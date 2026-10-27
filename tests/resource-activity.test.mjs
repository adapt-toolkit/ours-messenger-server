import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApi } from '../src/api.ts';
import { MessengerEventBus } from '../src/events.ts';
import { ACTIVITY_READERS, canonicalResourceDescriptor, projectActivity } from '../src/resource-views.ts';

assert.deepEqual(canonicalResourceDescriptor({ viewId: 'activity', resource: 'activity' }), { viewId: 'activity', resource: 'activity' });
for (const descriptor of [{ viewId: 'a', resource: 'activity', entityId: 'peer' },
  { viewId: 'a', resource: 'activity', window: { limit: 1, retainedPages: 1 } }]) {
  assert.throws(() => canonicalResourceDescriptor(descriptor), /descriptor/, 'activity is identity-wide and has no window');
}

// One newest-row read per contact, at most ACTIVITY_READERS at once; a failing or empty
// contact neither blocks nor erases the others.
const rows = {
  A: [{ date: '2026-10-27T10:00:00.000Z', message_kind: 'text' }],
  B: [{ date: '2026-10-27T11:00:00.000Z', message_kind: 'text' }],
  EMPTY: [],
  FAIL: null,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`P${i}`, [{ date: `2026-10-2${i}T00:00:00.000Z` }]])),
};
const order = Object.keys(rows);
const reads = [];
let active = 0, peak = 0;
const fake = {
  async listFiles() { throw new Error('files are not activity'); },
  async listContacts() { return { contacts: order.map(container_id => ({ container_id, name: container_id })), roots: [] }; },
  async listHistory(params) {
    reads.push(params); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (rows[params.peer_cid] === null) throw new Error('daemon unavailable');
    return { items: rows[params.peer_cid].slice(0, params.limit) };
  },
};
const projected = await projectActivity(fake);
assert.deepEqual(Object.keys(projected.activity), order, 'contact order is the contact list order');
assert.deepEqual(projected.activity.A, { at: '2026-10-27T10:00:00.000Z' });
assert.deepEqual(projected.activity.B, { at: '2026-10-27T11:00:00.000Z' });
assert.deepEqual(projected.activity.EMPTY, { at: '' });
assert.deepEqual(projected.activity.FAIL, { unavailable: true });
assert.equal(projected.activity.P7.at, '2026-10-27T00:00:00.000Z');
assert.equal(reads.length, order.length, 'exactly one history read per contact');
assert.ok(reads.every(params => params.limit === 1 && Object.keys(params).length === 2), 'newest row only, no cursor or direction');
assert.equal(peak, ACTIVITY_READERS, 'concurrent reads are capped');
assert.ok(!JSON.stringify(projected).includes('body'), 'no message content is projected');

// Cancellation stops further reads.
const owner = new AbortController();
reads.length = 0;
const cancelled = projectActivity({ ...fake, async listHistory(params) { owner.abort(); return fake.listHistory(params); } }, owner.signal);
await assert.rejects(cancelled, { name: 'AbortError' });
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(reads.length, 1, 'no reader starts a contact after cancellation');

// A held read cannot be cancelled: the projection publishes the others at its deadline,
// the held read keeps its slot, and later projections share the same four slots.
{
  const held = new Set(['H1']);
  const releases = [];
  let inFlight = 0, most = 0, started = [];
  const holding = {
    async listContacts() { return { contacts: ['H1', 'A', 'B', 'C', 'D', 'E'].map(container_id => ({ container_id })), roots: [] }; },
    async listHistory({ peer_cid }) {
      started.push(peer_cid); inFlight++; most = Math.max(most, inFlight);
      try {
        if (held.has(peer_cid)) await new Promise(resolve => releases.push(resolve));
        return { items: [{ date: `2026-10-27T00:00:00.000Z` }] };
      } finally { inFlight--; }
    },
  };
  const first = await projectActivity(holding, undefined, 50);
  assert.deepEqual(first.activity.H1, { unavailable: true }, 'the held contact is unavailable');
  assert.ok(['A', 'B', 'C', 'D', 'E'].every(cid => first.activity[cid].at), 'the others publish despite the held read');
  assert.equal(inFlight, 1, 'the held read is still in flight');
  // Every read is held now: one slot is taken, so the next projection can start only three.
  for (const cid of ['A', 'B', 'C', 'D', 'E']) held.add(cid);
  started = [];
  const second = await projectActivity(holding, undefined, 50);
  assert.equal(started.length, 3, 'the abandoned held read still counts toward the cap');
  assert.ok(Object.values(second.activity).every(entry => entry.unavailable), 'nothing finished by the deadline');
  assert.equal(most, ACTIVITY_READERS, 'never more than four reads in flight');
  started = [];
  const third = await projectActivity(holding, undefined, 50);
  assert.equal(started.length, 0, 'all slots held: no new read starts');
  assert.ok(Object.values(third.activity).every(entry => entry.unavailable));
  held.clear();
  for (const release of releases.splice(0)) release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(inFlight, 0);
  assert.equal(started.length, 0, 'withdrawn readers of ended projections start nothing when slots free up');
  started = [];
  const recovered = await projectActivity(holding, undefined, 1000);
  assert.ok(Object.values(recovered.activity).every(entry => entry.at), 'slots return once held reads settle');
  assert.equal(started.length, 6);
}

