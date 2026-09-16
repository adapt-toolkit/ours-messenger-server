// Connection to the one operator-owned ours daemon.
//
// Messenger is an SDK application, not a daemon distribution. It attaches to
// the coherent daemon selection resolved by @ours.network/sdk, leases exactly
// one configured identity, and releases that lease on shutdown. It never owns
// the daemon process, broker connection, API token, or identity storage.

import { randomBytes } from 'node:crypto';
import { attachOursClient, type OursClient } from '@ours.network/sdk';
import type { MessengerConfig } from './config.js';
import type { BuildInfo } from './build-info.js';
import { ConfigurationError } from './security.js';
import { OwnerSession } from './owner-session.js';
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

function daemonNotificationReader(client: OursClient): Runtime['readNotificationPage'] {
  return async (identity, since, signal) => {
    // Keep the raw page cursor and include receipts; the daemon's inbound-only
    // filter omits them. Authentication and selection belong to this client.
    const page = await client.readNotificationPage(identity, { since, signal });
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
  cfg: MessengerConfig,
  buildInfo: BuildInfo,
  attach: typeof attachOursClient = attachOursClient,
): Promise<Runtime> {
  const endpoint = process.env.OURS_DAEMON_URL?.trim();
  const expectedInstanceId = process.env.OURS_DAEMON_ID?.trim();
  const credentialPath = process.env.OURS_DAEMON_CREDENTIAL_PATH?.trim();
  const selected = [endpoint, expectedInstanceId, credentialPath].some(value => value !== undefined);
  if (selected && (!endpoint || !expectedInstanceId || !credentialPath)) {
    throw new ConfigurationError('OURS_DAEMON_URL, OURS_DAEMON_ID and OURS_DAEMON_CREDENTIAL_PATH must be set together');
  }
  const owner = await OwnerSession.open(cfg.stateDir, selected
    ? { endpoint: endpoint!, expectedInstanceId: expectedInstanceId!, credentialPath: credentialPath!, identity: cfg.identity }
    : undefined, attach);
  const leaseToken = owner?.ownerInstanceId ?? `messenger-${randomBytes(24).toString('hex')}`;
  let client: OursClient | undefined;
  let info: Awaited<ReturnType<OursClient['version']>>;
  try {
    client = await attach(selected
      ? { endpoint, expectedInstanceId, credentialPath, sessionMode: 'external', leaseToken, env: {} }
      : { leaseToken });
    info = await client.version();
  } catch (error) {
    try { await client?.close(); } finally { owner?.close(); }
    throw error;
  }
  const attached = client;
  let closePromise: Promise<void> | undefined;
  return {
    client: attached,
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
    readNotificationPage: daemonNotificationReader(attached),
    close() {
      closePromise ??= (async () => {
        try {
          if (owner) await owner.terminate(attached);
          else {
            const result = await attached.releaseLease();
            if (result.failed > 0) throw new Error('messenger owner release incomplete');
          }
        } finally {
          try { await attached.close(); } finally { owner?.close(); }
        }
      })();
      return closePromise;
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
