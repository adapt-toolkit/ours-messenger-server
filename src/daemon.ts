// The messenger-owned SDK runtime. No ours-mcp integration is injected.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { OursClient } from '@ours.network/sdk';
import { configureOwnedRuntime, releaseOwnedRuntimeLock } from './boot-env.js';
import type { MessengerConfig } from './config.js';

interface SdkDaemonHandle {
  readonly port: number;
  close(): Promise<void>;
}

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
  cfg: MessengerConfig,
  buildInfo: { readonly name: string; readonly version: string },
): Promise<Runtime> {
  const env = configureOwnedRuntime(cfg);

  // Dynamic imports are load-bearing: SDK module evaluation reads the env above.
  const [{ OursClient }, { startDaemon }] = await Promise.all([
    import('@ours.network/sdk'),
    import('@ours.network/sdk/daemon'),
  ]);

  let daemon: SdkDaemonHandle | undefined;
  try {
    daemon = await startDaemon({ version: `${buildInfo.name}@${buildInfo.version}` });
    const apiToken = (await readFile(env.tokenPath, 'utf8')).trim();
    if (!apiToken) throw new Error('owned SDK runtime created an empty API token');

    const leaseToken = `messenger-${randomBytes(12).toString('hex')}`;
    const client = new OursClient({
      url: `http://127.0.0.1:${daemon.port}`,
      leaseToken,
      apiToken,
    });
    let closed = false;
    return {
      client,
      port: daemon.port,
      stateDir: env.stateDir,
      leaseToken,
      described: Object.freeze({
        ownership: 'embedded-sdk',
        host: '127.0.0.1',
        port: daemon.port,
        stateDir: env.stateDir,
        brokerUrl: env.brokerUrl,
        apiVisibility: 'owner',
        tokenSource: 'owned-file',
        mcp: false,
      }),
      async close() {
        if (closed) return;
        closed = true;
        try {
          await daemon!.close();
        } finally {
          releaseOwnedRuntimeLock();
        }
      },
    };
  } catch (error) {
    try {
      await daemon?.close();
    } finally {
      releaseOwnedRuntimeLock();
    }
    throw error;
  }
}

/** Bind the configured identity, creating it only for a genuinely empty store. */
export async function bindIdentity(
  runtime: Runtime,
  cfg: MessengerConfig,
): Promise<{ readonly name: string; readonly cid: string; readonly keepHistory: boolean; readonly readvertised: unknown }> {
  let binding: { readonly cid: string };
  try {
    binding = await runtime.client.chooseIdentity({ name: cfg.identity, force: cfg.force });
  } catch (error) {
    if (!hasCode(error, 'NO_SUCH_IDENTITY')) throw error;
    const identities = await runtime.client.listIdentities();
    if (identities.length !== 0) throw error;
    const created = await runtime.client.createIdentity({
      name: cfg.identity,
      bio: '',
      exposeLocal: true,
      localAutoAccept: true,
    });
    binding = { cid: created.info.cid };
  }

  const policy = await runtime.client.setConversationPolicy({ keep_history: cfg.keepHistory });
  const readvertised = cfg.keepHistory ? await runtime.client.readvertiseOnUpgrade() : null;
  return { name: cfg.identity, cid: binding.cid, keepHistory: policy.keepHistory, readvertised };
}
