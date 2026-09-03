import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the accessibility browser gate');
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

try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  let pending = [
    { name: 'Waiting person', container_id: 'WAITING', queued: 2 },
    { name: 'Rejected person', container_id: 'REJECTED', queued: 1 },
    { name: 'Failing person', container_id: 'FAIL', queued: 3 },
  ];
  const decisions = [];
  let failInvites = false;
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({
      contacts: [{ name: 'Peer', container_id: 'PEER' }],
      pending,
    });
    if (url.pathname === '/api/contacts/introductions') {
      const body = route.request().postDataJSON();
      decisions.push(body);
      if (body.contact === 'FAIL') return json({ error: { message: 'decision fixture failed' } }, 500);
      pending = pending.filter((item) => item.container_id !== body.contact);
      return json({ ok: true });
    }
    if (url.pathname === '/api/conversations/PEER/page') return json({
      contact: 'PEER', messages: [], total: 0, unread: 0, hasMore: false, nextBefore: null,
    });
    if (url.pathname === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (url.pathname === '/api/invites') return failInvites ? json({ error: { message: 'invite fixture failed' } }, 500) : json([]);
    if (url.pathname === '/api/events') return route.fallback();
    return json({}, 404);
  });
  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const listInvite = page.locator('.listcol-head').getByRole('button', { name: 'Invite' });
  const listSettings = page.locator('.listcol-head').getByRole('button', { name: 'Settings' });
  await listInvite.waitFor();
  await listInvite.focus();
  await page.keyboard.press('Tab');
  assert.equal(await listSettings.evaluate((node) => document.activeElement === node), true, 'compact list actions retain predictable keyboard order');

  const pendingText = page.getByText('Waiting person', { exact: true });
  await pendingText.waitFor();
  assert.equal(await pendingText.locator('xpath=ancestor::button').count(), 0, 'pending introduction is not a fake button');
  const waitingRow = pendingText.locator('xpath=ancestor::div[contains(@class,"contact-row")]');
  assert.match(await waitingRow.innerText(), /2 queued/);
  const restingPendingStyle = await waitingRow.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderColor };
  });
  await waitingRow.hover();
  assert.deepEqual(await waitingRow.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderColor };
  }), restingPendingStyle, 'light-theme pending row has no fake hover affordance');
  await waitingRow.getByRole('button', { name: 'Approve' }).click();
  await pendingText.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.id === 'chat-list-title');
  assert.deepEqual(decisions[0], { contact: 'WAITING', action: 'approve' }, 'inline approval addresses the pending identity');
  const rejectedText = page.getByText('Rejected person', { exact: true });
  const rejectedRow = rejectedText.locator('xpath=ancestor::div[contains(@class,"contact-row")]');
  await rejectedRow.getByRole('button', { name: 'Reject' }).click();
  await rejectedText.waitFor({ state: 'detached' });
  assert.deepEqual(decisions[1], { contact: 'REJECTED', action: 'reject' }, 'inline rejection addresses the pending identity');
  const failingText = page.getByText('Failing person', { exact: true });
  const failingRow = failingText.locator('xpath=ancestor::div[contains(@class,"contact-row")]');
  const failingApprove = failingRow.getByRole('button', { name: 'Approve' });
  await failingApprove.click();
  await page.getByRole('alert').filter({ hasText: 'decision fixture failed' }).waitFor();
  assert.equal(await failingText.count(), 1, 'failed decision keeps the pending row');
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Approve');
  assert.equal(await failingApprove.evaluate((node) => document.activeElement === node), true, 'failed decision keeps focus at the action');

  await page.getByRole('button', { name: 'Invite' }).click();
  const generate = page.getByRole('tab', { name: 'Generate invite' });
  const accept = page.getByRole('tab', { name: 'Accept invite' });
  assert.equal(await generate.getAttribute('tabindex'), '0');
  assert.equal(await accept.getAttribute('tabindex'), '-1');
  assert.equal(await generate.getAttribute('aria-controls'), 'invite-panel');
  await generate.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await accept.getAttribute('aria-selected'), 'true');
  assert.equal(await accept.evaluate((node) => document.activeElement === node), true);
  assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'), 'invite-tab-accept');
  await page.keyboard.press('Home');
  assert.equal(await generate.getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'Close Invite a contact' }).click();

  const identityTrigger = page.getByRole('button', { name: /Open contact details/i });
  await identityTrigger.click();
  await page.getByRole('heading', { name: 'Verified identity' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-contact-trigger'));
  assert.equal(await identityTrigger.evaluate((node) => document.activeElement === node), true, 'desktop contact screen restores trigger focus');

  await page.setViewportSize({ width: 390, height: 844 });
  await identityTrigger.click();
  await page.getByRole('heading', { name: 'Verified identity' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-contact-trigger'));
  assert.equal(await identityTrigger.evaluate((node) => document.activeElement === node), true, 'mobile contact screen restores trigger focus');
  await page.setViewportSize({ width: 1280, height: 800 });

  await identityTrigger.click();
  await page.getByRole('button', { name: /Shared photos, files, and links/ }).click();
  const photo = page.getByRole('tab', { name: /Photos/ });
  const files = page.getByRole('tab', { name: /Files/ });
  await photo.focus();
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: /Links/ }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await photo.getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: /Links/ }).getAttribute('aria-selected'), 'true', 'Arrow navigation wraps backward');
  assert.equal(await page.getByRole('tabpanel').getAttribute('id'), 'shared-media-panel');
  assert.equal(await files.getAttribute('aria-controls'), 'shared-media-panel');
  await page.getByRole('button', { name: 'Close Shared media' }).click();
  await page.keyboard.press('Escape');

  await context.setOffline(true);
  await page.getByRole('status').filter({ hasText: 'Offline — reconnecting' }).waitFor();
  assert.equal(await page.getByRole('status').filter({ hasText: 'Offline — reconnecting' }).getAttribute('aria-live'), 'polite');
  await context.setOffline(false);
  failInvites = true;
  await page.getByRole('button', { name: 'Invite' }).click();
  const apiAlert = page.getByRole('alert').filter({ hasText: 'invite fixture failed' });
  await apiAlert.waitFor();
  assert.equal(await apiAlert.getAttribute('aria-live'), 'assertive');
  await context.close();
  console.log('browser-accessibility-controls OK — menu focus, pending semantics, live status, and tab keyboard contracts');
} finally {
  for (const stream of streams) stream.destroy();
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
