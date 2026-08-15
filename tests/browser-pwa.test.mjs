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

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
  console.log('browser-pwa OK — Chromium installability, active service worker, API cache isolation, and offline shell');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
