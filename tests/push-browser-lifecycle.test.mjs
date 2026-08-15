import assert from 'node:assert/strict';
import {
  activateWorkerUpdate,
  currentPushState,
  disablePush,
  enablePush,
  isIOSStandalone,
  requestNotificationPermission,
} from '../web/src/pwa.ts';

const key = (seed) => Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : (seed + index) % 256);
const publicKey = (bytes) => Buffer.from(bytes).toString('base64url');

async function permissionFrom(requestPermission, current = 'default') {
  return requestNotificationPermission({
    notification: { permission: current, requestPermission },
    timeoutMs: 100,
  });
}

assert.equal(await permissionFrom(() => Promise.resolve('granted')), 'granted', 'modern Promise permission resolves');
assert.equal(await permissionFrom((callback) => { callback('granted'); }), 'granted', 'legacy callback permission resolves');
assert.equal(await permissionFrom((callback) => { setTimeout(() => callback('granted'), 10); }), 'granted',
  'undefined-return legacy callback is awaited instead of becoming a false denial');
await assert.rejects(
  () => permissionFrom(() => new Promise(() => {})),
  /permission.*did not complete/i,
  'a stalled platform permission prompt is bounded',
);

const currentKey = key(30);
const staleKey = key(90);
let unsubscribed = 0;
let subscribed = 0;
let ensured;
const staleSubscription = {
  endpoint: 'https://push.example/stale-capability',
  options: { applicationServerKey: staleKey.buffer },
  toJSON: () => ({ endpoint: 'https://push.example/stale-capability', keys: { p256dh: 'stale', auth: 'stale' } }),
  async unsubscribe() { unsubscribed++; return true; },
};
const repairedSubscription = {
  endpoint: 'https://push.example/fresh-capability',
  options: { applicationServerKey: currentKey.buffer },
  toJSON: () => ({
    endpoint: 'https://push.example/fresh-capability',
    keys: { p256dh: Buffer.alloc(65, 7).toString('base64url'), auth: Buffer.alloc(16, 8).toString('base64url') },
  }),
  async unsubscribe() { return true; },
};
const registration = {
  pushManager: {
    async getSubscription() { return staleSubscription; },
    async subscribe(options) {
      subscribed++;
      assert.deepEqual(Buffer.from(options.applicationServerKey), Buffer.from(currentKey));
      return repairedSubscription;
    },
  },
};
const deps = {
  notification: { permission: 'granted', requestPermission: () => Promise.resolve('granted') },
  navigator: { userAgent: 'test browser', serviceWorker: { ready: Promise.resolve(registration) } },
  api: {
    async vapidPublicKey() {
      return { publicKey: publicKey(currentKey), fingerprint: 'fp-current', configEpoch: 2 };
    },
    async ensurePush(body) {
      ensured = body;
      return { status: 'on', binding_id: 'binding-opaque', fingerprint: 'fp-current', configEpoch: 2, preview: 'full' };
    },
  },
};

const enabled = await enablePush(registration, { preview: 'full' }, deps);
assert.equal(unsubscribed, 1, 'a stale applicationServerKey is unsubscribed exactly once');
assert.equal(subscribed, 1, 'a stale key is repaired with one fresh subscription');
assert.equal(enabled.status, 'on', 'UI may report On only after the server ensure acknowledgement');
assert.equal(enabled.bindingId, 'binding-opaque');
assert.equal(ensured.endpoint, repairedSubscription.endpoint);

let acked = false;
const matchingRegistration = {
  pushManager: {
    async getSubscription() { return repairedSubscription; },
    async subscribe() { throw new Error('matching subscriptions must be reused'); },
  },
};
const state = await currentPushState(matchingRegistration, {
  ...deps,
  api: { ...deps.api, async ensurePush(body) {
    acked = true;
    assert.equal(body.preview, undefined, 'reload health check does not overwrite the saved preview mode');
    return { ...(await deps.api.ensurePush(body)), preview: 'private' };
  } },
});
assert.equal(acked, true, 'reload re-ensures the browser capability with the server');
assert.equal(state.status, 'on', 'a matching browser capability is not false-green until server ack');
assert.equal(state.preview, 'private', 'reload restores the server-acknowledged preview mode');

assert.equal(isIOSStandalone(
  { userAgent: 'Mozilla/5.0 (iPhone)', standalone: true },
  { matchMedia: () => ({ matches: false }) },
), true, 'iOS Home Screen mode is detected independently of beforeinstallprompt');
assert.equal(isIOSStandalone(
  { userAgent: 'Mozilla/5.0 (iPhone)', standalone: false },
  { matchMedia: () => ({ matches: false }) },
), false, 'an iOS Safari tab is not misreported as an installed PWA');

let updateListener;
let reloads = 0;
let updateMessages = 0;
const workerContainer = {
  addEventListener(type, listener) { if (type === 'controllerchange') updateListener = listener; },
  removeEventListener() {},
};
const applying = activateWorkerUpdate({
  waiting: { postMessage() { updateMessages++; queueMicrotask(() => { updateListener(); updateListener(); }); } },
}, () => { reloads++; }, workerContainer);
await applying;
assert.equal(updateMessages, 1, 'the waiting worker is activated once');
assert.equal(reloads, 1, 'controllerchange reloads exactly once rather than reloading immediately');

let localDisable = 0;
let serverDisable = 0;
await assert.rejects(() => disablePush({
  pushManager: { async getSubscription() { return { async unsubscribe() { localDisable++; return true; } }; } },
}, { status: 'on', preview: 'full', bindingId: 'binding-opaque' }, {
  ...deps,
  api: { ...deps.api, async deletePush() { serverDisable++; throw new Error('temporary server failure'); } },
}));
assert.equal(serverDisable, 1);
assert.equal(localDisable, 1, 'disable attempts both server and browser legs so retry can converge');

console.log('push-browser-lifecycle OK — permission compatibility/timeouts, stale-key repair, and server-ack health');
