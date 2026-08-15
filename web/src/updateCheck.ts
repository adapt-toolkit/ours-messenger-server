// Deployment-independent update check and last-resort recovery, ported from
// ours-control-plane. It remains useful even when the service worker is the
// broken component because version.json is always fetched with no-store.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- injected by build.mjs for production builds.
declare const __MESSENGER_WEB_BUILD_SHA__: string;
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- pure JS core intentionally shared with node contract tests.
import { assessUpdate as assessUpdateJs } from './updateCheckCore.mjs';

interface RemoteVersion { sha: string; time?: string }
interface UpdateState {
  remoteSha: string | null;
  firstMismatchAt: number | null;
  controllerChanged: boolean;
}

const BUILD_SHA = typeof __MESSENGER_WEB_BUILD_SHA__ === 'string' ? __MESSENGER_WEB_BUILD_SHA__ : 'dev';
const POLL_MS = 15 * 60_000;
const STUCK_AFTER_MS = 60_000;

const assessUpdate = assessUpdateJs as (
  localSha: string,
  remote: RemoteVersion | null,
  state: UpdateState,
  now: number,
  stuckAfterMs?: number,
) => 'current' | 'newer-available' | 'stuck';

async function fetchRemote(): Promise<RemoteVersion | null> {
  try {
    const response = await fetch('/version.json', { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json() as RemoteVersion;
  } catch {
    return null;
  }
}

export function startUpdateCheck(options: {
  onUpdateAvailable: () => void;
  onStuck: (remoteSha: string) => void;
}): () => void {
  if (BUILD_SHA === 'dev') return () => {};
  const state: UpdateState = { remoteSha: null, firstMismatchAt: null, controllerChanged: false };
  const changed = () => { state.controllerChanged = true; };
  navigator.serviceWorker?.addEventListener('controllerchange', changed);
  let stuckFired = false;
  const tick = async () => {
    const remote = await fetchRemote();
    const verdict = assessUpdate(BUILD_SHA, remote, state, Date.now(), STUCK_AFTER_MS);
    if (verdict === 'newer-available') {
      options.onUpdateAvailable();
      void navigator.serviceWorker?.getRegistration().then((registration) => registration?.update());
    } else if (verdict === 'stuck' && !stuckFired) {
      stuckFired = true;
      options.onStuck(remote!.sha);
    }
  };
  const initial = setTimeout(() => void tick(), 5_000);
  const interval = setInterval(() => void tick(), POLL_MS);
  const visible = () => { if (document.visibilityState === 'visible') void tick(); };
  document.addEventListener('visibilitychange', visible);
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
    document.removeEventListener('visibilitychange', visible);
    navigator.serviceWorker?.removeEventListener('controllerchange', changed);
  };
}

export async function forceRecover(remoteSha: string): Promise<never> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch { /* recover even if teardown is only partial */ }
  location.replace(location.pathname + '?v=' + encodeURIComponent(remoteSha));
  return new Promise<never>(() => {});
}

export function stripRecoveryParam(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has('v')) return;
  url.searchParams.delete('v');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}
