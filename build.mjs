// Bundles the messenger server into self-contained ESM so it runs straight from a clone.
// Outputs:
//   dist/cli.js       ← the entrypoint (bin: ours-messenger-server)
//   dist/chunks/*     ← lazily loaded server/SDK graph (`--help` stays light)
//   dist/web/*        ← the focused same-origin messenger client
//
// Run via `npm run build`.
//
// WHAT IS AND IS NOT IN THIS BUNDLE — measured with grep over dist/cli.js, not
// asserted. An earlier version of this comment claimed "no WASM blob, no ADAPT
// SDK"; that was wrong, and the correction is the point of writing it down.
//
// The SDK engine is intentionally present: messenger owns it. The server graph
// stays lazy so `--help` does not initialise native/runtime state.

import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
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
  splitting: true,
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
    // The require binding is needed by bundled SDK/native loading. Runtime env
    // isolation itself lives in configureOwnedRuntime and happens before the
    // dynamic SDK chunk is imported.
    js: "import { createRequire as __messengerCreateRequire } from 'node:module'; const require = __messengerCreateRequire(import.meta.url);",
  },
  entryPoints: { cli: resolve(root, 'src/cli.ts') },
  outdir: dist,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

const webDist = resolve(dist, 'web');
await mkdir(webDist, { recursive: true });
await Promise.all([
  copyFile(resolve(root, 'web/index.html'), resolve(webDist, 'index.html')),
  copyFile(resolve(root, 'web/src/styles.css'), resolve(webDist, 'styles.css')),
  build({
    bundle: true,
    platform: 'browser',
    target: ['es2022'],
    format: 'esm',
    entryPoints: [resolve(root, 'web/src/main.ts')],
    outfile: resolve(webDist, 'app.js'),
    sourcemap: true,
    logLevel: 'info',
  }),
]);
