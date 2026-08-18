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
import { build as viteBuild } from 'vite';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const adaptMuflFiles = resolve(root, 'mufl_files');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const releaseBuild = process.env.OURS_MESSENGER_RELEASE_BUILD === '1';
const resolveModule = createRequire(import.meta.url).resolve;

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

await Promise.all([
  rm(dist, { recursive: true, force: true }),
  rm(adaptMuflFiles, { recursive: true, force: true }),
]);
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
  define: {
    __MESSENGER_BUILD_INFO__: JSON.stringify(buildInfo),
  },
  entryPoints: { cli: resolve(root, 'src/cli.ts') },
  outdir: dist,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

// The SDK locates its compiled MUFL packet beside its emitted module. Bundling
// rewrites that module into dist/chunks, whose supported fallback is
// dist/mufl_code. The ADAPT evaluator likewise resolves its WASM binary beside
// the bundled wasm chunk and its protocol unit two levels above that chunk.
// esbuild does not copy any of these non-JS runtime assets.
const sdkDaemon = resolveModule('@ours.network/sdk/daemon');
const sdkDist = dirname(sdkDaemon);
const resolveSdkDependency = createRequire(sdkDaemon).resolve;
const adaptWasm = resolveSdkDependency('@adapt-toolkit/sdk/mufl-bindings.wasm');
const adaptDist = resolve(dirname(adaptWasm), '..');
await Promise.all([
  cp(resolve(sdkDist, 'mufl_code'), resolve(dist, 'mufl_code'), { recursive: true }),
  copyFile(adaptWasm, resolve(dist, 'chunks', 'mufl-bindings.wasm')),
  cp(resolve(adaptDist, 'mufl_files'), adaptMuflFiles, { recursive: true }),
]);

// THE NATIVE ADDON IS A RUNTIME ASSET TOO, AND MISSING IT IS SILENT.
//
// @adapt-toolkit/sdk prefers the @adapt-toolkit/sdk-native N-API backend and
// falls back to WASM when it cannot load. sdk-native finds its prebuilt binding
// through `createRequire(import.meta.url)` on a RELATIVE path:
//
//   ../prebuilds/<platform>-<arch>/adapt_js.node
//
// Unbundled, `import.meta.url` is sdk-native/dist/index.js, so that path is
// correct. Bundled, it becomes dist/chunks/<chunk>.js, so the same path points
// at dist/prebuilds — which nothing wrote. Both candidates miss, sdk-native's
// module-level check throws ERR_ADAPT_NO_PREBUILD, and @adapt-toolkit/sdk reads
// that as "no binding for this platform" and quietly uses WASM.
//
// THAT FALLBACK IS CORRECT AND STAYS. It is what keeps platforms with no
// prebuilt binding working, so a missing addon must never fail this build. The
// defect is that it also fired on a host where the prebuild was PRESENT and
// merely mislocated by bundling: production served every transaction through
// the WASM backend and hit its 2 GiB emscripten heap ceiling, twice in 24
// hours, while a 27 MB adapt_js.node sat unused in node_modules. Nothing said
// so — answering "wasm or native?" meant reading /proc/<pid>/maps.
//
// So put the binding where the BUNDLED module looks. `files` ships `dist`, so
// the copy travels in the tarball with the WASM blob and the MUFL packets.
// src/daemon.ts logs which backend was actually loaded, so the next time this
// silently regresses, one line of the boot log says so.
function findPackageDir(fromFile, name) {
  // Node's own node_modules walk. sdk-native is a dependency of
  // @adapt-toolkit/sdk, so start there and accept either a nested copy or the
  // usual hoisted one. `exports` in sdk-native's package.json declares only
  // ".", so resolving a subpath (or its package.json) is refused with
  // ERR_PACKAGE_PATH_NOT_EXPORTED — walking is what actually works.
  let dir = dirname(fromFile);
  for (;;) {
    const candidate = resolve(dir, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const platformArch = `${process.platform}-${process.arch}`;
const nativePkg = findPackageDir(adaptWasm, '@adapt-toolkit/sdk-native');
const nativeBinding = nativePkg
  ? [
    resolve(nativePkg, 'prebuilds', platformArch, 'adapt_js.node'),
    resolve(nativePkg, 'build', 'Release', 'adapt_js.node'),
  ].find((path) => existsSync(path))
  : undefined;
if (nativeBinding) {
  // dist/chunks/<chunk>.js resolves '../prebuilds/...' against dist/, so this is
  // the one location the bundled loader will look in.
  await mkdir(resolve(dist, 'prebuilds', platformArch), { recursive: true });
  await copyFile(nativeBinding, resolve(dist, 'prebuilds', platformArch, 'adapt_js.node'));
  console.log(`[build] native ADAPT binding staged: dist/prebuilds/${platformArch}/adapt_js.node`);
} else {
  // Not an error. This is the case the WASM fallback exists for.
  console.log(`[build] no native ADAPT binding for ${platformArch} — the bundle will use the WASM backend`);
}

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
