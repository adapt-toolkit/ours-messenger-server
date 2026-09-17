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
   const errors = []; const api = [];
   page.on('pageerror', e => errors.push(e.message));
   page.on('request', r => { if(new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()); });
   await page.goto(origin + '/fleet/profile/developer');
   const dialog = page.getByRole('dialog');
   await dialog.getByRole('button', {name:'Contacts & conversations',exact:true}).click();
   await dialog.getByPlaceholder('Search agent’s contacts').fill('missing');
   await expect(dialog).toContainText('No matching contacts.');
   await dialog.getByPlaceholder('Search agent’s contacts').fill('Coordinator');
   await dialog.getByRole('button',{name:/Coordinator.*Ready for review/}).click();
   await expect(dialog.getByRole('heading',{name:'Developer ↔ Coordinator'})).toBeVisible();
   await expect(dialog.locator('.fleet-correspondence-message')).toHaveCount(4);
   await expect(dialog.locator('textarea,[contenteditable="true"]')).toHaveCount(0);
   await expect(dialog).toContainText('Viewing agent history · Read only');
   await page.reload();
   await expect(dialog.getByRole('heading',{name:'Developer ↔ Coordinator'})).toBeVisible();
   await dialog.getByRole('button',{name:'Coordinator’s profile ›'}).click();
   await expect(dialog.getByRole('heading',{name:'Coordinator',exact:true})).toBeVisible();
   await dialog.getByRole('button',{name:'‹ Back',exact:true}).click();
   await expect(dialog.getByRole('heading',{name:'Developer ↔ Coordinator'})).toBeVisible();
   for (const dark of [false, true]) {
    await page.evaluate(dark => document.documentElement.classList.toggle('theme-dark',dark),dark);
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {})));
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({path:`/tmp/ours-fleet-evidence/correspondence-${engine.name()}-${width}-${dark?'dark':'light'}.png`});
   }
   await dialog.getByRole('button',{name:'‹ Developer’s contacts'}).click();
   await dialog.getByRole('button',{name:/Launch website.*No messages yet/}).click();
   await expect(dialog).toContainText('No messages yet');
   await dialog.getByRole('button',{name:'Room details ›'}).click();
   await expect(dialog).toContainText('Room members');
   await dialog.getByRole('button',{name:'‹ Contacts',exact:true}).click();
   await expect(dialog).toContainText('Developer ↔ Launch website');
   await page.goto(origin + '/fleet/profile/critic/contacts/coordinator');
   await expect(dialog.getByRole('heading',{name:'Critic ↔ Coordinator'})).toBeVisible();
   await page.goto(origin + '/fleet/profile/alex-reviewer/contacts');
   await expect(dialog).toContainText('Agent unavailable');
   assert.deepEqual(errors,[]); assert.deepEqual(api,[]);
   await page.close(); console.log(`${engine.name()} ${width} correspondence PASS`);
  }} finally { await browser.close(); }
 }
} finally { server.close(); }
