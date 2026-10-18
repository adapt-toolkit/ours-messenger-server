import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    { id: 'cleanup', value: { url: '/fleet/chats/contacts/PEER' }, operation: 'delete-target' }];
  writeFileSync(file, JSON.stringify({ entries: [...invalid, { id: 'typed', value: {}, targetVersion: 1 }] }));
  const outbox = new NotificationOutbox(file, config, project, () => {}, async () => true); outboxes.push(outbox);
  await outbox.drain();
  assert.deepEqual(accepted.map(row => [row.path, row.body.eventId]), [['/api/v1/send', 'typed']]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, invalid);
  assert.equal(outbox.enqueue('next', {}), true);

  // Only the current state shape is read; anything else is refused and left unchanged.
  for (const contents of ['[]', '[{"id":"x","value":{}}]', 'null', '{"entries":{}}']) {
    const shape = join(dir, 'shape.json'); writeFileSync(shape, contents);
    assert.throws(() => new NotificationOutbox(shape, config, project), /Unsupported notification outbox state/);
    assert.equal(readFileSync(shape, 'utf8'), contents);
  }
  console.log('Notification outbox sends only the typed contract and refuses unsupported state');
} finally {
  for (const outbox of outboxes) await outbox.close?.();
  server.closeAllConnections(); server.close();
}
