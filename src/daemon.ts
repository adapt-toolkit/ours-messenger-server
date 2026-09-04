// Connection to the one operator-owned ours daemon.
//
// Messenger is an SDK application, not a daemon distribution. It attaches to
// the coherent daemon selection resolved by @ours.network/sdk, leases exactly
// one configured identity, and releases that lease on shutdown. It never owns
// the daemon process, broker connection, API token, or identity storage.

import { randomBytes } from 'node:crypto';
import { attachOursClient, resolveDaemonConfig, type OursClient } from '@ours.network/sdk';
import type { MessengerConfig } from './config.js';
import type { BuildInfo } from './build-info.js';
import { ConfigurationError } from './security.js';
import type { NotificationPage } from './watch.js';

export interface Runtime {
  readonly client: OursClient;
  readonly port: number;
  readonly stateDir: string;
  readonly leaseToken: string;
  /** Safe for logs and /api/state. It contains provenance, never token bytes. */
  readonly described: Readonly<Record<string, unknown>>;
  readNotificationPage(identity: string, since: number | 'tip', signal: AbortSignal): Promise<NotificationPage>;
  close(): Promise<void>;
}

const MESSENGER_NOTIFICATION_EVENTS = new Set([
  'message_received',
  'file_received',
  'receipt_received',
]);

function daemonNotificationReader(leaseToken: string): Runtime['readNotificationPage'] {
  let selected: ReturnType<typeof resolveDaemonConfig> | undefined;
  return async (identity, since, signal) => {
    selected ??= resolveDaemonConfig();
    const url = `${selected.baseUrl.value}/identities/${encodeURIComponent(identity)}`
      // Do not select the SDK's `inbound` set here. It intentionally means only
      // message/file arrivals; delivery/read receipts are separate notification
      // events. This cursor feeds both Web Push and the browser SSE bus, whose
      // admission/normalization layers already ignore or reduce each event kind.
      + `/notifications?since=${encodeURIComponent(String(since))}`;
    const response = await fetch(url, {
      headers: {
        'x-ours-lease-token': leaseToken,
        'x-ours-client-pid': String(process.pid),
        ...(selected.token ? { 'x-ours-api-token': selected.token.value } : {}),
      },
      signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error(`daemon notification page returned HTTP ${response.status} with invalid JSON`); }
    if (!response.ok) throw new Error(`daemon notification page returned HTTP ${response.status}`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('daemon notification page is malformed');
    const page = body as Partial<NotificationPage>;
    if (!Number.isSafeInteger(page.cursor) || page.cursor! < 0 || !Array.isArray(page.events)) {
      throw new Error('daemon notification page is malformed');
    }
    return {
      cursor: page.cursor!,
      // Asking without `kinds` is the only public daemon query that includes
      // receipts. Keep the previous messenger-only boundary locally so contact,
      // lifecycle, and future events do not become cross-chat invalidations.
      events: page.events.filter((record) => record !== null && typeof record === 'object'
        && !Array.isArray(record)
        && MESSENGER_NOTIFICATION_EVENTS.has((record as Record<string, unknown>).event as string)),
    };
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as Error & { code?: unknown }).code === code;
}

export async function startRuntime(
  _cfg: MessengerConfig,
  buildInfo: BuildInfo,
  attach: (options: { readonly leaseToken: string }) => Promise<OursClient> = attachOursClient,
): Promise<Runtime> {
  const leaseToken = `messenger-${randomBytes(24).toString('hex')}`;
  const client = await attach({ leaseToken });
  const info = await client.version();
  let closed = false;
  return {
    client,
    // The shared daemon endpoint is deliberately not part of messenger's
    // public state. This compatibility field is meaningful only to old tests.
    port: 0,
    stateDir: info.stateDir,
    leaseToken,
    described: Object.freeze({
      ownership: 'shared-daemon',
      application: `${buildInfo.name}@${buildInfo.version}`,
      host: '127.0.0.1',
      daemonVersion: info.version,
      daemonCompat: info.compat,
      apiVisibility: 'daemon-configured',
      mcp: false,
    }),
    readNotificationPage: daemonNotificationReader(leaseToken),
    async close() {
      if (closed) return;
      closed = true;
      await client.releaseLease();
    },
  };
}

/** Bind one pre-existing shared-daemon identity. Messenger never provisions it. */
export async function bindIdentity(
  runtime: Runtime,
  cfg: MessengerConfig,
): Promise<{ readonly name: string; readonly cid: string }> {
  try {
    const binding = await runtime.client.chooseIdentity({ name: cfg.identity, force: cfg.force });
    return { name: cfg.identity, cid: binding.cid };
  } catch (error) {
    if (!hasCode(error, 'NO_SUCH_IDENTITY')) throw error;
    throw new ConfigurationError(
      `shared ours daemon has no identity named ${JSON.stringify(cfg.identity)}; ` +
      'create it with the ours CLI before starting messenger',
    );
  }
}
