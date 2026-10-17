import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as profiles from '../src/workspace-profile.ts';

// Missing post-rename publication, publication on failed writes, and observer
// exception propagation would each break this real-filesystem contract.
assert.equal(typeof profiles.subscribeHumanProfile, 'function', 'Human profile exposes committed observation');
const dir = mkdtempSync(join(tmpdir(), 'resource-profile-'));
const cid = 'a'.repeat(64), other = 'b'.repeat(64);
const observed = [];
const signal = new AbortController();
try {
  profiles.subscribeHumanProfile(dir, cid, () => { throw Error('observer failure'); }, signal.signal);
  profiles.subscribeHumanProfile(dir, cid, () => observed.push(profiles.readHumanProfile(dir, cid)), signal.signal);
  profiles.writeHumanProfile(dir, other, { name: 'Other' });
  assert.deepEqual(observed, [], 'another identity cannot wake the profile view');
  profiles.writeHumanProfile(dir, cid, { name: 'Committed' });
  assert.deepEqual(observed, [{ fullName: null, name: 'Committed', surname: null }]);
  chmodSync(dir, 0o755);
  assert.throws(() => profiles.writeHumanProfile(dir, cid, { name: 'Rejected' }), /Private profile directory/);
  assert.equal(observed.length, 1, 'failed write does not publish');
  chmodSync(dir, 0o700);
  signal.abort();
  profiles.writeHumanProfile(dir, cid, { name: 'Disposed' });
  assert.equal(observed.length, 1, 'aborted profile owner releases observation');
} finally { signal.abort(); rmSync(dir, { recursive: true, force: true }); }
console.log('resource-views: committed profile observation passed');

const resources = await import('../src/resource-views.ts');
assert.equal(typeof resources.captureResourceProjection, 'function', 'canonical projections have a bounded source fence');
let position = 0, reads = 0;
const owner = new AbortController();
const source = { async resourcePosition() { return { protocolVersion: 1, producerGeneration: 'source-a', position }; } };
const capture = await resources.captureResourceProjection(source, 'identity', async () => {
  reads++;
  if (reads === 1) position++;
  return { contacts: [{ cid: 'new', name: 'Committed' }] };
}, owner.signal);
assert.equal(reads, 2, 'mutation during projection retries before certifying baseline');
assert.deepEqual(capture, { source: { protocolVersion: 1, producerGeneration: 'source-a', position: 1 }, payload: { contacts: [{ cid: 'new', name: 'Committed' }] } });
reads = 0;
await assert.rejects(resources.captureResourceProjection(source, 'identity', async () => { reads++; position++; return {}; }, owner.signal), /unstable/);
assert.equal(reads, 3, 'sustained churn is bounded');
owner.abort();
await assert.rejects(resources.captureResourceProjection(source, 'identity', async () => ({}), owner.signal), /abort/i);
console.log('resource-views: stable canonical capture passed');

