import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MAX_INLINE_FILE_BYTES, serveApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { MessengerEventBus } from '../src/events.ts';

const PUBLIC_ORIGIN = 'https://messenger.example';
const BUILD = {
  name: '@ours.network/messenger-server',
  version: '0.1.0',
  sha: '3fb10cc41af69e1a15cb99eab1c1b408ec245de0',
  dirty: false,
};

class FakeRequest extends EventEmitter {
  constructor({ method = 'GET', url = '/', headers = {}, rawHeaders, body = '' } = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.rawHeaders = rawHeaders ?? Object.entries(headers).flatMap(([key, value]) => [key, String(value)]);
    this.body = body;
    this.bodyRead = false;
  }
  async *[Symbol.asyncIterator]() {
    this.bodyRead = true;
    if (this.body) yield Buffer.from(this.body);
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers = {};
  chunks = [];
  destroyed = false;
  writableEnded = false;
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.writableEnded = true; return this; }
  json() { const wire = this.chunks.join(''); return wire ? JSON.parse(wire) : null; }
}

const mutationHeaders = {
  'Content-Type': 'Application/JSON; charset=utf-8',
  Origin: PUBLIC_ORIGIN,
  'X-Ours-Messenger-CSRF': '1',
};

function makeDeps(client = {}) {
  return {
    runtime: {
      client,
      described: {
        ownership: 'shared-daemon',
        application: '@ours.network/messenger-server@0.1.0',
        host: '127.0.0.1',
        daemonVersion: '3.0.2',
        daemonCompat: '3',
        apiVisibility: 'daemon-configured',
        mcp: false,
      },
    },
    push: {
      publicConfig: { publicKey: 'public', fingerprint: 'public-fingerprint', configEpoch: 1 },
      bindingCount: 0,
      queueStats: () => ({ pending: 0, sent: 0, dropped: 0, depth: 0 }),
      ensure: () => ({}),
      delete: () => false,
    },
    config: {
      host: '127.0.0.1', port: 0, identity: 'Me', force: false,
      stateDir: '/tmp/DO-NOT-EXPOSE',
      publicOrigin: PUBLIC_ORIGIN,
    },
    buildInfo: BUILD,
    watcherStats: () => ({ pushes: 1, events: 2, reconnects: 0 }),
    events: new MessengerEventBus(),
    identityCid: 'BOUND-CID',
    healthTimeoutMs: 5,
  };
}

async function call(deps, { method = 'GET', url = '/', headers = {}, rawHeaders, body } = {}) {
  const request = new FakeRequest({ method, url, headers, rawHeaders, body });
  const response = new FakeResponse();
  await serveApi(request, response, deps);
  return { request, response, status: response.statusCode, json: response.json(), wire: response.chunks.join('') };
}

// Configuration must provide one explicit serialized public origin. It may not
// be inferred from Host or forwarding headers.
assert.throws(() => loadConfig({ OURS_MESSENGER_IDENTITY: 'Me' }), /OURS_MESSENGER_PUBLIC_ORIGIN/);
assert.throws(() => loadConfig({
  OURS_MESSENGER_IDENTITY: 'Me',
  OURS_MESSENGER_PUBLIC_ORIGIN: 'https://messenger.example/path',
}), /OURS_MESSENGER_PUBLIC_ORIGIN/);
assert.equal(loadConfig({
  OURS_MESSENGER_IDENTITY: 'Me',
  OURS_MESSENGER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
}).publicOrigin, PUBLIC_ORIGIN);

// Every mutation is gated before body iteration and handler invocation.
let sends = 0;
const sendDeps = makeDeps({ sendMessage: async () => { sends++; return { sent: true, wireId: 'WIRE-SECURITY-1' }; } });
const good = await call(sendDeps, {
  method: 'POST', url: '/api/messages/send', headers: mutationHeaders,
  body: JSON.stringify({ contact: 'Peer', text: 'hello' }),
});
assert.equal(good.status, 200);
assert.equal(sends, 1);

