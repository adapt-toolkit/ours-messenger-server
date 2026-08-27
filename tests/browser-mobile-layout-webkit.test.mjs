import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the mobile WebKit gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': open\n\n');
    streams.add(response); response.on('close', () => streams.delete(response)); return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream' }); response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address(); assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const messages = [
  { dir: 'in', text: `Long ${'C'.repeat(180)} https://example.com/action`, date: '2026-08-26T08:00:00Z', read: true, wire_id: 'MOBILE-IN', receipt: null },
  { dir: 'out', text: 'outgoing reply target', date: '2026-08-26T08:01:00Z', read: true, wire_id: 'MOBILE-OUT', receipt: null },
];
const installRoutes = (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({
    contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [],
    roots: { PEER: { root_cid: 'ROOT', root_name: 'Owner', role_id: 'assistant' } },
  });
  if (url.pathname === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages, total: 2, unread: 0, hasMore: false, nextBefore: null });
  if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
  if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
  if (url.pathname === '/api/events') return route.fallback();
  return json({}, 404);
});
const installCaptureHarness = (page) => page.addInitScript(() => {
  const held = new WeakMap();
  Element.prototype.setPointerCapture = function (id) { held.set(this, id); };
  Element.prototype.hasPointerCapture = function (id) { return held.get(this) === id; };
  Element.prototype.releasePointerCapture = function (id) { if (held.get(this) === id) held.delete(this); };
});
const settleAnimations = (page) => page.evaluate(() => document.getAnimations().forEach((animation) => {
  const endTime = animation.effect?.getComputedTiming().endTime;
  try {
    if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish();
    else animation.cancel();
  } catch {
    animation.cancel();
  }
}));
const fireGesture = (row, points, downTargetSelector) => row.evaluate((node, { points: path, downTarget }) => {
  const fire = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
    button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
  }));
  const target = downTarget ? node.querySelector(downTarget) : node;
  fire(target, 'pointerdown', path[0][0], path[0][1]);
  for (const [x, y] of path.slice(1)) fire(node, 'pointermove', x, y);
  const last = path.at(-1); fire(node, 'pointerup', last[0], last[1]);
}, { points, downTarget: downTargetSelector });
const fireNativeTouch = async (page, selector, direction) => {
  const row = page.locator(selector);
  const bubble = row.locator('.message-markdown p').first();
  const box = await bubble.boundingBox();
  assert.ok(box, `${selector} has a native-touch target`);
  const x0 = direction > 0 ? box.x + Math.min(24, box.width / 3) : box.x + box.width - Math.min(24, box.width / 3);
  const y = box.y + box.height / 2;
  await row.evaluate((node) => {
    globalThis.__nativeSwipeEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, (event) => {
      globalThis.__nativeSwipeEvents.push({ type, pointerType: event.pointerType, button: event.button, buttons: event.buttons });
    }, { once: type === 'pointerdown' });
  });
  const session = await page.context().newCDPSession(page);
  const point = (x) => [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x0) });
  for (const distance of [12, 28, 48, 72]) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x0 + direction * distance) });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  return page.evaluate(() => globalThis.__nativeSwipeEvents);
};

