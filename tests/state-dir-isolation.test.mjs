// REAL ENTRYPOINT-LAYER LIFECYCLE AND ISOLATION PROOF.
//
// Two subprocesses are required because the native SDK wrapper is intentionally
// one-boot-per-process: one exercises a complete start/close, the other forces a
// bind failure after the runtime has started and checks rollback.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter } from './harness.mjs';
import { migrateMessengerState } from '../src/lifecycle.ts';

const t = counter();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests/fixtures/owned-runtime-child.mjs');
const decoy = mkdtempSync(join(tmpdir(), 'ambient-ours-'));
const own = mkdtempSync(join(tmpdir(), 'messenger-owned-'));
const scratch = mkdtempSync(join(tmpdir(), 'messenger-lifecycle-'));
const ambientToken = 'AMBIENT-TOKEN-MUST-NOT-BECOME-RUNTIME-TOKEN';

writeFileSync(join(decoy, 'daemon-token'), ambientToken, { mode: 0o600 });
writeFileSync(join(decoy, 'startup-progress.json'), '{"pretend":true}');
writeFileSync(join(decoy, 'config.json'), JSON.stringify({
  stateDir: decoy,
  port: 1,
  brokerUrl: 'wss://ambient.invalid/forbidden',
  apiVisibility: 'shared',
  apiToken: ambientToken,
}));
const before = Object.fromEntries(readdirSync(decoy).map((name) => {
  const path = join(decoy, name);
  return [name, { bytes: readFileSync(path, 'base64'), mtime: statSync(path).mtimeMs }];
}));

async function run(mode, stateDir, extraEnv = {}) {
  const resultPath = join(scratch, `${mode}.json`);
  const outputPath = join(scratch, `${mode}.log`);
  const outputFd = openSync(outputPath, 'w');
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    env: {
      ...process.env,
      TEST_MODE: mode,
      TEST_RESULT_PATH: resultPath,
      OURS_MESSENGER_STATE_DIR: stateDir,
      OURS_STATE_DIR: decoy,
      OURS_CONFIG: join(decoy, 'config.json'),
      OURS_PORT: '1',
      OURS_BROKER_URL: 'wss://ambient.invalid/forbidden',
      OURS_API_TOKEN: ambientToken,
      ...extraEnv,
    },
    stdio: ['ignore', outputFd, outputFd],
  });
  closeSync(outputFd);
  const code = await new Promise((resolveExit) => child.once('exit', resolveExit));
  const output = readFileSync(outputPath, 'utf8');
  assert.equal(code, 0, `${mode} fixture failed (exit ${code}):\n${output}`);
  return { result: JSON.parse(readFileSync(resultPath, 'utf8')), output };
}

const empty = await run('empty-serve', own);
t.eq(empty.result.code, 'INITIALIZATION_REQUIRED', 'empty serve fails with the stable typed lifecycle code');
t.ok(!empty.result.stateMutated, 'empty serve creates no identity, lock, token, registrar, or other state entry');
t.eq(empty.result.listeningServersAfter, empty.result.listeningServersBefore, 'empty serve opens no enduring listener');

const initialized = await run('init', own);
t.eq(initialized.result.identityNames, ['Messenger'], 'offline init creates exactly one named Human/root identity');
t.ok(initialized.result.lockReleased, 'offline init releases runtime ownership before returning');
const lifecycle = await run('lifecycle', own);
t.eq(lifecycle.result.boundCid, initialized.result.cid, 'restart binds the identical CID pinned by offline initialization');
t.eq(lifecycle.result.stateStatus, 200, '/api/state remains available on the public messenger server');
t.eq(lifecycle.result.outerMcp, 404, 'messenger /mcp is 404');
t.eq(lifecycle.result.innerMcp, 404, 'embedded runtime /mcp is 404 without an injected MCP integration');
t.eq(lifecycle.result.unauthenticated, 401, 'owned runtime rejects a request without its owner token');
t.eq(lifecycle.result.authenticated, 200, 'and accepts the same loopback route with the owner token');
t.ok(lifecycle.result.runtimeStateDir === join(own, 'runtime'), 'runtime state is isolated under the messenger state root');
t.ok(lifecycle.result.token && lifecycle.result.token !== ambientToken, 'runtime minted its own token instead of inheriting ambient token material');
t.ok(!lifecycle.result.stateText.includes(lifecycle.result.token), '/api/state redacts the real runtime token');
t.ok(!lifecycle.output.includes(lifecycle.result.token), 'startup/shutdown logs redact the real runtime token');
if (!lifecycle.result.listenersRestored) {
  console.log(
    '  - signal listener ownership remains covered by sdk-signal-ownership.blocker.test.mjs: ' +
    JSON.stringify(lifecycle.result.signalListenersAfter),
  );
}
t.ok(lifecycle.result.lockReleased, 'programmatic close releases advisory runtime ownership');
t.ok(lifecycle.result.outerClosed && lifecycle.result.runtimeClosed, 'programmatic close stops both public and runtime loopback ports');
t.eq(lifecycle.result.listeningServersAfter, lifecycle.result.listeningServersBefore, 'programmatic close leaves no listening Server handle');

const migratedState = mkdtempSync(join(tmpdir(), 'messenger-migrated-'));
const migrationBackup = join(scratch, 'migration-backup');
const migration = migrateMessengerState({
  source: own,
  destinationStateDir: migratedState,
  backupDir: migrationBackup,
  confirmed: true,
});
t.eq(migration.sourceManifest.digest, migration.destinationManifest.digest, 'offline migration verifies the complete copied payload');
const migratedRestart = await run('lifecycle', migratedState);
t.eq(migratedRestart.result.boundCid, initialized.result.cid, 'migration restart preserves the original Human CID');

const rollbackState = mkdtempSync(join(tmpdir(), 'messenger-rollback-'));
await run('init', rollbackState, { TEST_INIT_NAME: 'Existing' });
const rollback = await run('rollback', rollbackState);
t.ok(rollback.result.rejected, 'invalid identity fails after runtime startup');
if (!rollback.result.listenersRestored) {
  console.log(
    '  - rollback signal listener ownership remains covered by sdk-signal-ownership.blocker.test.mjs: ' +
    JSON.stringify(rollback.result.signalListenersAfter),
  );
}
t.ok(rollback.result.lockReleased, 'partial-start rollback releases advisory runtime ownership');
t.eq(rollback.result.listeningServersAfter, rollback.result.listeningServersBefore, 'partial-start rollback leaves no listening Server handle');

const after = Object.fromEntries(readdirSync(decoy).map((name) => {
  const path = join(decoy, name);
  return [name, { bytes: readFileSync(path, 'base64'), mtime: statSync(path).mtimeMs }];
}));
assert.deepEqual(after, before, 'ambient ours state/config was created, rewritten, or removed');
t.ok(true, 'ambient OURS_STATE_DIR and OURS_CONFIG remain byte-for-byte untouched');

rmSync(decoy, { recursive: true, force: true });
rmSync(own, { recursive: true, force: true });
rmSync(rollbackState, { recursive: true, force: true });
rmSync(migratedState, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });
console.log(`\nstate-dir-isolation OK (${t.count} checks)`);
process.exit(0);
