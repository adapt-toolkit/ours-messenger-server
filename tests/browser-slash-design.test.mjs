import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

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
const browser = await chromium.launch({ headless: true });


try {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (path === '/api/contacts') return json({ contacts: [{ name: 'Assistant', container_id: 'PEER' }], pending: [] });
    if (path.endsWith('/commands')) return json({ recipient_cid: 'PEER', fingerprint: 'A'.repeat(43), commands: [
      { name: 'summarize', description: 'Summarize the conversation and highlight next steps.', input_schema: { type: 'object', properties: {} } },
      { name: 'schedule', description: 'Choose a time and create a reminder.', input_schema: { type: 'object', properties: {} } },
      ...Array.from({ length: 10 }, (_, i) => ({ name: 'command-' + i, description: 'A longer description with enough context to understand this action before choosing it.', input_schema: { type: 'object', properties: {} } })),
    ] });
    if (path.endsWith('/page')) return json({ messages: [], total: 0, unread: 0, hasMore: false });
    if (path.endsWith('/files')) return json({ files: [] });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return json({});
  });
  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const input = page.locator('.composer textarea');
  const list = page.getByRole('listbox', { name: 'Suggested contact commands' });
  await input.fill('/'); await list.waitFor();
  if (process.env.SLASH_DESIGN_SCREENSHOT) await page.screenshot({ path: process.env.SLASH_DESIGN_SCREENSHOT });
  const first = list.getByRole('option').first();
  const box = await first.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + 20, box.y + 20);
  const resting = await first.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.mouse.down();
  const pressed = await first.evaluate(el => getComputedStyle(el).backgroundColor);
  assert.notEqual(pressed, resting, 'pointer-down must provide distinct immediate press feedback');
  await page.mouse.move(1, 1); await page.mouse.up();
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'dragging away cancels selection');
  assert.equal(await input.evaluate(el => document.activeElement === el), true, 'press/cancel retains composer focus');
  const session = await context.newCDPSession(page);
  const touchX = box.x + 20; const touchY = box.y + 20;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY }] });
  assert.equal(await first.getAttribute('data-pressed'), 'true', 'held touch has deterministic visual feedback');
  assert.notEqual(await first.evaluate(el => getComputedStyle(el).backgroundColor), resting);
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'held touch does not select');
  if (process.env.SLASH_DESIGN_SCREENSHOT) await page.screenshot({ path: process.env.SLASH_DESIGN_SCREENSHOT });
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.equal(await first.getAttribute('data-pressed'), null, 'touch cancel clears feedback');
  const listBox = await list.boundingBox(); assert.ok(listBox);
  const x = listBox.x + listBox.width / 2;
  const y = listBox.y + listBox.height - 15;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let delta = 20; delta <= 120; delta += 20) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - delta }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('.command-suggestions').scrollTop > 0);
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'scroll gesture does not choose a command');
  assert.equal(await list.locator('[data-pressed=true]').count(), 0, 'scroll clears pressed feedback');
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  const scaledBox = await list.boundingBox(); assert.ok(scaledBox);
  assert.ok(scaledBox.x >= 0 && scaledBox.x + scaledBox.width <= 390, '200% text remains horizontally contained');
  assert.ok(await list.evaluate(el => el.scrollWidth <= el.clientWidth), '200% text does not create horizontal scrolling');
  await input.press('ArrowUp');
  const selected = list.locator('[aria-selected=true]');
  assert.ok(await selected.evaluate(el => {
    const row = el.getBoundingClientRect(); const list = el.parentElement.getBoundingClientRect();
    return row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  }), 'selected option is fully visible with enlarged text');
  await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
  assert.equal(await list.evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await list.evaluate(el => getComputedStyle(el).borderTopColor === getComputedStyle(el).color), true);
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await selected.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => document.documentElement.style.fontSize = '100%');
  await first.tap();
  await page.getByRole('form', { name: 'Send a typed command' }).waitFor();
  await context.close();
  console.log('browser-slash-design OK — immediate press, cancel, native touch scrolling, enlarged text, reduced motion and contrast');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
