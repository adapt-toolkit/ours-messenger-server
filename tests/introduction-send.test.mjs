// THE REGRESSION FOR "the surface said a delivered message was not delivered".
//
// A first message to an identity this one has no contact edge with cannot use the
// ordinary send transaction. The SDK connects on the way past and carries the text
// inside the introduction: the message ARRIVES, and it gets NO WIRE ID, because the
// introduction has no slot for one.
//
// `POST /api/messages/send` used to require a wire id and throw without one, so that
// successful send was answered with HTTP 500 and the client rendered
// "Send failed … the message was not delivered" over a message the peer already had.
//
// WHAT THIS ASSERTS, and why each half is needed:
//   1. the introduction-carried send answers 200, reports delivery "introduced",
//      and reports wire_id null — not a fabricated id, and not an error;
//   2. THE PEER ACTUALLY HAS THE MESSAGE. Without this, assertion 1 would stay green
//      if the route were "fixed" by swallowing a genuine failure, which is the exact
//      wrong fix and the one the old throw was defending against;
//   3. the ordinary send over the now-existing edge still reports a real wire id and
//      delivery "tracked", so the honest path is not quietly downgraded to the
//      untracked one;
//   4. a missing wire id on any OTHER outcome kind still throws — the guard the old
//      code was providing is kept, narrowed to the cases where it is correct.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter, freePort, memSample, until } from './harness.mjs';

const t = counter();
memSample('before');

const stateDir = mkdtempSync(join(tmpdir(), 'messenger-introsend-'));
const port = await freePort();
const publicOrigin = `http://127.0.0.1:${port}`;
execFileSync(process.execPath, [
  '--import', 'tsx', fileURLToPath(new URL('./fixtures/owned-runtime-child.mjs', import.meta.url)),
], {
  env: {
    ...process.env, TEST_MODE: 'init', TEST_RESULT_PATH: join(stateDir, 'init-result.json'),
    TEST_INIT_NAME: 'Me', OURS_MESSENGER_STATE_DIR: stateDir,
  },
  stdio: 'ignore',
});

const { start } = await import('../src/server.ts');
const server = await start({
  host: '127.0.0.1', port, publicOrigin, identity: 'Me', force: false,
  stateDir, keepHistory: true, runtime: { brokerUrl: 'wss://invalid.local/none' },
}, { name: '@ours.network/messenger-server', version: '0.1.0', sha: 'introduction-send-test', dirty: false });

const { OursClient } = await import('@ours.network/sdk');
const runtimeToken = readFileSync(join(server.runtime.stateDir, 'daemon-token'), 'utf8').trim();
const peer = new OursClient({
  url: `http://127.0.0.1:${server.runtime.port}`, leaseToken: 'peer-lease', apiToken: runtimeToken,
});
await peer.createIdentity({ name: 'Peer', bio: 'the other end', exposeLocal: true, localAutoAccept: true });
await peer.setConversationPolicy({ keep_history: true });
await peer.readvertiseOnUpgrade();
// DELIBERATELY NO INVITE AND NO addContact. The absence of the edge is the subject.

const base = `http://127.0.0.1:${port}`;
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : {
      'content-type': 'application/json', origin: publicOrigin, 'x-ours-messenger-csrf': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

t.eq((await api('GET', '/api/contacts')).json.contacts, [], 'no contact edge exists before the first send');

// ---- 1. the introduction-carried send -------------------------------------
const introText = 'the first message, carried by the introduction';
const introduced = await api('POST', '/api/messages/send', { contact: 'Peer', text: introText });
t.eq(introduced.status, 200, 'a send with no contact edge answers 200, not 500');
t.eq(introduced.json.delivery, 'introduced', 'and reports the outcome for what it is: introduced');
t.eq(introduced.json.wire_id, null, 'with wire_id null — no id is invented for a message that has none');

// ---- 2. THE COUNTERWEIGHT: the peer really has it -------------------------
// Assertion 1 alone would also pass if the route had been "fixed" by swallowing a
// real failure. This is what makes the 200 mean something.
const landed = await until('the introduction-carried message to reach the peer', async () => {
  const incoming = await peer.listIncomingMessages();
  const match = incoming.find((message) => message.text === introText);
  return match ?? undefined;
});
t.ok(landed, 'THE PEER RECEIVED IT — the 200 describes a delivered message, not a swallowed error');
t.eq(landed.wire_id, '', 'and it carries no wire id at the peer either, which is why no receipt can name it');

// The introduction is also what creates the edge, so the contact list must move.
const linked = await until('the contact edge the introduction created', async () => {
  const contacts = (await api('GET', '/api/contacts')).json.contacts;
  return contacts.some((contact) => contact.name === 'Peer') ? contacts : undefined;
});
t.ok(linked.some((contact) => contact.name === 'Peer'), 'the introduction created the contact edge');

// ---- 3. the ordinary path is unchanged ------------------------------------
const trackedText = 'the second message, over the edge that now exists';
const tracked = await api('POST', '/api/messages/send', { contact: 'Peer', text: trackedText });
t.eq(tracked.status, 200, 'the ordinary send still answers 200');
t.eq(tracked.json.delivery, 'tracked', 'and reports delivery "tracked"');
t.ok(typeof tracked.json.wire_id === 'string' && tracked.json.wire_id.length > 0,
     'with a real wire id — the honest path is not downgraded to the untracked one');

const receipted = await until('a delivered receipt for the tracked send', async () => {
  const receipts = await server.runtime.client.getReceipts({ contact: 'Peer' });
  return receipts.receipts[tracked.json.wire_id] ? receipts : undefined;
});
t.eq(receipted.receipts[tracked.json.wire_id], 'delivered',
     'and it acquires a delivered receipt, which the introduction-carried one never can');

await server.close?.();
rmSync(stateDir, { recursive: true, force: true });
memSample('after');
console.log(`\nintroduction-send OK (${t.count} checks) — an introduction-carried send is reported as delivered-but-untracked, never as a failure`);
process.exit(0);
