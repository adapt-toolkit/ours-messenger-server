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
// and — the one that matters for the provider boundary — THAT THE PLAINTEXT IS
// NOWHERE IN THE REQUEST. The encrypted payload intentionally contains the full
// owner notification text; the push service sees ciphertext and delivery metadata.

import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
execFileSync(process.execPath, [
  '--import', 'tsx', fileURLToPath(new URL('./fixtures/owned-runtime-child.mjs', import.meta.url)),
], {
  env: {
    ...process.env,
    TEST_MODE: 'init',
    TEST_RESULT_PATH: join(certDir, 'init-result.json'),
    TEST_INIT_NAME: 'Me',
    OURS_MESSENGER_STATE_DIR: ownStateDir,
  },
  stdio: 'ignore',
});
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
const peerIdentity = await peer.createIdentity({ name: 'Peer', bio: 'the other end', exposeLocal: false, localAutoAccept: true });
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
const appAsset = shellHtml.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
t.ok(shellHtml.includes('id="app"') && appAsset, 'and its same-origin content-hashed Vite entry');
const appResponse = await fetch(base + appAsset);
t.eq(appResponse.status, 200, 'GET the hashed Vite entry serves the built client bundle');
t.eq(appResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'hashed assets are immutable');
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

// THE PROVIDER PRIVACY ASSERTION. Full text exists only inside aes128gcm.
const wire = Buffer.concat([Buffer.from(JSON.stringify(req.headers)), req.body]).toString('latin1');
t.ok(!wire.includes(SECRET), 'AND THE PLAINTEXT APPEARS NOWHERE IN THE REQUEST — the owner payload is encrypted to the browser');

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
const sent = await api('POST', '/api/messages/send', {
  contact: peerIdentity.info.cid,
  text: 'reply from the server',
  reply_to_wire_id: sentId,
});
t.eq(sent.status, 200, 'POST /api/messages/send sends as the bound identity');
await until('the reply to reach the peer', async () => {
  const v = await peer.getConversation({ contact: 'Me' });
  return v.messages.some((m) => m.dir === 'in' && m.text === 'reply from the server') ? v : undefined;
});
t.ok(true, 'and it arrives at the peer');
const replyPage = await api('GET', `/api/conversations/${encodeURIComponent(peerIdentity.info.cid)}/page?limit=10`);
const replyRow = replyPage.json.messages.find((message) => message.text === 'reply from the server');
t.eq(replyRow.reply_to, { wire_id: sentId }, 'reply correlation survives the SDK history projection and renders from canonical wire ids');

// ---- files/photos/voice and immutable per-dialog versions ------------------
const photoV1 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const photoV2 = Buffer.from('89504e470d0a1a0a0000000d4948445201', 'hex');
const sendPhoto = (bytes) => api('POST', '/api/messages/send-file', {
  contact: peerIdentity.info.cid,
  data_base64: bytes.toString('base64'),
  filename: 'photo.png',
  mime: 'image/png',
  reply_to_wire_id: sentId,
});
const photo1 = await sendPhoto(photoV1);
const photo2 = await sendPhoto(photoV2);
t.eq(photo1.status, 200, 'browser photo upload sends through the real SDK file operation');
t.eq(photo2.status, 200, 'a logical second version is sent without overwriting the first');
const photoWire1 = photo1.json.wireId;
const photoWire2 = photo2.json.wireId;
await until('both photos to reach the isolated peer', async () => {
  const rows = await peer.listIncomingFiles();
  return rows.some((row) => row.wire_id === photoWire1) && rows.some((row) => row.wire_id === photoWire2) ? rows : undefined;
});
const peerPhotos = await peer.getFiles({ wire_ids: [photoWire1, photoWire2] });
t.eq(readFileSync(peerPhotos.files.find((file) => file.wire_id === photoWire1).path), photoV1,
  'photo v1 round-trips byte-for-byte to the isolated identity');
t.eq(readFileSync(peerPhotos.files.find((file) => file.wire_id === photoWire2).path), photoV2,
  'photo v2 round-trips independently without overwriting v1');
const photoInventory = await api('GET', `/api/conversations/${encodeURIComponent(peerIdentity.info.cid)}/files`);
const photoVersions = photoInventory.json.files.filter((file) => file.logical_name === 'photo.png');
t.eq(photoVersions.map((file) => file.version), [1, 2], 'dialog inventory exposes an exact ordered version history');
t.ok(photoVersions.every((file) => file.kind === 'photo' && file.sha256 && file.available),
  'outgoing photo inventory carries immutable hashes, provenance, and available bytes');

const voiceBytes = Buffer.from('OggS\u0000ours-voice-opus-fixture');
const voiceSent = await peer.sendFile({
  contact: who.json.cid,
  data_base64: voiceBytes.toString('base64'),
  filename: 'voice-message-2026-08-15T00-00-00.000Z.ogg',
  mime: 'audio/ogg;codecs=opus;x-ours-kind=voice-message',
});
const voiceInventory = await until('voice metadata to appear in the dialog inventory', async () => {
  const view = await api('GET', `/api/conversations/${encodeURIComponent(peerIdentity.info.cid)}/files`);
  return view.json.files.some((file) => file.wire_id === voiceSent.wireId) ? view : undefined;
});
const voiceMeta = voiceInventory.json.files.find((file) => file.wire_id === voiceSent.wireId);
t.eq(voiceMeta.kind, 'voice_message', 'exact MIME marker classifies the incoming OGG/Opus payload as voice');
t.eq(voiceMeta.available, false, 'incoming bytes are not consumed until the browser explicitly fetches them');
const fetchedVoice = await api('POST', '/api/files/fetch', { wire_ids: [voiceSent.wireId] });
t.eq(fetchedVoice.status, 200, 'explicit browser fetch retrieves voice bytes and transcription metadata');
const voiceResponse = await fetch(`${base}/api/media/${encodeURIComponent(voiceSent.wireId)}`);
t.eq(Buffer.from(await voiceResponse.arrayBuffer()), voiceBytes, 'voice playback/download route returns the exact received bytes');
t.eq(voiceResponse.headers.get('content-type'), 'audio/ogg', 'voice playback uses the real safe base MIME');
const storedVoice = (await api('GET', `/api/conversations/${encodeURIComponent(peerIdentity.info.cid)}/files`)).json.files
  .find((file) => file.wire_id === voiceSent.wireId);
t.ok(storedVoice.available && storedVoice.sha256?.length === 64, 'fetched voice is retained privately with a verified digest');

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
console.log(`\nrest-e2e OK (${t.count} checks) — REST/SSE, replies, media/version round-trips, and encrypted full-text Web Push`);
process.exit(0);
