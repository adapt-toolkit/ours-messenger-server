import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, webkit } from '@playwright/test';
import { HTML_PREVIEW_CSP } from '../web/src/ui/htmlPreviewCore.mjs';
import { transformHtmlPreview } from '../src/html-preview-transform.ts';

const engineName = process.env.HTML_BROWSER_ENGINE ?? 'chromium';
const engine = { chromium, webkit }[engineName]; assert.ok(engine, `unknown HTML_BROWSER_ENGINE ${engineName}`);
const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before HTML preview gate');
const APP_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const RESPONSE_CSP = `${HTML_PREVIEW_CSP}; sandbox; frame-ancestors 'self'`;
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript']]);
let hostileRequests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/hostile-')) { hostileRequests++; response.writeHead(204).end(); return; }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'content-security-policy': APP_CSP, 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const ownerShaped = (marker, accent) => Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>code{white-space:pre-wrap}.smallcaps{font-variant:small-caps}</style><style>
  @import url("${origin}/hostile-import");
  :root{--ink:#15213a} body{display:grid;grid-template-columns:17rem minmax(0,1fr);margin:0;background:#fbfcff;color:var(--ink)}
  #title-block-header{padding:42px;color:white;background:linear-gradient(132deg,#07152f,#3434a4)}
  .title{font-size:43px}.card{border-radius:22px;background:${accent};background-image:url("${origin}/hostile-image")}
  #TOC{position:sticky;border-radius:20px}.section{min-height:30rem}</style></head><body><header id="title-block-header"><h1 class="title">${marker} — Привет</h1></header>
  <nav id="TOC"><a id="toc-link" href="#section">Раздел</a></nav><section id="section" class="card section" style="width: 33%; padding: 18px">Styled card</section>
  <script>parent.postMessage('script-ran','*');document.body.dataset.scriptRan='yes';localStorage.setItem('pwn','1')</script>
  <img id="event-probe" src="${origin}/hostile-img" onerror="parent.postMessage('event-ran','*')">
  <form action="${origin}/hostile-form"><button>Submit hostile form</button></form>
  <a id="js-link" href="javascript:parent.postMessage('js-ran','*')">JS URL</a>
  <a id="popup-link" target="_blank" href="${origin}/hostile-popup">Popup</a>
  <a id="download-link" download href="${origin}/hostile-download">Download</a><a id="nav-link" href="${origin}/hostile-nav">Navigate</a></body></html>`, 'utf8');
const files = new Map([['HTML-ONE', ownerShaped('Owner specification', '#ffffff')], ['HTML-TWO', ownerShaped('Second specification', '#eef4ff')]]);
const responseHeaders = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
  'content-security-policy': RESPONSE_CSP, 'content-disposition': "inline; filename*=UTF-8''owner.html",
  'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer',
};
const browser = await engine.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 760 } });
  await context.addCookies([{ name: 'app-secret', value: 'not-for-preview', url: origin }]);
  const previewRequests = [];
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [], roots: {} });
    if (url.pathname === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages: [...files].map(([id], index) => ({ dir: 'in', text: '', date: `2026-08-27T10:0${index}:00Z`, read: true, wire_id: id, receipt: null })), total: 2, unread: 0, hasMore: false, nextBefore: null });
    if (url.pathname === '/api/conversations/PEER/read') return json({ marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [...files].map(([id, body], index) => ({ wire_id: id, contact_id: 'PEER', dir: 'in', filename: `${index + 1}.html`, mime: 'text/html', size: body.byteLength, date: `2026-08-27T10:0${index}:00Z`, available: true })) });
    if (url.pathname.startsWith('/api/media/')) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: files.get(decodeURIComponent(url.pathname.slice('/api/media/'.length))) });
    if (url.pathname.startsWith('/api/html-preview/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/html-preview/'.length)); previewRequests.push(id);
      return route.fulfill({ status: 200, headers: responseHeaders, body: transformHtmlPreview(files.get(id)) });
    }
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });
  const page = await context.newPage(); const messages = [];
  page.on('console', (message) => messages.push(message.text()));
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const triggers = page.getByTitle('Preview HTML'); await triggers.first().click();
  const iframe = page.locator('.html-preview-iframe'); await iframe.waitFor();
  assert.equal(await iframe.getAttribute('sandbox'), '');
  assert.equal(await iframe.getAttribute('src'), '/api/html-preview/HTML-ONE');
  assert.equal(await iframe.getAttribute('srcdoc'), null);
  const frame = page.frameLocator('.html-preview-iframe'); await frame.locator('.title').waitFor();
  const styles = await frame.locator('body').evaluate(() => {
    const body = getComputedStyle(document.body); const title = getComputedStyle(document.querySelector('.title')); const card = getComputedStyle(document.querySelector('.card'));
    let parentDenied = false; try { void parent.document.body; } catch { parentDenied = true; }
    let storageDenied = false; try { void localStorage.length; } catch { storageDenied = true; }
    let cookieDenied = false; try { void document.cookie; } catch { cookieDenied = true; }
    return { color: body.color, background: body.backgroundColor, grid: body.gridTemplateColumns, titleSize: title.fontSize, cardWidth: card.width, cardRadius: card.borderRadius, sheets: [...document.styleSheets].map((sheet) => sheet.cssRules.length), parentDenied, storageDenied, cookieDenied, scriptRan: document.body.dataset.scriptRan ?? null };
  });
  assert.equal(styles.color, 'rgb(21, 33, 58)'); assert.equal(styles.background, 'rgb(251, 252, 255)');
  assert.notEqual(styles.grid, 'none'); assert.equal(styles.titleSize, '43px'); assert.equal(styles.cardRadius, '22px');
  assert.ok(styles.sheets.reduce((sum, count) => sum + count, 0) >= 5); assert.ok(styles.parentDenied && styles.storageDenied && styles.cookieDenied && styles.scriptRan === null, JSON.stringify(styles));
  const download = page.getByRole('link', { name: /Download original/ });
  const downloadEvent = page.waitForEvent('download'); await download.click(); const saved = await downloadEvent; const stream = await saved.createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), files.get('HTML-ONE'), 'download blob preserves exact original bytes');
  await page.screenshot({ path: `/tmp/html-preview-owner-shaped-${engineName}.png`, fullPage: true });
  const frameUrl = await frame.locator('body').evaluate(() => location.href);
  await frame.getByRole('button', { name: 'Submit hostile form' }).click();
  assert.equal(await frame.locator('body').evaluate(() => location.href), frameUrl, 'hostile form cannot navigate the preview');
  await frame.locator('#js-link').click();
  assert.equal(await frame.locator('body').evaluate(() => location.href), frameUrl, 'javascript URL cannot navigate the preview');
  for (const selector of ['#popup-link', '#download-link', '#nav-link']) {
    assert.equal(await frame.locator(selector).getAttribute('href'), null, `${selector} external navigation is removed`);
    assert.equal(await frame.locator(selector).getAttribute('target'), null, `${selector} target is removed`);
    await frame.locator(selector).click();
  }
  await frame.locator('#toc-link').click();
  assert.match(await frame.locator('body').evaluate(() => location.href), /#section$/, 'fragment-only TOC navigation survives');
  await page.waitForTimeout(100); assert.equal(hostileRequests, 0); assert.deepEqual(messages.filter((line) => /script-ran|event-ran|js-ran/.test(line)), []);
  assert.deepEqual(previewRequests, ['HTML-ONE']);
  await page.getByRole('button', { name: 'Close 1.html' }).click(); await iframe.waitFor({ state: 'detached' });
  await triggers.nth(1).click(); await page.frameLocator('.html-preview-iframe').locator('text=Second specification').waitFor();
  assert.equal(await page.locator('.html-preview-iframe').getAttribute('src'), '/api/html-preview/HTML-TWO');
  assert.equal(await page.locator('iframe[src*="HTML-ONE"]').count(), 0, 'old iframe navigation is gone');
  await page.getByRole('button', { name: 'Close 2.html' }).click(); assert.equal(await page.locator('.html-preview-iframe').count(), 0);

  const direct = await context.newPage(); await direct.goto(`${origin}/api/html-preview/HTML-ONE`); await direct.locator('.title').waitFor();
  assert.equal(await direct.evaluate(() => { try { localStorage.setItem('x', '1'); return false; } catch { return true; } }), true, 'response CSP sandbox denies top-level storage');
  assert.equal(await direct.evaluate(() => { try { void document.cookie; return false; } catch { return true; } }), true, 'response CSP sandbox denies top-level cookies'); assert.equal(await direct.locator('body').getAttribute('data-script-ran'), null);
  assert.equal(hostileRequests, 0, 'top-level response also emits no hostile network traffic');
  await context.close();
} finally {
  await browser.close(); if (server.listening) await new Promise((done) => server.close(done));
}
console.log(`browser-html-preview OK — ${engineName} response CSP restores CSS and contains active content`);
