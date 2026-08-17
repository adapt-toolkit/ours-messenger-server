// The conversation timeline must never move under the reader. This gate drives
// the real bundle in a real browser and samples the scroller every frame, so a
// send or an arrival that jumps the viewport fails here instead of on a phone.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the scroll stability gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const history = Array.from({ length: 40 }, (_, index) => ({
  dir: index % 2 === 0 ? 'in' : 'out',
  text: `history line ${index} — long enough to occupy a full bubble row in a narrow viewport`,
  date: new Date(Date.UTC(2026, 7, 15, 0, index)).toISOString(),
  read: true,
  wire_id: `WIRE-${index}`,
  receipt: null,
}));

try {
  const conversationMessages = [...history];
  let sendDelayMs = 120;
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      return json({
        contact: 'PEER',
        messages: conversationMessages,
        total: conversationMessages.length, unread: 0, hasMore: false, nextBefore: null,
      });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (url.pathname === '/api/messages/send') {
      const body = request.postDataJSON();
      await new Promise((resolveWait) => setTimeout(resolveWait, sendDelayMs));
      const wireId = `SENT-${conversationMessages.length}`;
      conversationMessages.push({
        // Newest, as a real send is: the confirmation must land where its own
        // optimistic bubble already sits, not somewhere up the thread.
        dir: 'out', text: body.text, date: new Date(Date.UTC(2026, 7, 15, 9, conversationMessages.length)).toISOString(),
        read: true, wire_id: wireId, receipt: null,
        ...(body.reply_to_wire_id ? { reply_to: { wire_id: body.reply_to_wire_id } } : {}),
      });
      return json({ wire_id: wireId });
    }
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('.composer textarea');
  await composer.waitFor();
  await page.locator('#chat-message-WIRE-39').waitFor();

  // A frame-by-frame trace of the scroller. `text` counts how many bubbles
  // currently render the probe text, so a duplicated optimistic bubble is
  // visible in the trace even when it lives for a single frame.
  await page.evaluate(() => {
    globalThis.__scrollTrace = [];
    globalThis.__probeText = '';
    const sample = () => {
      const el = document.querySelector('.messages');
      if (el) {
        const text = globalThis.__probeText;
        globalThis.__scrollTrace.push({
          top: el.scrollTop,
          height: el.scrollHeight,
          client: el.clientHeight,
          text: text ? [...document.querySelectorAll('.messages .ours-message')].filter((node) => node.textContent?.includes(text)).length : 0,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const startTrace = async (probeText = '') => page.evaluate((text) => {
    globalThis.__probeText = text;
    globalThis.__scrollTrace = [];
  }, probeText);
  const readTrace = async () => page.evaluate(() => globalThis.__scrollTrace);

  // --- 1. A message arriving while the reader is scrolled up ---------------
  await page.evaluate(() => {
    const el = document.querySelector('.messages');
    el.scrollTop = Math.round(el.scrollHeight / 2);
  });
  await page.waitForTimeout(120);
  const anchoredTop = await page.evaluate(() => document.querySelector('.messages').scrollTop);
  await startTrace('arriving while reading history');
  conversationMessages.push({
    dir: 'in', text: 'arriving while reading history', date: '2026-08-15T02:00:00.000Z',
    read: false, wire_id: 'WIRE-IN-1', receipt: null,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ours-messenger-live-event', {
    detail: { v: 1, type: 'message_received', contact_id: 'PEER', wire_id: 'WIRE-IN-1' },
  })));
  await page.locator('#chat-message-WIRE-IN-1').waitFor();
  await page.waitForTimeout(900);
  const arrivalTrace = await readTrace();
  const arrivalDrift = Math.max(...arrivalTrace.map((s) => Math.abs(s.top - anchoredTop)));
  assert.ok(arrivalDrift <= 2,
    `an arriving message must not move a reader who is scrolled up (drift ${arrivalDrift}px from ${anchoredTop})`);

  // --- 2. Sending while pinned to the newest message ------------------------
  await page.evaluate(() => {
    const el = document.querySelector('.messages');
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
  await startTrace('probe send stability');
  await composer.fill('probe send stability');
  await page.locator('.composer').getByRole('button', { name: 'Send' }).tap();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
  await page.waitForTimeout(1200);
  const sendTrace = await readTrace();

  // The submitted text must never be on screen twice: an optimistic bubble and
  // its own server confirmation rendering together is the visible "double
  // message" flash, and the collapse that follows is the jump.
  const duplicateFrames = sendTrace.filter((sample) => sample.text > 1).length;
  assert.equal(duplicateFrames, 0,
    `the optimistic bubble and its confirmation must never render together (${duplicateFrames} frames showed the text twice)`);

  // Content that grows and then shrinks is a bubble being removed after it was
  // laid out — the list visibly collapses under whatever is below it.
  const peakHeight = Math.max(...sendTrace.map((sample) => sample.height));
  const settledHeight = sendTrace.at(-1).height;
  assert.ok(peakHeight - settledHeight <= 2,
    `sending must not grow the timeline and then collapse it (peak ${peakHeight}px vs settled ${settledHeight}px)`);

  // Following the newest message may take several frames, but it only ever
  // moves one way. A frame that scrolls backwards is the viewport bouncing.
  const backwards = sendTrace.filter((sample, index) => index > 0 && sample.top < sendTrace[index - 1].top - 1);
  assert.equal(backwards.length, 0,
    `following a sent message must not scroll backwards (${backwards.length} frames reversed)`);

  // And it must arrive: a pinned reader ends at the newest message.
  const settled = sendTrace.at(-1);
  assert.ok(settled.height - settled.client - settled.top <= 4,
    `a pinned reader must end at the newest message (${settled.height - settled.client - settled.top}px short)`);

  await context.close();
  console.log('browser-scroll-stability OK — arrivals hold the reader, sends neither duplicate nor collapse the timeline');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
