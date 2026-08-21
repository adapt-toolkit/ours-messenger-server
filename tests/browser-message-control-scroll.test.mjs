// Message controls may update their bubble or resize the conversation viewport,
// but neither is permission to move a reader's anchor. This gate uses the real
// built timeline, a real voice bubble, and the ordinary Reply control.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(process.env.OURS_BROWSER_WEB_ROOT ?? new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the message-control scroll gate');

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

const history = Array.from({ length: 48 }, (_, index) => ({
  dir: index % 2 === 0 ? 'in' : 'out',
  text: `history line ${index} — ${'enough text to wrap this message '.repeat(2)}`,
  date: new Date(Date.UTC(2026, 7, 15, 0, index)).toISOString(),
  read: true,
  wire_id: `WIRE-${index}`,
  receipt: null,
}));

const voiceHistory = {
  wire_id: 'VOICE-HISTORY', contact_id: 'PEER', dir: 'in', filename: 'voice-message-fixture.wav',
  mime: 'audio/wav;x-ours-kind=voice-message;x-ours-duration=2', size: 44,
  date: new Date(Date.UTC(2026, 7, 15, 0, 23, 30)).toISOString(), available: true,
};
const voiceLatest = {
  ...voiceHistory,
  wire_id: 'VOICE-LATEST',
  date: new Date(Date.UTC(2026, 7, 15, 1, 0)).toISOString(),
};

const measure = (page, rowId) => page.evaluate((id) => {
  const scroller = document.querySelector('.messages');
  const row = document.getElementById(id);
  const rowRect = row.getBoundingClientRect();
  return {
    top: scroller.scrollTop,
    distance: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
    rowTop: rowRect.top,
    rowBottom: rowRect.bottom,
  };
}, rowId);

const afterLayout = (page) => page.evaluate(() => new Promise((resolveFrame) => {
  requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
}));

