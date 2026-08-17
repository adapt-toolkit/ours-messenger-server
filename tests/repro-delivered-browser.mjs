// REPRODUCTION ONLY — the owner's exact flow, in a real browser, against the
// real server: type a message, send it, let the peer mark it read a couple of
// seconds later, and record what the SENDER'S DOM shows the whole time.
//
// The tick element carries data-receipt-status ("sent" | "delivered" | "read"),
// so the client state machine and the rendering are both observable here.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { until, memSample, freePort } from './harness.mjs';

const READ_DELAY_MS = Number(process.env.REPRO_READ_DELAY_MS ?? 3000);
const WATCH_MS = Number(process.env.REPRO_WATCH_MS ?? 12000);

memSample('before');
const ownStateDir = mkdtempSync(join(tmpdir(), 'repro-browser-state-'));
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
const link = await until('the contact link', async () => {
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
page.on('console', (msg) => record('CONSOLE', `${msg.type()}: ${msg.text().slice(0, 200)}`));
page.on('pageerror', (err) => record('PAGEERR', String(err).slice(0, 300)));
page.on('response', (res) => {
  if (res.url().includes('/api/') && !res.url().includes('/api/events')) {
    record('HTTP', `${res.status()} ${res.request().method()} ${res.url().replace(base, '')}`);
  }
});

await page.goto(`${base}/chats/${encodeURIComponent(peerCid)}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.composer textarea, textarea', { timeout: 30_000 });
await page.waitForTimeout(1500);

t0 = Date.now();
const composer = page.locator('textarea').first();
await composer.fill('repro: watching the ticks');
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
  const banner = await page.$$eval('.banner.error', (nodes) => nodes.map((n) => n.textContent?.slice(0, 120)));
  const snapshot = JSON.stringify(states) + (banner.length ? ` err=${JSON.stringify(banner)}` : '');
  if (snapshot !== last) { record('DOM', `data-receipt-status = ${snapshot}`); last = snapshot; }
  await page.waitForTimeout(100);
}

console.log('\n--- SENDER DOM TIMELINE (ms from Enter) ---');
for (const row of timeline) console.log(`${String(row.ms).padStart(6)}  ${row.layer.padEnd(9)} ${row.what}`);
const sawDelivered = timeline.some((r) => r.layer === 'DOM' && /"delivered"/.test(r.what));
console.log(`\nSENDER EVER SHOWED "delivered": ${sawDelivered}`);

await browser.close();
await server.close?.();
rmSync(ownStateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
