import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { PushStore } from '../src/push.ts';
import { PushDeliveryQueue } from '../src/push-delivery.ts';

const stateDir = mkdtempSync(join(tmpdir(), 'messenger-push-delivery-'));
const vapid = webpush.generateVAPIDKeys();
const endpoint = 'https://push.example/device';
const subscription = {
  endpoint,
  keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
};
const env = {
  OURS_MESSENGER_VAPID_PUBLIC_KEY: vapid.publicKey,
  OURS_MESSENGER_VAPID_PRIVATE_KEY: vapid.privateKey,
  OURS_MESSENGER_VAPID_SUBJECT: 'mailto:test@example.com',
};

try {
  let now = Date.now();
  const sends = [];
  const store = PushStore.open(stateDir, 'CID-ME', env, {
    sendNotification: async (_subscription, payload) => {
      sends.push(JSON.parse(payload));
      if (sends.length === 1) throw Object.assign(new Error('provider private failure'), { statusCode: 503 });
    },
  });
  store.ensure({ ...subscription, preview: 'full' });
  let projections = 0;
  const queue = new PushDeliveryQueue({
    store,
    client: {},
    identityCid: 'CID-ME',
    log: { info() {}, warn() {} },
    now: () => now,
    random: () => 0,
    project: async (job) => {
      projections++;
      if (projections === 1) throw new Error('projection not ready');
      return { v: 1, kind: job.kind, title: 'Alice', body: 'private preview', contact_id: job.contactId, wire_id: job.wireId, url: `/chats/${job.contactId}` };
    },
    autoStart: false,
  });

  assert.equal(queue.enqueue({ event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'WIRE-1' }), true);
  assert.equal(queue.enqueue({ event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'WIRE-1' }), false,
    'duplicate authenticated events dedupe by identity:wire:kind');
  await queue.drainDue();
  assert.equal(sends.length, 0, 'projection lag is retained instead of dropped');
  now += 1_000;
  await queue.drainDue();
  assert.equal(sends.length, 1, 'projection recovery reaches delivery');
  now += 2_000;
  await queue.drainDue();
  assert.equal(sends.length, 2, '503 is retried with bounded backoff');
  assert.equal(store.queueStats().pending, 0);
  assert.equal(store.queueStats().sent, 1);

  const foregroundDir = mkdtempSync(join(tmpdir(), 'messenger-push-foreground-'));
  try {
    const foregroundStore = PushStore.open(foregroundDir, 'CID-ME', env, { sendNotification: async () => {
      throw new Error('foreground delivery must be suppressed before provider I/O');
    } });
    foregroundStore.ensure(subscription);
    const foregroundQueue = new PushDeliveryQueue({
      store: foregroundStore, client: {}, identityCid: 'CID-ME', log: { info() {}, warn() {} },
      isForeground: () => true, autoStart: false,
      project: async () => { throw new Error('foreground delivery must be suppressed before projection'); },
    });
    assert.equal(foregroundQueue.enqueue({ event: 'message_received', sender_id: 'CID-A', wire_id: 'FOREGROUND-1' }), true);
    assert.equal(foregroundQueue.stats.suppressed, 1);
    assert.equal(foregroundStore.queueStats().pending, 0);
    assert.equal(foregroundStore.queueStats().sent, 1, 'suppression is terminal in the durable dedupe ledger');
  } finally {
    rmSync(foregroundDir, { recursive: true, force: true });
  }

  const multiDeviceDir = mkdtempSync(join(tmpdir(), 'messenger-push-multi-device-'));
  try {
    const deliveredEndpoints = [];
    const multiDeviceStore = PushStore.open(multiDeviceDir, 'CID-ME', env, {
      sendNotification: async (target) => { deliveredEndpoints.push(target.endpoint); },
    });
    const pc = multiDeviceStore.ensure({ ...subscription, endpoint: 'https://push.example/pc' });
    multiDeviceStore.ensure({ ...subscription, endpoint: 'https://push.example/phone' });
    const multiDeviceQueue = new PushDeliveryQueue({
      store: multiDeviceStore, client: {}, identityCid: 'CID-ME', log: { info() {}, warn() {} },
      foregroundBindingIds: () => new Set([pc.bindingId]), autoStart: false,
      project: async (job) => ({
        v: 1, kind: job.kind, title: 'Alice', body: 'device-scoped', contact_id: job.contactId,
        wire_id: job.wireId, url: `/chats/${job.contactId}`,
      }),
    });
    assert.equal(multiDeviceQueue.enqueue({ event: 'message_received', sender_id: 'CID-A', wire_id: 'MULTI-1' }), true);
    assert.equal(multiDeviceQueue.stats.suppressed, 1, 'only the foreground browser binding is suppressed');
    await multiDeviceQueue.drainDue();
    assert.deepEqual(deliveredEndpoints, ['https://push.example/phone'], 'background phone still receives push while PC is open');
    assert.equal(multiDeviceStore.queueStats().sent, 1);
  } finally {
    rmSync(multiDeviceDir, { recursive: true, force: true });
  }

  const reopened = PushStore.open(stateDir, 'CID-ME', env, { sendNotification: async () => {} });
  const resumed = new PushDeliveryQueue({
    store: reopened, client: {}, identityCid: 'CID-ME', log: { info() {}, warn() {} },
    now: () => now, random: () => 0, project: async () => { throw new Error('sent jobs do not replay'); }, autoStart: false,
  });
  assert.equal(resumed.enqueue({ event: 'message_received', sender_id: 'CID-A', wire_id: 'WIRE-1' }), false,
    'restart keeps the terminal dedupe ledger');

  const pendingWire = 'WIRE-PENDING-RESTART';
  assert.equal(resumed.enqueue({ event: 'message_received', sender_id: 'CID-A', wire_id: pendingWire }), true);
  const restartStore = PushStore.open(stateDir, 'CID-ME', env, { sendNotification: async () => {} });
  const restartQueue = new PushDeliveryQueue({
    store: restartStore, client: {}, identityCid: 'CID-ME', log: { info() {}, warn() {} },
    now: () => now, random: () => 0, autoStart: false,
    project: async (job) => ({
      v: 1, kind: 'message', title: 'Restart', body: 'resumed', contact_id: job.contactId,
      wire_id: job.wireId, url: `/chats/${job.contactId}`,
    }),
  });
  await restartQueue.drainDue();
  assert.equal(restartStore.queueStats().pending, 0, 'a pending job resumes and completes after store restart');

  const emptyDir = mkdtempSync(join(tmpdir(), 'messenger-push-delivery-empty-'));
  try {
    const empty = PushStore.open(emptyDir, 'CID-ME', env, { sendNotification: async () => {} });
    const noBindings = new PushDeliveryQueue({
      store: empty, client: {}, identityCid: 'CID-ME', log: { info() {}, warn() {} }, autoStart: false,
      project: async () => { throw new Error('zero bindings must not project'); },
    });
    assert.equal(noBindings.enqueue({ event: 'file_received', sender_id: 'CID-A', wire_id: 'FILE-1' }), false,
      'zero bindings short-circuit before projection or durable work');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  const policyDir = mkdtempSync(join(tmpdir(), 'messenger-push-delivery-policy-'));
  try {
    const roomIdentity = 'ours-cowork-release-2-room-01hzyk8m0000000000000000aa';
    const roomBody = JSON.stringify({
      version: 1, kind: 'room_msg', room_id: '01hzyk8m0000000000000000aa', message_id: 'ROOM-MESSAGE',
      author: { identity: 'CID-AUTHOR-MUST-NOT-RENDER', display_name: 'Builder', role: 'builder' },
      text: 'Room deploy is green', signature: 'SIG',
    });
    const delivered = [];
    const policyStore = PushStore.open(policyDir, 'CID-ME', env, {
      sendNotification: async (target, payload) => {
        if (target.endpoint.endsWith('/dead')) throw Object.assign(new Error('gone'), { statusCode: 410 });
        delivered.push({ endpoint: target.endpoint, event: JSON.parse(payload) });
      },
    });
    policyStore.ensure({ ...subscription, endpoint: 'https://push.example/full', preview: 'full' });
    policyStore.ensure({ ...subscription, endpoint: 'https://push.example/private', preview: 'private' });
    policyStore.ensure({ ...subscription, endpoint: 'https://push.example/dead', preview: 'full' });
    const rows = [
      { wire_id: 'FILE-1', from: { id: 'CID-A', name: 'Alice' }, kind: 'file', mime: 'application/pdf', filename: 'report.pdf' },
      { wire_id: 'PHOTO-1', from: { id: 'CID-A', name: 'Alice' }, kind: 'file', mime: 'image/png', filename: 'photo.png' },
      { wire_id: 'VOICE-1', from: { id: 'CID-A', name: 'Alice' }, kind: 'voice_message', mime: 'audio/ogg', filename: 'voice.ogg' },
    ];
    const policyQueue = new PushDeliveryQueue({
      store: policyStore,
      client: {
        async getHistoryItem({ wire_id }) {
          if (wire_id === 'MESSAGE-1') {
            return { direction: 'in', wire_id, text: 'full message text', peer: { id: 'CID-A', name: 'Alice' } };
          }
          return wire_id === 'MESSAGE-ROOM'
            ? { direction: 'in', wire_id, text: roomBody, peer: { id: 'CID-A', name: roomIdentity } }
            : null;
        },
        async getFileInfo({ wire_id }) {
          const row = rows.find((candidate) => candidate.wire_id === wire_id);
          return row ? { ...row, direction: 'in', peer: row.from } : null;
        },
      },
      identityCid: 'CID-ME', log: { info() {}, warn() {} }, now: () => now, random: () => 0, autoStart: false,
    });
    policyQueue.enqueue({ event: 'message_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'MESSAGE-1' });
    policyQueue.enqueue({ event: 'message_received', sender_id: 'CID-A', sender_name: roomIdentity, wire_id: 'MESSAGE-ROOM' });
    policyQueue.enqueue({ event: 'file_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'FILE-1' });
    policyQueue.enqueue({ event: 'file_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'PHOTO-1' });
    policyQueue.enqueue({ event: 'file_received', sender_id: 'CID-A', sender_name: 'Alice', wire_id: 'VOICE-1' });
    await policyQueue.drainDue();
    const full = delivered.filter((row) => row.endpoint.endsWith('/full')).map((row) => row.event);
    assert.deepEqual(full.map((event) => event.kind).sort(), ['file', 'message', 'message', 'photo', 'voice'],
      'message/file/photo/voice projection policies remain distinct');
    assert.ok(full.some((event) => event.body === 'full message text'));
    assert.ok(full.some((event) => event.body === 'Photo: photo.png'));
    const roomPush = full.find((event) => event.wire_id === 'MESSAGE-ROOM');
    assert.equal(roomPush.title, 'Release 2 room', 'durable push renders the configured friendly room label');
    assert.equal(roomPush.body, 'Builder · Room deploy is green', 'durable push renders the shared room preview, never raw JSON');
    assert.ok(!JSON.stringify(roomPush).includes(roomIdentity), 'durable push leaks no generated room identity label');
    assert.ok(!JSON.stringify(roomPush).includes('CID-AUTHOR-MUST-NOT-RENDER'), 'durable push preserves room anonymity');
    assert.ok(full.every((event) => event.contact_id === 'CID-A' && event.wire_id),
      'every payload preserves authenticated CID and wire correlation');
    assert.ok(full.every((event) => event.url === `/chats/CID-A#chat-message-${encodeURIComponent(event.wire_id)}`),
      'every notification deep-links to its exact conversation message');
    const privatePayloads = delivered.filter((row) => row.endpoint.endsWith('/private')).map((row) => row.event);
    assert.ok(privatePayloads.every((event) => event.title === 'ours messenger'
      && !event.body.includes('full message text') && !event.body.includes('.png') && !event.body.includes('.pdf') && !event.body.includes('.ogg')),
    'Private mode removes content and filenames without changing full-preview default');
    assert.equal(policyStore.bindingCount, 2, '410 permanently prunes a dead binding');
    assert.equal(policyQueue.stats.pruned, 1, 'pruning is observable without logging endpoint capability');
  } finally {
    rmSync(policyDir, { recursive: true, force: true });
  }
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log('push-delivery OK — projection retry, transient backoff, dedupe, restart, and zero-binding short-circuit');
