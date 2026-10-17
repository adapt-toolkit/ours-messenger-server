// Opt-in real source qualification using the matching published daemon runtime.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OursClient } from '@ours.network/sdk';
import { serveApi } from '../src/api.ts';
import { MessengerEventBus } from '../src/events.ts';
import { freePort } from './harness.mjs';
const runtimeDir = process.env.OURS_RESOURCE_TEST_DAEMON_RUNTIME;
assert.ok(runtimeDir, 'set OURS_RESOURCE_TEST_DAEMON_RUNTIME to reviewed built daemon dist/runtime');
const root = realpathSync(mkdtempSync(join(tmpdir(),'messenger-resource-daemon-')));
const retainState = process.env.KEEP_RESOURCE_TEST_STATE === '1';
if (retainState) console.log(`Retaining resource test state: ${root}`);
const port = await freePort();
Object.assign(process.env,{ OURS_STATE_DIR:root, OURS_CONFIG:join(root,'missing-config'), OURS_BROKER_URL:'wss://invalid.local/none', OURS_PORT:String(port), OURS_API_VISIBILITY:'owner' });
const runtimeModule = relative => import(pathToFileURL(join(runtimeDir, relative)).href);
const { startDaemon } = await runtimeModule('internal/daemon.js');
const daemon = await startDaemon({handleSignals:false});
const { API_TOKEN } = await runtimeModule('runtime/env.js');
const opts = { url:`http://127.0.0.1:${port}`, leaseToken:'messenger-human', apiToken:API_TOKEN };
const human = new OursClient(opts), second = new OursClient(opts), peer = new OursClient({...opts,leaseToken:'messenger-peer'});
let http, reader, closed=false;
const abort = new AbortController();
let initialGETs=0, dataEventFollowupGETs=0, healthyPeriodicGETs=0, commandRequests=0;
try {
 const identity = await human.createRootIdentity({skipIfRootExists:true,name:'Human',bio:'initial',exposeLocal:false,localAutoAccept:true});
 await peer.createIdentity({name:'Peer',bio:'',exposeLocal:false,localAutoAccept:true});
 const invite=await human.generateInvite({name:'Peer'});
 await peer.addContact({invite:invite.blob});
 // Initial contact setup uses SDK source events; no browser content polling.
 const sourceAbort=new AbortController();
 const source=human.resourceEvents('Human',{signal:sourceAbort.signal});
 await source.next();
 let contact;
 for(let tries=0;tries<50;tries++) {
  contact=(await human.listContacts()).contacts.find(row=>row.name==='Peer');
  if(contact)break;
  await source.next();
 }
 sourceAbort.abort(); assert.ok(contact,'local contact handshake completes');
 let canonicalReads=0,positionReads=0;
 for(const name of ['currentIdentity','listContacts','listHistory','getHistorySummary','getHistoryItem','listFiles','listContactCommands']) {
  const original=human[name].bind(human);human[name]=async(...args)=>{canonicalReads++;return original(...args);};
 }
 const originalPosition=human.resourcePosition.bind(human);
 human.resourcePosition=async(...args)=>{positionReads++;return originalPosition(...args);};
 const deps={runtime:{client:human},config:{stateDir:root,identity:'Human',publicOrigin:'http://localhost'},identityCid:identity.info.cid,events:new MessengerEventBus()};
 const requests=[];
 http=createServer((req,res)=>{requests.push(`${req.method} ${req.url}`);void serveApi(req,res,deps);});
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${http.address().port}`;
 const response=await fetch(base+'/api/events?resources=1',{signal:abort.signal}); reader=response.body.getReader();
 let pending='';
 const frames=[];
 async function nextFrame() {
  for(;;) {
   while(!pending.includes('\n\n')) {const result=await reader.read();assert.equal(result.done,false,'resource stream remains open');pending+=new TextDecoder().decode(result.value);}
   const end=pending.indexOf('\n\n'),raw=pending.slice(0,end);pending=pending.slice(end+2);
   if(!raw.startsWith('event: '))continue;
   const frame={event:raw.split('\n')[0].slice(7),data:JSON.parse(raw.split('\n').find(line=>line.startsWith('data: ')).slice(6))};frames.push(frame);return frame;
  }
 }
 async function untilFrame(label,predicate) {
  const timeout=AbortSignal.timeout(30000);
  for(;;) {const frame=await Promise.race([nextFrame(),new Promise((_,reject)=>timeout.addEventListener('abort',()=>reject(Error('Timed out: '+label)),{once:true}))]);if(predicate(frame))return frame;}
 }
 const connection=(await nextFrame()).data;
 const headers={Origin:'http://localhost','Content-Type':'application/json','X-Ours-Messenger-CSRF':'1'};
 const views=[
  [{viewId:'identity',resource:'identity'},'/api/identity'],
  [{viewId:'contacts',resource:'contacts'},'/api/contacts'],
  [{viewId:'messages',resource:'messages',entityId:contact.container_id,window:{limit:50,retainedPages:1}},`/api/conversations/${contact.container_id}/page?limit=50`],
  [{viewId:'files',resource:'files',entityId:contact.container_id},`/api/conversations/${contact.container_id}/files`],
  [{viewId:'commands',resource:'commands',entityId:contact.container_id},`/api/contacts/${contact.container_id}/commands`],
 ];
 for(const [descriptor,path] of views) {
  const control=await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify({connectionId:connection.connectionId,viewId:descriptor.viewId,subscriptionEpoch:1,descriptor})});
  assert.equal(control.status,200);const registered=await control.json();
  const initial=await fetch(base+path,{headers:{'X-Resource-Connection':connection.connectionId,'X-Resource-View':descriptor.viewId,'X-Resource-Epoch':'1','X-Resource-Baseline':registered.baselineId}});
  assert.equal(initial.status,200);await initial.json();initialGETs++;
 }
 const readyIds=new Set();
 while(readyIds.size<views.length) {const frame=await nextFrame();if(frame.data.kind==='ready')readyIds.add(frame.data.viewId);}
 const committedAt=Date.now();
 await second.setBio({bio:'second RPC writer committed'});commandRequests++;
 const identityFrame=await untilFrame('second client bio',frame=>frame.data.viewId==='identity'&&frame.data.payload?.bio==='second RPC writer committed');
 assert.equal(identityFrame.data.kind,'snapshot');
 const commitToFrameMs=Date.now()-committedAt;
 await peer.sendMessage({contact:'Human',text:'remote committed full message'});commandRequests++;
 const inbound=await untilFrame('incoming message',frame=>frame.data.viewId==='messages'&&frame.data.payload?.upserts?.some(row=>row.item.text==='remote committed full message'));
 const wireId=inbound.data.payload.upserts.find(row=>row.item.text==='remote committed full message').id;
 assert.ok(wireId);assert.equal(inbound.data.payload.window.unread,1);
 assert.equal((await human.listIncomingMessages()).length,1,'neutral view never consumes unread history');
 await second.getMessages({wire_ids:[wireId]});commandRequests++;
 await untilFrame('selective read update',frame=>frame.data.viewId==='messages'&&frame.data.payload?.upserts?.some(row=>row.id===wireId&&row.item.read===true));
 await second.sendMessage({contact:contact.container_id,text:'outgoing second writer'});commandRequests++;
 await untilFrame('outgoing message',frame=>frame.data.viewId==='messages'&&frame.data.payload?.upserts?.some(row=>row.item.text==='outgoing second writer'));
 await peer.sendFile({contact:'Human',data_base64:Buffer.from('file bytes').toString('base64'),filename:'fixture.txt',mime:'text/plain'});commandRequests++;
 const file=await untilFrame('incoming file metadata',frame=>frame.data.viewId==='files'&&frame.data.payload?.files?.some(row=>row.filename==='fixture.txt'));
 assert.equal(file.data.payload.files[0].size,10);assert.equal(file.data.payload.files[0].blob_path,undefined);
 await peer.registerCommands([{name:'probe',description:'Resource fixture',input_schema:{type:'object'},handler:()=>null}]);commandRequests++;
 await untilFrame('remote catalog',frame=>frame.data.viewId==='commands'&&JSON.stringify(frame.data.payload).includes('probe'));
 await second.renameContact({contact:contact.container_id,name:'Renamed Peer'});commandRequests++;
 await untilFrame('renamed contact',frame=>frame.data.viewId==='contacts'&&frame.data.payload?.contacts?.some(row=>row.name==='Renamed Peer'));
 await second.removeContact({contact:contact.container_id});commandRequests++;
 await untilFrame('removed contact',frame=>frame.data.viewId==='contacts'&&Array.isArray(frame.data.payload?.contacts)&&!frame.data.payload.contacts.some(row=>row.container_id===contact.container_id));
 // The contact snapshot can arrive while another view still has a queued
 // projection for the same mutation. Measure idle only after every view has
 // delivered coverage through the removal's capture, without a settling sleep.
 const removalCoverage=await untilFrame('removed contact coverage',frame=>frame.data.viewId==='contacts'&&frame.data.kind==='coverage');
 const barrier=removalCoverage.data.payload.source;
 // A removed peer no longer has a command catalog. Its explicit failure is
 // not healthy coverage; retire that selection before measuring active views.
 const catalogFailed=frame=>frame.data.viewId==='commands'&&frame.data.kind==='resync'&&frame.data.payload?.reason==='projection_unavailable';
 if(!frames.some(catalogFailed))await untilFrame('removed peer catalog unavailable',catalogFailed);
 const retired=await fetch(base+'/api/resource-subscriptions',{method:'DELETE',headers,body:JSON.stringify({connectionId:connection.connectionId,viewId:'commands',subscriptionEpoch:1})});
 assert.equal(retired.status,200);
 // Do not reuse an earlier capture at the same position: the observer may
 // already have queued another view pass while that capture was publishing.
 const coverageRoundStart=frames.length;
 const allCovered=()=>views.filter(([descriptor])=>descriptor.viewId!=='commands').every(([descriptor])=>frames.slice(coverageRoundStart).some(frame=>frame.data.viewId===descriptor.viewId
  && frame.data.kind==='coverage' && frame.data.payload.source.producerGeneration===barrier.producerGeneration
  && frame.data.payload.source.position>=barrier.position));
 if(!allCovered())await untilFrame('all views cover removal',allCovered);
 const contentBefore=requests.filter(request=>request.startsWith('GET /api/')&&!request.includes('/api/events')).length;
 dataEventFollowupGETs=contentBefore-initialGETs;
 const idleCanonicalBefore=canonicalReads,idlePositionBefore=positionReads;
 const coverageStart=Date.now();
 await untilFrame('healthy source coverage',frame=>frame.data.kind==='coverage'&&Date.now()-coverageStart>=2100);
 assert.equal(requests.filter(request=>request.startsWith('GET /api/')&&!request.includes('/api/events')).length,contentBefore);
 healthyPeriodicGETs=requests.filter(request=>request.startsWith('GET /api/')&&!request.includes('/api/events')).length-contentBefore;
 assert.equal(contentBefore,initialGETs,'healthy updates required only registered initial GETs');
 assert.equal(canonicalReads,idleCanonicalBefore,'idle coverage never reruns canonical projections');
 assert.equal(positionReads,idlePositionBefore,'idle coverage never issues source position GETs');
 await daemon.close();closed=true;
 const health=await untilFrame('upstream loss',frame=>frame.data.kind==='health'&&frame.data.payload?.healthy===false);
 assert.equal(health.data.payload.reason,'upstream_unavailable');
 console.log(JSON.stringify({result:'resource-daemon PASS',initialGETs,dataEventFollowupGETs,healthyPeriodicGETs,commandRequests,commitToFrameMs,idleCanonicalReads:canonicalReads-idleCanonicalBefore,idlePositionReads:positionReads-idlePositionBefore,source:'reviewed SDK built daemon; unchanged published MUFL packet qualified in1A'}));
} finally {
 abort.abort();await reader?.cancel().catch(()=>{});
 if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
 if(!closed)await daemon.close();
 if(!retainState)rmSync(root,{recursive:true,force:true});
}
process.exit(0);
