import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the visual viewport geometry gate');
const types = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.end(': open\n\n');
    return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-store' });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

await context.addInitScript(() => {
  const viewport = new EventTarget();
  Object.assign(viewport, { width: 390, height: 412.5, offsetLeft: 0, offsetTop: 10.25, pageLeft: 0, pageTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
});
await context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/events') return route.fallback();
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
  if (url.pathname === '/api/conversations/PEER/page') return json({
    contact: 'PEER', messages: [], total: 0, unread: 0, hasMore: false, nextBefore: null,
  });
  if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
  if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
  return json({}, 404);
});

const page = await context.newPage();
await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
await page.locator('.composer textarea').waitFor({ timeout: 20_000 });
const geometry = await page.evaluate(() => {
  const root = document.querySelector('#root').getBoundingClientRect();
  const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
  return { root: root.toJSON(), composer: composer.toJSON() };
});
assert.ok(Math.abs(geometry.root.top - 10.25) <= 0.1, `root follows fractional visualViewport offset (${geometry.root.top})`);
assert.ok(Math.abs(geometry.root.height - 412.5) <= 0.1, `root follows fractional visualViewport height (${geometry.root.height})`);
assert.ok(Math.abs((geometry.root.bottom - geometry.composer.bottom) - 8) <= 0.1,
  `composer hugs the visible viewport with only its intentional 8px gutter (${geometry.root.bottom - geometry.composer.bottom})`);

await context.close();
await browser.close();
server.close();
console.log('browser-visual-viewport-geometry OK — composer follows fractional visible viewport without a keyboard gap');
