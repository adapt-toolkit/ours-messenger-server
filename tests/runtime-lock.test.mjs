import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBrokerUrl } from '../src/config.ts';

assert.throws(() => validateBrokerUrl('wss://user:secret@broker.invalid/path'), /without credentials/);
assert.throws(() => validateBrokerUrl('wss://broker.invalid/path?token=secret'), /without credentials/);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests/fixtures/runtime-lock-child.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'messenger-runtime-lock-'));
const stateDir = join(scratch, 'state');

function attempt() {
  return spawnSync(process.execPath, ['--import', 'tsx', FIXTURE], {
    env: { ...process.env, TEST_STATE_DIR: stateDir, TEST_LOCK_MODE: 'try' },
    encoding: 'utf8',
  });
}

async function holder(tag) {
  const readyPath = join(scratch, `${tag}.ready`);
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
    env: { ...process.env, TEST_STATE_DIR: stateDir, TEST_READY_PATH: readyPath, TEST_LOCK_MODE: 'hold' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (!existsSync(readyPath)) {
    if (child.exitCode !== null) throw new Error(`${tag} exited ${child.exitCode}: ${stderr}`);
    assert.ok(Date.now() < deadline, `${tag} did not acquire lock`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return child;
}

try {
  const first = await holder('first');
  const collision = attempt();
  assert.equal(collision.status, 3, `live collision must fail: ${collision.stderr}`);
  assert.match(collision.stderr, /already locked|another messenger process/i);

  // Changing stale-looking metadata, including a reused live PID, cannot steal
  // an OS-held advisory lock: ownership is the descriptor, never the PID text.
  const lockPath = join(stateDir, 'runtime', '.messenger-runtime.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, processStart: 'forged-reuse' }));
  assert.equal(attempt().status, 3, 'PID reuse metadata cannot steal a live lock');

  first.send('close');
  await new Promise((resolveExit) => first.once('exit', resolveExit));
  assert.equal(attempt().status, 0, 'graceful release permits restart');

  const killed = await holder('killed');
  killed.kill('SIGKILL');
  await new Promise((resolveExit) => killed.once('exit', resolveExit));
  assert.equal(attempt().status, 0, 'SIGKILL releases ownership without deleting a lock file');
  assert.ok(existsSync(lockPath), 'persistent diagnostic inode is harmless; ownership is advisory');
  assert.doesNotThrow(() => JSON.parse(readFileSync(lockPath, 'utf8')), 'latest owner record remains diagnostic JSON');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('runtime-lock OK — advisory ownership rejects live collisions and recovers after graceful/SIGKILL exit');
