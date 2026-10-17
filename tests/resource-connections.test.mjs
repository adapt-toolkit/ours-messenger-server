import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as connections from '../src/resource-connections.ts';
assert.equal(typeof connections.ResourceOutput, 'function', 'resource stream obeys bounded progressive output');
class Response extends EventEmitter {
  chunks = []; blocked = true; destroyed = false; writableEnded = false;
  write(chunk) { this.chunks.push(chunk); return !this.blocked; }
  end() { this.writableEnded = true; this.emit('close'); }
  drain() { this.blocked = false; this.emit('drain'); }
}
const response = new Response();
const controller = new AbortController();
let failure;
const output = new connections.ResourceOutput(response, controller.signal, error => { failure = error; });
const envelope = { protocolVersion: 1, producerGeneration: 'm', subscriptionEpoch: 1, viewId: 'v', sequence: 1, revision: 1, kind: 'snapshot', payload: 'x'.repeat(9 * 1024 * 1024) };
const completion = output.send(envelope);
await new Promise(resolve => setImmediate(resolve));
assert.equal(response.chunks.length, 1, 'large assembly emits only start while backpressured');
assert.ok(!failure, 'valid >8MiB assembly does not count as pending queue');
response.drain();
await completion;
assert.ok(response.chunks.length > 2);
assert.ok(response.chunks.every(frame => Buffer.byteLength(frame) <= 512 * 1024));
assert.ok(response.chunks.at(-1).includes('"type":"commit"'));
controller.abort();

const slow = new Response(), abort = new AbortController();
let overflow;
const bounded = new connections.ResourceOutput(slow, abort.signal, error => { overflow = error; });
const first = bounded.send({ ...envelope, payload: 'held' });
const pending = bounded.send({ ...envelope, sequence: 2, payload: 'x'.repeat(7 * 1024 * 1024) });
const excess = bounded.send({ ...envelope, sequence: 3, payload: 'x'.repeat(2 * 1024 * 1024) });
await Promise.allSettled([first, pending, excess]);
assert.match(overflow.message, /pending limit/);
assert.equal(slow.writableEnded, true, 'overflow retires stream rather than silently dropping changes');
assert.equal(slow.listenerCount('drain'), 0, 'retiring owner releases blocked output');
abort.abort();
console.log('resource-connections: progressive large output, pending overflow and disposal passed');

const watch = await import('../src/watch.ts');
assert.equal(typeof watch.startResourceObserver, 'function', 'SDK committed input has an owned health lifecycle');
const readers = [];
let finish;
const sourceClient = {
 async *resourceEvents(identity, { signal }) {
  assert.equal(identity, 'bound');
  try {
   yield { protocolVersion: 1, producerGeneration: 's', position: 0, kind: 'ready' };
   const next = await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(null), { once: true }); });
   if (next) throw next;
  } finally { readers.push('disposed'); }
 },
};
const wakes = [], failures = [];
const observation = watch.startResourceObserver(sourceClient, 'bound', { committed: frame => wakes.push(frame), failed: error => failures.push(error) });
await observation.ready;
assert.equal(observation.healthy, true);
finish(Error('upstream lost behind live browser bytes'));
await new Promise(resolve => setImmediate(resolve));
assert.equal(observation.healthy, false, 'upstream loss retires semantic health immediately');
assert.equal(failures.length, 1);
assert.equal(wakes.length, 1);
await observation.stop();
assert.deepEqual(readers, ['disposed']);
console.log('resource-connections: upstream loss and disposal passed');

