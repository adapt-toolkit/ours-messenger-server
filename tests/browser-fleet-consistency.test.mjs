import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createFleetPreviewServer } from '../scripts/fleet-preview-server.mjs';
const server = createFleetPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = process.env.FLEET_PREVIEW_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const properties = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'backgroundImage', 'borderColor', 'borderWidth', 'borderRadius', 'boxShadow'];
try {
  for (const width of [320, 390, 1280]) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(origin + '/fleet');
    const button = name => page.getByRole('button', { name, exact: true });
    await expect(button('Coordinator Persistent · Ready')).toBeVisible();
    if(theme === 'light') await button('Use light theme').click();
    await page.waitForTimeout(400);
    const style = selector => page.locator(selector).first().evaluate((el, props) => Object.fromEntries(props.map(p => [p, getComputedStyle(el)[p]])), properties);
    const sessionStyles = await Promise.all(['.contact-row:not(.active)', '.contact-row:not(.active) .contact-avatar', '.conversation-list-modes', '.search'].map(s => style('.fleet-list ' + s)));
    await expect(page.locator('.fleet-list h1')).toHaveCount(0);
    await expect(page.locator('.fleet-list').getByRole('button', { name: /New chat|＋/ })).toHaveCount(0);
    await page.getByLabel('Search sessions').fill('Research');
    await expect(button('Coordinator Persistent · Ready')).toHaveCount(0);
    await button('Change section: Sessions').click(); await page.getByRole('dialog').getByRole('button', { name: /^Messenger/ }).click();
    await expect(button('Change section: Messenger')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('div.fleet-messenger-list .listcol-titlebar')).toBeHidden();
    await expect(page.locator('div.fleet-messenger-list .list-bottom-invite')).toBeHidden();
    const messengerStyles = await Promise.all(['.contact-row:not(.active)', '.contact-row:not(.active) .contact-avatar', '.conversation-list-modes', '.search'].map(s => style('div.fleet-messenger-list ' + s)));
    assert.deepEqual(sessionStyles, messengerStyles, `${width}/${theme}: shared list styles`);
    await page.screenshot({ path: `/tmp/ours-fleet-evidence/consistent-messenger-${width}-${theme}.png` });
    await button('Navigate').click(); await page.getByRole('dialog').getByRole('button', { name: /^Sessions/ }).click();
    await expect(page.getByLabel('Search sessions')).toHaveValue('Research');
    await page.getByLabel('Search sessions').fill('');
    await page.screenshot({ path: `/tmp/ours-fleet-evidence/consistent-sessions-${width}-${theme}.png` });
    await button('Add or connect').click();
    const checkReference = async (selector, className) => {
      await page.locator(selector).first().evaluate(el => el.blur());
      await page.mouse.move(0, 0); await page.waitForTimeout(250);
      await page.locator(selector).first().evaluate((el, args) => {
        const reference = document.createElement(el.tagName); reference.className = args.className; reference.textContent = 'Reference'; document.body.append(reference);
        const copy = el.cloneNode(true); copy.removeAttribute('id'); copy.removeAttribute('autofocus'); copy.tabIndex = -1; el.parentElement.append(copy);
        const actual = getComputedStyle(copy), expected = getComputedStyle(reference);
        const differences = args.properties.filter(p => actual[p] !== expected[p]).map(p => `${p}: ${actual[p]} != ${expected[p]}`);
        copy.remove(); reference.remove(); if(differences.length) throw Error(differences.join('; '));
      }, { className, properties });
    };
    await checkReference('.fleet-menu-action', 'btn');
    await page.screenshot({ path: `/tmp/ours-fleet-evidence/consistent-menu-${width}-${theme}.png` });
    await button('New persistent agent').click();
    await checkReference('.fleet-field input', 'field');
    await checkReference('.fleet-dialog-actions .btn.primary', 'btn primary');
    await page.screenshot({ path: `/tmp/ours-fleet-evidence/consistent-form-${width}-${theme}.png` });
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Temporary', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Temporary', exact: true })).toHaveAttribute('aria-selected', 'true');
    await button('Launch website Task · 2 agents · Active').click();
    await button('Add or connect').click(); await button('Add to this task').click();
    await expect(page.getByRole('dialog')).toContainText('Launch website');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log(`${width}px ${theme}: list/header/search, shared control styles, task-context creation PASS`);
    await button('Navigate').click(); await page.getByRole('dialog').getByRole('button', { name: /^Task manager/ }).click();
    await expect(button('Change section: Task manager')).toBeVisible();
    await button('Change section: Task manager').focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toContainText('Task manager'); await page.keyboard.press('Escape');
    const addBox = await button('Add or connect').boundingBox(); assert.ok(addBox.x + addBox.width <= width);
    await page.screenshot({ path: `/tmp/ours-fleet-evidence/consistent-tasks-${width}-${theme}.png` });
    await page.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
