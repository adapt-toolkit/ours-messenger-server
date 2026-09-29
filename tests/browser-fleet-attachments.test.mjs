import {chromium,webkit,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const engine=process.env.FLEET_BROWSER==='webkit'?webkit:chromium;const browser=await engine.launch(engine===chromium?{executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE}:{});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
try{
 const p=await browser.newPage({viewport:{width:360,height:800}}),writes=[],errors=[];let generation='g1',created=false,fail=true,stale=false;const inputs=[];
 const ui=p.locator('.fleet-acp:visible');
 p.on('pageerror',e=>errors.push(e.message));
 const role=id=>({role:{id,lifetime:'temporary',config:{name:id,harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'session'}},capabilities:{}});
 await p.route('**/fleet/api/v1/**',async r=>{const u=new URL(r.request().url()),path=u.pathname,method=r.request().method();let data;
 if(method==='POST'&&!path.includes('/auth/'))writes.push({path,body:r.request().postDataJSON()});
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={model:{manifest:{},roles:{Assistant:{}},brains:{normal:{harness:'codex'}},agent_templates:{},room_templates:{}},revision:'1'};
 else if(path.endsWith('/roles/preview'))data={request:r.request().postDataJSON(),previewHash:'reviewed',prerequisites:[]};
 else if(path.endsWith('/roles')&&method==='POST'){created=true;data={actionId:'new'};}
 else if(path.endsWith('/roles'))data={roles:[role('Existing'),...(created?[role('New')]:[])]};
 else if(path.endsWith('/creation-actions/new'))data={state:'session_reachable',roleId:'New'};
 else if(path.endsWith('/attachments')){const body=r.request().postDataJSON();assert.equal(body.expectedSessionGeneration,generation);data={id:body.name==='photo.png'?'a'.repeat(64):'b'.repeat(64)};}
 else if(path.endsWith('/input')){inputs.push(r.request().postDataJSON());if(stale){stale=false;generation+='-next';return r.fulfill({status:409,json:{error:{code:'stale_state',message:'Session changed'}}});}if(fail){fail=false;return r.fulfill({status:503,json:{error:{message:'Temporary send failure'}}});}data={promptId:'sent',state:'starting'};}
 else if(path.endsWith('/conversation'))data={events:[],snapshot:{sessionGeneration:generation,readiness:'idle',pendingPermissionIds:[],queueDepth:0},nextCursor:'0',hasMore:false};
 else if(path.endsWith('/read'))data={};
 else if(/\/roles\/(Existing|New)$/.test(path))data=role(path.split('/').pop());
 else if(path.endsWith('/tasks'))data={tasks:[]};else if(path.endsWith('/task-lists'))data={lists:[]};else throw Error('Unexpected '+path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',r=>r.fulfill({json:{contacts:[],pending:[],files:[],messages:[]}}));
 await p.addInitScript(() => {
  window.micCalls=0;window.stoppedTracks=0;window.delayMic=false;
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>{window.micCalls++;const stream={getTracks:()=>[{stop:()=>window.stoppedTracks++}]};return window.delayMic?new Promise(r=>{window.resolveMic=()=>r(stream);}):Promise.resolve(stream);}});
  class Recorder extends EventTarget {
   static isTypeSupported(mime){return mime.startsWith('audio/webm');}
   state='inactive';start(){this.state='recording';}
   stop(){this.state='inactive';queueMicrotask(()=>{const event=new Event('dataavailable');event.data=new Blob([new Uint8Array([26,69,223,163,1])],{type:'audio/webm'});this.ondataavailable?.(event);this.onstop?.();});}
  }
  window.MediaRecorder=Recorder;
  window.Audio=class extends EventTarget{duration=2;set src(_){queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}removeAttribute(){}load(){}};
 });
 await p.route('**/daemon/voice/transcribe',r=>r.fulfill({json:{text:'Dictated attachment message'}}));
 await p.goto(base+'/fleet');await p.getByText('Existing',{exact:true}).first().click();await ui.getByLabel('Attach photos or files',{exact:true}).waitFor();
 const choose=files=>p.locator('.fleet-acp:visible input[type=file]').setInputFiles(files);
 await choose([{name:'photo.png',mimeType:'image/png',buffer:png}]);await expect(p.getByAltText('photo.png',{exact:true})).toBeVisible();assert.equal(writes.filter(x=>x.path.endsWith('/attachments')||x.path.endsWith('/input')).length,0);
 await ui.getByLabel('Remove photo.png',{exact:true}).click();await expect(ui.getByLabel('Attached files',{exact:true})).toHaveCount(0);
 await choose([{name:'photo.png',mimeType:'image/png',buffer:png},{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('file payload')}]);
 await p.getByRole('button',{name:'Send',exact:true}).click();await expect(p.getByRole('alert')).toContainText('Temporary send failure');await expect(ui.getByLabel('Remove photo.png',{exact:true})).toBeDisabled();
 await p.getByRole('button',{name:'Send',exact:true}).click();await expect(ui.getByLabel('Attached files',{exact:true})).toHaveCount(0);assert.deepEqual(inputs[0],inputs[1]);assert.equal(inputs[0].text,'');assert.deepEqual(inputs[0].attachments,['a'.repeat(64),'b'.repeat(64)]);assert.equal(writes.filter(x=>x.path.endsWith('/attachments')).length,2);
 assert.equal(Buffer.from(writes.find(x=>x.path.endsWith('/attachments')).body.data,'base64').equals(png),true);
 await p.getByRole('button',{name:'Back to chats',exact:true}).click();await p.getByRole('button',{name:'Add or connect',exact:true}).click();await p.getByRole('button',{name:'New chat',exact:true}).click();
 await choose([{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('first file')}]);assert.equal(created,false);fail=true;await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('button',{name:'Resume first message',exact:true}).waitFor();await p.getByRole('button',{name:'Resume first message',exact:true}).click();await expect.poll(()=>inputs.length).toBe(4);await ui.getByLabel('Attach photos or files',{exact:true}).filter({visible:true}).waitFor();assert.equal(writes.filter(x=>x.path==='/fleet/api/v1/roles').length,1);assert.deepEqual(inputs[2],inputs[3]);assert.equal(writes.filter(x=>x.path==='/fleet/api/v1/roles/New/attachments').length,1);
 for(const withVoice of [false,true]){
 await p.getByRole('button',{name:'Back to chats',exact:true}).click();await p.getByRole('button',{name:'Add or connect',exact:true}).click();await p.getByRole('button',{name:'New chat',exact:true}).click();await choose([{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('stale new file')}]);if(withVoice){const box=await ui.getByRole('button',{name:'Record voice message',exact:true}).boundingBox();await p.mouse.move(box.x+box.width/2,box.y+box.height/2);await p.mouse.down();await p.locator('.voice-rec-overlay[data-mode="recording"]').waitFor();await p.mouse.move(box.x+box.width/2,box.y-100);await p.locator('.voice-rec-overlay[data-mode="locked"]').waitFor();await p.mouse.up();await p.getByRole('button',{name:'Stop',exact:true}).click();await expect(ui.getByLabel('Message agent',{exact:true})).toHaveValue('Dictated attachment message');}stale=true;const beforeCreate=writes.filter(x=>x.path==='/fleet/api/v1/roles').length;await p.getByRole('button',{name:'Send',exact:true}).click();await expect(p.getByRole('alert')).toContainText('select them again');await expect(ui.getByLabel('Remove notes.txt',{exact:true})).toBeEnabled();const prematureInputs=inputs.length;await p.getByRole('button',{name:'Resume first message',exact:true}).click();await expect(p.getByRole('alert')).toContainText('select them again');await expect(ui.getByLabel('Remove notes.txt',{exact:true})).toBeEnabled();await expect(ui.getByLabel('Attach photos or files',{exact:true})).toBeEnabled();assert.equal(inputs.length,prematureInputs);await ui.getByLabel('Remove notes.txt',{exact:true}).click();await choose([{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('reselected new file')}]);const beforeRetry=inputs.length;await p.getByRole('button',{name:'Resume first message',exact:true}).click();await expect.poll(()=>inputs.length).toBe(beforeRetry+1);if(withVoice)assert.equal(inputs[beforeRetry].text,'Dictated attachment message');assert.notEqual(inputs[beforeRetry-1].commandId,inputs[beforeRetry].commandId);assert.notEqual(inputs[beforeRetry-1].expectedSessionGeneration,inputs[beforeRetry].expectedSessionGeneration);await ui.getByLabel('Attach photos or files',{exact:true}).waitFor();assert.equal(writes.filter(x=>x.path==='/fleet/api/v1/roles').length,beforeCreate+1);
 }
 await p.reload();await p.getByRole('button',{name:'Back to chats',exact:true}).click();await p.getByText('Existing',{exact:true}).first().click();await ui.getByLabel('Attach photos or files',{exact:true}).waitFor();await choose([{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('retained draft')}]);await ui.getByLabel('Message agent',{exact:true}).fill('Keep this text');stale=true;await p.getByRole('button',{name:'Send',exact:true}).click();await expect(p.getByRole('alert')).toContainText('Remove the attachments');await expect(ui.getByLabel('Remove notes.txt',{exact:true})).toBeEnabled();await expect(ui.getByLabel('Message agent',{exact:true})).toHaveValue('Keep this text');assert.equal(await p.evaluate(()=>sessionStorage.getItem('fleet-pending-input:Existing')),null);await ui.getByLabel('Remove notes.txt',{exact:true}).click();
 assert.deepEqual(errors,[]);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 console.log(engine.name()+': attachment photo/file preview/remove, exact bytes, no early upload/send, file-only input, stable retry, one New chat creation PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));}
