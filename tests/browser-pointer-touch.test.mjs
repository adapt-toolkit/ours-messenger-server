import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the pointer/touch browser gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
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
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const messages = Array.from({ length: 28 }, (_, index) => ({
  dir: index % 2 ? 'out' : 'in',
  text: `touch fixture ${index}`,
  date: new Date(Date.UTC(2026, 7, 26, 8, index)).toISOString(),
  read: true,
  wire_id: `TOUCH-${index}`,
  receipt: null,
}));

const installRoutes = async (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({
    contacts: [{ name: 'Peer', container_id: 'PEER' }],
    pending: [{ name: 'Waiting', container_id: 'WAITING', queued: 2 }],
  });
  if (url.pathname === '/api/conversations/PEER/page') return json({
    contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null,
  });
  if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
  if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
  if (url.pathname === '/api/events') return route.fallback();
  return json({}, 404);
});

const touch = async (session, type, x, y) => session.send('Input.dispatchTouchEvent', {
  type,
  touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ id: 1, x, y }],
});

const pen = async (session, type, x, y) => session.send('Input.dispatchMouseEvent', {
  type,
  x,
  y,
  button: type === 'mouseMoved' ? 'none' : 'left',
  buttons: type === 'mouseReleased' ? 0 : 1,
  pointerType: 'pen',
  clickCount: 1,
});

const styleOf = (locator) => locator.evaluate((node) => {
  const style = getComputedStyle(node);
  return { transform: style.transform, background: style.backgroundColor };
});

