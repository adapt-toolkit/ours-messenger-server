// SAFE MESSAGE MARKDOWN THROUGH THE REAL BUILT APP.
//
// This follows the three production paths that carry Fleet and tool output:
//   1. Fleet final/progress text is an ordinary ours message -> message.text.
//   2. Pair results are signed room_msg envelopes -> RoomLine.text.
//   3. Fleet role/task briefings are room_role_briefing system notes.
// The browser assertions use the shipped bundle and CSS, including hostile and
// oversized direct peer input, so emitted tags alone cannot satisfy this gate.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the message Markdown browser gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);
let remoteImageRequests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/markdown-remote.png') {
    remoteImageRequests++;
    response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('89504e470d0a1a0a', 'hex'));
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

const ordinarySource = [
  '# Tool result',
  '**done** and *reviewed* with `npm test`',
  '',
  '- contract',
  '- browser',
  '',
  `[safe](https://example.com/evidence) [unsafe](javascript:alert(1)) ![remote](${origin}/markdown-remote.png)`,
  '',
  'soft line',
  'next soft line',
  '',
  'hard line  ',
  'next hard line',
  '',
  '```js',
  '<script>globalThis.pwned = true</script>',
  '```',
  '',
  '<img src=x onerror="globalThis.pwned=true">',
].join('\n');
const oversizedSource = `# must stay literal\n${'oversized'.repeat(6_251)}`;
assert.ok(oversizedSource.length > 50_000);

const roomBody = (kind, text, extra = {}) => JSON.stringify({
  version: 1,
  kind,
  room_id: '01hzyk8m0000000000000000aa',
  message_id: `MESSAGE-${kind}`,
  signature: 'SIGNED-BY-ROOM',
  at: '2026-08-15T00:00:00.000Z',
  author: {
    identity: 'CID-NEVER-DISPLAYED',
    display_name: kind === 'room_msg' ? 'Secretary' : 'Room',
    role: kind === 'room_msg' ? 'Secretary' : 'room',
  },
  text,
  ...extra,
});

