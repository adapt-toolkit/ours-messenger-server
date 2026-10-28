import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serveApi } from '../src/api.ts';

// Use colliding CID-shaped aliases: preview omission must never change resolution.
const a = 'A'.repeat(64), b = 'B'.repeat(64);
const calls = [];
let failure;
const row = (seq, text) => ({ seq, direction: 'in', text, date: '2026-01-01',
  inbox_state: 'unread', wire_id: `wire-${seq}`, peer: { id: a, name: b }, body: text });
const client = {
  async listContacts() {
    calls.push(['contacts']);
    if (failure === 'contacts') throw new Error('fixture resolver failure');
    return { contacts: [{ container_id: a, name: b }, { container_id: b, name: 'realB' }] };
  },
  async listHistory(query) {
    calls.push(['history', query]);
    if (failure === 'history') throw new Error('fixture history failure');
    return { items: [row(query.before_seq ? 80 : 120, query.before_seq ? 'older' : 'latest')], next_cursor: 70 };
  },
  async getHistorySummary(query) {
    calls.push(['summary', query]);
    if (failure === 'summary') throw new Error('fixture summary failure');
    return { total: 200, unread: 150 };
  },
};
const deps = { runtime: { client }, config: {} };
const server = createServer((req, res) => void serveApi(req, res, deps));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/conversations/${b}/page`;
async function read(query) {
  calls.length = 0;
  const response = await fetch(base + query);
  return { status: response.status, value: await response.json() };
}
try {
  const baseline = await read('?limit=50&before=100');
  assert.equal(baseline.status, 200);
  assert.equal(baseline.value.preview, 'latest');
  assert.deepEqual(calls, [['contacts'],
    ['history', { peer_cid: a, before_seq: 100, limit: 50 }],
    ['summary', { peer_cid: a }], ['history', { peer_cid: a, limit: 1 }]]);
  const omitted = await read('?limit=50&before=100&preview=none');
  assert.equal(omitted.status, 200);
  assert.deepEqual(omitted.value, { ...baseline.value, preview: '' },
    'passive page rows, whole-dialog counts, receipts and cursor remain unchanged');
  assert.deepEqual(calls, [['contacts'],
    ['history', { peer_cid: a, before_seq: 100, limit: 50 }], ['summary', { peer_cid: a }]],
    'only the extra newest-row read disappears; the legacy alias still resolves A');
  const initial = await read('?limit=50&preview=none');
  assert.equal(initial.status, 200);
  assert.equal(initial.value.preview, '');
  assert.equal(initial.value.messages[0].text, 'latest');
  assert.equal(calls.filter(call => call[0] === 'history').length, 1);
  for (const query of ['?preview=', '?preview=false', '?preview=NONE', '?preview=none&preview=none', '?preview=none&preview=']) {
    assert.equal((await read(query)).status, 400, query);
    assert.deepEqual(calls, [], 'invalid opt-in is rejected before SDK work');
  }
  for (failure of ['contacts', 'history', 'summary']) {
    assert.equal((await read('?limit=50&before=100&preview=none')).status, 500,
      `${failure} failure must not become a successful empty page`);
  }
  console.log('PASS preview omission HTTP contract, call counts, alias collision, validation and failures');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