try {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await installRoutes(context);
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const incoming = page.locator('#chat-message-TOUCH-26 .msg-row');
  await incoming.waitFor();
  await page.evaluate(() => {
    globalThis.__pointerId = -1;
    document.addEventListener('pointerdown', (event) => { globalThis.__pointerId = event.pointerId; }, true);
    // Narrow only the test target so a horizontal pointer can genuinely leave
    // its bounds while remaining inside the viewport.
    document.querySelector('#chat-message-TOUCH-26 .msg-row').style.width = '150px';
  });

  const point = await incoming.boundingBox();
  assert.ok(point);
  const x = Math.min(110, point.x + 70);
  const y = point.y + point.height / 2;
  const outsideX = point.x + point.width + 10;

  // Horizontal intent captures; subsequent movement outside the row still
  // tracks and an armed release commits exactly one reply.
  await pen(session, 'mousePressed', x, y);
  await pen(session, 'mouseMoved', x + 18, y);
  await page.waitForFunction(() => document.querySelector('#chat-message-TOUCH-26 .msg-row')?.hasPointerCapture(globalThis.__pointerId));
  const outsideY = y;
  await pen(session, 'mouseMoved', outsideX, outsideY);
  await page.waitForTimeout(80);
  assert.equal(outsideX > point.x + point.width, true, 'pointer coordinate is outside the owning row');
  await pen(session, 'mouseReleased', outsideX, outsideY);
  await page.getByText('Replying to Peer', { exact: true }).waitFor();
  assert.equal(await page.getByText('Replying to Peer', { exact: true }).count(), 1, 'captured release commits once');
  await page.getByTitle('Cancel reply').click();

  const clean = async (label) => {
    assert.equal(await incoming.locator('.bubble-wrap.swiping').count(), 0, `${label}: swiping class cleared`);
    assert.equal(await incoming.locator('.swipe-cue.armed').count(), 0, `${label}: armed cue cleared`);
    assert.equal(await incoming.locator('.bubble-wrap').evaluate((node) => node.style.transform), '', `${label}: transform cleared`);
  };

  // Arm, retreat below threshold, and release: drag-away/back cancels.
  await pen(session, 'mousePressed', x, y);
  await pen(session, 'mouseMoved', x + 70, y);
  await pen(session, 'mouseMoved', x + 20, y);
  await pen(session, 'mouseReleased', x + 20, y);
  assert.equal(await page.getByText('Replying to Peer', { exact: true }).count(), 0);
  await clean('retreat');

  // pointercancel and explicit capture loss are cancellation-only and leave no
  // presentation residue. Explicit release also proves lost-capture idempotence.
  await pen(session, 'mousePressed', x, y);
  await pen(session, 'mouseMoved', x + 70, y);
  await incoming.dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => globalThis.__pointerId), pointerType: 'pen', bubbles: true });
  await pen(session, 'mouseReleased', x + 70, y);
  await clean('pointercancel');
  await touch(session, 'touchStart', x, y);
  await touch(session, 'touchMove', x + 18, y);
  await page.waitForFunction(() => document.querySelector('#chat-message-TOUCH-26 .msg-row')?.hasPointerCapture(globalThis.__pointerId));
  // Chromium transfers the touch back to native pan-y handling on this
  // diagonal continuation, producing a real lostpointercapture event.
  await touch(session, 'touchMove', x + 70, point.y + point.height + 8);
  await page.waitForFunction(() => !document.querySelector('#chat-message-TOUCH-26 .bubble-wrap')?.classList.contains('swiping'));
  await clean('lostpointercapture');
  await touch(session, 'touchEnd', x + 70, point.y + point.height + 8);
  assert.equal(await page.getByText('Replying to Peer', { exact: true }).count(), 0, 'lost capture never commits later');

  // A vertical gesture remains browser-owned and moves the real scroller.
  const scroller = page.locator('.messages');
  await scroller.evaluate((node) => { node.scrollTop = Math.round(node.scrollHeight / 2); });
  const beforeScroll = await scroller.evaluate((node) => node.scrollTop);
  await touch(session, 'touchStart', x, y);
  await touch(session, 'touchMove', x + 2, y - 90);
  await touch(session, 'touchEnd', x + 2, y - 90);
  await page.waitForTimeout(250);
  const afterScroll = await scroller.evaluate((node) => node.scrollTop);
  assert.ok(afterScroll > beforeScroll + 10, `vertical path scrolls natively (${beforeScroll} -> ${afterScroll})`);
  await clean('vertical scroll');

  // Coarse-pointer primary controls expose 44px boxes without overflow.
  const seekTarget = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:280px;z-index:-1';
    host.innerHTML = '<div class="bubble voice-bubble"><button class="voice-play">Play</button><div class="voice-track seekable has-wave"><div class="voice-wave"><span class="voice-wave-bar" style="height:100%"></span></div><div class="voice-track-fill" style="width:50%"></div></div><span class="voice-dur">0:10</span></div>';
    document.body.append(host);
    const track = host.querySelector('.voice-track');
    const wave = host.querySelector('.voice-wave');
    const play = host.querySelector('.voice-play');
    return {
      trackHeight: track.getBoundingClientRect().height,
      waveHeight: wave.getBoundingClientRect().height,
      playWidth: play.getBoundingClientRect().width,
      playHeight: play.getBoundingClientRect().height,
    };
  });
  assert.ok(seekTarget.trackHeight >= 44, `seek wrapper exposes a 44px hit box (${seekTarget.trackHeight}px)`);
  assert.ok(seekTarget.waveHeight <= 34.5, `waveform remains visually compact (${seekTarget.waveHeight}px)`);
  assert.ok(seekTarget.playWidth >= 44 && seekTarget.playHeight >= 44, 'playback button exposes a 44x44 hit box');

  await page.getByTitle('Shared photos, files, and links').click();
  const sharedTabs = page.getByRole('tablist', { name: 'Shared media type' }).getByRole('tab');
  assert.equal(await sharedTabs.count(), 3);
  for (const tab of await sharedTabs.all()) {
    assert.match(await tab.getAttribute('class'), /\btab\b/, 'shared primitive emits its stable tab selector');
    const box = await tab.boundingBox();
    assert.ok(box && box.width >= 43.9 && box.height >= 43.9, `shared-media tab is at least 44x44 (${box?.width}x${box?.height})`);
  }
  const filesTab = page.getByRole('tab', { name: /Files/ });
  const filesBox = await filesTab.boundingBox();
  const tabRest = await styleOf(filesTab);
  await pen(session, 'mousePressed', filesBox.x + 20, filesBox.y + 20);
  await page.waitForTimeout(50);
  const tabPressed = await styleOf(filesTab);
  assert.notEqual(tabPressed.transform, tabRest.transform, 'real tab has immediate geometric press feedback');
  assert.notEqual(tabPressed.background, tabRest.background, 'real tab has immediate surface press feedback');
  await pen(session, 'mouseReleased', filesBox.x + 20, filesBox.y + 20);
  await pen(session, 'mouseMoved', 1, 1);
  await page.waitForTimeout(200);
  const tabReleased = await styleOf(filesTab);
  assert.equal(tabReleased.transform, tabRest.transform, 'real tab release removes geometric feedback');
  assert.notEqual(tabReleased.background, tabPressed.background, 'real tab release settles into its selected surface');
  await page.getByRole('button', { name: 'Close Shared media' }).click();

  const targetSelectors = ['.detail-back', '.conv-actions .btn', '.composer-tool', '.vr-mic', '.composer .btn.primary'];
  for (const selector of targetSelectors) {
    const target = page.locator(selector).first();
    await target.waitFor();
    const box = await target.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, `${selector} is at least 44x44 (${box?.width}x${box?.height})`);
  }
  await page.locator('.detail-back').click();
  const pendingActions = page.getByText('Waiting', { exact: true }).locator('xpath=ancestor::div[contains(@class,"contact-row")]').getByRole('button');
  assert.equal(await pendingActions.count(), 2);
  for (const action of await pendingActions.all()) {
    const box = await action.boundingBox();
    assert.ok(box && box.width >= 43.9 && box.height >= 43.9, `pending action is at least 44x44 (${box?.width}x${box?.height})`);
  }
  await page.getByRole('button', { name: 'Invite' }).click();
  const inviteTabs = page.getByRole('tablist', { name: 'Invite mode' }).getByRole('tab');
  assert.equal(await inviteTabs.count(), 2);
  for (const tab of await inviteTabs.all()) {
    assert.match(await tab.getAttribute('class'), /\btab\b/, 'invite primitive emits its stable tab selector');
    const box = await tab.boundingBox();
    assert.ok(box && box.width >= 43.9 && box.height >= 43.9, `invite tab is at least 44x44 (${box?.width}x${box?.height})`);
    assert.notEqual((await tab.evaluate((node) => getComputedStyle(node).appearance)), 'auto', 'invite tab has intentional base appearance');
  }
  await page.getByRole('button', { name: 'Close Invite a contact' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '390px controls do not overflow');
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '320px controls do not overflow');

  // Enabled controls change immediately on down and settle on release;
  // disabled controls do not acquire the pressed presentation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.contact-row:not(.pending)').click();
  const attach = page.locator('.composer-tool:not(.vr-mic)');
  const attachBox = await attach.boundingBox();
  const rest = await styleOf(attach);
  await pen(session, 'mousePressed', attachBox.x + 20, attachBox.y + 20);
  await page.waitForTimeout(50);
  const pressed = await styleOf(attach);
  assert.notEqual(pressed.transform, rest.transform, 'press applies immediate geometric feedback');
  assert.notEqual(pressed.background, rest.background, 'press applies immediate surface feedback');
  await pen(session, 'mouseReleased', attachBox.x + 20, attachBox.y + 20);
  await pen(session, 'mouseMoved', 1, 1);
  await page.waitForTimeout(200);
  assert.deepEqual(await styleOf(attach), rest, 'release restores the resting presentation');
  const send = page.locator('.composer .btn.primary');
  assert.equal(await send.isDisabled(), true);
  const disabledRest = await styleOf(send);
  const sendBox = await send.boundingBox();
  await pen(session, 'mousePressed', sendBox.x + 20, sendBox.y + 20);
  assert.deepEqual(await styleOf(send), disabledRest, 'disabled control has no pressed state');
  await pen(session, 'mouseReleased', sendBox.x + 20, sendBox.y + 20);
  await context.close();

  const reduceContext = await browser.newContext({ hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await installRoutes(reduceContext);
  const reducePage = await reduceContext.newPage();
  const reduceSession = await reduceContext.newCDPSession(reducePage);
  await reducePage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const reduceAttach = reducePage.locator('.composer-tool:not(.vr-mic)');
  await reduceAttach.waitFor();
  const reduceBox = await reduceAttach.boundingBox();
  const reduceRest = await styleOf(reduceAttach);
  await pen(reduceSession, 'mousePressed', reduceBox.x + 20, reduceBox.y + 20);
  await reducePage.waitForTimeout(50);
  const reducePressed = await styleOf(reduceAttach);
  assert.equal(reducePressed.transform, reduceRest.transform, 'reduced motion removes geometric press feedback');
  assert.notEqual(reducePressed.background, reduceRest.background, 'reduced motion retains visible surface feedback');
  await pen(reduceSession, 'mouseReleased', reduceBox.x + 20, reduceBox.y + 20);
  await reduceContext.close();

  console.log('browser-pointer-touch OK — capture cleanup, native vertical scroll, coarse targets, and press feedback');
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
