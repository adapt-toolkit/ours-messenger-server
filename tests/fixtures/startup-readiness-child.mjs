import assert from 'node:assert/strict';
import { start } from '../../src/server.ts';

const stateDir = process.env.TEST_STATE_DIR;
const port = Number(process.env.TEST_PORT);
const mode = process.env.TEST_BOOT_MODE ?? 'ready';
assert.ok(stateDir && Number.isInteger(port) && port > 0, 'startup fixture requires state and port');

let releaseBoot;
const bootGate = new Promise((resolve) => { releaseBoot = resolve; });
let leaseReleased = false;
let runtimeClosed = false;

const client = {
  async chooseIdentity() { return { cid: 'CID-STABLE' }; },
  async currentIdentity() { return { name: 'Human', cid: 'CID-STABLE', bio: 'fixture' }; },
  async version() { return { version: 'fixture', compat: 3, stateDir: '/operator/daemon' }; },
  async listIncomingMessages() { return []; },
  async listIncomingFiles() { return []; },
  async releaseLease() { leaseReleased = true; },
  async *watchNotifications(_identity, { signal }) {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  },
};

const startRuntime = async () => {
  if (mode === 'ready') {
    // Model a pathological slow attach on the caller's event loop. The bounded
    // readiness responder remains independently available while no identity
    // lease or application API exists yet.
    const blockedUntil = Date.now() + 3_000;
    while (Date.now() < blockedUntil) {
      // Deliberately model the source boundary; the readiness responder must
      // remain live on an independent event loop.
    }
  }
  await bootGate;
  if (mode === 'reject') throw new Error('deterministic boot rejection');
  return {
    client,
    port: 32123,
    stateDir: '/operator/daemon',
    leaseToken: 'fixture-lease',
    described: { ownership: 'shared-daemon' },
    async close() {
      await client.releaseLease();
      runtimeClosed = true;
    },
  };
};

process.on('message', (message) => {
  if (message === 'release') releaseBoot();
});

const starting = start({
  host: '127.0.0.1',
  port,
  publicOrigin: `http://127.0.0.1:${port}`,
  identity: 'Human',
  force: false,
  stateDir,
}, {
  name: '@ours.network/messenger-server',
  version: '0.1.0',
  sha: '1111111111111111111111111111111111111111',
  dirty: false,
}, { startRuntime });

process.send?.({ type: 'starting' });

try {
  const handle = await starting;
  process.send?.({ type: 'ready' });
  await new Promise((resolve) => process.on('message', async (message) => {
    if (message !== 'close') return;
    await handle.close();
    process.send?.({ type: 'closed', leaseReleased, runtimeClosed });
    resolve();
  }));
  process.exit(0);
} catch (error) {
  process.send?.({
    type: 'failed',
    message: error instanceof Error ? error.message : String(error),
    leaseReleased,
    runtimeClosed,
  });
  process.exit(mode === 'reject' ? 0 : 1);
}
