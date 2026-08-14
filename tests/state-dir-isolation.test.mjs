// THE GUARD ON A SIDE EFFECT THAT HAPPENS BEFORE ANY OF OUR CODE RUNS.
//
// Importing @ours.network/sdk writes into whatever state directory it resolves at
// MODULE LOAD. Unset, that is `~/.ours` — the operator's live daemon's own state
// directory. src/boot-env.ts redirects it to ours, and it only works because
// src/cli.ts imports it FIRST. This test is what notices if those two imports are
// ever swapped, since nothing else would: the server would start, attach, serve
// every route and pass every other test in this suite while quietly writing into
// a directory it does not own.
//
// It runs the REAL entrypoint in a subprocess against a decoy "daemon state dir",
// and requires that directory to come back untouched.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter } from './harness.mjs';

const t = counter();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A stand-in for ~/.ours. Pre-seeded so we can prove non-modification rather than
// merely non-creation: an empty directory that stays empty is a weaker claim, and
// the failure we care about is a WRITE over an existing daemon's files.
const decoyDaemonDir = mkdtempSync(join(tmpdir(), 'decoy-daemon-'));
writeFileSync(join(decoyDaemonDir, 'daemon-token'), 'PRETEND-TOKEN', { mode: 0o600 });
writeFileSync(join(decoyDaemonDir, 'startup-progress.json'), '{"pretend":true}');
const before = Object.fromEntries(
  readdirSync(decoyDaemonDir).map((f) => [f, statSync(join(decoyDaemonDir, f)).mtimeMs]),
);

const ourStateDir = mkdtempSync(join(tmpdir(), 'messenger-own-'));
const captureDir = mkdtempSync(join(tmpdir(), 'messenger-state-capture-'));
const capturePath = join(captureDir, 'combined');
const captureFd = openSync(capturePath, 'w');

// Run the real CLI. It will fail to attach — there is no daemon at this port, and
// that is fine: the state-directory writes we are hunting happen at MODULE LOAD,
// strictly before any attach is attempted. A test that needed a live daemon to
// check an import-time side effect would be testing the wrong moment.
const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(ROOT, 'src/cli.ts'), 'serve'],
  {
    env: {
      ...process.env,
      OURS_STATE_DIR: decoyDaemonDir, // the hazard: what an operator's shell would have
      OURS_MESSENGER_IDENTITY: 'Nobody',
      OURS_MESSENGER_STATE_DIR: ourStateDir,
      OURS_MESSENGER_DAEMON_URL: 'http://127.0.0.1:1', // nothing listens on port 1
      OURS_MESSENGER_DAEMON_STATE_DIR: decoyDaemonDir,
    },
    stdio: ['ignore', captureFd, captureFd],
  },
);
closeSync(captureFd);
const code = await new Promise((r) => child.on('exit', r));
const out = readFileSync(capturePath, 'utf8');

t.ok(code !== 0, `the CLI exited non-zero with no daemon to attach to (exit ${code})`);
t.ok(/ECONNREFUSED|fetch failed|connect/i.test(out), 'and it failed at the ATTACH step, i.e. it got past module load');

const after = Object.fromEntries(
  readdirSync(decoyDaemonDir).map((f) => [f, statSync(join(decoyDaemonDir, f)).mtimeMs]),
);

assert.deepEqual(
  Object.keys(after).sort(),
  Object.keys(before).sort(),
  `the daemon's state dir gained or lost files:\n  before ${JSON.stringify(Object.keys(before))}\n  after  ${JSON.stringify(Object.keys(after))}`,
);
t.ok(true, "no file was created in or removed from the daemon's state dir");

assert.deepEqual(after, before, 'a file in the daemon state dir was REWRITTEN (mtime moved)');
t.ok(true, "and no existing file was rewritten — the daemon's state dir is untouched");

// THE POSITIVE HALF. Without this the test would also pass if the SDK had simply
// stopped writing anywhere, which would make the guard measure nothing at all.
// The writes must have landed — just in OUR directory.
const ours = readdirSync(ourStateDir);
t.ok(
  ours.includes('startup-progress.json'),
  `the module-load writes DID happen, redirected into our own dir: ${JSON.stringify(ours)}`,
);

rmSync(decoyDaemonDir, { recursive: true, force: true });
rmSync(ourStateDir, { recursive: true, force: true });
rmSync(captureDir, { recursive: true, force: true });
console.log(`\nstate-dir-isolation OK (${t.count} checks)`);
process.exit(0);
