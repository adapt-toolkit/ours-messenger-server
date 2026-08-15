import type { ServerEvent } from './types.js';

export interface PresenceOptions {
  readonly registration: ServiceWorkerRegistration;
  readonly identity: () => Promise<{ cid: string }>;
  readonly onEvent: (event: ServerEvent) => void;
  readonly onState?: (state: 'connecting' | 'live' | 'retrying') => void;
}

export function presenceUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/presence`;
}

function serverEvent(value: unknown): ServerEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as { type?: unknown; event?: unknown };
  if (frame.type !== 'event' || !frame.event || typeof frame.event !== 'object') return null;
  const event = frame.event as ServerEvent;
  return event.v === 1 ? event : null;
}

/**
 * A visible installed client holds one authenticated socket. Its liveness is
 * the server-side signal that suppresses Web Push on iOS, and the same socket
 * carries foreground invalidations without relying on a mobile EventSource.
 */
export function startPresence(options: PresenceOptions): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1_000;
  let generation = 0;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const current = socket;
    socket = null;
    if (current && current.readyState < WebSocket.CLOSING) current.close(1000, 'hidden');
  };

  const schedule = () => {
    if (stopped || document.visibilityState !== 'visible') return;
    options.onState?.('retrying');
    const delay = retryMs;
    retryMs = Math.min(30_000, retryMs * 2);
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  };

  const connect = async () => {
    clear();
    if (stopped || document.visibilityState !== 'visible') return;
    const mine = ++generation;
    options.onState?.('connecting');
    try {
      const [identity, subscription] = await Promise.all([
        options.identity(),
        options.registration.pushManager.getSubscription(),
      ]);
      if (stopped || mine !== generation || document.visibilityState !== 'visible') return;
      const json = subscription?.toJSON();
      const endpoint = subscription?.endpoint;
      const auth = json?.keys?.auth;
      if (!endpoint || !auth) return;

      const ws = new WebSocket(presenceUrl());
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ identity: identity.cid, endpoint, auth }));
      ws.onmessage = (raw) => {
        let parsed: unknown;
        try { parsed = JSON.parse(String(raw.data)); } catch { return; }
        if ((parsed as { ok?: unknown })?.ok === true) {
          retryMs = 1_000;
          options.onState?.('live');
          return;
        }
        const event = serverEvent(parsed);
        if (event) options.onEvent(event);
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (mine === generation) schedule();
      };
      ws.onerror = () => ws.close();
    } catch {
      if (mine === generation) schedule();
    }
  };

  const visibility = () => {
    generation++;
    if (document.visibilityState === 'visible') {
      retryMs = 1_000;
      void connect();
    } else clear();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', clear);
  void connect();
  return () => {
    stopped = true;
    generation++;
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', clear);
    clear();
  };
}
