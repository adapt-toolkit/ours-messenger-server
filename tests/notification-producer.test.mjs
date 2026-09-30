import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessengerNotificationProducer } from '../src/notification-producer.ts';
import { PushStore } from '../src/push.ts';
import { applyNotificationPage } from '../src/watch.ts';
import { MessengerEventBus } from '../src/events.ts';

mkdirSync('.test-artifacts', { recursive: true });
const dir = mkdtempSync(join('.test-artifacts', 'notification-producer-'));
const accepted = []; let fail = true;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  assert.equal(req.url, '/api/v1/send'); assert.equal(req.headers.authorization, 'Bearer ' + 'p'.repeat(40));
  if (fail) { res.writeHead(503); res.end(); return; }
  accepted.push(JSON.parse(body)); res.end('{}');
}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const config = { origin: `http://127.0.0.1:${server.address().port}`, token: 'p'.repeat(40) };
let text = 'Hello user';
const client = { getHistoryItem: async ({ wire_id }) => ({ wire_id, direction: 'in', text, peer: { id: 'PEER', name: 'Alice' } }),
  getFileInfo: async ({ wire_id }) => ({ wire_id, direction: 'in', peer: { id: 'PEER' }, from: { name: 'Alice' }, kind: 'photo', mime: 'image/png', filename: 'photo.png' }) };
let producer = new MessengerNotificationProducer(dir, config, 'USER', client, () => {});
try {
  const push = PushStore.open(join(dir, 'push'), 'USER'); push.commitNotificationCursor(10);
  assert.equal(push.bindingCount, 0);
  const page = { cursor: 20, events: [{ event: 'message_received', sender_id: 'PEER', wire_id: 'MESSAGE' }, { event: 'file_received', sender_id: 'PEER', wire_id: 'FILE' }] };
  const stats = { pushes: 0, events: 0, reconnects: 0, cursorCommits: 0, saturationEvents: 0 };
  assert.equal(applyNotificationPage(page, push, producer, new MessengerEventBus(), stats, { info() {}, warn() {} }), true);
  assert.equal(push.notificationCursor, 20);
  await producer.outbox.drain();
  assert.equal(JSON.parse(readFileSync(join(dir, 'notification-outbox.json'), 'utf8')).entries.length, 2);
  await producer.close(); producer = new MessengerNotificationProducer(dir, config, 'USER', client, () => {});
  text = 'Changed projection after first attempted delivery';
  fail = false; await producer.outbox.drain();
  assert.equal(accepted.length, 2); assert.equal(accepted[0].body, 'Hello user');
  assert.equal(accepted[1].body, 'Photo: photo.png');
  assert.match(accepted[0].url, /source=messenger&chat=PEER/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'notification-outbox.json'), 'utf8')).entries.length, 0);
  console.log('Messenger event watcher -> durable producer -> HTTP delivery passed without local push bindings');
} finally { await producer.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
