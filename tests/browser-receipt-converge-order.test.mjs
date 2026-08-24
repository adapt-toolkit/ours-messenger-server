// A SEND'S CONVERGENCE MUST NOT ORPHAN A RECEIPT'S.
//
// This is the ordering the defect actually needed, and the one the render gate
// cannot reach. `converge` used to key its generation slot on the contact alone,
// so every caller shared one slot and the last one to start silently cancelled
// the rest. The order that hurts is:
//
//   1. the delivered receipt arrives over SSE and starts a convergence watching
//      for it;
//   2. the send's own POST resolves a moment LATER and starts its convergence,
//      taking the slot;
//   3. the send's predicate — "my message is in the page" — is satisfied by its
//      very first poll, so it stops immediately;
//   4. nothing is left watching for the receipt.
//
// On a fast link the receipt lands AFTER the send resolves, the send's
// convergence starts first, and the ordering is harmless. The render gate emits
// the receipt after the send has settled and therefore exercises that harmless
// order; this test forces the harmful one by HOLDING the send response until the
// receipt event has been delivered.
//
// What is asserted is the WATCHER, not the tick: /page GETs must keep arriving
// on the receipt convergence's schedule after the send's convergence has been
// satisfied and stopped.
//
// The tick is then checked as the consequence: the receipt is released into
// /page LATE, after the send's convergence has long since stopped, and with no
// further event. Only a watcher that is still alive can render it: the receipt
// event may arrive on time while canonical state catches up seconds later.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

// The convergence delays are 0/100/400/1000/3000/6000ms and they are sequential,
// so the polls themselves land at roughly 0/100/500/1500/4500/10500ms from that
// convergence's own start. The windows below are placed against that.
const RECEIPT_TO_SEND_MS = 200;     // how long the send is held after the event
const QUIET_AFTER_MS = 900;         // past here, only the receipt's watcher polls
const RELEASE_PAGE_AFTER_MS = 3200; // canonical state catches up, late
const WATCH_MS = 8000;              // covers the poll after that catch-up

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the convergence ordering gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const streams = new Set();
const pageGets = [];
let sent = null;
let heldReceipt = true;
let sendArrived = null;
let releaseSend = null;
const sendHeld = new Promise((resolveHold) => { releaseSend = resolveHold; });
const sendSeen = new Promise((resolveSeen) => { sendArrived = resolveSeen; });

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const json = (body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n');
    streams.add(response);
    response.on('close', () => streams.delete(response));
    return;
  }
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
  if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
  if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
  if (url.pathname === '/api/messages/send') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      // The canonical row exists as soon as the send is accepted, so the send's
      // own convergence is satisfied by its first poll — exactly as in
      // production, and the reason it stops and takes the slot with it.
      sent = {
        dir: 'out', text: parsed.text, date: '2026-08-15T00:00:00.000Z',
        read: true, wire_id: 'WIRE-SENT', receipt: null,
      };
      sendArrived();
      // HELD: the client does not learn its wire id, and cannot start the send's
      // convergence, until the receipt event has already started one.
      void sendHeld.then(() => json({ wire_id: 'WIRE-SENT', delivery: 'tracked' }));
    });
    return;
  }
  if (url.pathname === '/api/conversations/PEER/page') {
    pageGets.push(Date.now());
    // While held, every response is honest and out of date: the receipt is real,
    // canonical state has not caught up on the link the client polls over. The
    // receipt's convergence therefore cannot satisfy its predicate and must keep
    // to its schedule — if it is still alive to keep it.
    const messages = sent ? [{ ...sent, receipt: heldReceipt ? null : 'delivered' }] : [];
    return json({ contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

const emit = (event, data) => {
  for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify({ v: 1, ...data })}\n\n`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => { throw error; });
await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
await page.locator('.composer textarea').waitFor({ timeout: 20_000 });
await page.waitForTimeout(600);

const ticks = () => page.$$eval('[data-receipt-status]', (nodes) => nodes.map((n) => n.getAttribute('data-receipt-status')));

// ---- send, and hold it open ------------------------------------------------
await page.locator('.composer textarea').fill('which convergence survives?');
await page.locator('.composer textarea').press('Enter');
await sendSeen;

// ---- the receipt arrives FIRST, while the send is still in flight ----------
emit('receipt_received', { contact_id: 'PEER', kind: 'delivered', wire_ids: ['WIRE-SENT'], date: '2026-08-15T00:00:01.000Z' });
await page.waitForTimeout(RECEIPT_TO_SEND_MS);

// ---- now let the send resolve, so its convergence starts second ------------
releaseSend();
const released = Date.now();

// ---- canonical state catches up, late, with no further event ---------------
await page.waitForTimeout(RELEASE_PAGE_AFTER_MS);
const relative = () => pageGets.map((at) => at - released);
const beforeCatchUp = relative();
heldReceipt = false;
await page.waitForTimeout(WATCH_MS - RELEASE_PAGE_AFTER_MS);

const timeline = relative();
const late = timeline.filter((at) => at > QUIET_AFTER_MS);
assert.ok(
  late.length >= 2,
  'THE SEND\'S CONVERGENCE ORPHANED THE RECEIPT\'S: once the send resolved, its own convergence was satisfied '
  + 'by its first poll and stopped, and the receipt\'s watcher stopped with it. Expected the receipt schedule to '
  + `keep firing (>=2 /page GETs more than ${QUIET_AFTER_MS}ms after the send resolved), saw ${late.length}. `
  + `/page GETs, ms relative to the send resolving: ${JSON.stringify(timeline)}`,
);
assert.ok(
  beforeCatchUp.some((at) => at > QUIET_AFTER_MS),
  'the watcher is still polling while canonical state is behind, not only once it has caught up '
  + `(GETs before the catch-up: ${JSON.stringify(beforeCatchUp)})`,
);

// ---- and the tick lands, from a poll no other caller was left to make ------
assert.ok(
  (await ticks()).includes('delivered'),
  'THE TICK NEVER ARRIVED: the receipt reached canonical state seconds after the send settled, and nothing was '
  + `still asking for it (saw ${JSON.stringify(await ticks())}, /page GETs at ${JSON.stringify(timeline)}ms)`,
);

await browser.close();
server.close();
for (const stream of streams) stream.end();
console.log(`browser-receipt-converge-order OK — the receipt's watcher outlives the send's (/page GETs at ${JSON.stringify(timeline)}ms)`);
