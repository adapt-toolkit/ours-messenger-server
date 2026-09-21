// Real Firefox + Mozilla Autopush over the built messenger and V1 daemon.
// This fixture must stay outside the offline/browser suites: it needs public
// HTTPS/WSS egress and proves native receipt, not merely provider acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk';
import { firefox } from '@playwright/test';
import { sleep, startProcess, stopProcess, unusedPort, waitFor, waitForPort } from './v1-runtime.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const cli = join(ROOT, process.env.MESSENGER_V1_DIST ?? 'dist', 'cli.js');
const oursCli = join(ROOT, 'node_modules/@ours.network/daemon/dist/cli.js');
const state = mkdtempSync(join(tmpdir(), 'messenger-live-push-'));
const oursState = join(state, 'ours');
const messengerState = join(state, 'messenger');
mkdirSync(oursState, { mode: 0o700 });
const clean = { ...process.env };
for (const key of Object.keys(clean)) if (key.startsWith('OURS_')) delete clean[key];
const brokerPort = await unusedPort();
const daemonPort = await unusedPort();
const messengerPort = await unusedPort();
const endpoint = `http://127.0.0.1:${daemonPort}`;
const origin = `http://127.0.0.1:${messengerPort}`;
const daemonId = randomUUID();
const credentialPath = join(oursState, 'daemon-token');
const configPath = join(state, 'ours.json');
writeFileSync(configPath, JSON.stringify({
  brokerUrl: `ws://127.0.0.1:${brokerPort}`,
  port: daemonPort,
  stateDir: oursState,
  apiVisibility: 'owner',
  apiTokenDeliveryFiles: [],
}), { mode: 0o600 });
const oursEnv = { ...clean, HOME: state, OURS_CONFIG: configPath, OURS_DAEMON_ID: daemonId };
const messengerEnv = {
  ...clean,
  HOME: state,
  OURS_DAEMON_URL: endpoint,
  OURS_DAEMON_ID: daemonId,
  OURS_DAEMON_CREDENTIAL_PATH: credentialPath,
  OURS_MESSENGER_IDENTITY: 'MessengerLivePush',
  OURS_MESSENGER_STATE_DIR: messengerState,
  OURS_MESSENGER_HOST: '127.0.0.1',
  OURS_MESSENGER_PORT: String(messengerPort),
  OURS_MESSENGER_PUBLIC_ORIGIN: origin,
};
const selection = {
  endpoint,
  expectedInstanceId: daemonId,
  credentialPath,
  sessionMode: 'external',
  env: {},
};
const attach = () => attachOursClient({ ...selection, leaseToken: randomUUID() });
const defaults = (name) => ({
  name,
  bio: 'Live Web Push integration fixture',
  exposeLocal: false,
  localAutoAccept: true,
});
const foregroundText = 'foreground live push evidence';
const backgroundText = 'background live push evidence';
const endpointHost = 'updates.push.services.mozilla.com';
const stage = (name, facts = {}) => console.log(`LIVE_PUSH_STAGE ${JSON.stringify({ name, ...facts })}`);
const redact = (value) => String(value?.stack ?? value?.message ?? value)
  .replace(/(?:https?|wss?):\/\/[^\s)'\"]+/g, '[url-redacted]')
  .replace(/(?:token|credential|authorization|p256dh|auth)\s*[:=]\s*[^\s,}]+/gi, '$1=[redacted]')
  .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
const boundedText = (value) => redact(value).replace(/\s+/g, ' ').trim().slice(0, 500);

let broker;
let daemon;
let messenger;
let root;
let creator;
let peer;
let browser;
let context;
let page;
let identityCid;
let peerCid;
let subscriptionCreated = false;
let failed = false;

