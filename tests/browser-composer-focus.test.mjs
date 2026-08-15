import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the composer browser gate');

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

try {
  const sends = [];
  let stallConversationRefresh = false;
  let sendBehavior = 'resolved';
  let releaseManualSend = null;
  const conversationMessages = [
    { dir: 'in', text: 'reply target', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'WIRE-1', receipt: null },
  ];
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  // iOS will not reopen the software keyboard for a focus() call made after an
  // awaited request. Blocking that fallback makes the regression deterministic
  // in Chromium: a passing composer must retain focus without needing the call.
  await context.addInitScript(() => {
    const nativeFocus = HTMLTextAreaElement.prototype.focus;
    HTMLTextAreaElement.prototype.focus = function composerFocus(...args) {
      if (this.closest('.composer') && globalThis.__blockAsyncComposerFocus) return;
      return nativeFocus.apply(this, args);
    };
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: '@ours.network/messenger-server', version: '0.1.0', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      if (stallConversationRefresh) return new Promise(() => {});
      return json({
        contact: 'PEER',
        messages: conversationMessages,
        total: conversationMessages.length, unread: 0, hasMore: false, nextBefore: null,
      });
    }
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (url.pathname === '/api/messages/send') {
      const body = request.postDataJSON();
      sends.push(body);
      if (sendBehavior === 'lost-with-history') {
        conversationMessages.push({
          dir: 'out', text: body.text, date: '2026-08-15T00:00:01.000Z', read: true,
          wire_id: `HISTORY-${sends.length}`, receipt: null,
          ...(body.reply_to_wire_id ? { reply_to: { wire_id: body.reply_to_wire_id } } : {}),
        });
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        return route.abort('connectionreset');
      }
      if (sendBehavior === 'lost') {
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        return route.abort('connectionreset');
      }
      if (sendBehavior === 'manual') {
        await new Promise((resolveWait) => { releaseManualSend = resolveWait; });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      if (body.text === 'fixture failure') return json({ error: { message: 'fixture rejected' } }, 500);
      const wireId = `SENT-${sends.length}`;
      conversationMessages.push({
        dir: 'out', text: body.text, date: '2026-08-15T00:00:02.000Z', read: true,
        wire_id: wireId, receipt: null,
        ...(body.reply_to_wire_id ? { reply_to: { wire_id: body.reply_to_wire_id } } : {}),
      });
      return json({ wire_id: wireId });
    }
    if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('.composer textarea');
  const sendButton = page.locator('.composer').getByRole('button', { name: 'Send' });
  await composer.waitFor();

  stallConversationRefresh = true;
  await composer.fill('delivered before refresh stalls');
  const deliveredResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await deliveredResponse;
  await page.waitForTimeout(100);
  assert.equal(await composer.getAttribute('aria-busy'), 'false',
    'a resolved send transaction settles the composer without waiting for a later REST/SSE reconciliation');
  stallConversationRefresh = false;
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');

  sendBehavior = 'manual';
  await composer.fill('optimistic message stays visible');
  const optimisticResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await page.getByText('optimistic message stays visible', { exact: true }).waitFor();
  assert.equal(await composer.getAttribute('aria-busy'), 'true',
    'the visible optimistic bubble does not pretend the network transaction has settled');
  releaseManualSend?.();
  await optimisticResponse;
  sendBehavior = 'resolved';
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');

  await composer.fill('successful async send');
  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = true; });
  const successResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  assert.equal(await composer.inputValue(), '', 'submitted text clears immediately instead of freezing until network settlement');
  assert.equal(await composer.isEnabled(), true, 'in-flight send never disables and blurs the focused textarea');
  assert.equal(await sendButton.isDisabled(), true, 'in-flight send still disables duplicate submit activation');
  await successResponse;
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
  assert.equal(await composer.evaluate((node) => document.activeElement === node), true,
    'successful async mobile send retains textarea focus without an async focus fallback');

  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = false; });
  await composer.fill('submitted snapshot');
  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = true; });
  const editedDraftResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await composer.fill('newer draft ');
  await editedDraftResponse;
  assert.equal(await composer.inputValue(), 'newer draft ',
    'successful send preserves an exact newer draft edited while the request is pending');

  await page.clock.install();
  sendBehavior = 'lost-with-history';
  await composer.fill('history reconciles lost response');
  await sendButton.tap();
  await composer.fill('new draft survives reconciliation');
  await page.clock.fastForward(15_001);
  await page.getByText('history reconciles lost response', { exact: true }).last().waitFor();
  assert.equal(await composer.getAttribute('aria-busy'), 'false',
    'lost delivery completion reaches a bounded non-busy state');
  assert.equal(await composer.inputValue(), 'new draft survives reconciliation',
    'later canonical history does not clear a newer draft');
  assert.equal(await composer.evaluate((node) => document.activeElement === node), true,
    'later canonical history does not steal mobile composer focus');

  sendBehavior = 'lost';
  await composer.fill('unknown delivery');
  await sendButton.tap();
  await page.clock.fastForward(15_001);
  await page.getByText(/delivery status is unknown/i).waitFor();
  assert.equal(await composer.getAttribute('aria-busy'), 'false',
    'outcome-unknown timeout releases visible busy state');
  assert.equal(await composer.inputValue(), 'unknown delivery',
    'outcome-unknown timeout preserves the draft');
  assert.equal(await sendButton.isDisabled(), true,
    'the exact outcome-unknown payload is guarded against a blind retry');
  const unknownCount = sends.filter((body) => body.text === 'unknown delivery').length;
  const sendBox = await sendButton.boundingBox();
  assert.ok(sendBox);
  await page.touchscreen.tap(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
  await page.touchscreen.tap(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
  await page.waitForTimeout(100);
  assert.equal(sends.filter((body) => body.text === 'unknown delivery').length, unknownCount,
    'repeated physical taps do not duplicate an outcome-unknown delivery');
  sendBehavior = 'resolved';
  await composer.fill('edited after unknown');
  const editedAfterUnknownResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await editedAfterUnknownResponse;
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
  assert.equal(sends.filter((body) => body.text === 'edited after unknown').length, 1,
    'editing creates one explicit new transaction after an outcome-unknown send');

  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = false; });
  await composer.fill('fixture failure');
  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = true; });
  const failureResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await failureResponse;
  await page.getByText(/fixture rejected/).waitFor();
  assert.equal(await composer.inputValue(), 'fixture failure', 'failed send preserves the draft');
  assert.equal(await composer.evaluate((node) => document.activeElement === node), true,
    'failed send does not close or steal the engaged composer focus');

  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = false; });
  await page.locator('#chat-message-WIRE-1 .msg-reply').evaluate((button) => button.click());
  await page.getByText('Replying to Peer').waitFor();
  await composer.fill('reply send');
  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = true; });
  const replyResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await replyResponse;
  await page.getByText('Replying to Peer').waitFor({ state: 'detached' });
  assert.equal(sends.at(-1)?.reply_to_wire_id, 'WIRE-1', 'reply context reaches the actual send request');
  assert.equal(await composer.evaluate((node) => document.activeElement === node), true,
    'successful reply send keeps the mobile composer engaged');

  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = false; });
  await composer.fill('rapid send');
  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = true; });
  await sendButton.evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
  assert.equal(sends.filter((body) => body.text === 'rapid send').length, 1,
    'same-turn rapid activation submits one request');

  await page.evaluate(() => { globalThis.__blockAsyncComposerFocus = false; });
  await composer.fill('tool focus send');
  const toolResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  const attach = page.getByTitle('Attach a file or photo');
  await attach.focus();
  await toolResponse;
  assert.equal(await attach.evaluate((node) => document.activeElement === node), true,
    'async completion does not steal focus from an explicit attachment control');

  await composer.fill('voice focus send');
  const voiceResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  const voice = page.getByTitle('Hold to record a voice message');
  await voice.focus();
  await voiceResponse;
  assert.equal(await voice.evaluate((node) => document.activeElement === node), true,
    'async completion does not steal focus from an explicit voice control');

  await composer.fill('navigation send');
  const navigationResponse = page.waitForResponse((response) => response.url().endsWith('/api/messages/send'));
  await sendButton.tap();
  await page.locator('.detail-back').tap();
  await navigationResponse;
  assert.equal(new URL(page.url()).pathname, '/chats', 'explicit mobile navigation remains authoritative during send');
  assert.equal(await page.locator('.composer textarea').count(), 0,
    'async completion does not reopen or refocus a composer after navigation');

  await context.close();
  console.log('browser-composer-focus OK — mobile focus, settlement, timeout, reconciliation, and duplicate safety');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
