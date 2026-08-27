import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the preference browser gate');
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
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const file = {
  wire_id: 'FILE-1', contact_id: 'PEER', dir: 'in', sender_id: 'PEER', sender_name: 'Peer',
  filename: 'accessibility.pdf', logical_name: 'accessibility.pdf', version: 1,
  mime: 'application/pdf', size: 4096, sha256: null,
  date: '2026-08-26T09:00:00.000Z', date_source: 'protocol', kind: 'file', reply_to: null, available: true,
};
const messages = Array.from({ length: 8 }, (_, index) => ({
  dir: index % 2 ? 'out' : 'in', text: `preference fixture ${index}`,
  date: new Date(Date.UTC(2026, 7, 26, 8, index)).toISOString(), read: true,
  wire_id: `PREF-${index}`, receipt: null,
}));

const installRoutes = async (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }, { name: 'Other', container_id: 'OTHER' }], pending: [] });
  if (url.pathname === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
  if (url.pathname === '/api/conversations/OTHER/page') return json({ contact: 'OTHER', messages: [{ dir: 'in', text: 'new message', date: '2026-08-26T10:00:00.000Z', read: false, wire_id: 'OTHER-1', receipt: null }], total: 1, unread: 1, hasMore: false, nextBefore: null });
  if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [file] });
  if (url.pathname === '/api/conversations/OTHER/files') return json({ contact: 'OTHER', files: [] });
  if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
  if (url.pathname === '/api/invites') return json([]);
  if (url.pathname === '/api/events') return route.fallback();
  return json({}, 404);
});

const makePage = async ({ features = [], dark = true, reducedMotion = 'no-preference' } = {}) => {
  const context = await browser.newContext({ reducedMotion, serviceWorkers: 'block', viewport: { width: 1000, height: 760 } });
  await installRoutes(context);
  await context.addInitScript((useDark) => localStorage.setItem('ours-dark-v3', useDark ? '1' : '0'), dark);
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  if (features.length) await session.send('Emulation.setEmulatedMedia', { features });
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await page.locator('.composer textarea').waitFor();
  const geometry = await page.evaluate(() => {
    const app = document.querySelector('.signal-app');
    const stage = document.querySelector('.signal-stage');
    const tool = document.querySelector('.composer-tool:not(.vr-mic)');
    const appRect = app?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const toolRect = tool?.getBoundingClientRect();
    const target = toolRect && document.elementFromPoint(toolRect.left + toolRect.width / 2, toolRect.top + toolRect.height / 2);
    return { appHeight: appRect?.height, stageHeight: stageRect?.height, composerHit: target?.closest('.composer-tool') != null };
  });
  assert.equal(geometry.stageHeight, geometry.appHeight, `${dark ? 'dark' : 'light'} desktop stage fills the app shell`);
  assert.equal(geometry.composerHit, true, `${dark ? 'dark' : 'light'} desktop composer remains hit-testable`);
  return { context, page, session };
};

const alpha = (color) => {
  const match = color.match(/^rgba?\((?:\s*\d+(?:\.\d+)?\s*,?){3}(?:\s*\/\s*|\s*,\s*)?(\d?(?:\.\d+)?)?\s*\)$/);
  return match?.[1] === undefined || match[1] === '' ? 1 : Number(match[1]);
};

