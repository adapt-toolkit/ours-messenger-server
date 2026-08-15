import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { MessengerEventBus } from '../src/events.ts';
import { attachPresenceServer, PresenceRegistry } from '../src/presence.ts';

const http = createServer((_req, res) => { res.writeHead(404).end(); });
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
const address = http.address();
assert.ok(address && typeof address === 'object');
const url = `ws://127.0.0.1:${address.port}/api/presence`;
const registry = new PresenceRegistry();
const events = new MessengerEventBus();
const presence = attachPresenceServer(http, registry, {
  allowedOrigin: 'https://messenger.example',
  verify: (frame) => frame.identity === 'CID-ME' && frame.endpoint === 'ENDPOINT' && frame.auth === 'AUTH'
    ? 'CID-ME' : null,
  subscribe: () => events.subscribe(),
  pingIntervalMs: 50,
  authTimeoutMs: 200,
});

try {
  const wrongOrigin = new WebSocket(url, { headers: { Origin: 'https://evil.example' } });
  const rejected = await Promise.race([
    once(wrongOrigin, 'error').then(() => true),
    once(wrongOrigin, 'close').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  assert.equal(rejected, true, 'cross-origin presence upgrade is rejected');

  const socket = new WebSocket(url, { headers: { Origin: 'https://messenger.example' } });
  await once(socket, 'open');
  socket.send(JSON.stringify({ identity: 'CID-ME', endpoint: 'ENDPOINT', auth: 'AUTH' }));
  const [ack] = await once(socket, 'message');
  assert.deepEqual(JSON.parse(String(ack)), { ok: true });
  assert.equal(registry.isOnline('CID-ME'), true, 'authenticated live socket marks the identity online');

  events.publish({ type: 'message_received', contact_id: 'PEER', wire_id: 'WIRE-1', date: 'DATE' });
  const [raw] = await once(socket, 'message');
  assert.deepEqual(JSON.parse(String(raw)), {
    type: 'event',
    event: { v: 1, type: 'message_received', contact_id: 'PEER', wire_id: 'WIRE-1', date: 'DATE' },
  }, 'presence socket carries the same metadata-only live invalidation contract');

  socket.close();
  await once(socket, 'close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.isOnline('CID-ME'), false, 'socket loss immediately resumes background push eligibility');
} finally {
  events.close();
  await presence.close();
  await new Promise((resolve) => http.close(resolve));
}

console.log('presence OK — origin/auth gate, liveness, live events, and disconnect');
