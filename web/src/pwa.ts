import { api } from './api.js';
import { dispatchLiveEvent } from './events.js';
import type { PushPreviewMode, PushState, PushView } from './types.js';

export interface WorkerState {
  supported: boolean;
  offline: boolean;
  updateAvailable: boolean;
  registration: ServiceWorkerRegistration | null;
}

export interface WorkerUpdateOptions {
  shouldDeferReload?: () => boolean;
  reload?: () => void;
}

export function workerControllerChangeAction(
  hadControllerAtLoad: boolean,
  reloading: boolean,
  busy: boolean,
): 'ignore' | 'defer' | 'reload' {
  if (!hadControllerAtLoad || reloading) return 'ignore';
  return busy ? 'defer' : 'reload';
}

interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(callback?: (permission: NotificationPermission) => void): Promise<NotificationPermission> | void;
}

interface PushApi {
  vapidPublicKey(): Promise<{ publicKey: string; fingerprint: string; configEpoch: number }>;
  ensurePush(value: PushSubscriptionJSON & {
    label?: string; preview?: PushPreviewMode; binding_id?: string;
  }): Promise<{
    status: 'on'; binding_id: string; fingerprint: string; configEpoch: number; preview: PushPreviewMode;
  }>;
  deletePush(bindingId: string): Promise<{ removed: boolean }>;
}

export interface PushBrowserDependencies {
  readonly api: PushApi;
  readonly notification?: NotificationApi;
  readonly navigator: Pick<Navigator, 'userAgent'> & {
    serviceWorker: Pick<ServiceWorkerContainer, 'ready'>;
  };
}

function browserDependencies(): PushBrowserDependencies {
  return {
    api,
    notification: globalThis.Notification as unknown as NotificationApi | undefined,
    navigator: navigator as PushBrowserDependencies['navigator'],
  };
}

