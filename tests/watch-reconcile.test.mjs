import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { MessengerEventBus } from '../src/events.ts';
import { PushStore } from '../src/push.ts';
import { startWatcher } from '../src/watch.ts';

const vapid = webpush.generateVAPIDKeys();
const env = {
  OURS_MESSENGER_VAPID_PUBLIC_KEY: vapid.publicKey,
  OURS_MESSENGER_VAPID_PRIVATE_KEY: vapid.privateKey,
  OURS_MESSENGER_VAPID_SUBJECT: 'mailto:test@example.com',
};

const blockedPage = (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
const dir = mkdtempSync(join(tmpdir(), 'messenger-watch-source-cursor-'));
try {
  const store = PushStore.open(dir, 'CID-ME', env);
  const since = [];
  const forbiddenClient = {
    listIncomingMessages() { throw new Error('unread message history must never be scanned'); },
    listIncomingFiles() { throw new Error('unread file history must never be scanned'); },
    version: async () => ({ ok: true }),
  };
  let calls = 0;
  const first = startWatcher(forbiddenClient, 'Me', store, { info() {}, warn() {} }, new MessengerEventBus(), {
    delivery: { admit: () => ({ status: 'queued' }) },
    readPage: async (_identity, cursor, signal) => {
      since.push(cursor);
      if (calls++ === 0) return { cursor: 100, events: [] };
      await blockedPage(signal);
      return { cursor: 100, events: [] };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await first.stop();
  assert.deepEqual(since.slice(0, 2), ['tip', 100], 'fresh state primes at EOF, then polls only from the durable checkpoint');

  const reopened = PushStore.open(dir, 'CID-ME', env);
  const caught = [];
  calls = 0;
  const second = startWatcher(forbiddenClient, 'Me', reopened, { info() {}, warn() {} }, new MessengerEventBus(), {
    delivery: { admit(record) { caught.push(record.wire_id); return { status: 'queued' }; } },
    readPage: async (_identity, cursor, signal) => {
      assert.equal(cursor, calls === 0 ? 100 : 200, 'restart/catch-up uses the committed byte cursor');
      if (calls++ === 0) return {
        cursor: 200,
        events: [{ event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'ONLY-NEW-EVENT' }],
      };
      await blockedPage(signal);
      return { cursor: 200, events: [] };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await second.stop();
  assert.deepEqual(caught, ['ONLY-NEW-EVENT'], 'only source events after the checkpoint catch up; unread history is not replayed');
  assert.equal(reopened.notificationCursor, 200);
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log('watch-reconcile OK — fresh tip, restart cursor catch-up, and no unread-history push replay');
