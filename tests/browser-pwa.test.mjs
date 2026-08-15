import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the browser gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

let hostileExecutionRequests = 0;
const hostileSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/pwned")</script></svg>';

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/pwned') {
    hostileExecutionRequests++;
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === '/api/media/hostile') {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': "attachment; filename*=UTF-8''hostile.svg",
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    response.end(hostileSvg);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end('{"error":"browser fixture has no runtime"}');
    return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': path.endsWith('sw.js') || path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    ...(path.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
  });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });

  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/manifest.webmanifest');
  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  assert.equal(manifest.start_url, '/chats');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');

  const registration = await page.evaluate(async () => {
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('service worker readiness timeout')), 10_000)),
    ]);
    if (ready.active && ready.active.state !== 'activated') {
      await new Promise((resolveState) => ready.active.addEventListener('statechange', resolveState, { once: true }));
    }
    return { scope: ready.scope, active: ready.active?.state };
  });
  assert.equal(registration.scope, `${origin}/`);
  assert.equal(registration.active, 'activated');

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cacheFacts = await page.evaluate(async () => {
    const keys = await caches.keys();
    const requests = (await Promise.all(keys.map(async (key) => (await caches.open(key)).keys()))).flat();
    return { keys, urls: requests.map((request) => new URL(request.url).pathname).sort() };
  });
  assert.ok(cacheFacts.keys.includes('ours-messenger-shell-v1'));
  assert.ok(cacheFacts.urls.includes('/chats'));
  assert.ok(cacheFacts.urls.includes('/manifest.webmanifest'));
  assert.equal(cacheFacts.urls.some((path) => path.startsWith('/api/')), false, 'API responses never enter Cache Storage');

  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send('Page.getAppManifest');
  assert.deepEqual(appManifest.errors ?? [], [], 'Chromium parses the web app manifest without errors');
  assert.match(appManifest.data ?? '', /"start_url"\s*:\s*"\/chats"/);
  const installability = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, [], 'Chromium accepts the app as installable');

  const mediaContext = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const mediaPage = await mediaContext.newPage();
  await mediaPage.goto(origin);
  const downloadPromise = mediaPage.waitForEvent('download');
  await mediaPage.goto(`${origin}/api/media/hostile`).catch(() => undefined);
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'hostile.svg', 'top-level active media navigation becomes a download');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(hostileExecutionRequests, 0, 'downloaded SVG never executes with the messenger origin');
  await mediaContext.close();

  const historyRequests = [];
  const messages = Array.from({ length: 60 }, (_, index) => ({
    dir: index % 2 ? 'out' : 'in',
    text: `history message ${index + 1}`,
    date: new Date(Date.UTC(2026, 7, 15, 0, index)).toISOString(),
    read: true,
    wire_id: `W${index + 1}`,
    receipt: index % 2 ? 'read' : null,
  }));
  const appContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 760 } });
  await appContext.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      const before = url.searchParams.get('before');
      historyRequests.push(before);
      return before === 'W11'
        ? json({ contact: 'PEER', messages: messages.slice(0, 10), total: 60, unread: 0, hasMore: false, nextBefore: null })
        : json({ contact: 'PEER', messages: messages.slice(10), total: 60, unread: 0, hasMore: true, nextBefore: 'W11' });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (url.pathname === '/api/invites') return json([]);
    if (url.pathname === '/api/contacts/add') return json({ pending: true });
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const appPage = await appContext.newPage();
  await appPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await appPage.locator('.message-row').nth(49).waitFor();
  assert.equal(await appPage.locator('.message-row').count(), 50, 'the initial browser snapshot is capped at 50 messages');
  await appPage.locator('.load-older').scrollIntoViewIfNeeded();
  const scrollBefore = await appPage.locator('.thread').evaluate((node) => ({ height: node.scrollHeight, top: node.scrollTop }));
  await appPage.getByRole('button', { name: 'Load older messages' }).click();
  await appPage.locator('.message-row').nth(59).waitFor();
  const scrollAfter = await appPage.locator('.thread').evaluate((node) => ({ height: node.scrollHeight, top: node.scrollTop }));
  assert.equal(await appPage.locator('.message-row').count(), 60, 'cursor loading renders history beyond 50 messages');
  assert.deepEqual(await appPage.locator('.message-row').evaluateAll((rows) => [rows[0].id, rows.at(-1)?.id]), ['message-W1', 'message-W60']);
  assert.ok(historyRequests.includes('W11'), 'the browser requests the server-provided exclusive cursor');
  assert.ok(Math.abs((scrollAfter.height - scrollAfter.top) - (scrollBefore.height - scrollBefore.top)) <= 2,
    `prepending preserves the visible scroll anchor (${JSON.stringify({ scrollBefore, scrollAfter })})`);

  await appPage.locator('.identity-header').getByRole('button', { name: 'Add contact' }).click();
  await appPage.getByRole('textbox', { name: 'Invite', exact: true }).fill('test-invite');
  await appPage.getByRole('button', { name: 'Accept invite' }).click();
  await appPage.getByRole('dialog').waitFor({ state: 'detached' });
  await appPage.locator('.identity-header').getByRole('button', { name: 'Add contact' }).click();
  assert.equal(await appPage.getByRole('button', { name: 'Accept invite' }).isEnabled(), true,
    'successful acceptance clears busy state before the invite dialog is reopened');
  assert.equal(await appPage.getByRole('button', { name: 'Create one-time invite' }).isEnabled(), true,
    'all reopened invite controls are usable');
  await appContext.close();

  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const offlineFacts = {
    root: await page.locator('#app').count(),
    title: await page.title(),
    url: page.url(),
    text: (await page.locator('body').innerText()).slice(0, 240),
  };
  assert.equal(offlineFacts.root, 1, `offline navigation restores the React app shell: ${JSON.stringify(offlineFacts)}`);
  assert.ok((await page.locator('body').innerText()).trim().length > 0, 'offline shell renders visible UI');

  await context.close();
  console.log('browser-pwa OK — installability/offline shell, hostile navigation download, cursor scrollback, and invite reopen');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
