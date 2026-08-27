import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const webRoot = join(repo, 'dist/web');
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the unread-positioning gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n'); streams.add(response); response.on('close', () => streams.delete(response)); return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address(); assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const row = (index, read) => ({ dir: 'in', text: `message ${index} ${'content '.repeat(8)}`, date: new Date(Date.UTC(2026, 7, 26, 8, index)).toISOString(), read, wire_id: `W${index}`, receipt: null });
const newestUnread = Array.from({ length: 50 }, (_, index) => row(index + 10, false));
const older = [...Array.from({ length: 5 }, (_, index) => row(index, true)), ...Array.from({ length: 5 }, (_, index) => row(index + 5, false)), row(10, false)];

const install = async (context, { failOlder = false, delayFirstOlder = false, noUnread = false, multiPage = false, noProgress = false } = {}) => {
  let marked = false; let pageRequests = 0; let olderRequests = 0; const arrivals = [];
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      pageRequests += 1;
      if (url.searchParams.get('before')) {
        olderRequests += 1;
        if (delayFirstOlder && olderRequests === 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
        if (failOlder) return json({ error: { message: 'older failed' } }, 500);
        if (noProgress) return json({ contact: 'PEER', messages: newestUnread, total: 60, unread: 55, hasMore: true, nextBefore: 'OLDER-1' });
        if (multiPage && url.searchParams.get('before') === 'OLDER-1') return json({ contact: 'PEER', messages: [...Array.from({ length: 50 }, (_, index) => row(index + 10, false)), row(60, false)], total: 110, unread: 105, hasMore: true, nextBefore: 'OLDER-2' });
        if (multiPage) return json({ contact: 'PEER', messages: [...Array.from({ length: 5 }, (_, index) => row(index, true)), ...Array.from({ length: 6 }, (_, index) => row(index + 5, false))], total: 110, unread: 105, hasMore: false, nextBefore: null });
        return json({ contact: 'PEER', messages: older, total: 60, unread: 55, hasMore: false, nextBefore: null });
      }
      if (multiPage) return json({ contact: 'PEER', messages: Array.from({ length: 50 }, (_, index) => row(index + 60, false)), total: 110, unread: 105, hasMore: true, nextBefore: 'OLDER-1' });
      const base = marked || noUnread ? newestUnread.map((message) => ({ ...message, read: true })) : newestUnread;
      return json({ contact: 'PEER', messages: [...base, ...arrivals], total: (noUnread ? 50 : 60) + arrivals.length, unread: noUnread ? arrivals.length : marked ? arrivals.length : 55 + arrivals.length, hasMore: !noUnread, nextBefore: noUnread ? null : 'OLDER-1' });
    }
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (url.pathname === '/api/conversations/PEER/read') { marked = true; return json({ contact: 'PEER', marked: 55 }); }
    if (url.pathname === '/api/invites') return json([]);
    if (url.pathname === '/api/events') return route.fallback();
    return json({}, 404);
  });
  return {
    counts: () => ({ pageRequests, olderRequests }),
    arrive: () => {
      arrivals.push(row(60, false));
    },
  };
};

