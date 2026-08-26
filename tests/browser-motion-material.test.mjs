import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const repo = resolve(new URL('..', import.meta.url).pathname);
const webRoot = join(repo, 'dist/web');
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the motion/material gate');
const motionSource = readFileSync(join(repo, 'web/src/motion.css'), 'utf8');
const chatsSource = readFileSync(join(repo, 'web/src/ui/Chats.tsx'), 'utf8');
const themeSource = readFileSync(join(repo, 'web/src/theme.css'), 'utf8');
const layoutSource = readFileSync(join(repo, 'web/src/layout-v4.css'), 'utf8');
const redesignSource = readFileSync(join(repo, 'web/src/redesign.css'), 'utf8');
assert.doesNotMatch(motionSource, /listcol-scroll\s*>|animation-delay/, 'contact rows have no mount/filter/live-update stagger');
assert.match(themeSource, /--ease-soft:\s*var\(--ease-interface\)/);
assert.match(themeSource, /--dur-1:\s*var\(--dur-immediate\)/);
assert.match(themeSource, /--dur-2:\s*var\(--dur-standard\)/);
assert.match(themeSource, /--dur-3:\s*var\(--dur-emphasis\)/);
assert.doesNotMatch(motionSource, /var\(--(?:ease-soft|dur-[123])\)/, 'motion utilities consume the canonical timing family directly');
assert.doesNotMatch(`${layoutSource}\n${redesignSource}`, /\b(?:160|170|180|220|280)ms\b/, 'primary Messenger surfaces contain no independent legacy timing values');
const jumpRule = layoutSource.match(/\.jump-latest\s*\{([^}]*)\}/)?.[1] ?? '';
assert.doesNotMatch(jumpRule, /background:|backdrop-filter:|blur\(14px\)/, 'Jump latest consumes the centralized named material owner without a later override');
assert.match(chatsSource, /transition=\{interfaceSpring\}/, 'Framer transform owners use the exported interface spring');
assert.doesNotMatch(chatsSource, /duration:\s*0\.22|whileHover=\{\{\s*x:/, 'message tweens and unconditional hover translation are removed');

const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') { response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' }); response.write(': open\n\n'); streams.add(response); response.on('close', () => streams.delete(response)); return; }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream' }); response.end(readFileSync(path));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address === 'object'); const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const install = (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url()); const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }, { name: 'Other', container_id: 'OTHER' }], pending: [] });
  if (url.pathname.endsWith('/page')) { const cid = url.pathname.includes('OTHER') ? 'OTHER' : 'PEER'; return json({ contact: cid, messages: [{ dir: 'in', text: `${cid} message`, date: '2026-08-26T09:00:00.000Z', read: true, wire_id: `${cid}-1`, receipt: null }], total: 1, unread: 0, hasMore: false, nextBefore: null }); }
  if (url.pathname.endsWith('/files')) return json({ contact: 'PEER', files: [] });
  if (url.pathname.endsWith('/read')) return json({ contact: 'PEER', marked: 0 });
  if (url.pathname === '/api/invites') return json([]);
  if (url.pathname === '/api/events') return route.fallback();
  return json({}, 404);
});
const openPage = async (context) => { await install(context); const page = await context.newPage(); await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); await page.locator('.composer textarea').waitFor(); return page; };

