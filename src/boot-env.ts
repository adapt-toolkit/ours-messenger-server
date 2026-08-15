// Configure the embedded SDK runtime BEFORE its first import.
//
// The SDK freezes state, broker, port, visibility and config-file selection at
// module evaluation. This module has no SDK import; src/daemon.ts calls this
// function and only then dynamically imports @ours.network/sdk/daemon. That is
// the isolation boundary, including for direct src/server.ts callers.

import {
  chmodSync, closeSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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
let lockFd: number | undefined;

/**
 * Acquire a Linux/POSIX advisory flock on an already-open descriptor.
 *
 * The util-linux helper inherits the descriptor's open-file description, places
 * the lock on it, and exits. flock(2) ownership remains with our still-open
 * descriptor. A graceful close, SIGKILL, or host crash all release it in the
 * kernel; the on-disk inode is diagnostic only and is never a stale-lock gate.
 */
function tryFlock(fd: number): boolean {
  const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', fd],
  });
  if (result.error) {
    throw new Error(`cannot acquire owned runtime advisory lock: ${result.error.message}`);
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = result.stderr?.toString().trim();
  throw new Error(`owned runtime advisory lock helper failed (exit ${String(result.status)})${detail ? `: ${detail}` : ''}`);
}

function acquireLock(path: string): void {
  const fd = openSync(path, 'a+', 0o600);
  try {
    chmodSync(path, 0o600);
    if (!tryFlock(fd)) {
      let owner = 'owner record unavailable';
      try { owner = readFileSync(path, 'utf8').trim() || owner; } catch { /* collision remains authoritative */ }
      throw new Error(
        `owned runtime state is already locked at ${path} (${owner}). ` +
        'Another messenger process is live against this state directory.',
      );
    }

    // This record is for operator diagnostics only. In particular, no PID or
    // timestamp is consulted for ownership, so PID reuse cannot steal a live
    // lock and stale text cannot block restart after SIGKILL/power loss.
    const record = `${JSON.stringify({
      version: 2,
      owner: '@ours.network/messenger-server',
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      authority: 'advisory-flock',
    })}\n`;
    ftruncateSync(fd, 0);
    writeFileSync(fd, record);
    fsyncSync(fd);
    lockFd = fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export interface AdvisoryLockProbe {
  close(): void;
}

/** Acquire without rewriting owner diagnostics; callers can hold this across a copy. */
export function tryAcquireOwnedRuntimeAdvisoryLock(path: string): AdvisoryLockProbe | null {
  const fd = openSync(path, 'a+', 0o600);
  let held = false;
  try {
    if (!tryFlock(fd)) return null;
    held = true;
    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  } finally {
    if (!held) closeSync(fd);
  }
}

/** Non-mutating when the diagnostic inode already exists; used by tests. */
export function ownedRuntimeLockIsAvailable(path: string): boolean {
  const probe = tryAcquireOwnedRuntimeAdvisoryLock(path);
  if (!probe) return false;
  try {
    return true;
  } finally {
    probe.close();
  }
}

function closeGlobalLockFd(): void {
  if (lockFd !== undefined) {
    const fd = lockFd;
    lockFd = undefined;
    closeSync(fd);
  }
}

export function releaseOwnedRuntimeLock(): void {
  closeGlobalLockFd();
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
    if (lockFd === undefined) throw new Error('the owned SDK runtime was already closed; start a new process to restart it');
    return configured;
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
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
