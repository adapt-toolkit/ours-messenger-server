import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});let created=false;let running=false;let interrupted=0;let historyCalls=[];const mutations=[];let failInput=true;let sttFail=true;let sttCalls=0;let generation='voice-session';let holdConversation=false;let releaseConversation;let conversationWaiting;let holdStt=false;let releaseStt;let request;const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const role={role:{id:'fixture-chat',lifetime:'temporary',config:{name:'fixture-chat',harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'fixture-session'}},capabilities:{}};
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;const method=r.request().method();let data;
 if(method==='POST'&&!path.includes('/auth/'))mutations.push({path,body:r.request().postDataJSON()});
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={model:{manifest:{defaults:{permissions:{approval:'ask',filesystem:'workspace',unattended:'deny'}}},roles:{Assistant:{},Developer:{}},brains:{normal:{harness:'codex',model:'default'},fast:{harness:'codex',model:'fast-model'}},agent_templates:{},room_templates:{}},revision:'fixture'};
 else if(path.endsWith('/roles/preview')){request=r.request().postDataJSON();await new Promise(r=>setTimeout(r,250));data={request,previewHash:'reviewed',prerequisites:[]};}
 else if(path.endsWith('/roles')&&method==='POST'){created=true;data={actionId:'creation'};}
 else if(path.endsWith('/roles'))data={roles:created?[role]:[]};
 else if(path.endsWith('/creation-actions/creation'))data={state:'session_reachable',roleId:'fixture-chat'};
 else if(path.endsWith('/roles/fixture-chat/interrupt')){interrupted++;running=false;data={state:'accepted'};}
 else if(path.endsWith('/roles/fixture-chat/contacts')){historyCalls.push({operation:'contacts',method});data={contacts:[{name:'Fixture peer',container_id:'A'.repeat(64)}]};}
 else if(path.endsWith('/roles/fixture-chat/messages')){const q=Object.fromEntries(new URL(r.request().url()).searchParams);historyCalls.push({operation:'history',method,args:q});data={items:[{seq:q.before_seq?1:2,direction:q.before_seq?'in':'out',text:q.before_seq?'Earlier reply':'Agent sent this',date:'2026-09-28T08:00:00Z'}],next_cursor:q.before_seq?null:2};}
 else if(path.endsWith('/roles/fixture-chat/removal-preview'))data={lifetime:'temporary'};
 else if(path.endsWith('/roles/fixture-chat/remove')){created=false;data={removed:true};}
 else if(path.endsWith('/roles/fixture-chat/input')){if(failInput){failInput=false;await r.abort('failed');return;}data={promptId:'first-message',state:'queued'};}
 else if(path.endsWith('/roles/fixture-chat'))data=role;
 else if(path.endsWith('/conversation')){if(holdConversation)await conversationWaiting;data={events:[{kind:'message.replace',eventId:'reply',messageId:'reply',seq:1,at:new Date().toISOString(),payload:{role:'assistant',content:{type:'text',text:'First message received'}}}],snapshot:{sessionGeneration:generation,readiness:running?'running':'idle',pendingPermissionIds:[],queueDepth:running?1:0},nextCursor:'1',hasMore:false};}
 else if(path.endsWith('/tasks'))data={tasks:[]};else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};else throw new Error('Unexpected '+path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',r=>r.fulfill({json:{contacts:[],pending:[],files:[],messages:[]}}));

 await p.addInitScript(() => {
  window.micCalls=0;window.stoppedTracks=0;window.delayMic=true;
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>{window.micCalls++;const stream={getTracks:()=>[{stop:()=>window.stoppedTracks++}]};return window.delayMic?new Promise(r=>{window.resolveMic=()=>r(stream);}):Promise.resolve(stream);}});
  class Recorder extends EventTarget {
   static isTypeSupported(mime){return mime.startsWith('audio/webm');}
   state='inactive';start(){this.state='recording';}
   stop(){this.state='inactive';queueMicrotask(()=>{const event=new Event('dataavailable');event.data=new Blob([new Uint8Array([26,69,223,163,1])],{type:'audio/webm'});this.dispatchEvent(event);this.dispatchEvent(new Event('stop'));});}
  }
  window.MediaRecorder=Recorder;
  window.Audio=class extends EventTarget{duration=2;set src(_){queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}removeAttribute(){}load(){}};
 });
 await p.route('**/daemon/voice/transcribe',async r=>{sttCalls++;assert.equal(r.request().headers()['x-csrf-token'],'fixture');assert.match(r.request().headers()['content-type'],/^audio\/webm/);assert.equal(r.request().headers()['x-voice-duration'],'2');if(sttFail){await r.fulfill({status:503,json:{error:{message:'STT is unavailable'}}});return;}if(holdStt)await new Promise(resolve=>{releaseStt=resolve;});await r.fulfill({json:{text:'/restart'}}).catch(()=>{});});
 await p.goto(base+'/fleet');await p.getByRole('button',{name:'Add or connect',exact:true}).click();await p.getByRole('button',{name:'New chat',exact:true}).click();await p.getByLabel('New chat settings').waitFor();
 await p.getByRole('button',{name:'Live voice mode',exact:true}).click();await p.getByRole('dialog',{name:'Live voice',exact:true}).waitFor();assert.equal(await p.evaluate(()=>window.micCalls),0);if(process.env.FLEET_VOICE_SCREENSHOT)await p.screenshot({path:process.env.FLEET_VOICE_SCREENSHOT+'-live.png'});await p.keyboard.press('Escape');await p.getByRole('dialog').waitFor({state:'hidden'});
 await p.getByRole('button',{name:'Record voice message',exact:true}).click();await p.getByText('Waiting for microphone…',{exact:true}).waitFor();await p.getByRole('button',{name:'Cancel voice message',exact:true}).click();await p.evaluate(()=>window.resolveMic());await p.waitForTimeout(50);assert.equal(await p.evaluate(()=>window.stoppedTracks),1);
 await p.evaluate(()=>{window.delayMic=false;});
 await p.getByLabel('Agent name',{exact:true}).fill('fixture-chat');await p.getByLabel('Brain',{exact:true}).selectOption('fast');
 await p.getByRole('button',{name:'Record voice message',exact:true}).click();await p.getByRole('button',{name:'Stop recording',exact:true}).click();await p.getByRole('button',{name:'Send voice message',exact:true}).waitFor();assert.equal(await p.getByLabel('Recording preview').count(),1);if(process.env.FLEET_VOICE_SCREENSHOT)await p.screenshot({path:process.env.FLEET_VOICE_SCREENSHOT+'-recording.png'});
 await p.getByRole('button',{name:'Send voice message',exact:true}).click();await p.getByText('STT is unavailable',{exact:true}).waitFor();assert.equal(mutations.length,0);assert.equal(await p.getByLabel('Recording preview').count(),1);
 sttFail=false;await p.getByRole('button',{name:'Send voice message',exact:true}).click();await p.getByRole('button',{name:'Retry voice message',exact:true}).waitFor();assert.equal(mutations.filter(x=>x.path.endsWith('/roles')).length,1);
 const first=mutations.find(x=>x.path.endsWith('/input')).body;assert.equal(first.text,'Voice message:\n/restart');assert.equal(first.expectedSessionGeneration,'voice-session');assert.equal(request.brain.ref,'fast');
 await p.getByRole('button',{name:'Retry voice message',exact:true}).click();await p.getByText('First message received',{exact:true}).waitFor();
 assert.equal(mutations.filter(x=>x.path.endsWith('/roles')).length,1);assert.deepEqual(mutations.filter(x=>x.path.endsWith('/input')).map(x=>x.body),[first,first]);assert.equal(sttCalls,2);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 assert.equal(await p.evaluate(()=>window.stoppedTracks),2);

 await p.getByRole('button',{name:'Record voice message',exact:true}).click();await p.getByRole('button',{name:'Stop recording',exact:true}).click();await p.getByRole('button',{name:'Send voice message',exact:true}).waitFor();
 generation='new-session';await p.waitForTimeout(2300);await p.getByRole('button',{name:'Send voice message',exact:true}).click();await p.getByText('Agent session changed. Cancel and record a new message.',{exact:true}).waitFor();assert.equal(sttCalls,2);await p.getByRole('button',{name:'Cancel voice message',exact:true}).click();
 holdStt=true;await p.getByRole('button',{name:'Record voice message',exact:true}).click();await p.getByRole('button',{name:'Stop recording',exact:true}).click();await p.getByRole('button',{name:'Send voice message',exact:true}).click();await p.getByText('Recognizing speech…',{exact:true}).waitFor();
 await p.getByRole('button',{name:'Back to chats',exact:true}).click();await p.waitForTimeout(100);releaseStt();await p.waitForTimeout(100);assert.equal(mutations.filter(x=>x.path.endsWith('/input')).length,2);
 holdConversation=true;conversationWaiting=new Promise(resolve=>{releaseConversation=resolve;});
 await p.goto(base+'/fleet/chats?chat=fixture-chat&detail=1');
 const record=p.getByRole('button',{name:'Record voice message',exact:true});await record.waitFor();
 await p.waitForTimeout(150);assert.equal(await record.isDisabled(),true);assert.equal(await p.evaluate(()=>window.micCalls),0);
 holdConversation=false;releaseConversation();await p.waitForFunction(()=>!document.querySelector('button[aria-label="Record voice message"]')?.disabled);
 assert.equal(await p.evaluate(()=>window.micCalls),0);
 console.log('Existing chat: delayed initial conversation snapshot prevents recording until session generation is known PASS');
 console.log('Existing ACP: changed session rejects before transcription; switching away cancels pending STT without prompt admission PASS');
 console.log('ACP voice: live stub without microphone, late permission cancellation, recording preview, STT failure retained, draft creation and exact input retry PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));}
