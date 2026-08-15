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
  let voiceAvailable = false;
  const messages = Array.from({ length: 60 }, (_, index) => ({
    dir: index % 2 ? 'out' : 'in',
    text: `history message ${index + 1}`,
    date: new Date(Date.UTC(2026, 7, 15, 0, index)).toISOString(),
    read: true,
    wire_id: `W${index + 1}`,
    receipt: index % 2 ? 'read' : null,
  }));
  const appContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await appContext.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      const before = url.searchParams.get('before');
      historyRequests.push(before);
      return before === 'W11'
        ? json({ contact: 'PEER', messages: messages.slice(0, 10), total: 60, unread: 0, hasMore: false, nextBefore: null })
        : json({ contact: 'PEER', messages: messages.slice(10), total: 60, unread: 0, hasMore: true, nextBefore: 'W11' });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [
      { wire_id: 'VOICE-31', contact_id: 'PEER', dir: 'in', sender_id: 'PEER', sender_name: 'Peer', filename: 'voice-message-fixture.webm', logical_name: 'voice-message-fixture.webm', version: 1, mime: 'audio/webm;codecs=opus;x-ours-kind=voice-message', size: 14, sha256: 'a'.repeat(64), date: '2026-08-15T00:30:30.000Z', date_source: 'protocol', kind: 'voice_message', reply_to: { wire_id: 'W31' }, available: voiceAvailable, transcription: { status: 'complete', text: 'Voice fixture transcript' } },
      { wire_id: 'PHOTO-46', contact_id: 'PEER', dir: 'out', sender_id: 'ME-CID', sender_name: 'Me', filename: 'photo.png', logical_name: 'photo.png', version: 1, mime: 'image/png', size: 68, sha256: 'b'.repeat(64), date: '2026-08-15T00:45:30.000Z', date_source: 'server_observed', kind: 'photo', reply_to: null, available: true },
    ] });
    if (url.pathname === '/api/files/fetch') { voiceAvailable = true; return json({ files: [] }); }
    if (url.pathname === '/api/media/VOICE-31') return route.fulfill({ status: 200, contentType: 'audio/webm', body: Buffer.from('voice-fixture') });
    if (url.pathname === '/api/media/PHOTO-46') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') });
    if (url.pathname === '/api/invites') return json([]);
    if (url.pathname === '/api/contacts/add') return json({ pending: true });
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const appPage = await appContext.newPage();
  await appPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await appPage.locator('#chat-message-W60').waitFor();
  assert.equal(await appPage.locator('.message-motion').count(), 52, 'the initial browser snapshot joins two media records into chronological history');
  assert.equal(await appPage.locator('#chat-message-VOICE-31').getByRole('button', { name: 'Fetch' }).count(), 1,
    'unavailable inbound voice requires an explicit fetch');
  await appPage.locator('.image-bubble').waitFor({ state: 'attached' });
  const timelineOrder = await appPage.locator('.message-motion').evaluateAll((rows) => rows.map((row) => row.id));
  assert.ok(timelineOrder.indexOf('chat-message-W31') < timelineOrder.indexOf('chat-message-VOICE-31'));
  assert.ok(timelineOrder.indexOf('chat-message-VOICE-31') < timelineOrder.indexOf('chat-message-W32'));
  assert.ok(timelineOrder.indexOf('chat-message-W46') < timelineOrder.indexOf('chat-message-PHOTO-46'));
  await appPage.getByRole('button', { name: 'Fetch' }).click();
  await appPage.locator('.voice-bubble').waitFor({ state: 'attached' });
  await appPage.locator('.voice-bubble audio').waitFor({ state: 'attached' });
  assert.equal(await appPage.getByText('Voice fixture transcript').isVisible(), true,
    'voice transcription remains visible beside the canonical player');
  await appPage.screenshot({ path: '/tmp/ours-messenger-desktop-dark.png' });
  await appPage.locator('.chat-load-earlier').scrollIntoViewIfNeeded();
  const scrollBefore = await appPage.locator('.messages').evaluate((node) => ({ height: node.scrollHeight, top: node.scrollTop }));
  await appPage.getByRole('button', { name: /Load earlier messages/ }).click();
  await appPage.locator('#chat-message-W1').waitFor();
  await appPage.waitForFunction(() => (document.querySelector('.messages')?.scrollTop ?? 0) > 0);
  const scrollAfter = await appPage.locator('.messages').evaluate((node) => ({ height: node.scrollHeight, top: node.scrollTop }));
  assert.equal(await appPage.locator('.message-motion').count(), 62, 'cursor loading renders history beyond 50 messages while retaining media');
  assert.deepEqual(await appPage.locator('.message-motion').evaluateAll((rows) => [rows[0].id, rows.at(-1)?.id]), ['chat-message-W1', 'chat-message-W60']);
  assert.ok(historyRequests.includes('W11'), 'the browser requests the server-provided exclusive cursor');
  assert.ok(Math.abs((scrollAfter.height - scrollAfter.top) - (scrollBefore.height - scrollBefore.top)) <= 2,
    `prepending preserves the visible scroll anchor (${JSON.stringify({ scrollBefore, scrollAfter })})`);

  await appPage.locator('.commandbar').getByRole('button', { name: 'New chat' }).click();
  await appPage.getByRole('tab', { name: 'Accept invite' }).click();
  await appPage.getByRole('textbox', { name: 'Invite', exact: true }).fill('test-invite');
  await appPage.getByRole('button', { name: 'Add contact' }).click();
  await appPage.getByText(/Invite accepted/).waitFor();
  assert.equal(await appPage.getByRole('button', { name: 'Add contact' }).isEnabled(), false);
  await appPage.getByRole('button', { name: 'Close Accept an invite' }).click();
  await appPage.getByRole('dialog').waitFor({ state: 'detached' });
  await appPage.locator('.commandbar').getByRole('button', { name: 'New chat' }).click();
  await appPage.getByRole('tab', { name: 'Accept invite' }).click();
  assert.equal(await appPage.getByRole('button', { name: 'Add contact' }).isEnabled(), false,
    'successful acceptance clears busy state before the invite dialog is reopened');
  await appPage.getByRole('button', { name: 'Close Accept an invite' }).click();
  await appPage.setViewportSize({ width: 390, height: 844 });
  await appPage.locator('.detail-back').click();
  await appPage.locator('.listcol-head').getByRole('button', { name: 'Settings' }).click();
  await appPage.getByRole('heading', { name: 'Notifications' }).waitFor();
  assert.equal(await appPage.getByText(/requires a secure browser/i).isVisible(), true,
    'mobile reaches Settings → notifications and clearly explains unsupported push');
  await appPage.screenshot({ path: '/tmp/ours-messenger-mobile-dark.png' });
  await appContext.close();

  const closingServer = new Promise((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()));
  // Chromium may retain an otherwise-idle HTTP connection after the mobile
  // screenshot. Close it explicitly so the offline reload gate is deterministic.
  server.closeAllConnections?.();
  await closingServer;
  await page.reload({ waitUntil: 'domcontentloaded' });
  const offlineFacts = {
    root: await page.locator('#root').count(),
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
