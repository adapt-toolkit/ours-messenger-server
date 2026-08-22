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

export interface Runtime {
  readonly client: OursClient;
  readonly port: number;
  readonly stateDir: string;
  readonly leaseToken: string;
  /** Safe for logs and /api/state. It contains provenance, never token bytes. */
  readonly described: Readonly<Record<string, unknown>>;
  close(): Promise<void>;
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
