// What the MESSENGER SURFACE does with the introduction-carried first message.
// The SDK returns kind:"introduced" with no wireId; src/api.ts requires a wire
// id. This asks the real REST route what a user would actually see.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memSample, freePort, sleep } from './harness.mjs';

memSample('before');
const ownStateDir = mkdtempSync(join(tmpdir(), 'repro-noedge-state-'));
const webPort = await freePort();
const publicOrigin = `http://127.0.0.1:${webPort}`;
execFileSync(process.execPath, [
  '--import', 'tsx', fileURLToPath(new URL('./fixtures/owned-runtime-child.mjs', import.meta.url)),
], {
  env: {
    ...process.env, TEST_MODE: 'init', TEST_RESULT_PATH: join(ownStateDir, 'init-result.json'),
    TEST_INIT_NAME: 'Me', OURS_MESSENGER_STATE_DIR: ownStateDir,
  },
  stdio: 'ignore',
});

const { start } = await import('../src/server.ts');
const server = await start({
  host: '127.0.0.1', port: webPort, publicOrigin, identity: 'Me', force: false,
  stateDir: ownStateDir, keepHistory: true, runtime: { brokerUrl: 'wss://invalid.local/none' },
}, { name: '@ours.network/messenger-server', version: '0.1.0', sha: 'repro', dirty: false });

const { OursClient } = await import('@ours.network/sdk');
const { readFileSync } = await import('node:fs');
const runtimeToken = readFileSync(join(server.runtime.stateDir, 'daemon-token'), 'utf8').trim();
const peer = new OursClient({
  url: `http://127.0.0.1:${server.runtime.port}`, leaseToken: 'peer-lease', apiToken: runtimeToken,
});
await peer.createIdentity({ name: 'Peer', bio: 'repro peer', exposeLocal: true, localAutoAccept: true });
await peer.setConversationPolicy({ keep_history: true });
await peer.readvertiseOnUpgrade();
// NOTE: deliberately NO invite / addContact. The edge does not exist.

const base = `http://127.0.0.1:${server.port}`;
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', origin: publicOrigin, 'x-ours-messenger-csrf': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 300) };
};

console.log('\ncontacts before:', (await api('GET', '/api/contacts')).body);
const sent = await api('POST', '/api/messages/send', { contact: 'Peer', text: 'first message, no edge' });
console.log('POST /api/messages/send ->', sent.status, sent.body);
await sleep(3000);
console.log('contacts after :', (await api('GET', '/api/contacts')).body);
const peerConv = await peer.getConversation({ contact: 'Me' }).catch((e) => ({ error: String(e) }));
console.log('peer history   :', JSON.stringify((peerConv.messages ?? []).map((m) => ({ dir: m.dir, wire: m.wire_id, text: m.text }))));
const peerIncoming = await peer.listIncomingMessages().catch(() => []);
console.log('peer incoming  :', JSON.stringify(peerIncoming.map((m) => ({ wire: m.wire_id, text: m.text }))));

await server.close?.();
rmSync(ownStateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
