// THE TEST HARNESS, AND THE ONE PLACE THIS REPO IS ALLOWED TO START A DAEMON.
//
// THE PRODUCTION PATH ATTACHES. src/ contains no `startDaemon` and must never
// contain one — tests/no-engine.test.mjs is the guard. This file hosts a
// short-lived daemon on an ISOLATED TEMP STATE DIR so the suite never touches an
// operator's `~/.ours`, exactly as ours-mcp's and ours-tg-connector's own suites
// already do. When ours-mcp PR #50 merges and the shared daemon serves /api/v1,
// not one line of src/ changes: OursClient is the only seam.
//
// EVERY ENV VAR IS SET BEFORE THE FIRST SDK IMPORT, and the ordering is
// load-bearing rather than stylistic: the SDK reads its config at MODULE LOAD, so
// importing first and configuring after silently boots against ~/.ours and the
// public broker. ours-tg-connector's suite learned this by dying with "Failed to
// invoke initializer in ADAPT environment" — an error naming neither the env nor
// the ordering.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * THE DEADLINE IS GENEROUS ON PURPOSE. This box swings between ~350 MB and
 * ~1.6 GB available, and a tight bound turns a slow machine into a red test that
 * reads as a regression. If this times out, check `free -m` before believing it.
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
 * Boot an isolated daemon and return `{ url, stateDir, sdk, close }`.
 *
 * Call this BEFORE importing anything that imports the SDK.
 */
export async function startHarnessDaemon(tag) {
  const stateDir = mkdtempSync(join(tmpdir(), `messenger-${tag}-`));
  process.env.OURS_STATE_DIR = stateDir;
  // No broker: these tests exercise two identities inside ONE daemon, which is
  // local delivery. Pointing at a real broker would make the suite depend on the
  // network and on somebody else's uptime.
  process.env.OURS_BROKER_URL = 'wss://invalid.local/none';
  process.env.OURS_API_VISIBILITY = 'open';
  const port = await freePort();
  process.env.OURS_PORT = String(port);

  const sdk = await import('@ours.network/sdk');
  const { startDaemon } = await import('@ours.network/sdk/daemon');

  // startDaemon BOOTS THE WRAPPER ITSELF. Calling bootWrapper() first and then
  // startDaemon() initialises the ADAPT environment TWICE in one process and dies
  // with "Failed to invoke initializer in ADAPT environment", naming neither the
  // double init nor which call was the second.
  const handle = await startDaemon({ version: 'test' });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stateDir,
    sdk,
    async close() {
      await handle.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Report memory around a suite, per the fleet's load-sensitivity rule. */
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
