import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApi } from '../src/api.ts';
import { bindIdentity, startRuntime } from '../src/daemon.ts';
import { MessengerEventBus } from '../src/events.ts';
import { ConfigurationError } from '../src/security.ts';

const BUILD = {
  name: '@ours.network/messenger-server', version: '0.1.0',
  sha: '1111111111111111111111111111111111111111', dirty: false,
};
const commandStateDir = mkdtempSync(join(tmpdir(), 'messenger-command-api-'));
const NativeResponse = globalThis.Response;
const CONFIG = {
  host: '127.0.0.1', port: 8420, publicOrigin: 'https://messenger.example.com',
  identity: 'Messenger', force: false, stateDir: commandStateDir,
};

let attached = 0;
let released = 0;
const chosen = [];
const client = {
  version: async () => ({ version: '3.0.2', compat: '3', stateDir: '/shared/ours' }),
  releaseLease: async () => { released++; },
  chooseIdentity: async (input) => {
    chosen.push(input);
    return { name: input.name, cid: 'CID-MESSENGER' };
  },
};
const runtime = await startRuntime(CONFIG, BUILD, async ({ leaseToken }) => {
  attached++;
  assert.match(leaseToken, /^messenger-[0-9a-f]{48}$/);
  return client;
});
assert.equal(attached, 1, 'messenger attaches exactly once to the selected shared daemon');
assert.equal(runtime.described.ownership, 'shared-daemon');
assert.equal(runtime.stateDir, '/shared/ours');
assert.equal(Object.hasOwn(runtime.described, 'brokerUrl'), false, 'daemon credentials are not messenger state');
assert.deepEqual(await bindIdentity(runtime, CONFIG), { name: 'Messenger', cid: 'CID-MESSENGER' });
assert.deepEqual(chosen, [{ name: 'Messenger', force: false }], 'messenger leases only its configured existing identity');

// The public daemon notification route classifies `kinds=inbound` narrowly as
// message/file arrivals. Delivery/read receipts are deliberately a different
// event kind. Messenger needs both on the same cursor, otherwise the receipt is
// persisted in history but never reaches the already-open browser over SSE.
// Both ordinary peers and Cowork rooms use this exact subscription path.
const originalFetch = globalThis.fetch;
const peerReceipt = {
  event: 'receipt_received', sender_id: 'CID-PEER', kind: 'delivered',
  wire_ids: ['WIRE-PEER'], date: '2026-09-04T10:00:00.000Z',
};
const roomReceipt = {
  event: 'receipt_received', sender_id: 'CID-ROOM', kind: 'read',
  wire_ids: ['WIRE-ROOM'], date: '2026-09-04T10:00:01.000Z',
};
const unrelatedLifecycleEvent = { event: 'contact_removed', cid: 'CID-UNRELATED', by: 'peer' };
let notificationUrl;
try {
  globalThis.fetch = async (input) => {
    notificationUrl = new URL(String(input));
    const events = notificationUrl.searchParams.has('kinds')
      ? [] : [peerReceipt, unrelatedLifecycleEvent, roomReceipt];
    return new NativeResponse(JSON.stringify({ cursor: 42, events }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const notificationPage = await runtime.readNotificationPage('Messenger', 17, new AbortController().signal);
  assert.equal(notificationUrl.searchParams.get('since'), '17');
  assert.equal(notificationUrl.searchParams.get('kinds'), null,
    'messenger must not select the daemon inbound-only event set, which excludes receipts');
  assert.deepEqual(notificationPage, { cursor: 42, events: [peerReceipt, roomReceipt] },
    'one shared notification cursor carries ordinary-chat and Cowork-room receipts without cross-chat lifecycle invalidation');
} finally {
  globalThis.fetch = originalFetch;
}
await assert.rejects(
  bindIdentity({ client: { chooseIdentity: async () => { throw Object.assign(new Error('missing'), { code: 'NO_SUCH_IDENTITY' }); } } }, CONFIG),
  (error) => error instanceof ConfigurationError && error.message.includes('create it with the ours CLI'),
  'a missing configured identity is an actionable operator error, never implicit provisioning',
);
await runtime.close();
await runtime.close();
assert.equal(released, 1, 'shutdown releases the application lease but never owns daemon shutdown');

class Request extends EventEmitter {
  constructor(method, url, body) {
    super();
    this.method = method;
    this.url = url;
    this.headers = method === 'GET' ? {} : {
      'content-type': 'application/json', origin: CONFIG.publicOrigin, 'x-ours-messenger-csrf': '1',
    };
    this.rawHeaders = Object.entries(this.headers).flatMap(([key, value]) => [key, value]);
    this.body = body ? JSON.stringify(body) : '';
  }
  async *[Symbol.asyncIterator]() { if (this.body) yield Buffer.from(this.body); }
}
class Response extends EventEmitter {
  chunks = [];
  destroyed = false;
  writableEnded = false;
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.writableEnded = true; }
  json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); }
}

