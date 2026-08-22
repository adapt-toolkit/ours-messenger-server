import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/startup-readiness-child.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'messenger-startup-readiness-'));
const unrelatedState = join(scratch, 'operator-owned-sentinel');
writeFileSync(unrelatedState, 'must not change');

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await sleep(20);
  }
}

async function request(port, path, init) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      signal: AbortSignal.timeout(250),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  } catch {
    return undefined;
  }
}

function launch(port, mode) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    env: { ...process.env, TEST_STATE_DIR: scratch, TEST_PORT: String(port), TEST_BOOT_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  return { child, messages, output: () => output };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitExit(child);
}

async function waitExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', resolve));
}

try {
  const port = await freePort();
  const run = launch(port, 'ready');
  try {
    await waitFor('fixture process to begin startup', async () =>
      run.messages.some((message) => message.type === 'starting') ? true : undefined);

    const build = await waitFor('bounded startup listener', () => request(port, '/api/build-info'));
    assert.equal(build.status, 200, `startup listener did not expose build metadata:\n${run.output()}`);
    assert.equal(build.json.sha, '1111111111111111111111111111111111111111');

    const health = await request(port, '/api/healthz');
    assert.equal(health?.status, 503, 'health stays unavailable until the identity runtime is fully bound');
    assert.deepEqual(health?.json, {
      status: 'starting', message: 'Service unavailable', version: '0.1.0',
      sha: '1111111111111111111111111111111111111111',
    });

    const identity = await request(port, '/api/identity');
    assert.equal(identity?.status, 503, 'identity reads are rejected before readiness');
    const mutation = await request(port, '/api/identity/bio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'must not be applied' }),
    });
    assert.equal(mutation?.status, 503, 'identity mutations are rejected before readiness without entering the API');

    run.child.send('release');
    await waitFor('runtime-ready transition', async () =>
      run.messages.some((message) => message.type === 'ready') ? true : undefined, 5_000);
    const readyHealth = await request(port, '/api/healthz');
    assert.equal(readyHealth?.status, 200);
    assert.equal(readyHealth?.json.identityCid, 'CID-STABLE');
    assert.equal((await request(port, '/api/identity'))?.status, 200, 'full REST API becomes available atomically');

    run.child.send('close');
    const closed = await waitFor('ordered shutdown', async () =>
      run.messages.find((message) => message.type === 'closed'));
    assert.equal(closed.leaseReleased, true);
    assert.equal(closed.runtimeClosed, true, 'messenger closes its runtime handle after releasing the lease');
    await waitExit(run.child);
    assert.equal(await request(port, '/api/build-info'), undefined, 'shutdown closes the public listener');
  } finally {
    await stop(run.child);
  }

  const rejectedPort = await freePort();
  const rejected = launch(rejectedPort, 'reject');
  try {
    await waitFor('rejection fixture startup listener', () => request(rejectedPort, '/api/build-info'));
    rejected.child.send('release');
    const failure = await waitFor('deterministic startup rejection', async () =>
      rejected.messages.find((message) => message.type === 'failed'));
    assert.match(failure.message, /deterministic boot rejection/);
    await waitExit(rejected.child);
    assert.equal(await request(rejectedPort, '/api/build-info'), undefined,
      'startup rollback closes a listener opened for readiness probes');
  } finally {
    await stop(rejected.child);
  }

  assert.equal(readFileSync(unrelatedState, 'utf8'), 'must not change',
    'startup never mutates unrelated operator-owned state');
  console.log('startup-readiness OK — bounded listener, safe 503 gate, atomic readiness, rollback and shutdown');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
