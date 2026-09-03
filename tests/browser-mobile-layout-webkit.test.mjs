import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the mobile WebKit gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const streams = new Set();
const captureDir = process.env.MOBILE_CAPTURE_DIR ? resolve(process.env.MOBILE_CAPTURE_DIR) : null;
if (captureDir) mkdirSync(captureDir, { recursive: true });
const mobileLayoutSource = readFileSync(resolve(new URL('../web/src/layout-v4.css', import.meta.url).pathname), 'utf8');
assert.match(mobileLayoutSource, /-webkit-backdrop-filter:\s*blur\(var\(--material-floating-blur\)\)\s+saturate\(115%\)/, 'shared material directly declares the WebKit filter');
assert.match(mobileLayoutSource, /(?<!-webkit-)backdrop-filter:\s*blur\(var\(--material-floating-blur\)\)\s+saturate\(115%\)/, 'shared material directly declares the standard filter');
const contrastRatio = (foreground, background) => {
  const channel = (value) => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
  const luminance = (color) => {
    const normalized = color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const [r, g, b] = (color.startsWith('color(srgb') ? normalized.map((value) => value * 255) : normalized).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};
const parseCssColor = (color) => {
  const values = color.match(/[\d.]+/g).map(Number);
  const normalized = color.startsWith('color(srgb') ? values.slice(0, 3).map((value) => value * 255) : values.slice(0, 3);
  const slash = color.match(/\/\s*([\d.]+)/); const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/);
  return { channels: normalized, alpha: Number(slash?.[1] ?? rgba?.[1] ?? 1) };
};
const compositeColor = (foreground, background) => {
  const fg = parseCssColor(foreground); const bg = parseCssColor(background);
  return `rgb(${fg.channels.map((channel, index) => Math.round(channel * fg.alpha + bg.channels[index] * (1 - fg.alpha))).join(' ')})`;
};
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
  { dir: 'out', text: 'outgoing continuation', date: '2026-08-26T08:01:30Z', read: true, wire_id: 'MOBILE-OUT-CONT', receipt: null },
];
const installRoutes = (context) => context.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
  if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
  if (url.pathname === '/api/contacts') return json({
    contacts: [
      { name: 'Peer', container_id: 'PEER' },
      { name: 'Alice', container_id: 'ALICE' },
      { name: 'Bob', container_id: 'BOB' },
    ], pending: [],
    roots: Object.fromEntries(['PEER', 'ALICE', 'BOB'].map((id) => [id, { root_cid: 'ROOT', root_name: 'Owner', role_id: 'assistant' }])),
  });
  if (url.pathname === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
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
const settleConversation = async (page) => {
  await page.waitForFunction(() => document.querySelectorAll('.message-motion').length >= 8);
  await settleAnimations(page);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await settleAnimations(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.message-motion')].every((node) => Number(getComputedStyle(node).opacity) > 0.99));
};
const fireGesture = (row, points, downTargetSelector, button = 0, pointerType = 'touch') => row.evaluate((node, { points: path, downTarget, pointerButton, pointerKind }) => {
  const fire = (target, eventType, x, y) => target.dispatchEvent(new PointerEvent(eventType, {
    bubbles: true, cancelable: true, pointerId: 7, pointerType: pointerKind, isPrimary: true,
    button: pointerButton, buttons: eventType === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
  }));
  const target = downTarget ? node.querySelector(downTarget) : node;
  let observedDown = null;
  target.addEventListener('pointerdown', (event) => { observedDown = { button: event.button, pointerType: event.pointerType }; }, { capture: true, once: true });
  fire(target, 'pointerdown', path[0][0], path[0][1]);
  for (const [x, y] of path.slice(1)) fire(node, 'pointermove', x, y);
  const last = path.at(-1); fire(node, 'pointerup', last[0], last[1]);
  return observedDown;
}, { points, downTarget: downTargetSelector, pointerButton: button, pointerKind: pointerType });
const fireNativeTouch = async (page, selector, direction) => {
  const row = page.locator(selector);
  const bubble = row.locator('.message-markdown p').first();
  await bubble.scrollIntoViewIfNeeded();
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
const fireNativeModeDrag = async (page, fromRatio, toRatio, vertical = false) => {
  const control = page.locator('.conversation-list-modes');
  const box = await control.boundingBox(); assert.ok(box, 'segmented control has native-touch geometry');
  const x0 = box.x + box.width * fromRatio; const y0 = box.y + box.height / 2;
  await control.evaluate((node) => {
    globalThis.__nativeModeEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, (event) => {
      globalThis.__nativeModeEvents.push({ type, pointerType: event.pointerType, button: event.button });
    });
  });
  const session = await page.context().newCDPSession(page);
  const point = (x, y) => [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x0, y0) });
  for (const ratio of [0.2, 0.45, 0.7, 1]) {
    const x = vertical ? x0 + 2 : x0 + (box.width * toRatio - box.width * fromRatio) * ratio;
    const y = vertical ? y0 + 70 * ratio : y0;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
  }
  const mid = await control.evaluate((node) => ({ dragging: node.classList.contains('dragging'), offset: node.style.getPropertyValue('--mode-drag-x') }));
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  return { mid, events: await page.evaluate(() => globalThis.__nativeModeEvents) };
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
          const messages = document.querySelector('.messages').getBoundingClientRect();
          const head = document.querySelector('.detail-head').getBoundingClientRect();
          const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
          const canvasHit = document.elementFromPoint(2, Math.round((head.bottom + composer.top) / 2));
          return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
            visualWidth: visualViewport?.width ?? innerWidth,
            detail: detail.toJSON(), messages: messages.toJSON(), head: head.toJSON(), composer: composer.toJSON(),
            canvasHit: !!canvasHit?.closest('.messages'), stage: stage.toJSON() };
        });
        assert.equal(geometry.scrollWidth, geometry.clientWidth, `${engineName} ${viewport.width} has no document overflow`);
        assert.ok(Math.abs(geometry.clientWidth - geometry.visualWidth) < 1, `${engineName} layout matches visual viewport`);
        for (const box of [geometry.detail, geometry.messages]) {
          assert.ok(Math.abs(box.left) < 1 && Math.abs(box.right - geometry.clientWidth) < 1, `${engineName} ${viewport.width} conversation canvas meets viewport edges ${JSON.stringify(box)}`);
        }
        assert.ok(geometry.head.left >= 8 && geometry.head.right <= geometry.clientWidth - 8, `${engineName} ${viewport.width} header floats inside viewport`);
        assert.ok(geometry.composer.left >= 8 && geometry.composer.right <= geometry.clientWidth - 8, `${engineName} ${viewport.width} composer floats inside viewport`);
        assert.equal(geometry.canvasHit, true, `${engineName} ${viewport.width} message canvas remains hit-testable between overlays`);
        for (const [state, value] of [['mic', ''], ['send', 'Ready to send']]) {
          await page.locator('.composer textarea').fill(value);
          const composerGap = await page.locator('.composer').evaluate((node) => {
            const field = node.querySelector('textarea').getBoundingClientRect();
            const trailing = node.querySelector('.vr-mic, .btn.primary').getBoundingClientRect();
            return { gap: trailing.left - field.right, field: field.toJSON(), trailing: trailing.toJSON() };
          });
          assert.ok(composerGap.gap >= 8, `${engineName} ${viewport.width} ${state} has >=8px after input ${JSON.stringify(composerGap)}`);
        }
        await page.locator('.composer textarea').fill('');
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
        for (const button of [0, -1]) {
          const observedTouch = await fireGesture(row, inward, '.message-markdown p', button, 'touch');
          assert.deepEqual(observedTouch, { button, pointerType: 'touch' }, `${engineName} diagnostic dispatched touch button ${button}`);
          await page.getByText('Replying to', { exact: false }).waitFor();
          await page.getByTitle('Cancel reply').click();
          await page.getByText('Replying to', { exact: false }).waitFor({ state: 'detached' });
        }
      }
      const incoming = page.locator('#chat-message-MOBILE-IN .msg-row');
      await fireGesture(incoming, [[40, 100], [38, 170]]);
      assert.equal(await page.getByText('Replying to', { exact: false }).count(), 0, `${engineName} vertical gesture does not reply`);
      await fireGesture(incoming, [[40, 100], [110, 100]], 'a');
      assert.equal(await page.getByText('Replying to', { exact: false }).count(), 0, `${engineName} link does not reply`);
      assert.equal(await incoming.locator('.bubble-wrap').evaluate((node) => node.style.transform), '', `${engineName} gestures settle`);
      await fireGesture(incoming, [[40, 100], [110, 100]], '.message-markdown p', 0, 'pen');
      assert.equal(await page.getByText('Replying to', { exact: false }).count(), 1, `${engineName} pen tip replies`);
      await page.getByTitle('Cancel reply').click();
      await page.getByText('Replying to', { exact: false }).waitFor({ state: 'detached' });
      const penBarrel = await fireGesture(incoming, [[40, 100], [110, 100]], '.message-markdown p', 2, 'pen');
      assert.deepEqual(penBarrel, { button: 2, pointerType: 'pen' }, `${engineName} diagnostic dispatched pen barrel semantics`);
      assert.equal(await page.getByText('Replying to', { exact: false }).count(), 0, `${engineName} pen barrel button does not reply`);
      if (engineName === 'chromium') {
        for (const [selector, direction] of [['#chat-message-MOBILE-IN .msg-row', 1], ['#chat-message-MOBILE-OUT .msg-row', -1]]) {
          const events = await fireNativeTouch(page, selector, direction);
          await page.getByText('Replying to', { exact: false }).waitFor();
          assert.ok(events.some((event) => event.type === 'pointerdown' && event.pointerType === 'touch'), `${selector} receives native touch pointerdown: ${JSON.stringify(events)}`);
          assert.ok(events.some((event) => event.type === 'pointerup'), `${selector} receives native touch pointerup: ${JSON.stringify(events)}`);
          assert.equal(events.some((event) => event.type === 'pointercancel'), false, `${selector} native inward swipe is not cancelled: ${JSON.stringify(events)}`);
          await page.getByTitle('Cancel reply').click();
          await page.getByText('Replying to', { exact: false }).waitFor({ state: 'detached' });
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
          directionGap: rows[1].top - rows[0].bottom, continuationGap: rows[2].top - rows[1].bottom,
          sendDelta: Math.abs((button.left + button.width / 2) - (icon.left + icon.width / 2)) };
      });
      assert.equal(lightMetrics.overflow, 0, `${engineName} light theme has no overflow`);
      assert.ok(Math.abs(lightMetrics.left) < 1 && Math.abs(lightMetrics.right) < 1, `${engineName} light conversation is edge-to-edge (${lightMetrics.left}/${lightMetrics.right})`);
      assert.ok(lightMetrics.directionGap >= 8, `${engineName} light incoming/outgoing messages retain an >=8px turn gap (${lightMetrics.directionGap}px)`);
      assert.ok(lightMetrics.continuationGap > 0 && lightMetrics.continuationGap < lightMetrics.directionGap,
        `${engineName} light same-sender continuation remains compact (${lightMetrics.continuationGap}px vs ${lightMetrics.directionGap}px)`);
      assert.ok(lightMetrics.sendDelta < 0.1, `${engineName} light compact send remains centered`);
      await light.close();

      if (!messages.some((message) => message.wire_id === 'MOBILE-CAPTURE-1')) messages.push(...Array.from({ length: 8 }, (_, index) => ({
        dir: index % 2 ? 'out' : 'in',
        text: `Workspace note ${index + 1}: a calm, readable message moving beneath the floating controls.`,
        date: `2026-08-26T08:${String(index + 2).padStart(2, '0')}:00Z`, read: true,
        wire_id: `MOBILE-CAPTURE-${index + 1}`, receipt: null,
      })));

      for (const dark of [false, true]) {
        const listContext = await browser.newContext({ hasTouch: true, isMobile: true, serviceWorkers: 'block', viewport: { width: 390, height: 812 } });
        await installRoutes(listContext);
        await listContext.addInitScript(({ useDark }) => {
          localStorage.setItem('ours-dark-v3', useDark ? '1' : '0');
          localStorage.setItem('ours.chats.listMode', 'identity');
        }, { useDark: dark });
        const listPage = await listContext.newPage(); await installCaptureHarness(listPage);
        await listPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });
        await listPage.locator('.contact-row.grouped').first().waitFor();
        for (const width of [320, 390, 430]) {
          await listPage.setViewportSize({ width, height: 812 });
          for (const textScale of [100, 200]) {
          await listPage.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, textScale);
          const geometry = await listPage.evaluate(() => {
            const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
            const stage = rect('.signal-stage'); const list = rect('.signal-stage > .listcol');
            const head = rect('.listcol-head'); const titlebar = rect('.listcol-titlebar'); const title = rect('.listcol-title');
            const scroll = rect('.listcol-scroll'); const row = rect('.contact-row.grouped');
            const search = rect('.search'); const bottomChrome = rect('.list-bottom-chrome'); const invite = rect('.list-bottom-invite'); const actionGroup = rect('.listcol-actions');
            const actions = [...document.querySelectorAll('.listcol-actions .icon-btn')].map((node) => {
              const box = node.getBoundingClientRect();
              return { label: node.getAttribute('aria-label'), title: node.getAttribute('title'), ...box.toJSON() };
            }).filter((action) => action.width > 0 && action.height > 0);
            const rows = [...document.querySelectorAll('.conversation-group > .contact-row')];
            const firstDivider = rows[0] ? getComputedStyle(rows[0], '::after') : null;
            const lastDivider = rows.at(-1) ? getComputedStyle(rows.at(-1), '::after') : null;
            const firstAvatar = rows[0]?.querySelector('.contact-avatar')?.getBoundingClientRect();
            return {
              stage: [list.left - stage.left, stage.right - list.right],
              titlebar: [titlebar.left - head.left, head.right - titlebar.right],
              row: [row.left - scroll.left, scroll.right - row.right],
              head: head.toJSON(), title: title.toJSON(), actionGroup: actionGroup.toJSON(),
              actions,
              searchBox: search.toJSON(),
              bottomChrome: bottomChrome.toJSON(), invite: invite.toJSON(),
              divider: firstDivider && firstAvatar ? { content: firstDivider.content, left: parseFloat(firstDivider.left), bottom: parseFloat(firstDivider.bottom), height: parseFloat(firstDivider.height), background: firstDivider.backgroundColor, avatarRight: firstAvatar.right - rows[0].getBoundingClientRect().left } : null,
              lastDividerContent: lastDivider?.content,
              viewport: innerWidth,
              list: list.toJSON(),
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          for (const [label, pair] of Object.entries({ stage: geometry.stage, titlebar: geometry.titlebar, row: geometry.row })) {
            assert.ok(Math.abs(pair[0] - pair[1]) < 1, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${textScale}% ${label} gaps symmetric (${pair[0]}/${pair[1]})`);
          }
          assert.deepEqual(geometry.actions.map((action) => action.label), ['Settings'], `${engineName} ${width}px ${textScale}% keeps only Settings in header`);
          assert.ok(geometry.actions.every((action) => action.title === action.label), `${engineName} ${width}px icon controls retain tooltips`);
          assert.ok(Math.abs(geometry.list.left) < 1 && Math.abs(geometry.list.right - geometry.viewport) < 1, `${engineName} ${width}px list meets viewport edges ${JSON.stringify(geometry.list)}`);
          assert.ok(geometry.actions.every((action) => action.width >= 44 && action.height >= 44), `${engineName} ${width}px ${textScale}% header actions retain 44px targets`);
          assert.ok(geometry.searchBox.width >= 200 && geometry.searchBox.height >= 44, `${engineName} ${width}px search stays fixed open ${JSON.stringify(geometry.searchBox)}`);
          assert.ok(geometry.invite.width >= 44 && geometry.invite.height >= 44 && geometry.invite.left - geometry.searchBox.right >= 10, `${engineName} ${width}px bottom Search and Invite are disjoint 44px+ controls`);
          assert.ok(Math.abs(geometry.invite.height - geometry.searchBox.height) <= 1, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${textScale}% Invite height equals Search (${geometry.invite.height}/${geometry.searchBox.height})`);
          assert.ok(geometry.bottomChrome.left >= 0 && geometry.bottomChrome.right <= geometry.viewport && geometry.bottomChrome.bottom <= 812, `${engineName} ${width}px transparent bottom wrapper is contained`);
          assert.ok(geometry.title.right <= geometry.actionGroup.left || geometry.title.bottom <= geometry.actionGroup.top, `${engineName} ${width}px ${textScale}% title and actions do not overlap`);
          assert.ok(geometry.actionGroup.left >= geometry.head.left && geometry.actionGroup.right <= geometry.head.right && geometry.actionGroup.bottom <= geometry.head.bottom, `${engineName} ${width}px ${textScale}% actions remain inside header ${JSON.stringify({ head: geometry.head, actions: geometry.actionGroup })}`);
          assert.equal(geometry.overflow, 0, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${textScale}% list has no horizontal overflow`);
          assert.ok(geometry.divider && geometry.divider.content !== 'none' && geometry.divider.left >= geometry.divider.avatarRight,
            `${engineName} ${width}px divider begins after avatar ${JSON.stringify(geometry.divider)}`);
          assert.ok(geometry.divider.height >= 1 && geometry.divider.bottom >= 0 && !['transparent', 'rgba(0, 0, 0, 0)'].includes(geometry.divider.background),
            `${engineName} ${width}px divider is paintable inside the clipped row ${JSON.stringify(geometry.divider)}`);
          assert.equal(geometry.lastDividerContent, 'none', `${engineName} ${width}px last visible chat has no divider`);
          }
        }
        if (!dark) {
          const invite = listPage.getByRole('button', { name: 'Invite' });
          const colors = () => invite.evaluate((node) => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
          const states = [['default', await colors()]];
          await invite.hover(); states.push(['hover', await colors()]);
          const box = await invite.boundingBox(); assert.ok(box, 'Invite has geometry for pressed contrast');
          await listPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await listPage.mouse.down();
          states.push(['pressed', await colors()]); await listPage.mouse.up();
          for (const [state, pair] of states) assert.ok(contrastRatio(pair.color, pair.background) >= 3, `${engineName} light Invite icon ${state} contrast is 3:1 (${contrastRatio(pair.color, pair.background).toFixed(2)}:1, ${JSON.stringify(pair)})`);
        }
        if (await listPage.locator('[role="dialog"]').count()) {
          await listPage.keyboard.press('Escape');
          await listPage.locator('[role="dialog"]').waitFor({ state: 'detached' });
        }
        await listPage.setViewportSize({ width: 390, height: 812 });
        const searchInput = listPage.getByPlaceholder('Search people, agents, apps…');
        const fixedSearchWidth = await listPage.locator('.adaptive-search').evaluate((node) => node.getBoundingClientRect().width);
        assert.ok(fixedSearchWidth > 200 && await searchInput.isVisible(), `${engineName} fixed-open search is visible`);
        await searchInput.fill('Peer');
        await listPage.getByRole('button', { name: 'Settings' }).focus();
        assert.equal(await searchInput.inputValue(), 'Peer', `${engineName} nonempty search query survives blur`);
        assert.ok(Math.abs(await listPage.locator('.adaptive-search').evaluate((node) => node.getBoundingClientRect().width) - fixedSearchWidth) < 1, `${engineName} search width is stable with content`);
        await searchInput.focus(); await searchInput.press('Escape');
        assert.equal(await searchInput.inputValue(), '', `${engineName} Escape explicitly clears search`);
        assert.ok(Math.abs(await listPage.locator('.adaptive-search').evaluate((node) => node.getBoundingClientRect().width) - fixedSearchWidth) < 1, `${engineName} empty search remains fixed open`);

        const recentTab = listPage.getByRole('tab', { name: 'Recent' });
        const identityTab = listPage.getByRole('tab', { name: 'By identity' });
        await recentTab.click();
        assert.equal(await recentTab.getAttribute('aria-selected'), 'true', `${engineName} segmented control supports tap`);
        await recentTab.press('ArrowRight');
        assert.equal(await identityTab.getAttribute('aria-selected'), 'true', `${engineName} segmented control supports arrow keys`);
        await identityTab.press('Home'); assert.equal(await recentTab.getAttribute('aria-selected'), 'true', `${engineName} segmented control supports Home`);
        await recentTab.press('End'); assert.equal(await identityTab.getAttribute('aria-selected'), 'true', `${engineName} segmented control supports End`);
        const dragObserved = await listPage.locator('.conversation-list-modes').evaluate((node) => {
          const box = node.getBoundingClientRect(); const target = node.querySelector('[aria-selected="true"]');
          const fire = (to, type, x, y) => to.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'touch', isPrimary: true, button: -1, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
          let down = null; node.addEventListener('pointerdown', (event) => { down = { button: event.button, pointerType: event.pointerType }; }, { capture: true, once: true });
          fire(target, 'pointerdown', box.right - 30, box.top + box.height / 2);
          fire(node, 'pointermove', box.left + box.width / 2 - 20, box.top + box.height / 2);
          fire(node, 'pointermove', box.left + 30, box.top + box.height / 2);
          fire(node, 'pointerup', box.left + 30, box.top + box.height / 2);
          return down;
        });
        assert.deepEqual(dragObserved, { button: -1, pointerType: 'touch' }, `${engineName} segmented drag receives iOS touch semantics`);
        assert.equal(await recentTab.getAttribute('aria-selected'), 'true', `${engineName} horizontal drag commits nearest segment`);
        await listPage.locator('.conversation-list-modes').evaluate((node) => {
          const box = node.getBoundingClientRect(); const target = node.querySelector('[aria-selected="true"]');
          const fire = (to, type, x, y) => to.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 32, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }));
          fire(target, 'pointerdown', box.left + 30, box.top + box.height / 2);
          fire(node, 'pointermove', box.left + 32, box.top + box.height / 2 + 45);
          fire(node, 'pointerup', box.left + 32, box.top + box.height / 2 + 45);
        });
        assert.equal(await recentTab.getAttribute('aria-selected'), 'true', `${engineName} vertical intent cancels without changing selection`);
        assert.equal(await listPage.locator('.conversation-list-modes').evaluate((node) => node.classList.contains('dragging')), false, `${engineName} vertical intent leaves no drag state`);
        if (engineName === 'chromium') {
          const nativeForward = await fireNativeModeDrag(listPage, 0.25, 0.82);
          assert.ok(nativeForward.mid.dragging && nativeForward.mid.offset, `native segmented hold-drag moves lens before release ${JSON.stringify(nativeForward)}`);
          assert.ok(nativeForward.events.some((event) => event.type === 'pointerup') && !nativeForward.events.some((event) => event.type === 'pointercancel'), `native horizontal segmented drag completes ${JSON.stringify(nativeForward.events)}`);
          assert.equal(await identityTab.getAttribute('aria-selected'), 'true', 'native segmented drag commits By identity');
          const nativeReverse = await fireNativeModeDrag(listPage, 0.75, 0.18);
          assert.ok(nativeReverse.mid.dragging, `native reverse drag moves lens ${JSON.stringify(nativeReverse)}`);
          assert.equal(await recentTab.getAttribute('aria-selected'), 'true', 'native reverse drag commits Recent');
          const nativeVertical = await fireNativeModeDrag(listPage, 0.25, 0.25, true);
          assert.equal(await recentTab.getAttribute('aria-selected'), 'true', 'native vertical intent does not change segment');
          assert.equal(nativeVertical.mid.dragging, false, `native vertical intent never owns lens ${JSON.stringify(nativeVertical)}`);
        }
        const bottomInvite = listPage.getByRole('button', { name: 'Invite' });
        await bottomInvite.click();
        await listPage.getByRole('dialog').waitFor();
        await listPage.keyboard.press('Escape');
        await listPage.getByRole('dialog').waitFor({ state: 'detached' });
        await listPage.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Invite');
        assert.equal(await bottomInvite.evaluate((node) => node === document.activeElement), true, `${engineName} Invite dialog restores focus to bottom +`);
        await listPage.emulateMedia({ contrast: 'more' });
        const contrastMaterials = await listPage.evaluate(() => {
          const read = (node, pseudo) => { const style = getComputedStyle(node, pseudo); return { border: style.borderTopColor, color: style.color, shadow: style.boxShadow, outline: style.outlineColor, outlineWidth: parseFloat(style.outlineWidth) }; };
          const modes = document.querySelector('.conversation-list-modes');
          return [read(document.querySelector('.adaptive-search')), read(document.querySelector('.list-bottom-invite')), read(modes), read(modes, '::before')];
        });
        assert.ok(contrastMaterials.every((item) => item.shadow === 'none' && item.outline === item.color && item.outlineWidth >= 1), `${engineName} increased-contrast list materials use currentColor boundaries without soft shadows ${JSON.stringify(contrastMaterials)}`);
        await listPage.emulateMedia({ contrast: 'no-preference' });
        const listMaterials = await listPage.evaluate(() => {
          const probe = (value) => { const node = document.createElement('i'); node.style.background = value; document.body.append(node); const result = getComputedStyle(node).backgroundColor; node.remove(); return result; };
          const read = (selector, pseudo) => { const style = getComputedStyle(document.querySelector(selector), pseudo); const background = style.backgroundColor; const slash = background.match(/\/\s*([\d.]+)/); const rgba = background.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/); return { background, alpha: Number(slash?.[1] ?? rgba?.[1] ?? 1), filter: style.backdropFilter, webkitFilter: style.webkitBackdropFilter }; };
          return { regular: probe('var(--material-floating)'), accent: probe('var(--material-floating-accent)'),
            search: read('.adaptive-search'), modes: read('.conversation-list-modes'), lens: read('.conversation-list-modes', '::before'), invite: read('.list-bottom-invite') };
        });
        for (const item of [listMaterials.search, listMaterials.modes, listMaterials.lens]) {
          assert.equal(item.background, listMaterials.regular, `${engineName} list glass resolves the floating role ${JSON.stringify(listMaterials)}`);
          assert.notEqual(item.filter, 'none', `${engineName} list glass exposes standard backdrop filter`);
          if (item.webkitFilter) assert.notEqual(item.webkitFilter, 'none', `${engineName} list glass exposes computed WebKit backdrop filter`);
          assert.ok(item.alpha < 1, `${engineName} list glass stays translucent ${JSON.stringify(item)}`);
        }
        assert.equal(listMaterials.invite.background, listMaterials.accent, `${engineName} Invite resolves translucent floating accent role`);
        assert.ok(listMaterials.invite.alpha < 1 && listMaterials.invite.filter !== 'none', `${engineName} Invite is filtered translucent glass ${JSON.stringify(listMaterials.invite)}`);
        if (listMaterials.invite.webkitFilter) assert.notEqual(listMaterials.invite.webkitFilter, 'none', `${engineName} Invite exposes computed WebKit filter`);
        await listPage.setViewportSize({ width: 390, height: 812 });
        await listPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
        await listPage.locator('.composer textarea').waitFor();
        await listPage.waitForFunction(() => {
          const detail = document.querySelector('.detail-chat'); const composer = document.querySelector('.composer-wrap');
          return detail && composer && parseFloat(getComputedStyle(detail).getPropertyValue('--conversation-compose-height')) === Math.round(composer.getBoundingClientRect().height);
        });
        await settleAnimations(listPage);
        const naturalOpen = await listPage.evaluate(() => {
          const scroller = document.querySelector('.messages'); const last = [...document.querySelectorAll('.msg-row')].at(-1);
          const composer = document.querySelector('.composer-wrap').getBoundingClientRect(); const row = last.getBoundingClientRect();
          return { row: row.toJSON(), composer: composer.toJSON(), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight, reserve: getComputedStyle(document.querySelector('.detail-chat')).getPropertyValue('--conversation-compose-height'),
            paddingBottom: getComputedStyle(document.querySelector('.messages-inner')).paddingBottom };
        });
        assert.ok(naturalOpen.row.bottom <= naturalOpen.composer.top - 8, `${engineName} ${dark ? 'dark' : 'light'} natural first open fully exposes final message ${JSON.stringify(naturalOpen)}`);
        assert.ok(Math.abs(naturalOpen.scrollTop - Math.max(0, naturalOpen.scrollHeight - naturalOpen.clientHeight)) < 2, `${engineName} natural first open remains bottom-anchored ${JSON.stringify(naturalOpen)}`);
        await listPage.locator('.messages').evaluate((node) => { node.scrollTop = 0; });
        await listPage.locator('.jump-latest').waitFor();
        const awayBefore = await listPage.locator('.messages').evaluate((node) => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
        await listPage.locator('.msg-reply').first().click();
        await listPage.getByTitle('Cancel reply').waitFor();
        await listPage.waitForFunction((height) => parseFloat(getComputedStyle(document.querySelector('.detail-chat')).getPropertyValue('--conversation-compose-height')) > height, Number.parseFloat(naturalOpen.reserve));
        await listPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const awayAfter = await listPage.locator('.messages').evaluate((node) => ({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight }));
        assert.ok(awayAfter.max - awayAfter.top > 100 && awayAfter.top < awayAfter.max, `${engineName} composer reserve growth does not force an away reader to bottom ${JSON.stringify({ awayBefore, awayAfter })}`);
        await listPage.getByTitle('Cancel reply').click();
        const conversationMaterials = await listPage.evaluate(() => {
          const probe = (value) => { const node = document.createElement('i'); node.style.background = value; document.body.append(node); const result = getComputedStyle(node).backgroundColor; node.remove(); return result; };
          const probeColor = (value) => { const node = document.createElement('i'); node.style.color = value; document.body.append(node); const result = getComputedStyle(node).color; node.remove(); return result; };
          const read = (selector) => { const style = getComputedStyle(document.querySelector(selector)); const background = style.backgroundColor; const slash = background.match(/\/\s*([\d.]+)/); const rgba = background.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/); return { background, alpha: Number(slash?.[1] ?? rgba?.[1] ?? 1), filter: style.backdropFilter, webkitFilter: style.webkitBackdropFilter }; };
          return { regular: probe('var(--material-floating)'), accent: probe('var(--material-floating-accent)'), action: probe('var(--material-floating-action)'), actionHover: probe('var(--material-floating-action-hover)'), actionPressed: probe('var(--material-floating-action-pressed)'), actionInk: probeColor('var(--material-floating-action-ink)'), solidAccent: probe('var(--accent)'), canvas: probe('var(--bg)'), surface: probe('var(--surface)'), outgoing: probe('var(--accent-fill)'),
            jump: read('.jump-latest'), back: read('.detail-back'), status: read('.conv-peer-status'), attach: read('.composer-tool'), field: read('.composer .field'), mic: read('.vr-mic'), avatar: read('.conv-contact-avatar') };
        });
        for (const [name, item] of Object.entries(conversationMaterials).filter(([name]) => !['regular', 'accent', 'action', 'actionHover', 'actionPressed', 'actionInk', 'solidAccent', 'canvas', 'surface', 'outgoing', 'avatar'].includes(name))) {
          assert.equal(item.background, conversationMaterials.regular, `${engineName} ${name} resolves shared floating role`);
          assert.notEqual(item.filter, 'none', `${engineName} ${name} has standard backdrop filter`);
          if (item.webkitFilter) assert.notEqual(item.webkitFilter, 'none', `${engineName} ${name} has computed WebKit backdrop filter`);
        }
        assert.equal(conversationMaterials.avatar.background, conversationMaterials.accent, `${engineName} avatar resolves floating accent role`);
        assert.ok(conversationMaterials.avatar.alpha < 1 && conversationMaterials.avatar.filter !== 'none', `${engineName} avatar is filtered translucent glass ${JSON.stringify(conversationMaterials.avatar)}`);
        if (conversationMaterials.avatar.webkitFilter) assert.notEqual(conversationMaterials.avatar.webkitFilter, 'none', `${engineName} avatar exposes computed WebKit filter`);
        await listPage.locator('.composer textarea').fill('Material check');
        const sendMaterial = await listPage.locator('.composer .btn.primary').evaluate((node) => { const style = getComputedStyle(node); const iconStyle = getComputedStyle(node.querySelector('.ic')); const background = style.backgroundColor; const slash = background.match(/\/\s*([\d.]+)/); const rgba = background.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)/); return { background, color: style.color, iconColor: iconStyle.color, border: style.borderColor, opacity: Number(style.opacity), pointerEvents: style.pointerEvents, alpha: Number(slash?.[1] ?? rgba?.[1] ?? 1), filter: style.backdropFilter, webkitFilter: style.webkitBackdropFilter }; });
        assert.equal(sendMaterial.background, conversationMaterials.action, `${engineName} enabled Send resolves dedicated floating action role`);
        assert.equal(sendMaterial.iconColor, conversationMaterials.actionInk, `${engineName} enabled Send glyph resolves action-ink role`);
        assert.ok(sendMaterial.alpha < 1 && sendMaterial.filter !== 'none', `${engineName} Send is filtered translucent glass ${JSON.stringify(sendMaterial)}`);
        if (sendMaterial.webkitFilter) assert.notEqual(sendMaterial.webkitFilter, 'none', `${engineName} Send exposes computed WebKit filter`);
        const underlyingColors = { canvas: conversationMaterials.canvas, surface: conversationMaterials.surface, outgoing: conversationMaterials.outgoing };
        const effectiveActions = Object.fromEntries(Object.entries(underlyingColors).map(([name, color]) => [name, compositeColor(sendMaterial.background, color)]));
        for (const [name, effectiveAction] of Object.entries(effectiveActions)) assert.ok(contrastRatio(sendMaterial.iconColor, effectiveAction) >= 3, `${engineName} enabled Send glyph has >=3:1 effective contrast over ${name} (${contrastRatio(sendMaterial.iconColor, effectiveAction).toFixed(2)}) ${JSON.stringify({ sendMaterial, effectiveAction, underlying: underlyingColors[name] })}`);
        const effectiveAction = effectiveActions.canvas;
        const effectivePassive = compositeColor(conversationMaterials.accent, conversationMaterials.canvas);
        assert.ok(Math.abs(contrastRatio('rgb(0 0 0)', effectiveAction) - contrastRatio('rgb(0 0 0)', effectivePassive)) >= 0.75, `${engineName} enabled action has >=0.75 grayscale luminance-ratio delta from passive accent ${JSON.stringify({ effectiveAction, effectivePassive })}`);
        assert.equal(sendMaterial.opacity, 1, `${engineName} enabled Send is fully legible`);
        await listPage.locator('.composer .btn.primary').hover();
        await settleAnimations(listPage);
        const hoverSend = await listPage.locator('.composer .btn.primary').evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, iconColor: getComputedStyle(node.querySelector('.ic')).color }));
        assert.deepEqual(hoverSend, { background: conversationMaterials.actionHover, iconColor: conversationMaterials.actionInk }, `${engineName} hover resolves action-hover and action-ink roles`);
        const sendBox = await listPage.locator('.composer .btn.primary').boundingBox(); assert.ok(sendBox);
        await listPage.mouse.move(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2); await listPage.mouse.down();
        await settleAnimations(listPage);
        const pressedSend = await listPage.locator('.composer .btn.primary').evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, iconColor: getComputedStyle(node.querySelector('.ic')).color }));
        assert.deepEqual(pressedSend, { background: conversationMaterials.actionPressed, iconColor: conversationMaterials.actionInk }, `${engineName} pressed resolves action-pressed and action-ink roles`);
        await listPage.mouse.up();
        await listPage.locator('.composer .btn.primary').evaluate((node) => { node.disabled = true; });
        await settleAnimations(listPage);
        const disabledSend = await listPage.locator('.composer .btn.primary').evaluate((node) => { const style = getComputedStyle(node); return { disabled: node.disabled, opacity: Number(style.opacity), pointerEvents: style.pointerEvents, color: style.color, iconColor: getComputedStyle(node.querySelector('.ic')).color }; });
        assert.ok(disabledSend.disabled && disabledSend.opacity <= 0.45 && disabledSend.pointerEvents === 'none' && disabledSend.iconColor !== conversationMaterials.actionInk, `${engineName} genuinely disabled Send retains its muted glyph styling and is noninteractive ${JSON.stringify(disabledSend)}`);
        await listPage.locator('.composer .btn.primary').evaluate((node) => { node.disabled = false; });
        if (engineName === 'chromium') {
          const mediaSession = await listPage.context().newCDPSession(listPage);
          await mediaSession.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
          await settleAnimations(listPage);
          const reducedSend = await listPage.locator('.composer .btn.primary').evaluate((node) => { const style = getComputedStyle(node); return { background: style.backgroundColor, filter: style.backdropFilter, webkitFilter: style.webkitBackdropFilter }; });
          assert.equal(reducedSend.background, conversationMaterials.solidAccent, `reduced-transparency enabled Send uses solid accent fallback ${JSON.stringify(reducedSend)}`);
          assert.equal(reducedSend.filter, 'none', 'reduced-transparency enabled Send removes standard filter');
          if (reducedSend.webkitFilter) assert.equal(reducedSend.webkitFilter, 'none', 'reduced-transparency enabled Send removes WebKit filter');
          await mediaSession.send('Emulation.setEmulatedMedia', { features: [] }); await mediaSession.detach();
        }
        await listPage.emulateMedia({ contrast: 'more' });
        await settleAnimations(listPage);
        const highContrastSend = await listPage.locator('.composer .btn.primary').evaluate((node) => { const style = getComputedStyle(node); return { outline: style.outlineColor, color: style.color, width: parseFloat(style.outlineWidth), shadow: style.boxShadow }; });
        assert.ok(highContrastSend.outline === highContrastSend.color && highContrastSend.width >= 1 && highContrastSend.shadow === 'none', `${engineName} increased-contrast Send has a currentColor edge without soft shadow ${JSON.stringify(highContrastSend)}`);
        await listPage.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' });
        await settleAnimations(listPage);
        const forcedSend = await listPage.locator('.composer .btn.primary').evaluate((node) => { const style = getComputedStyle(node); return { background: style.backgroundColor, color: style.color, filter: style.backdropFilter, shadow: style.boxShadow }; });
        assert.ok(forcedSend.filter === 'none' && forcedSend.shadow === 'none' && forcedSend.background !== forcedSend.color, `${engineName} forced-colors Send uses distinct system fill/text without glass ${JSON.stringify(forcedSend)}`);
        await listPage.emulateMedia({ forcedColors: 'none' });
        await listPage.locator('.composer textarea').fill('');
        await listPage.locator('.messages').evaluate((node) => { node.scrollTop = node.scrollHeight; });
        const headTopology = await listPage.locator('.detail-head').evaluate((node) => {
          const back = node.querySelector('.detail-back').getBoundingClientRect();
          const center = node.querySelector('.conv-peer-status').getBoundingClientRect();
          const avatar = node.querySelector('.conv-contact-avatar').getBoundingClientRect();
          const inner = node.querySelector('.conv-contact-initials'); const innerStyle = getComputedStyle(inner);
          const style = getComputedStyle(node);
          return { back: back.toJSON(), center: center.toJSON(), avatar: avatar.toJSON(), background: style.backgroundColor, border: style.borderTopWidth,
            centerTabIndex: node.querySelector('.conv-peer-status').tabIndex, avatarName: node.querySelector('.conv-contact-avatar').getAttribute('aria-label'),
            inner: { background: innerStyle.backgroundColor, border: innerStyle.borderTopWidth, shadow: innerStyle.boxShadow } };
        });
        assert.ok(headTopology.center.left - headTopology.back.right >= 10 && headTopology.avatar.left - headTopology.center.right >= 10, `${engineName} top pieces remain independently separated`);
        assert.ok(headTopology.back.width >= 44 && headTopology.avatar.width >= 44, `${engineName} Back/avatar retain 44px targets`);
        assert.equal(headTopology.centerTabIndex, -1, `${engineName} center status capsule is noninteractive`);
        assert.match(headTopology.avatarName, /^Open contact details for /, `${engineName} avatar is the sole named details action`);
        assert.deepEqual(headTopology.inner, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' }, `${engineName} avatar initials create no inset square or second ring`);
        assert.equal(headTopology.background, 'rgba(0, 0, 0, 0)', `${engineName} top wrapper owns no material`);
        for (const width of [320, 390, 430]) {
          await listPage.setViewportSize({ width, height: 812 });
          const input = listPage.locator('.composer textarea');
          await input.fill('');
          await listPage.locator('.messages').focus();
          const collapsed = await listPage.locator('.composer').evaluate((node) => {
            const wrapperStyle = getComputedStyle(node.closest('.composer-wrap'));
            const field = node.querySelector('textarea'); const fieldStyle = getComputedStyle(field);
            const items = [node.querySelector('.composer-tool'), field, node.querySelector('.vr-mic')].map((item) => item.getBoundingClientRect());
            return {
              width: items[1].width, height: items[1].height, placeholder: field.placeholder,
              toolCount: node.querySelectorAll('.composer-tool').length,
              placeholderColor: fieldStyle.getPropertyValue('--placeholder-color') || getComputedStyle(field, '::placeholder').color,
              wrapperBackground: wrapperStyle.backgroundColor, wrapperBorder: wrapperStyle.borderTopWidth,
              gaps: [items[1].left - items[0].right, items[2].left - items[1].right],
              items: items.map((item) => item.toJSON()),
            };
          });
          const equalChrome = await listPage.evaluate(() => {
            const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
            return { back: rect('.detail-back').toJSON(), status: rect('.conv-peer-status').toJSON(), avatar: rect('.conv-contact-avatar').toJSON(), attach: rect('.composer-tool').toJSON(), field: rect('.composer .field').toJSON(), trailing: rect('.composer .vr-mic, .composer .btn.primary').toJSON() };
          });
          for (const [name, top] of Object.entries({ back: equalChrome.back, status: equalChrome.status, avatar: equalChrome.avatar })) {
            assert.ok(top.height >= 44 && Math.abs(top.height - equalChrome.field.height) <= 1, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${name} height equals bottom controls (${top.height}/${equalChrome.field.height})`);
          }
          assert.ok(Math.abs(equalChrome.attach.height - equalChrome.field.height) <= 1 && Math.abs(equalChrome.trailing.height - equalChrome.field.height) <= 1, `${engineName} ${width}px bottom controls share one height ${JSON.stringify(equalChrome)}`);
          assert.ok(equalChrome.status.left - equalChrome.back.right >= 10 && equalChrome.avatar.left - equalChrome.status.right >= 10, `${engineName} ${width}px equal-height header controls remain disjoint`);
          const minimumInputWidth = width <= 350 && collapsed.toolCount > 1 ? 140 : 160;
          assert.ok(collapsed.width >= minimumInputWidth && collapsed.height >= 44 && collapsed.height <= 45 && collapsed.placeholder.length > 0,
            `${engineName} ${dark ? 'dark' : 'light'} ${width}px fixed-open input stays recognizable ${JSON.stringify(collapsed)}`);
          assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(collapsed.placeholderColor),
            `${engineName} ${dark ? 'dark' : 'light'} ${width}px collapsed placeholder remains visible (${collapsed.placeholderColor})`);
          assert.equal(await listPage.getByRole('textbox', { name: collapsed.placeholder, exact: true }).count(), 1,
            `${engineName} ${dark ? 'dark' : 'light'} ${width}px collapsed input retains its accessible name`);
          assert.ok(collapsed.gaps.every((gap) => gap >= 8), `${engineName} ${dark ? 'dark' : 'light'} ${width}px independent controls retain gaps ${collapsed.gaps}`);
          assert.equal(collapsed.wrapperBackground, 'rgba(0, 0, 0, 0)', `${engineName} ${dark ? 'dark' : 'light'} wrapper owns no material`);
          assert.equal(collapsed.wrapperBorder, '0px', `${engineName} ${dark ? 'dark' : 'light'} wrapper owns no border`);
          await input.focus();
          const focusedWidth = await input.evaluate((node) => node.getBoundingClientRect().width);
          assert.ok(Math.abs(focusedWidth - collapsed.width) < 1, `${engineName} ${dark ? 'dark' : 'light'} ${width}px input width is stable on focus (${collapsed.width} -> ${focusedWidth})`);
          for (const [state, value] of [['mic', ''], ['send', 'Ready to send']]) {
            await input.fill(value);
            const composerGap = await listPage.locator('.composer').evaluate((node) => {
              const field = node.querySelector('textarea').getBoundingClientRect();
              const trailing = node.querySelector('.vr-mic, .btn.primary').getBoundingClientRect();
              return { gap: trailing.left - field.right, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            });
            assert.ok(composerGap.gap >= 8, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${state} has >=8px after input (${composerGap.gap}px)`);
            assert.equal(composerGap.overflow, 0, `${engineName} ${dark ? 'dark' : 'light'} ${width}px ${state} has no horizontal overflow`);
          }
        }
        await listPage.setViewportSize({ width: 390, height: 812 });
        await listPage.locator('.composer textarea').fill('');
        await listPage.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        await listPage.locator('.composer textarea').fill('Zoom resize probe');
        await listPage.locator('.composer textarea').fill('');
        await listPage.waitForFunction(() => {
          const detail = document.querySelector('.detail-chat');
          const head = document.querySelector('.detail-head');
          const composer = document.querySelector('.composer-wrap');
          return detail && head && composer
            && parseFloat(getComputedStyle(detail).getPropertyValue('--conversation-head-height')) === Math.round(head.getBoundingClientRect().height)
            && parseFloat(getComputedStyle(detail).getPropertyValue('--conversation-compose-height')) === Math.round(composer.getBoundingClientRect().height);
        });
        const zoomMetrics = await listPage.evaluate(() => {
          const box = (selector) => document.querySelector(selector).getBoundingClientRect();
          const detail = document.querySelector('.detail-chat');
          const head = box('.detail-head'); const composer = box('.composer-wrap');
          const controls = [...document.querySelectorAll('.detail-head button, .composer-wrap button')].map((node) => node.getBoundingClientRect().toJSON());
          const equalHeights = ['.detail-back', '.conv-peer-status', '.conv-contact-avatar', '.composer-tool', '.composer .vr-mic, .composer .btn.primary'].map((selector) => box(selector).height);
          const field = document.querySelector('.composer .field');
          const rows = [...document.querySelectorAll('.msg-row')].map((node) => node.getBoundingClientRect());
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            viewport: { width: innerWidth, height: innerHeight }, head: head.toJSON(), composer: composer.toJSON(), controls, equalHeights,
            field: { height: field.getBoundingClientRect().height, clientHeight: field.clientHeight, scrollHeight: field.scrollHeight },
            headReserve: parseFloat(getComputedStyle(detail).getPropertyValue('--conversation-head-height')),
            composeReserve: parseFloat(getComputedStyle(detail).getPropertyValue('--conversation-compose-height')),
            directionGap: rows[1].top - rows[0].bottom,
            continuationGap: rows[2].top - rows[1].bottom,
          };
        });
        assert.equal(zoomMetrics.overflow, 0, `${engineName} ${dark ? 'dark' : 'light'} 390px 200% conversation has no horizontal overflow`);
        for (const overlay of [zoomMetrics.head, zoomMetrics.composer]) {
          assert.ok(overlay.left >= 0 && overlay.right <= zoomMetrics.viewport.width && overlay.top >= 0 && overlay.bottom <= zoomMetrics.viewport.height,
            `${engineName} ${dark ? 'dark' : 'light'} 200% overlay remains inside viewport ${JSON.stringify(overlay)}`);
        }
        assert.equal(zoomMetrics.headReserve, Math.round(zoomMetrics.head.height), `${engineName} ${dark ? 'dark' : 'light'} 200% header reserve follows ResizeObserver`);
        assert.equal(zoomMetrics.composeReserve, Math.round(zoomMetrics.composer.height), `${engineName} ${dark ? 'dark' : 'light'} 200% composer reserve follows ResizeObserver`);
        assert.ok(zoomMetrics.controls.every((control) => control.width >= 44 && control.height >= 44
          && control.left >= 0 && control.right <= zoomMetrics.viewport.width && control.top >= 0 && control.bottom <= zoomMetrics.viewport.height),
        `${engineName} ${dark ? 'dark' : 'light'} 200% overlay controls retain contained 44px targets ${JSON.stringify(zoomMetrics.controls)}`);
        assert.ok(zoomMetrics.equalHeights.every((height) => height >= 44 && Math.abs(height - zoomMetrics.equalHeights[0]) <= 1), `${engineName} ${dark ? 'dark' : 'light'} 200% fixed top and bottom controls retain equal 44px heights ${zoomMetrics.equalHeights}`);
        assert.ok(zoomMetrics.field.height >= 44 && zoomMetrics.field.scrollHeight <= zoomMetrics.field.clientHeight + 2, `${engineName} ${dark ? 'dark' : 'light'} 200% text field may grow for Dynamic Type without vertical clipping ${JSON.stringify(zoomMetrics.field)}`);
        assert.ok(zoomMetrics.directionGap >= 8, `${engineName} ${dark ? 'dark' : 'light'} 200% direction turn retains >=8px (${zoomMetrics.directionGap}px)`);
        assert.ok(zoomMetrics.continuationGap > 0 && zoomMetrics.continuationGap < zoomMetrics.directionGap,
          `${engineName} ${dark ? 'dark' : 'light'} 200% continuation stays compact (${zoomMetrics.continuationGap}px vs ${zoomMetrics.directionGap}px)`);
        const timeline = listPage.locator('.messages');
        await timeline.evaluate((node) => { node.scrollTop = 0; });
        const firstReachable = await listPage.evaluate(() => ({
          row: document.querySelector('.msg-row').getBoundingClientRect().toJSON(),
          head: document.querySelector('.detail-head').getBoundingClientRect().toJSON(),
          scrollTop: document.querySelector('.messages').scrollTop,
        }));
        assert.ok(firstReachable.row.bottom > firstReachable.head.bottom && firstReachable.row.top < zoomMetrics.composer.top,
          `${engineName} ${dark ? 'dark' : 'light'} 200% first message is reachable in the exposed canvas ${JSON.stringify(firstReachable)}`);
        await timeline.evaluate((node) => { node.scrollTop = node.scrollHeight; });
        const lastReachable = await listPage.evaluate(() => ({
          row: [...document.querySelectorAll('.msg-row')].at(-1).getBoundingClientRect().toJSON(),
          composer: document.querySelector('.composer-wrap').getBoundingClientRect().toJSON(),
          scrollTop: document.querySelector('.messages').scrollTop,
        }));
        assert.ok(lastReachable.row.bottom <= lastReachable.composer.top - 8 && lastReachable.row.bottom > zoomMetrics.head.bottom,
          `${engineName} ${dark ? 'dark' : 'light'} 200% last message clears the measured composer while remaining reachable ${JSON.stringify(lastReachable)}`);
        if (captureDir && engineName === 'chromium') {
          await listPage.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });
          await listPage.locator('.contact-row.grouped').first().waitFor();
          await listPage.setViewportSize({ width: 390, height: 812 });
          await listPage.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
          await settleAnimations(listPage);
          assert.equal(await listPage.locator('[role="dialog"]').count(), 0, 'capture list has no open modal');
          await listPage.getByRole('tab', { name: 'Recent' }).click();
          await settleAnimations(listPage);
          await listPage.screenshot({ path: join(captureDir, `mobile-list-collapsed-recent-${dark ? 'dark' : 'light'}.png`) });
          await listPage.locator('.adaptive-search .field').focus();
          await listPage.waitForFunction(() => document.activeElement === document.querySelector('.adaptive-search .field'));
          await settleAnimations(listPage);
          await listPage.screenshot({ path: join(captureDir, `mobile-list-search-focused-${dark ? 'dark' : 'light'}.png`) });
          await listPage.locator('.adaptive-search .field').press('Escape');
          await listPage.getByRole('tab', { name: 'By identity' }).click();
          await settleAnimations(listPage);
          await listPage.screenshot({ path: join(captureDir, `mobile-list-collapsed-identity-${dark ? 'dark' : 'light'}.png`) });
          await listPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
          await listPage.locator('.composer textarea').waitFor();
          await settleConversation(listPage);
          await listPage.locator('.messages').evaluate((node) => { node.scrollTop = Math.max(1, Math.round((node.scrollHeight - node.clientHeight) / 2)); });
          await listPage.locator('.jump-latest').waitFor();
          await settleConversation(listPage);
          await listPage.screenshot({ path: join(captureDir, `mobile-conversation-empty-${dark ? 'dark' : 'light'}.png`) });
          await listPage.locator('.composer textarea').fill('Ready to send');
          await listPage.waitForFunction(() => !document.querySelector('.composer .btn.primary')?.disabled);
          await settleConversation(listPage);
          await listPage.screenshot({ path: join(captureDir, `mobile-conversation-typed-${dark ? 'dark' : 'light'}.png`) });
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
