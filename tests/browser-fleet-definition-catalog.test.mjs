import {chromium, webkit, expect} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-definition-catalog-'));
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const configFile=path.join(directory,'definitions.json');
const catalog={model:{manifest:{},roles:{Developer:{},Critic:{}},brains:{development:{harness:'codex',model:'same-model',effort:'medium'},review:{harness:'codex',model:'same-model',effort:'medium'}},agent_templates:{},room_templates:{}},revision:'1'};
const engine=process.env.FLEET_BROWSER==='webkit'?webkit:chromium;
const browser=await engine.launch(engine===chromium?{executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE}:{});
try {
 fs.writeFileSync(configFile,JSON.stringify(catalog));
 const p=await browser.newPage({viewport:{width:360,height:800}});const errors=[],mutations=[];let unavailable=false;
 p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/fleet/api/v1/**',async r=>{
  const u=new URL(r.request().url()),method=r.request().method();let data;
  if(method!=='GET'&&!u.pathname.includes('/auth/'))mutations.push(u.pathname);
  if(u.pathname.includes('/auth/'))data={csrfToken:'fixture'};
  else if(u.pathname.endsWith('/configuration')){assert.equal(u.searchParams.get('includeDefinitions'),'true');if(unavailable)return r.fulfill({status:503,json:{error:{message:'Catalog unavailable'}}});data=JSON.parse(fs.readFileSync(configFile,'utf8'));}
  else if(u.pathname.endsWith('/roles'))data={roles:[]};
  else if(u.pathname.endsWith('/tasks'))data={tasks:[]};
  else if(u.pathname.endsWith('/task-lists'))data={lists:[]};
  else throw new Error('Unexpected '+u.pathname);
  await r.fulfill({json:data});
 });
 await p.route('**/messenger/api/**',r=>r.fulfill({json:{contacts:[],pending:[],files:[],messages:[]}}));
 await p.goto(base+'/fleet');await p.getByRole('button',{name:'Add or connect',exact:true}).click();await p.getByRole('button',{name:'New chat',exact:true}).click();
 const brain=p.getByLabel('Brain',{exact:true}),role=p.getByLabel('Role',{exact:true});
 await expect(brain.locator('option')).toHaveCount(2);
 assert.deepEqual(await role.locator('option').evaluateAll(xs=>xs.map(x=>x.value)),Object.keys(catalog.model.roles));
 const labels=await brain.locator('option').allTextContents();assert.equal(new Set(labels).size,2);assert.ok(labels[0].includes('development'));assert.ok(labels[1].includes('review'));
 await brain.selectOption('review');await role.selectOption('Critic');await p.getByLabel('Agent name',{exact:true}).fill('kept-draft');await p.getByLabel('Message agent',{exact:true}).fill('unsent draft');
 // The fixture endpoint rereads its disk catalog on each request, as Fleet does.
 catalog.model.brains['custom-medium']={harness:'codex',model:'custom-model',effort:'medium'};catalog.model.roles.Engineer={};catalog.revision='2';fs.writeFileSync(configFile,JSON.stringify(catalog));
 await expect(brain.locator('option')).toHaveCount(3,{timeout:12000});await expect(role.locator('option')).toHaveCount(3);
 await expect(brain).toHaveValue('review');await expect(role).toHaveValue('Critic');await expect(p.getByLabel('Agent name',{exact:true})).toHaveValue('kept-draft');await expect(p.getByLabel('Message agent',{exact:true})).toHaveValue('unsent draft');
 unavailable=true;await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(p.getByRole('alert')).toBeVisible();await expect(brain.locator('option')).toHaveCount(3);
 unavailable=false;delete catalog.model.brains['custom-medium'];catalog.revision='3';fs.writeFileSync(configFile,JSON.stringify(catalog));await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(brain.locator('option')).toHaveCount(2,{timeout:12000});
 assert.deepEqual(mutations,[]);assert.deepEqual(errors,[]);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 console.log(`${engine.name()}: complete definition catalog, distinct labels, disk refresh/add/remove, selection/draft preservation, failure/recovery, zero mutations PASS`);
}finally{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});}
