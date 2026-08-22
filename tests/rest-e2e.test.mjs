// THE WHOLE SERVER, END TO END: its shared-daemon client, the REST surface, and a real
// signed WebPush request captured on the wire.
//
// It launches a daemon through the published CLI, boots src/server.ts against
// that shared process, exercises the routes a
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
import { counter, memSample, startHarnessDaemon, until } from './harness.mjs';

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

// ---- boot one CLI-owned daemon, provision identities, then attach messenger --
const daemon = await startHarnessDaemon('rest-e2e');
const ownStateDir = mkdtempSync(join(tmpdir(), 'messenger-e2e-app-state-'));
const publicOrigin = 'http://messenger.test';
const { OursClient } = daemon.sdk;
const provision = new OursClient({ url: daemon.url, leaseToken: 'provision' });
const human = await provision.createRootIdentity({
  name: 'Me', bio: 'messenger identity', exposeLocal: true,
  localAutoAccept: true, skipIfRootExists: false,
});
const peer = new OursClient({ url: daemon.url, leaseToken: 'peer-lease' });
const peerIdentity = await peer.createIdentity({
  name: 'Peer', bio: 'the other end', exposeLocal: true, localAutoAccept: true,
});
const invite = await provision.generateInvite({});
await peer.addContact({ invite: invite.blob });
await until('the contact link', async () => {
  const v = await peer.listContacts();
  return v.contacts.some((c) => c.name === 'Me') ? v : undefined;
});
await provision.releaseLease();

const { start } = await import('../src/server.ts');
const server = await start(
  {
    host: '127.0.0.1',
    port: 0,
    publicOrigin,
    identity: 'Me',
    force: false,
    stateDir: ownStateDir,
  },
  {
    name: '@ours.network/messenger-server', version: '0.1.0',
    sha: '3fb10cc41af69e1a15cb99eab1c1b408ec245de0', dirty: false,
  },
);

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
t.ok(shellHtml.includes('id="root"') && appAsset, 'and its same-origin content-hashed Vite entry');
const appResponse = await fetch(base + appAsset);
t.eq(appResponse.status, 200, 'GET the hashed Vite entry serves the built client bundle');
t.eq(appResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'hashed assets are immutable');
t.ok((await appResponse.text()).includes('/api/events'), 'whose live path is the same-origin SSE endpoint');
const clientRoute = await fetch(base + '/chats/peer');
t.ok((await clientRoute.text()).includes('id="root"'), 'non-API client routes fall back to the app shell');
const unknownApi = await api('GET', '/api/not-a-route');
t.eq(unknownApi.status, 404, 'unknown /api routes remain JSON 404s and never fall through to HTML');
const publicMcp = await fetch(base + '/mcp');
t.eq(publicMcp.status, 404, 'GET /mcp is 404 on the messenger surface');

// ---- identity, state, build info --------------------------------------------
const who = await api('GET', '/api/identity');
t.eq(who.status, 200, 'GET /api/identity responds 200');
t.eq(who.json.name, 'Me', 'and reports the bound identity — this is the old getProfileName');

const state = await api('GET', '/api/state');
t.eq(state.json.runtime.ownership, 'shared-daemon', '/api/state reports shared-daemon provenance');
t.ok(
  !JSON.stringify(state.json).includes(ownStateDir) &&
    state.json.runtime.port === undefined && state.json.runtime.brokerUrl === undefined,
  'and state paths, daemon endpoint, token, and broker are absent from the state response',
);

const build = await api('GET', '/api/build-info');
t.eq(build.json.name, '@ours.network/messenger-server', 'GET /api/build-info identifies the server');
t.eq(build.json.sha, '3fb10cc41af69e1a15cb99eab1c1b408ec245de0', 'and reports its build-time full commit');
const health = await api('GET', '/api/healthz');
t.eq(health.status, 200, 'GET /api/healthz proves the shared daemon lease is ready');
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
t.ok(typeof vapid.json.fingerprint === 'string' && vapid.json.configEpoch === 1,
     'the public key response identifies the current non-secret VAPID generation');

