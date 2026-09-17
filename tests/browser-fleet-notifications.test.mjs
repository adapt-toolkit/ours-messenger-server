import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { createFleetPreviewServer } from '../scripts/fleet-preview-server.mjs';
const server = createFleetPreviewServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = process.env.FLEET_PREVIEW_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
try {
for (const engine of [chromium, webkit]) {
 const browser = await engine.launch();
 try { for (const width of [320, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(origin + '/fleet');
  const badge = node => page.locator(`[data-notification-node="${node}"]:visible`).first();
  await expect(badge('root')).toHaveText('5');
  await expect(page.locator('.fleet-nav [data-notification-node="root"]')).toHaveCount(1);
  await page.getByRole('button', {name:'Navigate', exact:true}).click();
  await expect(badge('messenger')).toHaveText('2');
  await expect(page.getByRole('button', {name:'Close Navigation',exact:true}).locator('[data-notification-node]')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', {name:/^Messenger/}).click();
  // Selecting a section alone never marks its conversations read.
  await expect(badge('root')).toHaveText('5');
  await page.locator('.fleet-messenger-list:visible .contact-row').filter({hasText:'Maya'}).click();
  await expect(page.getByText('Yes. Send an agent invite.', {exact:false})).toBeVisible();
  if(width < 600) {
   await expect(page.getByRole('button', {name:'Back to conversations'}).locator('[data-notification-node="root"]')).toHaveText('4');
   await page.getByRole('button', {name:'Back to conversations'}).click();
  }
  await expect(badge('root')).toHaveText('4');
  await page.getByRole('button', {name:'Navigate',exact:true}).click();
  await expect(badge('messenger')).toHaveText('1');
  await page.getByRole('dialog').getByRole('button', {name:/^Sessions/}).click();
  await page.locator('.fleet-list .contact-row').filter({hasText:'Research assistant'}).click();
  await expect(page.getByRole('button',{name:'Approve request',exact:true})).toBeVisible();
  // Seeing a request does not clear an actionable decision.
  await page.getByRole('button',{name:'Approve request',exact:true}).click();
  await expect(page.getByText('Request resolved in this preview.', {exact:false})).toBeVisible();
  if(width < 600) await page.getByRole('button',{name:'Back to conversations'}).click();
  await expect(badge('root')).toHaveText('3');
  await page.getByRole('tab', {name:/^Temporary/}).click();
  await page.locator('.fleet-list .contact-row').filter({hasText:'Launch website'}).click();
  await page.locator('.fleet-list .contact-row').filter({hasText:'Developer'}).click();
  await page.getByRole('button',{name:'Decline request',exact:true}).click();
  if(width < 600) await page.getByRole('button',{name:'Back to conversations'}).click();
  await expect(badge('root')).toHaveText('2');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path:`/tmp/ours-fleet-evidence/notifications-${engine.name()}-${width}.png`});
  await page.getByRole('button',{name:'Navigate',exact:true}).click();
  await page.getByRole('button',{name:'Notifications',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Alex’s reviewer finished the review');
  await expect(page.getByRole('button',{name:'Close Notifications',exact:true}).locator('[data-notification-node]')).toHaveCount(0);
  await page.screenshot({path:`/tmp/ours-fleet-evidence/notification-panel-${engine.name()}-${width}.png`});
  await page.getByRole('dialog').getByRole('button',{name:/Alex’s reviewer finished/}).click();
  await expect(page.locator('.fleet-chat-slot:not([hidden])')).toContainText('Review complete.');
  if(width < 600) await page.getByRole('button',{name:'Back to conversations'}).click();
  await expect(badge('root')).toHaveText('1');
  await page.getByRole('button',{name:'Navigate',exact:true}).click();
  await page.getByRole('button',{name:'Notifications',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:/Approve the outline/}).click();
  await page.getByRole('button',{name:'Approve request',exact:true}).click();
  if(width < 600) await page.getByRole('button',{name:'Back to conversations'}).click();
  await expect(page.locator('[data-notification-node="root"]:visible')).toHaveCount(0);
  await page.getByRole('button',{name:'Navigate',exact:true}).click();
  await page.getByRole('button',{name:'Notifications',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('You’re all caught up.');
  await page.close();
  console.log(`${engine.name()} ${width} notification routes PASS`);
 }} finally { await browser.close(); }
}
} finally { server.close(); }
