import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serveApi, projectResourceView, presentContacts } from '../src/api.ts';
import { canonicalResourceDescriptor, messageProjectionDelta } from '../src/resource-views.ts';

const a = 'A'.repeat(64), b = 'B'.repeat(64);
let contacts = [{ container_id: a, name: b }, { container_id: b, name: 'real B' }];
const calls = [];
const client = {
  async listContacts() { calls.push(['contacts']); return { contacts }; },
  async listHistory(query) {
    calls.push(['history', query]);
    return { items: [{ seq: 2, direction: 'in', body: 'body', text: 'body',
      date: '2026-01-01', inbox_state: 'unread', wire_id: 'wire',
      peer: { id: query.peer_cid, name: 'fixture' } }], next_cursor: null };
  },
  async getHistorySummary(query) { calls.push(['summary', query]); return { total: 1, unread: 1 }; },
  async listFiles(query) { calls.push(['files', query]); return { items: [], next_cursor: null }; },
  async listIncomingMessages() {
    calls.push(['incoming']);
    return [a, ...Array(201).fill(b)].map((id, n) => ({ from: { id }, wire_id: 'unread-' + n }));
  },
  async getMessages(query) {
    calls.push(['consume', query]);
    return { messages: query.wire_ids.map(wire_id => ({ wire_id })) };
  },
};
const deps = { runtime: { client }, config: { publicOrigin: 'http://localhost' } };
const server = createServer((req, res) => void serveApi(req, res, deps));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-Ours-Messenger-CSRF': '1' };
async function request(path, method = 'GET', extra = {}) {
  calls.length = 0;
  const response = await fetch(base + path, { method, headers: method === 'GET' ? extra : { ...headers, ...extra },
    ...(method === 'POST' ? { body: '{}' } : {}) });
  return { status: response.status, value: await response.json() };
}
try {
  assert.deepEqual(presentContacts({ contacts: [], pending: [] }).capabilities, { canonicalPeerReads: 1 });
  const strict = await request(`/api/peers/${b}/page?before=10&limit=50`);
  assert.equal(strict.status, 200);
  assert.deepEqual(strict.value.peer, { kind: 'cid', cid: b });
  assert.equal(strict.value.preview, '');
  assert.deepEqual(calls, [['history', { peer_cid: b, before_seq: 10, limit: 50 }], ['summary', { peer_cid: b }]]);
  const legacy = await request(`/api/conversations/${b}/page?before=10&limit=50`);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.value.peer, undefined);
  assert.equal(calls[0][0], 'contacts');
  assert.ok(calls.filter(([kind]) => kind === 'history').every(([, query]) => query.peer_cid === a));
  assert.equal(calls.filter(([kind]) => kind === 'history').length, 2, 'legacy newest preview remains');

  // A directory reassignment after initial admission cannot retarget any strict successor.
  contacts = [{ container_id: a, name: b }];
  for (const path of [`/api/peers/${b}/page?before=5`, `/api/peers/${b}/files`]) {
    const result = await request(path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.value.peer, { kind: 'cid', cid: b });
    assert.ok(calls.every(([kind, query]) => kind !== 'contacts' && query.peer_cid === b));
  }
  const consumed = await request(`/api/peers/${b}/read`, 'POST');
  assert.equal(consumed.status, 200);
  assert.equal(consumed.value.marked, 201);
  assert.deepEqual(consumed.value.peer, { kind: 'cid', cid: b });
  const batches = calls.filter(([kind]) => kind === 'consume').map(([, query]) => query.wire_ids);
  assert.deepEqual(batches.map(ids => ids.length), [200, 1]);
  assert.ok(batches.flat().every(id => id !== 'unread-0'), 'only B is consumed, never alias A');
  assert.equal((await request(`/api/peers/${b}/read`, 'POST', { Origin: 'https://evil.test' })).status, 403);
  assert.deepEqual(calls, [], 'existing mutation intent authority stays before SDK');

  for (const path of ['/api/peers/name/page', '/api/peers/name/files',
    `/api/peers/${b}/page?before=no`, `/api/peers/${b}/page?limit=0`,
    `/api/peers/${b}/page?limit=1&limit=2`, `/api/peers/${b}/page?before=2&before=3`,
    `/api/peers/${b}/page?preview=none&preview=none`]) {
    assert.equal((await request(path)).status, 400, path);
    assert.deepEqual(calls, [], 'malformed strict requests have no SDK calls');
  }
  assert.equal((await request('/api/peers/name/read', 'POST')).status, 400);
  assert.deepEqual(calls, []);

  const signal = new AbortController().signal;
  for (const resource of ['messages', 'files']) {
    const descriptor = { viewId: resource, resource, entityId: b, addressing: 'cid',
      ...(resource === 'messages' ? { window: { limit: 50, retainedPages: 1 } } : {}) };
    assert.equal(canonicalResourceDescriptor(descriptor).addressing, 'cid');
    calls.length = 0;
    const value = await projectResourceView(deps, descriptor, signal);
    assert.deepEqual(value.peer, { kind: 'cid', cid: b });
    assert.ok(calls.every(([kind, query]) => kind !== 'contacts' && query.peer_cid === b));
    if (resource === 'messages') {
      assert.equal(value.preview, '');
      const delta = await messageProjectionDelta({}, { ...value, unread: 2 }, value, signal);
      assert.deepEqual(delta.window.peer, { kind: 'cid', cid: b }, 'delta metadata retains the pin');
    }
    for (const bad of [{ ...descriptor, entityId: 'alias' }, { ...descriptor, addressing: 'guess' },
      { ...descriptor, resource: 'commands', window: undefined },
      { ...descriptor, expectedCID: b }])
      assert.throws(() => canonicalResourceDescriptor(bad), /invalid resource descriptor/);
  }
  console.log('PASS strict passive/read CID collision, reassignment, no contact lookup, validation, auth and resource metadata');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
