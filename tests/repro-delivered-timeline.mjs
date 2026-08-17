// REPRODUCTION ONLY — not a regression test. Captures the real receipt timeline
// the owner described: sender sends, recipient's open app marks read shortly
// after, sender's UI shows one tick then jumps to read.
//
// It boots the real server as the SENDER ("Me"), creates a Peer in the same
// owned runtime, subscribes to the sender's SSE stream, sends one message, and
// then polls the sender's conversation page every 100ms while the peer marks
// read after a configurable delay. Everything is stamped relative to send.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { until, memSample } from './harness.mjs';

const READ_DELAY_MS = Number(process.env.REPRO_READ_DELAY_MS ?? 2000);
const WATCH_MS = Number(process.env.REPRO_WATCH_MS ?? 12000);

memSample('before');
const ownStateDir = mkdtempSync(join(tmpdir(), 'repro-delivered-state-'));
const publicOrigin = 'http://messenger.test';
execFileSync(process.execPath, [
  '--import', 'tsx', fileURLToPath(new URL('./fixtures/owned-runtime-child.mjs', import.meta.url)),
], {
  env: {
    ...process.env,
    TEST_MODE: 'init',
    TEST_RESULT_PATH: join(ownStateDir, 'init-result.json'),
    TEST_INIT_NAME: 'Me',
    OURS_MESSENGER_STATE_DIR: ownStateDir,
  },
  stdio: 'ignore',
});

const { start } = await import('../src/server.ts');
const server = await start({
  host: '127.0.0.1', port: 0, publicOrigin, identity: 'Me', force: false,
  stateDir: ownStateDir, keepHistory: true, runtime: { brokerUrl: 'wss://invalid.local/none' },
}, { name: '@ours.network/messenger-server', version: '0.1.0', sha: 'repro', dirty: false });

const { OursClient } = await import('@ours.network/sdk');
const runtimeToken = readFileSync(join(server.runtime.stateDir, 'daemon-token'), 'utf8').trim();
const peer = new OursClient({
  url: `http://127.0.0.1:${server.runtime.port}`, leaseToken: 'peer-lease', apiToken: runtimeToken,
});
await peer.createIdentity({ name: 'Peer', bio: 'repro peer', exposeLocal: false, localAutoAccept: true });
await peer.setConversationPolicy({ keep_history: true });
await peer.readvertiseOnUpgrade();
const invite = await server.runtime.client.generateInvite({});
await peer.addContact({ invite: invite.blob });
await until('the contact link', async () => {
  const v = await peer.listContacts();
  return v.contacts.some((c) => c.name === 'Me') ? v : undefined;
});

const base = `http://127.0.0.1:${server.port}`;
const api = async (method, path, body) => {
  const mutating = method !== 'GET' && method !== 'HEAD';
  const res = await fetch(base + path, {
    method,
    headers: mutating ? { 'content-type': 'application/json', origin: publicOrigin, 'x-ours-messenger-csrf': '1' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

// ---- the sender's live event stream ----------------------------------------
const timeline = [];
let t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(5, ' ')}ms`;
const record = (layer, what) => { timeline.push({ ms: Date.now() - t0, layer, what }); console.log(`${at()}  ${layer.padEnd(10)} ${what}`); };

const sse = new AbortController();
const sseResponse = await fetch(base + '/api/events', { signal: sse.signal, headers: { accept: 'text/event-stream' } });
void (async () => {
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const name = /^event:\s*(.+)$/m.exec(frame)?.[1];
        const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
        if (name) record('SSE', `${name} ${data ?? ''}`);
      }
    }
  } catch { /* aborted */ }
})();

// ---- send, then watch the sender's own view of its receipt ------------------
t0 = Date.now();
const sent = await api('POST', '/api/messages/send', { contact: 'Peer', text: 'repro: does delivered ever show?' });
const wireId = sent.json.wire_id;
record('CLIENT', `send() resolved wire_id=${wireId.slice(0, 12)}… (UI shows one tick, receipt=null)`);

setTimeout(() => {
  void peer.markRead({ contact: 'Me' }).then(
    (r) => record('PEER', `markRead marked=${r.marked}`),
    (e) => record('PEER', `markRead failed: ${String(e)}`),
  );
}, READ_DELAY_MS);

let lastPage = null;
let lastReceipts = null;
const deadline = Date.now() + WATCH_MS;
while (Date.now() < deadline) {
  const page = await api('GET', `/api/conversations/Peer/page?limit=50`);
  const row = page.json.messages.find((m) => m.wire_id === wireId);
  const receipt = row ? String(row.receipt) : 'ABSENT';
  if (receipt !== lastPage) { record('PAGE', `projected receipt = ${receipt}`); lastPage = receipt; }
  const raw = await api('GET', `/api/conversations/Peer/receipts`);
  const rawReceipt = String(raw.json.receipts[wireId]);
  if (rawReceipt !== lastReceipts) { record('SDK', `getReceipts[wire] = ${rawReceipt}`); lastReceipts = rawReceipt; }
  await new Promise((r) => setTimeout(r, 100));
}

record('END', 'watch window closed');
console.log('\n--- TIMELINE (ms from send) ---');
for (const row of timeline) console.log(`${String(row.ms).padStart(6)}  ${row.layer.padEnd(10)} ${row.what}`);

sse.abort();
await server.close?.();
rmSync(ownStateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