const rejected = [
  ['sibling origin', { ...mutationHeaders, Origin: 'https://sibling.example' }, undefined, 403],
  ['null origin', { ...mutationHeaders, Origin: 'null' }, undefined, 403],
  ['absent origin', { 'Content-Type': 'application/json', 'X-Ours-Messenger-CSRF': '1' }, undefined, 403],
  ['duplicate origin', mutationHeaders, [
    'Content-Type', 'application/json',
    'Origin', PUBLIC_ORIGIN,
    'Origin', PUBLIC_ORIGIN,
    'X-Ours-Messenger-CSRF', '1',
  ], 403],
  ['wrong content type', { ...mutationHeaders, 'Content-Type': 'text/plain' }, undefined, 415],
  ['missing CSRF header', { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN }, undefined, 403],
];
for (const [name, headers, rawHeaders, status] of rejected) {
  const result = await call(sendDeps, {
    method: 'POST', url: '/api/messages/send', headers, rawHeaders,
    body: JSON.stringify({ contact: 'Peer', text: `must not run: ${name}` }),
  });
  assert.equal(result.status, status, name);
  assert.equal(result.request.bodyRead, false, `${name} rejected before reading body`);
  assert.ok(!result.wire.includes(String(headers.Origin ?? 'absent')), `${name} is not reflected`);
}
assert.equal(sends, 1, 'rejected mutations never invoke the SDK');

const preflight = await call(sendDeps, { method: 'OPTIONS', url: '/api/messages/send', headers: {
  Origin: PUBLIC_ORIGIN,
  'Access-Control-Request-Method': 'POST',
} });
assert.notEqual(preflight.status, 200);
assert.equal(preflight.response.headers['access-control-allow-origin'], undefined);
assert.equal(sends, 1, 'preflight never invokes a handler');

// Browser file send rejects the key itself, never forwarding its value. Inline
// bytes are required, validated, and capped by decoded size before the SDK call.
const SENTINEL_PATH = '/tmp/SECRET-SENTINEL-HOST-PATH';
const fileCalls = [];
const fileDeps = makeDeps({ sendFile: async (args) => { fileCalls.push(args); return { sent: true }; } });
const originalWarn = console.warn;
const originalError = console.error;
const captured = [];
console.warn = (...args) => captured.push(args.join(' '));
console.error = (...args) => captured.push(args.join(' '));
try {
  const pathAttempt = await call(fileDeps, {
    method: 'POST', url: '/api/messages/send-file', headers: mutationHeaders,
    body: JSON.stringify({ contact: 'Peer', path: SENTINEL_PATH, data_base64: 'QQ==' }),
  });
  assert.equal(pathAttempt.status, 400);
  assert.equal(fileCalls.length, 0);
  assert.ok(!pathAttempt.wire.includes(SENTINEL_PATH));
  assert.ok(!captured.join('\n').includes(SENTINEL_PATH));

  const boundary = Buffer.alloc(MAX_INLINE_FILE_BYTES).toString('base64');
  const allowed = await call(fileDeps, {
    method: 'POST', url: '/api/messages/send-file', headers: mutationHeaders,
    body: JSON.stringify({ contact: 'Peer', data_base64: boundary, filename: 'boundary.bin' }),
  });
  assert.equal(allowed.status, 200, allowed.wire);
  assert.equal(fileCalls.length, 1);
  assert.equal(Object.hasOwn(fileCalls[0], 'path'), false);

  const oversized = Buffer.alloc(MAX_INLINE_FILE_BYTES + 1).toString('base64');
  const denied = await call(fileDeps, {
    method: 'POST', url: '/api/messages/send-file', headers: mutationHeaders,
    body: JSON.stringify({ contact: 'Peer', data_base64: oversized, filename: 'too-big.bin' }),
  });
  assert.equal(denied.status, 413);
  assert.equal(fileCalls.length, 1, 'oversized decoded bytes fail before the SDK');
} finally {
  console.warn = originalWarn;
  console.error = originalError;
}

// Readiness proves both a shared-daemon response and the startup-bound CID.
const healthy = await call(makeDeps({ currentIdentity: async () => ({ cid: 'BOUND-CID', name: 'Me' }) }), {
  url: '/api/healthz',
});
assert.equal(healthy.status, 200);
assert.deepEqual(healthy.json, {
  status: 'ok', version: BUILD.version, sha: BUILD.sha, identityCid: 'BOUND-CID',
});

