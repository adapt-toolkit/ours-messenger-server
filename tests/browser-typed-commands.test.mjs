import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the typed-command browser gate');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  response.end(readFileSync(path));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

try {
  const sends = [];
  let sendMode = 'response-loss';
  const messages = [
    { dir: 'out', text: '', date: '2026-09-03T00:00:00Z', read: true, wire_id: 'COMMAND-OLD', peer_cid: 'PEER', receipt: 'delivered', reply_to: null, message_kind: 'command', typed: { kind: 'command', command: 'old.command', arguments: {} } },
    { dir: 'in', text: '', date: '2026-09-03T00:00:01Z', read: true, wire_id: 'RESULT-GOOD', peer_cid: 'PEER', receipt: null, reply_to: { wire_id: 'COMMAND-OLD' }, message_kind: 'command_result', typed: { kind: 'command_result', outcome: { ok: true, result: 0 } } },
    { dir: 'in', text: '', date: '2026-09-03T00:00:02Z', read: true, wire_id: 'RESULT-BAD-PEER', peer_cid: 'OTHER', receipt: null, reply_to: { wire_id: 'COMMAND-OLD' }, message_kind: 'command_result', typed: { kind: 'command_result', outcome: { ok: true, result: 1 } } },
    { dir: 'in', text: 'ordinary', date: '2026-09-03T00:00:03Z', read: true, wire_id: 'TEXT', peer_cid: 'PEER', receipt: null, reply_to: null, message_kind: 'text', typed: null },
    { dir: 'in', text: '', date: '2026-09-03T00:00:04Z', read: true, wire_id: 'RESULT-WRONG-TARGET', peer_cid: 'PEER', receipt: null, reply_to: { wire_id: 'TEXT' }, message_kind: 'command_result', typed: { kind: 'command_result', outcome: { ok: true, result: 2 } } },
    { dir: 'in', text: '', date: '2026-09-03T00:00:05Z', read: true, wire_id: 'RESULT-NO-REPLY', peer_cid: 'PEER', receipt: null, reply_to: null, message_kind: 'command_result', typed: { kind: 'command_result', outcome: { ok: true, result: 3 } } },
    { dir: 'in', text: '', date: '2026-09-03T00:00:06Z', read: true, wire_id: 'COMMAND-IN', peer_cid: 'PEER', receipt: null, reply_to: null, message_kind: 'command', typed: { kind: 'command', command: 'incoming.command', arguments: {} } },
    { dir: 'in', text: '', date: '2026-09-03T00:00:07Z', read: true, wire_id: 'RESULT-INBOUND-TARGET', peer_cid: 'PEER', receipt: null, reply_to: { wire_id: 'COMMAND-IN' }, message_kind: 'command_result', typed: { kind: 'command_result', outcome: { ok: true, result: 4 } } },
  ];
  const catalog = {
    recipient_cid: 'PEER', fingerprint: 'A'.repeat(43), commands: [{
      name: 'values.capture', description: 'Capture explicit JSON values', input_schema: {
        type: 'object', required: ['required'], properties: {
          required: { type: 'string', title: 'Required' },
          optionalText: { type: 'string', title: 'Optional text' },
          zero: { type: 'integer', title: 'Zero' },
          flag: { type: 'boolean', title: 'Flag' },
          nil: { type: 'null', title: 'Nil' },
          '': { type: 'string', title: 'Empty key' },
          tags: { type: 'array', title: 'Tags', items: { type: 'integer' }, minItems: 1 },
          otherTags: { type: 'array', title: 'Other tags', items: { type: 'string' }, default: [] },
        },
      },
    }],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (path === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
    if (path === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (path === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
    if (path === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (path === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (path === '/api/contacts/PEER/commands') return json(catalog);
    if (path === '/api/commands/send') {
      const body = request.postDataJSON(); sends.push(body);
      if (sendMode === 'response-loss') return route.abort('connectionreset');
      return json({
        invocation_id: body.invocation_id, recipient_cid: 'PEER', catalog_fingerprint: body.catalog_fingerprint,
        command: body.command, wire_id: 'WIRE-NEW', delivery: 'e2e', status: 'accepted',
        payload_fingerprint: 'B'.repeat(43), deduplicated: true,
      });
    }
    if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Recipient commands' }).click();
  const panel = page.getByRole('form', { name: 'Send a typed command' });
  await panel.waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Add Optional text' }).count(), 1, 'optional fields are omitted initially');
  assert.equal(await panel.getByLabel('Optional text').count(), 0, 'an omitted optional string is not silently materialized as empty');
  await panel.getByLabel('Required').fill('present');
  for (const name of ['Optional text', 'Zero', 'Flag', 'Nil', 'Empty key', 'Tags']) {
    await panel.getByRole('button', { name: `Add ${name}` }).click();
  }
  await panel.getByRole('button', { name: 'Remove Optional text' }).click();
  assert.equal(await panel.getByRole('textbox', { name: 'Optional text' }).count(), 0, 'accessible remove returns an optional field to omission');
  await panel.getByRole('button', { name: 'Add Optional text' }).click();
  await panel.getByRole('textbox', { name: 'Optional text' }).fill('');
  await panel.getByRole('spinbutton', { name: 'Zero' }).fill('0');
  assert.equal(await panel.getByRole('checkbox', { name: 'Flag' }).isChecked(), false, 'explicit false survives adding an optional boolean');
  assert.equal(await panel.getByText('Null value').count(), 1, 'explicit null survives adding an optional null');
  await panel.getByRole('textbox', { name: 'Empty key' }).fill('');

  const tags = panel.getByRole('textbox', { name: /^Tags\b/ });
  const otherTags = panel.getByRole('textbox', { name: /^Other tags\b/ });
  assert.notEqual(await tags.getAttribute('aria-describedby'), await otherTags.getAttribute('aria-describedby'), 'array help ids are unique and path based');
  await tags.fill('[1');
  await panel.getByRole('alert').getByText(/valid JSON/).waitFor();
  assert.equal(await tags.inputValue(), '[1', 'invalid array source remains visible instead of reverting to stale parsed data');
  assert.equal(await panel.getByRole('button', { name: 'Send command' }).isDisabled(), true, 'visible invalid array source blocks send');
  await tags.fill('[0]');
  await panel.getByLabel(/Confirm sending/).check();

  const sendButton = panel.getByRole('button', { name: 'Send command' });
  await page.evaluate(() => {
    const button = document.querySelector('.command-panel .btn.primary');
    button?.click(); button?.click();
  });
  await panel.getByText(/state is indeterminate/i).waitFor();
  assert.equal(sends.length, 1, 'two synchronous activations create one request');
  assert.equal(new Set(sends.map((body) => body.invocation_id)).size, 1, 'one stable invocation id belongs to the attempt');
  assert.deepEqual(sends[0].arguments, {
    required: 'present', optionalText: '', zero: 0, flag: false, nil: null, '': '', tags: [0], otherTags: [],
  }, 'omission and explicit empty/zero/false/null/empty-key values remain distinct and faithful');
  assert.equal(await sendButton.isDisabled(), true, 'an indeterminate attempt stays locked');

  const savedInvocation = sends[0].invocation_id;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Recipient commands' }).click();
  const restored = page.getByRole('form', { name: 'Send a typed command' });
  await restored.getByText(`Saved attempt: indeterminate`).waitFor();
  assert.match(await restored.locator('.command-attempt .mono').innerText(), new RegExp(savedInvocation), 'reload restores the identity/recipient-scoped attempt');
  sendMode = 'accepted';
  await restored.getByRole('button', { name: 'Reconcile saved attempt' }).click();
  await restored.getByText(/reconciled/i).waitFor();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].invocation_id, savedInvocation, 'response-loss reconciliation replays the same stable invocation id');

  const completed = page.getByText('Completed', { exact: true });
  await completed.waitFor();
  assert.equal(await completed.count(), 1, 'only the authenticated result for the exact outgoing command renders completed');
  assert.equal(await page.getByText(/Unmatched result · safe failure/).count(), 4,
    'wrong peer, ordinary/inbound reply targets, and missing replies never render completed');
  const box = await restored.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'command form remains within the narrow mobile viewport');
  const commandTrigger = page.getByRole('button', { name: 'Recipient commands' });
  await restored.getByRole('button', { name: 'Close commands' }).click();
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'close button closes the command form');
  assert.equal(await commandTrigger.evaluate((element) => document.activeElement === element), true,
    'close button restores focus to the Recipient commands trigger');
  await commandTrigger.click();
  await restored.waitFor();
  await restored.getByRole('button', { name: 'Reset after verifying outcome' }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'keyboard Escape closes the command form');
  assert.equal(await commandTrigger.evaluate((element) => document.activeElement === element), true,
    'keyboard Escape restores focus to the Recipient commands trigger');

  console.log('browser-typed-commands OK — keyboard/mobile form, raw validation, stable persisted attempt, strict correlation');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
