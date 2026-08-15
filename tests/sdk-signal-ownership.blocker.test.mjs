// SDK embedding-contract gate. The linked SDK must expose the option, and the
// messenger must opt out of SDK-owned process lifecycle behavior:
// startDaemon({ handleSignals: false }) must install no process signal handlers
// and must never call process.exit; the host then owns ordered shutdown through
// DaemonHandle.close(). Default true preserves current CLI/MCP behavior.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = fileURLToPath(import.meta.resolve('@ours.network/sdk/daemon'));
const daemonTypes = readFileSync(join(dirname(daemonEntry), 'http/server.d.ts'), 'utf8');
const messengerRuntime = readFileSync(join(root, 'src/daemon.ts'), 'utf8');

assert.match(
  daemonTypes,
  /handleSignals\??:\s*boolean/,
  'SDK DaemonOptions must expose handleSignals?: boolean',
);
assert.match(
  messengerRuntime,
  /startDaemon\(\{.*?handleSignals:\s*false.*?\}\);/s,
  'messenger must disable SDK-owned process signal handling once the option is released',
);

console.log('sdk-signal-ownership OK — embedded runtime leaves signals and process exit to messenger');
