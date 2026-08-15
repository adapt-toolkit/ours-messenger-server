// Inspect the exact npm tarball without dependency fallback, then install it
// production-style and prove its one-shot init succeeds from packaged assets.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'messenger-package-assets-'));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'package runtime smoke must run through an npm script');
let runId = 0;

function run(file, args, options = {}) {
  const capture = join(scratch, `capture-${runId++}`);
  mkdirSync(capture);
  const stdoutPath = join(capture, 'stdout');
  const stderrPath = join(capture, 'stderr');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  const child = spawn(file, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return new Promise((resolveRun, rejectRun) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120_000);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code, signal, timedOut,
        stdout: readFileSync(stdoutPath, 'utf8'),
        stderr: readFileSync(stderrPath, 'utf8'),
      });
    });
  });
}

try {
  const packRun = await run(process.execPath, [npmCli,
    'pack', '--json', '--pack-destination', scratch, '--cache', join(scratch, 'npm-cache'),
  ], { cwd: ROOT });
  assert.equal(packRun.code, 0, `npm pack failed:\n${packRun.stderr}`);
  const packed = JSON.parse(packRun.stdout)[0];
  const tarball = join(scratch, packed.filename);
  const extracted = await run('tar', ['-xzf', tarball, '-C', scratch]);
  assert.equal(extracted.code, 0, `package extraction failed:\n${extracted.stderr}`);

  const packedRoot = join(scratch, 'package');
  const chunksDir = join(packedRoot, 'dist', 'chunks');
  assert.equal(existsSync(join(packedRoot, 'node_modules')), false, 'tarball proof must not fall back to installed SDK files');

  const resolverFiles = readdirSync(chunksDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(chunksDir, name))
    .filter((path) => readFileSync(path, 'utf8').includes('no compiled .muflo packet found'));
  assert.equal(resolverFiles.length, 1, 'packed bundle has exactly one SDK MUFL resolver');

  const resolverDir = dirname(resolverFiles[0]);
  const searchDirs = [join(resolverDir, 'mufl_code'), join(resolverDir, '..', 'mufl_code')];
  const resolvedUnitDir = searchDirs.find((path) => existsSync(path));
  assert.equal(resolve(resolvedUnitDir ?? ''), resolve(packedRoot, 'dist', 'mufl_code'));

  const packets = readdirSync(resolvedUnitDir).filter((name) => name.endsWith('.muflo'));
  assert.equal(packets.length, 1, 'packed runtime has exactly one compiled MUFL packet');
  assert.match(packets[0], /^[A-F0-9]{64}\.muflo$/);
  const packedPacket = join(resolvedUnitDir, packets[0]);
  assert.ok(statSync(packedPacket).size > 0, 'packed MUFL packet is non-empty');

  const sdkDaemon = fileURLToPath(import.meta.resolve('@ours.network/sdk/daemon'));
  const sdkPacket = join(dirname(sdkDaemon), 'mufl_code', packets[0]);
  assert.equal(digest(packedPacket), digest(sdkPacket), 'packed MUFL packet is byte-identical to SDK 1.3.1');
  assert.ok(packed.files.some(({ path }) => path === `dist/mufl_code/${packets[0]}`));

  const packedWasm = join(chunksDir, 'mufl-bindings.wasm');
  const resolveSdkDependency = createRequire(sdkDaemon).resolve;
  const sdkWasm = resolveSdkDependency('@adapt-toolkit/sdk/mufl-bindings.wasm');
  assert.ok(statSync(packedWasm).size > 0, 'packed evaluator WASM is non-empty');
  assert.equal(digest(packedWasm), digest(sdkWasm), 'packed evaluator WASM is byte-identical to the SDK dependency');
  assert.ok(packed.files.some(({ path }) => path === 'dist/chunks/mufl-bindings.wasm'));

  const adaptDist = resolve(dirname(sdkWasm), '..');
  const adaptPackets = readdirSync(join(adaptDist, 'mufl_files')).filter((name) => name.endsWith('.muflo'));
  assert.equal(adaptPackets.length, 1, 'SDK dependency has exactly one ADAPT protocol unit');
  const packedAdaptPacket = join(packedRoot, 'mufl_files', adaptPackets[0]);
  assert.ok(statSync(packedAdaptPacket).size > 0, 'packed ADAPT protocol unit is non-empty');
  assert.equal(
    digest(packedAdaptPacket),
    digest(join(adaptDist, 'mufl_files', adaptPackets[0])),
    'packed ADAPT protocol unit is byte-identical to the SDK dependency',
  );
  assert.ok(packed.files.some(({ path }) => path === `mufl_files/${adaptPackets[0]}`));

  const installPrefix = join(scratch, 'installed');
  const installRun = await run(process.execPath, [npmCli,
    'install', '--prefix', installPrefix, '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', '--prefer-offline', tarball,
  ], { timeoutMs: 120_000 });
  assert.equal(installRun.timedOut, false, 'production-style package install exceeded its 120 second deadline');
  assert.equal(installRun.code, 0, `production-style package install failed:\n${installRun.stderr}`);
  const installed = join(installPrefix, 'node_modules', '@ours.network', 'messenger-server');
  assert.equal(existsSync(join(installed, 'dist', 'cli.js')), true, 'installed package contains its CLI');
  assert.equal(
    existsSync(join(installPrefix, 'node_modules', '@ours.network', 'sdk')),
    true,
    'production install contains the declared SDK dependency',
  );

  const help = await run(process.execPath, [join(installed, 'dist', 'cli.js'), '--help'], {
    env: { PATH: process.env.PATH, HOME: scratch },
  });
  assert.equal(help.code, 0, `packed --help failed:\n${help.stderr}`);
  assert.match(help.stdout, /ours-messenger-server <command>/);

  // Exercise the exact bundled static router against the production-installed
  // dist/web tree. This proves routing independently from file inclusion: the
  // manifest and every icon must agree over a real non-production HTTP socket.
  const bundledServers = readdirSync(join(installed, 'dist', 'chunks'))
    .filter((name) => /^server-[A-Z0-9]+\.js$/.test(name));
  assert.equal(bundledServers.length, 1, 'installed artifact has exactly one bundled server module');
  const { serveApp } = await import(pathToFileURL(join(installed, 'dist', 'chunks', bundledServers[0])).href);
  assert.equal(typeof serveApp, 'function', 'installed server exports its static router');
  const installedWeb = join(installed, 'dist', 'web');
  const installedManifest = JSON.parse(readFileSync(join(installedWeb, 'manifest.webmanifest'), 'utf8'));
  assert.ok(installedManifest.icons.length > 0, 'installed manifest declares PWA icons');
  const staticServer = createServer((request, response) => {
    void serveApp(request, response, installedWeb).catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    staticServer.once('error', rejectListen);
    staticServer.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const address = staticServer.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const icon of installedManifest.icons) {
      const iconPath = join(installedWeb, `.${icon.src}`);
      assert.equal(existsSync(iconPath), true, `${icon.src} physically exists in the installed artifact`);
      assert.ok(packed.files.some(({ path }) => path === `dist/web${icon.src}`), `${icon.src} is listed in the npm tarball`);
      const bytes = readFileSync(iconPath);

      const get = await fetch(`${origin}${icon.src}`);
      assert.equal(get.status, 200, `installed artifact GET ${icon.src}`);
      assert.equal(get.headers.get('content-type'), icon.type);
      assert.equal(get.headers.get('cache-control'), 'no-cache');
      assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(get.headers.get('content-length'), String(bytes.length));
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes, `${icon.src} never falls back to SPA HTML`);

      const head = await fetch(`${origin}${icon.src}`, { method: 'HEAD' });
      assert.equal(head.status, 200, `installed artifact HEAD ${icon.src}`);
      assert.equal(head.headers.get('content-type'), icon.type);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      staticServer.close((error) => error ? rejectClose(error) : resolveClose()));
  }

  // Recreate the reported package defect in a broken copy. Failure is before
  // the loopback listener: it must create neither an identity nor an
  // initialization receipt, even though private runtime bootstrap diagnostics
  // may remain for the operator.
  const brokenPrefix = join(scratch, 'broken-install');
  cpSync(installPrefix, brokenPrefix, { recursive: true });
  const broken = join(brokenPrefix, 'node_modules', '@ours.network', 'messenger-server');
  rmSync(join(broken, 'dist', 'mufl_code'), { recursive: true, force: true });
  const failedState = join(scratch, 'failed-init');
  const failed = await run(process.execPath, [
    join(broken, 'dist', 'cli.js'),
    'init', '--name', 'Human', '--bio', 'Package rollback fixture', '--yes',
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      OURS_MESSENGER_STATE_DIR: failedState,
      OURS_MESSENGER_PUBLIC_ORIGIN: 'http://messenger.test',
      OURS_MESSENGER_BROKER_URL: 'wss://invalid.local/none',
    },
  });
  assert.equal(failed.code, 1);
  const messengerErrors = failed.stderr.split('\n').filter((line) => line.startsWith('[messenger]'));
  assert.equal(messengerErrors.length, 1, 'messenger emits one stable operator-owned failure line');
  assert.match(messengerErrors[0], /^\[messenger\] startup failed \(correlation [0-9a-f-]+\)$/);
  assert.equal(existsSync(join(failedState, 'initialization.json')), false);
  assert.equal(existsSync(join(failedState, 'runtime', 'root.json')), false, 'failed init creates no Human/root marker');
  const identityArtifacts = existsSync(join(failedState, 'runtime'))
    ? readdirSync(join(failedState, 'runtime'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) =>
        existsSync(join(failedState, 'runtime', entry.name, 'identity.key')) ||
        existsSync(join(failedState, 'runtime', entry.name, 'state_data.bin')))
      .map((entry) => entry.name)
    : [];
  assert.deepEqual(identityArtifacts, []);

  const initializedState = join(scratch, 'initialized-state');
  const initialized = await run(process.execPath, [
    join(installed, 'dist', 'cli.js'),
    'init', '--name', 'Human', '--bio', 'Packed artifact fixture', '--yes',
  ], {
    timeoutMs: 120_000,
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      OURS_MESSENGER_STATE_DIR: initializedState,
      OURS_MESSENGER_PUBLIC_ORIGIN: 'http://messenger.test',
      OURS_MESSENGER_BROKER_URL: 'wss://invalid.local/none',
    },
  });
  assert.equal(initialized.timedOut, false, 'packed init exceeded its 120 second deadline');
  assert.equal(initialized.code, 0, `packed init failed:\nstdout:\n${initialized.stdout}\nstderr:\n${initialized.stderr}`);
  const receipt = JSON.parse(readFileSync(join(initializedState, 'initialization.json'), 'utf8'));
  assert.equal(receipt.identity.name, 'Human');
  assert.match(receipt.identity.cid, /^[A-F0-9]{64}$/);
  assert.match(initialized.stdout, new RegExp(`Initialized Human/root Human \\(${receipt.identity.cid}\\)`));
  assert.equal(existsSync(join(initializedState, 'runtime', 'Human', 'identity.key')), true);
  assert.equal(existsSync(join(initializedState, 'runtime', 'Human', 'state_data.bin')), true);

  console.log(`package-runtime-assets OK — ${packets[0]} resolves from packed dist/mufl_code`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