assert.equal(typeof connections.ResourceConnections, 'function', 'registered views share one connection-owned source');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const profileDir = mkdtempSync(join(tmpdir(), 'resource-connections-'));
let sourcePosition = 0, wake, endSource;
const rpc = {
 async *resourceEvents(identity, { signal }) {
  yield { protocolVersion: 1, kind: 'ready', producerGeneration: 's', position: sourcePosition };
  while (!signal.aborted) {
   const next = await new Promise(resolve => { wake = resolve; endSource = () => resolve(null); signal.addEventListener('abort', endSource, { once: true }); });
   signal.removeEventListener('abort', endSource);
   if (!next) return;
   yield next;
  }
 },
 async resourcePosition() { return { protocolVersion: 1, producerGeneration: 's', position: sourcePosition }; },
};
const stream = new Response(); stream.blocked = false;
let projectionReads = 0;
const registry = new connections.ResourceConnections({ client: rpc, identity: 'bound', identityCid: 'a'.repeat(64), stateDir: profileDir,
 project: async descriptor => { projectionReads++; return { contacts: [{ name: `Committed${sourcePosition}` }], pending: [], roots: [] }; },
});
const session = registry.open(stream);
const registered = await registry.register(session.connectionId, 'directory', 1, { viewId: 'directory', resource: 'contacts' });
const bound = await registry.bound(session.connectionId, 'directory', 1, registered.baselineId);
assert.equal(bound.payload.contacts[0].name, 'Committed0');
assert.ok(stream.chunks.some(chunk => chunk.includes('"kind":"ready"')));
sourcePosition++;
wake({ protocolVersion: 1, kind: 'committed', producerGeneration: 's', position: sourcePosition });
await new Promise(resolve => setImmediate(resolve));
assert.ok(stream.chunks.some(chunk => chunk.includes('Committed1')));
const afterChangeReads = projectionReads;
wake({ protocolVersion: 1, kind: 'coverage', producerGeneration: 's', position: sourcePosition });
await new Promise(resolve => setImmediate(resolve));
assert.equal(projectionReads, afterChangeReads, 'coverage heartbeats never read canonical content');
const replacement = await registry.register(session.connectionId, 'directory', 2, { viewId: 'directory', resource: 'contacts' });
registry.remove(session.connectionId, 'directory', 1);
assert.equal((await registry.bound(session.connectionId, 'directory', 2, replacement.baselineId)).payload.contacts[0].name, 'Committed1', 'stale delete cannot remove replacement');
registry.remove(session.connectionId, 'directory', 3);
await assert.rejects(registry.bound(session.connectionId, 'directory', 2, replacement.baselineId), /binding/, 'newer retirement removes the older installed binding');
session.close();
await assert.rejects(registry.bound(session.connectionId, 'directory', 2, replacement.baselineId), /connection/);
rmSync(profileDir, { recursive: true, force: true });
console.log('resource-connections: registration, bound capture, full updates and stale epoch disposal passed');

// A delayed POST/DELETE cannot reuse an epoch after its view was removed.
const registry2 = new connections.ResourceConnections({ client: rpc, identity: 'bound', identityCid: 'a'.repeat(64), stateDir: profileDir,
 project: async () => ({ contacts: [], pending: [], roots: [] }),
});
const response2 = new Response(); response2.blocked = false;
const session2 = registry2.open(response2);
await registry2.register(session2.connectionId, 'directory', 1, { viewId: 'directory', resource: 'contacts' });
registry2.remove(session2.connectionId, 'directory', 1);
await assert.rejects(registry2.register(session2.connectionId, 'directory', 1, { viewId: 'directory', resource: 'contacts' }), /epoch/);
session2.close();

const realNow = Date.now;
let now = 1000;
Date.now = () => now;
const elapsedFailures=[];
const elapsedSource=watch.startResourceObserver(sourceClient,'bound',{committed:()=>{},failed:error=>elapsedFailures.push(error)});
await elapsedSource.ready;
now=7001;
assert.equal(elapsedSource.healthy,false,'elapsed source silence expires before a delayed timer or new activity');
assert.equal(elapsedFailures.length,1);
Date.now=realNow;
await elapsedSource.stop();

let concurrent=0,maxConcurrent=0,releaseProjection;
const projectionGate=new Promise(resolve=>{releaseProjection=resolve;});
const serial=new connections.ResourceConnections({client:rpc,identity:'bound',identityCid:'a'.repeat(64),stateDir:profileDir,
 project:async()=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);await projectionGate;concurrent--;return {contacts:[],pending:[],roots:[]};},
});
const serialResponse=new Response();serialResponse.blocked=false;
const serialSession=serial.open(serialResponse);
const a=await serial.register(serialSession.connectionId,'a',1,{viewId:'a',resource:'contacts'});
const b=await serial.register(serialSession.connectionId,'b',1,{viewId:'b',resource:'contacts'});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(maxConcurrent,1,'one connection assembles only one canonical projection at a time');
releaseProjection();
await Promise.all([serial.bound(serialSession.connectionId,'a',1,a.baselineId),serial.bound(serialSession.connectionId,'b',1,b.baselineId)]);
serialSession.close();

