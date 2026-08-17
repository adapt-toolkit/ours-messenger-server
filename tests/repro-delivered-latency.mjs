// REPRODUCTION — the owner's symptom, with the one thing loopback cannot supply:
// REQUEST LATENCY THAT VARIES. On this box every /page GET returns in <10ms, so
// concurrent refreshes can never land out of order and the bug is invisible. On a
// phone they do.
//
// Everything under test is real: the real server, the real SDK, the real SSE
// stream, the real receipts. The ONLY thing injected is per-request latency on
// the sender's own GET /page calls — the client's link to its server, exactly the
// link that is slow on a phone. The first refresh after send is held back; later
// ones are fast. Both carry honest server responses.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { until, memSample, freePort } from './harness.mjs';

const READ_DELAY_MS = Number(process.env.REPRO_READ_DELAY_MS ?? 5000);
const WATCH_MS = Number(process.env.REPRO_WATCH_MS ?? 14000);
const SLOW_MS = Number(process.env.REPRO_SLOW_MS ?? 3000);
const FAST_MS = Number(process.env.REPRO_FAST_MS ?? 150);

memSample('before');
const ownStateDir = mkdtempSync(join(tmpdir(), 'repro-latency-state-'));
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
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const timeline = [];
let t0 = Date.now();
const record = (layer, what) => {
  const ms = Date.now() - t0;
  timeline.push({ ms, layer, what });
  console.log(`${String(ms).padStart(6)}  ${layer.padEnd(9)} ${what}`);
};

// Latency injection: only the sender's conversation-page GETs, only after send.
let armed = false;
let seq = 0;
let stalled = false;
await page.route('**/page?*', async (route) => {
  if (!armed) return route.continue();
  const n = ++seq;
  const issued = Date.now() - t0;
  const response = await route.fetch();
  const body = await response.text();
  const receipt = JSON.parse(body).messages.at(-1)?.receipt ?? null;
  // Stall exactly one honest pre-delivered response: the phone-network case where
  // an early refresh is still in flight when a later one has already answered.
  const stall = receipt === null && !stalled;
  if (stall) stalled = true;
  const delay = stall ? SLOW_MS : FAST_MS;
  await new Promise((r) => setTimeout(r, delay));
  record('NET', `page GET #${n} issued+${issued}ms body.receipt=${JSON.stringify(receipt)} held ${delay}ms`);
  await route.fulfill({ response, body });
});

await page.goto(`${base}/chats/${encodeURIComponent(peerCid)}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('textarea', { timeout: 30_000 });
await page.waitForTimeout(1500);

t0 = Date.now();
armed = true;
const composer = page.locator('textarea').first();
await composer.fill('repro: does delivered survive a slow refresh?');
await composer.press('Enter');
record('UI', 'pressed Enter');

setTimeout(() => {
  void peer.markRead({ contact: 'Me' }).then(
    (r) => record('PEER', `markRead marked=${r.marked}`),
    (e) => record('PEER', `markRead failed: ${String(e)}`),
  );
}, READ_DELAY_MS);

let last = null;
const deadline = Date.now() + WATCH_MS;
while (Date.now() < deadline) {
  const states = await page.$$eval('[data-receipt-status]', (nodes) =>
    nodes.map((n) => n.getAttribute('data-receipt-status')));
  const snapshot = JSON.stringify(states);
  if (snapshot !== last) { record('DOM', `ticks = ${snapshot}`); last = snapshot; }
  await page.waitForTimeout(50);
}

console.log('\n--- SENDER DOM TIMELINE (ms from Enter) ---');
for (const row of timeline) console.log(`${String(row.ms).padStart(6)}  ${row.layer.padEnd(9)} ${row.what}`);
const dom = timeline.filter((r) => r.layer === 'DOM').map((r) => r.what);
console.log('\nDOM sequence:', dom.join('  ->  '));

await browser.close();
await server.close?.();
rmSync(ownStateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
