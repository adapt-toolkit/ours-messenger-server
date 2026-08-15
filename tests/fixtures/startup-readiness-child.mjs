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
  async setConversationPolicy() { return { keepHistory: true }; },
  async readvertiseOnUpgrade() { return { readvertised: 0 }; },
  async currentIdentity() { return { name: 'Human', cid: 'CID-STABLE', bio: 'fixture' }; },
  async version() { return { version: 'fixture' }; },
  async releaseLease() { leaseReleased = true; },
  async *watchNotifications(_identity, { signal }) {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  },
};

const startRuntime = async () => {
  if (mode === 'ready') {
    // The real SDK restore performs long CPU-bound packet work on the caller's
    // event loop. A listener on that same loop exists in the kernel but cannot
    // answer build/readiness probes, which is operationally still unavailable.
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
    stateDir: `${stateDir}/runtime`,
    leaseToken: 'fixture-lease',
    described: {},
    async close() { runtimeClosed = true; },
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
  keepHistory: true,
  runtime: { brokerUrl: 'wss://invalid.local/none' },
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
