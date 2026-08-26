import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const webRoot = join(repo, 'dist/web');
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the mobile banner geometry gate');

const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const installRoutes = (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'Maya Chen', cid: `MAYA-${'A'.repeat(56)}` });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Design room', container_id: 'DESIGN' }], pending: [] });
  if (url.pathname.endsWith('/page')) return json({ contact: 'DESIGN', messages: [], total: 0, unread: 0, hasMore: false, nextBefore: null });
  if (url.pathname.endsWith('/files')) return json({ contact: 'DESIGN', files: [] });
  if (url.pathname.endsWith('/read')) return json({ contact: 'DESIGN', marked: 0 });
  if (url.pathname === '/api/invites') return json([]);
  return json({});
});

const overlaps = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;

const exercise = async (width, scale) => {
  const height = 844;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await installRoutes(context);
  const page = await context.newPage();
  await page.goto(`${origin}/chats/DESIGN`, { waitUntil: 'domcontentloaded' });
  await page.locator('.composer textarea').waitFor();
  if (scale === 2) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const banner = page.locator('.app-banners .banner').first();
  await banner.waitFor();
  const account = page.getByRole('button', { name: /account menu/ });
  const geometry = await page.evaluate(() => {
    const toRect = (node) => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
    const accountNode = document.querySelector('.command-me');
    const bannerNode = document.querySelector('.app-banners .banner');
    const accountRect = toRect(accountNode);
    const center = document.elementFromPoint((accountRect.left + accountRect.right) / 2, (accountRect.top + accountRect.bottom) / 2);
    return {
      account: accountRect,
      banner: toRect(bannerNode),
      accountHit: center === accountNode || accountNode.contains(center),
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  assert.equal(overlaps(geometry.account, geometry.banner), false, `${width}px/${scale * 100}% banner and account are rect-disjoint: ${JSON.stringify(geometry)}`);
  for (const [name, box] of [['account', geometry.account], ['banner', geometry.banner]]) {
    assert.ok(box.left >= -0.5 && box.right <= geometry.viewportWidth + 0.5, `${width}px/${scale * 100}% ${name} remains inside horizontal viewport/safe-area bounds`);
    assert.ok(box.top >= -0.5 && box.bottom <= geometry.viewportHeight + 0.5, `${width}px/${scale * 100}% ${name} remains inside vertical viewport bounds`);
  }
  assert.ok(geometry.scrollWidth <= geometry.viewportWidth + 1, `${width}px/${scale * 100}% has no horizontal overflow`);
  assert.equal(geometry.accountHit, true, `${width}px/${scale * 100}% account center wins hit testing`);
  await account.click();
  await page.getByRole('menu', { name: /Maya Chen account/ }).waitFor();
  assert.equal(await account.getAttribute('aria-expanded'), 'true', `${width}px/${scale * 100}% account menu opens`);
  await context.close();
};

try {
  for (const width of [320, 375, 390]) for (const scale of [1, 2]) await exercise(width, scale);
  console.log('browser-mobile-banner-geometry OK — 320/375/390 normal+200%, disjoint safe geometry and account interaction');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