function timeout<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${description} did not complete within ${ms / 1_000}s — try again`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function registerMessengerWorker(
  onState: (state: WorkerState) => void,
  options: WorkerUpdateOptions = {},
): Promise<() => void> {
  let registration: ServiceWorkerRegistration | null = null;
  let updateAvailable = false;
  let reloading = false;
  const supported = 'serviceWorker' in navigator && window.isSecureContext;
  const emit = () => onState({ supported, offline: !navigator.onLine, updateAvailable, registration });
  const online = () => emit();
  const offline = () => emit();
  const visible = () => {
    if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
  };
  const workerMessage = (event: MessageEvent) => {
    if (event.data?.type === 'ours-push-repair-required') {
      window.dispatchEvent(new Event('ours-push-repair-required'));
      return;
    }
    if (event.data?.type === 'ours-push-foreground') {
      const contact = event.data.contact_id;
      const wire = event.data.wire_id;
      const kind = event.data.kind;
      if (typeof contact === 'string' && typeof wire === 'string') {
        dispatchLiveEvent({
          v: 1,
          type: kind === 'file' ? 'file_received' : 'message_received',
          contact_id: contact,
          wire_id: wire,
          date: new Date().toISOString(),
        });
      }
    }
  };
  // Snapshot before registration: clients.claim() on the very first install is
  // not an update and must not cause a redundant reload.
  const hadControllerAtLoad = supported && !!navigator.serviceWorker.controller;
  const controllerChanged = () => {
    const action = workerControllerChangeAction(hadControllerAtLoad, reloading, options.shouldDeferReload?.() ?? false);
    if (action === 'ignore') return;
    if (action === 'defer') {
      updateAvailable = true;
      emit();
      return;
    }
    reloading = true;
    (options.reload ?? (() => location.reload()))();
  };
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  document.addEventListener('visibilitychange', visible);
  navigator.serviceWorker?.addEventListener('message', workerMessage);
  navigator.serviceWorker?.addEventListener('controllerchange', controllerChanged);

  if (supported) {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    const track = (worker: ServiceWorker | null) => worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        updateAvailable = true;
        emit();
      }
    });
    track(registration.installing);
    registration.addEventListener('updatefound', () => track(registration?.installing ?? null));
    void registration.update().catch(() => {});
  }
  emit();
  return () => {
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
    document.removeEventListener('visibilitychange', visible);
    navigator.serviceWorker?.removeEventListener('message', workerMessage);
    navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
  };
}

export async function activateWorkerUpdate(
  registration: ServiceWorkerRegistration,
  reload: () => void = () => location.reload(),
  serviceWorker: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'> = navigator.serviceWorker,
): Promise<void> {
  const waiting = registration.waiting;
  // skipWaiting may already have promoted the new worker. In that deferred
  // state the banner's explicit action is simply a safe page reload.
  if (!waiting) {
    reload();
    return;
  }
  await timeout(new Promise<void>((resolve) => {
    let applied = false;
    const changed = () => {
      if (applied) return;
      applied = true;
      serviceWorker.removeEventListener('controllerchange', changed);
      reload();
      resolve();
    };
    serviceWorker.addEventListener('controllerchange', changed);
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }), 10_000, 'service-worker update');
}

export function applicationServerKey(value: string): Uint8Array {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bufferBytes(value: BufferSource | null | undefined): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function equalKeys(left: BufferSource | null | undefined, right: Uint8Array): boolean {
  const bytes = bufferBytes(left);
  return !!bytes && bytes.length === right.length && bytes.every((value, index) => value === right[index]);
}

export function isIOS(userAgent = navigator.userAgent): boolean {
  return /iP(?:hone|ad|od)/.test(userAgent);
}

export function isIOSStandalone(
  nav: Navigator = navigator,
  media: Pick<Window, 'matchMedia'> = window,
): boolean {
  return isIOS(nav.userAgent) && (
    (nav as Navigator & { standalone?: boolean }).standalone === true
    || media.matchMedia('(display-mode: standalone)').matches
  );
}

export function pushGuidance(): string | null {
  if (isIOS() && !isIOSStandalone()) {
    return 'On iPhone or iPad, tap Share → Add to Home Screen, then open messenger from its Home Screen icon (iOS 16.4 or later).';
  }
  if (!('Notification' in window) || !window.PushManager || !('serviceWorker' in navigator)) {
    return 'Notifications require a current secure browser with service-worker and Web Push support.';
  }
  if (Notification.permission === 'denied') {
    return isIOS()
      ? 'Allow messenger in iOS Settings → Notifications, then return and choose Repair.'
      : 'Allow notifications in this site’s browser settings, then return and choose Repair.';
  }
  return null;
}

export function requestNotificationPermission(options: {
  notification?: NotificationApi;
  timeoutMs?: number;
} = {}): Promise<NotificationPermission> {
  const notification = options.notification ?? browserDependencies().notification;
  if (!notification) return Promise.reject(new Error('notification permission is unavailable'));
  const result = new Promise<NotificationPermission>((resolve, reject) => {
    let settled = false;
    const done = (value?: NotificationPermission) => {
      if (settled) return;
      const permission = value ?? notification.permission;
      if (permission !== 'granted' && permission !== 'denied' && permission !== 'default') return;
      settled = true;
      resolve(permission);
    };
    try {
      const possible = notification.requestPermission(done);
      if (possible && typeof possible.then === 'function') possible.then(done, reject);
    } catch (error) {
      reject(error);
    }
  });
  return timeout(result, options.timeoutMs ?? 15_000, 'notification permission');
}

function supported(registration: ServiceWorkerRegistration | null, deps: PushBrowserDependencies): boolean {
  return !!registration && !!registration.pushManager && !!deps.notification && !!deps.navigator.serviceWorker;
}

function state(status: PushState, extra: Partial<PushView> = {}): PushView {
  return { status, preview: 'full', ...extra };
}

async function subscribeWithRepair(
  registration: ServiceWorkerRegistration,
  key: Uint8Array,
  forceFresh: boolean,
): Promise<PushSubscription> {
  let existing = await timeout(registration.pushManager.getSubscription(), 5_000, 'push subscription lookup');
  if (forceFresh || (existing?.options.applicationServerKey && !equalKeys(existing.options.applicationServerKey, key))) {
    if (existing) await timeout(existing.unsubscribe(), 5_000, 'stale push unsubscribe');
    existing = null;
  }
  if (existing && equalKeys(existing.options.applicationServerKey, key)) return existing;
  try {
    return await timeout(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }), 15_000, 'push subscribe');
  } catch (firstError) {
    const stale = await registration.pushManager.getSubscription();
    if (!stale) throw firstError;
    await timeout(stale.unsubscribe(), 5_000, 'stale push unsubscribe');
    return timeout(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }), 15_000, 'push repair');
  }
}

async function ensureGranted(
  registration: ServiceWorkerRegistration,
  preview: PushPreviewMode | undefined,
  forceFresh: boolean,
  deps: PushBrowserDependencies,
): Promise<PushView> {
  const config = await deps.api.vapidPublicKey();
  const ready = await timeout(Promise.resolve(deps.navigator.serviceWorker.ready), 10_000, 'service-worker readiness');
  const activeRegistration = ready ?? registration;
  const key = applicationServerKey(config.publicKey);
  const subscription = await subscribeWithRepair(activeRegistration, key, forceFresh);
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('browser returned an incomplete push subscription');
  const ack = await deps.api.ensurePush({
    ...json,
    label: deps.navigator.userAgent.slice(0, 160),
    ...(preview === undefined ? {} : { preview }),
  });
  if (ack.status !== 'on' || ack.fingerprint !== config.fingerprint || ack.configEpoch !== config.configEpoch) {
    throw new Error('server did not acknowledge the current Web Push configuration');
  }
  return state('on', { bindingId: ack.binding_id, fingerprint: ack.fingerprint, configEpoch: ack.configEpoch, preview: ack.preview });
}

export async function currentPushState(
  registration: ServiceWorkerRegistration | null,
  dependencies: PushBrowserDependencies = browserDependencies(),
): Promise<PushView> {
  if (!supported(registration, dependencies)) return state('unsupported');
  if (dependencies.notification!.permission !== 'granted') {
    return state('needs-permission', { blocked: dependencies.notification!.permission === 'denied' });
  }
  const existing = await registration!.pushManager.getSubscription();
  if (!existing) return state('off');
  return ensureGranted(registration!, undefined, false, dependencies);
}

export async function enablePush(
  registration: ServiceWorkerRegistration,
  options: { preview?: PushPreviewMode; forceFresh?: boolean } = {},
  dependencies: PushBrowserDependencies = browserDependencies(),
): Promise<PushView> {
  if (!supported(registration, dependencies)) return state('unsupported');
  // This call is intentionally the first asynchronous operation so it remains
  // directly inside the browser's user-gesture activation.
  const permission = await requestNotificationPermission({ notification: dependencies.notification! });
  if (permission !== 'granted') return state('needs-permission', { blocked: permission === 'denied' });
  return ensureGranted(registration, options.preview ?? 'full', options.forceFresh ?? false, dependencies);
}

export const repairPush = (
  registration: ServiceWorkerRegistration,
  preview: PushPreviewMode,
  dependencies: PushBrowserDependencies = browserDependencies(),
): Promise<PushView> => enablePush(registration, { preview, forceFresh: true }, dependencies);

export async function disablePush(
  registration: ServiceWorkerRegistration,
  current: PushView,
  dependencies: PushBrowserDependencies = browserDependencies(),
): Promise<PushView> {
  const subscription = await registration.pushManager.getSubscription();
  const failures: unknown[] = [];
  if (current.bindingId) {
    try { await dependencies.api.deletePush(current.bindingId); } catch (error) { failures.push(error); }
  }
  if (subscription) {
    try { await subscription.unsubscribe(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new Error('notification disable did not fully converge — choose Repair and try again');
  return state('off', { preview: current.preview });
}

export function startForegroundHeartbeat(intervalMs = 15_000): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const post = () => {
    const message = {
      type: 'ours-visibility', state: document.visibilityState, ts: Date.now(),
      iosStandalone: isIOSStandalone(),
    };
    void navigator.serviceWorker.ready.then((registration) => {
      (navigator.serviceWorker.controller ?? registration.active)?.postMessage(message);
    }).catch(() => {});
  };
  const sync = () => {
    post();
    if (timer !== undefined) clearInterval(timer);
    timer = document.visibilityState === 'visible' ? setInterval(post, intervalMs) : undefined;
    if (document.visibilityState === 'visible') void clearPushNotifications();
  };
  const reply = (event: MessageEvent) => {
    if (event.data?.type !== 'ours-visibility-query' || !event.ports?.[0]) return;
    event.ports[0].postMessage({
      type: 'ours-visibility-reply', state: document.visibilityState, iosStandalone: isIOSStandalone(),
    });
  };
  document.addEventListener('visibilitychange', sync);
  navigator.serviceWorker.addEventListener('message', reply);
  sync();
  return () => {
    document.removeEventListener('visibilitychange', sync);
    navigator.serviceWorker.removeEventListener('message', reply);
    if (timer !== undefined) clearInterval(timer);
  };
}

export async function clearPushNotifications(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const notifications = await registration?.getNotifications() ?? [];
    for (const notification of notifications) notification.close();
    if ('clearAppBadge' in navigator) await (navigator as Navigator & { clearAppBadge(): Promise<void> }).clearAppBadge();
  } catch {
    // Best effort only; notification cleanup must never break messenger state.
  }
}
