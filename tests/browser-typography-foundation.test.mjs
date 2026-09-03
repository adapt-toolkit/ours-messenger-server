import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const webRoot = join(repo, 'dist/web');
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the typography browser gate');
const removed = /Hanken Grotesk|Inter Variable|Fraunces Variable|fonts\.googleapis\.com|fonts\.gstatic\.com/i;
for (const source of ['web/src/main.tsx', 'web/src/theme.css', 'web/src/redesign.css', 'package.json', 'package-lock.json']) {
  assert.doesNotMatch(readFileSync(join(repo, source), 'utf8'), removed, `${source} contains no removed UI-font family/import`);
}
const builtFiles = readdirSync(join(webRoot, 'assets'));
assert.equal(builtFiles.some((name) => /inter|fraunces|hanken/i.test(name)), false, 'built assets contain no removed UI fonts');
for (const name of builtFiles.filter((item) => item.endsWith('.css'))) {
  assert.doesNotMatch(readFileSync(join(webRoot, 'assets', name), 'utf8'), removed, `${name} contains no removed UI-font reference`);
}
assert.equal(builtFiles.some((name) => /jetbrains-mono/i.test(name)), true, 'functional mono asset remains bundled locally');

const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n');
    streams.add(response);
    response.on('close', () => streams.delete(response));
    return;
  }
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
const cid = 'PEER';
const longName = 'A very long verified contact name that must remain reachable at large text sizes';

const installRoutes = async (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'An extensively named local identity for text scaling', cid: 'ME-CID-' + 'B'.repeat(56) });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: longName, container_id: cid }], pending: [] });
  if (url.pathname.endsWith('/page')) return json({ contact: cid, messages: [{ dir: 'in', text: 'Readable body text with `functional code` and a deliberately long unbroken identifier ' + 'C'.repeat(90), date: '2026-08-26T09:00:00.000Z', read: true, wire_id: 'TYPE-1', receipt: null }], total: 1, unread: 0, hasMore: false, nextBefore: null });
  if (url.pathname.endsWith('/files')) return json({ contact: cid, files: [] });
  if (url.pathname.endsWith('/read')) return json({ contact: cid, marked: 0 });
  if (url.pathname === '/api/invites') return json([]);
  if (url.pathname === '/api/events') return route.fallback();
  return json({}, 404);
});

const overlaps = (a, b) => a && b && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
const rect = (box) => box && ({ left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height });

const exercise = async (width, height, coarse) => {
  const context = await browser.newContext({ hasTouch: coarse, isMobile: coarse, serviceWorkers: 'block', viewport: { width, height } });
  await installRoutes(context);
  await context.addInitScript(() => localStorage.setItem('ours-dark-v3', '0'));
  const requested = [];
  context.on('request', (request) => requested.push(request.url()));
  const page = await context.newPage();
  await page.goto(`${origin}/chats/${cid}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.composer textarea').waitFor();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.waitForTimeout(100);

  assert.equal(requested.some((url) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)), false, `${width}px makes no remote font request`);
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return { font: root.getPropertyValue('--font'), display: root.getPropertyValue('--display'), mono: root.getPropertyValue('--mono'), body: getComputedStyle(document.body).fontFamily };
  });
  for (const value of [tokens.font, tokens.display, tokens.body]) {
    assert.match(value, /system-ui/);
    assert.doesNotMatch(value, removed);
  }
  assert.match(tokens.mono, /JetBrains Mono Variable/);
  assert.doesNotMatch(tokens.mono, removed);
  const monoFamily = await page.locator('.ours-message code').evaluate((node) => getComputedStyle(node).fontFamily);
  assert.match(monoFamily, /JetBrains Mono Variable/);

  const metrics = await page.evaluate(() => {
    const title = getComputedStyle(document.querySelector('.conv-peer-name'));
    const meta = getComputedStyle(document.querySelector('.bubble-at'));
    const body = getComputedStyle(document.querySelector('.bubble-text'));
    return {
      titleTracking: parseFloat(title.letterSpacing), titleRatio: parseFloat(title.lineHeight) / parseFloat(title.fontSize),
      metaTracking: parseFloat(meta.letterSpacing), metaRatio: parseFloat(meta.lineHeight) / parseFloat(meta.fontSize),
      bodyRatio: parseFloat(body.lineHeight) / parseFloat(body.fontSize),
    };
  });
  assert.ok(metrics.titleTracking < metrics.metaTracking, 'title tracking is tighter than metadata tracking');
  assert.ok(metrics.titleRatio < metrics.bodyRatio && metrics.metaRatio >= 1.25, 'semantic leading keeps titles compact and body/metadata readable');

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${width}px page has no horizontal overflow at 200% text`);
  const peer = rect(await page.locator('.conv-peer').boundingBox());
  const contactTrigger = rect(await page.locator('.conv-contact-trigger').boundingBox());
  assert.ok(contactTrigger.left >= peer.left && contactTrigger.right <= peer.right, `${width}px compact contact trigger stays within conversation identity bounds`);
  const composerChildren = await page.locator('.composer > :not(input)').evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).display !== 'none').map((node) => {
    const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  }));
  for (let i = 0; i < composerChildren.length; i += 1) for (let j = i + 1; j < composerChildren.length; j += 1) {
    assert.equal(overlaps(composerChildren[i], composerChildren[j]), false, `${width}px composer controls ${i}/${j} do not overlap`);
  }
  if (coarse) {
    for (const selector of ['.detail-back', '.composer-tool', '.vr-mic']) {
      const box = await page.locator(selector).first().boundingBox();
      assert.ok(box && box.width >= 43.9 && box.height >= 43.9, `${selector} remains a 44px touch target at 200%`);
    }
    await page.locator('.composer textarea').fill('Send target');
    const sendBox = await page.locator('.composer .btn.primary').boundingBox();
    assert.ok(sendBox && sendBox.width >= 43.9 && sendBox.height >= 43.9, '.composer .btn.primary remains a 44px touch target at 200%');
  }

  if (coarse) await page.locator('.detail-back').click();
  const invite = page.getByRole('button', { name: 'Invite' });
  await invite.click();
  const modal = page.locator('.modal');
  await modal.waitFor();
  const close = page.getByRole('button', { name: 'Close Invite a contact' });
  const closeBox = rect(await close.boundingBox());
  const tabsBox = rect(await page.getByRole('tablist', { name: 'Invite mode' }).boundingBox());
  assert.equal(overlaps(closeBox, tabsBox), false, `${width}px modal close and tabs do not overlap`);
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached' });
  await page.waitForFunction((button) => document.activeElement === button, await invite.elementHandle());
  assert.equal(await invite.evaluate((node) => document.activeElement === node), true, 'modal Escape restores focus at 200%');
  const focusStyle = await invite.evaluate((node) => getComputedStyle(node));
  assert.ok(focusStyle.outlineStyle !== 'none' && parseFloat(focusStyle.outlineWidth) >= 2, 'restored focus remains visible');

  await context.close();
};

try {
  await exercise(320, 760, true);
  await exercise(1280, 900, false);
  console.log('browser-typography-foundation OK — system UI ownership, local mono, semantic metrics, and 200% geometry');
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
