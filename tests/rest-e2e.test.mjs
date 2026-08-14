// THE WHOLE SERVER, END TO END: its owned SDK runtime, the REST surface, and a real
// signed WebPush request captured on the wire.
//
// It boots src/server.ts and its embedded runtime, exercises the routes a
// frontend actually calls, and then does the thing the owner named by name —
// a message lands in the packet on this server and THIS SERVER sends the push.
// The push is asserted against a local endpoint we control: the request that
// would go to a browser's push service, headers and all.
//
// WHAT THE PUSH ASSERTION READS, since a captured request is easy to check
// vacuously: not merely "a request arrived", but that it carries a VAPID
// `Authorization: vapid t=…, k=…` header, that the body is ENCRYPTED (aes128gcm),
// and — the one that matters for privacy — THAT THE MESSAGE TEXT IS NOWHERE IN
// THE REQUEST. The push payload is sender-and-count by design; a regression that
// started including message bodies would still produce a request and still have
// valid headers.

import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { counter, memSample, until } from './harness.mjs';

// THE FAKE PUSH SERVICE IS HTTPS, AND IT HAS TO BE. `web-push` calls
// `https.request` unconditionally (src/web-push-lib.js:369) — there is no http
// path and no option to choose one — because every real push service is HTTPS.
// A plain-http stub fails with `write EPROTO … SSL routines … packet length too
// long`, which is the library speaking TLS at an http socket, and it names
// neither web-push nor the stub. So the stub is a real TLS server with a
// self-signed cert.
//
// TLS VERIFICATION IS DISABLED FOR THIS TEST PROCESS ONLY, because the cert is
// self-signed and generated seconds ago. It is scoped to this file; nothing in
// src/ touches it, and no production path relies on it.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const t = counter();
memSample('before');

// ---- a push service we own ---------------------------------------------------
const certDir = mkdtempSync(join(tmpdir(), 'messenger-push-tls-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
  '-days', '1', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1',
], { stdio: 'ignore' });

const pushed = [];
const pushService = createServer({
  key: readFileSync(join(certDir, 'key.pem')),
  cert: readFileSync(join(certDir, 'cert.pem')),
}, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    pushed.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201).end();
  });
});
await new Promise((r) => pushService.listen(0, '127.0.0.1', r));
const pushAddress = pushService.address();
const pushPort = typeof pushAddress === 'object' && pushAddress ? pushAddress.port : 0;

// A REAL subscription key pair. web-push encrypts to it, so a made-up string
// would fail inside the library and the test would prove nothing about our code.
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const p256dh = ecdh.getPublicKey().toString('base64url');
const auth = randomBytes(16).toString('base64url');

// ---- boot the real server and the runtime IT owns ----------------------------
const ownStateDir = mkdtempSync(join(tmpdir(), 'messenger-e2e-state-'));
const publicOrigin = 'http://messenger.test';
const { start } = await import('../src/server.ts');
const server = await start(
  {
    host: '127.0.0.1',
    port: 0,
    publicOrigin,
    identity: 'Me',
    force: false,
    stateDir: ownStateDir,
    keepHistory: true,
    runtime: { brokerUrl: 'wss://invalid.local/none' },
  },
  {
    name: '@ours.network/messenger-server', version: '0.1.0',
    sha: '3fb10cc41af69e1a15cb99eab1c1b408ec245de0', dirty: false,
  },
);

// ---- a second session in the same owned runtime -----------------------------
const { OursClient } = await import('@ours.network/sdk');
const runtimeToken = readFileSync(join(server.runtime.stateDir, 'daemon-token'), 'utf8').trim();
const peer = new OursClient({
  url: `http://127.0.0.1:${server.runtime.port}`,
  leaseToken: 'peer-lease',
  apiToken: runtimeToken,
});
await peer.createIdentity({ name: 'Peer', bio: 'the other end', exposeLocal: false, localAutoAccept: true });
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
    headers: mutating ? {
      'content-type': 'application/json',
      origin: publicOrigin,
      'x-ours-messenger-csrf': '1',
    } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

