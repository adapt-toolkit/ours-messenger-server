// watch-reconcile — a reconnect must not silently swallow the notifications
// that arrived while the stream was down.
//
// THE DEFECT. `startWatcher` calls `client.watchNotifications(name, { signal })`
// with no `since`, so the SDK defaults to "tip" and the daemon answers a tip
// request with the current cursor and ZERO events. Right for a cold start,
// wrong for a reconnect — and `startWatcher`'s outer loop re-enters that same
// call after EVERY transient failure. Each reconnect jumps to the tip and
// discards whatever arrived in the gap. Discarded, not deferred: the messages
// are still in the packet and readable over REST, so the only thing lost is the
// notification, which is exactly the "it was there when I opened the app but
// nobody told me" report.
//
// Passing the cursor across the reconnect is not available to us — `r.cursor`
// never leaves the SDK generator and the yielded records carry no cursor field.
// So we reconcile from canonical state, which also covers the wider gap of the
// messenger process having been DOWN (twice in 24h on a WASM heap ceiling), a
// window no in-memory cursor could ever have closed.
//
// The second case is the one that matters most on review: the reconcile runs on
// every reconnect, so without `enqueueJob`'s dedupe it would re-push every
// unread message 16 times a night to a real phone. That dedupe is load-bearing
// for correctness, and this test pins it from the caller's side.
import assert from 'node:assert/strict';
import { MessengerEventBus } from '../src/events.ts';
import { startWatcher } from '../src/watch.ts';

const UNREAD_MESSAGES = [
  { msg_id: 1, from: { id: 'CID-A', name: 'Alice' }, wire_id: 'W-MISSED-1', text: 'never leaves', date: 'D1', status: 'unread', reply_to: null },
  { msg_id: 2, from: { id: 'CID-B', name: 'Bob' }, wire_id: 'W-MISSED-2', text: 'also private', date: 'D2', status: 'unread', reply_to: null },
  { msg_id: 3, from: { id: 'CID-A', name: 'Alice' }, wire_id: 'W-ALREADY-READ', text: 'seen', date: 'D0', status: 'read', reply_to: null },
];
const UNREAD_FILES = [
  { file_id: 1, wire_id: 'F-MISSED-1', from: { id: 'CID-A', name: 'Alice' }, filename: 'a.png', mime: 'image/png', size: 1, size_source: 'received_payload', status: 'unread', date: 'D1', sha256: null, reply_to: null, kind: 'file' },
  { file_id: 2, wire_id: 'F-READ', from: { id: 'CID-B', name: 'Bob' }, filename: 'b.txt', mime: 'text/plain', size: 1, size_source: 'received_payload', status: 'processed', date: 'D0', sha256: null, reply_to: null, kind: 'file' },
];

function makeHarness({ streams }) {
  const enqueued = [];
  const seen = new Set();
  const client = {
    listIncomingMessages: async () => UNREAD_MESSAGES,
    listIncomingFiles: async () => UNREAD_FILES,
    version: async () => ({ ok: true }),
  };
  // Stand-in for PushDeliveryQueue with the REAL dedupe rule PushStore.enqueueJob
  // applies: one job per `${wire_id}:${kind}`, and a job that already exists is
  // refused. Terminal jobs are retained for 7 days there, so a repeat within a
  // night's worth of reconnects is exactly this `seen` set.
  const delivery = {
    enqueue: (record) => {
      const kind = record.event === 'message_received' ? 'message'
        : record.kind === 'voice_message' ? 'voice' : 'file';
      const key = `${record.wire_id}:${kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      enqueued.push({ ...record, _kind: kind });
      return true;
    },
  };
  let attempt = 0;
  const handle = startWatcher(
    client,
    'Me',
    { send: async () => ({ sent: 1, pruned: 0, failed: 0, errors: [] }) },
    { info() {}, warn() {} },
    new MessengerEventBus(),
    {
      wait: async () => {},
      probe: async () => ({ ok: true }),
      delivery,
      watch: (_identity, signal) => streams(attempt++, signal),
    },
  );
  return { handle, enqueued };
}

const idle = (signal) => (async function* () {
  if (!signal.aborted) await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
})();

// ─── 1. THE HEADLINE: what the tip-primed stream will not replay is recovered ─
{
  const { handle, enqueued } = makeHarness({
    streams: (n, signal) => (n === 0
      ? (async function* () { throw new Error('forced disconnect'); })()
      : idle(signal)),
  });
  await new Promise((r) => setTimeout(r, 150));
  await handle.stop();

  const wires = enqueued.map((e) => e.wire_id).sort();
  assert.deepEqual(wires, ['F-MISSED-1', 'W-MISSED-1', 'W-MISSED-2'],
    'every unread message and file is queued for push, since a tip-primed stream will never replay them');
  assert.ok(!wires.includes('W-ALREADY-READ'),
    'an already-read message is NOT re-notified — unread is the filter, not "everything in the inbox"');
  assert.ok(!wires.includes('F-READ'), 'a processed file is not re-notified');
  assert.ok(!JSON.stringify(enqueued).includes('never leaves'),
    'the reconcile carries correlation metadata only — no message body reaches the push queue');
  console.log('  ✓ missed notifications are recovered across a reconnect');
}

// ─── 2. THE GUARD: 16 reconnects a night must not mean 16 pushes ─────────────
{
  let attempts = 0;
  const { handle, enqueued } = makeHarness({
    streams: (n, signal) => {
      attempts = n;
      return n < 5
        ? (async function* () { throw new Error(`forced disconnect ${n}`); })()
        : idle(signal);
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  await handle.stop();

  assert.ok(attempts >= 4, `the harness actually reconnected several times (${attempts})`);
  assert.equal(enqueued.length, 3,
    `each wire_id is queued exactly once across ${attempts + 1} reconnects — enqueueJob's dedupe is what prevents re-pushing a human's phone on every blip (got ${enqueued.length})`);
  console.log('  ✓ repeated reconnects do not re-push: the dedupe is load-bearing and holds');
}

// ─── 3. A failing reconcile must not cost us the watcher ─────────────────────
// Same rule the push block already follows: an unqueued push is degraded UX, a
// dead watcher is a broken one.
{
  const bus = new MessengerEventBus();
  let attempt = 0;
  const handle = startWatcher(
    {
      listIncomingMessages: async () => { throw new Error('daemon busy'); },
      listIncomingFiles: async () => [],
      version: async () => ({ ok: true }),
    },
    'Me',
    { send: async () => ({ sent: 0, pruned: 0, failed: 0, errors: [] }) },
    { info() {}, warn() {} },
    bus,
    {
      wait: async () => {},
      probe: async () => ({ ok: true }),
      delivery: { enqueue: () => true },
      watch: (_identity, signal) => { attempt++; return idle(signal); },
    },
  );
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(attempt >= 1, 'the watcher still opened its stream despite the reconcile throwing');
  await handle.stop();
  console.log('  ✓ a throwing reconcile degrades the notification, not the watcher');
}

console.log('watch-reconcile: all passed');