try {
  const fine = await browser.newContext({ viewport: { width: 1000, height: 760 }, serviceWorkers: 'block' });
  const page = await openPage(fine);
  const tokens = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); return { immediate: s.getPropertyValue('--dur-immediate'), standard: s.getPropertyValue('--dur-standard'), emphasis: s.getPropertyValue('--dur-emphasis'), material: s.getPropertyValue('--material-chrome'), blur: s.getPropertyValue('--material-blur') }; });
  assert.deepEqual([tokens.immediate.trim(), tokens.standard.trim(), tokens.emphasis.trim(), tokens.blur.trim()], ['.12s', '.2s', '.32s', '14px']);
  assert.match(tokens.material, /color-mix/);
  const rows = page.locator('.contact-row:not(.pending)');
  assert.equal(await rows.first().evaluate((node) => getComputedStyle(node).animationName), 'none', 'contact rows are immediate on initial mount');
  await rows.first().hover(); assert.equal(await rows.first().evaluate((node) => getComputedStyle(node).transform), 'none', 'fine hover does not create a second transform owner');
  await rows.nth(1).click(); await rows.first().click();
  assert.equal(await page.locator('.contact-active-glow').count(), 1, 'rapid selection retarget keeps one shared spring owner');
  assert.equal(await rows.first().evaluate((node) => node.style.transform), '', 'Framer does not write transforms onto the CSS-owned contact row');
  await page.getByRole('button', { name: /account menu/ }).click();
  const menuOrigin = await page.locator('.command-menu').evaluate((node) => ({ origin: getComputedStyle(node).transformOrigin, width: node.getBoundingClientRect().width }));
  assert.ok(parseFloat(menuOrigin.origin) >= menuOrigin.width * 0.75 && menuOrigin.origin.endsWith(' 0px'), 'account menu is anchored at its top-right trigger edge');
  await page.getByRole('button', { name: /account menu/ }).evaluate((node) => node.click());
  await page.locator('.idchip').click();
  assert.equal(await page.locator('.idcard').evaluate((node) => getComputedStyle(node).transformOrigin), '0px 0px', 'identity popover is anchored at its header trigger edge');
  await page.getByRole('button', { name: 'Close verified identity' }).click();
  await page.locator('.command-settings').click();
  await page.locator('.modal').evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const dialogOrigin = await page.locator('.modal').evaluate((node) => ({ origin: getComputedStyle(node).transformOrigin.split(' ').map(parseFloat), box: [node.getBoundingClientRect().width, node.getBoundingClientRect().height] }));
  assert.ok(Math.abs(dialogOrigin.origin[0] - dialogOrigin.box[0] / 2) < 1 && Math.abs(dialogOrigin.origin[1] - dialogOrigin.box[1] / 2) < 1, `desktop dialog originates at its center ${JSON.stringify(dialogOrigin)}`);
  await fine.close();

  const coarse = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const mobile = await openPage(coarse); await mobile.locator('.command-settings').evaluate((node) => node.click());
  await mobile.locator('.modal').evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const sheetOrigin = await mobile.locator('.modal').evaluate((node) => ({ origin: getComputedStyle(node).transformOrigin.split(' ').map(parseFloat), box: [node.getBoundingClientRect().width, node.getBoundingClientRect().height] }));
  assert.ok(Math.abs(sheetOrigin.origin[0] - sheetOrigin.box[0] / 2) < 1 && Math.abs(sheetOrigin.origin[1] - sheetOrigin.box[1]) < 1, 'mobile sheet originates at its bottom edge');
  await coarse.close();

  const reduced = await browser.newContext({ viewport: { width: 1000, height: 760 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const reducedPage = await openPage(reduced); await reducedPage.locator('.command-settings').click();
  assert.equal(await reducedPage.locator('.modal').evaluate((node) => getComputedStyle(node).animationName), 'none', 'reduced motion suppresses dialog spatial keyframes');
  await reduced.close();

  const accessible = await browser.newContext({ viewport: { width: 1000, height: 760 }, serviceWorkers: 'block' }); await install(accessible);
  const accessiblePage = await accessible.newPage(); const session = await accessible.newCDPSession(accessiblePage);
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'forced-colors', value: 'active' }] });
  await accessiblePage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); await accessiblePage.locator('.composer textarea').waitFor();
  for (const selector of ['.commandbar', '.detail-head', '.composer']) assert.equal(await accessiblePage.locator(selector).evaluate((node) => getComputedStyle(node).backdropFilter), 'none', `${selector} material becomes non-blurred in accessibility modes`);
  await accessible.close();
  console.log('browser-motion-material OK — single motion owners, immediate lists, real anchored surfaces, and accessible material fallbacks');
} finally {
  await browser.close(); for (const stream of streams) stream.end(); if (server.listening) await new Promise((done) => server.close(done));
}
