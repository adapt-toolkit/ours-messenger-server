// A visible installed PWA holds one authenticated WebSocket to the messenger
// server. Socket liveness is authoritative foreground presence on iOS: when the
// OS backgrounds or kills the app the transport disappears, so Web Push resumes
// without trusting stale WindowClient visibility or a best-effort close beacon.

import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { EventSubscription, MessengerEvent } from './events.js';

export interface PresenceOptions {
  readonly verify: (frame: Record<string, unknown>) => PresencePrincipal | null | Promise<PresencePrincipal | null>;
  readonly subscribe: () => EventSubscription;
  readonly allowedOrigin?: string;
  readonly path?: string;
  readonly pingIntervalMs?: number;
  readonly authTimeoutMs?: number;
  readonly onChange?: (cid: string, online: boolean) => void;
}

export interface PresencePrincipal {
  readonly cid: string;
  readonly bindingId: string;
}

export class PresenceRegistry {
  readonly #online = new Map<string, Map<string, Set<WebSocket>>>();

  isOnline(cid: string): boolean { return (this.#online.get(cid)?.size ?? 0) > 0; }
  onlineBindings(cid: string): ReadonlySet<string> {
    return new Set(this.#online.get(cid)?.keys() ?? []);
  }
  get onlineCount(): number { return this.#online.size; }
  get socketCount(): number {
    let count = 0;
    for (const bindings of this.#online.values()) {
      for (const sockets of bindings.values()) count += sockets.size;
    }
    return count;
  }

  add(cid: string, bindingId: string, socket: WebSocket): void {
    const bindings = this.#online.get(cid) ?? new Map<string, Set<WebSocket>>();
    const sockets = bindings.get(bindingId) ?? new Set<WebSocket>();
    sockets.add(socket);
    bindings.set(bindingId, sockets);
    this.#online.set(cid, bindings);
  }

  remove(cid: string, bindingId: string, socket: WebSocket): boolean {
    const bindings = this.#online.get(cid);
    const sockets = bindings?.get(bindingId);
    if (!bindings || !sockets) return false;
    const removed = sockets.delete(socket);
    if (sockets.size === 0) bindings.delete(bindingId);
    if (bindings.size === 0) this.#online.delete(cid);
    return removed && !this.isOnline(cid);
  }
}

type LiveSocket = WebSocket & { isAlive?: boolean };

function liveFrame(event: MessengerEvent): string {
  return JSON.stringify({ type: 'event', event: { v: 1, ...event } });
}

export function attachPresenceServer(
  server: Server,
  registry: PresenceRegistry,
  options: PresenceOptions,
): { close(): Promise<void> } {
  const path = options.path ?? '/api/presence';
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    let pathname = '/';
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { /* reject below */ }
    if (pathname !== path || (options.allowedOrigin && request.headers.origin !== options.allowedOrigin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };
  server.on('upgrade', upgrade);

  wss.on('connection', (socket: LiveSocket) => {
    let bound: PresencePrincipal | null = null;
    let authStarted = false;
    let subscription: EventSubscription | null = null;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    const authTimer = setTimeout(() => {
      if (!bound) socket.close(4001, 'auth timeout');
    }, authTimeoutMs);
    authTimer.unref?.();

    socket.on('message', async (data) => {
      if (authStarted) return;
      authStarted = true;
      let frame: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
        frame = parsed as Record<string, unknown>;
      } catch {
        socket.close(4002, 'bad auth frame');
        return;
      }
      let principal: PresencePrincipal | null = null;
      try { principal = await options.verify(frame); } catch { principal = null; }
      if (!principal) {
        try { socket.send(JSON.stringify({ ok: false, error: 'auth rejected' })); } catch { /* closing */ }
        socket.close(4004, 'auth rejected');
        return;
      }
      clearTimeout(authTimer);
      bound = principal;
      registry.add(principal.cid, principal.bindingId, socket);
      options.onChange?.(principal.cid, true);
      subscription = options.subscribe();
      socket.send(JSON.stringify({ ok: true }));
      void (async () => {
        while (socket.readyState === WebSocket.OPEN && subscription) {
          const event = await subscription.next();
          if (!event || socket.readyState !== WebSocket.OPEN) break;
          socket.send(liveFrame(event));
        }
      })().catch(() => { try { socket.close(1011, 'event stream failed'); } catch { /* closed */ } });
    });

    const drop = () => {
      clearTimeout(authTimer);
      subscription?.close();
      subscription = null;
      if (bound) {
        const offline = registry.remove(bound.cid, bound.bindingId, socket);
        if (offline) options.onChange?.(bound.cid, false);
        bound = null;
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  const pinger = setInterval(() => {
    for (const socket of wss.clients as Set<LiveSocket>) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, pingIntervalMs);
  pinger.unref?.();

  return {
    close: async () => {
      clearInterval(pinger);
      server.removeListener('upgrade', upgrade);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