try {
  // Fresh ordinary context: spatial surface motion remains present. Contact
  // rows intentionally have no hover transform owner after motion consolidation.
  const ordinary = await makePage();
  await ordinary.page.locator('.listcol-head').getByRole('button', { name: 'Settings' }).click();
  assert.notEqual(await ordinary.page.locator('.modal').evaluate((node) => getComputedStyle(node).animationName), 'none', 'ordinary spatial motion remains enabled');
  assert.equal(await ordinary.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), false);
  await ordinary.context.close();

  // Fresh reduced-motion context: Framer/CSS spatial movement is removed, the
  // real shared-media jump reports auto (not smooth), and press colour remains.
  const reduced = await makePage({ reducedMotion: 'reduce' });
  assert.equal(await reduced.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await reduced.page.locator('.listcol-head').getByRole('button', { name: 'Settings' }).click();
  assert.equal(await reduced.page.locator('.modal').evaluate((node) => getComputedStyle(node).animationName), 'none', 'reduced motion removes spatial surface motion');
  await reduced.page.getByRole('button', { name: 'Close Settings' }).click();
  await reduced.page.evaluate(() => {
    globalThis.__elementScroll = null;
    globalThis.__windowScrollBeforeJump = { x: window.scrollX, y: window.scrollY };
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (options) {
      globalThis.__elementScroll = { className: this.className, options };
      return original.call(this, options);
    };
  });
  await reduced.page.getByRole('button', { name: /Open contact details/ }).click();
  await reduced.page.getByRole('button', { name: /Shared photos, files, and links/ }).click();
  await reduced.page.getByRole('tab', { name: /Files/ }).click();
  await reduced.page.locator('.shared-media-jump').first().click();
  await reduced.page.waitForFunction(() => globalThis.__elementScroll?.options?.behavior === 'auto');
  const jumpScroll = await reduced.page.evaluate(() => ({ element: globalThis.__elementScroll, before: globalThis.__windowScrollBeforeJump, after: { x: window.scrollX, y: window.scrollY } }));
  assert.match(jumpScroll.element.className, /(?:^|\s)messages(?:\s|$)/, 'media jump scrolls the message container');
  assert.equal(jumpScroll.element.options.behavior, 'auto', 'real reduced-motion media jump uses auto scrolling');
  assert.deepEqual(jumpScroll.after, jumpScroll.before, 'media jump does not scroll the document');
  const press = reduced.page.locator('.composer-tool:not(.vr-mic)');
  const pressBox = await press.boundingBox();
  const pressPoint = { x: pressBox.x + pressBox.width / 2, y: pressBox.y + pressBox.height / 2 };
  const pressTarget = await reduced.page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return { composerTool: target?.closest('.composer-tool') != null, tag: target?.tagName, className: target?.getAttribute('class'), label: target?.getAttribute('aria-label') };
  }, pressPoint);
  assert.equal(pressTarget.composerTool, true, `composer tool remains the hit target after media jump: ${JSON.stringify(pressTarget)}`);
  const rest = await press.evaluate((node) => ({ transform: getComputedStyle(node).transform, background: getComputedStyle(node).backgroundColor }));
  await reduced.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pressPoint, button: 'left', buttons: 1, pointerType: 'pen', clickCount: 1 });
  await reduced.page.waitForTimeout(50);
  const down = await press.evaluate((node) => ({ transform: getComputedStyle(node).transform, background: getComputedStyle(node).backgroundColor }));
  assert.ok(down.transform === rest.transform || down.transform === 'matrix(1, 0, 0, 1, 0, 0)', 'reduced press has no geometric movement');
  assert.notEqual(down.background, rest.background, 'reduced press retains surface feedback');
  await reduced.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pressPoint, button: 'left', buttons: 0, pointerType: 'pen', clickCount: 1 });
  await reduced.context.close();

  // Reduced transparency is genuinely emulated and independently checked in
  // fresh light and dark contexts.
  for (const dark of [false, true]) {
    const transparent = await makePage({ dark, features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    assert.equal(await transparent.page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches), true);
    assert.equal(await transparent.page.evaluate(() => matchMedia('(prefers-contrast: more)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches), false, 'transparency preference is independent');
    const assertOpaqueSurface = async (selector) => {
      const style = await transparent.page.locator(selector).first().evaluate((node) => {
        const computed = getComputedStyle(node);
        return { backdrop: computed.backdropFilter, webkitBackdrop: computed.webkitBackdropFilter, background: computed.backgroundColor };
      });
      assert.ok(style.backdrop === 'none' && (!style.webkitBackdrop || style.webkitBackdrop === 'none'), `${selector} removes backdrop filtering`);
      assert.equal(alpha(style.background), 1, `${selector} has an opaque ${dark ? 'dark' : 'light'} background (${style.background})`);
    };
    for (const selector of ['.listcol-actions .btn', '.detail-head', '.composer']) await assertOpaqueSurface(selector);

    await transparent.page.getByRole('button', { name: 'Invite' }).click();
    await assertOpaqueSurface('.modal');
    await transparent.page.getByRole('button', { name: 'Close Invite a contact' }).click();

    await transparent.page.getByRole('button', { name: /Open contact details/ }).click();
    await assertOpaqueSurface('.contact-identity');
    await transparent.page.keyboard.press('Escape');

    await transparent.context.setOffline(true);
    const transparencyBanner = transparent.page.getByRole('status').filter({ hasText: 'Offline' });
    await transparencyBanner.waitFor();
    await assertOpaqueSurface('.banner.warn');
    await transparent.context.close();
  }

  // Increased contrast is independent and strengthens actual boundaries.
  const contrast = await makePage({ features: [{ name: 'prefers-contrast', value: 'more' }] });
  assert.equal(await contrast.page.evaluate(() => matchMedia('(prefers-contrast: more)').matches), true);
  assert.equal(await contrast.page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches), false, 'contrast preference is independent');
  for (const selector of ['.listcol-actions .btn', '.detail-head', '.composer', '.conv-contact-trigger']) {
    const boundary = await contrast.page.locator(selector).first().evaluate((node) => {
      const style = getComputedStyle(node);
      return { width: Math.max(parseFloat(style.borderTopWidth), parseFloat(style.borderBottomWidth)), color: style.borderColor };
    });
    assert.ok(boundary.width >= 1 && boundary.color !== 'rgba(0, 0, 0, 0)', `${selector} retains a visible high-contrast boundary`);
  }
  await contrast.context.close();

  // Forced colors uses system boundaries and shape/weight with real keyboard
  // focus; the real banner shape is exercised in both transparency contexts.
  const forced = await makePage({ features: [{ name: 'forced-colors', value: 'active' }] });
  assert.equal(await forced.page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
  await forced.page.getByRole('button', { name: /Open contact details/ }).click();
  await forced.page.getByRole('button', { name: /Shared photos, files, and links/ }).click();
  const selected = forced.page.getByRole('tab', { name: /Photos/ });
  const unselected = forced.page.getByRole('tab', { name: /Files/ });
  assert.ok(parseFloat(await selected.evaluate((node) => getComputedStyle(node).borderTopWidth)) >= 2, 'selected tab has a shape boundary');
  assert.notEqual(await selected.evaluate((node) => getComputedStyle(node).fontWeight), await unselected.evaluate((node) => getComputedStyle(node).fontWeight), 'selected tab differs by weight, not color alone');
  await selected.focus();
  await forced.page.keyboard.press('ArrowRight');
  const focus = await unselected.evaluate((node) => getComputedStyle(node));
  assert.ok(parseFloat(focus.outlineWidth) >= 3 && focus.outlineStyle !== 'none', 'keyboard focus remains visibly outlined');
  await forced.context.close();

  const restored = await makePage();
  assert.equal(await restored.page.evaluate(() => [
    matchMedia('(prefers-reduced-motion: reduce)').matches,
    matchMedia('(prefers-reduced-transparency: reduce)').matches,
    matchMedia('(prefers-contrast: more)').matches,
    matchMedia('(forced-colors: active)').matches,
  ].some(Boolean)), false, 'fresh ordinary context restores every media preference');
  await restored.page.locator('.listcol-head').getByRole('button', { name: 'Settings' }).click();
  assert.notEqual(await restored.page.locator('.modal').evaluate((node) => getComputedStyle(node).animationName), 'none', 'ordinary spatial motion still exists after preference contexts');
  await restored.context.close();

  console.log('browser-accessibility-preferences OK — independent motion, transparency, contrast, and forced-colors policies');
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
