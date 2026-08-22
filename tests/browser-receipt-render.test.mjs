// THE DELIVERED TICK MUST APPEAR WHILE THE PAGE STILL SAYS NOTHING.
//
// The defect this pins: the client learned about a delivered receipt on time and
// still never rendered it. Every caller of `converge` shared one generation slot
// per contact, so the convergence watching for the receipt was cancelled by the
// one the send itself starts — whose predicate is satisfied by its first poll.
// Nothing was left watching, and the tick waited for whatever unrelated refresh
// came next, usually the READ receipt.
//
// Measured before the fix, with the receipt held out of /page for four seconds:
// the event reached the browser at +329ms, the client issued its last request at
// +423ms, and the DOM never showed two ticks in a fourteen-second window.
//
// The stub holds `receipt: null` in every /page body for a fixed window while
// delivering the live event normally. That is the phone case — the receipt is
// real and the event is on time, but canonical state has not caught up on the
// link the client is polling over. On a fast local link the receipt lands before
// the send resolves and the whole defect hides, which is why this has to be
// forced rather than waited for.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const HOLD_MS = 8000;
const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the receipt render gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const streams = new Set();
let streamRevision = 0;
let sent = null;
let holdUntil = 0;

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
    streamRevision += 1;
    response.on('close', () => {
      streams.delete(response);
      streamRevision += 1;
    });
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
      sent = {
        dir: 'out', text: parsed.text, date: '2026-08-15T00:00:00.000Z',
        read: true, wire_id: 'WIRE-SENT', receipt: null,
      };
      json({ wire_id: 'WIRE-SENT', delivery: 'tracked' });
    });
    return;
  }
  if (url.pathname === '/api/conversations/PEER/page') {
    const messages = sent ? [{ ...sent, receipt: Date.now() < holdUntil ? null : sent.receipt }] : [];
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

// Do not race the event against EventSource startup. A fixed sleep happened to
// be enough on a developer machine, but a busy CI runner can render the
// composer before its SSE request reaches this fixture. The receipt event is
// intentionally live-only during the hold window, so emitting before a stream
// exists turns this into a startup-timing test instead of a receipt test.
const streamDeadline = Date.now() + 15_000;
let stableStream = false;
while (!stableStream && Date.now() < streamDeadline) {
  if (streams.size === 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    continue;
  }
  const observedRevision = streamRevision;
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  stableStream = streams.size > 0 && streamRevision === observedRevision;
}
assert.ok(stableStream, 'the browser settled on a live event stream before the receipt fixture emitted');

const ticks = () => page.$$eval('[data-receipt-status]', (nodes) => nodes.map((n) => n.getAttribute('data-receipt-status')));

// ---- send, then deliver the receipt while /page still says nothing ---------
await page.locator('.composer textarea').fill('does the tick arrive on time?');
await page.locator('.composer textarea').press('Enter');
await page.waitForFunction(() => document.querySelectorAll('[data-receipt-status]').length > 0, null, { timeout: 15_000 });

holdUntil = Date.now() + HOLD_MS;
sent.receipt = 'delivered';
emit('receipt_received', { contact_id: 'PEER', kind: 'delivered', wire_ids: ['WIRE-SENT'], date: '2026-08-15T00:00:01.000Z' });

// Five seconds is still inside the eight-second hold while allowing a heavily
// loaded Actions runner enough time to schedule Chromium. Before the fix this
// window elapsed with the client having stopped issuing requests entirely.
await page.waitForFunction(
  () => [...document.querySelectorAll('[data-receipt-status]')].some((node) => node.getAttribute('data-receipt-status') === 'delivered'),
  null,
  { timeout: 5000 },
).catch(() => {});
assert.ok((await ticks()).includes('delivered'),
  `the delivered tick appears from the event itself, while /page is still reporting no receipt (saw ${JSON.stringify(await ticks())})`);

// ---- and a page response that was already in flight must not undo it -------
// The hold is still active, so every /page response in this window carries
// receipt: null. The tick has to survive all of them.
await page.waitForTimeout(HOLD_MS);
assert.ok((await ticks()).includes('delivered'),
  `the tick SURVIVES a full window of honest, older page responses carrying no receipt (saw ${JSON.stringify(await ticks())})`);

// ---- ordering: delivered then read ends at read ----------------------------
sent.receipt = 'read';
emit('receipt_received', { contact_id: 'PEER', kind: 'read', wire_ids: ['WIRE-SENT'], date: '2026-08-15T00:00:06.000Z' });
await page.waitForFunction(
  () => [...document.querySelectorAll('[data-receipt-status]')].some((node) => node.getAttribute('data-receipt-status') === 'read'),
  null,
  { timeout: 5000 },
);
assert.ok((await ticks()).includes('read'), 'a read receipt after delivered moves the tick to read');

// ---- ordering: a late DELIVERED event must not walk read backwards ---------
emit('receipt_received', { contact_id: 'PEER', kind: 'delivered', wire_ids: ['WIRE-SENT'], date: '2026-08-15T00:00:07.000Z' });
await page.waitForTimeout(1200);
const finalTicks = await ticks();
assert.ok(finalTicks.includes('read') && !finalTicks.includes('delivered'),
  `A DELIVERED EVENT ARRIVING AFTER READ LEAVES IT READ (saw ${JSON.stringify(finalTicks)})`);

await browser.close();
server.close();
for (const stream of streams) stream.end();
console.log('browser-receipt-render OK — the tick arrives from the event, survives stale pages, and never walks backwards');
