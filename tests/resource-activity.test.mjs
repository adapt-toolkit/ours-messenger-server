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
} finally {
  stream.abort(); server.closeAllConnections(); server.close(); rmSync(stateDir, { recursive: true, force: true });
}
console.log('resource-activity: newest-row activity per contact, capped reads, isolated failures, bound GET');