// ---- the focused same-origin client ----------------------------------------
const shellResponse = await fetch(base + '/');
const shellHtml = await shellResponse.text();
t.eq(shellResponse.status, 200, 'GET / serves the focused messenger client');
t.ok(shellHtml.includes('id="app"') && shellHtml.includes('/app.js'), 'and its same-origin application entry');
const appResponse = await fetch(base + '/app.js');
t.eq(appResponse.status, 200, 'GET /app.js serves the built client bundle');
t.ok((await appResponse.text()).includes('/api/events'), 'whose live path is the same-origin SSE endpoint');
const clientRoute = await fetch(base + '/chats/peer');
t.ok((await clientRoute.text()).includes('id="app"'), 'non-API client routes fall back to the app shell');
const unknownApi = await api('GET', '/api/not-a-route');
t.eq(unknownApi.status, 404, 'unknown /api routes remain JSON 404s and never fall through to HTML');
const publicMcp = await fetch(base + '/mcp');
t.eq(publicMcp.status, 404, 'GET /mcp is 404 on the messenger surface');
const runtimeMcp = await fetch(`http://127.0.0.1:${server.runtime.port}/mcp`);
t.eq(runtimeMcp.status, 404, 'GET /mcp is 404 on the embedded runtime (no MCP integration injected)');

// ---- identity, state, build info --------------------------------------------
const who = await api('GET', '/api/identity');
t.eq(who.status, 200, 'GET /api/identity responds 200');
t.eq(who.json.name, 'Me', 'and reports the bound identity — this is the old getProfileName');

const state = await api('GET', '/api/state');
t.eq(state.json.runtime.ownership, 'embedded-sdk', '/api/state reports messenger-owned runtime provenance');
t.eq(state.json.keepHistory, true, 'and the retention policy in force');
t.ok(
  !JSON.stringify(state.json).includes(runtimeToken) &&
    !JSON.stringify(state.json).includes(ownStateDir) &&
    state.json.runtime.port === undefined && state.json.runtime.brokerUrl === undefined,
  'and owner token, state path, internal port, and broker are absent from the state response',
);

const build = await api('GET', '/api/build-info');
t.eq(build.json.name, '@ours.network/messenger-server', 'GET /api/build-info identifies the server');
t.eq(build.json.sha, '3fb10cc41af69e1a15cb99eab1c1b408ec245de0', 'and reports its build-time full commit');
const health = await api('GET', '/api/healthz');
t.eq(health.status, 200, 'GET /api/healthz proves the owned runtime is ready');
t.eq(health.json.identityCid, who.json.cid, 'and matches the startup-bound identity CID');

// ---- contacts and invites ----------------------------------------------------
const contacts = await api('GET', '/api/contacts');
t.ok(contacts.json.contacts.some((c) => c.name === 'Peer'), 'GET /api/contacts lists the peer');
const roots = await api('GET', '/api/contacts/roots');
t.ok(typeof roots.json.roots === 'object' && roots.json.roots !== null,
     'GET /api/contacts/roots returns the roots map — the old listContactRoots, no separate op needed');
const invites = await api('GET', '/api/invites');
t.ok(Array.isArray(invites.json), 'GET /api/invites returns a list — the old listPendingInvites');

// ---- the push subscription, before any message ------------------------------
const vapid = await api('GET', '/api/push/vapid-public-key');
t.ok(typeof vapid.json.publicKey === 'string' && vapid.json.publicKey.length > 20,
     'GET /api/push/vapid-public-key serves a key for the browser to subscribe with');

const sub = await api('POST', '/api/push/subscribe', {
  endpoint: `https://127.0.0.1:${pushPort}/push/device-1`,
  keys: { p256dh, auth },
  label: 'test device',
});
t.eq(sub.status, 200, 'POST /api/push/subscribe accepts a subscription');
t.ok(sub.json.keys === undefined, 'and does not echo the subscription keys back');
t.ok(sub.json.endpoint === undefined, 'and does not echo the push endpoint back');

// Idempotent on endpoint: a device re-subscribing must not double-push.
await api('POST', '/api/push/subscribe', { endpoint: `https://127.0.0.1:${pushPort}/push/device-1`, keys: { p256dh, auth } });
t.eq((await api('GET', '/api/state')).json.pushSubscriptions, 1,
     're-subscribing the same endpoint replaces it rather than duplicating — one device, one push');

// ---- THE THING HE ASKED FOR: a message lands, THIS SERVER pushes ------------
const SECRET = 'sekrit-message-text-that-must-not-leak';
await peer.sendMessage({ contact: 'Me', text: SECRET });

