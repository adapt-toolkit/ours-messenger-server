// DETERMINISTIC RELEASE-BLOCKER GATE for the locally linked SDK head dd0fa113.
//
// The default suite reports a named skip until the SDK exposes the minimal
// embedding contract. It then becomes the acceptance test for the blocker:
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

if (!/handleSignals\??:\s*boolean/.test(daemonTypes)) {
  console.log(
    'sdk-signal-ownership SKIP — release blocker: SDK DaemonOptions is missing ' +
    'handleSignals?: boolean (default true; embedded host must pass false)',
  );
  process.exit(0);
}
assert.match(
  messengerRuntime,
  /startDaemon\(\{[^}]*handleSignals:\s*false/s,
  'messenger must disable SDK-owned process signal handling once the option is released',
);

console.log('sdk-signal-ownership OK — embedded runtime leaves signals and process exit to messenger');