// The deadline and cancellation also cover the contact list: a held list fails the
// projection rather than reporting no contacts, and no history read follows it.
{
  let releaseList, historyReads = 0, lists = 0;
  const heldList = {
    listContacts: () => { lists++; return new Promise((resolve, reject) => { releaseList = reject; }); },
    async listHistory() { historyReads++; return { items: [] }; },
  };
  const started = performance.now();
  await assert.rejects(projectActivity(heldList, undefined, 30), /contact list unavailable/);
  assert.ok(performance.now() - started < 500, 'the deadline runs from projection start');
  const owner = new AbortController();
  const cancelled = projectActivity(heldList, owner.signal, 60_000);
  owner.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(lists, 1, 'projections share the held contact list read');
  releaseList(new Error('late list failure'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(historyReads, 0);
  await assert.rejects(projectActivity(heldList, undefined, 30), /contact list unavailable/);
  assert.equal(lists, 2, 'a settled list read is not reused');
  await assert.rejects(projectActivity(fake, AbortSignal.abort()), { name: 'AbortError' });
}

// A list read that began before a projection is never its answer: the projection waits
// for it to settle, then reads the list again, with still one list read in flight.
{
  let roster = ['A'], lists = 0, inFlight = 0, most = 0;
  const releases = [];
  const changing = {
    listContacts() {
      lists++; inFlight++; most = Math.max(most, inFlight);
      const sampled = roster.map(container_id => ({ container_id }));
      return new Promise(resolve => releases.push(() => { inFlight--; resolve({ contacts: sampled, roots: [] }); }));
    },
    async listHistory() { return { items: [] }; },
  };
  const earlier = projectActivity(changing, undefined, 60_000);
  roster = ['A', 'B'];
  const later = projectActivity(changing, undefined, 60_000);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lists, 1, 'the later projection does not start a second list read alongside the first');
  releases.shift()();
  assert.deepEqual(Object.keys((await earlier).activity), ['A']);
  while (!releases.length) await new Promise(resolve => setTimeout(resolve, 1));
  releases.shift()();
  assert.deepEqual(Object.keys((await later).activity), ['A', 'B'], 'the later projection sees the contact added after the earlier read began');
  assert.equal(lists, 2);
  assert.equal(most, 1, 'never more than one list read in flight');
  // Projections waiting out the same older read share the one fresh read after it.
  const first = projectActivity(changing, undefined, 60_000);
  const waiting = [projectActivity(changing, undefined, 60_000), projectActivity(changing, undefined, 60_000)];
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lists, 3);
  releases.shift()();
  await first;
  while (!releases.length) await new Promise(resolve => setTimeout(resolve, 1));
  releases.shift()();
  for (const projection of waiting) assert.deepEqual(Object.keys((await projection).activity), ['A', 'B']);
  assert.equal(lists, 4, 'both waiting projections use one fresh read');
  // Waiting out an older read stays inside the deadline and starts nothing late.
  const held = projectActivity(changing, undefined, 60_000);
  const expiring = projectActivity(changing, undefined, 30);
  await assert.rejects(expiring, /contact list unavailable/);
  releases.shift()();
  await held;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lists, 5, 'the expired projection never starts its own read after the older one settles');
}

