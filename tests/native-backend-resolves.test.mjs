// RESOLVE THE NATIVE ADDON THE WAY THE BUNDLE DOES, THEN LOAD IT.
//
// @adapt-toolkit/sdk prefers the @adapt-toolkit/sdk-native N-API backend and
// falls back to WASM when it cannot load one. sdk-native locates its prebuilt
// binding with `createRequire(import.meta.url)` on a RELATIVE path,
// `../prebuilds/<platform>-<arch>/adapt_js.node`. Unbundled, import.meta.url is
// sdk-native/dist/index.js and that is correct. Bundled, it is
// dist/chunks/<chunk>.js, so the same path points at dist/prebuilds — which
// nothing wrote. Both candidates missed, sdk-native threw
// ERR_ADAPT_NO_PREBUILD, and the SDK read that as "no binding for this
// platform" and used WASM. Production served every transaction through the WASM
// backend and hit its 2 GiB emscripten heap ceiling twice in 24 hours, while a
// 27 MB adapt_js.node sat unused in node_modules.
//
// The fallback itself is correct and this test does not attack it: where the
// platform genuinely ships no binding, there is nothing to resolve and the test
// says so and stops. What it refuses to allow is a binding that EXISTS being
// unreachable from the artefact we ship.
//
// It asserts against the BUILT dist, and it performs the bundle's own
// resolution rather than a paraphrase of it — same createRequire base, same
// relative specifier — because a test that hard-codes the expected path would
// keep passing if the SDK ever changed where it looks.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { counter } from './harness.mjs';

const t = counter();
const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const CHUNKS = join(DIST, 'chunks');
const platformArch = `${process.platform}-${process.arch}`;
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

statSync(join(DIST, 'cli.js')); // clear ENOENT if nobody built, rather than a skip

// The same node_modules walk build.mjs performs. sdk-native's package.json
// declares only "." in `exports`, so resolving its subpaths or package.json is
// refused with ERR_PACKAGE_PATH_NOT_EXPORTED — walking is what works.
function findPackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = resolve(dir, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const nativePkg = findPackageDir(ROOT, '@adapt-toolkit/sdk-native');
const sourceBinding = nativePkg
  ? [
    resolve(nativePkg, 'prebuilds', platformArch, 'adapt_js.node'),
    resolve(nativePkg, 'build', 'Release', 'adapt_js.node'),
  ].find((path) => existsSync(path))
  : undefined;

if (!sourceBinding) {
  // The case the WASM fallback exists for. Nothing to prove and nothing broken.
  console.log(`native-backend-resolves SKIPPED — no native ADAPT binding for ${platformArch}`);
  process.exit(0);
}

// Find the bundled chunk that carries sdk-native's loader. Locating it by its
// own error text ties the test to the code under test, not to a chunk hash.
const loaderChunks = readdirSync(CHUNKS)
  .filter((name) => name.endsWith('.js'))
  .map((name) => join(CHUNKS, name))
  .filter((path) => readFileSync(path, 'utf8').includes('@adapt-toolkit/sdk-native: no native binding for'));
t.eq(loaderChunks.length, 1, 'bundled artefact has exactly one sdk-native loader chunk');

// THE ASSERTION THAT FAILS WITHOUT THE BUILD FIX. This is the bundle's own
// resolution: createRequire over the chunk's URL, the chunk's own relative
// specifier. Before the fix it throws MODULE_NOT_FOUND, which is exactly what
// production experienced as a silent downgrade to WASM.
const bundleRequire = createRequire(pathToFileURL(loaderChunks[0]));
let resolved;
try {
  resolved = bundleRequire.resolve(`../prebuilds/${platformArch}/adapt_js.node`);
} catch (error) {
  assert.fail(
    'the bundled sdk-native loader cannot resolve its prebuilt binding, so the shipped artefact ' +
    `silently falls back to the WASM backend and its 2 GiB heap ceiling (${error.code}: ${error.message})`,
  );
}
t.eq(resolved, join(DIST, 'prebuilds', platformArch, 'adapt_js.node'),
  'the binding resolves to dist/prebuilds, where the bundled loader looks');
t.eq(digest(resolved), digest(sourceBinding),
  'the staged binding is byte-identical to the sdk-native prebuild');

// Present and correctly named is not the same as usable: load it.
const loaded = bundleRequire(`../prebuilds/${platformArch}/adapt_js.node`);
t.ok(loaded && typeof loaded === 'object', 'the staged binding loads as a native addon');
t.ok(process.report.getReport().sharedObjects.some((object) => object.endsWith('adapt_js.node')),
  'loading it registers a real shared object in this process');

// GUARD, NOT PROOF: this passes with or without the resolution fix, and only
// catches the boot line being deleted outright. The line itself is exercised
// for real by the loopback suite, which boots a runtime.
const bundleText = readdirSync(CHUNKS)
  .filter((name) => name.endsWith('.js'))
  .map((path) => readFileSync(join(CHUNKS, path), 'utf8'))
  .join('');
t.ok(bundleText.includes('adapt backend:'), 'GUARD: the shipped bundle still reports its backend at boot');

console.log(`native-backend-resolves OK — ${t.count} checks, binding reachable at dist/prebuilds/${platformArch}`);
