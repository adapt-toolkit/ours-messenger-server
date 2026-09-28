import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});const calls=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
 const role={role:{id:'fixture-agent',lifetime:'temporary',config:{name:'Fixture agent',harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'fixture-session'}},capabilities:{}};
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;let data;
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={revision:'fixture',model:{roles:{},brains:{},agent_templates:{},room_templates:{}}};
 else if(path.endsWith('/roles'))data={roles:[role]};
 else if(path.endsWith('/roles/fixture-agent'))data=role;
 else if(path.endsWith('/conversation'))data={events:[],snapshot:{readiness:'idle',pendingPermissionIds:[],queueDepth:0},hasMore:false};
 else if(path.endsWith('/ours/call')){calls.push({path,body:r.request().postDataJSON()});data={result:{structuredContent:{blob:'fixture-agent-code'}}};}
 else if(path.endsWith('/tasks'))data={tasks:[]};else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};else throw Error(path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',async r=>{const path=new URL(r.request().url()).pathname;if(path.endsWith('/invites')&&r.request().method()==='POST'){calls.push({path,body:r.request().postDataJSON()});await r.fulfill({json:{blob:'fixture-human-code'}});}else await r.fulfill({json:{contacts:[],pending:[],messages:[],files:[]}});});
 for(const target of ['human','agent'])for(const mode of ['one_time','public']) {
  await p.goto(base+(target==='agent'?'/fleet/chats?chat=fixture-agent&detail=1':'/fleet'));
  await p.getByRole('button',{name:target==='agent'?'Agent actions':'Add or connect',exact:true}).click();
  await p.getByRole('button',{name:'Generate invite',exact:true}).click();
  await p.getByLabel('Invitation type',{exact:true}).selectOption(mode);
  await p.getByRole('button',{name:`Generate ${mode==='one_time'?'one-time':'reusable'} invite`,exact:true}).click();
  await p.getByLabel('Invitation code',{exact:true}).waitFor();
  const call=calls.at(-1);assert.deepEqual(call.body,target==='agent'?{tool:'generate_invite',arguments:{mode}}:{mode});
  assert.equal(call.path,target==='agent'?'/fleet/api/v1/roles/fixture-agent/ours/call':'/messenger/api/invites');
  assert.equal(await p.getByLabel('Invitation type',{exact:true}).isDisabled(),true);
  assert.equal(await p.getByRole('button',{name:`Generate ${mode==='one_time'?'one-time':'reusable'} invite`,exact:true}).isDisabled(),true);
 }
 assert.equal(calls.length,4);
 for(const size of [{width:360,height:800},{width:800,height:400},{width:1280,height:900}]) {
  await p.setViewportSize(size);await p.emulateMedia({reducedMotion:'reduce'});await p.goto(base+'/fleet');await p.getByRole('button',{name:'Add or connect',exact:true}).click();
  const dialog=p.getByRole('dialog');await dialog.waitFor();const box=await dialog.boundingBox();assert.ok(box.x>=15&&box.y>=19);assert.ok(box.x+box.width<=size.width-15&&box.y+box.height<=size.height-19);
  assert.equal(await dialog.evaluate(e=>getComputedStyle(e).animationName),'none');
  await p.keyboard.press('Tab');assert.equal(await dialog.evaluate(e=>e.contains(document.activeElement)),true);
  await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 assert.deepEqual(errors,[]);console.log('Human/agent invite modes and exact identity binding; floating mobile/desktop/short viewport, focus, Escape and reduced-motion PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));}
