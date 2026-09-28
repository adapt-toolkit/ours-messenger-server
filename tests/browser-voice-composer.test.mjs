import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the file-bubble layout gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n');
    return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLEET_CHROMIUM_EXECUTABLE });


try {
 const page=await browser.newPage({viewport:{width:360,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let sent=[];let stt=0;
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;let json={};
 if(path==='/api/events')return r.fallback();
 if(path==='/api/identity')json={name:'Me',cid:'ME-CID'};
 if(path==='/api/contacts')json={contacts:[{name:'Peer',container_id:'PEER'}],pending:[]};
 if(path==='/api/conversations/PEER/page')json={contact:'PEER',messages:[],total:0,unread:0,hasMore:false,nextBefore:null};
 if(path==='/api/conversations/PEER/files')json={contact:'PEER',files:[]};
 if(path==='/api/messages/send-file'){sent.push(r.request().postDataBuffer());json={wire_id:'sent-voice'};}
 await r.fulfill({json});});
 await page.route('**/voice/transcribe',r=>{stt++;return r.fulfill({json:{text:'Unexpected'}});});
 await page.addInitScript(()=>{
 window.stoppedTracks=0;window.delayMic=false;window.failRecorder=false;
 Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>{const stream={getTracks:()=>[{stop:()=>window.stoppedTracks++}]};return window.delayMic?new Promise(resolve=>{window.resolveMic=()=>resolve(stream);}):Promise.resolve(stream);}});
 window.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){if(window.failRecorder)throw new Error('fixture constructor error');}state='inactive';start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob([new Uint8Array([26,69,223,163,1])],{type:'audio/webm'})});this.onstop?.();});}};
 window.Audio=class extends EventTarget{duration=2;set src(_){queueMicrotask(()=>this.dispatchEvent(new Event('loadedmetadata')));}removeAttribute(){}load(){}};
 });
 await page.goto(origin+'/chats/PEER');const mic=page.getByRole('button',{name:'Record voice message',exact:true});await mic.waitFor();
 const press=async()=>{const box=await mic.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();return box;};
 let box=await press();await page.locator('.voice-rec-overlay[data-mode="recording"]').waitFor();await page.mouse.move(box.x+box.width/2,box.y-100);await page.locator('.voice-rec-overlay[data-mode="locked"]').waitFor();await page.mouse.up();await page.getByRole('button',{name:'Stop',exact:true}).click();await page.getByLabel('Recording preview').waitFor();assert.equal(sent.length,0);assert.equal(stt,0);
 await page.locator('.attach-preview').getByRole('button',{name:'Send',exact:true}).click();await page.getByLabel('Recording preview').waitFor({state:'hidden'});assert.equal(sent.length,1);assert.match(sent[0].toString(),/x-ours-kind=voice-message/);assert.match(sent[0].toString(),/x-ours-duration=2/);assert.equal(stt,0);
 await page.evaluate(()=>{window.failRecorder=true;});await press();await page.mouse.up();await page.getByText('Unable to start voice recording.',{exact:true}).waitFor();assert.ok(await page.evaluate(()=>window.stoppedTracks>=2));await page.evaluate(()=>{window.failRecorder=false;});
 // Releasing during the permission prompt must stop the late stream.
 await page.evaluate(()=>{window.delayMic=true;});await press();await page.locator('.voice-rec-overlay[data-mode="arming"]').waitFor();await page.mouse.up();const before=await page.evaluate(()=>window.stoppedTracks);await page.evaluate(()=>window.resolveMic());await page.waitForFunction(n=>window.stoppedTracks>n,before);assert.equal(sent.length,1);
 // Leaving the actual contact unmounts the shared recorder before permission resolves.
 await press();await page.locator('.voice-rec-overlay[data-mode="arming"]').waitFor();await page.mouse.up();await page.evaluate(()=>{history.pushState({},'', '/settings');window.dispatchEvent(new PopStateEvent('popstate'));});await mic.waitFor({state:'hidden'});const left=await page.evaluate(()=>window.stoppedTracks);await page.evaluate(()=>window.resolveMic());await page.waitForFunction(n=>window.stoppedTracks>n,left);assert.equal(sent.length,1);assert.equal(stt,0);assert.deepEqual(errors,[]);
 console.log('External contact shared recorder: hold/lock/preview, audio Send + duration metadata, no STT, constructor failure, late permission/release/unmount cleanup PASS');
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
