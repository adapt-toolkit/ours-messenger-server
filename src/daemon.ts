// The messenger-owned SDK runtime. No ours-mcp integration is injected.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { OursClient } from '@ours.network/sdk';
import { configureOwnedRuntime, releaseOwnedRuntimeLock } from './boot-env.js';
import type { MessengerConfig } from './config.js';
import type { BuildInfo } from './build-info.js';
import { InitializationRequiredError, readInitializationReceipt } from './lifecycle.js';

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

// WHICH ADAPT BACKEND DID THIS PROCESS ACTUALLY GET?
//
// @adapt-toolkit/sdk prefers a native N-API binding and falls back to WASM when
// it cannot load one. The fallback is deliberate and correct — it is what makes
// platforms without a prebuilt binding work — but it is also SILENT, and the
// two backends are not interchangeable in the way that matters here: the WASM
// build runs inside a 2 GiB emscripten heap that cannot be raised at runtime.
// Production ran on the WASM fallback for as long as it did because nothing
// ever said which one it had; the only way to answer was to read
// /proc/<pid>/maps of a live process.
//
// This is OBSERVED, not re-derived. process.report lists the shared objects
// this process really loaded, so the line reports what happened. Repeating the
// SDK's own selection logic here would risk a line that agrees with itself and
// is wrong — precisely the failure being fixed.
function describeAdaptBackend(): string {
  try {
    const report = process.report?.getReport() as unknown as { sharedObjects?: readonly string[] };
    const binding = (report?.sharedObjects ?? []).find((object) => object.endsWith('adapt_js.node'));
    return binding
      ? `native (${binding})`
      : 'wasm (no native binding loaded — the 2 GiB heap ceiling applies)';
  } catch {
    // Never let an observability line break startup.
    return 'unknown (process.report unavailable)';
  }
}

export async function startRuntime(
  cfg: MessengerConfig,
  buildInfo: BuildInfo,
): Promise<Runtime> {
  const env = configureOwnedRuntime(cfg);
  let daemon: SdkDaemonHandle | undefined;
  try {
    // Dynamic imports are load-bearing: SDK module evaluation reads the env
    // above. They remain inside rollback ownership so a missing/broken SDK
    // cannot strand the advisory lock until process exit.
    const [{ OursClient }, { startDaemon }] = await Promise.all([
      import('@ours.network/sdk'),
      import('@ours.network/sdk/daemon'),
    ]);
    daemon = await startDaemon({
      version: `${buildInfo.name}@${buildInfo.version}`,
      handleSignals: false,
    });
    // After startDaemon, so the backend has actually been loaded and not merely
    // selected. Once per process, on the operator's stdout.
    console.log(`[messenger] adapt backend: ${describeAdaptBackend()}`);
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

/** Bind an explicitly initialized identity. Serve never provisions identities. */
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
    throw new InitializationRequiredError(cfg.stateDir);
  }

  const provenance = readInitializationReceipt(cfg.stateDir);
  if (provenance && (provenance.identity.name !== cfg.identity || provenance.identity.cid !== binding.cid)) {
    throw new Error(
      `initialized identity provenance mismatch: expected ${provenance.identity.name} (${provenance.identity.cid}), ` +
      `bound ${cfg.identity} (${binding.cid})`,
    );
  }

  const policy = await runtime.client.setConversationPolicy({ keep_history: cfg.keepHistory });
  const readvertised = cfg.keepHistory ? await runtime.client.readvertiseOnUpgrade() : null;
  return { name: cfg.identity, cid: binding.cid, keepHistory: policy.keepHistory, readvertised };
}
