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

const rgb = (value) => {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `expected a computed RGB color, received ${value}`);
  return channels;
};
const relativeLuminance = (value) => rgb(value)
  .map((channel) => channel / 255)
  .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrastRatio = (foreground, background) => {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

async function outgoingMetadataContrast(page, dark) {
  await page.evaluate((enabled) => document.documentElement.classList.toggle('theme-dark', enabled), dark);
  const bubble = page.locator('#chat-message-COMMAND-PENDING .typed-message.ours-message--out');
  const styles = await bubble.evaluate((element) => {
    const bubbleStyle = getComputedStyle(element);
    const read = (selector) => {
      const child = element.querySelector(selector);
      if (!child) throw new Error(`missing typed-message metadata ${selector}`);
      const style = getComputedStyle(child);
      return { color: style.color, opacity: style.opacity };
    };
    return {
      backgroundColor: bubbleStyle.backgroundColor,
      backgroundImage: bubbleStyle.backgroundImage,
      metadata: {
        eyebrow: read('.typed-message-kind'),
        state: read('.typed-message-state'),
        timestamp: read('.bubble-at'),
        receipt: read('.ticks'),
      },
    };
  });
  const backgrounds = styles.backgroundImage === 'none'
    ? [styles.backgroundColor]
    : [...styles.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].map(([color]) => color);
  assert.ok(backgrounds.length > 0, `expected a computed bubble background, received ${JSON.stringify(styles)}`);
  return Object.fromEntries(Object.entries(styles.metadata).map(([name, metadata]) => {
    assert.equal(metadata.opacity, '1', `${name} is not attenuated by opacity in the ${dark ? 'dark' : 'light'} theme`);
    return [name, Math.min(...backgrounds.map((background) => contrastRatio(metadata.color, background)))];
  }));
}

try {
  const sends = [];
  const sendModes = [];
  let releaseSend = null;
  const messages = [
    { dir: 'out', text: '', date: '2026-09-03T00:00:00Z', read: true, wire_id: 'COMMAND-OLD', peer_cid: 'PEER', receipt: 'delivered', reply_to: null, message_kind: 'command', typed: { kind: 'command', command: 'old.command', arguments: {} } },
    { dir: 'in', text: '', date: '2026-09-03T00:00:01Z', read: true, wire_id: 'RESULT-GOOD', peer_cid: 'PEER', receipt: null, reply_to: { wire_id: 'COMMAND-OLD' }, message_kind: 'command_result', typed: { kind: 'command_result', outcome: { ok: true, result: 0 } } },
    { dir: 'out', text: '', date: '2026-09-03T00:00:01.500Z', read: true, wire_id: 'COMMAND-PENDING', peer_cid: 'PEER', receipt: 'read', reply_to: null, message_kind: 'command', typed: { kind: 'command', command: 'list-members', arguments: {} } },
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
        type: 'object', additionalProperties: false, required: ['required'], properties: {
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
    }, {
      name: 'remove-member', description: 'Remove a Cowork member', input_schema: {
        type: 'object', additionalProperties: false, required: ['member'], properties: {
          member: { type: 'string', title: 'Member', pattern: '^[A-F0-9]{64}$' },
        },
      },
    }],
  };
  let advertisedCatalog = catalog;
  let catalogLoads = 0;
  let heldCatalogRead = null;
  const installRoutes = (targetContext) => targetContext.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/identity') return json({ name: 'Me', cid: 'ME' });
    if (path === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
    if (path === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (path === '/api/conversations/PEER/page') return json({ contact: 'PEER', messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null });
    if (path === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
    if (path === '/api/conversations/PEER/files') return json({ contact: 'PEER', files: [] });
    if (path === '/api/contacts/PEER/commands') {
      catalogLoads++;
      const heldRead = heldCatalogRead;
      heldCatalogRead = null;
      if (heldRead) await heldRead;
      return json(advertisedCatalog);
    }
    if (path === '/api/commands/send') {
      const body = request.postDataJSON(); sends.push(body);
      const sendMode = sendModes.shift() ?? 'accepted';
      if (sendMode === 'response-loss') return route.abort('connectionreset');
      if (sendMode === 'hold-accepted') await new Promise((done) => { releaseSend = done; });
      return json({
        invocation_id: body.invocation_id, recipient_cid: 'PEER', catalog_fingerprint: body.catalog_fingerprint,
        command: body.command, wire_id: `WIRE-${sends.length}`, delivery: 'e2e', status: sendMode === 'hold-accepted' ? 'accepted' : sendMode,
        payload_fingerprint: 'B'.repeat(43), deduplicated: true,
      });
    }
    if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return json({}, 404);
  });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await installRoutes(context);
  const page = await context.newPage();
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const commandTrigger = page.getByRole('button', { name: 'Recipient commands' });
  await commandTrigger.waitFor();
  await page.waitForTimeout(50);
  assert.equal(catalogLoads, 1, 'opening a selected chat performs one bounded catalog read, not render-driven polling');
  await page.locator('#chat-message-COMMAND-PENDING').getByText('Accepted · pending result', { exact: true }).waitFor();
  const outgoingContrast = {};
  for (const dark of [true, false]) {
    const ratios = await outgoingMetadataContrast(page, dark);
    outgoingContrast[dark ? 'dark' : 'light'] = Object.fromEntries(
      Object.entries(ratios).map(([name, ratio]) => [name, Number(ratio.toFixed(2))]),
    );
    for (const [name, ratio] of Object.entries(ratios)) {
      assert.ok(ratio >= 4.5,
        `${name} meets WCAG AA contrast in the ${dark ? 'dark' : 'light'} outgoing typed-command bubble (measured ${ratio.toFixed(2)}:1)`);
    }
  }
  assert.equal(await page.locator('#chat-message-COMMAND-PENDING .ticks').getAttribute('aria-label'), 'Message read',
    'the higher-contrast receipt preserves its accessible read label');
  const screenshotBubble = await page.locator('#chat-message-COMMAND-PENDING .typed-message').boundingBox();
  assert.ok(screenshotBubble && screenshotBubble.x >= 0 && screenshotBubble.x + screenshotBubble.width <= 390,
    'the screenshot command bubble remains contained in the narrow mobile viewport');
  await page.evaluate(() => document.documentElement.classList.add('theme-dark'));

  const screenshotContext = await browser.newContext({ viewport: { width: 339, height: 288 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await installRoutes(screenshotContext);
  const screenshotPage = await screenshotContext.newPage();
  await screenshotPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await screenshotPage.locator('#chat-message-COMMAND-PENDING .typed-message-state').waitFor();
  const screenshotRatios = await outgoingMetadataContrast(screenshotPage, true);
  const screenshotSizeBubble = await screenshotPage.locator('#chat-message-COMMAND-PENDING .typed-message').boundingBox();
  assert.ok(Object.values(screenshotRatios).every((ratio) => ratio >= 4.5)
    && screenshotSizeBubble && screenshotSizeBubble.x >= 0 && screenshotSizeBubble.x + screenshotSizeBubble.width <= 339,
  'metadata stays AA-legible and horizontally contained at the authoritative screenshot size');
  await screenshotContext.close();
  assert.equal((await commandTrigger.innerText()).trim(), '', 'the compact command affordance has no truncating text label');
  assert.equal(await commandTrigger.locator('svg').count(), 1, 'the compact command affordance renders one menu icon');
  const triggerBox = await commandTrigger.boundingBox();
  assert.ok(triggerBox && triggerBox.width === 44 && triggerBox.height >= 44,
    'the menu icon retains a compact 44px touch target');
  await commandTrigger.click();
  const panel = page.getByRole('form', { name: 'Send a typed command' });
  await panel.waitFor();
  await panel.getByText('Commands for Peer', { exact: true }).waitFor();
  assert.equal(await panel.locator('.command-panel-recipient .mono').getAttribute('title'), 'PEER',
    'the authenticated recipient CID remains available as secondary identity context');
  const mobileFieldStyle = await panel.getByLabel('Required').evaluate((element) => getComputedStyle(element));
  assert.equal(mobileFieldStyle.fontSize, '16px', 'command fields use the app mobile 16px treatment');
  for (const control of [panel.getByRole('button', { name: 'Refresh' }), panel.getByRole('button', { name: 'Add Optional text' })]) {
    const controlBox = await control.boundingBox();
    assert.ok(controlBox && controlBox.height >= 44, 'typed-command link controls expose a 44px touch target');
  }
  const refresh = panel.getByRole('button', { name: 'Refresh' });
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await refresh.evaluate((element) => document.activeElement === element), true,
    'keyboard navigation reaches the typed-command refresh action');
  assert.equal(await refresh.evaluate((element) => getComputedStyle(element).outlineStyle), 'solid',
    'typed-command link controls retain a clear keyboard focus indicator');
  const refreshBox = await refresh.boundingBox();
  assert.ok(refreshBox);
  await page.mouse.move(refreshBox.x + refreshBox.width / 2, refreshBox.y + refreshBox.height / 2);
  await page.mouse.down();
  assert.notEqual(await refresh.evaluate((element) => getComputedStyle(element).transform), 'none',
    'pointer-down receives immediate physical feedback');
  await page.mouse.up();
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
  await otherTags.fill(JSON.stringify(['x'.repeat(65536)]));
  await panel.getByRole('alert').getByText(/65536 UTF-8 bytes/).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Send command' }).isDisabled(), true,
    'an oversized free-form array is blocked in the browser before an invocation is reserved');
  await otherTags.fill('[]');
  const sendButton = panel.getByRole('button', { name: 'Send command' });
  assert.equal(await panel.getByLabel(/Confirm sending/).count(), 0, 'typed commands require no acknowledgement checkbox');
  sendModes.push('hold-accepted');
  await sendButton.click();
  assert.equal(sends.length, 1, 'the first command request starts immediately');
  assert.deepEqual(sends[0].arguments, {
    required: 'present', optionalText: '', zero: 0, flag: false, nil: null, '': '', tags: [0], otherTags: [],
  }, 'omission and explicit empty/zero/false/null/empty-key values remain distinct and faithful');
  assert.equal(await panel.getByLabel('Required').inputValue(), '',
    'submission resets the command form before its request resolves');
  await panel.getByLabel('Required').fill('again');
  await sendButton.click();
  await panel.getByText(/values\.capture sent/).waitFor();
  assert.equal(sends.length, 2, 'the same command can be sent again while its previous request is delayed');
  assert.equal(new Set(sends.slice(0, 2).map((body) => body.invocation_id)).size, 2,
    'each immediate resubmission receives an independent invocation id');

  await panel.locator('select').first().selectOption('remove-member');
  const memberField = panel.getByRole('textbox', { name: /^Member/ });
  await memberField.fill('not-a-cid');
  await panel.getByRole('alert').getByText(/required format/).waitFor();
  assert.equal(await sendButton.isDisabled(), true, 'an invalid pattern value blocks only that form with a field error');
  await memberField.fill('A'.repeat(64));
  assert.equal(await sendButton.isDisabled(), false, 'the bounded Cowork member pattern accepts a valid CID');
  sendModes.push('pending');
  await sendButton.click();
  await panel.getByText(/delivery is pending/i).waitFor();
  assert.equal(sends[2].command, 'remove-member', 'switching commands after a send uses the newly selected command');
  assert.equal(await panel.locator('select').first().inputValue(), 'remove-member',
    'pending delivery resets to a normal, reusable command form');

  await panel.getByRole('textbox', { name: /^Member/ }).fill('B'.repeat(64));
  sendModes.push('failed');
  await sendButton.click();
  await panel.getByText(/refused before delivery/i).waitFor();
  assert.equal(await panel.locator('.command-status').getAttribute('data-state'), 'error',
    'failed delivery is reported without locking the next invocation');
  await panel.getByRole('textbox', { name: /^Member/ }).fill('C'.repeat(64));
  await sendButton.click();
  await panel.getByText(/remove-member sent/).waitFor();
  assert.equal(sends.length, 5, 'a command with no eventual result does not block the next send');
  assert.equal(messages.some((message) => message.reply_to?.wire_id === 'WIRE-5'), false,
    'the fixture intentionally supplies no result for the accepted command');
  releaseSend?.();

  sendModes.push('response-loss');
  await panel.getByRole('textbox', { name: /^Member/ }).fill('D'.repeat(64));
  await sendButton.click();
  await panel.getByText(/could not be sent/i).waitFor();
  await panel.getByRole('textbox', { name: /^Member/ }).fill('D'.repeat(64));
  await sendButton.click();
  await panel.getByText(/remove-member sent/).waitFor();
  assert.equal(sends.length, 7, 'response loss does not require cancellation or acknowledgement before retry');

  const completed = page.getByText('Completed', { exact: true });
  await completed.waitFor();
  assert.equal(await completed.count(), 1, 'only the authenticated result for the exact outgoing command renders completed');
  assert.equal(await page.getByText(/Unmatched result · safe failure/).count(), 4,
    'wrong peer, ordinary/inbound reply targets, and missing replies never render completed');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Recipient commands' }).click();
  const restored = page.getByRole('form', { name: 'Send a typed command' });
  assert.equal(await restored.locator('.command-attempt').count(), 0,
    'reload has no stale attempt gate to reconcile, acknowledge, cancel, or reset');
  assert.equal(await restored.getByRole('button', { name: 'Send command' }).isDisabled(), false,
    'the normal command form is immediately available after reload');
  const box = await restored.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'command form remains within the narrow mobile viewport');
  await restored.getByRole('button', { name: 'Close commands' }).click();
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'close button closes the command form');
  assert.equal(await commandTrigger.evaluate((element) => document.activeElement === element), true,
    'close button restores focus to the Recipient commands trigger');
  await commandTrigger.click();
  await restored.waitFor();
  await restored.locator('select').first().focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('form', { name: 'Send a typed command' }).count(), 0, 'keyboard Escape closes the command form');
  assert.equal(await commandTrigger.evaluate((element) => document.activeElement === element), true,
    'keyboard Escape restores focus to the Recipient commands trigger');

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await installRoutes(desktopContext);
  const desktopPage = await desktopContext.newPage();
  await desktopPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  const desktopContrast = await outgoingMetadataContrast(desktopPage, true);
  assert.ok(Object.values(desktopContrast).every((ratio) => ratio >= 4.5),
    'outgoing typed-command metadata retains AA contrast in the desktop layout');
  await desktopPage.getByRole('button', { name: 'Recipient commands' }).click();
  const desktopPanel = desktopPage.getByRole('form', { name: 'Send a typed command' });
  await desktopPanel.waitFor();
  const desktopBox = await desktopPanel.boundingBox();
  assert.ok(desktopBox && desktopBox.x >= 0 && desktopBox.x + desktopBox.width <= 1280,
    'the command panel remains anchored within a desktop conversation');
  const baseMaterial = await desktopPanel.evaluate((element) => getComputedStyle(element));
  assert.equal(baseMaterial.backdropFilter, 'none', 'typed commands use an opaque, nonblocking surface');
  assert.doesNotMatch(baseMaterial.backgroundColor, /rgba\([^)]*,\s*0(?:\.\d+)?\)/,
    'the typed-command surface stays opaque, so reduced transparency is not required');
  await desktopPage.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
  const preferenceStyle = await desktopPanel.evaluate((element) => getComputedStyle(element));
  assert.equal(preferenceStyle.animationName, 'none', 'the typed-command panel remains static under reduced motion');
  assert.equal(preferenceStyle.boxShadow, 'none', 'increased contrast removes decorative panel shadow');
  assert.equal(preferenceStyle.borderTopColor, preferenceStyle.color, 'increased contrast promotes the panel border to currentColor');
  await desktopPage.emulateMedia({ forcedColors: 'active' });
  const forcedStyle = await desktopPanel.evaluate((element) => getComputedStyle(element));
  assert.equal(forcedStyle.borderTopStyle, 'solid', 'forced-colors mode retains a visible panel boundary');
  assert.equal(forcedStyle.backdropFilter, 'none', 'forced-colors mode retains a nonblocking material');
  await desktopContext.close();

  const availabilityContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await installRoutes(availabilityContext);
  const availabilityPage = await availabilityContext.newPage();
  advertisedCatalog = { ...catalog, fingerprint: 'C'.repeat(43), commands: [] };
  const emptyLoad = availabilityPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/contacts/PEER/commands');
  await availabilityPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await emptyLoad;
  assert.equal(await availabilityPage.getByRole('button', { name: 'Recipient commands' }).count(), 0,
    'a selected contact with an empty advertised catalog has no command control');
  await availabilityPage.getByRole('button', { name: 'Back to conversations' }).click();
  advertisedCatalog = catalog;
  const reopenedLoad = availabilityPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/contacts/PEER/commands');
  await availabilityPage.locator('.contact-row').filter({ hasText: 'Peer' }).click();
  await reopenedLoad;
  await availabilityPage.getByRole('button', { name: 'Recipient commands' }).waitFor();
  assert.equal(await availabilityPage.getByRole('form', { name: 'Send a typed command' }).count(), 0,
    'reopening discovers newly available commands without opening the panel');
  await availabilityPage.getByRole('button', { name: 'Recipient commands' }).click();
  advertisedCatalog = { ...catalog, fingerprint: 'D'.repeat(43), commands: [] };
  const refreshedEmpty = availabilityPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/contacts/PEER/commands');
  await availabilityPage.getByRole('button', { name: 'Refresh' }).click();
  await refreshedEmpty;
  assert.equal(await availabilityPage.getByRole('button', { name: 'Recipient commands' }).count(), 0,
    'refreshing an open panel hides its trigger when the canonical catalog becomes empty');
  const composerInput = availabilityPage.locator('.composer textarea');
  await availabilityPage.locator('.composer textarea:focus').waitFor({ timeout: 1_000 });
  assert.equal(await composerInput.evaluate((element) => document.activeElement === element), true,
    'removing the focused command surface restores focus to the stable composer input');
  await availabilityPage.getByRole('button', { name: 'Back to conversations' }).click();
  advertisedCatalog = catalog;
  const restoredLoad = availabilityPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/contacts/PEER/commands');
  await availabilityPage.locator('.contact-row').filter({ hasText: 'Peer' }).click();
  await restoredLoad;
  await availabilityPage.getByRole('button', { name: 'Recipient commands' }).waitFor();
  await availabilityPage.getByRole('button', { name: 'Back to conversations' }).click();
  advertisedCatalog = { ...catalog, fingerprint: 'E'.repeat(43), commands: [] };
  const removedLoad = availabilityPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/contacts/PEER/commands');
  await availabilityPage.locator('.contact-row').filter({ hasText: 'Peer' }).click();
  await removedLoad;
  assert.equal(await availabilityPage.getByRole('button', { name: 'Recipient commands' }).count(), 0,
    'reopening hides the command control after the canonical catalog becomes empty');
  await availabilityContext.close();

  let releaseCatalogRead;
  heldCatalogRead = new Promise((resolve) => { releaseCatalogRead = resolve; });
  advertisedCatalog = catalog;
  const silentContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await installRoutes(silentContext);
  const silentPage = await silentContext.newPage();
  const heldRequest = silentPage.waitForRequest((request) => new URL(request.url()).pathname === '/api/contacts/PEER/commands');
  await silentPage.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await heldRequest;
  await silentPage.locator('.composer').waitFor();
  await silentPage.waitForTimeout(50);
  assert.equal(await silentPage.locator('.composer-wrap > .command-status').count(), 0,
    'automatic command discovery stays silent while the open-time catalog request is pending');
  releaseCatalogRead();
  await silentPage.getByRole('button', { name: 'Recipient commands' }).waitFor();
  await silentContext.close();

  console.log(`browser-typed-commands OK — outgoing metadata contrast ${JSON.stringify(outgoingContrast)}, silent discovery, conditional open-time menu, repeated/switching sends, pattern validation, reset, chronology, desktop/mobile/accessibility`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