const reads = [];
const commandsSent = [];
let advertisedCommands = [{
  name: 'notes.create', description: 'Create a note',
  input_schema: { type: 'object', required: [''], properties: { '': { type: 'string' } } },
}];
const historyClient = {
  listContacts: async () => ({ contacts: [{ container_id: 'CID-PEER', name: 'Peer' }], roots: [] }),
  listHistory: async (query) => {
    if (query.before_seq === 7) {
      assert.deepEqual(query, { peer_cid: 'CID-PEER', before_seq: 7, limit: 2 });
      return {
        items: [{ type: 'message', seq: 6, direction: 'in', wire_id: 'W6', peer: { id: 'CID-PEER', name: 'Peer' }, text: 'older', date: 'D6', inbox_state: 'read', delivery_state: null, reply_to: null }],
        next_cursor: null,
      };
    }
    if (query.limit === 1) {
      assert.deepEqual(query, { peer_cid: 'CID-PEER', limit: 1 });
      return {
        items: [{ type: 'message', seq: 8, direction: 'in', wire_id: 'W8', peer: { id: 'CID-PEER', name: 'Peer' }, text: 'new', date: 'D8', inbox_state: 'unread', delivery_state: null, reply_to: null }],
        next_cursor: 8,
      };
    }
    assert.deepEqual(query, { peer_cid: 'CID-PEER', before_seq: undefined, limit: 2 });
    return {
      items: [
        { type: 'message', seq: 8, direction: 'in', wire_id: 'W8', peer: { id: 'CID-PEER', name: 'Peer' }, text: 'new', date: 'D8', status: 'unread', delivery_state: null, reply_to: null },
        { type: 'message', seq: 7, direction: 'out', wire_id: 'W7', peer: { id: 'CID-PEER', name: 'Peer' }, text: 'old', date: 'D7', status: 'sent', delivery_state: 'delivered', reply_to: null },
      ],
      next_cursor: 7,
    };
  },
  getHistorySummary: async ({ peer_cid }) => {
    assert.equal(peer_cid, 'CID-PEER');
    return { total: 8, unread: 3 };
  },
  listIncomingMessages: async () => [
    { wire_id: 'A1', from: { id: 'CID-PEER', name: 'Peer' }, status: 'unread' },
    { wire_id: 'B1', from: { id: 'CID-OTHER', name: 'Other' }, status: 'unread' },
    { wire_id: 'A2', from: { id: 'CID-PEER', name: 'Peer' }, status: 'unread' },
  ],
  getMessages: async (input) => {
    reads.push(input);
    return { messages: input.wire_ids.map((wire_id) => ({ wire_id })) };
  },
  listContactCommands: async ({ contact }) => {
    assert.equal(contact, 'CID-PEER');
    return advertisedCommands;
  },
  sendCommand: async (input) => {
    commandsSent.push(input);
    return { kind: 'e2e', wireId: 'CMD-WIRE-1' };
  },
  listFiles: async ({ peer_cid, before_seq, limit }) => {
    assert.deepEqual({ peer_cid, before_seq, limit }, { peer_cid: 'CID-PEER', before_seq: undefined, limit: 200 });
    return {
      items: [
        { seq: 12, wire_id: 'F2', direction: 'in', peer: { id: 'CID-PEER', name: 'Peer' }, from: { id: 'CID-PEER', name: 'Peer' }, filename: 'Photo.PNG', mime: 'image/png', byte_length: 2, sha256: 'B', date: 'D12', kind: 'file', inbox_state: 'unread', reply_to: null },
        { seq: 10, wire_id: 'F1', direction: 'out', peer: { id: 'CID-PEER', name: 'Peer' }, from: { id: 'CID-MESSENGER', name: 'Messenger' }, filename: 'photo.png', mime: 'image/png', byte_length: 1, sha256: 'A', date: 'D10', kind: 'file', inbox_state: 'read', reply_to: null },
      ],
      next_cursor: null,
    };
  },
  getFileInfo: async ({ wire_id }) => wire_id === 'F2'
    ? { wire_id: 'F2', direction: 'in', inbox_state: 'unread', filename: 'Photo.PNG', mime: 'image/png' }
    : null,
  fetchFile: async () => { throw new Error('unread bytes must not be exposed'); },
};
const deps = {
  runtime: { client: historyClient, described: { ownership: 'shared-daemon' } },
  push: { publicConfig: {}, bindingCount: 0, queueStats: () => ({}), ensure() {}, delete() {} },
  config: CONFIG, buildInfo: BUILD, watcherStats: () => ({}), events: new MessengerEventBus(),
  identityCid: 'CID-MESSENGER',
};