const unsupportedResponse=new Response();unsupportedResponse.blocked=false;
const unsupported=new connections.ResourceConnections({client:{async *resourceEvents(){const error=Error('not supported');error.status=404;throw error;}},identity:'bound',identityCid:'a'.repeat(64),stateDir:profileDir,project:async()=>({})});
unsupported.open(unsupportedResponse);
await new Promise(resolve=>setImmediate(resolve));
assert.ok(unsupportedResponse.chunks.some(chunk=>chunk.includes('resource-service-health')&&chunk.includes('unsupported')),'capability loss before view registration is explicit');
assert.equal(unsupportedResponse.writableEnded,true);

let captureEnteredResolve;
const captureEntered=new Promise(resolve=>{captureEnteredResolve=resolve;});
const failingRegistry=new connections.ResourceConnections({client:{...sourceClient,async resourcePosition(){return {protocolVersion:1,producerGeneration:'s',position:0};}},identity:'bound',identityCid:'a'.repeat(64),stateDir:profileDir,
 project:async()=>{captureEnteredResolve();return new Promise(()=>{});},
});
const failedResponse=new Response();
const failingSession=failingRegistry.open(failedResponse);
const incomplete=await failingRegistry.register(failingSession.connectionId,'incomplete',1,{viewId:'incomplete',resource:'identity'});
await captureEntered;
const incompleteGET=failingRegistry.bound(failingSession.connectionId,'incomplete',1,incomplete.baselineId);
finish(Error('source gone during blocked baseline'));
await Promise.race([assert.rejects(incompleteGET,/source gone/),new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream failure left bound GET waiting on downstream drain')),50))]);
failingSession.close();

let releaseOpening;
const openingGate=new Promise(resolve=>{releaseOpening=resolve;});
const openingRegistry=new connections.ResourceConnections({client:{
 async *resourceEvents(_identity,{signal}){await openingGate;yield {protocolVersion:1,kind:'ready',producerGeneration:'s',position:0};await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},
 async resourcePosition(){return {protocolVersion:1,producerGeneration:'s',position:0};},
},identity:'bound',identityCid:'a'.repeat(64),stateDir:profileDir,project:async()=>({})});
const openingResponse=new Response();openingResponse.blocked=false;
const openingSession=openingRegistry.open(openingResponse),abandonedControl=new AbortController();
const pendingControl=openingRegistry.register(openingSession.connectionId,'late',1,{viewId:'late',resource:'identity'},abandonedControl.signal);
abandonedControl.abort();
await Promise.race([assert.rejects(pendingControl,/abort/i),new Promise((_,reject)=>setTimeout(()=>reject(Error('aborted control awaited late SDK source')),50))]);
releaseOpening();await new Promise(resolve=>setImmediate(resolve));
await assert.rejects(openingRegistry.bound(openingSession.connectionId,'late',1,'none'),/binding/);
openingSession.close();

// Stable captures must still yield the connection queue when a busy view keeps
// receiving committed wakes while each of its snapshots waits for drain.
class BusyViewResponse extends Response {
 write(chunk) {
  this.chunks.push(chunk);
  return !(chunk.startsWith('event: resource\n') && JSON.parse(chunk.split('\ndata: ')[1]).kind === 'snapshot'
   && JSON.parse(chunk.split('\ndata: ')[1]).viewId === 'a');
 }
}
const fairResponse=new BusyViewResponse(),projectionOrder=[];
const fairRegistry=new connections.ResourceConnections({client:rpc,identity:'bound',identityCid:'a'.repeat(64),stateDir:profileDir,
 project:async descriptor=>{projectionOrder.push(descriptor.viewId);return {contacts:[{name:`Committed${sourcePosition}`}],pending:[],roots:[]};},
});
const fairSession=fairRegistry.open(fairResponse);
try {
 await fairRegistry.register(fairSession.connectionId,'a',1,{viewId:'a',resource:'contacts'});
 await new Promise(resolve=>setImmediate(resolve));
 const fairB=await fairRegistry.register(fairSession.connectionId,'b',1,{viewId:'b',resource:'contacts'});
 for(let cycle=0;cycle<4;cycle++) {
  sourcePosition++;
  wake({protocolVersion:1,kind:'committed',producerGeneration:'s',position:sourcePosition});
  await new Promise(resolve=>setImmediate(resolve));
  fairResponse.emit('drain');
  await new Promise(resolve=>setImmediate(resolve));
 }
 const frames=fairResponse.chunks.filter(chunk=>chunk.startsWith('event: resource\n')).map(chunk=>JSON.parse(chunk.split('\ndata: ')[1]));
 assert.ok(frames.some(frame=>frame.viewId==='b'&&frame.kind==='ready'),`queued view B must reach ready under sustained A wakes; order=${JSON.stringify(projectionOrder)}`);
 assert.equal(projectionOrder[1],'b','dirty A requeues behind already queued B');
 assert.equal((await fairRegistry.bound(fairSession.connectionId,'b',1,fairB.baselineId)).descriptor.viewId,'b');
 console.log('resource-connections: queued view reaches ready under sustained busy-view backpressure passed');
} finally { fairSession.close(); }

// A DELETE may beat the first install while this connection's SDK source is
// still opening; another connection must keep its independent view alive.
let sourceNumber=0,releaseDeferredSource;
const deferredSource=new Promise(resolve=>{releaseDeferredSource=resolve;});
const retirementRegistry=new connections.ResourceConnections({client:{
 async *resourceEvents(_identity,{signal}){
  if(++sourceNumber===2)await deferredSource;
  yield {protocolVersion:1,kind:'ready',producerGeneration:'retirement',position:0};
  if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 },
 async resourcePosition(){return {protocolVersion:1,producerGeneration:'retirement',position:0};},
},identity:'bound',identityCid:'a'.repeat(64),stateDir:profileDir,project:async descriptor=>({view:descriptor.viewId})});
const keeperResponse=new Response();keeperResponse.blocked=false;
const deferredResponse=new Response();deferredResponse.blocked=false;
const keeperSession=retirementRegistry.open(keeperResponse),deferredSession=retirementRegistry.open(deferredResponse);
try {
 const keeper=await retirementRegistry.register(keeperSession.connectionId,'keeper',1,{viewId:'keeper',resource:'identity'});
 await retirementRegistry.bound(keeperSession.connectionId,'keeper',1,keeper.baselineId);
 const delayed=retirementRegistry.register(deferredSession.connectionId,'retired',1,{viewId:'retired',resource:'identity'});
 const rejected=assert.rejects(delayed,/obsolete subscription epoch/);
 retirementRegistry.remove(deferredSession.connectionId,'retired',1);
 releaseDeferredSource();await rejected;
 await assert.rejects(retirementRegistry.register(deferredSession.connectionId,'retired',1,{viewId:'retired',resource:'identity'}),/obsolete subscription epoch/);
 const replacement=await retirementRegistry.register(deferredSession.connectionId,'retired',2,{viewId:'retired',resource:'identity'});
 retirementRegistry.remove(deferredSession.connectionId,'retired',1);
 assert.equal((await retirementRegistry.bound(deferredSession.connectionId,'retired',2,replacement.baselineId)).payload.view,'retired');
 assert.equal((await retirementRegistry.bound(keeperSession.connectionId,'keeper',1,keeper.baselineId)).payload.view,'keeper','unrelated connection remains live');
 assert.equal(deferredResponse.chunks.some(chunk=>chunk.includes('"subscriptionEpoch":1')),false,'retired first install never publishes content');
 console.log('resource-connections: DELETE-before-first-install rejects delayed/same epoch and preserves newer/unrelated views passed');
}finally{releaseDeferredSource();keeperSession.close();deferredSession.close();}

const boundedResponse=new Response();boundedResponse.blocked=false;
const boundedSession=registry2.open(boundedResponse);
try{
 assert.throws(()=>registry2.remove(boundedSession.connectionId,'bad/id',1),/invalid/);
 assert.throws(()=>registry2.remove(boundedSession.connectionId,'valid',NaN),/invalid/);
 for(let n=0;n<256;n++)registry2.remove(boundedSession.connectionId,'retired_'+n,1);
 assert.throws(()=>registry2.remove(boundedSession.connectionId,'overflow',1),/capacity/);
 await assert.rejects(registry2.register(boundedSession.connectionId,'overflow',1,{viewId:'overflow',resource:'identity'}),/capacity/);
 await assert.rejects(registry2.register(boundedSession.connectionId,'retired_0',1,{viewId:'retired_0',resource:'identity'}),/obsolete/);
 console.log('resource-connections: retirement identity validation and bounded fence retention passed');
}finally{boundedSession.close();}
