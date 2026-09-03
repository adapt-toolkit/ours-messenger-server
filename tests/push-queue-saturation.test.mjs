import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { PushStore } from '../src/push.ts';
import { PushDeliveryQueue } from '../src/push-delivery.ts';

const vapid = webpush.generateVAPIDKeys();
const env = {
  OURS_MESSENGER_VAPID_PUBLIC_KEY: vapid.publicKey,
  OURS_MESSENGER_VAPID_PRIVATE_KEY: vapid.privateKey,
  OURS_MESSENGER_VAPID_SUBJECT: 'mailto:test@example.com',
};
const subscription = {
  endpoint: 'https://push.example/device',
  keys: { p256dh: Buffer.alloc(65, 3).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') },
};
const job = (index, status = 'sent', now = Date.now()) => ({
  id: `CID-ME:WIRE-${index}:message`, identityCid: 'CID-ME', wireId: `WIRE-${index}`, kind: 'message',
  contactId: 'CID-AGENT', createdAt: now - 1_000, expiresAt: now + 60_000, attempts: 0,
  nextAttemptAt: now, targetBindingIds: ['binding'], deliveredBindingIds: status === 'sent' ? ['binding'] : [],
  status, sentCount: status === 'sent' ? 1 : 0, ...(status === 'pending' ? {} : { completedAt: now - 500 }),
});

function legacyState(jobs) {
  const fingerprint = createHash('sha256').update(vapid.publicKey).digest('base64url');
  return {
    version: 2, vapid: { ...vapid, subject: env.OURS_MESSENGER_VAPID_SUBJECT },
    vapidFingerprint: fingerprint, configEpoch: 1,
    identities: { 'CID-ME': { bindings: [], jobs } },
  };
}

// Reproduce the production defect without 4096 quadratic journal rewrites: one
// atomic legacy fixture contains the same recent terminal rows that made the old
// store reject a new job while reporting pending=0.
{
  const dir = mkdtempSync(join(tmpdir(), 'messenger-push-saturated-terminal-'));
  try {
    writeFileSync(join(dir, 'push.json'), JSON.stringify(legacyState(Array.from({ length: 4_096 }, (_, i) => job(i)))), { mode: 0o600 });
    const store = PushStore.open(dir, 'CID-ME', env);
    store.ensure(subscription);
    assert.equal(store.admitJob({ wireId: 'NEW', kind: 'message', contactId: 'CID-AGENT' }).status, 'queued',
      'migration removes obsolete seven-day terminal history before admitting new work');
    const stats = store.queueStats();
    assert.ok(stats.tombstones <= 256, 'dedupe tombstones are deliberately small and bounded');
    assert.equal(stats.admissionFailures, 0, 'terminal compaction prevents false saturation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A queue genuinely full of pending work refuses cursor advancement rather than
// silently throwing away the newly eligible event. Saturation remains visible
// even if pending later becomes zero.
{
  const dir = mkdtempSync(join(tmpdir(), 'messenger-push-saturated-pending-'));
  try {
    writeFileSync(join(dir, 'push.json'), JSON.stringify(legacyState(Array.from({ length: 4_096 }, (_, i) => job(i, 'pending')))), { mode: 0o600 });
    const store = PushStore.open(dir, 'CID-ME', env);
    store.ensure(subscription);
    const logs = [];
    const queue = new PushDeliveryQueue({
      store, client: {}, identityCid: 'CID-ME', log: { info() {}, warn(line) { logs.push(line); } }, autoStart: false,
    });
    assert.equal(queue.admit({ event: 'message_received', sender_id: 'CID-AGENT', wire_id: 'BLOCKED' }).status, 'saturated');
    assert.match(logs.join('\n'), /push_queue_saturated.*wire=BLOCKED/, 'saturation emits an explicit structured operator log');
    const stats = store.queueStats();
    assert.equal(stats.pending, 4_096);
    assert.equal(stats.saturated, true);
    assert.equal(stats.admissionFailures, 1);
    assert.equal(stats.healthy, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// More than the former global cap can flow successfully while durable storage
// stays bounded: completed jobs become only short-lived capped tombstones and
// delivery totals live in counters.
{
  const dir = mkdtempSync(join(tmpdir(), 'messenger-push-volume-'));
  try {
    let now = 1_800_000_000_000;
    const store = PushStore.open(dir, 'CID-ME', env, { sendNotification: async () => {} });
    store.ensure(subscription);
    for (let index = 0; index < 4_200; index++) {
      const admitted = store.admitJob({ wireId: `AGENT-${index}`, kind: 'message', contactId: 'CID-AGENT' }, now++);
      assert.equal(admitted.status, 'queued');
      const due = store.dueJobs(now)[0];
      assert.ok(due && store.claimJob(due.id, now));
      await store.dispatchJob(due.id, {
        v: 1, kind: 'message', title: 'Agent', body: 'event', contact_id: 'CID-AGENT', wire_id: `AGENT-${index}`, url: '/chats/CID-AGENT',
      }, now);
    }
    const stats = store.queueStats();
    assert.equal(stats.pending, 0);
    assert.equal(stats.delivered, 4_200);
    assert.ok(stats.tombstones <= 256);
    assert.ok(stats.depth <= 256, `durable records remain bounded (depth=${stats.depth})`);
    assert.ok(readFileSync(join(dir, 'push.json')).byteLength < 200_000, 'persistent queue does not grow with delivery history');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Tombstones cover the cursor/job commit race, then expire quickly instead of
// becoming delivery history. Two worker instances sharing one store still get
// one crash-safe claim and one provider call.
{
  const dir = mkdtempSync(join(tmpdir(), 'messenger-push-tombstone-concurrency-'));
  try {
    let now = 1_800_000_000_000;
    let sends = 0;
    const store = PushStore.open(dir, 'CID-ME', env, { sendNotification: async () => { sends++; } });
    store.ensure(subscription);
    const options = {
      store, client: {}, identityCid: 'CID-ME', log: { info() {}, warn() {} }, now: () => now,
      autoStart: false, project: async (pending) => ({
        v: 1, kind: pending.kind, title: 'Agent', body: 'once', contact_id: pending.contactId,
        wire_id: pending.wireId, url: '/chats/CID-AGENT',
      }),
    };
    const first = new PushDeliveryQueue(options);
    const second = new PushDeliveryQueue(options);
    assert.equal(first.enqueue({ event: 'message_received', sender_id: 'CID-AGENT', wire_id: 'CONCURRENT' }), true);
    await Promise.all([first.drainDue(), second.drainDue()]);
    assert.equal(sends, 1, 'concurrent workers cannot both claim the same pending job');
    assert.equal(first.enqueue({ event: 'message_received', sender_id: 'CID-AGENT', wire_id: 'CONCURRENT' }), false,
      'short-lived tombstone dedupes source replay after successful cleanup');
    now += 16 * 60 * 1_000;
    assert.equal(first.enqueue({ event: 'message_received', sender_id: 'CID-AGENT', wire_id: 'CONCURRENT' }), true,
      'tombstone expires instead of retaining delivery history');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('push-queue-saturation OK — legacy defect, full admission, explicit health, >4096 flow, and bounded storage');
