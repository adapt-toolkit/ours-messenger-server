import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the iOS composer gate');
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
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  serviceWorkers: 'block',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
});
let sentText = null;
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
  if (url.pathname === '/api/messages/send') {
    sentText = JSON.parse(route.request().postData() || '{}').text;
    return json({ wire_id: 'WIRE-IOS', delivery: 'tracked' });
  }
  return json({}, 404);
});

const page = await context.newPage();
await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
const editor = page.locator('.composer .composer-editor');
await editor.waitFor({ timeout: 20_000 });
assert.equal(await page.locator('.composer textarea, .composer input:not([type=file])').count(), 0,
  'iOS composer contains no form text control that summons Form Assistant');
assert.equal(await editor.getAttribute('contenteditable'), 'plaintext-only');
assert.equal(await editor.getAttribute('role'), 'textbox');
assert.equal(await editor.getAttribute('aria-multiline'), 'true');
assert.equal(await editor.getAttribute('inputmode'), 'text');
assert.equal(await editor.getAttribute('enterkeyhint'), 'send');
assert.match(await editor.getAttribute('aria-label'), /^Message Peer/);

await editor.fill('draft');
await editor.evaluate((node) => {
  const transfer = new DataTransfer();
  transfer.setData('text/plain', '<b> plain </b>');
  transfer.setData('text/html', '<b>unsafe</b>');
  node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
});
assert.equal(await editor.evaluate((node) => node.textContent), 'draft<b> plain </b>', 'paste inserts text only');
assert.equal(await editor.locator('b').count(), 0, 'paste never creates HTML');

await editor.fill('IME');
await editor.dispatchEvent('compositionstart', { data: '' });
await editor.evaluate((node) => { node.textContent = 'IMEж'; node.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ж', inputType: 'insertCompositionText', isComposing: true })); });
await editor.dispatchEvent('compositionend', { data: 'ж' });
assert.equal(await editor.evaluate((node) => node.textContent), 'IMEж', 'composition text survives controlled synchronization');

await editor.fill('line one');
await editor.press('Shift+Enter');
assert.equal(await editor.evaluate((node) => node.textContent), 'line one\n', 'Shift+Enter inserts a plain-text newline');
await editor.fill('send from iPhone');
await editor.press('Enter');
await page.waitForFunction(() => document.querySelector('.composer-editor')?.textContent === '');
assert.equal(sentText, 'send from iPhone', 'Enter submits the controlled plain-text draft');
assert.equal(await editor.evaluate((node) => document.activeElement === node), true, 'successful send retains editor focus');
assert.equal(await editor.getAttribute('aria-busy'), 'false', 'settled send restores the non-busy state');

await context.close();
await browser.close();
server.close();
console.log('browser-ios-composer OK — no form control, plaintext paste, IME, newline, send, focus and a11y contract');
