import { chromium, webkit, expect } from '@playwright/test';
import { createFleetPreviewServer } from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=process.env.FLEET_PREVIEW_ORIGIN??`http://127.0.0.1:${server.address().port}`;
try {for(const engine of [chromium,webkit]) {const browser=await engine.launch();try {for(const width of [390,1280]) {
 const page=await browser.newPage({viewport:{width,height:844}});
 await page.goto(origin+'/fleet/settings');
 const button=name=>page.getByRole('button',{name,exact:true});
 const section=async name=>{await button('Navigate').click();await page.getByRole('dialog').getByRole('button',{name:'Settings',exact:true}).click();await button(name).click();};
 const open=async name=>page.locator('.fleet-config-list .contact-row').filter({has:page.locator('.contact-name',{hasText:name})}).click();
 await button('Roles').click();await button('New role').click();
 await page.getByLabel('Definition name',{exact:true}).fill('CustomReviewer');await page.getByLabel('Mission',{exact:true}).fill('Review accessibility');await button('Save role').click();
 await open('CustomReviewer');await expect(page.getByLabel('Mission',{exact:true})).toHaveValue('Review accessibility');await page.getByLabel('Mission',{exact:true}).fill('Cancelled edit');await button('Cancel').click();await open('CustomReviewer');await expect(page.getByLabel('Mission',{exact:true})).toHaveValue('Review accessibility');
 await section('Brains');await button('New brain').click();await page.getByLabel('Definition name',{exact:true}).fill('CustomBrain');await page.getByLabel('Harness',{exact:true}).selectOption('claude-code');await page.getByLabel('Model',{exact:true}).selectOption('claude-sonnet-5');await page.getByLabel('Reasoning effort',{exact:true}).selectOption('high');await button('Save brain').click();
 await open('CustomBrain');await expect(page.getByLabel('Model',{exact:true})).toHaveValue('claude-sonnet-5');await page.getByLabel('Harness',{exact:true}).selectOption('codex');await expect(page.getByLabel('Model',{exact:true})).toHaveValue('');await expect(page.getByLabel('Reasoning effort',{exact:true})).toHaveValue('');await page.getByLabel('Model',{exact:true}).selectOption('__custom');await page.getByLabel('Custom model ID').fill('custom-local-model');await button('Save brain').click();
 await section('Agent Templates');await button('New agent template').click();await page.getByLabel('Definition name',{exact:true}).fill('CustomAgent');await button('Save agent template').click();await expect(page.getByRole('alert')).toHaveText('Choose an existing role.');await page.getByLabel('Role',{exact:true}).selectOption('CustomReviewer');await page.getByLabel('Brain',{exact:true}).selectOption('CustomBrain');await button('Save agent template').click();await open('CustomAgent');await expect(page.getByLabel('Role',{exact:true})).toHaveValue('CustomReviewer');await expect(page.getByLabel('Brain',{exact:true})).toHaveValue('CustomBrain');
 await section('Task / room templates');await button('New room template').click();await page.getByLabel('Definition name',{exact:true}).fill('CustomRoom');await button('Add member').click();await page.getByLabel('Slot 1',{exact:true}).fill('reviewer');await page.getByLabel('Room role 1',{exact:true}).fill('Reviewer');await page.getByLabel('Agent template 1',{exact:true}).selectOption('CustomAgent');await button('Save room template').click();await open('CustomRoom');await expect(page.getByLabel('Agent template 1',{exact:true})).toHaveValue('CustomAgent');
 await expect(page.locator('body')).not.toContainText('undefined');
 await page.screenshot({path:`/tmp/ours-fleet-evidence/config-${engine.name()}-${width}.png`});
 await page.close();console.log(`${engine.name()} ${width} configuration CRUD/cancel/references PASS`);
 }}finally{await browser.close();}}}finally{server.close();}