const rawPushMutation = async (path, body, headers = {}) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};
const crossOriginPush = await rawPushMutation('/api/push/subscriptions/ensure', {}, {
  origin: 'https://attacker.example', 'x-ours-messenger-csrf': '1',
});
t.eq(crossOriginPush.status, 403, 'cross-origin push mutation is rejected before body validation');
const missingCsrfPush = await rawPushMutation('/api/push/subscriptions/ensure', {}, { origin: publicOrigin });
t.eq(missingCsrfPush.status, 403, 'missing push CSRF intent is rejected');
const malformedPush = await api('POST', '/api/push/subscriptions/ensure', {
  endpoint: 'http://push.example/not-https', keys: { p256dh, auth },
});
t.eq(malformedPush.status, 400, 'malformed/non-HTTPS subscription capability is rejected');
t.ok(!JSON.stringify(malformedPush.json).includes('not-https'), 'invalid capability values are not reflected');
const oversizedPush = await rawPushMutation('/api/push/subscriptions/ensure', {
  endpoint: 'https://push.example/device', keys: { p256dh, auth }, label: 'x'.repeat(17_000),
}, { origin: publicOrigin, 'x-ours-messenger-csrf': '1' });
t.eq(oversizedPush.status, 413, 'push mutations have a small route-specific body cap');

const sub = await api('POST', '/api/push/subscriptions/ensure', {
  endpoint: `https://127.0.0.1:${pushPort}/push/device-1`,
  keys: { p256dh, auth },
  label: 'test device', preview: 'full',
});
t.eq(sub.status, 200, 'POST push ensure accepts and acknowledges a bounded subscription');
t.ok(typeof sub.json.binding_id === 'string' && sub.json.status === 'on', 'ack returns only an opaque binding id and On state');
t.ok(sub.json.keys === undefined, 'and does not echo the subscription keys back');
t.ok(sub.json.endpoint === undefined, 'and does not echo the push endpoint back');

// Idempotent on endpoint: a device re-subscribing must not double-push.
const ensuredAgain = await api('POST', '/api/push/subscriptions/ensure', {
  endpoint: `https://127.0.0.1:${pushPort}/push/device-1`, keys: { p256dh, auth }, preview: 'full',
});
t.eq(ensuredAgain.json.binding_id, sub.json.binding_id, 'same endpoint ensure preserves the opaque binding id');
t.eq((await api('GET', '/api/state')).json.pushSubscriptions, 1,
     're-subscribing the same endpoint replaces it rather than duplicating — one device, one push');

// ---- THE THING HE ASKED FOR: a message lands, THIS SERVER pushes ------------
const SECRET = 'sekrit-message-text-that-must-not-leak';
const inbound = await peer.sendMessage({ contact: 'Me', text: SECRET });
const sentId = inbound.wireId;
t.ok(typeof sentId === 'string' && sentId.length > 0, 'the peer send has a canonical wire id');

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

const beforeRead = await peer.getHistoryItem({ wire_id: sentId });
t.ok(beforeRead?.delivery_state !== 'read',
     'the peer has NO read receipt yet — the REST read path is non-consuming');

