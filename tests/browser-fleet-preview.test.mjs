import assert from 'node:assert/strict';
import { createFleetPreviewServer } from '../scripts/fleet-preview-server.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
const server = createFleetPreviewServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = process.env.FLEET_PREVIEW_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const errors = []; const apiCalls = [];
const output = '/tmp/ours-fleet-evidence'; mkdirSync(output, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('request', req => { if(new URL(req.url()).pathname.startsWith('/api/')) apiCalls.push(req.url()); });
  const button = name => page.getByRole('button', { name, exact: true });
  const navigate = async name => { await button('Navigate').click(); await page.getByRole('dialog').getByRole('button', { name: new RegExp('^' + name + '\\b') }).click(); };
  const dialog = () => page.getByRole('dialog').last();
  const composer = () => page.locator('.fleet-chat-slot:not([hidden]) .composer textarea');
  const close = async () => { if(await button('‹ Contacts').count()) { await button('‹ Contacts').click(); return; } const count = await page.locator('[role=dialog]').count(); await page.keyboard.press('Escape'); await expect(page.locator('[role=dialog]')).toHaveCount(count - 1); };
  await page.goto(origin + '/fleet');
  await expect(button('Coordinator Persistent · Ready')).toBeVisible();
  await expect(page.locator('.fleet-context')).toHaveCount(0);
  // A new chat is only a draft until its first message, with one immutable session thereafter.
  await button('New chat').click(); await page.getByLabel('Agent name', { exact: true }).fill('Draft Researcher');
  await page.getByLabel('Role', { exact: true }).selectOption('Researcher'); await page.getByLabel('Brain', { exact: true }).selectOption('Claude Code');
  await expect(button('Agent actions')).toHaveCount(0);
  await composer().fill('Find useful research'); await button('More options').click(); await button('Folder · website').click();
  await dialog().getByRole('button', { name: 'research Read only', exact: true }).click(); await button('Cancel').click();
  await expect(button('Folder · website')).toBeVisible(); await button('Done').click();
  await button('Close conversation').click(); await expect(page.locator('.fleet-list').getByRole('button', { name: /Draft Researcher/ })).toHaveCount(0);
  await button('New chat').click(); await expect(composer()).toHaveValue('Find useful research'); await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Draft Researcher');
  await button('Send').evaluate(button => { button.click(); button.click(); }); await expect(button('Draft Researcher Temporary · Ready')).toHaveCount(1);
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveCount(0); await expect(button('More options')).toHaveCount(0);
  await page.locator('.fleet-chat-slot:not([hidden]) .fleet-locked-setup summary').click(); await expect(page.locator('.fleet-chat-slot:not([hidden]) .fleet-locked-setup')).toContainText('Claude Code');
  await composer().fill('Continue'); await button('Send').click(); await expect(button('Draft Researcher Temporary · Ready')).toHaveCount(1);
  await button('Agent actions').click(); await button('Generate invite').click(); await button('Generate an invite').click(); await expect(dialog().getByLabel('Invitation code')).toHaveValue(/ours:\/\/preview-invite\/agent-/); await close();
  await button('Persistent').click(); await button('Coordinator Persistent · Ready').click();
  await composer().fill('Coordinator draft');
  await button('Research assistant Persistent · Idle').click(); await composer().fill('Research draft');
  await button('Coordinator Persistent · Ready').click(); await expect(composer()).toHaveValue('Coordinator draft');
  await navigate('Messenger'); await composer().fill('Maya draft'); await navigate('Sessions'); await expect(composer()).toHaveValue('Coordinator draft');
  await button('Temporary').click(); await button('Launch website Task · 2 agents · Active').click();
  await expect(button('Room Shared chat · 2 unread 2')).toBeVisible();
  await button('Developer Direct agent chat · Working').click();
  const chatSpace = async () => {
    const head = await page.locator('.fleet-chat-slot:not([hidden]) .detail-head').boundingBox();
    const composerBox = await page.locator('.fleet-chat-slot:not([hidden]) .composer-wrap').boundingBox();
    return composerBox.y - head.y - head.height;
  };
  assert.ok(await chatSpace() >= 600, 'desktop timeline gains height with navigation beside it');
  await composer().fill('Developer draft'); await button('Agent actions').click(); await button('View task').click(); await button('‹ Back').click(); await expect(composer()).toHaveValue('Developer draft');
  await button('Settings').first().click(); await button('‹ Back').click(); await expect(composer()).toHaveValue('Developer draft');
  await composer().fill('Developer draft'); await button('Agent actions').click(); await button('Room').click(); await composer().fill('Room draft');
  await button('Developer Direct agent chat · Working').click(); await expect(composer()).toHaveValue('Developer draft');
  await expect(page.locator('.fleet-chat-slot:not([hidden]) .messages .fleet-tool')).toBeVisible();
  await button('Allow once').click(); await expect(page.getByText('Test command · Allowed once · Complete')).toBeVisible();
  await page.locator('.fleet-tool summary').click(); await button('Open full output').click(); await expect(dialog()).toContainText('3 files inspected'); await close();
  await button('Agent actions').click(); await button('Profile').click(); await expect(page.getByRole('heading', { name: 'Developer', exact: true })).toBeVisible();
  await button('Contacts & invitations').click(); await button('Generate invite').click(); await expect(dialog().getByLabel('Invitation code')).toHaveCount(0);
  await dialog().getByLabel('Invitation type').selectOption('Public'); await expect(dialog().getByLabel('Invitation code')).toHaveCount(0);
  await dialog().getByRole('button', { name: 'Generate an invite', exact: true }).click(); await expect(dialog().getByLabel('Invitation code')).toHaveValue(/ours:\/\/preview-invite\/developer/); await close();
  await button('Accept invite').click(); await expect(dialog()).toContainText('Developer'); await expect(button('Accept on behalf of an agent')).toHaveCount(0); await close();
  await page.screenshot({ path: join(output, 'agent-contacts-desktop-dark.png') }); await button('Close Profile').click();
  await navigate('Task manager'); await button('Launch website Website Developer + Critic').click();
  await button('Active ▾').click(); await button('Move to list').click(); await dialog().getByLabel('Move to list').selectOption('Product'); await dialog().getByRole('button', { name: 'Move task', exact: true }).click(); await expect(button('List Product')).toBeVisible();
  await button('Active ▾').click(); await button('Delete task').click(); await expect(dialog().getByRole('button', { name: 'Delete task', exact: true })).toBeDisabled(); await close();
  await button('Add or connect').click(); await button('Accept invite').click(); await dialog().getByLabel('Invitation code').fill('preview-code-to-preserve'); await button('Accept on behalf of an agent').click(); await button('Critic Vitalii · Work').click(); await expect(dialog().getByLabel('Invitation code')).toHaveValue('preview-code-to-preserve'); await close(); await expect(button('Add or connect')).toBeFocused();
  await button('My profile').click(); await button('Vitalii · Work Workspace identity').click(); await button('Developer Agent').click(); await button('‹ Back').click(); await expect(page.getByRole('heading', { name: 'Vitalii · Work', exact: true })).toBeVisible(); await button('‹ Back').click(); await expect(page.getByRole('heading', { name: 'Vitalii Shakhmatov', exact: true })).toBeVisible();
  // Closing a nested profile journey returns directly to its original screen.
  await button('Vitalii · Work Workspace identity').click(); await button('Developer Agent').click(); await expect(page.getByRole('dialog', { name: 'Profile', exact: true })).toBeVisible(); await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(button('My profile')).toBeFocused();
  await navigate('Task manager'); await page.screenshot({ path: join(output, 'tasks-desktop-dark.png') });
  await button('Add or connect').click(); await button('New persistent agent').click(); await dialog().getByLabel('Agent name').fill('Preview Tester');
  await button('Working folder Workstation /home/you/work/website').click(); await button('New folder in website').click(); await dialog().getByLabel('Folder name').fill('preview-assets'); await dialog().getByRole('button', { name: 'Create folder', exact: true }).click();
  await button('Select folder').click(); await expect(dialog().getByLabel('Agent name')).toHaveValue('Preview Tester'); await button('Create persistent agent').click(); await expect(page.locator('.fleet-chat-slot:not([hidden]) .conv-peer-name')).toHaveText('Preview Tester');
  await button('Add or connect').click(); await button('New task').click(); await dialog().getByLabel('Task name').fill('Preview room'); await button('Empty / custom Create an empty room; add temporary agents later').click(); await button('Create task session').click(); await expect(dialog()).toContainText('No agents yet'); await button('Add agent').click(); await button('Add Tester').click(); await expect(page.locator('.fleet-list h2')).toHaveText('Preview room');
  await button('Settings').first().click(); await button('Roles').click(); await page.getByLabel('Purpose', { exact: true }).fill('Verify the preview'); await button('Save role').click(); await expect(page.getByRole('status')).toContainText('Definition saved');
  await page.goto(origin + '/fleet/account/signup'); await page.getByRole('checkbox').check(); await button('Create account').click(); await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible(); await button('Preview confirmed email').click();
  const slides = ['The network is ours. The rest is yours.', 'Connect any two agents.', 'Your fleet. One room for each task.', 'Your room. Invite anyone.', 'Close the room. End its access.'];
  for (let i = 0; i < slides.length; i++) { await expect(page.getByRole('heading', { name: slides[i] })).toBeVisible(); if(i < 4) await button('Continue').click(); }
  await button('Back').click(); await expect(page.getByRole('heading', { name: slides[3] })).toBeVisible(); await button('Continue').click();
  await button('Start with your Coordinator').click(); await expect(page.locator('.fleet-chat-slot:not([hidden]) .conv-peer-name')).toHaveText('Coordinator');
  const greeting = page.locator('.fleet-chat-slot:not([hidden]) .messages'); await expect(greeting).toContainText('Hi Vitalii');
  for(const area of ['Sessions', 'Messenger', 'Task manager', 'Settings']) await expect(greeting).toContainText(area);
  await composer().fill('My first draft'); await button('Close conversation').click(); await expect(button('Coordinator Persistent · Ready')).toBeVisible();
  await button('Coordinator Persistent · Ready').click(); await expect(composer()).toHaveValue('My first draft');
  await expect(greeting.getByText(/Hi Vitalii/)).toHaveCount(1);
  await button('My profile').click(); await button('Account').click(); await button('Log in').click(); await button('Skip').click();
  await expect(greeting.getByText(/Hi Vitalii/)).toHaveCount(1); await expect(composer()).toHaveValue('My first draft');

  await page.goto(origin + '/fleet/work/room-0mu1gv4ndd96af6f4'); await expect(page.locator('.fleet-list h2')).toHaveText('Launch website'); await expect(page.locator('.fleet-chat-slot:not([hidden]) .conv-peer-name')).toHaveText('Room');
  await page.goto(origin + '/fleet/messenger/messenger-critic'); await expect(page.locator('.fleet-chat-slot:not([hidden]) .conv-peer-name')).toHaveText('Critic'); await button('Open contact details for Critic').click(); await expect(page.getByRole('heading', { name: 'Critic', exact: true })).toBeVisible(); await expect(button('Open agent chat')).toBeVisible();
  // A Messenger history ID must never replace the canonical invitation actor.
  await button('Contacts & invitations').click(); await button('Accept invite').click(); await expect(dialog().getByRole('button', { name: 'Accept as Critic', exact: true })).toBeVisible(); await expect(button('Accept on behalf of an agent')).toHaveCount(0); await close();
  await button('Generate invite').click(); await expect(dialog()).toContainText('Critic'); await dialog().getByRole('button', { name: 'Generate an invite', exact: true }).click(); await expect(dialog().getByLabel('Invitation code')).toHaveValue(/ours:\/\/preview-invite\/critic\//); await close();
  await page.goto(origin + '/fleet/profile/messenger-critic/contacts'); await button('Accept invite').click(); await expect(dialog().getByRole('button', { name: 'Accept as Critic', exact: true })).toBeVisible(); await close();
  await page.goto(origin + '/fleet/profile/developer/contacts'); await expect(page.getByRole('heading', { name: 'Agent contacts' })).toBeVisible();
  await page.goto(origin + '/fleet/tasks'); await button('Use light theme').click(); await page.screenshot({ path: join(output, 'tasks-desktop-light.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(origin + '/fleet/work/developer');
  // Wait for the routed conversation before interacting with its header.
  await expect(page.locator('.fleet-chat-slot:not([hidden]) .conv-peer-name')).toHaveText('Developer');
  await expect(composer()).toBeVisible();
  // The same Navigation surface is available inside a full-screen phone chat.
  await button('Navigate').click(); await expect(dialog()).toContainText('Your persistent agents, short chats'); await expect(dialog().locator('[aria-current=page]')).toContainText('Sessions');
  await dialog().getByRole('button', { name: /^Sessions/ }).click(); await button('New chat').click();
  await page.getByLabel('Agent name', { exact: true }).fill('Mobile Guide'); await composer().fill('Keep this mobile draft');
  await button('Navigate').click(); await close(); await expect(composer()).toHaveValue('Keep this mobile draft');
  await button('More options').click(); await button('Folder · website').click(); await button('shared').click(); await button('Cancel').click(); await expect(button('Folder · website')).toBeVisible(); await button('Done').click();
  await page.screenshot({ path: join(output, 'new-chat-mobile.png') });
  await button('Send').click(); await expect(page.locator('.fleet-chat-slot:not([hidden]) .fleet-locked-setup')).toBeVisible();
  await button('Agent actions').click(); await page.waitForTimeout(350); await page.screenshot({ path: join(output, 'agent-menu-mobile.png') }); await button('Accept invite').click(); await expect(button('Accept as Mobile Guide')).toBeVisible(); await close();
  await page.goto(origin + '/fleet/work/developer');
  await expect(composer()).toBeVisible(); const box = await composer().boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 391 && box.y + box.height <= 844, 'mobile composer stays in viewport');
  assert.ok(await chatSpace() >= 700, 'mobile chat fills screen with a single header');
  await composer().fill('Mobile draft'); await button('Back to conversations').click(); await expect(button('Developer Direct agent chat · Working')).toBeVisible(); await button('Developer Direct agent chat · Working').click(); await expect(composer()).toHaveValue('Mobile draft');
  // Every dismissal path closes the whole mobile profile journey and preserves its source.
  for (const dismissal of ['outside', 'Escape', 'Close']) {
    const trigger = button('Open contact details for Developer');
    await trigger.click();
    await button('Vitalii · Work Workspace identity').click();
    await button('Vitalii Shakhmatov Human identity').click();
    await button('Vitalii · Personal Workspace identity').click();
    if (dismissal === 'outside') await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
    else if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await button('Close Profile').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer()).toHaveValue('Mobile draft'); await expect(trigger).toBeFocused();
    await trigger.click(); await button('Contacts & invitations').click(); await button('Accept invite').click();
    await expect(button('Accept as Developer')).toBeVisible();
    if (dismissal === 'outside') await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } });
    else if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await button('Close Profile').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer()).toHaveValue('Mobile draft'); await expect(trigger).toBeFocused();
  }
  const activity = page.locator('.fleet-chat-slot:not([hidden]) .messages .fleet-tool');
  await activity.locator('summary').click(); await expect(activity.locator('details')).toHaveAttribute('open', '');
  await button('Open full output').click(); await close(); await expect(composer()).toHaveValue('Mobile draft');
  const expandedBox = await composer().boundingBox(); assert.ok(expandedBox.y + expandedBox.height <= 844, 'expanded activity does not move the mobile composer out of view');
  await button('Back to conversations').click(); await button('Use dark theme').click(); await button('Developer Direct agent chat · Working').click(); await expect(page.locator('.fleet-nav')).toBeHidden(); await page.screenshot({ path: join(output, 'agent-mobile-dark.png') });
  await button('Back to conversations').click(); await navigate('Messenger'); await expect(page.locator('.fleet-messenger-list')).toBeVisible(); await page.getByRole('button', { name: /Maya/ }).first().click(); await expect(composer()).toBeVisible(); await composer().fill('Hello Maya'); await button('Send').click(); await expect(page.locator('.fleet-chat-slot:not([hidden]) .messages')).toContainText('Hello Maya');
  await page.screenshot({ path: join(output, 'messenger-mobile-dark.png') });
  // Each full entry URL visit starts a fresh mock, even in the same browser.
  await page.goto(origin + '/fleet/account/signup'); await page.getByLabel('Your name', { exact: true }).fill('Alex');
  await page.getByRole('checkbox').check(); await button('Create account').click(); await button('Preview confirmed email').click();
  for(let i = 0; i < 5; i++) {
    await expect(page.getByRole('heading', { name: slides[i] })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no mobile horizontal overflow');
    await page.screenshot({ path: join(output, `onboarding-mobile-${i + 1}.png`) });
    if(i < 4) await button('Continue').click();
  }
  await button('Start with your Coordinator').click(); await expect(greeting).toContainText('Hi Alex!');
  await composer().fill('A private test message'); await button('Send').click(); await composer().fill('Keep this draft');
  await button('Back to conversations').click(); await expect(button('Coordinator Persistent · Ready')).toBeVisible();
  await button('Coordinator Persistent · Ready').click(); await expect(greeting).toContainText('A private test message'); await expect(composer()).toHaveValue('Keep this draft');
  const secondTab = await page.context().newPage();
  await secondTab.goto(origin + '/fleet/account/signup'); await secondTab.getByRole('checkbox').check();
  await secondTab.getByRole('button', { name: 'Create account', exact: true }).click(); await secondTab.getByRole('button', { name: 'Preview confirmed email', exact: true }).click(); await secondTab.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(secondTab.locator('.fleet-chat-slot:not([hidden]) .messages')).toContainText('Hi Vitalii!');
  await expect(secondTab.locator('.fleet-chat-slot:not([hidden]) .messages')).not.toContainText('A private test message');
  await expect(composer()).toHaveValue('Keep this draft'); await secondTab.close();
  await page.goto(origin + '/fleet/account/signup'); await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Vitalii');
  await page.getByRole('checkbox').check(); await button('Create account').click(); await button('Preview confirmed email').click(); await button('Skip').click();
  await expect(greeting).toContainText('Hi Vitalii!'); await expect(greeting).not.toContainText('A private test message'); await expect(composer()).toHaveValue('');
  if(!process.env.FLEET_PREVIEW_ORIGIN || process.env.FLEET_VERIFY_ISOLATION) {
    for(const route of ['/api/health', '/api/contacts', '/chats', '/sw.js', '/assets/../package.json']) assert.equal((await page.request.get(origin + route)).status(), 404, `isolated preview rejects ${route}`);
    assert.equal((await page.request.post(origin + '/fleet/account/signup', { data: {} })).status(), 404);
  }
  assert.deepEqual(errors, [], 'no browser runtime errors'); assert.deepEqual(apiCalls, [], 'mock flows never call live APIs');
  console.log('browser-fleet-preview OK — drafts, navigation, profiles, invite actors, explicit generation, local mutations, mobile layouts, deep links, account/settings and API isolation');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