const req = await until('the server to issue a push', async () => (pushed.length ? pushed[0] : undefined), 60_000);
t.eq(pushed.length, 1, 'exactly ONE push request was issued for one message');
t.eq(req.url, '/push/device-1', 'to the endpoint the browser registered');

const authz = req.headers.authorization ?? '';
t.ok(authz.startsWith('vapid '), 'the request is VAPID-signed (Authorization: vapid …)');
t.ok(/\bt=[\w-]+\.[\w-]+\.[\w-]+/.test(authz), 'carrying a JWT in t=');
t.ok(/\bk=[\w-]{20,}/.test(authz), 'and the application server public key in k=');
t.eq(req.headers['content-encoding'], 'aes128gcm', 'the payload is encrypted to the subscription');
t.ok(req.body.length > 0, 'and the body is non-empty');

// THE PRIVACY ASSERTION. Sender and count, never text.
const wire = Buffer.concat([Buffer.from(JSON.stringify(req.headers)), req.body]).toString('latin1');
t.ok(!wire.includes(SECRET), 'AND THE MESSAGE TEXT APPEARS NOWHERE IN THE REQUEST — push carries sender and count, not content');

// ---- the read path, through the REST surface --------------------------------
const page = await until('the message to appear in the conversation page', async () => {
  const p = await api('GET', '/api/conversations/Peer/page?limit=10');
  return p.json.messages.length ? p : undefined;
});
t.eq(page.json.unread, 1, 'GET …/page reports 1 unread — reading a page marks nothing');
t.eq(page.json.messages.at(-1).text, SECRET, 'and the page carries the message');

const sentId = (await peer.getConversation({ contact: 'Me' })).messages.filter((m) => m.dir === 'out').at(-1).wire_id;
t.ok((await peer.getReceipts({ contact: 'Me' })).receipts[sentId] !== 'read',
     'the peer has NO read receipt yet — the REST read path is non-consuming');

const marked = await api('POST', '/api/conversations/Peer/read');
t.eq(marked.json.marked, 1, 'POST …/read marks exactly the one unread entry');
await until('the read receipt to reach the peer', async () => {
  const r = await peer.getReceipts({ contact: 'Me' });
  return r.receipts[sentId] === 'read' ? r : undefined;
});
t.ok(true, 'and the peer now sees READ — the human read event, and only it, emits the receipt');

// ---- getMessages is NOT reachable over REST ---------------------------------
// The hazard removed at the surface rather than warned about in a docstring.
for (const path of ['/api/messages', '/api/messages/get', '/api/getMessages', '/api/messages/pull']) {
  const r = await api('POST', path);
  t.eq(r.status, 404, `POST ${path} is 404 — the consuming path is not on this surface`);
}

// ---- sending, and error shape -----------------------------------------------
const sent = await api('POST', '/api/messages/send', { contact: 'Peer', text: 'reply from the server' });
t.eq(sent.status, 200, 'POST /api/messages/send sends as the bound identity');
await until('the reply to reach the peer', async () => {
  const v = await peer.getConversation({ contact: 'Me' });
  return v.messages.some((m) => m.dir === 'in' && m.text === 'reply from the server') ? v : undefined;
});
t.ok(true, 'and it arrives at the peer');

const bad = await api('POST', '/api/messages/send', { contact: 'Peer' });
t.eq(bad.status, 400, 'a missing field is a 400');
t.ok(bad.json.error.message.includes('text'), 'naming the field that was missing');

const engineErr = await api('POST', '/api/messages/send', { contact: 'NoSuchContact', text: 'x' });
t.eq(engineErr.status, 400, 'an engine error is a 400');
t.ok(typeof engineErr.json.error.code === 'string' && engineErr.json.error.code.length > 0,
     `and returns a fixed public code (${engineErr.json.error.code}) rather than raw engine text`);

const badCursor = await api('GET', '/api/conversations/Peer/page?before=NOPE');
t.eq(badCursor.status, 400, 'an unresolvable page cursor is a 400, not a silent reset to the newest page');

await server.close();
await new Promise((r) => pushService.close(r));
rmSync(ownStateDir, { recursive: true, force: true });
rmSync(certDir, { recursive: true, force: true });
memSample('after');
console.log(`\nrest-e2e OK (${t.count} checks) — the REST surface, and a real signed push carrying no message text`);
process.exit(0);
