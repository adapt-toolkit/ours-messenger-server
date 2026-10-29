import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApi } from '../src/api.ts';
import { MessengerEventBus } from '../src/events.ts';
import { canonicalResourceDescriptor, projectActivity } from '../src/resource-views.ts';
import { ResourceConnections } from '../src/resource-connections.ts';

assert.deepEqual(canonicalResourceDescriptor({ viewId: 'activity', resource: 'activity' }), { viewId: 'activity', resource: 'activity' });
for (const descriptor of [{ viewId: 'a', resource: 'activity', entityId: 'peer' },
  { viewId: 'a', resource: 'activity', window: { limit: 1, retainedPages: 1 } }]) {
  assert.throws(() => canonicalResourceDescriptor(descriptor), /descriptor/, 'activity is identity-wide and has no window');
}
const activity = { A: { at: '2026-10-27T10:00:00.000Z' }, B: { at: '2026-10-27T11:00:00.000Z' },
  EMPTY: { at: '' }, FAIL: { unavailable: true } };
const order = Object.keys(activity);
let lease = 1, retired = false, failOnce = false;
let position = 0, metadataReads = 0, positionReads = 0, hold, release, sharedSignal;
const source = () => ({ protocolVersion: 1, producerGeneration: 'source', position });
const fake = {
  async listHistory() { throw new Error('body history must not be read for activity'); },
  async listFiles() { throw new Error('files must not be read for activity'); },
  async resourcePosition() { positionReads++; return source(); },
  async getContactActivity() {
    metadataReads++;
    const incarnation = lease;
    if (retired) throw new Error('binding retired');
    if (failOnce) { failOnce = false; throw new Error('fixture metadata query unavailable'); }
    if (hold) await new Promise(resolve => { release = resolve; });
    if (retired || lease !== incarnation) throw new Error('binding changed');
    return { source: source(), activity: structuredClone(activity) };
  },
};
const projected = await projectActivity(fake);
assert.deepEqual(projected, { activity }, 'public map/order/empty/unavailable serialization stays unchanged');
assert.deepEqual(Object.keys(projected.activity), order);
assert.equal(metadataReads, 1, 'one typed metadata request replaces all body-history reads');
await assert.rejects(projectActivity(fake, AbortSignal.abort()), { name: 'AbortError' });
assert.equal(metadataReads, 1, 'retired owner admits no metadata request');
await assert.rejects(projectActivity({ ...fake, async getContactActivity() { throw Error('unsupported operation (HTTP404)'); } }),
  /unsupported/, 'older daemon fails explicitly without body fallback');
await assert.rejects(projectActivity({ ...fake, async getContactActivity() {
  return { source: { ...source(), producerGeneration: 'different-identity' }, activity };
} }, new AbortController().signal, source()), /source changed/,
  'metadata from a different bound identity cannot be certified by the expected resource source');

