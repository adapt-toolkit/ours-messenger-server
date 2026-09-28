import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from '../src/daemon.ts';
import { start } from '../src/server.ts';

const BUILD = { name: '@ours.network/messenger-server', version: 'fixture', sha: '1'.repeat(40), dirty: false };
const CONFIG = { host: '127.0.0.1', port: 0, publicOrigin: 'http://localhost', identity: 'Messenger', force: false };
const ACK = { released: [], closed: [], attempted: 0, notified: 0, failed: 0 };
function client(extra = {}) {
  return {
    version: async () => ({ version: 'fixture', compat: 3, stateDir: '/operator/daemon' }),
    chooseIdentity: async () => ({ cid: 'CID-MESSENGER' }),
    currentIdentity: async () => ({ name: 'Messenger', cid: 'CID-MESSENGER' }),
    releaseLease: async () => ACK,
    close() {},
    ...extra,
  };
}
const vars = ['OURS_DAEMON_URL', 'OURS_DAEMON_ID', 'OURS_DAEMON_CREDENTIAL_PATH'];
async function selected(values, fn) {
  const before = vars.map(key => process.env[key]);
  vars.forEach((key, i) => values[i] === undefined ? delete process.env[key] : process.env[key] = values[i]);
  try { await fn(); } finally {
    vars.forEach((key, i) => before[i] === undefined ? delete process.env[key] : process.env[key] = before[i]);
  }
}
test('complete V1 selection reaches the SDK and the same client reads full pages', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'messenger-v1-selection-'));
  try { await selected(['http://daemon:3210', 'fixture-daemon', '/private/current-token'], async () => {
    let options, read;
    const signal = new AbortController().signal;
    const runtime = await startRuntime({ ...CONFIG, stateDir }, BUILD, async value => {
      options = value;
      return client({ readNotificationPage: async (...args) => {
        read = args;
        return { cursor: 42, events: [
          { event: 'receipt_received', kind: 'read' },
          { event: 'contact_removed' },
        ] };
      } });
    });
    try {
      assert.equal(options.endpoint, 'http://daemon:3210');
      assert.equal(options.expectedInstanceId, 'fixture-daemon');
      assert.equal(options.credentialPath, '/private/current-token');
      assert.equal(options.sessionMode, 'external');
      assert.deepEqual(options.env, {});
      assert.equal(options.leaseToken, runtime.leaseToken);
      assert.deepEqual(await runtime.readNotificationPage('Messenger', 17, signal),
        { cursor: 42, events: [{ event: 'receipt_received', kind: 'read' }] });
      assert.deepEqual(read, ['Messenger', { since: 17, signal }]);
    } finally { await runtime.close(); }
  }); } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
test('partial V1 selection refuses before attachment', async () => {
  await selected(['http://daemon:3210', undefined, undefined], async () => {
    let attached = false;
    await assert.rejects(startRuntime(CONFIG, BUILD, async () => {
      attached = true;
      return client();
    }), /OURS_DAEMON/);
    assert.equal(attached, false);
  });
});
for (const mode of ['partial', 'rejected']) {
  test('runtime reports ' + mode + ' terminal release and closes transport', async () => {
    let closed = 0;
    const runtime = await startRuntime(CONFIG, BUILD, async () => client({
      releaseLease: async () => {
        if (mode === 'rejected') throw new Error('fixture release rejected');
        return { ...ACK, failed: 1 };
      },
      close() { closed++; },
    }));
    await assert.rejects(runtime.close(), /release|cleanup/i);
    await assert.rejects(runtime.close(), /release|cleanup/i);
    assert.equal(closed, 1);
  });
}
test('server close propagates failed owner release', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'messenger-v1-close-'));
  const runtime = {
    client: client(), described: {}, leaseToken: 'fixture-owner',
    readNotificationPage: async (_identity, since, signal) => {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { cursor: typeof since === 'number' ? since : 0, events: [] };
    },
    close: async () => { throw new Error('fixture release rejected'); },
  };
  try {
    const handle = await start({ ...CONFIG, stateDir }, BUILD, { startRuntime: async () => runtime });
    await assert.rejects(handle.close(), /fixture release rejected/);
    await assert.rejects(handle.close(), /fixture release rejected/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
test('server drains an admitted HTTP handler before retiring its owner', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'messenger-v1-drain-'));
  let entered, resume;
  const enteredPromise = new Promise(resolve => entered = resolve);
  const gate = new Promise(resolve => resume = resolve);
  let handlerFinished = false, released = false;
  const runtime = {
    client: client({ currentIdentity: async () => {
      entered();
      await gate;
      handlerFinished = true;
      return { name: 'Messenger', cid: 'CID-MESSENGER' };
    } }),
    described: {}, leaseToken: 'fixture-owner',
    readNotificationPage: async (_identity, since, signal) => {
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { cursor: typeof since === 'number' ? since : 0, events: [] };
    },
    close: async () => { released = true; },
  };
  let closing;
  try {
    const handle = await start({ ...CONFIG, stateDir }, BUILD, { startRuntime: async () => runtime });
    const response = fetch('http://127.0.0.1:' + handle.port + '/api/identity').catch(() => undefined);
    await enteredPromise;
    closing = handle.close();
    await sleep(50);
    const retiredBeforeDrain = released;
    resume();
    await closing;
    await response;
    assert.equal(retiredBeforeDrain, false, 'owner must remain until admitted API work settles');
    assert.equal(handlerFinished, true);
    assert.equal(released, true);
  } finally {
    resume();
    await closing?.catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runtime waits for asynchronous transport close and retains its failure', async () => {
  let finish, entered;
  const gate = new Promise(resolve => finish = resolve);
  const began = new Promise(resolve => entered = resolve);
  const runtime = await startRuntime(CONFIG, BUILD, async () => client({ close: async () => {
    entered();
    await gate;
    throw new Error('fixture transport close rejected');
  } }));
  let completed = false;
  const closed = runtime.close();
  const checked = assert.rejects(closed, /fixture transport close rejected/).then(() => { completed = true; });
  await began;
  await Promise.resolve();
  assert.equal(completed, false);
  finish();
  await checked;
  await assert.rejects(runtime.close(), /fixture transport close rejected/);
});
