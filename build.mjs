// Bundles the messenger server into self-contained ESM so it runs straight from a clone.
// Outputs:
//   dist/cli.js  ← the entrypoint (bin: ours-messenger-server)
//
// Run via `npm run build`.
//
// THERE IS NO ENGINE IN THIS BUNDLE. This server is an HTTP client of a daemon it
// does not start: no native NAPI addon, no WASM blob, no ADAPT SDK, no MUFL.
// @ours.network/sdk IS bundled, but only its typed client (`OursClient`) and its
// daemon-selection resolver are reached from this tree, and neither touches the
// engine. If a future edit pulls `@ours.network/sdk/daemon` into src/, this build
// will start dragging the engine in — that is the tripwire, and tests/no-engine.test.mjs
// is the guard that fires on it.

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
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(dist, 'cli.js'),
  logLevel: 'info',
});