async function request(method, url, body, activeDeps = deps) {
  const res = await rawRequest(method, url, body, activeDeps);
  assert.equal(res.statusCode, 200, Buffer.concat(res.chunks).toString('utf8'));
  return res.json();
}

async function rawRequest(method, url, body, activeDeps = deps) {
  const req = new Request(method, url, body);
  const res = new Response();
  await serveApi(req, res, activeDeps);
  return res;
}

const page = await request('GET', '/api/conversations/Peer/page?limit=2');
assert.equal(page.total, 8);
assert.equal(page.unread, 3);
assert.equal(page.nextBefore, '7');
assert.deepEqual(page.messages.map((row) => row.wire_id), ['W7', 'W8'], 'daemon newest-first history is projected to browser chronological order');

const older = await request('GET', '/api/conversations/Peer/page?limit=2&before=7');
assert.deepEqual(older.messages.map((row) => row.wire_id), ['W6']);
assert.equal(older.preview, 'new', 'an older page retains the newest whole-dialog preview');

const marked = await request('POST', '/api/conversations/Peer/read', {});
assert.equal(marked.marked, 2);
assert.deepEqual(reads, [{ wire_ids: ['A1', 'A2'] }], 'reading Peer never consumes unread messages from another identity contact');

const catalog = await request('GET', '/api/contacts/Peer/commands');
assert.equal(catalog.recipient_cid, 'CID-PEER');
assert.match(catalog.fingerprint, /^[A-Za-z0-9_-]{43}$/);
assert.deepEqual(catalog.commands.map((entry) => entry.name), ['notes.create']);
const commandSend = await request('POST', '/api/commands/send', {
  contact: 'CID-PEER', recipient_cid: 'CID-PEER', command: 'notes.create', arguments: { '': '' },
  invocation_id: '73ee164e-1cf9-41e8-8409-f3775591beef',
  catalog_fingerprint: catalog.fingerprint, confirmed: true,
});
assert.equal(commandSend.invocation_id, '73ee164e-1cf9-41e8-8409-f3775591beef');
assert.equal(commandSend.recipient_cid, 'CID-PEER');
assert.equal(commandSend.catalog_fingerprint, catalog.fingerprint);
assert.equal(commandSend.command, 'notes.create');
assert.equal(commandSend.wire_id, 'CMD-WIRE-1');
assert.equal(commandSend.delivery, 'e2e');
assert.equal(commandSend.status, 'accepted');
assert.equal(commandSend.deduplicated, false);
assert.deepEqual(commandsSent, [{ contact: 'CID-PEER', command: 'notes.create', arguments: { '': '' } }],
  'typed send revalidates the CID-bound catalog and preserves empty-string keys');

