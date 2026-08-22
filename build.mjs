// Bundles the messenger server into self-contained ESM so it runs straight from a clone.
// Outputs:
//   dist/cli.js       ← the entrypoint (bin: ours-messenger-server)
//   dist/chunks/*     ← lazily loaded server/SDK graph (`--help` stays light)
//   dist/web/*        ← the focused same-origin messenger client
//
// Run via `npm run build`.
//
// Messenger is an application client of one shared ours daemon. The bundle
// contains the SDK HTTP client, but never the daemon engine, MUFL packets,
// evaluator WASM, or native ADAPT bindings.

import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const releaseBuild = process.env.OURS_MESSENGER_RELEASE_BUILD === '1';

function command(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

let sha = process.env.OURS_MESSENGER_BUILD_SHA ?? '';
let dirty = true;
let gitSha = '';
try {
  gitSha = command(['rev-parse', 'HEAD']);
  if (sha && sha !== gitSha) throw new Error('provided build SHA does not match git HEAD');
  sha ||= gitSha;
  dirty = command(['status', '--porcelain']) !== '';
} catch (error) {
  if (gitSha) throw error;
  // A source-less package build may supply the immutable release SHA explicitly.
  dirty = process.env.OURS_MESSENGER_BUILD_CLEAN !== '1';
}
if (!/^[0-9a-f]{40}$/.test(sha)) {
  throw new Error('build requires a full 40-hex OURS_MESSENGER_BUILD_SHA or git commit');
}
if (releaseBuild && dirty) {
  throw new Error('release build refused: source tree is dirty');
}
const buildInfo = Object.freeze({ name: pkg.name, version: pkg.version, sha, dirty });

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  splitting: true,
  define: {
    __MESSENGER_BUILD_INFO__: JSON.stringify(buildInfo),
  },
  entryPoints: { cli: resolve(root, 'src/cli.ts') },
  outdir: dist,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

await viteBuild({
  configFile: resolve(root, 'vite.config.ts'),
  define: { __MESSENGER_WEB_BUILD_SHA__: JSON.stringify(sha) },
});

const serviceWorkerPath = resolve(dist, 'web', 'sw.js');
const serviceWorkerPlaceholder = '__MESSENGER_BUILD_SHA__';
const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
if (serviceWorker.split(serviceWorkerPlaceholder).length !== 2) {
  throw new Error('service worker must contain exactly one build SHA placeholder');
}
await writeFile(serviceWorkerPath, serviceWorker.replace(serviceWorkerPlaceholder, sha));
await writeFile(
  resolve(dist, 'web', 'version.json'),
  JSON.stringify({ sha, time: new Date().toISOString() }) + '\n',
);
