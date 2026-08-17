// The voice duration, END TO END, through the app's ACTUAL record path.
//
// A correction to the first diagnosis matters here: web/src/voice.ts is NOT the
// recorder the UI uses. The live one is VoiceRecorder in web/src/ui/FileBubbles.tsx,
// and it differs in exactly the two ways that decide this bug — it calls
// `rec.start()` with NO timeslice, and it builds `new Blob(chunks)` with no type.
//
// So this records the way the app does, sends it through the real server's
// send-file route, and then reads it back through the real media URL with an
// <audio> element, which is what VoiceBubble does. Every step is the real one:
// if the duration survives to the receiver, the zero is not on this platform.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { freePort, memSample, until } from './harness.mjs';

const RECORD_MS = Number(process.env.REPRO_RECORD_MS ?? 3000);

memSample('before');
const stateDir = mkdtempSync(join(tmpdir(), 'repro-voice-e2e-'));
const webPort = await freePort();
const publicOrigin = `http://127.0.0.1:${webPort}`;
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
  host: '127.0.0.1', port: webPort, publicOrigin, identity: 'Me', force: false,
  stateDir, keepHistory: true, runtime: { brokerUrl: 'wss://invalid.local/none' },
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
const peerCid = (await server.runtime.client.listContacts()).contacts.find((c) => c.name === 'Peer').container_id;

const base = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded' });

const sent = await page.evaluate(async ({ recordMs, contact, origin }) => {
  // VOICE_CONTAINER_CANDIDATES, verbatim from web/src/ui/voiceRecordingCore.mjs.
  const CANDIDATES = [
    { rec: 'audio/webm;codecs=opus', base: 'audio/webm', ext: 'webm' },
    { rec: 'audio/ogg;codecs=opus', base: 'audio/ogg', ext: 'ogg' },
    { rec: 'audio/webm', base: 'audio/webm', ext: 'webm' },
    { rec: 'audio/mp4', base: 'audio/mp4', ext: 'm4a' },
  ];
  const pick = CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.rec));

  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();

  const rec = new MediaRecorder(dest.stream, { mimeType: pick.rec, audioBitsPerSecond: 48000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  // THE APP'S CALL: no timeslice.
  rec.start();
  await new Promise((r) => setTimeout(r, recordMs));
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.stop();
  await stopped;
  osc.stop();
  await ctx.close();

  // THE APP'S BLOB: no type.
  const blob = new Blob(chunks);
  const localUrl = URL.createObjectURL(blob);
  const localDuration = await new Promise((resolve) => {
    const a = new Audio();
    const done = (v) => resolve(String(v));
    a.addEventListener('loadedmetadata', () => done(a.duration), { once: true });
    a.addEventListener('error', () => done('error'), { once: true });
    setTimeout(() => done('timeout'), 4000);
    a.src = localUrl;
  });
  URL.revokeObjectURL(localUrl);

  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const mime = `${pick.base}; x-ours-kind=voice-message`;

  const response = await fetch('/api/messages/send-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-ours-messenger-csrf': '1' },
    body: JSON.stringify({
      contact,
      filename: `voice-message-${stamp}.${pick.ext}`,
      mime,
      data_base64: btoa(binary),
    }),
  });
  return {
    recorderMime: pick.rec, sentMime: mime, bytes: buf.length,
    localDuration,
    sendStatus: response.status,
    sendBody: (await response.text()).slice(0, 200),
  };
}, { recordMs: RECORD_MS, contact: peerCid, origin: publicOrigin });

console.log('\n--- sender side ---');
console.log(JSON.stringify(sent, null, 2));

// ---- read it back the way the RECEIVING bubble does -------------------------
const files = await until('the file to appear in the conversation', async () => {
  const res = await fetch(`${base}/api/conversations/${encodeURIComponent(peerCid)}/files`);
  const body = await res.json();
  return body.files?.length ? body.files : undefined;
});
const record = files[0];
console.log('\n--- as stored ---');
console.log(JSON.stringify({ wire_id: record.wire_id, filename: record.filename, mime: record.mime, size: record.size }, null, 2));

const head = await fetch(`${base}/api/media/${encodeURIComponent(record.wire_id)}`, { method: 'GET' });
console.log('\n--- as served ---');
console.log(`status=${head.status} content-type=${head.headers.get('content-type')} disposition=${head.headers.get('content-disposition')}`);

const playback = await page.evaluate(async (wireId) => {
  const url = `/api/media/${encodeURIComponent(wireId)}`;
  const read = () => new Promise((resolve) => {
    const a = new Audio();
    const done = (stage, v) => resolve({ stage, value: String(v) });
    a.addEventListener('loadedmetadata', () => done('loadedmetadata', a.duration), { once: true });
    a.addEventListener('error', () => done('error', a.error?.code ?? 'unknown'), { once: true });
    setTimeout(() => done('timeout', a.duration), 5000);
    a.preload = 'metadata';
    a.src = url;
  });
  return read();
}, record.wire_id);

console.log('\n--- receiver-side <audio> against the real media URL ---');
console.log(JSON.stringify(playback, null, 2));
const d = Number(playback.value);
console.log(`\nVoiceBubble would render: ${Number.isFinite(d) && d > 0 ? `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}` : "'·:··'"}`);

await browser.close();
await server.close?.();
rmSync(stateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