try {
  const context = await browser.newContext({ viewport: { width: 900, height: 720 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__unreadScrollBehaviors = [];
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function patchedScrollTo(options, y) {
      if (typeof options === 'object') window.__unreadScrollBehaviors.push(options.behavior ?? 'auto');
      return scrollTo.call(this, options, y);
    };
  });
  const fixture = await install(context);
  const page = await context.newPage();
  await page.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Peer/ }).click();
  const divider = page.locator('.unread-divider'); await divider.waitFor();
  assert.equal(await divider.count(), 1, 'exactly one unread divider renders');
  assert.equal(await page.locator('#chat-message-W10').count(), 1, 'wire ids stay deduplicated across paginated pages');
  assert.equal(await divider.evaluate((node) => node.parentElement?.id), 'chat-message-W5', 'divider is frozen at the exact first unread wire id');
  assert.ok((await divider.boundingBox()).y > (await page.locator('.detail-head').boundingBox()).y, 'divider is below fixed conversation chrome');
  await page.waitForFunction(() => document.querySelector('.contact-unread') === null);
  assert.equal(await divider.evaluate((node) => node.parentElement?.id), 'chat-message-W5', 'mark-read reconciliation does not move the frozen divider');
  assert.equal(fixture.counts().olderRequests, 1, 'pagination stops as soon as the exact boundary is loaded');
  fixture.arrive();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ours-messenger-live-event', {
    detail: { v: 1, type: 'message_received', contact_id: 'PEER', wire_id: 'W60' },
  })));
  const jump = page.getByRole('button', { name: /Jump to latest, 1 new message/ }); await jump.waitFor();
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const jumpBox = await jump.boundingBox(); const composerBox = await page.locator('.composer-wrap').boundingBox();
  assert.ok(jumpBox.width >= 44 && jumpBox.height >= 44, 'Jump latest remains a 44px target at 200% mobile text');
  assert.ok(jumpBox.y + jumpBox.height <= composerBox.y, 'Jump latest does not overlap the composer at 320px/200%');
  await jump.focus(); await page.keyboard.press('Enter');
  await jump.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__unreadScrollBehaviors.includes('smooth')), false, 'reduced-motion Jump latest never requests smooth scrolling');
  await page.waitForFunction(() => document.activeElement?.classList.contains('messages'));
  assert.equal(await page.locator('.messages').evaluate((node) => document.activeElement === node), true, 'keyboard activation restores focus to the timeline');
  const focus = await page.locator('.messages').evaluate((node) => getComputedStyle(node));
  assert.ok(focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) >= 2, 'timeline focus is visible after Jump latest disappears');
  await context.close();

  const hashContext = await browser.newContext({ viewport: { width: 900, height: 720 }, serviceWorkers: 'block' }); await install(hashContext);
  const hashPage = await hashContext.newPage(); await hashPage.goto(`${origin}/chats/PEER#chat-message-W50`, { waitUntil: 'domcontentloaded' });
  await hashPage.locator('#chat-message-W50').waitFor(); await hashPage.waitForTimeout(100);
  const hashBox = await hashPage.locator('#chat-message-W50').boundingBox(); const scrollBox = await hashPage.locator('.messages').boundingBox();
  assert.ok(Math.abs((hashBox.y + hashBox.height / 2) - (scrollBox.y + scrollBox.height / 2)) < scrollBox.height * 0.3, 'deep-link target wins over unread placement');
  await hashContext.close();

  const readContext = await browser.newContext({ viewport: { width: 900, height: 720 }, serviceWorkers: 'block' }); await install(readContext, { noUnread: true });
  const readPage = await readContext.newPage(); await readPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' }); await readPage.getByRole('button', { name: /Peer/ }).click();
  await readPage.locator('#chat-message-W59').waitFor(); await readPage.waitForTimeout(50);
  assert.equal(await readPage.locator('.unread-divider').count(), 0, 'an already-read open renders no divider');
  assert.ok(await readPage.locator('.messages').evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop <= 4), 'an already-read open lands at latest');
  await readContext.close();

  const cancelContext = await browser.newContext({ viewport: { width: 900, height: 720 }, serviceWorkers: 'block' }); const cancelFixture = await install(cancelContext, { delayFirstOlder: true });
  const cancelPage = await cancelContext.newPage(); await cancelPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });
  const delayed = cancelPage.waitForRequest((request) => new URL(request.url()).searchParams.get('before') === 'OLDER-1');
  await cancelPage.getByRole('button', { name: /Peer/ }).click(); await delayed; await cancelPage.goBack();
  await cancelPage.getByRole('button', { name: /Peer/ }).waitFor();
  assert.equal(await cancelPage.locator('.unread-divider').count(), 0, 'history Back clears a stale unread boundary while older history is in flight');
  await cancelPage.goForward(); await cancelPage.locator('.unread-divider').waitFor();
  assert.equal(await cancelPage.locator('.unread-divider').count(), 1, 'history Forward freshly prepares the selected conversation');
  assert.ok(cancelFixture.counts().olderRequests <= 2, 'aborted Back/Forward pagination stays bounded');
  await cancelContext.close();

  const multiContext = await browser.newContext({ viewport: { width: 900, height: 720 }, serviceWorkers: 'block' }); const multiFixture = await install(multiContext, { multiPage: true });
  const multiPageView = await multiContext.newPage(); await multiPageView.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' }); await multiPageView.getByRole('button', { name: /Peer/ }).click();
  const multiDivider = multiPageView.locator('.unread-divider'); await multiDivider.waitFor();
  assert.equal(await multiDivider.evaluate((node) => node.parentElement?.id), 'chat-message-W5', 'multiple cursor pages accumulate to the exact first unread boundary');
  assert.equal(multiFixture.counts().olderRequests, 2, 'multi-page boundary fetch stops after the second required cursor');
  assert.equal(await multiPageView.locator('#chat-message-W10').count(), 1, 'first overlap is deduplicated across multiple pages');
  assert.equal(await multiPageView.locator('#chat-message-W60').count(), 1, 'second overlap is deduplicated across multiple pages');
  await multiContext.close();

  const stalledContext = await browser.newContext({ viewport: { width: 900, height: 720 }, serviceWorkers: 'block' }); const stalledFixture = await install(stalledContext, { noProgress: true });
  const stalledPage = await stalledContext.newPage(); await stalledPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' }); await stalledPage.getByRole('button', { name: /Peer/ }).click();
  await stalledPage.locator('#chat-message-W59').waitFor(); await stalledPage.waitForTimeout(50);
  assert.equal(stalledFixture.counts().olderRequests, 1, 'repeated cursor with zero novel rows terminates after one bounded request');
  assert.equal(await stalledPage.locator('.composer textarea').isVisible(), true, 'no-progress pagination leaves the conversation usable');
  await stalledContext.close();

  const failContext = await browser.newContext({ viewport: { width: 900, height: 720 }, serviceWorkers: 'block' }); const failed = await install(failContext, { failOlder: true });
  const failPage = await failContext.newPage(); await failPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' }); await failPage.getByRole('button', { name: /Peer/ }).click();
  await failPage.locator('#chat-message-W59').waitFor();
  assert.equal(failed.counts().olderRequests, 1, 'failed older fetch stops without a retry loop');
  assert.equal(await failPage.locator('.composer textarea').isVisible(), true, 'failed pagination leaves the loaded conversation usable');
  await failContext.close();
  console.log('browser-unread-positioning OK — exact frozen boundary, bounded pagination/fallback, hash priority, and keyboard Jump latest');
} finally {
  await browser.close(); for (const stream of streams) stream.end(); if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
