// RUN THE SHIPPED ARTEFACT. Not "was a file written" — RUN it.
//
// THIS TEST EXISTS BECAUSE THE BUILD LIED. esbuild exited 0 and printed
// "dist/cli.js 2.3mb / ⚡ Done in 107ms" while emitting a bundle Node could not
// parse:
//
//   SyntaxError: Identifier 'createRequire' has already been declared
//
// A banner is raw text injected AFTER bundling, so esbuild's renamer never sees
// its identifiers; @ours.network/sdk's chunk-UM73BGFH.js imports `createRequire`
// un-suffixed and the two collided. Every check that asked "does dist/cli.js
// exist and contain the right strings" passed on that file. Only running it
// failed.
//
// So this suite runs `node dist/cli.js --help` and requires usage on stdout and
// exit 0. It is the cheapest possible test and it is the one that caught a
// shipped-artefact defect the whole rest of the suite was blind to.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { counter } from './harness.mjs';

const t = counter();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'cli.js');

statSync(BUNDLE); // throws with a clear ENOENT if nobody built — better than skipping

function run(args, env = {}) {
  return new Promise((res) => {
    // Some managed sandboxes allow the child to run but discard its piped
    // stdout/stderr. File-backed capture still exercises the exact shipped
    // process and makes truncation/empty-output failures observable.
    const captureDir = mkdtempSync(join(tmpdir(), 'messenger-cli-capture-'));
    const outPath = join(captureDir, 'stdout');
    const errPath = join(captureDir, 'stderr');
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');
    const c = spawn(process.execPath, [BUNDLE, ...args], {
      // A DELIBERATELY BARE ENVIRONMENT. `--help` must work on a box where none of
      // the OURS_MESSENGER_* variables are set — that is the state of the user who
      // is running --help to find out what to set. Inheriting this shell's env
      // would hide exactly that failure.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', outFd, errFd],
    });
    closeSync(outFd);
    closeSync(errFd);
    c.on('exit', (code) => {
      const out = readFileSync(outPath, 'utf8');
      const err = readFileSync(errPath, 'utf8');
      rmSync(captureDir, { recursive: true, force: true });
      res({ code, out, err });
    });
  });
}

const help = await run(['--help'], { OURS_MESSENGER_STATE_DIR: join(ROOT, '.tmp-smoke-state') });
t.ok(
  !/SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(help.err),
  `the bundle PARSES AND LOADS (no SyntaxError / missing module)${help.err ? `\n    stderr: ${help.err.slice(0, 300)}` : ''}`,
);
t.eq(help.code, 0, '`--help` exits 0');
t.ok(help.out.includes('ours-messenger-server serve'), '`--help` prints usage on stdout');
t.ok(help.out.includes('OURS_MESSENGER_IDENTITY'), 'and the usage names the one required variable');

// A missing identity must be a clean, named error — not a stack trace, and not a
// silent default. This is the second most common first-run experience after --help.
const noIdentity = await run(['serve'], { OURS_MESSENGER_STATE_DIR: join(ROOT, '.tmp-smoke-state') });
t.eq(noIdentity.code, 1, '`serve` without an identity exits 1');
t.ok(
  noIdentity.err.includes('OURS_MESSENGER_IDENTITY is required'),
  'and says which variable is missing, in one line',
);
t.ok(
  !noIdentity.err.includes('    at '),
  'with no stack trace — the message is the whole answer for a config error',
);

console.log(`\nbundle-smoke OK (${t.count} checks)`);
process.exit(0);