async function api(path, body) {
  const response = await fetch(origin + path, {
    signal: AbortSignal.timeout(5_000),
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : {
      'content-type': 'application/json',
      origin,
      'x-ours-messenger-csrf': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, 200, `Messenger ${path} must return HTTP 200`);
  return response.json();
}

async function startDaemon() {
  daemon = startProcess([oursCli, 'daemon', 'serve'], oursEnv, ROOT);
  await waitFor(async () => {
    const response = await fetch(endpoint + '/selection', { signal: AbortSignal.timeout(1_000) });
    return response.ok && (await response.json()).instanceId === daemonId && existsSync(credentialPath);
  }, 'real V1 daemon selection', 180_000);
}

async function startMessenger() {
  messenger = startProcess([cli, 'serve'], messengerEnv, ROOT);
  let outcome;
  messenger.exited.then((value) => { outcome = value; });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (outcome) throw new Error(`Built messenger exited before healthy (code=${outcome.code}, signal=${outcome.signal})`);
    try {
      const health = await api('/api/healthz');
      if (health.status === 'ok') {
        assert.equal(health.identityCid, identityCid);
        return;
      }
    } catch { /* bounded readiness retry */ }
    await sleep(100);
  }
  throw new Error('Built messenger did not become healthy within fixture allowance');
}

async function historyMessage(text) {
  return waitFor(async () => {
    const history = await api(`/api/conversations/${encodeURIComponent(peerCid)}`);
    return history.messages.find((row) => row.text === text);
  }, 'canonical messenger history message', 45_000);
}

async function nativeSubscriptionExists() {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.pushManager.getSubscription()) !== null;
  });
}

async function nativeNotifications() {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map((notification) => ({
      tag: notification.tag,
      body: notification.body,
    }));
  });
}

async function normalBrowserUnsubscribe() {
  if (!page || page.isClosed()) return;
  let subscribed = false;
  try { subscribed = await nativeSubscriptionExists(); } catch { return; }
  if (!subscribed) return;
  await page.goto(`${origin}/chats/${encodeURIComponent(peerCid)}`, {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  });
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.waitFor({ timeout: 30_000 });
  await settings.click();
  const disable = page.getByRole('button', { name: 'Disable notifications' });
  await disable.waitFor({ timeout: 30_000 });
  await disable.click();
  await page.getByText('Off — enable notifications for this browser.', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await nativeSubscriptionExists(), false, 'normal UI disable must remove the native Firefox subscription');
  await waitFor(async () => (await api('/api/state')).pushSubscriptions === 0,
    'server push binding deletion', 30_000);
  subscriptionCreated = false;
  stage('notification-cleanup', { uiDisabled: true, nativeSubscriptionRemoved: true });
}

const watchdog = setTimeout(() => {
  messenger?.child.kill('SIGKILL');
  daemon?.child.kill('SIGKILL');
  broker?.child.kill('SIGKILL');
  console.error('LIVE_PUSH_FAIL fixture watchdog expired');
  process.exit(124);
}, 600_000);

