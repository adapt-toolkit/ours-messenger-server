// The HTML attachment preview is a real stored-file path, not an HTML-string
// demo. Drive the built messenger through its file record and media endpoint,
// then inspect both sides of the trust boundary: app-owned dialog chrome and
// the separately sandboxed srcdoc document.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
const evidenceRoot = resolve(new URL('../docs/design/baselines/calm-workspace-slice-1', import.meta.url).pathname);
mkdirSync(evidenceRoot, { recursive: true });
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the HTML preview browser gate');
const types = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
]);
let hostileNetworkRequests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/hostile-network') {
    hostileNetworkRequests++;
    response.writeHead(204).end();
    return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const hostileBody = [
  '<h1 id="stored-marker">Stored attachment bytes</h1>',
  `<img src="${origin}/hostile-network" onerror="parent.postMessage('escaped','*')">`,
  '<script>parent.postMessage("escaped", "*"); document.body.dataset.scriptRan="yes"</script>',
  `<form action="${origin}/hostile-network"><button>submit</button></form>`,
].join('');

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 760 } });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') return json({
      contact: 'PEER', messages: [{ dir: 'in', text: '', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'HTML-FILE', receipt: null }],
      total: 1, unread: 0, hasMore: false, nextBefore: null,
    });
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [{
      wire_id: 'HTML-FILE', contact_id: 'PEER', dir: 'in', filename: 'hostile.HTML', mime: 'text/html',
      size: Buffer.byteLength(hostileBody), date: '2026-08-15T00:00:00.000Z', available: true,
    }] });
    if (url.pathname === '/api/media/HTML-FILE') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostileBody });
    }
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  let escaped = false;
  await page.exposeFunction('recordEscape', () => { escaped = true; });
  await page.addInitScript(() => window.addEventListener('message', () => globalThis.recordEscape()));
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const trigger = page.getByTitle('Preview HTML');
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'hostile.HTML' });
  await dialog.waitFor();
  const frameElement = page.locator('.html-preview-iframe');
  assert.equal(await frameElement.getAttribute('sandbox'), '', 'iframe has no sandbox capabilities');
  assert.equal(await frameElement.getAttribute('referrerpolicy'), 'no-referrer');
  const frame = page.frameLocator('.html-preview-iframe');
  await frame.locator('#stored-marker').waitFor();
  assert.equal(await frame.locator('#stored-marker').textContent(), 'Stored attachment bytes', 'preview consumes exact media-endpoint bytes');
  assert.equal(await frame.locator('body').getAttribute('data-script-ran'), null, 'attachment script does not run');
  assert.match(await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /default-src 'none'/);
  const download = dialog.getByRole('link', { name: /Download original/ });
  const blobFacts = await download.evaluate(async (node) => {
    const response = await fetch(node.href);
    return { type: response.headers.get('content-type'), text: await response.text(), download: node.download };
  });
  assert.equal(blobFacts.type, 'application/octet-stream');
  assert.equal(blobFacts.text, hostileBody, 'neutral download preserves the original bytes');
  assert.equal(blobFacts.download, 'hostile.HTML');
  const frameUrlBeforeSubmit = await frame.locator('body').evaluate(() => location.href);
  const topUrlBeforeSubmit = page.url();
  await frame.locator('form button').click();
  await page.waitForTimeout(100);
  assert.equal(await frame.locator('body').evaluate(() => location.href), frameUrlBeforeSubmit,
    'sandbox and form-action policy keep the hostile frame URL fixed');
  assert.equal(page.url(), topUrlBeforeSubmit, 'hostile form cannot navigate the top-level app');
  assert.equal(hostileNetworkRequests, 0, 'hostile form submission issues no request');
  const box = await dialog.evaluate((node) => ({ width: node.getBoundingClientRect().width, viewport: innerWidth, scrollWidth: node.scrollWidth }));
  assert.ok(box.width <= box.viewport && box.scrollWidth <= box.width + 1, `narrow dialog stays contained (${JSON.stringify(box)})`);
  await page.screenshot({ path: join(evidenceRoot, 'renderer-html-mobile-after.png'), fullPage: true });
  await dialog.focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('title') === 'Preview HTML');
  assert.equal(await trigger.evaluate((node) => document.activeElement === node), true, 'closing restores focus to the preview trigger');
  await page.waitForTimeout(100);
  assert.equal(escaped, false, 'sandboxed attachment cannot message the parent');
  assert.equal(hostileNetworkRequests, 0, 'deny-first CSP blocks attachment network requests');
  await context.close();
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}

console.log('browser-html-preview OK — real bytes, empty sandbox, deny-first CSP, neutral download, narrow containment, focus restoration');
