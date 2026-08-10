// Bundles the messenger server into self-contained ESM so it runs straight from a clone.
// Outputs:
//   dist/cli.js  ← the entrypoint (bin: ours-messenger-server)
//
// Run via `npm run build`.
//
// WHAT IS AND IS NOT IN THIS BUNDLE — measured with grep over dist/cli.js, not
// asserted. An earlier version of this comment claimed "no WASM blob, no ADAPT
// SDK"; that was wrong, and the correction is the point of writing it down.
//
// NOT PRESENT (0 hits each): `startDaemon`, `bootWrapper`. This server never
// starts a daemon — it is an HTTP client of one it did not start, which is the
// whole reason the repo exists. tests/no-engine.test.mjs guards both src/ AND
// this bundle, because the bundler is where an import sneaks back in.
//
// PRESENT, and unavoidable today: `@adapt-toolkit` (70), `AdaptPacket` (235),
// `wasm` (118), `protocol_container` (13). @ours.network/sdk's root barrel
// re-exports the DAEMON-SIDE operation implementations next to the client, and
// the package exports no client-only subpath (`.`, `./daemon`, `./connector` are
// all of them), so importing `OursClient` drags that code in. It is not
// initialised at runtime — no native addon loads; `process.report`'s
// sharedObjects list has no adapt/ours entry — but it is in the file, and the
// bundle is 2.3 MB rather than the ~200 KB this server's own code justifies.
//
// The fix is an SDK one (an engine-free client entrypoint), raised with the
// coordinator. src/boot-env.ts is the consumer-side mitigation for the part that
// actually bites: the module-load state-directory writes.

import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // THE ALIAS IS NOT COSMETIC. A banner is raw text injected AFTER bundling, so
  // esbuild's renamer never sees its identifiers and cannot avoid colliding with
  // them. @ours.network/sdk's chunk-UM73BGFH.js imports `createRequire`
  // un-suffixed; with the obvious banner, the emitted bundle declared
  // `createRequire` twice and died at load with
  //   SyntaxError: Identifier 'createRequire' has already been declared
  // — while `npm run build` exited 0 and printed "Done in 107ms". The build was
  // green and the artefact could not be parsed. tests/bundle-smoke.test.mjs now
  // RUNS the bundle, because a build that only checks for a written file cannot
  // tell those two apart.
  banner: {
    js: "import { createRequire as __messengerCreateRequire } from 'node:module'; const require = __messengerCreateRequire(import.meta.url);",
  },
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(dist, 'cli.js'),
  logLevel: 'info',
});
