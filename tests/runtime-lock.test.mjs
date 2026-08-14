import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureOwnedRuntime } from '../src/boot-env.ts';
import { validateBrokerUrl } from '../src/config.ts';

assert.throws(() => validateBrokerUrl('wss://user:secret@broker.invalid/path'), /without credentials/);
assert.throws(() => validateBrokerUrl('wss://broker.invalid/path?token=secret'), /without credentials/);

const stateDir = mkdtempSync(join(tmpdir(), 'messenger-lock-'));
const runtimeDir = join(stateDir, 'runtime');
mkdirSync(runtimeDir);
writeFileSync(join(runtimeDir, '.messenger-runtime.lock'), JSON.stringify({ pid: 4242 }));

assert.throws(
  () => configureOwnedRuntime({
    host: '127.0.0.1',
    port: 0,
    identity: 'LockTest',
    force: false,
    stateDir,
    keepHistory: true,
    runtime: { brokerUrl: 'wss://invalid.local/none' },
  }),
  /already locked|Never run two messenger processes/,
  'an existing ownership record refuses concurrent state reuse before SDK import',
);

rmSync(stateDir, { recursive: true, force: true });
console.log('runtime-lock OK — concurrent state reuse fails before SDK import');