try {
  const requestedEngines = new Set((process.env.MOBILE_BROWSER_ENGINES ?? 'chromium,webkit').split(','));
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) => requestedEngines.has(name))) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 375, height: 812 } });
      await installRoutes(context); const page = await context.newPage(); await installCaptureHarness(page);
      await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); await page.locator('.composer textarea').waitFor();
      await settleAnimations(page);
      for (const viewport of [{ width: 320, height: 700 }, { width: 375, height: 812 }, { width: 430, height: 932 }, { width: 844, height: 390 }, { width: 375, height: 500 }]) {
        await page.setViewportSize(viewport);
        const geometry = await page.evaluate(() => {
          const stage = document.querySelector('.signal-stage').getBoundingClientRect();
          const detail = document.querySelector('.signal-stage > .detail').getBoundingClientRect();
          return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
            visualWidth: visualViewport?.width ?? innerWidth, left: detail.left - stage.left, right: stage.right - detail.right };
        });
        assert.equal(geometry.scrollWidth, geometry.clientWidth, `${engineName} ${viewport.width} has no document overflow`);
        assert.ok(Math.abs(geometry.clientWidth - geometry.visualWidth) < 1, `${engineName} layout matches visual viewport`);
        assert.ok(geometry.left >= 8 && geometry.right >= 8 && Math.abs(geometry.left - geometry.right) < 1,
          `${engineName} ${viewport.width} edges symmetric (${geometry.left}/${geometry.right})`);
      }
      await page.setViewportSize({ width: 375, height: 812 });
      const micGeometry = await page.locator('.composer .vr-mic').evaluate((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      });
      assert.ok(micGeometry.width >= 44 && micGeometry.height >= 44, `${engineName} empty composer microphone target is 44x44`);
      await page.locator('.composer textarea').fill('Ready to send');
      const sendGeometry = await page.locator('.composer .btn.primary').evaluate((button) => {
        const box = button.getBoundingClientRect(); const icon = button.querySelector('.ic').getBoundingClientRect();
        return { width: box.width, height: box.height, delta: Math.abs((icon.left + icon.width / 2) - (box.left + box.width / 2)), label: getComputedStyle(button.querySelector('.btn-label')).display };
      });
      assert.ok(sendGeometry.width >= 44 && sendGeometry.height >= 44, `${engineName} send target is 44x44`);
      assert.ok(sendGeometry.delta < 0.1, `${engineName} send icon centered (${sendGeometry.delta}px)`);
      assert.equal(sendGeometry.label, 'none', `${engineName} compact label removed`);
      for (const id of ['MOBILE-IN', 'MOBILE-OUT']) {
        const row = page.locator(`#chat-message-${id} .msg-row`); const reply = row.locator('.msg-reply'); const box = await reply.boundingBox();
        const replyStyle = await reply.evaluate((node) => ({ width: parseFloat(getComputedStyle(node).width), height: parseFloat(getComputedStyle(node).height), opacity: Number(getComputedStyle(node).opacity) }));
        assert.ok(box && replyStyle.width >= 44 && replyStyle.height >= 44 && replyStyle.opacity > 0, `${engineName} ${id} visible Reply action (${replyStyle.width}x${replyStyle.height}, opacity ${replyStyle.opacity})`);
        const inward = id === 'MOBILE-IN' ? [[40, 100], [52, 101], [110, 101]] : [[140, 100], [128, 101], [70, 101]];
        await fireGesture(row, inward); await page.getByText('Replying to', { exact: false }).waitFor(); await page.getByTitle('Cancel reply').click();
      }
      const incoming = page.locator('#chat-message-MOBILE-IN .msg-row');
      await fireGesture(incoming, [[40, 100], [38, 170]]);
      assert.equal(await page.getByText('Replying to', { exact: false }).count(), 0, `${engineName} vertical gesture does not reply`);
      await fireGesture(incoming, [[40, 100], [110, 100]], 'a');
      assert.equal(await page.getByText('Replying to', { exact: false }).count(), 0, `${engineName} link does not reply`);
      assert.equal(await incoming.locator('.bubble-wrap').evaluate((node) => node.style.transform), '', `${engineName} gestures settle`);
      if (engineName === 'chromium') {
        for (const [selector, direction] of [['#chat-message-MOBILE-IN .msg-row', 1], ['#chat-message-MOBILE-OUT .msg-row', -1]]) {
          const events = await fireNativeTouch(page, selector, direction);
          await page.getByText('Replying to', { exact: false }).waitFor();
          assert.ok(events.some((event) => event.type === 'pointerdown' && event.pointerType === 'touch'), `${selector} receives native touch pointerdown: ${JSON.stringify(events)}`);
          assert.ok(events.some((event) => event.type === 'pointerup'), `${selector} receives native touch pointerup: ${JSON.stringify(events)}`);
          assert.equal(events.some((event) => event.type === 'pointercancel'), false, `${selector} native inward swipe is not cancelled: ${JSON.stringify(events)}`);
          await page.getByTitle('Cancel reply').click();
        }
      }
      await context.close();

      const reduced = await browser.newContext({ hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block', viewport: { width: 375, height: 812 } });
      await installRoutes(reduced); const reducedPage = await reduced.newPage(); await installCaptureHarness(reducedPage);
      await reducedPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); const reducedRow = reducedPage.locator('#chat-message-MOBILE-IN .msg-row'); await reducedRow.waitFor();
      await fireGesture(reducedRow, [[40, 100], [52, 100], [80, 100]]);
      assert.equal(await reducedRow.locator('.bubble-wrap').evaluate((node) => node.style.transform), '', `${engineName} reduced motion never translates`);
      assert.equal(await reducedRow.locator('.swipe-cue').evaluate((node) => node.style.transform), 'scale(1)', `${engineName} reduced cue does not scale`);
      await reduced.close();

      const light = await browser.newContext({ hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 375, height: 812 } });
      await installRoutes(light);
      await light.addInitScript(() => localStorage.setItem('ours-dark-v3', '0'));
      const lightPage = await light.newPage(); await installCaptureHarness(lightPage);
      await lightPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); await lightPage.locator('.composer textarea').waitFor();
      await lightPage.locator('#chat-message-MOBILE-IN .msg-row').waitFor();
      await lightPage.locator('#chat-message-MOBILE-OUT .msg-row').waitFor();
      await lightPage.locator('.composer textarea').fill('Ready to send');
      await settleAnimations(lightPage);
      const lightMetrics = await lightPage.evaluate(() => {
        const stage = document.querySelector('.signal-stage').getBoundingClientRect();
        const detail = document.querySelector('.signal-stage > .detail').getBoundingClientRect();
        const rows = [...document.querySelectorAll('.msg-row')].map((node) => node.getBoundingClientRect());
        const button = document.querySelector('.composer .btn.primary').getBoundingClientRect();
        const icon = document.querySelector('.composer .btn.primary .ic').getBoundingClientRect();
        return { left: detail.left - stage.left, right: stage.right - detail.right,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          directionGap: rows[1].top - rows[0].bottom, sendDelta: Math.abs((button.left + button.width / 2) - (icon.left + icon.width / 2)) };
      });
      assert.equal(lightMetrics.overflow, 0, `${engineName} light theme has no overflow`);
      assert.ok(lightMetrics.left >= 8 && Math.abs(lightMetrics.left - lightMetrics.right) < 1, `${engineName} light edges remain symmetric (${lightMetrics.left}/${lightMetrics.right})`);
      assert.ok(lightMetrics.directionGap > 0, `${engineName} light incoming/outgoing messages retain a gap (${lightMetrics.directionGap}px)`);
      assert.ok(lightMetrics.sendDelta < 0.1, `${engineName} light compact send remains centered`);
      await light.close();

      for (const dark of [false, true]) {
        const listContext = await browser.newContext({ hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 390, height: 812 } });
        await installRoutes(listContext);
        await listContext.addInitScript(({ useDark }) => {
          localStorage.setItem('ours-dark-v3', useDark ? '1' : '0');
          localStorage.setItem('ours.chats.listMode', 'identity');
        }, { useDark: dark });
        const listPage = await listContext.newPage();
        await listPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });
        await listPage.locator('.contact-row.grouped').waitFor();
        for (const width of [320, 390, 430]) {
          await listPage.setViewportSize({ width, height: 812 });
          for (const textScale of [100, 200]) {
          await listPage.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, textScale);
          const geometry = await listPage.evaluate(() => {
            const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
            const stage = rect('.signal-stage'); const list = rect('.signal-stage > .listcol');
            const head = rect('.listcol-head'); const titlebar = rect('.listcol-titlebar'); const title = rect('.listcol-title');
            const scroll = rect('.listcol-scroll'); const row = rect('.contact-row.grouped');
            const search = rect('.search'); const actionGroup = rect('.listcol-actions');
            const actions = [...document.querySelectorAll('.listcol-actions .btn')].map((node) => {
              const box = node.getBoundingClientRect();
              return { text: node.textContent.trim(), ...box.toJSON(), labelContained: node.scrollWidth <= node.clientWidth };
            });
            return {
              stage: [list.left - stage.left, stage.right - list.right],
              titlebar: [titlebar.left - head.left, head.right - titlebar.right],
              search: [search.left - head.left, head.right - search.right],
              row: [row.left - scroll.left, scroll.right - row.right],
              head: head.toJSON(), title: title.toJSON(), actionGroup: actionGroup.toJSON(),
              actions,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          for (const [label, pair] of Object.entries({ stage: geometry.stage, titlebar: geometry.titlebar, search: geometry.search, row: geometry.row })) {
            assert.ok(Math.abs(pair[0] - pair[1]) < 1, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${textScale}% ${label} gaps symmetric (${pair[0]}/${pair[1]})`);
          }
          assert.deepEqual(geometry.actions.map((action) => action.text), ['Invite', 'Settings'], `${engineName} ${width}px ${textScale}% keeps visible Invite then Settings`);
          assert.ok(geometry.actions.every((action) => action.width >= 44 && action.height >= 44), `${engineName} ${width}px ${textScale}% header actions retain 44px targets`);
          assert.ok(geometry.actions.every((action) => action.labelContained), `${engineName} ${width}px ${textScale}% header labels remain fully contained ${JSON.stringify(geometry.actions)}`);
          assert.ok(geometry.title.right <= geometry.actionGroup.left || geometry.title.bottom <= geometry.actionGroup.top, `${engineName} ${width}px ${textScale}% title and actions do not overlap`);
          assert.ok(geometry.actionGroup.left >= geometry.head.left && geometry.actionGroup.right <= geometry.head.right && geometry.actionGroup.bottom <= geometry.head.bottom, `${engineName} ${width}px ${textScale}% actions remain inside header ${JSON.stringify({ head: geometry.head, actions: geometry.actionGroup })}`);
          assert.equal(geometry.overflow, 0, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${textScale}% list has no horizontal overflow`);
          }
        }
        await listContext.close();
      }

      if (engineName === 'chromium') {
        const desktop = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
        await installRoutes(desktop); const desktopPage = await desktop.newPage();
        await desktopPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); await desktopPage.locator('.composer textarea').waitFor();
        await settleAnimations(desktopPage);
        await desktopPage.locator('.composer textarea').fill('Ready to send');
        const desktopSend = await desktopPage.locator('.composer .btn.primary').evaluate((button) => {
          const label = button.querySelector('.btn-label'); const icon = button.querySelector('.ic');
          const box = button.getBoundingClientRect(); const iconBox = icon.getBoundingClientRect(); const labelBox = label.getBoundingClientRect();
          return { labelDisplay: getComputedStyle(label).display, gap: labelBox.left - iconBox.right,
            groupDelta: Math.abs(((iconBox.left + labelBox.right) / 2) - (box.left + box.width / 2)) };
        });
        assert.notEqual(desktopSend.labelDisplay, 'none', 'desktop Send label remains visible');
        assert.ok(desktopSend.gap > 0, 'desktop icon-plus-label gap remains present');
        assert.ok(desktopSend.groupDelta < 0.1, `desktop icon-plus-label group remains centered (${desktopSend.groupDelta}px)`);
        await desktop.close();
      }
    } finally { await browser.close(); }
  }
  console.log(`browser-mobile-layout-webkit OK — ${[...requestedEngines].join(', ')} DOM/CSS gesture and layout coverage`);
} finally {
  for (const stream of streams) stream.end();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