try {
  stage('fixture-start');
  stage('firefox-launch-start', { timeoutMs: 30_000 });
  browser = await firefox.launch({
    headless: false,
    timeout: 30_000,
    firefoxUserPrefs: {
      'dom.push.serverURL': 'wss://push.services.mozilla.com/',
      'dom.push.connection.enabled': true,
      // Use Firefox's real built-in alerts; this container has no desktop notification service.
      'alerts.useSystemBackend': false,
    },
  });
  stage('firefox-launch-complete', { version: browser.version() });

  broker = startProcess([
    '/cowork/node_modules/.bin/adapt-broker', '--host', '127.0.0.1',
    '--port', String(brokerPort), '--test_mode',
  ], clean, ROOT);
  await waitForPort(brokerPort);
  await startDaemon();
  root = await attach();
  await root.createRootIdentity({ ...defaults('MessengerLiveRoot'), skipIfRootExists: false });
  creator = await attach();
  await creator.createIdentity(defaults('MessengerLivePush'));
  identityCid = (await creator.currentIdentity()).cid;
  await creator.releaseLease();
  await creator.close();
  creator = undefined;
  peer = await attach();
  await peer.createIdentity(defaults('MessengerLivePeer'));
  peerCid = (await peer.currentIdentity()).cid;
  await startMessenger();
  const invite = await api('/api/invites', { mode: 'public' });
  await peer.addContact({ invite: invite.blob });
  await waitFor(async () => (await peer.listContacts()).contacts.some((row) => row.name === 'MessengerLivePush'),
    'real peer contact', 45_000);
  await waitFor(async () => (await api('/api/contacts')).contacts.some((row) => row.container_id === peerCid),
    'messenger peer contact', 45_000);
  stage('real-runtime-ready', { broker: true, daemon: true, messenger: true, peer: true });

  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['notifications'], { origin });
  page = await context.newPage();
  const pageRuntimeErrors = [];
  const recordPageRuntimeError = (kind, value) => {
    if (pageRuntimeErrors.length < 8) pageRuntimeErrors.push({ kind, message: boundedText(value) });
  };
  page.on('pageerror', (error) => recordPageRuntimeError('pageerror', error));
  page.on('console', (message) => {
    if (message.type() === 'error') recordPageRuntimeError('console-error', message.text());
  });
  await page.goto(`${origin}/chats/${encodeURIComponent(peerCid)}`, {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Settings' }).waitFor({ timeout: 30_000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
  stage('first-load-worker-ready', { registration: true, controller: true });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: 'Settings' }).waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Settings' }).click();
  const enable = page.getByRole('button', { name: 'Enable notifications' });
  const initializationStarted = Date.now();
  const enableDisabledBeforeProbe = await enable.isDisabled();
  const capabilities = await page.evaluate(async () => {
    const hasServiceWorker = 'serviceWorker' in navigator;
    const registration = hasServiceWorker ? await navigator.serviceWorker.getRegistration() : undefined;
    return {
      isSecureContext: window.isSecureContext,
      notification: 'Notification' in window,
      notificationPermission: 'Notification' in window ? Notification.permission : 'unavailable',
      pushManager: typeof window.PushManager === 'function',
      serviceWorker: hasServiceWorker,
      workerSupported: hasServiceWorker && window.isSecureContext,
      workerController: hasServiceWorker && navigator.serviceWorker.controller !== null,
      workerRegistration: registration !== undefined,
      registrationPushManager: registration?.pushManager !== undefined,
    };
  });
  const subscriptionProbe = await page.evaluate(async () => {
    const started = performance.now();
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.pushManager) {
        return { completed: false, exists: false, elapsedMs: Math.round(performance.now() - started), error: 'push manager unavailable' };
      }
      const subscription = await Promise.race([
        registration.pushManager.getSubscription(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getSubscription timeout')), 5_000)),
      ]);
      return { completed: true, exists: subscription !== null, elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      return {
        completed: false,
        exists: false,
        elapsedMs: Math.round(performance.now() - started),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  });
  const initializationDeadline = initializationStarted + 6_500;
  while (Date.now() < initializationDeadline && await enable.count() === 1 && await enable.isDisabled()) {
    await sleep(100);
  }
  const notificationGuidance = await page.getByRole('heading', { name: 'Notifications' })
    .locator('xpath=following-sibling::p[1]').textContent();
  const pushActionText = await page.getByRole('dialog').locator('button.btn.primary').textContent();
  const appAlertText = (await page.getByRole('alert').allTextContents()).slice(0, 4).map(boundedText);
  const appToastText = (await page.locator('.app-banners .banner.msg').allTextContents()).slice(0, 4).map(boundedText);
  stage('browser-capabilities', {
    ...capabilities,
    enableDisabledBeforeProbe,
    enableControlPresentAfterProbe: await enable.count() === 1,
    enableDisabledAfterProbe: await enable.count() === 1 && await enable.isDisabled(),
    enableBusy: pushActionText === 'Repairing…',
    initializationObservationMs: Date.now() - initializationStarted,
    notificationGuidance,
    subscriptionProbe: {
      completed: subscriptionProbe.completed,
      exists: subscriptionProbe.exists,
      elapsedMs: subscriptionProbe.elapsedMs,
      ...(subscriptionProbe.error ? { error: boundedText(subscriptionProbe.error) } : {}),
    },
    pageRuntimeErrors,
    appAlertText,
    appToastText,
  });

  const [ensured] = await Promise.all([
    page.waitForResponse((response) => {
      try { return new URL(response.url()).pathname === '/api/push/subscriptions/ensure'; }
      catch { return false; }
    }, { timeout: 90_000 }),
    enable.click({ timeout: 30_000 }),
  ]);
  assert.equal(ensured.status(), 200, 'server must acknowledge the real browser subscription');
  let ensurePayload;
  try { ensurePayload = JSON.parse(ensured.request().postData() ?? ''); }
  catch { throw new Error('Browser subscription request body was not valid JSON'); }
  let actualEndpointHost;
  try { actualEndpointHost = new URL(ensurePayload.endpoint).hostname; }
  catch { throw new Error('Browser subscription endpoint was not a valid URL'); }
  assert.equal(actualEndpointHost, endpointHost, 'Firefox must subscribe to Mozilla production Autopush');
  await page.getByText('On — this browser and the server agree on the current Web Push configuration.', { exact: true })
    .waitFor({ timeout: 90_000 });
  subscriptionCreated = await nativeSubscriptionExists();
  assert.equal(subscriptionCreated, true, 'Firefox must retain the acknowledged native subscription');
  await waitFor(async () => {
    const current = await api('/api/state');
    return current.pushSubscriptions === 1 && current.watcher.presenceSockets === 1;
  }, 'acknowledged subscription and foreground presence', 30_000);
  stage('subscription-on', { ensureStatus: ensured.status(), endpointHost: actualEndpointHost });

  await page.getByRole('button', { name: 'Close Settings' }).click();
  const beforeForeground = (await api('/api/state')).pushQueue;
  await peer.sendMessage({ contact: identityCid, text: foregroundText });
  const foreground = await historyMessage(foregroundText);
  await page.getByLabel('Conversation timeline').getByText(foregroundText, { exact: true }).waitFor({ timeout: 45_000 });
  await waitFor(async () => (await api('/api/state')).pushQueue.sent > beforeForeground.sent,
    'foreground delivery accounting', 45_000);
  assert.equal((await nativeNotifications()).some((row) => row.tag === `ours-${foreground.wire_id.slice(0, 256)}`), false,
    'foreground delivery must render in the app without creating a native notification');
  stage('foreground-message', { renderedInActualUi: true, nativeNotificationSuppressed: true });

  await page.goto(`${origin}/sw.js`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const heartbeatWaitStarted = Date.now();
  await sleep(32_000);
  const heartbeatAgeMs = Date.now() - heartbeatWaitStarted;
  assert(heartbeatAgeMs > 30_000, 'foreground heartbeat must expire before the background send');
  const beforeBackground = (await api('/api/state')).pushQueue;
  await peer.sendMessage({ contact: identityCid, text: backgroundText });
  const background = await historyMessage(backgroundText);
  const expectedTag = `ours-${background.wire_id.slice(0, 256)}`;
  const notification = await waitFor(async () => {
    const rows = await nativeNotifications();
    return rows.find((row) => row.tag === expectedTag && row.body === backgroundText);
  }, 'native Firefox service-worker notification', 150_000);
  assert.equal(notification.tag, expectedTag);
  assert.equal(notification.body, backgroundText);
  const afterBackground = await waitFor(async () => {
    const current = await api('/api/state');
    return current.pushQueue.delivered > beforeBackground.delivered ? current.pushQueue : null;
  }, 'successful provider delivery accounting', 45_000);
  stage('native-notification-received', {
    heartbeatAgeMs,
    providerResult: 'accepted',
    deliveredDelta: afterBackground.delivered - beforeBackground.delivered,
    canonicalTagMatched: true,
    canonicalBodyMatched: true,
  });
  console.log('MESSENGER_V1_LIVE_PUSH_PASS');
} catch (error) {
  failed = true;
  process.exitCode = 1;
  console.error(`LIVE_PUSH_FAIL ${redact(error)}`);
} finally {
  try {
    if (subscriptionCreated || (page && !page.isClosed() && await nativeSubscriptionExists().catch(() => false))) {
      await normalBrowserUnsubscribe();
    }
  } catch (error) {
    failed = true;
    process.exitCode = 1;
    console.error(`LIVE_PUSH_CLEANUP_FAIL browser ${redact(error)}`);
  }
  try { await context?.close(); } catch (error) {
    failed = true; process.exitCode = 1; console.error(`LIVE_PUSH_CLEANUP_FAIL context ${redact(error)}`);
  }
  try { await browser?.close(); } catch (error) {
    failed = true; process.exitCode = 1; console.error(`LIVE_PUSH_CLEANUP_FAIL browser-close ${redact(error)}`);
  }
  try {
    await stopProcess(messenger);
    if (messenger) assert.equal((await messenger.exited).code, 0, 'messenger must complete normal terminal cleanup');
  } catch (error) {
    failed = true; process.exitCode = 1; console.error(`LIVE_PUSH_CLEANUP_FAIL messenger ${redact(error)}`);
  }
  for (const client of [peer, creator, root].filter(Boolean)) {
    try { await client.releaseLease(); await client.close(); }
    catch (error) {
      failed = true; process.exitCode = 1; console.error(`LIVE_PUSH_CLEANUP_FAIL client ${redact(error)}`);
    }
  }
  try { await stopProcess(daemon); } catch (error) {
    failed = true; process.exitCode = 1; console.error(`LIVE_PUSH_CLEANUP_FAIL daemon ${redact(error)}`);
  }
  try { await stopProcess(broker, 'SIGKILL'); } catch (error) {
    failed = true; process.exitCode = 1; console.error(`LIVE_PUSH_CLEANUP_FAIL broker ${redact(error)}`);
  }
  rmSync(state, { recursive: true, force: true });
  clearTimeout(watchdog);
  stage('fixture-cleanup', { normal: !failed });
}