try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('ours-dark-v3', '0');
    // Playback state is the behavior under test; synthetic fixture bytes need
    // not depend on a host audio device or codec.
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause() {
      this.dispatchEvent(new Event('pause'));
    };
  });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      return json({ contact: 'PEER', messages: history, total: history.length, unread: 0, hasMore: false, nextBefore: null });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [voiceHistory, voiceLatest] });
    if (url.pathname.startsWith('/api/media/VOICE-')) return route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.alloc(44) });
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const voiceRow = page.locator('#chat-message-VOICE-HISTORY');
  await voiceRow.waitFor();
  await page.locator('#chat-message-VOICE-LATEST audio').waitFor({ state: 'attached' });
  await page.waitForFunction(() => [...document.querySelectorAll('.message-motion')].every((node) => {
    const style = getComputedStyle(node);
    return style.opacity === '1' && style.transform === 'none';
  }));
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.messages');
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2;
  });

  // Voice playback changes component state (play -> pause) while reading
  // history. The same message must remain under the reader's eye.
  await voiceRow.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await afterLayout(page);
  const beforeVoice = await measure(page, 'chat-message-VOICE-HISTORY');
  await voiceRow.locator('.voice-play').click();
  await page.waitForFunction(() => document.querySelector('#chat-message-VOICE-HISTORY .voice-play')?.getAttribute('title') === 'Pause');
  const afterVoice = await measure(page, 'chat-message-VOICE-HISTORY');

  // A non-audio message control can resize the composer. A reader in history
  // keeps the same anchor rather than being treated as pinned.
  const historyRow = page.locator('#chat-message-WIRE-20');
  await historyRow.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await afterLayout(page);
  const beforeHistoryReply = await measure(page, 'chat-message-WIRE-20');
  await historyRow.hover();
  await historyRow.locator('.msg-reply').click();
  await page.getByText('Replying to', { exact: false }).waitFor();
  await afterLayout(page);
  const afterHistoryReply = await measure(page, 'chat-message-WIRE-20');
  await page.getByTitle('Cancel reply').click();
  await afterLayout(page);

  // Mobile browser/media chrome can change the conversation viewport as a
  // voice control is activated without changing message content. Model that
  // external resize directly: a pinned reader still follows the newest voice.
  await page.evaluate(() => {
    const scroller = document.querySelector('.messages');
    scroller.scrollTop = scroller.scrollHeight;
  });
  await afterLayout(page);
  const latestVoice = page.locator('#chat-message-VOICE-LATEST');
  const beforePinnedVoice = await measure(page, 'chat-message-VOICE-LATEST');
  await latestVoice.locator('.voice-play').click();
  await page.waitForFunction(() => document.querySelector('#chat-message-VOICE-LATEST .voice-play')?.getAttribute('title') === 'Pause');
  await page.setViewportSize({ width: 1280, height: 720 });
  await afterLayout(page);
  const afterPinnedVoice = await measure(page, 'chat-message-VOICE-LATEST');

  // Restore the viewport and deliberately establish the bottom precondition
  // again so the Reply measurement is independent of the voice measurement.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const scroller = document.querySelector('.messages');
    scroller.scrollTop = scroller.scrollHeight;
  });
  await afterLayout(page);

  // The same viewport resize has the opposite invariant at the bottom: remain
  // pinned to the newest message instead of exposing an older slice.
  const newest = page.locator('#chat-message-VOICE-LATEST');
  const beforePinnedReply = await measure(page, 'chat-message-VOICE-LATEST');
  await newest.hover();
  await newest.locator('.msg-reply').click();
  await page.getByText('Replying to', { exact: false }).waitFor();
  await afterLayout(page);
  const afterPinnedReply = await measure(page, 'chat-message-VOICE-LATEST');

  const deltas = {
    voiceHistoryScrollTop: afterVoice.top - beforeVoice.top,
    voiceHistoryRowTop: afterVoice.rowTop - beforeVoice.rowTop,
    replyHistoryScrollTop: afterHistoryReply.top - beforeHistoryReply.top,
    replyHistoryRowTop: afterHistoryReply.rowTop - beforeHistoryReply.rowTop,
    voicePinnedDistance: `${beforePinnedVoice.distance} -> ${afterPinnedVoice.distance}`,
    replyPinnedDistance: `${beforePinnedReply.distance} -> ${afterPinnedReply.distance}`,
  };
  console.log(`browser-message-control-scroll measurements ${JSON.stringify(deltas)}`);

  assert.ok(Math.abs(afterVoice.top - beforeVoice.top) <= 2,
    `voice playback must preserve scrollTop (${beforeVoice.top} -> ${afterVoice.top})`);
  assert.ok(Math.abs(afterVoice.rowTop - beforeVoice.rowTop) <= 2,
    `voice playback must preserve the visible message anchor (${beforeVoice.rowTop} -> ${afterVoice.rowTop})`);
  assert.ok(Math.abs(afterHistoryReply.top - beforeHistoryReply.top) <= 2,
    `Reply must preserve a scrolled-up reader's scrollTop (${beforeHistoryReply.top} -> ${afterHistoryReply.top})`);
  assert.ok(Math.abs(afterHistoryReply.rowTop - beforeHistoryReply.rowTop) <= 2,
    `Reply must preserve a scrolled-up reader's anchor (${beforeHistoryReply.rowTop} -> ${afterHistoryReply.rowTop})`);
  assert.ok(afterPinnedVoice.distance <= 2,
    `a pinned reader stays at the newest voice after its viewport resizes (${afterPinnedVoice.distance}px away)`);
  assert.ok(afterPinnedReply.distance <= 2,
    `a pinned reader stays at the newest message after Reply (${afterPinnedReply.distance}px away)`);

  await context.close();
  console.log('browser-message-control-scroll OK — voice and Reply preserve history anchors; viewport resize remains pinned');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
