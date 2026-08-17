// THE FILE MESSAGE FRAME, MEASURED RATHER THAN LOOKED AT.
//
// On desktop the frame around a file message was wider than the card inside it,
// so the Download action — which sits at the end of the card — landed short of
// the frame's right edge and read as floating near the middle.
//
// This drives the REAL app against the REAL built bundle at a desktop viewport
// and measures boxes: the bubble, the card inside it, and the download control.
// The assertion is geometric because the defect is geometric; a DOM-shape test
// would have passed throughout.
//
// It runs at several filename lengths, including one long enough to need
// truncation, and at a narrow width, because the two plausible causes — a
// min-width holding the card open and a flex child that does not fill its
// parent — come apart precisely at the extremes.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the file-bubble layout gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n');
    return;
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
const browser = await chromium.launch({ headless: true });

const CASES = [
  { label: 'short name', filename: 'a.pdf' },
  { label: 'ordinary name', filename: 'quarterly-report.pdf' },
  { label: 'long name that must truncate', filename: 'a-very-long-attachment-filename-that-will-not-fit-in-the-card-at-all.pdf' },
];

const measure = async (filename, viewport) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/events') return route.fallback();
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      return json({
        contact: 'PEER',
        messages: [{ dir: 'out', text: '', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'WIRE-FILE', receipt: 'read' }],
        total: 1, unread: 0, hasMore: false, nextBefore: null,
      });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') {
      return json({
        contact: 'PEER',
        files: [{
          wire_id: 'WIRE-FILE', contact_id: 'PEER', dir: 'out', filename,
          mime: 'application/pdf', size: 20480, date: '2026-08-15T00:00:00.000Z', available: true,
        }],
      });
    }
    return json({}, 404);
  });
  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await page.locator('.filecard').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(250);

  const boxes = await page.evaluate(() => {
    const card = document.querySelector('.filecard');
    const bubble = card.closest('.filecard-bubble');
    const action = card.querySelector('a[download]');
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    const style = getComputedStyle(bubble);
    return {
      bubble: box(bubble),
      card: box(card),
      action: box(action),
      bubblePaddingRight: parseFloat(style.paddingRight),
      cardMinWidth: getComputedStyle(card).minWidth,
    };
  });
  await context.close();
  return boxes;
};

const DESKTOP = { width: 1280, height: 900 };
const NARROW = { width: 380, height: 720 };

const report = [];
for (const { label, filename } of CASES) {
  for (const [viewportLabel, viewport] of [['desktop', DESKTOP], ['narrow', NARROW]]) {
    const boxes = await measure(filename, viewport);
    // The card must fill the frame it is drawn in. Anything less is the reported
    // bug: the frame is sized by something the card does not stretch to.
    const slack = boxes.bubble.right - boxes.bubblePaddingRight - boxes.card.right;
    report.push({ label, viewportLabel, slack: Number(slack.toFixed(1)), card: boxes.card.width, bubble: boxes.bubble.width });
    // Both directions are the bug. Positive slack is a frame wider than its card,
    // which is how the owner described it; negative slack is a card wider than its
    // frame, which is what the measurement actually found. Either way the two
    // disagree and the action does not sit where the frame's edge says it should.
    assert.ok(Math.abs(slack) <= 1,
      `${label} @ ${viewportLabel}: the card must fill the frame's content box, ` +
      `but it ${slack > 0 ? 'stops' : 'overruns by'} ${Math.abs(slack).toFixed(1)}px ` +
      `(card ${boxes.card.width.toFixed(1)}px inside a ${boxes.bubble.width.toFixed(1)}px frame)`);

    // And the action pins to that edge, which is what the reader actually sees.
    const actionGap = boxes.bubble.right - boxes.bubblePaddingRight - boxes.action.right;
    assert.ok(Math.abs(actionGap) <= 1.5,
      `${label} @ ${viewportLabel}: the Download action sits ${actionGap.toFixed(1)}px from the frame's right edge — it must pin right, not float mid-frame`);

    // The frame must not be wider than its viewport allows, i.e. the min-width
    // must never win over the available space on a narrow screen.
    assert.ok(boxes.bubble.width <= viewport.width,
      `${label} @ ${viewportLabel}: the frame (${boxes.bubble.width.toFixed(1)}px) fits the ${viewport.width}px viewport`);
  }
}

console.table?.(report);
await browser.close();
server.close();
console.log('browser-file-bubble-layout OK — the card fills its frame and the action pins right at every name length and width');
