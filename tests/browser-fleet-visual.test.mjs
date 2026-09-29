import {chromium,webkit} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer(process.env.FLEET_VISUAL_ROOT);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await (process.env.FLEET_VISUAL_WEBKIT?webkit:chromium).launch({executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});const mutations=[];const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const role={role:{id:'fixture-chat',lifetime:'permanent',config:{name:'fixture-chat',harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'fixture-session'}},capabilities:{}};
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;const method=r.request().method();let data;
 if(method==='POST'&&!path.includes('/auth/'))mutations.push(path);
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={model:{manifest:{defaults:{permissions:{approval:'ask',filesystem:'workspace',unattended:'deny'}}},roles:{Assistant:{}},brains:{normal:{harness:'codex',model:'default'}},agent_templates:{},room_templates:{}},revision:'fixture'};
 else if(path.endsWith('/roles'))data={roles:[role]};
 else if(path.endsWith('/roles/fixture-chat'))data=role;
 else if(path.endsWith('/conversation'))data={events:[{kind:'message.replace',eventId:'reply',messageId:'reply',seq:1,at:new Date().toISOString(),payload:{role:'assistant',content:{type:'text',text:'First message received'}}}],snapshot:{sessionGeneration:'visual-session',readiness:'idle',pendingPermissionIds:[],queueDepth:0},nextCursor:'1',hasMore:false};
 else if(path.endsWith('/tasks'))data={tasks:[]};else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};else throw new Error('Unexpected '+path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',r=>r.fulfill({json:{contacts:[],pending:[],files:[],messages:[]}}));
 const samples=16000*2;const bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(1000*Math.sin(i*2*Math.PI*440/16000)),44+i*2);const wav=bytes.toString('base64');
 await p.addInitScript(wav=>{
  window.stoppedTracks=0;window.revoked=0;
  const revoke=URL.revokeObjectURL;URL.revokeObjectURL=u=>{window.revoked++;revoke(u);};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>window.stoppedTracks++}]})}});
  class Recorder {static isTypeSupported(m){return m==='audio/mp4';}state='inactive';start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob([Uint8Array.from(atob(wav),c=>c.charCodeAt(0))],{type:'audio/wav'})});this.onstop?.();});}}
  window.MediaRecorder=Recorder;
 },wav);
 await p.route('**/daemon/voice/transcribe',r=>r.fulfill({status:503,json:{error:{message:'Fixture transcription failure'}}}));
 await p.goto(base+'/fleet/chats?chat=fixture-chat&detail=1');
 await p.locator('.fleet-acp-thread').getByText('First message received',{exact:true}).waitFor();
 await p.waitForFunction(()=>!document.querySelector('button[aria-label="Record voice message"]').disabled);
 // Representative long conversation with harmless fixture content.
 await p.evaluate(()=>{const thread=document.querySelector('.fleet-acp-thread');for(let i=0;i<12;i++){const article=document.createElement('article');article.className='fleet-acp-message '+(i%2?'user':'agent');article.textContent=i%2?'Проверь запись перед отправкой.':'Запись можно прослушать, преобразовать в текст и отредактировать перед отправкой.';thread.append(article);}});
 const mic=p.getByRole('button',{name:'Record voice message',exact:true});const box=await mic.boundingBox();
 await p.mouse.move(box.x+22,box.y+22);await p.mouse.down();await p.locator('.voice-rec-overlay[data-mode="recording"]').waitFor({timeout:5000}).catch(async e=>{if(process.env.FLEET_VISUAL_SCREENSHOT)await p.screenshot({path:process.env.FLEET_VISUAL_SCREENSHOT+'-failure.png'});console.log(await p.locator('body').innerText());throw e;});await p.mouse.move(box.x+22,box.y-110);await p.locator('.voice-rec-overlay[data-mode="locked"]').waitFor();await p.mouse.up();await p.getByRole('button',{name:'Stop',exact:true}).click();await p.getByRole('button',{name:'Retry',exact:true}).waitFor();
 await p.getByLabel('Message agent',{exact:true}).fill('Можно исправить текст перед отправкой');
 await p.waitForTimeout(300);
 if(process.env.FLEET_VISUAL_SCREENSHOT)await p.screenshot({path:process.env.FLEET_VISUAL_SCREENSHOT+'-full.png'});
 if(!process.env.FLEET_VISUAL_BASELINE){
 const play=p.getByRole('button',{name:'Play recording',exact:true});await play.click();await p.getByRole('button',{name:'Pause recording',exact:true}).waitFor();await p.getByRole('button',{name:'Pause recording',exact:true}).click();await play.waitFor();
 const range=p.getByRole('slider',{name:'Recording position'});await range.focus();await range.press('ArrowRight');assert.ok(await range.inputValue()>0);
 await p.evaluate(()=>{const a=document.querySelector('.attach-preview-compact audio');a.currentTime=a.duration-.1;});await play.click();await play.waitFor();
 for(const height of [800,440]){
  await p.setViewportSize({width:360,height});await p.getByLabel('Message agent',{exact:true}).focus();await p.waitForTimeout(200);
  const geometry=await p.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {header:r('.fleet-acp-header'),scroll:r('.fleet-acp-scroll'),composer:r('.fleet-acp-composer'),preview:r('.attach-preview-compact'),overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.attach-preview-compact button')].map(b=>b.getBoundingClientRect().height)};});
  assert.ok(geometry.scroll.top>=geometry.header.bottom);assert.ok(geometry.scroll.bottom<=geometry.composer.top);assert.ok(geometry.composer.bottom<=height);assert.equal(geometry.overflow,false);assert.ok(geometry.buttons.every(h=>h>=44));
  await p.locator('.fleet-acp-scroll').evaluate(e=>e.scrollTop=0);
  assert.ok(await p.locator('.fleet-acp-message').first().evaluate(e=>e.getBoundingClientRect().top>=document.querySelector('.fleet-acp-scroll').getBoundingClientRect().top));
  await p.locator('.fleet-acp-scroll').evaluate(e=>e.scrollTop=e.scrollHeight);
  assert.ok(await p.locator('.fleet-acp-message').last().evaluate(e=>e.getBoundingClientRect().bottom<=document.querySelector('.fleet-acp-scroll').getBoundingClientRect().bottom));if(process.env.FLEET_VISUAL_SCREENSHOT)await p.screenshot({path:process.env.FLEET_VISUAL_SCREENSHOT+'-'+height+'.png'});
 }
 await p.evaluate(()=>{window.previewAudio=document.querySelector('.attach-preview-compact audio');window.previewAudio.dispatchEvent(new Event('error'));});await p.getByText('Preview unavailable. You can still transcribe this recording.',{exact:true}).waitFor();
 await p.getByRole('button',{name:'Discard',exact:true}).click();assert.equal(await p.getByLabel('Recording preview').count(),0);assert.ok(await p.evaluate(()=>window.revoked)>0);assert.equal(await p.evaluate(()=>window.previewAudio.paused),true);assert.equal(mutations.length,0);assert.deepEqual(errors,[]);
 }
 console.log('ACP visual fixture, bounds, playback/pause/end/keyboard seek, discard URL cleanup: PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));}
