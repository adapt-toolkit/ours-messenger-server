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
const admitted = [];
const controllerWait = async () => {};
const cursorStore = {
  notificationCursor: null,
  commitNotificationCursor(cursor) { this.notificationCursor = cursor; },
};
const handle = startWatcher(
  { version: async () => ({ ok: true }) },
  'Me',
  cursorStore,
  { info() {}, warn(message) { warnings.push(message); } },
  watchBus,
  {
    wait: controllerWait,
    probe: async () => ({ ok: true }),
    delivery: { admit(record) { admitted.push(record); return { status: 'queued' }; } },
    readPage: async (_identity, _since, signal) => {
      attempts++;
      if (attempts === 1) return { cursor: 10, events: [
        { event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'WIRE-2', date: 'D' },
      ] };
      if (attempts === 2) throw new Error('forced disconnect SECRET-WATCH-PATH-/private/token');
      if (attempts === 3) return { cursor: 20, events: [
        { event: 'receipt_received', sender_id: 'CID-A', kind: 'delivered', wire_ids: ['WIRE-2'], date: 'D2' },
      ] };
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { cursor: 20, events: [] };
    },
  },
);
assert.equal((await watched.next()).type, 'message_received');
assert.deepEqual(await watched.next(), { type: 'sync_required', reason: 'daemon_unavailable' });
assert.deepEqual(await watched.next(), { type: 'sync_required', reason: 'daemon_reconnected' });
assert.equal((await watched.next()).type, 'receipt_received');
assert.equal(admitted.length, 2, 'notification records are durably admitted before their cursor commits');
assert.ok(warnings.some((line) => line.includes('watch stream') && line.includes('correlation')),
  'disconnect is observable through a correlation id');
assert.ok(!warnings.join('\n').includes('SECRET-WATCH-PATH'), 'watch errors never expose exception content');
await handle.stop();
watched.close();
assert.equal(handle.stats.reconnects, 1);

const fileBus = new MessengerEventBus();
const fileEvents = fileBus.subscribe(2);
let durableEnqueues = 0;
let filePages = 0;
const fileCursor = { notificationCursor: null, commitNotificationCursor(cursor) { this.notificationCursor = cursor; } };
const fileHandle = startWatcher(
  { version: async () => ({ ok: true }) },
  'Me',
  fileCursor,
  { info() {}, warn() {} },
  fileBus,
  {
    delivery: { admit() { durableEnqueues++; return { status: 'queued' }; } },
    readPage: async (_identity, _since, signal) => {
      if (filePages++ === 0) return {
        cursor: 30, events: [{ event: 'file_received', sender_id: 'CID-A', wire_id: 'FILE-LAG', date: 'D4' }],
      };
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { cursor: 30, events: [] };
    },
  },
);
assert.equal((await fileEvents.next()).type, 'file_received');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(durableEnqueues, 1, 'file push work is durable before best-effort media projection can fail');
await fileHandle.stop();
fileEvents.close();

console.log('events OK — normalized metadata, redaction, bounded fan-out, reconnect, push coexistence');
