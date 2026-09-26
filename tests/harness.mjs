// Shared-daemon harness used by integration tests. Production and tests both
// attach through the public SDK client; only the operator CLI launches the
// daemon process.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function counter() {
  let pass = 0;
  return {
    ok(cond, msg) {
      assert.ok(cond, msg);
      pass++;
      console.log('  ✓', msg);
    },
    eq(a, b, msg) {
      assert.deepEqual(a, b, `${msg}\n    actual:   ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
      pass++;
      console.log('  ✓', msg);
    },
    get count() {
      return pass;
    },
  };
}

/**
 * Poll until `fn` returns something other than `undefined`.
 *
 * THE DEADLINE IS GENEROUS ON PURPOSE. Integration hosts can be resource
 * constrained, and a tight bound turns a slow machine into a red test that reads
 * as a regression. If this times out, inspect host load before diagnosing it.
 */
export async function until(label, fn, ms = 120_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    assert.ok(Date.now() < deadline, `timed out waiting for: ${label}`);
    await sleep(200);
  }
}

export const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

/**
 * Boot an isolated daemon through @ours.network/daemon and return
 * `{ url, stateDir, sdk, close }`.
 */
export async function startHarnessDaemon(tag, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), `messenger-${tag}-`));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const instanceId = randomUUID();
  // All fixture clients explicitly select the authenticated daemon. No client
  // infers its server or credential from ambient daemon-local configuration.
  const credentialPath = join(stateDir, 'fixture-client-credential');
  writeFileSync(credentialPath, 'ab'.repeat(32) + '\n', { mode: 0o600 });
  const env = {
    ...process.env,
    OURS_STATE_DIR: stateDir,
    OURS_PORT: String(port),
    OURS_BROKER_URL: 'wss://invalid.local/none',
    OURS_API_VISIBILITY: 'owner',
    OURS_API_TOKEN: 'ab'.repeat(32),
    OURS_DAEMON_ID: instanceId,
  };
  // Server-side attachment uses an explicit V1 selection, never SDK defaults.
  Object.assign(process.env, {
    OURS_STATE_DIR: stateDir,
    OURS_PORT: String(port),
    OURS_BROKER_URL: env.OURS_BROKER_URL,
    OURS_API_VISIBILITY: env.OURS_API_VISIBILITY,
    OURS_DAEMON_URL: url,
    OURS_DAEMON_ID: instanceId,
    OURS_DAEMON_CREDENTIAL_PATH: credentialPath,
  });

  const cli = options.cliEntry
    ? resolve(options.cliEntry)
    : resolve(import.meta.dirname, '..', 'node_modules', '@ours.network', 'daemon', 'dist', 'cli.js');
  const child = spawn(process.execPath, [cli, 'daemon', 'serve'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await until('shared daemon startup', async () => {
      if (child.exitCode !== null) throw new Error(`ours daemon exited ${child.exitCode}: ${output}`);
      try {
        const response = await fetch(`${url}/selection`);
        return response.ok && (await response.json()).instanceId === instanceId ? true : undefined;
      } catch {
        return undefined;
      }
    });
  } catch (error) {
    child.kill('SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }

  const sdk = options.sdkEntry
    ? await import(pathToFileURL(resolve(options.sdkEntry)).href)
    : await import('@ours.network/sdk');

  return {
    url,
    port,
    stateDir,
    sdk,
    clientOptions: { url, credentialPath, sessionMode: 'external' },
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolveExit) => child.once('exit', resolveExit));
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Report advisory host memory around a resource-sensitive integration suite. */
export function memSample(label) {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const avail = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
    if (avail) {
      const mb = Math.round(Number(avail[1]) / 1024);
      console.log(`  [mem] ${label}: ${mb} MB available`);
      return mb;
    }
  } catch {
    /* not Linux; the sample is advisory */
  }
  return null;
}
