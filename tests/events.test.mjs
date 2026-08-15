import assert from 'node:assert/strict';
import { MessengerEventBus, normalizeNotification, toSse } from '../src/events.ts';
import { startWatcher } from '../src/watch.ts';

const message = normalizeNotification({
  event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', msg_id: '7', wire_id: 'WIRE-1',
  date: '2026-08-14T12:00:00.000Z', text: 'must never escape',
});
assert.deepEqual(message, {
  type: 'message_received', contact_id: 'CID-A', wire_id: 'WIRE-1', date: '2026-08-14T12:00:00.000Z',
});
assert.ok(!JSON.stringify(message).includes('must never escape'), 'normalization redacts message bodies');

const receipt = normalizeNotification({
  event: 'receipt_received', sender_id: 'CID-B', kind: 'read', wire_ids: ['W1', 'W2'],
  date: '2026-08-14T12:00:01.000Z', invite: 'secret',
});
assert.deepEqual(receipt, {
  type: 'receipt_received', contact_id: 'CID-B', kind: 'read', wire_ids: ['W1', 'W2'], date: '2026-08-14T12:00:01.000Z',
});
assert.deepEqual(normalizeNotification({ event: 'message_received', from: 'Alice', msg_id: '1' }), {
  type: 'sync_required', reason: 'legacy_event',
}, 'old display-name-only events never guess a CID');
assert.deepEqual(normalizeNotification({ event: 'future_event', text: 'private' }), {
  type: 'sync_required', reason: 'unknown_event',
});
assert.deepEqual(toSse({ type: 'sync_required', reason: 'connected' }, 'ME'), {
  event: 'sync_required', data: { v: 1, reason: 'connected', identity: 'ME' },
});
assert.deepEqual(normalizeNotification({
  event: 'file_received', sender_id: 'CID-A', wire_id: 'FILE-1', date: 'D3', filename: 'private-name.txt',
}), { type: 'file_received', contact_id: 'CID-A', wire_id: 'FILE-1', date: 'D3' });

const bus = new MessengerEventBus();
const first = bus.subscribe(1);
const second = bus.subscribe(2);
bus.publish(message);
bus.publish(receipt);
assert.deepEqual(await first.next(), { type: 'sync_required', reason: 'overflow' }, 'overflow replaces queued details with one sync');
assert.deepEqual(await second.next(), message, 'fan-out subscriber one receives the first event');
assert.deepEqual(await second.next(), receipt, 'fan-out subscriber one receives the second event');
first.close();
second.close();
assert.equal(bus.size, 0, 'disconnect removes subscribers');

const watchBus = new MessengerEventBus();
const watched = watchBus.subscribe(8);
let attempts = 0;
const warnings = [];
const pushes = [];
const controllerWait = async () => {};
const handle = startWatcher(
  {
    getConversation: async () => ({
      messages: [{ dir: 'in', wire_id: 'WIRE-2', text: 'the full push body' }],
    }),
  },
  'Me',
  { send: async (event) => { pushes.push(event); return { sent: 1, pruned: 0, failed: 0, errors: [] }; } },
  { info() {}, warn(message) { warnings.push(message); } },
  watchBus,
  {
    wait: controllerWait,
    probe: async () => ({ ok: true }),
    watch: (_identity, signal) => {
      attempts++;
      if (attempts === 1) return (async function* () {
        yield { event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'WIRE-2', date: 'D' };
        throw new Error('forced disconnect SECRET-WATCH-PATH-/private/token');
      })();
      return (async function* () {
        yield { event: 'receipt_received', sender_id: 'CID-A', kind: 'delivered', wire_ids: ['WIRE-2'], date: 'D2' };
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      })();
    },
  },
);
assert.equal((await watched.next()).type, 'message_received');
assert.deepEqual(await watched.next(), { type: 'sync_required', reason: 'daemon_unavailable' });
assert.deepEqual(await watched.next(), { type: 'sync_required', reason: 'daemon_reconnected' });
assert.equal((await watched.next()).type, 'receipt_received');
assert.equal(pushes.length, 1, 'message event remains a push subscriber input');
assert.deepEqual(pushes[0], {
  v: 1,
  kind: 'message',
  title: 'Alice',
  body: 'the full push body',
  contact_id: 'CID-A',
  wire_id: 'WIRE-2',
  url: '/chats/CID-A',
}, 'push is encrypted by Web Push with the canonical full text and click-through identifiers');
assert.ok(warnings.some((line) => line.includes('watch stream') && line.includes('correlation')),
  'disconnect is observable through a correlation id');
assert.ok(!warnings.join('\n').includes('SECRET-WATCH-PATH'), 'watch errors never expose exception content');
await handle.stop();
watched.close();
assert.equal(handle.stats.reconnects, 1);

const fileBus = new MessengerEventBus();
const fileEvents = fileBus.subscribe(2);
let durableEnqueues = 0;
const fileHandle = startWatcher(
  { listIncomingFiles: async () => { throw new Error('canonical projection is temporarily behind'); } },
  'Me',
  { send: async () => ({ sent: 0, pruned: 0, failed: 0, errors: [] }) },
  { info() {}, warn() {} },
  fileBus,
  {
    delivery: { enqueue() { durableEnqueues++; return true; } },
    media: { reconcileIncoming() { throw new Error('must not reach reconciliation'); } },
    watch: () => (async function* () {
      yield { event: 'file_received', sender_id: 'CID-A', wire_id: 'FILE-LAG', date: 'D4' };
    })(),
    wait: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
  },
);
assert.equal((await fileEvents.next()).type, 'file_received');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(durableEnqueues, 1, 'file push work is durable before best-effort media projection can fail');
await fileHandle.stop();
fileEvents.close();

console.log('events OK — normalized metadata, redaction, bounded fan-out, reconnect, push coexistence');
