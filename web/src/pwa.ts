import { api } from './api.js';
import type { PushState } from './types.js';

export interface WorkerState {
  supported: boolean;
  offline: boolean;
  updateAvailable: boolean;
  registration: ServiceWorkerRegistration | null;
}

export async function registerMessengerWorker(
  onState: (state: WorkerState) => void,
): Promise<() => void> {
  let registration: ServiceWorkerRegistration | null = null;
  let updateAvailable = false;
  const supported = 'serviceWorker' in navigator && window.isSecureContext;
  const emit = () => onState({ supported, offline: !navigator.onLine, updateAvailable, registration });
  const online = () => emit();
  const offline = () => emit();
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);

  if (supported) {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const track = (worker: ServiceWorker | null) => worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        updateAvailable = true;
        emit();
      }
    });
    track(registration.installing);
    registration.addEventListener('updatefound', () => track(registration?.installing ?? null));
  }
  emit();
  return () => {
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
}

function applicationServerKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export async function currentPushState(registration: ServiceWorkerRegistration | null): Promise<PushState> {
  if (!registration || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return await registration.pushManager.getSubscription() ? 'subscribed' : 'idle';
}

export async function enablePush(registration: ServiceWorkerRegistration): Promise<PushState> {
  if (!('Notification' in window) || !('PushManager' in window)) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'idle';
  const { publicKey } = await api.vapidPublicKey();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  await api.subscribePush(subscription.toJSON(), navigator.userAgent.slice(0, 160));
  return 'subscribed';
}

export async function disablePush(registration: ServiceWorkerRegistration): Promise<PushState> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return 'idle';
  await api.unsubscribePush(subscription.endpoint);
  await subscription.unsubscribe();
  return 'idle';
}
