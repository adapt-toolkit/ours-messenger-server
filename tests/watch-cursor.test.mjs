import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { MessengerEventBus } from '../src/events.ts';
import { PushStore } from '../src/push.ts';
import { applyNotificationPage } from '../src/watch.ts';

const vapid = webpush.generateVAPIDKeys();
const env = {
  OURS_MESSENGER_VAPID_PUBLIC_KEY: vapid.publicKey,
  OURS_MESSENGER_VAPID_PRIVATE_KEY: vapid.privateKey,
  OURS_MESSENGER_VAPID_SUBJECT: 'mailto:test@example.com',
};
const subscription = {
  endpoint: 'https://push.example/device',
  keys: { p256dh: Buffer.alloc(65, 5).toString('base64url'), auth: Buffer.alloc(16, 6).toString('base64url') },
};
const page = {
  cursor: 200,
  events: [
    { event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'M-1' },
    { event: 'file_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'F-1', kind: 'file' },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'messenger-watch-cursor-'));
try {
  const first = PushStore.open(dir, 'CID-ME', env);
  first.ensure(subscription);
  assert.equal(first.notificationCursor, null, 'a new server has no source checkpoint and primes at tip');
  first.commitNotificationCursor(100);

  const admitted = [];
  const delivery = { admit(record) { admitted.push(record.wire_id); return { status: 'queued' }; } };
  const stats = { pushes: 0, events: 0, reconnects: 0, cursorCommits: 0, saturationEvents: 0 };
  const applied = applyNotificationPage(page, first, delivery, new MessengerEventBus(), stats, { info() {}, warn() {} });
  assert.equal(applied, true);
  assert.deepEqual(admitted, ['M-1', 'F-1']);
  assert.equal(first.notificationCursor, 200, 'checkpoint advances only after the whole source page is durably admitted');

  // Crash after admission but before the page checkpoint: restart replays the
  // page, pending work/tombstones dedupe it, then the cursor safely advances.
  first.commitNotificationCursor(100);
  first.admitJob({ wireId: 'M-1', kind: 'message', contactId: 'CID-A' });
  const restarted = PushStore.open(dir, 'CID-ME', env);
  const realDelivery = {
    admit(record) {
      const kind = record.event === 'message_received' ? 'message' : 'file';
      return restarted.admitJob({ wireId: record.wire_id, kind, contactId: record.sender_id });
    },
  };
  assert.equal(applyNotificationPage(page, restarted, realDelivery, new MessengerEventBus(), stats, { info() {}, warn() {} }), true);
  assert.equal(restarted.notificationCursor, 200);
  assert.equal(restarted.queueStats().pending, 2, 'replay adds only the previously uncommitted file event');

  restarted.commitNotificationCursor(200);
  assert.equal(applyNotificationPage({ cursor: 300, events: [{ event: 'message_received', sender_id: 'CID-A', wire_id: 'BLOCKED' }] }, restarted,
    { admit() { return { status: 'saturated' }; } }, new MessengerEventBus(), stats, { info() {}, warn() {} }), false);
  assert.equal(restarted.notificationCursor, 200, 'a saturated admission never commits past the missed event');

  const claimed = restarted.dueJobs()[0];
  assert.ok(claimed && restarted.claimJob(claimed.id), 'worker claims work before provider I/O');
  const afterCrash = PushStore.open(dir, 'CID-ME', env);
  assert.ok(afterCrash.dueJobs().some((row) => row.id === claimed.id), 'restart restores a crash-interrupted in-flight job');
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log('watch-cursor OK — durable catch-up, replay dedupe, saturation boundary, and crash restoration without unread history');
