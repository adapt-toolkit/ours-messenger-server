import { writeFileSync, writeSync } from 'node:fs';
import { configureOwnedRuntime, releaseOwnedRuntimeLock } from '../../src/boot-env.ts';

const stateDir = process.env.TEST_STATE_DIR;
const readyPath = process.env.TEST_READY_PATH;
if (!stateDir) throw new Error('TEST_STATE_DIR is required');

const cfg = {
  host: '127.0.0.1', port: 0, identity: 'LockTest', force: false, stateDir,
  keepHistory: true, runtime: { brokerUrl: 'wss://invalid.local/none' },
};

try {
  configureOwnedRuntime(cfg);
} catch (error) {
  // Synchronous so an immediate exit cannot truncate a piped diagnostic.
  writeSync(2, String(error));
  process.exit(3);
}

if (readyPath) writeFileSync(readyPath, String(process.pid));

if (process.env.TEST_LOCK_MODE === 'try') {
  releaseOwnedRuntimeLock();
  process.exit(0);
}

process.on('message', (message) => {
  if (message !== 'close') return;
  releaseOwnedRuntimeLock();
  process.disconnect();
  process.exit(0);
});

// Keep the inherited advisory lock descriptor alive until graceful close or
// SIGKILL. The interval is deliberately unref'd; the IPC channel owns lifetime.
setInterval(() => {}, 60_000).unref();
