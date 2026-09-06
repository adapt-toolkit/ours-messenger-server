import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the typed-command browser gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const engine = process.env.SLASH_BROWSER_ENGINE ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'supported slash browser engine');
const browser = await ({ chromium, webkit }[engine]).launch({ headless: true });

const definition = (name, description = 'Hint for ' + name) => ({ name, description, input_schema: { type: 'object', additionalProperties: false, properties: {} } });
const makeCatalog = (cid, revision, commands) => ({ recipient_cid: cid, fingerprint: revision.repeat(43), commands });
const catalogs = { PEER: makeCatalog('PEER', 'A', [definition('alpha'), definition('beta')]), OTHER: makeCatalog('OTHER', 'B', [definition('other')]), EMPTY: makeCatalog('EMPTY', 'C', []) };
const sends = [];
let commandSends = 0;
let holdNext = null;
let releaseHeld;
let heldStarted;
let loads = 0;
let failCatalog = false;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (path === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
    if (path === '/api/contacts') return json({ contacts: Object.keys(catalogs).map(cid => ({ name: cid, container_id: cid })), pending: [] });
    const match = path.match(/^\/api\/contacts\/(\w+)\/commands$/);
    if (match) {
      loads++;
      if (failCatalog) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      const snapshot = catalogs[match[1]];
      if (holdNext === match[1]) {
        holdNext = null;
        heldStarted?.();
        await new Promise(resolve => { releaseHeld = resolve; });
      }
      return json(snapshot);
    }
    if (path.endsWith('/page')) return json({ messages: [], total: 0, unread: 0, hasMore: false, nextBefore: null });
    if (path.endsWith('/files')) return json({ files: [] });
    if (path.endsWith('/read')) return json({ marked: 0 });
    if (path === '/api/messages/send') { sends.push(route.request().postDataJSON()); return json({ wire_id: 'SENT-' + sends.length, delivery: 'e2e' }); }
    if (path === '/api/commands/send') { commandSends++; return json({}); }
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return json({});
  });
  const page = await context.newPage();
  const input = page.locator('.composer textarea');
  const list = page.getByRole('listbox', { name: 'Suggested contact commands' });
  const panel = page.getByRole('form', { name: 'Send a typed command' });
  const options = () => list.getByRole('option');
  const absent = async () => { await list.waitFor({ state: 'hidden' }); };
  const completed = async name => {
    await absent();
    assert.equal(await input.inputValue(), `/${name} `);
    assert.deepEqual(await input.evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]),
      [true, name.length + 2, name.length + 2], 'completion retains focus and places caret after separator');
    assert.equal(await panel.count(), 0, 'suggestion does not open typed form');
    assert.equal(commandSends, 0, 'suggestion does not execute');
  };
  const visit = async cid => { await page.goto(`${origin}/chats/${cid}`, { waitUntil: 'domcontentloaded' }); await input.waitFor(); };
  await visit('PEER');
  await page.getByRole('button', { name: 'Recipient commands' }).waitFor();
  for (const text of ['hello /alpha', ' /alpha', '//alpha', '/alpha argument']) {
    await input.fill(text); await absent();
    assert.equal(await input.inputValue(), text, 'unrelated text is preserved');
  }
  await input.fill('/'); await list.waitFor();
  await options().nth(1).click();
  await completed('beta');
  assert.equal(sends.length, 0, 'selection sends neither text nor typed commands');
  await input.pressSequentially('argument');
  assert.equal(await input.inputValue(), '/beta argument', 'typing continues at the completion caret');
  await input.fill('/'); await list.waitFor();
  assert.equal(await options().count(), 2);
  assert.equal(await list.getByText('Hint for alpha').count(), 1);
  assert.equal(await input.getAttribute('aria-controls'), 'composer-command-suggestions');
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'no automatic selection');
  await input.press('ArrowUp');
  assert.equal(await options().nth(1).getAttribute('aria-selected'), 'true');
  await input.press('ArrowDown');
  assert.equal(await options().nth(0).getAttribute('aria-selected'), 'true', 'navigation wraps');
  await input.fill('/BE');
  assert.equal(await options().count(), 1, 'prefix filtering ignores case');
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'editing clears selection');
  await input.press('ArrowDown'); await input.press('Tab');
  await completed('beta');
  await input.fill('/alpha'); await input.press('ArrowDown'); await input.press('Enter');
  await completed('alpha');
  await input.fill('/'); await list.waitFor();
  await options().first().evaluate(el => el.click());
  await completed('alpha'); // Assistive activation has no preceding pointer gesture.

  await input.fill('/'); await list.waitFor(); await input.press('Escape'); await absent();
  const literalResponse = page.waitForResponse(response => response.url().endsWith('/api/messages/send'));
  await input.press('Enter');
  await literalResponse;
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
  assert.equal(sends.at(-1)?.text, '/', 'Escape then Enter sends literal slash');
  await page.waitForFunction(() => document.querySelector('.composer textarea').getAttribute('aria-busy') === 'false');
  await input.fill('/beta'); await list.waitFor();
  const betaResponse = page.waitForResponse(response => response.url().endsWith('/api/messages/send'));
  await input.press('Enter'); await betaResponse;
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '');
  assert.equal(sends.at(-1)?.text, '/beta', 'Enter without selection sends literal text');
  await input.fill('/'); await list.waitFor();
  await input.dispatchEvent('compositionstart'); await absent();
  const sendCount = sends.length;
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(sends.length, sendCount, 'IME Enter does not send');
  await input.dispatchEvent('compositionend'); await list.waitFor();
  await input.press('ArrowDown');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(await input.inputValue(), '/', 'IME legacy keycode does not complete the command');
  assert.equal(await options().count(), 2, 'IME legacy keycode leaves discovery open');
  assert.equal(await options().first().getAttribute('aria-selected'), 'true', 'IME legacy keycode retains selection');
  assert.equal(await input.evaluate(el => document.activeElement === el), true, 'IME retains composer focus');
  await options().nth(1).click(); await completed('beta');
  await input.fill(''); await input.fill('/'); await list.waitFor();
  await input.press('ArrowDown');
  const sameRevisionLoad = page.waitForResponse(response => new URL(response.url()).pathname === '/api/contacts/PEER/commands');
  await sameRevisionLoad;
  assert.equal(await options().first().getAttribute('aria-selected'), 'true', 'unchanged catalog preserves selection');
  assert.equal(await input.evaluate(el => document.activeElement === el), true, 'refresh preserves focus');
  const heldOption = await options().nth(1).elementHandle();
  const heldBox = await heldOption.boundingBox();
  await page.mouse.move(heldBox.x + 20, heldBox.y + 20);
  await page.mouse.down();
  catalogs.PEER = makeCatalog('PEER', 'D', [definition('beta', 'Updated hint'), definition('gamma')]);
  await list.getByText('Updated hint').waitFor({ timeout: 6000 });
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'registry revision invalidates selection');
  assert.equal(await list.getByText('/alpha', { exact: true }).count(), 0, 'removed command disappears');
  await page.mouse.up();
  await heldOption.evaluate(el => el.click());
  assert.equal(await input.inputValue(), '/', 'a gesture from a previous catalog revision cannot select');
  const dismissedOption = await options().first().elementHandle();
  await input.press('Escape'); await absent();
  await dismissedOption.evaluate(el => el.click());
  assert.equal(await input.inputValue(), '/', 'a closed popup cannot select');
  await input.fill(''); await input.fill('/'); await list.waitFor();
  catalogs.PEER = makeCatalog('PEER', 'E', []);
  await absent();
  catalogs.PEER = makeCatalog('PEER', 'F', [definition('fresh')]);
  await list.getByText('/fresh', { exact: true }).waitFor({ timeout: 6000 });
  failCatalog = true;
  await absent();
  assert.equal(await input.getAttribute('aria-activedescendant'), null, 'failed discovery clears stale suggestions');
  failCatalog = false;
  await list.getByText('/fresh', { exact: true }).waitFor({ timeout: 6000 });
  await input.fill('ordinary'); await absent();
  const stoppedLoads = loads;
  await page.waitForTimeout(2300);
  assert.equal(loads, stoppedLoads, 'refresh stops outside slash discovery');
  await visit('EMPTY'); await input.fill('/'); await absent();
  catalogs.EMPTY = makeCatalog('EMPTY', 'G', [definition('newly-registered')]);
  await list.getByText('/newly-registered', { exact: true }).waitFor({ timeout: 6000 });
  await page.setViewportSize({ width: 390, height: 844 });
  // Switch by in-app routing so a delayed request can resolve after unmount.
  const previousContactOption = await options().first().elementHandle();
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  holdNext = 'PEER';
  const held = new Promise(resolve => { heldStarted = resolve; });
  await page.locator('.contact-row').filter({ hasText: 'PEER' }).click(); await held;
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await page.locator('.contact-row').filter({ hasText: 'OTHER' }).click();
  await input.fill('/'); await list.getByText('/other', { exact: true }).waitFor();
  releaseHeld();
  await previousContactOption.evaluate(el => el.click());
  await page.waitForTimeout(200);
  assert.equal(await input.inputValue(), '/', 'old contact option cannot edit the new composer');
  assert.equal(await options().count(), 1);
  assert.equal(await list.getByText('/fresh', { exact: true }).count(), 0, 'stale result cannot cross contacts');
  // Narrow touch layout, long metadata, scrolling and reduced motion.
  await page.setViewportSize({ width: 390, height: 844 });
  catalogs.OTHER = makeCatalog('OTHER', 'H', Array.from({ length: 14 }, (_, i) => definition('command-' + i, '<img onerror=alert(1)>' + 'x'.repeat(120))));
  await list.getByText('/command-13', { exact: true }).waitFor({ timeout: 6000 });
  const box = await list.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height <= 241);
  assert.equal(await list.locator('img').count(), 0, 'metadata is escaped');
  await input.press('ArrowUp');
  assert.ok(await list.evaluate(el => el.scrollTop > 0), 'keyboard selection scrolls into view');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await list.evaluate(el => getComputedStyle(el).animationName), 'none');
  await options().last().click(); await completed('command-13');
  assert.equal(commandSends, 0);
  await context.close();
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await touch.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (path === '/api/contacts') return json({ contacts: [{ name: 'PEER', container_id: 'PEER' }], pending: [] });
    if (path === '/api/commands/send' || path === '/api/messages/send') {
      throw new Error('touch suggestion must not send');
    }
    if (path.endsWith('/commands')) return json(catalogs.PEER);
    if (path.endsWith('/page')) return json({ messages: [], total: 0, unread: 0, hasMore: false });
    if (path.endsWith('/files')) return json({ files: [] });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return json({});
  });
  const touchPage = await touch.newPage();
  await touchPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await touchPage.locator('.composer textarea').fill('/');
  const touchOption = touchPage.getByRole('option');
  await touchOption.waitFor();
  const touchBox = await touchOption.boundingBox();
  assert.ok(touchBox && touchBox.height >= 44 && touchBox.x >= 0 && touchBox.x + touchBox.width <= 390);
  await touchOption.tap();
  const touchInput = touchPage.locator('.composer textarea');
  assert.equal(await touchInput.inputValue(), '/fresh ');
  assert.deepEqual(await touchInput.evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 7, 7]);
  await touchInput.pressSequentially('argument');
  assert.equal(await touchInput.inputValue(), '/fresh argument');
  assert.equal(await touchPage.getByRole('form', { name: 'Send a typed command' }).count(), 0);
  await touch.close();
  console.log('browser-slash-commands OK: discovery/filter/close, literal sends, keyboard/pointer completion, IME, live catalog changes, isolation/races, accessibility, mobile and scroll');
} finally {
  releaseHeld?.();
  await browser.close();
  await new Promise(done => server.close(done));
}
