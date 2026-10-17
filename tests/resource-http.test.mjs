import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApi } from '../src/api.ts';
import { MessengerEventBus } from '../src/events.ts';
import { writeHumanProfile } from '../src/workspace-profile.ts';
const stateDir = mkdtempSync(join(tmpdir(), 'resource-http-'));
const identityCid = 'a'.repeat(64);
let position = 0, wake, stopped = false, resolveStopped, race = false;
const sourceStopped = new Promise(resolve => { resolveStopped = resolve; });
const client = {
 async *resourceEvents(identity, { signal }) {
  assert.equal(identity, 'bound');
  try {
   yield { protocolVersion: 1, producerGeneration: 'source', position, kind: 'ready' };
   while (!signal.aborted) {
    let release;
    const frame = await new Promise(resolve => { wake = resolve; release = () => resolve(null); signal.addEventListener('abort', release, { once: true }); });
    signal.removeEventListener('abort', release);
    if (!frame) return;
    yield frame;
   }
  } finally { stopped = true; resolveStopped(); }
 },
 async resourcePosition() { return { protocolVersion: 1, producerGeneration: 'source', position }; },
 async currentIdentity() {
  if (race) { race = false; position++; wake({protocolVersion:1,producerGeneration:'source',position,kind:'committed'}); }
  return { cid: identityCid, name: `Name${position}`, bio: 'Bio' };
 },
};
const deps = { runtime: { client }, config: { stateDir, publicOrigin: 'http://localhost', identity: 'bound' }, identityCid, events: new MessengerEventBus() };
let controlEntered, controlClosed, heldControlBinding;
const server = createServer((req,res) => {
 // Hold this response at the actual HTTP writer after the route handler has
 // returned, so abort races completed installation rather than source opening.
 if(req.headers['x-hold-control']){
  res.end=function(body){heldControlBinding=JSON.parse(String(body));controlEntered();return res;};
  res.once('close',()=>controlClosed());
 }
 void serveApi(req,res,deps);
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const abort = new AbortController();
const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Ours-Messenger-CSRF': '1' };
let reader;
try {
 const response = await fetch(base+'/api/events?resources=1', { signal: abort.signal });
 reader = response.body.getReader();
 let pending = '';
 async function frame() {
  while (!pending.includes('\n\n')) { const result = await reader.read(); assert.equal(result.done, false); pending += new TextDecoder().decode(result.value); }
  const end = pending.indexOf('\n\n'), record = pending.slice(0,end); pending = pending.slice(end+2);
  return { event: record.split('\n')[0].slice(7), data: JSON.parse(record.split('\n').find(line => line.startsWith('data: ')).slice(6)) };
 }
 const connection = await frame();
 assert.equal(connection.event, 'resource-connection', 'negotiated resource stream exposes ephemeral connection binding');
 const connectionId = connection.data.connectionId;
 const registration = { connectionId, viewId: 'self', subscriptionEpoch: 1, descriptor: { viewId: 'self', resource: 'identity' } };
 assert.equal((await fetch(base+'/api/resource-subscriptions',{ method:'POST', headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(registration)})).status,403);
 assert.equal((await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify({...registration,descriptor:{viewId:'self',resource:'arbitrary'}})})).status,400);
 deps.config.typedCommands=false;
 assert.equal((await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify({...registration,viewId:'commands',descriptor:{viewId:'commands',resource:'commands',entityId:'peer'}})})).status,404,'disabled catalog obeys the existing read allowlist');
 deps.config.typedCommands=true;
 const control = await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify(registration)});
 assert.equal(control.status,200); const registered = await control.json();
 const binding = { 'X-Resource-Connection':connectionId, 'X-Resource-View':'self', 'X-Resource-Epoch':'1', 'X-Resource-Baseline':registered.baselineId };
 const initial = await fetch(base+'/api/identity',{headers:binding});
 assert.equal(initial.status,200);
 assert.equal(initial.headers.get('x-resource-baseline'),registered.baselineId);
 assert.equal((await initial.json()).name,'Name0');
 assert.equal((await fetch(base+'/api/contacts',{headers:binding})).status,409,'binding cannot authorize another read shape');
 assert.equal((await fetch(base+'/api/identity',{headers:{...binding,'X-Resource-Epoch':'2'}})).status,409);
 const snapshot = await frame(), ready = await frame();
 assert.equal(snapshot.data.kind,'snapshot'); assert.equal(snapshot.data.payload.name,'Name0');
 assert.equal(ready.data.kind,'ready'); assert.equal(ready.data.baselineId,registered.baselineId);
 position++; wake({protocolVersion:1,producerGeneration:'source',position,kind:'committed'});
 let update = await frame();
 assert.equal(update.data.kind,'snapshot'); assert.equal(update.data.payload.name,'Name1');
 await frame(); // committed coverage
 writeHumanProfile(stateDir,identityCid,{name:'Local profile'});
 update = await frame(); assert.equal(update.data.payload.humanProfile.name,'Local profile');
 race=true;
 const replacementResponse=await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify({...registration,subscriptionEpoch:2})});
 const replacement=await replacementResponse.json();
 const replacementBinding={...binding,'X-Resource-Epoch':'2','X-Resource-Baseline':replacement.baselineId};
 const raced=await fetch(base+'/api/identity',{headers:replacementBinding});
 assert.equal(raced.status,200);assert.equal((await raced.json()).name,'Name2','commit during initial projection is fenced into the same baseline');
 assert.equal(raced.headers.get('x-resource-source-position'),'2');
 await fetch(base+'/api/resource-subscriptions',{method:'DELETE',headers,body:JSON.stringify({connectionId,viewId:'self',subscriptionEpoch:1})});
 assert.equal((await fetch(base+'/api/identity',{headers:replacementBinding})).status,200,'late old-epoch delete cannot remove replacement');
 const entered=new Promise(resolve=>{controlEntered=resolve;}),closed=new Promise(resolve=>{controlClosed=resolve;});
 const abandon=new AbortController();
 const abandoned={connectionId,viewId:'abandoned',subscriptionEpoch:1,descriptor:{viewId:'abandoned',resource:'identity'}};
 const pendingControl=fetch(base+'/api/resource-subscriptions',{method:'POST',headers:{...headers,'X-Hold-Control':'1'},signal:abandon.signal,body:JSON.stringify(abandoned)}).catch(()=>{});
 await entered;abandon.abort();await closed;await pendingControl;
 const abandonedBinding={...binding,'X-Resource-View':'abandoned','X-Resource-Baseline':heldControlBinding.baselineId};
 assert.equal((await fetch(base+'/api/identity',{headers:abandonedBinding})).status,409,'aborted unfinished control response retires its installed view');
 assert.equal((await fetch(base+'/api/identity',{headers:replacementBinding})).status,200,'independent retained view stays alive');
 assert.equal((await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify(abandoned)})).status,409,'aborted response epoch stays retired');
 assert.equal((await fetch(base+'/api/resource-subscriptions',{method:'POST',headers,body:JSON.stringify({...abandoned,subscriptionEpoch:2})})).status,200,'newer explicit replacement remains possible');
 await fetch(base+'/api/resource-subscriptions',{method:'DELETE',headers,body:JSON.stringify({connectionId,viewId:'abandoned',subscriptionEpoch:2})});
 console.log('resource-http: unfinished aborted registration response retires installed view while another binding remains live passed');
 const remove = await fetch(base+'/api/resource-subscriptions',{method:'DELETE',headers,body:JSON.stringify({connectionId,viewId:'self',subscriptionEpoch:2})});
 assert.equal(remove.status,200);
 assert.equal((await fetch(base+'/api/identity',{headers:binding})).status,409);
 console.log('resource-http: same-origin controls, registered initial GET, complete payloads and local profile commits passed');
} finally {
 abort.abort(); await reader?.cancel().catch(()=>{});
 await new Promise(resolve=>setImmediate(resolve));
 server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
 rmSync(stateDir,{recursive:true,force:true});
}
await Promise.race([sourceStopped, new Promise((_,reject) => { const timer = setTimeout(() => reject(Error('SDK source was not disposed')), 1000); timer.unref(); })]);
assert.equal(stopped,true,'stream abort releases SDK source');