const marked = await api('POST', '/api/conversations/Peer/read');
t.eq(marked.json.marked, 1, 'POST …/read marks exactly the one unread entry');
await until('the read receipt to reach the peer', async () => {
  const row = await peer.getHistoryItem({ wire_id: sentId });
  return row?.delivery_state === 'read' ? row : undefined;
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
t.eq(typeof sent.json.wire_id, 'string', 'text send response exposes the canonical wire id to browser reconciliation');
await until('the reply to reach the peer', async () => {
  const v = await peer.listHistory({ peer_cid: human.info.cid, limit: 20 });
  return v.items.some((m) => m.direction === 'in' && m.text === 'reply from the server') ? v : undefined;
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
t.eq(photoVersions.length, 2, 'dialog inventory preserves both logical file versions');
t.eq(photoVersions.map((file) => file.version), [1, 2],
  'and exposes stable logical version ordinals independent of daemon sequence');
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
t.eq(voiceMeta.available, false, 'incoming bytes stay unavailable to the browser until explicit fetch');
const fetchedVoice = await api('POST', '/api/files/fetch', { wire_ids: [voiceSent.wireId] });
t.eq(fetchedVoice.status, 200, 'explicit browser fetch retrieves voice bytes and transcription metadata');
const voiceResponse = await fetch(`${base}/api/media/${encodeURIComponent(voiceSent.wireId)}`);
t.eq(Buffer.from(await voiceResponse.arrayBuffer()), voiceBytes, 'voice playback/download route returns the exact received bytes');
t.eq(voiceResponse.headers.get('content-type'), 'audio/ogg', 'voice playback uses the real safe base MIME');
const storedVoice = (await api('GET', `/api/conversations/${encodeURIComponent(peerIdentity.info.cid)}/files`)).json.files
  .find((file) => file.wire_id === voiceSent.wireId);
t.ok(storedVoice.available && storedVoice.sha256?.length === 64, 'fetched voice is retained privately with a verified digest');

const hostileSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/pwned")</script></svg>');
const hostileSent = await peer.sendFile({
  contact: who.json.cid,
  data_base64: hostileSvg.toString('base64'),
  filename: 'hostile.svg',
  mime: 'image/svg+xml',
});
await until('hostile media metadata to appear', async () => {
  const view = await api('GET', `/api/conversations/${encodeURIComponent(peerIdentity.info.cid)}/files`);
  return view.json.files.some((file) => file.wire_id === hostileSent.wireId) ? view : undefined;
});
await api('POST', '/api/files/fetch', { wire_ids: [hostileSent.wireId] });
const hostileResponse = await fetch(`${base}/api/media/${encodeURIComponent(hostileSent.wireId)}`);
t.eq(Buffer.from(await hostileResponse.arrayBuffer()), hostileSvg, 'hostile media bytes remain available for explicit download');
t.eq(hostileResponse.headers.get('content-type'), 'application/octet-stream', 'active media is never served as an executable same-origin MIME');
t.ok(hostileResponse.headers.get('content-disposition')?.startsWith('attachment;'), 'active media forces download even on top-level navigation');
t.eq(hostileResponse.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'media responses deny scripts and same-origin capability in depth');
t.eq(hostileResponse.headers.get('x-content-type-options'), 'nosniff', 'browser MIME sniffing is disabled');

const bad = await api('POST', '/api/messages/send', { contact: 'Peer' });
t.eq(bad.status, 400, 'a missing field is a 400');
t.ok(bad.json.error.message.includes('text'), 'naming the field that was missing');

const engineErr = await api('POST', '/api/messages/send', { contact: 'NoSuchContact', text: 'x' });
t.eq(engineErr.status, 400, 'an engine error is a 400');
t.ok(typeof engineErr.json.error.code === 'string' && engineErr.json.error.code.length > 0,
     `and returns a fixed public code (${engineErr.json.error.code}) rather than raw engine text`);

const badCursor = await api('GET', '/api/conversations/Peer/page?before=NOPE');
t.eq(badCursor.status, 400, 'an unresolvable page cursor is a 400, not a silent reset to the newest page');

let rateLimited = false;
for (let attempt = 0; attempt < 35; attempt++) {
  const response = await api('POST', '/api/push/subscriptions/delete', { binding_id: `unknown-${attempt}` });
  if (response.status === 429) { rateLimited = true; break; }
}
t.ok(rateLimited, 'push subscription mutations enforce a bounded per-client rate');

await server.close();
await peer.releaseLease();
await daemon.close();
await new Promise((r) => pushService.close(r));
rmSync(ownStateDir, { recursive: true, force: true });
rmSync(certDir, { recursive: true, force: true });
memSample('after');
console.log(`\nrest-e2e OK (${t.count} checks) — REST/SSE, replies, media/version round-trips, and encrypted full-text Web Push`);
process.exit(0);