const stateDir = mkdtempSync(join(tmpdir(), 'resource-activity-'));
const service = () => new ResourceConnections({ client: fake, identity: 'bound', identityCid: 'a'.repeat(64), stateDir,
  project: (_descriptor, signal, capturedSource) => { sharedSignal = signal; return projectActivity(fake, signal, capturedSource); } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, 'fixture progress deadline'); await tick(); }
};
try {
  // One cancelled reader leaves the other owner and its admitted RPC intact.
  hold = true; metadataReads = 0;
  const owned = service(), a = new AbortController(), b = new AbortController();
  const first = owned.activity(a.signal), second = owned.activity(b.signal);
  await until(() => metadataReads === 1 && release);
  a.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(sharedSignal.aborted, false, 'another active reader retains the producer');
  release(); assert.deepEqual(await second, { activity });
  assert.equal(metadataReads, 1, 'simultaneous same-version demands coalesce');

  // All retired owners start nothing further; the admitted call drains in its slot.
  release = undefined;
  const c = new AbortController(), d = new AbortController();
  const third = owned.activity(c.signal), fourth = owned.activity(d.signal);
  await until(() => metadataReads === 2 && release);
  c.abort(); d.abort();
  await assert.rejects(third, { name: 'AbortError' });
  await assert.rejects(fourth, { name: 'AbortError' });
  assert.equal(sharedSignal.aborted, true);
  await assert.rejects(owned.activity(new AbortController().signal), /draining/);
  assert.equal(metadataReads, 2, 'abort is not a claim that admitted SQL was interrupted');
  release(); await tick(); await tick();
  hold = false;
  assert.deepEqual(await owned.activity(new AbortController().signal), { activity });
  assert.equal(metadataReads, 3, 'later genuine demand can start after actual drain');

  // A held completion cannot certify an older contact/history source version.
  hold = true; release = undefined;
  const stale = owned.activity(new AbortController().signal);
  await until(() => metadataReads === 4 && release);
  position++; release();
  await assert.rejects(stale, /source changed/);
  assert.equal(metadataReads, 4, 'no autonomous retry follows a changed source');
  hold = false;
  await owned.activity(new AbortController().signal);
  assert.equal(metadataReads, 5, 'new external demand obtains the new version');

  // Distinct service/authorization generations never share a pending projection.
  hold = true; release = undefined;
  const oldOwner = new AbortController();
  const old = owned.activity(oldOwner.signal);
  await until(() => metadataReads === 6 && release);
  const oldRelease = release;
  oldOwner.abort(); await assert.rejects(old, { name: 'AbortError' });
  const newGeneration = service(), currentOwner = new AbortController(); release = undefined;
  const current = newGeneration.activity(currentOwner.signal);
  await until(() => metadataReads === 7 && release);
  const currentRelease = release;
  oldRelease(); await tick();
  currentRelease(); assert.deepEqual(await current, { activity });
  assert.equal(metadataReads, 7);

  // Preserve the existing finite activity budget without orphaning held work.
  const timed = service(); release = undefined;
  const timeout = timed.activity(new AbortController().signal, undefined, 30);
  await until(() => release);
  await assert.rejects(timeout, /unavailable/);
  release(); await tick(); hold = false;

  // Only overlapping work shares admission. Each later demand checks the lease.
  metadataReads = 0; positionReads = 0; position = 0; hold = true; release = undefined;
  const client = {
    ...fake,
    async *resourceEvents(_identity, { signal }) {
      yield { ...source(), kind: 'ready' };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const deps = { runtime: { client }, config: { stateDir, publicOrigin: 'http://localhost', identity: 'bound' },
    identityCid: 'a'.repeat(64), events: new MessengerEventBus() };
  const server = createServer((req, res) => void serveApi(req, res, deps));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, stream = new AbortController();
  try {
    const ordinary = fetch(base + '/api/activity');
    await until(() => metadataReads === 1 && release);
    const reader = (await fetch(base + '/api/events?resources=1', { signal: stream.signal })).body.getReader();
    let pending = '';
    while (!pending.includes('\n\n')) pending += new TextDecoder().decode((await reader.read()).value);
    const connectionId = JSON.parse(pending.split('\n').find(line => line.startsWith('data: ')).slice(6)).connectionId;
    const registration = fetch(base + '/api/resource-subscriptions', {
      method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Ours-Messenger-CSRF': '1' },
      body: JSON.stringify({ connectionId, viewId: 'activity', subscriptionEpoch: 1, descriptor: { viewId: 'activity', resource: 'activity' } }),
    });
    await until(() => positionReads >= 3);
    release(); hold = false;
    const plain = await ordinary, registered = await registration;
    assert.equal(plain.status, 200); assert.deepEqual(await plain.json(), { activity });
    assert.equal(registered.status, 200);
    assert.equal(metadataReads, 1, 'simultaneous ordinary/bound work performs one metadata operation');
    const { baselineId } = await registered.json();
    const binding = { 'X-Resource-Connection': connectionId, 'X-Resource-View': 'activity', 'X-Resource-Epoch': '1', 'X-Resource-Baseline': baselineId };
    const bound = await fetch(base + '/api/activity', { headers: binding });
    assert.equal(bound.status, 200); assert.equal(bound.headers.get('x-resource-baseline'), baselineId);
    assert.deepEqual(await bound.json(), { activity });
    const reused = await fetch(base + '/api/activity');
    assert.equal(reused.status, 200); assert.deepEqual(await reused.json(), { activity });
    assert.equal(metadataReads, 3, 'bound bootstrap and later ordinary demand each validate current SDK authority');
    failOnce = true;
    const beforeFailure = source();
    assert.equal((await fetch(base + '/api/activity')).status, 500, 'provider failure rejects the projection');
    assert.equal(metadataReads, 4);
    assert.deepEqual(source(), beforeFailure);
    const recovered = await fetch(base + '/api/activity');
    assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), { activity });
    assert.equal(metadataReads, 5, 'later genuine same-source demand recovers without automatic retry');
    retired = true;
    assert.equal((await fetch(base + '/api/activity')).status, 500, 'same service must not return an old bound capture after lease retirement');
    assert.equal(metadataReads, 6);
    assert.equal((await fetch(base + '/api/activity', { headers: binding })).status, 409,
      'bound bootstrap must not return its old initial payload after lease retirement');
    assert.equal(metadataReads, 7);
    retired = false; lease++;
    assert.equal((await fetch(base + '/api/activity')).status, 200, 'current client new lease can satisfy a fresh ordinary demand');
    hold = true; release = undefined;
    const aba = fetch(base + '/api/activity');
    await until(() => metadataReads === 9 && release);
    lease++; lease++; // same client A-to-B-to-A with the same identity source
    release(); hold = false;
    assert.equal((await aba).status, 500, 'pending retired incarnation cannot publish after same-source ABA');
    assert.equal(metadataReads, 9, 'no automatic retry after retired-incarnation completion');
    assert.equal((await fetch(base + '/api/activity')).status, 200);
    assert.equal(metadataReads, 10, 'new genuine demand uses the current incarnation');
    assert.equal((await fetch(base + '/api/contacts', { headers: binding })).status, 409, 'binding authorizes only its own read');
    assert.equal((await fetch(base + '/api/activity?limit=1', { headers: binding })).status, 409, 'activity takes no query');
  } finally { stream.abort(); server.closeAllConnections(); server.close(); }
} finally { rmSync(stateDir, { recursive: true, force: true }); }
console.log('PASS resource activity: metadata-only, version/ownership, one/all cancellation, drain, deadline, ordinary/bound coalescing and bootstrap');