const replay = await request('POST', '/api/commands/send', {
  contact: 'CID-PEER', recipient_cid: 'CID-PEER', command: 'notes.create', arguments: { '': '' },
  invocation_id: '73ee164e-1cf9-41e8-8409-f3775591beef',
  catalog_fingerprint: catalog.fingerprint, confirmed: true,
});
assert.equal(replay.deduplicated, true);
assert.equal(replay.wire_id, 'CMD-WIRE-1');
assert.equal(commandsSent.length, 1, 'same invocation and payload is never sent twice');

advertisedCommands = [];
const replayAfterRestartAndRemoval = await request('POST', '/api/commands/send', {
  contact: 'CID-PEER', recipient_cid: 'CID-PEER', command: 'notes.create', arguments: { '': '' },
  invocation_id: '73ee164e-1cf9-41e8-8409-f3775591beef',
  catalog_fingerprint: catalog.fingerprint, confirmed: true,
}, { ...deps });
assert.equal(replayAfterRestartAndRemoval.deduplicated, true);
assert.equal(replayAfterRestartAndRemoval.wire_id, 'CMD-WIRE-1');
assert.equal(commandsSent.length, 1,
  'restart replay returns the durable accepted outcome even after the command is removed from the live catalog');
advertisedCommands = [{
  name: 'notes.create', description: 'Create a note',
  input_schema: { type: 'object', required: [''], properties: { '': { type: 'string' } } },
}];

const wrongRecipient = await rawRequest('POST', '/api/commands/send', {
  contact: 'CID-PEER', recipient_cid: 'CID-OTHER', command: 'notes.create', arguments: { '': '' },
  invocation_id: 'c0a03738-4233-4cd6-b12c-5a2339486240',
  catalog_fingerprint: catalog.fingerprint, confirmed: true,
});
assert.equal(wrongRecipient.statusCode, 409, 'recipient CID is revalidated at the final send boundary');

for (const invalidArguments of [undefined, { tooLarge: 'x'.repeat(65_537) },
  { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } }]) {
  const invalid = await rawRequest('POST', '/api/commands/send', {
    contact: 'CID-PEER', recipient_cid: 'CID-PEER', command: 'notes.create', arguments: invalidArguments,
    invocation_id: crypto.randomUUID(), catalog_fingerprint: catalog.fingerprint, confirmed: true,
  });
  assert.equal(invalid.statusCode, 400, 'missing, oversized, and over-deep arguments are client errors');
}

const files = await request('GET', '/api/conversations/Peer/files');
assert.deepEqual(files.files.map((row) => ({ wire_id: row.wire_id, version: row.version, available: row.available })), [
  { wire_id: 'F1', version: 1, available: true },
  { wire_id: 'F2', version: 2, available: false },
], 'daemon file history preserves logical versions while unread inbound bytes remain explicitly gated');

const mediaReq = new Request('GET', '/api/media/F2');
const mediaRes = new Response();
await serveApi(mediaReq, mediaRes, deps);
assert.equal(mediaRes.statusCode, 409, 'an unread inbound file cannot bypass the explicit fetch route');

rmSync(commandStateDir, { recursive: true, force: true });

console.log('shared-daemon-contract OK — one daemon, one identity lease, external history schema, selective read');
