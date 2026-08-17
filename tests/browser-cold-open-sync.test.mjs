// Opening the app from a push notification lands on a conversation whose
// messages have not arrived yet. The app must say so — inline, not as a screen
// — and it must stop saying so on its own, including when the message the
// notification pointed at never turns up.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the cold open browser gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // A real, open event stream: the client only reports "live" once the
  // connection stays up, and the indicator under test is allowed to consider
  // live updates a settled state.
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
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const history = [
  { dir: 'in', text: 'older line', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'WIRE-OLD', receipt: null },
];
const announced = {
  dir: 'in', text: 'the message the notification was about', date: '2026-08-15T00:05:00.000Z',
  read: false, wire_id: 'WIRE-NEW', receipt: null,
};

const openApp = async (context, { deliver }) => {
  let delivered = deliver;
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/events') return route.fallback();
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      const messages = delivered() ? [...history, announced] : history;
      return json({ contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    return json({}, 404);
  });
  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER#chat-message-WIRE-NEW`, { waitUntil: 'domcontentloaded' });
  return page;
};

try {
  // --- 1. The announced message is still in flight -------------------------
  {
    let arrived = false;
    const context = await browser.newContext({
      hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 },
    });
    const page = await openApp(context, { deliver: () => arrived });
    const indicator = page.locator('.conv-sync');
    await indicator.waitFor();
    assert.match(await indicator.innerText(), /Updating|Connecting/,
      'a cold open whose message has not arrived reports that it is still catching up');
    assert.equal(await page.locator('.centered-screen').count(), 0,
      'the catching-up state is inline, never a screen over the conversation');

    arrived = true;
    await page.locator('#chat-message-WIRE-NEW').waitFor({ timeout: 15_000 });
    await indicator.waitFor({ state: 'detached', timeout: 15_000 });
    assert.equal(await page.locator('.conv-sync').count(), 0,
      'the indicator clears once the announced message is on screen');
    await context.close();
  }

  // --- 2. The announced message never turns up -----------------------------
  {
    const context = await browser.newContext({
      hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 },
    });
    const page = await openApp(context, { deliver: () => false });
    await page.locator('.conv-sync').waitFor();
    // Bounded convergence, not a timer that can be missed: an indicator that
    // outlives the sync it describes is worse than none at all.
    await page.locator('.conv-sync').waitFor({ state: 'detached', timeout: 30_000 });
    await context.close();
  }

  console.log('browser-cold-open-sync OK — inline catching-up state appears on a notification cold open and always clears');
} finally {
  for (const stream of streams) stream.destroy();
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
