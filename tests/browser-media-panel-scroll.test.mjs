// The shared-media panel must scroll its own list instead of growing until the
// dialog outgrows the screen. This gate drives the real bundle in a real
// browser with more files and photos than fit, on a tall and a short viewport,
// and asserts the modal stays inside the viewport while the list scrolls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the media panel gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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

// Enough of each kind that no reasonable dialog height could hold them all.
const FILE_COUNT = 40;
const PHOTO_COUNT = 36;
const LINK_COUNT = 30;

const media = [
  ...Array.from({ length: FILE_COUNT }, (_, index) => ({
    wire_id: `FILE-${index}`,
    contact_id: 'PEER',
    dir: index % 2 === 0 ? 'in' : 'out',
    sender_id: 'PEER', sender_name: 'Peer',
    filename: `quarterly-report-${index}.pdf`,
    logical_name: `quarterly-report-${index}.pdf`,
    version: 1,
    mime: 'application/pdf',
    size: 4096,
    sha256: null,
    date: new Date(Date.UTC(2026, 7, 15, 1, index)).toISOString(),
    date_source: 'protocol',
    kind: 'file',
    reply_to: null,
    available: true,
  })),
  ...Array.from({ length: PHOTO_COUNT }, (_, index) => ({
    wire_id: `PHOTO-${index}`,
    contact_id: 'PEER',
    dir: 'in',
    sender_id: 'PEER', sender_name: 'Peer',
    filename: `snapshot-${index}.png`,
    logical_name: `snapshot-${index}.png`,
    version: 1,
    mime: 'image/png',
    size: 2048,
    sha256: null,
    date: new Date(Date.UTC(2026, 7, 15, 3, index)).toISOString(),
    date_source: 'protocol',
    kind: 'photo',
    reply_to: null,
    available: true,
  })),
];

const conversationMessages = Array.from({ length: LINK_COUNT }, (_, index) => ({
  dir: 'in',
  text: `shared reading ${index} https://example.com/a-fairly-long-article-path/${index}`,
  date: new Date(Date.UTC(2026, 7, 15, 5, index)).toISOString(),
  read: true,
  wire_id: `LINK-${index}`,
  receipt: null,
}));

const measure = async (page) => page.evaluate(() => {
  const modal = document.querySelector('.shared-media-modal');
  const body = document.querySelector('.shared-media-modal .modal-body');
  const list = document.querySelector('.shared-media-list');
  const box = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height),
      clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
    };
  };
  return {
    viewport: window.innerHeight,
    docScrollHeight: document.documentElement.scrollHeight,
    modal: box(modal),
    body: box(body),
    list: box(list),
    items: document.querySelectorAll('.shared-media-list .shared-media-item, .shared-media-list .file-version-stack').length,
  };
});

const report = [];

const check = (label, m, { expectItems }) => {
  const lines = [
    `[${label}] viewport=${m.viewport} modal=${m.modal?.top}..${m.modal?.bottom} (h=${m.modal?.height})`,
    `[${label}] list client=${m.list?.clientHeight} scroll=${m.list?.scrollHeight} overflowY=${m.list?.overflowY} items=${m.items}`,
  ];
  console.log(lines.join('\n'));
  report.push(...lines);

  assert.ok(m.items >= expectItems, `[${label}] expected at least ${expectItems} rows rendered, saw ${m.items}`);

  // 1. The dialog must stay on screen. A panel that grows past the viewport is
  //    the reported "layout breaks" symptom.
  assert.ok(m.modal.top >= -1, `[${label}] modal top escaped the viewport (${m.modal.top}px)`);
  assert.ok(m.modal.bottom <= m.viewport + 1,
    `[${label}] modal bottom escaped the viewport (${m.modal.bottom}px vs ${m.viewport}px)`);

  // 2. The page itself must not grow a scrollbar to accommodate the dialog.
  assert.ok(m.docScrollHeight <= m.viewport + 1,
    `[${label}] the document grew past the viewport (${m.docScrollHeight}px vs ${m.viewport}px)`);

  // 3. The list must be the scroll container, and it must actually overflow —
  //    otherwise the rows were crammed rather than scrolled.
  assert.equal(m.list.overflowY, 'auto', `[${label}] the list is not a scroll container`);
  assert.ok(m.list.clientHeight > 0, `[${label}] the list has no height`);
  assert.ok(m.list.scrollHeight > m.list.clientHeight + 1,
    `[${label}] the list did not overflow: scrollHeight ${m.list.scrollHeight} vs clientHeight ${m.list.clientHeight}`);
  assert.ok(m.list.bottom <= m.modal.bottom + 1,
    `[${label}] the list spills past the dialog (${m.list.bottom}px vs ${m.modal.bottom}px)`);
};

const scrolls = async (page, label) => {
  const moved = await page.evaluate(() => {
    const list = document.querySelector('.shared-media-list');
    list.scrollTop = 0;
    const before = list.scrollTop;
    list.scrollTop = list.scrollHeight;
    return { before, after: list.scrollTop, max: list.scrollHeight - list.clientHeight };
  });
  const line = `[${label}] scrollTop ${moved.before} -> ${moved.after} (max ${moved.max})`;
  console.log(line);
  report.push(line);
  assert.ok(moved.after > moved.before, `[${label}] the list did not scroll`);
};

try {
  for (const [label, viewport] of [
    ['tall', { width: 1280, height: 900 }],
    ['short', { width: 1280, height: 560 }],
    ['mobile', { width: 390, height: 720 }],
  ]) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport });
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
      if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
      if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
      if (url.pathname === '/api/conversations/PEER/page') {
        return json({
          contact: 'PEER', messages: conversationMessages,
          total: conversationMessages.length, unread: 0, hasMore: false, nextBefore: null,
        });
      }
      if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
      if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: media });
      if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      return json({}, 404);
    });

    const page = await context.newPage();
    await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Open contact details/ }).click();
    await page.getByRole('button', { name: /Shared photos, files, and links/ }).click();
    await page.locator('.shared-media-modal').waitFor();
    await page.locator('.shared-media-list').waitFor();
    await page.waitForTimeout(350);

    // Photos tab is the default: a grid with align-content:start.
    check(`${label}/photos`, await measure(page), { expectItems: PHOTO_COUNT });
    await scrolls(page, `${label}/photos`);

    for (const [tab, expected] of [['Files', 1], ['Links', LINK_COUNT]]) {
      await page.locator('.shared-media-tabs').getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await page.waitForTimeout(250);
      check(`${label}/${tab.toLowerCase()}`, await measure(page), { expectItems: expected });
      await scrolls(page, `${label}/${tab.toLowerCase()}`);
    }

    await context.close();
  }

  console.log('browser-media-panel-scroll OK — the shared-media list scrolls and the dialog stays inside the viewport');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
