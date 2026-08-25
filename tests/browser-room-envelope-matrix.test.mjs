import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cowork-room-envelopes.json', import.meta.url), 'utf8'));
const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the room envelope browser gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml']]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
const roomMessages = fixture.cases.map(({ kind, body }, index) => ({
  dir: 'in', text: JSON.stringify(body), date: `2026-08-25T11:${String(index).padStart(2, '0')}:00.000Z`,
  read: true, wire_id: `ROOM-${kind}`, receipt: null,
}));
roomMessages.push({
  dir: 'out', text: JSON.stringify({ ...fixture.cases[0].body, text: 'typed by me' }),
  date: '2026-08-25T11:08:00.000Z', read: true, wire_id: 'ROOM-OUTGOING-JSON', receipt: null,
});
const ordinaryJson = JSON.stringify(fixture.cases[0].body);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 1000 } });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: 'test', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [
      { name: fixture.announced_contact, display_name: 'Cowork room', container_id: 'ROOM' },
      { name: 'Alice', container_id: 'PEER' },
    ], pending: [] });
    if (url.pathname === '/api/conversations/ROOM/page') return json({ contact: 'ROOM', messages: roomMessages, total: roomMessages.length, unread: 0, hasMore: false, nextBefore: null });
    if (url.pathname === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages: [{ dir: 'in', text: ordinaryJson, date: '2026-08-25T11:00:00.000Z', read: true, wire_id: 'PEER-JSON', receipt: null }], total: 1, unread: 0, hasMore: false, nextBefore: null });
    if (/\/api\/conversations\/(ROOM|PEER)\/read$/.test(url.pathname)) return json({ marked: 0 });
    if (/\/api\/conversations\/(ROOM|PEER)\/files$/.test(url.pathname)) return json({ files: [] });
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  await page.goto(`${origin}/chats/ROOM`, { waitUntil: 'domcontentloaded' });
  const chat = page.locator('#chat-message-ROOM-room_msg');
  assert.equal(await chat.locator('.room-message-room').textContent(), 'Комната релиза');
  assert.equal(await chat.locator('.room-author-name').textContent(), 'Секретарь');
  assert.equal(await chat.locator('.room-author-role').textContent(), 'Reviewer');
  assert.equal(await chat.locator('.message-markdown').textContent(), 'Проверка завершена.');
  assert.match(await chat.locator('.bubble-at').textContent(), /^10:00/);

  const briefing = page.locator('#chat-message-ROOM-room_briefing .room-briefing-card');
  assert.equal(await briefing.locator('.room-card-name').textContent(), 'Постоянные инвайты должны сохраняться');
  assert.equal(await briefing.locator('.room-system-text').textContent(), 'Проверьте, что постоянные инвайты сохраняются после перезапуска комнаты.');
  assert.equal(await briefing.locator('.room-card-author').textContent(), 'Координатор');
  assert.match(await briefing.locator('.room-system-at').textContent(), /^10:01/);
  const role = page.locator('#chat-message-ROOM-room_role_briefing .room-role-card');
  assert.equal(await role.locator('.room-system-label').textContent(), 'Role briefing · Reviewer · v2');
  assert.deepEqual(await role.locator('.room-card-details li').allTextContents(), ['Role: Reviewer']);
  const membership = page.locator('#chat-message-ROOM-room_membership .room-membership-card');
  assert.deepEqual(await membership.locator('.room-card-details li').allTextContents(), ['Status: Remove', 'Member: Рецензент', 'Role: Reviewer', 'Epoch: 7']);
  const file = page.locator('#chat-message-ROOM-room_file .room-file-card');
  assert.equal(await file.locator('.room-system-text').textContent(), 'отчёт.pdf');
  assert.deepEqual(await file.locator('.room-card-details li').allTextContents(), ['Type: application/pdf', 'Size: 1.5 KiB', 'SHA-256: aaaaaaaaaaaa…aaaaaa']);
  assert.equal(await file.locator('.room-card-author').textContent(), 'Секретарь');
  const removed = page.locator('#chat-message-ROOM-room_not_member .room-lifecycle-card');
  assert.equal(await removed.locator('.room-system-text').textContent(), 'You are no longer a member of this room.');
  assert.deepEqual(await removed.locator('.room-card-details li').allTextContents(), ['Status: Removed']);
  const future = page.locator('#chat-message-ROOM-room_future_status .room-system-card');
  assert.equal(await future.locator('.room-system-text').textContent(), 'Future status from the room.');
  const wholeRoom = await page.locator('.messages').textContent();
  assert.equal(wholeRoom.includes('future-secret-shape'), false, 'future metadata is not stringified');
  for (const { kind } of fixture.cases) {
    const rendered = await page.locator(`#chat-message-ROOM-${kind}`).textContent();
    assert.equal(rendered.includes('CID-MUST-NOT-RENDER'), false,
      `${kind} never renders authenticated author identity bytes`);
    assert.equal(rendered.includes('{"version"'), false,
      `${kind} received from the authenticated room never renders as raw JSON`);
  }
  assert.equal(await page.locator('#chat-message-ROOM-OUTGOING-JSON .message-markdown').textContent(),
    roomMessages.at(-1).text, 'outgoing JSON remains literal and cannot impersonate authenticated room provenance');

  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#chat-message-PEER-JSON .message-markdown').textContent(), ordinaryJson, 'ordinary 1:1 JSON remains ordinary message text');
  assert.equal(await page.locator('#chat-message-PEER-JSON .room-system').count(), 0);
  await context.close();
} finally {
  await browser.close();
  server.close();
}

console.log('browser-room-envelope-matrix OK — every Cowork room kind renders structurally and 1:1 JSON stays unchanged');
