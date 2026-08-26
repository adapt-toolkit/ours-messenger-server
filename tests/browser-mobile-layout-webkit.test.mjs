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
  if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
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
      assert.ok(lightMetrics.directionGap > 0, `${engineName} light incoming/outgoing messages retain a gap`);
      assert.ok(lightMetrics.sendDelta < 0.1, `${engineName} light compact send remains centered`);
      await light.close();

      if (engineName === 'chromium') {
        const desktop = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
        await installRoutes(desktop); const desktopPage = await desktop.newPage();
        await desktopPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' }); await desktopPage.locator('.composer textarea').waitFor();
        await settleAnimations(desktopPage);
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
