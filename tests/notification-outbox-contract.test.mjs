import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationOutbox } from '../src/notification-outbox.ts';

mkdirSync('.test-artifacts', { recursive: true });
const dir = mkdtempSync(join('.test-artifacts', 'notification-outbox-contract-'));
const accepted = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  accepted.push({ path: req.url, body: JSON.parse(body) }); res.end('{}');
}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const config = { origin: `http://127.0.0.1:${server.address().port}`, token: 'p'.repeat(40) };
const project = async (_value, eventId) => ({ eventId, title: 'Alice', body: 'Hello', target: { kind: 'contact', contactId: 'PEER' } });
const outboxes = [];
try {
  // Present but invalid payload or operation fields are never projected or sent, and do not block typed work.
  const file = join(dir, 'invalid-fields.json');
  const invalid = [...[null, false, 0, ''].map((payload, i) => ({ id: `payload-${i}`, value: {}, targetVersion: 1, payload })),
    { id: 'operation', value: {}, targetVersion: 1, operation: 'other' },
    { id: 'cleanup', value: { url: '/fleet/chats/contacts/PEER' }, operation: 'delete-target' },
    null, 7, 'typed', [], { id: 5, value: {}, targetVersion: 1 }, { id: 'typed', value: {} }];
  writeFileSync(file, JSON.stringify({ entries: [...invalid, { id: 'typed', value: {}, targetVersion: 1 }] }));
  const outbox = new NotificationOutbox(file, config, project, () => {}, async () => true); outboxes.push(outbox);
  await outbox.drain();
  assert.deepEqual(accepted.map(row => [row.path, row.body.eventId]), [['/api/v1/send', 'typed']]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, invalid);
  // Unsupported entries neither hold an ID nor block later typed work or cleanup, also after a restart.
  assert.equal(outbox.enqueue('typed', {}), true); assert.equal(outbox.enqueue('next', {}), true);
  outbox.retireTarget({ kind: 'contact', contactId: 'GONE' }, () => false); await outbox.close();
  const restarted = new NotificationOutbox(file, config, project, () => {}, async () => true); outboxes.push(restarted);
  await restarted.drain();
  assert.deepEqual(accepted.map(row => [row.path, row.body.eventId ?? row.body.target.contactId]),
    [['/api/v1/send', 'typed'], ['/api/v1/send', 'typed'], ['/api/v1/send', 'next'], ['/api/v1/delete-target', 'GONE']]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, invalid);

  // Only typed entries count toward the queue capacity.
  const capacity = join(dir, 'capacity.json');
  writeFileSync(capacity, JSON.stringify({ entries: [...Array.from({ length: 50 }, () => null), { id: 'raw', value: {} },
    ...Array.from({ length: 1999 }, (_, i) => ({ id: `typed-${i}`, value: {}, targetVersion: 1 }))] }));
  const full = new NotificationOutbox(capacity, config, project); outboxes.push(full);
  assert.equal(full.enqueue('last', {}), true); assert.equal(full.enqueue('over', {}), false);

  // Only the current state shape is read; anything else is refused and left unchanged.
  for (const contents of ['[]', '[{"id":"x","value":{}}]', 'null', '{"entries":{}}']) {
    const shape = join(dir, 'shape.json'); writeFileSync(shape, contents);
    assert.throws(() => new NotificationOutbox(shape, config, project), /Unsupported notification outbox state/);
    assert.equal(readFileSync(shape, 'utf8'), contents);
  }
  // Prompt delivery: a durable entry is sent without waiting for the recovery timer, an entry
  // admitted during a pass gets one follow-up pass, and after a failure only the timer retries.
  {
    const seen = [], held = []; let mode = 'ok';
    const gate = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      seen.push({ id: JSON.parse(body).eventId, at: performance.now() });
      if (mode === 'fail') { res.statusCode = 503; return res.end('{}'); }
      if (mode === 'hold') return held.push(res);
      res.end('{}');
    }); gate.listen(0, '127.0.0.1'); await once(gate, 'listening');
    const until = async (check, ms = 1000) => { const end = performance.now() + ms; while (!check()) { if (performance.now() > end) return false; await new Promise(r => setTimeout(r, 5)); } return true; };
    const prompt = new NotificationOutbox(join(dir, 'prompt.json'), { origin: `http://127.0.0.1:${gate.address().port}`, token: 'p'.repeat(40) }, project);
    outboxes.push(prompt);
    try {
      assert.equal(prompt.enqueue('p1', {}), true); prompt.prompt();
      assert.ok(await until(() => seen.some(row => row.id === 'p1'), 1000), 'sent well before the 3 s recovery tick');
      mode = 'hold'; assert.equal(prompt.enqueue('p2', {}), true); prompt.prompt();
      assert.ok(await until(() => held.length === 1));
      assert.equal(prompt.enqueue('p3', {}), true); prompt.prompt(); prompt.prompt();
      mode = 'ok'; held.shift().end('{}');
      assert.ok(await until(() => seen.some(row => row.id === 'p3'), 1000), 'one follow-up pass covers an entry admitted mid-pass');
      assert.deepEqual(seen.map(row => row.id), ['p1', 'p2', 'p3']);
      mode = 'fail'; assert.equal(prompt.enqueue('p4', {}), true); prompt.prompt();
      assert.ok(await until(() => seen.length === 4)); await until(() => false, 100);
      for (const id of ['p5', 'p6']) { assert.equal(prompt.enqueue(id, {}), true); prompt.prompt(); }
      await until(() => false, 300);
      assert.equal(seen.length, 4, 'after a failed pass arrivals add no attempts');
      mode = 'ok'; await prompt.drain();
      assert.deepEqual(seen.slice(4).map(row => row.id), ['p4', 'p5', 'p6'], 'the recovery pass delivers in order');
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'prompt.json'), 'utf8')).entries, []);
      assert.equal(prompt.enqueue('p7', {}), true); prompt.prompt();
      assert.ok(await until(() => seen.some(row => row.id === 'p7'), 1000), 'prompt delivery resumes after recovery');
      await prompt.close(); assert.equal(prompt.enqueue('p8', {}), true); prompt.prompt();
      await until(() => false, 200); assert.equal(seen.some(row => row.id === 'p8'), false, 'a closed outbox starts no pass');
      // A burst keeps the per-pass limit: one follow-up pass sends at most 32, the rest wait for recovery.
      const burst = new NotificationOutbox(join(dir, 'burst.json'), { origin: `http://127.0.0.1:${gate.address().port}`, token: 'p'.repeat(40) }, project);
      outboxes.push(burst);
      const before = seen.length;
      for (let i = 0; i < 40; i++) { assert.equal(burst.enqueue(`b${i}`, {}), true); burst.prompt(); }
      assert.ok(await until(() => seen.length - before === 33, 1500));
      await until(() => false, 300);
      assert.equal(seen.length - before, 33, 'first pass plus one 32-attempt follow-up');
      assert.ok(await until(() => seen.length - before === 40, 4000), 'the recovery tick delivers the remainder');
      assert.deepEqual(seen.slice(before).map(row => row.id), Array.from({ length: 40 }, (_, i) => `b${i}`));
      // A record that could not be persisted is never sent.
      const { MessengerNotificationProducer } = await import('../src/notification-producer.ts');
      const locked = join(dir, 'locked'); mkdirSync(locked, { mode: 0o700 });
      const producer = new MessengerNotificationProducer(locked, { origin: `http://127.0.0.1:${gate.address().port}`, token: 'p'.repeat(40) }, 'USER', {}, () => {});
      outboxes.push(producer);
      chmodSync(locked, 0o500);
      try {
        const sent = seen.length;
        assert.throws(() => producer.admit({ event: 'message_received', sender_id: 'PEER', wire_id: 'UNPERSISTED' }));
        await until(() => false, 300);
        assert.equal(seen.length, sent, 'a failed persist sends nothing');
      } finally { chmodSync(locked, 0o700); }
    } finally { gate.closeAllConnections(); gate.close(); }
  }
  console.log('Notification outbox sends only the typed contract and refuses unsupported state');
} finally {
  for (const outbox of outboxes) await outbox.close?.();
  server.closeAllConnections(); server.close();
}
