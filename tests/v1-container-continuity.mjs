// Finite controller for actual Docker container continuity; no product control seam.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {attachOursClient} from '@ours.network/sdk';
import {startProcess, stopProcess, waitFor, waitForPort} from './v1-runtime.mjs';

const state='/fixture', oursState=state+'/ours', appState=state+'/messenger';
mkdirSync(oursState,{recursive:true,mode:0o700});
const daemonId=randomUUID(), endpoint='http://127.0.0.1:38351', base='http://127.0.0.1:8420';
const configPath=state+'/ours.json', credentialPath=oursState+'/daemon-token';
writeFileSync(configPath,JSON.stringify({brokerUrl:'ws://127.0.0.1:9000',port:38351,stateDir:oursState,apiVisibility:'owner',apiTokenDeliveryFiles:[]}),{mode:0o600});
const env={...process.env,HOME:state,OURS_CONFIG:configPath,OURS_DAEMON_ID:daemonId};
const selection={endpoint,expectedInstanceId:daemonId,credentialPath,sessionMode:'external',env:{}};
const attach=()=>attachOursClient({...selection,leaseToken:randomUUID()});
const defaults=name=>({name,bio:'Container continuity fixture',exposeLocal:false,localAutoAccept:true});
const bindings=()=>JSON.parse(readFileSync(oursState+'/bindings.json','utf8'));
const owner=()=>bindings().externalLeases.find(row=>row.identity==='MessengerContainer')?.token;
const cursor=()=>JSON.parse(readFileSync(appState+'/push.json','utf8')).identities[cid].notificationCursor;
const output=(stage,extra={})=>console.log(JSON.stringify({stage,...extra}));
let broker,daemon,root,creator,sibling,peer,cid,siblingCid,rootCid,peerCid,originalOwner,previousCursor;
async function api(path,body){
 const response=await fetch(base+path,{signal:AbortSignal.timeout(3000),method:body===undefined?'GET':'POST',
  headers:body===undefined?{}:{'content-type':'application/json',origin:base,'x-ours-messenger-csrf':'1'},
  body:body===undefined?undefined:JSON.stringify(body)});
 assert.equal(response.status,200,'Actual messenger HTTP request must succeed');
 return response.json();
}
async function healthy(){
 await waitFor(async()=>{const health=await api('/api/healthz');return health.status==='ok'&&health.identityCid===cid;},'actual built messenger health',45000);
}
async function preserved(){
 assert.equal((await api('/api/identity')).cid,cid,'Permanent messenger CID must survive');
 assert.equal((await sibling.currentIdentity()).cid,siblingCid,'Independent sibling must survive');
 assert((await root.listIdentities()).some(row=>row.name==='ContainerRoot'&&row.cid===rootCid));
}
async function exchange(text){
 await waitFor(()=>cursor()!==null,'notification tip committed');
 const before=cursor(), abort=new AbortController();
 const response=await fetch(base+'/api/events',{signal:abort.signal});
 assert.equal(response.status,200); assert(response.headers.get('content-type').includes('text/event-stream'));
 let frames='',failure;
 const work=(async()=>{try{for await(const chunk of response.body)frames+=new TextDecoder().decode(chunk);}catch(error){if(!abort.signal.aborted)failure=error;}})();
 try{
  await waitFor(()=>frames.includes('event: sync_required'),'SSE connected');
  await peer.sendMessage({contact:cid,text});
  await waitFor(async()=>(await api('/api/conversations/'+encodeURIComponent(peerCid))).messages.some(row=>row.text===text),'actual canonical message',45000);
  await waitFor(()=>{if(failure)throw failure;return frames.includes('event: message_received');},'real notification SSE',45000);
  await waitFor(()=>cursor()>before,'durable byte cursor advances',45000);
  assert(!frames.includes(text),'SSE must remain metadata-only');
  previousCursor=cursor();
 }finally{abort.abort();await work;}
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
const watchdog=setTimeout(()=>{console.error('FAIL controller watchdog');process.exit(124);},600000);
try{
 broker=startProcess(['/cowork/node_modules/.bin/adapt-broker','--host','127.0.0.1','--port','9000','--test_mode'],process.env,'/messenger');
 await waitForPort(9000);
 daemon=startProcess(['/messenger/node_modules/@ours.network/cli/dist/cli.js','daemon','serve'],env,'/messenger');
 await waitFor(async()=>{const response=await fetch(endpoint+'/selection',{signal:AbortSignal.timeout(1000)});return response.ok&&(await response.json()).instanceId===daemonId;},'real daemon',180000);
 root=await attach();await root.createRootIdentity({...defaults('ContainerRoot'),skipIfRootExists:false});rootCid=(await root.currentIdentity()).cid;
 creator=await attach();await creator.createIdentity(defaults('MessengerContainer'));cid=(await creator.currentIdentity()).cid;
 await creator.releaseLease();await creator.close();creator=undefined;
 sibling=await attach();await sibling.createTemporaryIdentity(defaults('ContainerSibling'));siblingCid=(await sibling.currentIdentity()).cid;
 peer=await attach();await peer.createIdentity(defaults('ContainerPeer'));peerCid=(await peer.currentIdentity()).cid;
 output('ready',{daemonId});
 for await(const step of lines){
  if(step==='initial'){
   await healthy();originalOwner=owner();assert(originalOwner);await preserved();
   const invite=await api('/api/invites',{mode:'public'});await peer.addContact({invite:invite.blob});
   await waitFor(async()=>(await peer.listContacts()).contacts.some(row=>row.name==='MessengerContainer'),'real peer contact',45000);
   await exchange('before container recreation');output('initial');
  }else if(step==='contended'){
   assert.equal(owner(),originalOwner,'Contender cannot replace original owner');await preserved();output('contended');
  }else if(step==='recreated'){
   await healthy();assert.equal(owner(),originalOwner,'Container recreation must continue original nonterminal owner');
   assert(!bindings().retired.includes(originalOwner),'Continued owner must not retire');
   assert(cursor()>=previousCursor,'Retained notification cursor must not regress');await preserved();
   await exchange('after container recreation');output('recreated');
  }else if(step==='stopped'){
   assert(bindings().retired.includes(originalOwner),'Normal stop must retire original owner');assert(!owner());
   assert.equal((await sibling.currentIdentity()).cid,siblingCid);
   assert((await root.listIdentities()).some(row=>row.name==='MessengerContainer'&&row.cid===cid));output('stopped');
  }else if(step==='successor'){
   await healthy();assert(owner());assert.notEqual(owner(),originalOwner,'Normal SessionEnd requires fresh successor');
   await preserved();output('successor');
  }else if(step==='finish')break;
  else throw new Error('Unexpected fixture step');
 }
}catch(error){console.error('FAIL '+error.message);process.exitCode=1;}
finally{
 for(const client of [peer,sibling,creator,root].filter(Boolean)){try{await client.releaseLease();await client.close();}catch{process.exitCode=1;}}
 try{await stopProcess(daemon);}catch{process.exitCode=1;}await stopProcess(broker,'SIGKILL');clearTimeout(watchdog);lines.close();
}