assert.equal(typeof resources.resourceFrames, 'function', 'resource encoder supports complete bounded assembly');
const large = { protocolVersion: 1, producerGeneration: 'messenger-a', subscriptionEpoch: 1, viewId: 'directory', sequence: 1, revision: 1, kind: 'snapshot', payload: { text: '🙂'.repeat(140000) } };
const ordinary = [...resources.resourceFrames({ ...large, payload: { text: 'small' } })];
assert.equal(ordinary.length, 1);
assert.equal(ordinary[0].event, 'resource');
const encoded = [...resources.resourceFrames(large)];
assert.equal(encoded[0].data.type, 'start');
assert.equal(encoded.at(-1).data.type, 'commit');
const pieces = encoded.filter(frame => frame.data.type === 'chunk');
const assembled = Buffer.concat(pieces.map(frame => Buffer.from(frame.data.data, 'base64')));
assert.deepEqual(JSON.parse(assembled.toString('utf8')), large, 'UTF-8 survives arbitrary byte boundaries');
assert.equal(encoded[0].data.totalBytes, assembled.length);
assert.equal(encoded[0].data.parts, pieces.length);
assert.ok(encoded.every(frame => Buffer.byteLength(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`) <= 512 * 1024));
assert.throws(() => [...resources.resourceFrames({ ...large, payload: 'x'.repeat(16 * 1024 * 1024) })], /assembly limit/);
console.log('resource-views: bounded UTF-8 assembly passed');

assert.equal(typeof resources.canonicalResourceDescriptor, 'function', 'view descriptors reject arbitrary route/query access');
assert.deepEqual(resources.canonicalResourceDescriptor({ viewId: 'list', resource: 'contacts' }), { viewId: 'list', resource: 'contacts' });
for (const descriptor of [
  { viewId: 'x', resource: '/etc/passwd' },
  { viewId: 'x', resource: 'identity', entityId: 'other' },
  { viewId: 'x', resource: 'contacts', filter: { arbitrary: true } },
  { viewId: 'x', resource: 'messages', entityId: 'peer', window: { limit: 201, retainedPages: 1 } },
  { viewId: 'x', resource: 'messages', entityId: 'peer', path: '/api/state' },
  { viewId: 'x', resource: 'messages', entityId: 'peer', window: { limit: 50, retainedPages: 0 } },
]) assert.throws(() => resources.canonicalResourceDescriptor(descriptor), /descriptor/);
console.log('resource-views: descriptor allowlist passed');

assert.equal(typeof resources.projectMessageWindow, 'function', 'loaded message windows reuse canonical history projection');
const historyRows = [1,2,3,4,5].map(seq => ({ seq, msg_id: seq, wire_id: `W${seq}`, from: { id: 'peer', name: 'Peer' }, peer: { id: 'peer', name: 'Peer' }, direction: 'in', text: `text${seq}`, body: `text${seq}`, message_kind: 'text', occurred_at_ms: seq, date: '2026-10-16', encryption: 'encrypted', transport: 'double_ratchet', inbox_state: 'unread', status: 'unread', delivery_state: null, human_read_at_ms: null, reply_to: null }));
// SDK RPC boundary fixture supplies canonical rows, not a mock projection.
const historyClient = {
 async listHistory(query) {
  const rows = historyRows.filter(row => query.before_seq === undefined || row.seq < query.before_seq).toReversed();
  return { items: rows.slice(0, query.limit), next_cursor: rows.length > query.limit ? rows[query.limit - 1].seq : null };
 },
 async getHistorySummary() { return { total: historyRows.length, unread: historyRows.length }; },
 async getHistoryItem({ wire_id }) { return historyRows.find(row => row.wire_id === wire_id) ?? null; },
};
const active = new AbortController();
const first = await resources.projectMessageWindow(historyClient, 'peer', 'Peer', { limit: 2, retainedPages: 2 }, active.signal);
assert.deepEqual(first.messages.map(row => row.wire_id), ['W2','W3','W4','W5']);
assert.equal(first.nextBefore, '2');
assert.equal(first.preview, 'text5');
assert.equal(first.oldestSequence, 2);
historyRows.push({ ...historyRows[4], seq: 6, msg_id: 6, wire_id: 'W6', text: 'text6', body: 'text6' });
const shifted = await resources.projectMessageWindow(historyClient, 'peer', 'Peer', { limit: 2, retainedPages: 2 }, active.signal);
assert.deepEqual(shifted.messages.map(row => row.wire_id), ['W3','W4','W5','W6']);
const delta = await resources.messageProjectionDelta(historyClient, first, shifted, active.signal);
assert.deepEqual(delta.upserts.map(row => row.id), ['W6']);
assert.deepEqual(delta.deletes, [], 'leaving a page window is not source deletion');
assert.deepEqual(delta.window.orderedIds, ['W3','W4','W5','W6']);
historyRows.splice(historyRows.findIndex(row => row.wire_id === 'W2'), 1);
const retained = await resources.projectMessageWindow(historyClient, 'peer', 'Peer', { limit: 2, retainedPages: 2, oldestSequence: 2 }, active.signal);
const deleted = await resources.messageProjectionDelta(historyClient, first, retained, active.signal);
assert.deepEqual(deleted.deletes, ['W2'], 'deleted loaded older message gets explicit tombstone');
assert.deepEqual(retained.messages.map(row => row.wire_id), ['W3','W4','W5','W6']);
assert.equal(retained.preview, 'text6');
console.log('resource-views: arrivals, window departures and older tombstones passed');

const api = await import('../src/api.ts');
assert.equal(typeof api.projectResourceView, 'function', 'resource delivery uses existing canonical route serializers');
const projectionDir = mkdtempSync(join(tmpdir(), 'resource-projection-'));
try {
 profiles.writeHumanProfile(projectionDir, cid, { name: 'Human' });
 const deps = { runtime: { client: { ...historyClient,
  listContacts: async () => ({ contacts: [{ name: 'Peer', container_id: 'peer', extra: 'retained' }], pending: [], roots: [] }),
  currentIdentity: async () => ({ cid, name: 'Human identity', bio: 'Bio', secret: 'never' }),
  listFiles: async () => ({ items: [], next_cursor: null }),
 } }, config: { stateDir: projectionDir, identity: 'Human' }, identityCid: cid };
 const projectedIdentity = await api.projectResourceView(deps, { viewId: 'self', resource: 'identity' }, active.signal);
 assert.deepEqual(projectedIdentity, { cid, name: 'Human identity', bio: 'Bio', humanProfile: { fullName: null, name: 'Human', surname: null } });
 const contacts = await api.projectResourceView(deps, { viewId: 'contacts', resource: 'contacts' }, active.signal);
 assert.equal(contacts.contacts[0].display_name, 'Peer');
 assert.equal(contacts.contacts[0].extra, 'retained');
 const files = await api.projectResourceView(deps, { viewId: 'files', resource: 'files', entityId: 'peer' }, active.signal);
 assert.deepEqual(files, { contact: 'peer', files: [] });
 const messages = await api.projectResourceView(deps, { viewId: 'messages', resource: 'messages', entityId: 'peer', window: { limit: 2, retainedPages: 1 } }, active.signal);
 assert.deepEqual(messages.messages.map(row => row.wire_id), ['W5', 'W6']);
 assert.equal(messages.unread, 5);
} finally { rmSync(projectionDir, { recursive: true, force: true }); }
console.log('resource-views: canonical identity, contacts, messages and files passed');

const abandoned = new AbortController();
let enteredResolve;
const entered = new Promise(resolve => { enteredResolve=resolve; });
const hanging = resources.captureResourceProjection(source, 'identity', async () => { enteredResolve(); return new Promise(()=>{}); }, abandoned.signal);
await entered;
abandoned.abort();
await Promise.race([assert.rejects(hanging,/abort/i), new Promise((_,reject)=>setTimeout(()=>reject(Error('retired capture waited for abort-ignoring read')),50))]);
console.log('resource-views: retirement fences abort-ignoring projection reads passed');

const largeText='x'.repeat(9*1024*1024);
const largeHistory={...historyClient,async listHistory(){return {items:[historyRows[2],{...historyRows[0],text:largeText,body:largeText}],next_cursor:null};}};
const largeWindow=await resources.projectMessageWindow(largeHistory,'peer','Peer',{limit:50,retainedPages:1},active.signal);
assert.equal(largeWindow.messages[0].text.length,9*1024*1024,'assembly budget measures canonical payload, not duplicated internal body/text fields');
await assert.rejects(resources.projectMessageWindow({...historyClient,async listHistory(){return {items:[{...historyRows[0],wire_id:''}],next_cursor:null};}},'peer','Peer',{limit:50,retainedPages:1},active.signal),/stable IDs/);
let filePages=0;
await assert.rejects(api.projectResourceView({runtime:{client:{
 async listContacts(){return {contacts:[],pending:[],roots:[]};},
 async listFiles(){filePages++;return {items:[{seq:4-filePages,wire_id:`F${filePages}`,peer:{id:'peer',name:'Peer'},direction:'in',filename:'x'.repeat(9*1024*1024),mime:'text/plain',byte_length:1,sha256:'hash',date:'date',kind:'file',inbox_state:'unread',reply_to:null}],next_cursor:filePages<3?4-filePages:null};},
}},config:{identity:'Human'},identityCid:cid},{viewId:'files',resource:'files',entityId:'peer'},active.signal),/assembly limit/);
assert.equal(filePages,1,'one oversized canonical file record aborts before unbounded further pages');