const HEALTH_SECRET = 'TOKEN-health-secret-/private/path?query=secret';
const unhealthyBodies = [];
for (const client of [
  { currentIdentity: async () => ({ cid: 'DIFFERENT-CID' }) },
  { currentIdentity: async () => new Promise(() => {}) },
  { currentIdentity: async () => { throw new Error(HEALTH_SECRET); } },
]) {
  const result = await call(makeDeps(client), { url: '/api/healthz' });
  assert.equal(result.status, 503);
  assert.ok(!result.wire.includes(HEALTH_SECRET));
  assert.ok(!/stateDir|broker|port|error|DIFFERENT/.test(result.wire));
  unhealthyBodies.push(result.json);
}
assert.deepEqual(unhealthyBodies[0], unhealthyBodies[1]);
assert.deepEqual(unhealthyBodies[1], unhealthyBodies[2]);

// State and error responses expose only explicit public projections.
const leakyClient = {
  currentIdentity: async () => ({ cid: 'BOUND-CID', name: 'Me', bio: 'Public bio', persona: HEALTH_SECRET, stateDir: '/private' }),
  version: async () => ({ brokerUrl: HEALTH_SECRET, internalPort: 49152 }),
};
const profile = await call(makeDeps(leakyClient), { url: '/api/identity' });
assert.equal(profile.status, 200);
assert.deepEqual(profile.json, { cid: 'BOUND-CID', name: 'Me', bio: 'Public bio' });
assert.ok(!profile.wire.includes(HEALTH_SECRET) && !profile.wire.includes('/private'), '/api/identity projects only public profile fields');
const state = await call(makeDeps(leakyClient), { url: '/api/state' });
assert.equal(state.status, 200);
assert.deepEqual(state.json.identity, { cid: 'BOUND-CID', name: 'Me', bio: 'Public bio' });
assert.equal(state.json.runtime.ownership, 'shared-daemon');
for (const forbidden of [HEALTH_SECRET, '/private', 'stateDir', 'brokerUrl', 'internalPort', 'selection', 'tokenSource']) {
  assert.ok(!state.wire.includes(forbidden), `/api/state redacts ${forbidden}`);
}

const fetched = await call(makeDeps({
  listIncomingFiles: async () => [{ wire_id: 'WIRE' }],
  getFiles: async () => ({
  mode: 'selected', requested: ['WIRE'], text: `saved at ${SENTINEL_PATH}`,
  files: [{
    file_id: 7, wire_id: 'WIRE', from: { id: 'PEER', name: 'Peer' }, filename: 'safe.bin',
    path: SENTINEL_PATH, mime: 'application/octet-stream', size: 1, sha256: 'HASH',
    status: 'processed', date: 'DATE', kind: 'file', sender: `from ${SENTINEL_PATH}`,
  }],
  }),
}), {
  method: 'POST', url: '/api/files/fetch', headers: mutationHeaders,
  body: JSON.stringify({ wire_ids: ['WIRE'] }),
});
assert.equal(fetched.status, 200);
assert.equal(fetched.json.files[0].filename, 'safe.bin');
assert.ok(!fetched.wire.includes(SENTINEL_PATH));
assert.equal(fetched.json.files[0].path, undefined);
assert.equal(fetched.json.text, undefined);

const internalLogs = [];
console.warn = (...args) => internalLogs.push(args.join(' '));
let internal;
try {
  internal = await call(makeDeps({ sendMessage: async () => { throw new Error(HEALTH_SECRET); } }), {
    method: 'POST', url: '/api/messages/send', headers: mutationHeaders,
    body: JSON.stringify({ contact: 'Peer', text: 'hello' }),
  });
} finally {
  console.warn = originalWarn;
}
assert.equal(internal.status, 500);
assert.equal(internal.json.error.code, 'INTERNAL');
assert.equal(internal.json.error.message, 'Internal server error');
assert.match(internal.json.error.correlationId, /^[0-9a-f-]{36}$/);
assert.ok(!internal.wire.includes(HEALTH_SECRET));
assert.ok(internalLogs.some((line) => line.includes(internal.json.error.correlationId)));
assert.ok(!internalLogs.join('\n').includes(HEALTH_SECRET));

console.log('production-security OK — mutation intent, inline files, readiness, redaction, minimized state');
