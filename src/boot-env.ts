// Configure the embedded SDK runtime BEFORE its first import.
//
// The SDK freezes state, broker, port, visibility and config-file selection at
// module evaluation. This module has no SDK import; src/daemon.ts calls this
// function and only then dynamically imports @ours.network/sdk/daemon. That is
// the isolation boundary, including for direct src/server.ts callers.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateBrokerUrl, type MessengerConfig } from './config.js';

export interface OwnedRuntimeEnvironment {
  readonly stateDir: string;
  readonly configPath: string;
  readonly brokerUrl: string;
  readonly tokenPath: string;
  readonly lockPath: string;
}

let configured: OwnedRuntimeEnvironment | undefined;
let lockRecord: string | undefined;

function acquireLock(path: string): void {
  const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner = 'unknown owner';
    try { owner = readFileSync(path, 'utf8'); } catch { /* preserve the original collision */ }
    throw new Error(
      `owned runtime state is already locked at ${path} (${owner}). ` +
      'Never run two messenger processes against one state directory; after a crash, verify the recorded pid is dead before removing the lock.',
    );
  }
  try {
    writeFileSync(fd, record);
  } finally {
    closeSync(fd);
  }
  lockRecord = record;
}

export function releaseOwnedRuntimeLock(): void {
  if (!configured || !lockRecord) return;
  // Only unlink the exact record this process created. A mismatched path is a
  // collision or operator intervention, never ours to delete.
  if (readFileSync(configured.lockPath, 'utf8') !== lockRecord) {
    throw new Error(`owned runtime lock changed while held: ${configured.lockPath}`);
  }
  unlinkSync(configured.lockPath);
  lockRecord = undefined;
}

export function configureOwnedRuntime(cfg: MessengerConfig): OwnedRuntimeEnvironment {
  const stateDir = resolve(cfg.stateDir, 'runtime');
  const next: OwnedRuntimeEnvironment = {
    stateDir,
    configPath: join(stateDir, 'config.json'),
    brokerUrl: validateBrokerUrl(cfg.runtime.brokerUrl),
    tokenPath: join(stateDir, 'daemon-token'),
    lockPath: join(stateDir, '.messenger-runtime.lock'),
  };

  if (configured) {
    if (JSON.stringify(configured) !== JSON.stringify(next)) {
      throw new Error('the SDK runtime is already configured for a different messenger state root');
    }
    if (!lockRecord) throw new Error('the owned SDK runtime was already closed; start a new process to restart it');
    return configured;
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  acquireLock(next.lockPath);

  // Explicit values defeat both ambient OURS_* variables and ~/.ours/config.json.
  process.env.OURS_CONFIG = next.configPath;
  process.env.OURS_STATE_DIR = next.stateDir;
  process.env.OURS_BROKER_URL = next.brokerUrl;
  process.env.OURS_PORT = '0';
  process.env.OURS_API_VISIBILITY = 'owner';
  process.env.OURS_TRANSPORT = 'http';
  process.env.OURS_AUTOSTART = 'false';
  process.env.OURS_GC_INTERVAL_MS = '3600000';
  // Owner mode mints a private 0600 token inside the owned state dir. An
  // ambient token must never become this runtime's credential.
  delete process.env.OURS_API_TOKEN;

  configured = next;
  return next;
}