const conversations = {
  PEER: [
    { dir: 'in', text: ordinarySource, date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'ORDINARY', receipt: null },
    { dir: 'in', text: oversizedSource, date: '2026-08-15T00:01:00.000Z', read: true, wire_id: 'OVERSIZED', receipt: null },
  ],
  ROOM: [
    {
      dir: 'in',
      text: roomBody('room_msg', '## Pair result\n**approved**\n1. security\n2. evidence'),
      date: '2026-08-15T00:02:00.000Z', read: true, wire_id: 'ROOM-CHAT', receipt: null,
    },
    {
      dir: 'in',
      text: roomBody(
        'room_role_briefing',
        '# Fleet task\n- audit\n- ship\n\n[blocked](data:text/html,boom) <script>globalThis.roomPwned=true</script>',
        { briefing_role: 'Secretary', briefing_version: 2 },
      ),
      date: '2026-08-15T00:03:00.000Z', read: true, wire_id: 'ROOM-SYSTEM', receipt: null,
    },
  ],
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 900 } });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.2', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [
      { name: 'Peer', container_id: 'PEER' },
      { name: 'ours-cowork-room:release', display_name: 'Release', container_id: 'ROOM' },
    ], pending: [] });
    const pageMatch = /^\/api\/conversations\/(PEER|ROOM)\/page$/.exec(url.pathname);
    if (pageMatch) {
      const messages = conversations[pageMatch[1]];
      return json({ contact: pageMatch[1], messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
    }
    const readMatch = /^\/api\/conversations\/(PEER|ROOM)\/read$/.exec(url.pathname);
    if (readMatch) return json({ contact: readMatch[1], marked: 0 });
    const filesMatch = /^\/api\/conversations\/(PEER|ROOM)\/files$/.exec(url.pathname);
    if (filesMatch) return json({ contact: filesMatch[1], files: [] });
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const ordinary = page.locator('#chat-message-ORDINARY .message-markdown');
  await ordinary.waitFor();

  assert.equal(await ordinary.getAttribute('data-render-mode'), 'markdown', 'ordinary Fleet/tool output takes the Markdown path');
  assert.equal(await ordinary.locator('h1').textContent(), 'Tool result');
  assert.equal(await ordinary.locator('strong').textContent(), 'done');
  assert.equal(await ordinary.locator('em').textContent(), 'reviewed');
  assert.equal(await ordinary.locator('li').count(), 2);
  assert.equal(await ordinary.locator('pre code').textContent(), '<script>globalThis.pwned = true</script>\n');

  const goodLink = ordinary.locator('a', { hasText: 'safe' });
  assert.equal(await goodLink.getAttribute('href'), 'https://example.com/evidence');
  assert.equal(await goodLink.getAttribute('target'), '_blank');
  assert.equal(await goodLink.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await ordinary.locator('a', { hasText: 'unsafe' }).count(), 0, 'active URL schemes are inert');
  assert.equal(await ordinary.locator('img').count(), 0, 'Markdown and raw HTML cannot load an image');
  assert.equal(await ordinary.locator('.message-image-placeholder').textContent(), '[image: remote]');
  assert.deepEqual(await page.evaluate(() => ({ pwned: globalThis.pwned, roomPwned: globalThis.roomPwned })),
    { pwned: undefined, roomPwned: undefined });

  const visual = await ordinary.evaluate((root) => {
    const heading = root.querySelector('h1');
    const body = root.querySelector('p');
    const soft = [...root.querySelectorAll('p')].find((node) => node.textContent?.startsWith('soft line'));
    const hard = [...root.querySelectorAll('p')].find((node) => node.textContent?.startsWith('hard line'));
    const lineTops = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map((rect) => Math.round(rect.top * 10) / 10)
        .filter((top, index, all) => index === 0 || Math.abs(top - all[index - 1]) > 0.5);
    };
    return {
      headingSize: parseFloat(getComputedStyle(heading).fontSize),
      headingWeight: Number.parseInt(getComputedStyle(heading).fontWeight, 10),
      bodySize: parseFloat(getComputedStyle(body).fontSize),
      headingHeight: heading.getBoundingClientRect().height,
      bodyHeight: body.getBoundingClientRect().height,
      softWhiteSpace: getComputedStyle(soft).whiteSpace,
      softLineTops: lineTops(soft),
      hardLineTops: lineTops(hard),
      hardBreaks: hard.querySelectorAll('br').length,
    };
  });
  assert.ok(visual.headingSize > visual.bodySize && visual.headingWeight >= 700,
    `shipped CSS makes headings visually distinct (${JSON.stringify(visual)})`);
  assert.ok(visual.headingHeight > 0 && visual.bodyHeight > 0, 'heading and body occupy visible geometry');
  assert.equal(visual.softWhiteSpace, 'pre-wrap', 'shipped CSS preserves CommonMark soft line breaks');
  assert.ok(visual.softLineTops.length >= 2, `soft break paints on separate lines (${visual.softLineTops})`);
  assert.equal(visual.hardBreaks, 1, 'hard break emits exactly one br');
  assert.ok(visual.hardLineTops.length >= 2, `hard break paints on separate lines (${visual.hardLineTops})`);

  const oversized = page.locator('#chat-message-OVERSIZED .message-markdown');
  await oversized.waitFor();
  assert.equal(await oversized.getAttribute('data-render-mode'), 'plaintext');
  assert.equal(await oversized.textContent(), oversizedSource, 'oversized direct input is lossless and literal');
  assert.equal(await oversized.locator('h1').count(), 0, 'oversized Markdown is not parsed');
  const overflow = await oversized.evaluate((node) => ({
    whiteSpace: getComputedStyle(node).whiteSpace,
    overflowWrap: getComputedStyle(node).overflowWrap,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    selected: (() => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })(),
  }));
  assert.equal(overflow.whiteSpace, 'pre-wrap');
  assert.equal(overflow.overflowWrap, 'anywhere');
  assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, `long text wraps instead of overflowing (${JSON.stringify(overflow)})`);
  assert.equal(overflow.selected, oversizedSource, 'native selection/copy text remains the complete plaintext source');

  await page.goto(`${origin}/chats/ROOM`, { waitUntil: 'domcontentloaded' });
  const roomChat = page.locator('#chat-message-ROOM-CHAT .message-markdown');
  await roomChat.waitFor();
  assert.equal(await roomChat.locator('h2').textContent(), 'Pair result');
  assert.equal(await roomChat.locator('strong').textContent(), 'approved');
  assert.deepEqual(await roomChat.locator('li').allTextContents(), ['security', 'evidence']);
  assert.equal(await page.locator('#chat-message-ROOM-CHAT .room-author-name').textContent(), 'Secretary');

  const system = page.locator('#chat-message-ROOM-SYSTEM .room-system');
  await system.waitFor();
  assert.equal(await system.getAttribute('role'), 'note');
  assert.equal(await system.locator('.room-system-label').textContent(), 'Role briefing · Secretary · v2');
  assert.equal(await system.locator('.room-system-text h1').textContent(), 'Fleet task');
  assert.deepEqual(await system.locator('.room-system-text li').allTextContents(), ['audit', 'ship']);
  assert.equal(await system.locator('.room-system-text a').count(), 0, 'hostile Fleet-system URLs stay inert');
  assert.equal(await system.locator('.room-system-at').count(), 1, 'the timestamp remains separate from rendered body content');
  assert.equal((await system.textContent()).includes('CID-NEVER-DISPLAYED'), false);
  assert.equal(await page.evaluate(() => globalThis.roomPwned), undefined, 'room-system raw HTML never executes');
  assert.equal(remoteImageRequests, 0, 'remote Markdown images never issue a request');

  await context.close();
} finally {
  await browser.close();
  server.close();
}

console.log('browser-message-markdown OK — built ordinary/tool, room result, Fleet system, hostile, CSS, and long-input paths');