// An owner that ends in the same turn its wait is granted starts no list read.
{
  let lists = 0, release;
  const racing = {
    listContacts() { lists++; return new Promise(resolve => { release = () => resolve({ contacts: [], roots: [] }); }); },
    async listHistory() { return { items: [] }; },
  };
  const older = projectActivity(racing, undefined, 60_000);
  const owner = new AbortController();
  const joiner = projectActivity(racing, owner.signal, 60_000);
  await new Promise(resolve => setTimeout(resolve, 5));
  release(); owner.abort();
  await assert.rejects(joiner, { name: 'AbortError' });
  await older;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lists, 1, 'the aborted joiner dispatches no fresh list read');
}

// The descriptor registers, and its bound GET serves the same registered capture.
const stateDir = mkdtempSync(join(tmpdir(), 'resource-activity-'));
let wake;
const client = {
  ...fake,
  async *resourceEvents(_identity, { signal }) {
    yield { protocolVersion: 1, producerGeneration: 'source', position: 0, kind: 'ready' };
    while (!signal.aborted) {
      const frame = await new Promise(resolve => { wake = resolve; signal.addEventListener('abort', () => resolve(null), { once: true }); });
      if (!frame) return;
      yield frame;
    }
  },
  async resourcePosition() { return { protocolVersion: 1, producerGeneration: 'source', position: 0 }; },
};
const deps = { runtime: { client }, config: { stateDir, publicOrigin: 'http://localhost', identity: 'bound' }, identityCid: 'a'.repeat(64), events: new MessengerEventBus() };
const server = createServer((req, res) => void serveApi(req, res, deps));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const stream = new AbortController();
try {
  const unbound = await fetch(base + '/api/activity');
  assert.equal(unbound.status, 200);
  assert.deepEqual((await unbound.json()).activity.B, { at: '2026-10-27T11:00:00.000Z' });
  const reader = (await fetch(base + '/api/events?resources=1', { signal: stream.signal })).body.getReader();
  let pending = '';
  while (!pending.includes('\n\n')) pending += new TextDecoder().decode((await reader.read()).value);
  const connectionId = JSON.parse(pending.split('\n').find(line => line.startsWith('data: ')).slice(6)).connectionId;
  const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Ours-Messenger-CSRF': '1' };
  const registration = await fetch(base + '/api/resource-subscriptions', { method: 'POST', headers,
    body: JSON.stringify({ connectionId, viewId: 'activity', subscriptionEpoch: 1, descriptor: { viewId: 'activity', resource: 'activity' } }) });
  assert.equal(registration.status, 200);
  const { baselineId } = await registration.json();
  const binding = { 'X-Resource-Connection': connectionId, 'X-Resource-View': 'activity', 'X-Resource-Epoch': '1', 'X-Resource-Baseline': baselineId };
  const bound = await fetch(base + '/api/activity', { headers: binding });
  assert.equal(bound.status, 200);
  assert.equal(bound.headers.get('x-resource-baseline'), baselineId);
  assert.deepEqual(Object.keys((await bound.json()).activity), order);
  assert.equal((await fetch(base + '/api/contacts', { headers: binding })).status, 409, 'an activity binding authorizes only its own read');
  assert.equal((await fetch(base + '/api/activity?limit=1', { headers: binding })).status, 409, 'activity takes no query');
  // A reader that goes away starts no further contact reads.
  const releases = [];
  let reads = 0;
  client.listHistory = async () => { reads++; await new Promise(resolve => releases.push(resolve)); return { items: [] }; };
  const leaving = new AbortController();
  const answer = fetch(base + '/api/activity', { signal: leaving.signal }).catch(error => error);
  while (reads < ACTIVITY_READERS) await new Promise(resolve => setTimeout(resolve, 5));
  leaving.abort();
  assert.equal((await answer).name, 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 50));
  for (const release of releases.splice(0)) release();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(reads, ACTIVITY_READERS, 'no contact read starts after the request is gone');
} finally {
  stream.abort(); server.closeAllConnections(); server.close(); rmSync(stateDir, { recursive: true, force: true });
}
console.log('resource-activity: newest message time per contact, four reads at most, held and failed contacts isolated, bound GET, request-owned reads');
