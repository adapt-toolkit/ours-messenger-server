// THE GUARD ON THE ONE THING THIS REPO EXISTS TO NOT DO.
//
// Sharing one daemon with ours-mcp IS the point of the exercise. A server that
// starts its own daemon in-process is the second daemon the work was commissioned
// to remove — and it would pass every functional test in this suite, because a
// self-started daemon behaves identically to an attached one from the inside.
// Nothing else here can catch it. This can.
//
// It is a source scan rather than a runtime check on purpose: by the time a
// `startDaemon` in src/ has run, the second engine already exists in the process.
//
// COUNTERFACTUAL, actually run — see tests/no-engine-counterfactual.sh, which
// writes a forbidden import into a copy of src/, runs this test, and requires it
// to FAIL, then restores. A guard nobody has watched fail is a guard nobody has
// tested.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter } from './harness.mjs';

const t = counter();
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Each pattern is the SHAPE OF THE MISTAKE, not a name to grep once. `startDaemon`
 * alone would miss `import * as d from '@ours.network/sdk/daemon'`, and the
 * subpath alone would miss a re-export through some future barrel.
 */
const FORBIDDEN = [
  { re: /@ours\.network\/sdk\/daemon/, why: "the daemon subpath — src/ is an HTTP CLIENT of a daemon it does not start" },
  { re: /\bstartDaemon\b/, why: 'startDaemon — this would BE the second daemon' },
  { re: /\bbootWrapper\b/, why: 'bootWrapper — that is the stdio engine path, not ours' },
  { re: /\bsetDaemonEventHandler\b/, why: 'in-process daemon event handlers — we are remote; use watchNotifications' },
  { re: /@adapt-toolkit\/(sdk|mufl|broker)/, why: 'the engine packages directly' },
];

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = sourceFiles(SRC);

// THE GUARD MUST HAVE SOMETHING TO READ. A scan over zero files passes forever;
// that is the commonest way a green lies, and it is one renamed directory away.
assert.ok(files.length >= 5, `expected at least 5 source files under src/, found ${files.length}`);
t.ok(true, `scanning ${files.length} source files under src/`);

const violations = [];
for (const file of files) {
  // Strip line and block comments first: this file's own prose names every
  // forbidden symbol, and so does src/daemon.ts's header explaining why they are
  // absent. A scanner that cannot tell code from the comment warning about the
  // code is a scanner that forces people to stop writing the warning.
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  for (const { re, why } of FORBIDDEN) {
    if (re.test(code)) violations.push(`${file.slice(SRC.length + 1)}: ${why}`);
  }
}

assert.deepEqual(
  violations,
  [],
  `src/ must never start or embed an engine. Found:\n  ${violations.join('\n  ')}`,
);
t.ok(true, 'src/ contains no startDaemon, no daemon subpath, no engine package — the production path ATTACHES');

// The comment-stripper must not be so eager that it hides real code. Prove it
// still sees a symbol that IS present in src/.
const anySource = files.map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')).join('\n');
t.ok(/\bOursClient\b/.test(anySource), 'and the scanner still reads real code: OursClient is found in src/');
t.ok(/\bresolveDaemonConfig\b/.test(anySource), 'and so is resolveDaemonConfig — the attach path is present, not just the absence');

// ---- THE BUNDLE, NOT JUST THE SOURCE ----------------------------------------
// The bundler is where an import sneaks back in: a transitive re-export can put
// `startDaemon` in dist/cli.js while src/ stays clean, and only this half would
// see it.
const DIST = resolve(SRC, '..', 'dist');
let bundle;
try {
  const jsFiles = [];
  const walkJs = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkJs(path);
      else if (entry.name.endsWith('.js')) jsFiles.push(path);
    }
  };
  walkJs(DIST);
  bundle = jsFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
} catch {
  assert.fail(`dist/cli.js is missing — run \`npm run build\` before this test. Skipping it silently would make this suite green on a bundle nobody built.`);
}

// A DELIBERATELY NARROW LIST. Only the two symbols whose presence would mean the
// bundle can start an engine. The engine's *code* is unavoidably in there today
// (see build.mjs for the counts and why); what must never be there is the entry
// point that RUNS it.
for (const sym of ['startDaemon', 'bootWrapper']) {
  const hits = bundle.split(sym).length - 1;
  assert.equal(hits, 0, `dist/cli.js contains ${hits} occurrence(s) of ${sym} — the bundle can start a daemon`);
}
t.ok(true, 'dist JavaScript contains no startDaemon and no bootWrapper — the shipped artefact cannot start a daemon');

// And the same must-have-something-to-read check: a bundle that failed to build,
// or one truncated to nothing, would satisfy every assertion above.
t.ok(bundle.length > 100_000, `the bundle is real (${Math.round(bundle.length / 1024)} KB), not an empty file passing by default`);
// THE POSITIVE MARKERS MUST BE STRING LITERALS, NOT IDENTIFIERS. `OursClient` and
// `resolveDaemonConfig` are renamed by the bundler and appear NOWHERE in
// dist/cli.js — asserting on them fails on a perfectly good bundle. (It did, and
// chasing that failure is how the createRequire collision was found, so the
// mistake earned its keep.) String literals survive: these three are the lease
// header OursClient sends, the typed operation prefix it posts to, and the
// unauthenticated route assertDaemonStateDir reads.
for (const marker of ['x-ours-lease-token', '/api/v1/', 'state-dir']) {
  assert.ok(bundle.includes(marker), `dist/cli.js should contain the literal ${JSON.stringify(marker)}`);
}
t.ok(true, 'and it contains the attach path — lease header, /api/v1/ prefix and the state-dir probe are all in the shipped artefact');

console.log(`\nno-engine OK (${t.count} checks)`);
process.exit(0);
