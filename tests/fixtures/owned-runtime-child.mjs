import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { start } from '../../src/server.ts';
import { ownedRuntimeLockIsAvailable } from '../../src/boot-env.ts';
import { startRuntime } from '../../src/daemon.ts';
import { initializeMessengerState } from '../../src/lifecycle.ts';

const mode = process.env.TEST_MODE;
const resultPath = process.env.TEST_RESULT_PATH;
const stateDir = process.env.OURS_MESSENGER_STATE_DIR;
assert.ok(resultPath && stateDir && mode, 'fixture requires TEST_MODE, TEST_RESULT_PATH and state dir');

const signalCounts = () => ({
  sigint: process.listenerCount('SIGINT'),
  sigterm: process.listenerCount('SIGTERM'),
});
const signalListeners = () => ({
  sigint: process.listeners('SIGINT').map((listener) => listener.name || '<anonymous>'),
  sigterm: process.listeners('SIGTERM').map((listener) => listener.name || '<anonymous>'),
});
const listeningServers = () => process._getActiveHandles()
  .filter((handle) => typeof handle?.address === 'function' && handle.listening)
  .length;
const before = { signals: signalCounts(), servers: listeningServers() };
const stateEntriesBefore = existsSync(stateDir) ? readdirSync(stateDir).sort() : null;
const cfg = {
  host: '127.0.0.1',
  port: 0,
  identity: mode === 'rollback' ? 'Bad/Name' : 'Messenger',
  force: false,
  stateDir,
  keepHistory: true,
  runtime: { brokerUrl: 'wss://invalid.local/none' },
};

if (mode === 'empty-serve') {
  const error = await start(cfg, { name: 'test', version: 'empty-serve' }).then(
    () => null,
    (caught) => caught,
  );
  writeFileSync(resultPath, JSON.stringify({
    rejected: true,
    code: error?.code,
    stateMutated: JSON.stringify(existsSync(stateDir) ? readdirSync(stateDir).sort() : null) !== JSON.stringify(stateEntriesBefore),
    listeningServersBefore: before.servers,
    listeningServersAfter: listeningServers(),
  }));
  process.exit(0);
}

if (mode === 'init') {
  const initName = process.env.TEST_INIT_NAME || 'Messenger';
  const receipt = await initializeMessengerState(
    { ...cfg, identity: initName },
    { name: initName, bio: 'Lifecycle fixture Human identity', confirmed: true },
    { startRuntime, buildInfo: { name: 'test', version: 'init' } },
  );
  writeFileSync(resultPath, JSON.stringify({
    cid: receipt.identity.cid,
    identityNames: readdirSync(`${stateDir}/runtime`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(`${stateDir}/runtime/${entry.name}/identity.key`))
      .map((entry) => entry.name),
    lockReleased: ownedRuntimeLockIsAvailable(`${stateDir}/runtime/.messenger-runtime.lock`),
    listeningServersBefore: before.servers,
    listeningServersAfter: listeningServers(),
  }));
  process.exit(0);
}

if (mode === 'rollback') {
  await assert.rejects(() => start(cfg, { name: 'test', version: 'rollback' }), /name|invalid/i);
  await new Promise((resolve) => setImmediate(resolve));
  writeFileSync(resultPath, JSON.stringify({
    rejected: true,
    listenersRestored: JSON.stringify(signalCounts()) === JSON.stringify(before.signals),
    signalListenersAfter: signalListeners(),
    lockReleased: ownedRuntimeLockIsAvailable(`${stateDir}/runtime/.messenger-runtime.lock`),
    listeningServersBefore: before.servers,
    listeningServersAfter: listeningServers(),
  }));
  process.exit(0);
}

const handle = await start(cfg, { name: 'test', version: 'lifecycle' });
const outer = `http://127.0.0.1:${handle.port}`;
const inner = `http://127.0.0.1:${handle.runtime.port}`;
const token = readFileSync(`${handle.runtime.stateDir}/daemon-token`, 'utf8').trim();

const stateResponse = await fetch(`${outer}/api/state`);
const stateText = await stateResponse.text();
const stateJson = JSON.parse(stateText);
const outerMcp = await fetch(`${outer}/mcp`);
const innerMcp = await fetch(`${inner}/mcp`);
const unauthenticated = await fetch(`${inner}/identities`);
const authenticated = await fetch(`${inner}/identities`, {
  headers: { 'x-ours-api-token': token },
});

await handle.close();
await handle.close(); // idempotence is part of the public lifecycle contract.
await new Promise((resolve) => setImmediate(resolve));

const refuses = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return true;
  }
};

writeFileSync(resultPath, JSON.stringify({
  outerPort: handle.port,
  runtimePort: handle.runtime.port,
  runtimeStateDir: handle.runtime.stateDir,
  token,
  stateStatus: stateResponse.status,
  stateText,
  boundCid: stateJson.identity.cid,
  outerMcp: outerMcp.status,
  innerMcp: innerMcp.status,
  unauthenticated: unauthenticated.status,
  authenticated: authenticated.status,
  listenersRestored: JSON.stringify(signalCounts()) === JSON.stringify(before.signals),
  signalListenersBefore: before.signals,
  signalListenersAfter: signalListeners(),
  lockReleased: ownedRuntimeLockIsAvailable(`${handle.runtime.stateDir}/.messenger-runtime.lock`),
  outerClosed: await refuses(outer),
  runtimeClosed: await refuses(inner),
  listeningServersBefore: before.servers,
  listeningServersAfter: listeningServers(),
}));
process.exit(0);
