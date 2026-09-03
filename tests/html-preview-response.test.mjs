import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveApi } from '../src/api.ts';
import { MAX_HTML_PREVIEW_BYTES, transformHtmlPreview } from '../src/html-preview-transform.ts';
import { HTML_PREVIEW_CSP } from '../web/src/ui/htmlPreviewCore.mjs';
import { MessengerEventBus } from '../src/events.ts';

class Request extends EventEmitter {
  constructor(method, url) { super(); this.method = method; this.url = url; this.headers = {}; this.rawHeaders = []; }
  async *[Symbol.asyncIterator]() {}
}
class Response extends EventEmitter {
  chunks = []; destroyed = false; writableEnded = false;
  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; }
  write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.writableEnded = true; }
  body() { return Buffer.concat(this.chunks); }
}
const baseDeps = (client) => ({
  runtime: { client, described: { ownership: 'shared-daemon' } },
  push: { publicConfig: {}, bindingCount: 0, queueStats: () => ({}), ensure() {}, delete() {} },
  config: { publicOrigin: 'https://messenger.example', identity: 'Me' }, buildInfo: {},
  watcherStats: () => ({}), events: new MessengerEventBus(), identityCid: 'ME',
});
const call = async (client, url, method = 'GET') => {
  const response = new Response(); await serveApi(new Request(method, url), response, baseDeps(client)); return response;
};
const record = (overrides = {}) => ({
  wire_id: 'WIRE/✓', direction: 'in', inbox_state: 'read', filename: 'Документ\r\nX-Evil: yes.html',
  mime: 'text/plain', byte_length: bytes.byteLength, ...overrides,
});
const bytes = Buffer.from('<!doctype html><style>body{color:red}</style><p>Привет</p>', 'utf8');

let fetches = 0;
for (const [label, info, status] of [
  ['missing', null, 404],
  ['unread', record({ inbox_state: 'unread' }), 409],
  ['non HTML', record({ filename: 'report.txt', mime: 'text/html' }), 415],
]) {
  fetches = 0;
  const response = await call({ getFileInfo: async () => info, fetchFile: async () => { fetches++; return bytes; } }, '/api/html-preview/WIRE');
  assert.equal(response.statusCode, status, label);
  assert.equal(fetches, 0, `${label} never fetches bytes`);
}
fetches = 0;
const tooLarge = await call({ getFileInfo: async () => record({ byte_length: MAX_HTML_PREVIEW_BYTES + 1 }), fetchFile: async () => { fetches++; return bytes; } }, '/api/html-preview/WIRE');
assert.equal(tooLarge.statusCode, 413); assert.equal(fetches, 0, 'truthful oversize metadata prevents fetch');
for (const byte_length of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  fetches = 0;
  const malformed = await call({ getFileInfo: async () => record({ byte_length }), fetchFile: async () => { fetches++; return bytes; } }, '/api/html-preview/WIRE');
  assert.equal(malformed.statusCode, 400, `malformed byte_length ${String(byte_length)} fails closed`);
  assert.equal(fetches, 0, 'malformed metadata prevents fetch');
}
const deceptive = await call({ getFileInfo: async () => record({ byte_length: 1 }), fetchFile: async () => Buffer.alloc(MAX_HTML_PREVIEW_BYTES + 1) }, '/api/html-preview/WIRE');
assert.equal(deceptive.statusCode, 413, 'actual bytes are rechecked before decode/parse');

fetches = 0;
const goodClient = { getFileInfo: async ({ wire_id }) => { assert.equal(wire_id, 'WIRE/✓'); return record(); }, fetchFile: async (id) => { fetches++; assert.equal(id, 'WIRE/✓'); return bytes; } };
const response = await call(goodClient, '/api/html-preview/WIRE%2F%E2%9C%93?ignored=1');
assert.equal(response.statusCode, 200);
assert.equal(fetches, 1);
assert.deepEqual(response.body(), transformHtmlPreview(bytes), 'response is the deterministic transformed document');
assert.match(response.body().toString(), /Привет/, 'non-ASCII content survives UTF-8 transform');
assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
assert.equal(response.headers['content-length'], String(response.body().byteLength));
assert.equal(response.headers['cache-control'], 'private, no-store');
assert.equal(response.headers['x-content-type-options'], 'nosniff');
assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
assert.equal(response.headers['referrer-policy'], 'no-referrer');
assert.equal(response.headers['x-ours-html-preview'], 'transformed');
assert.equal(response.headers['content-disposition'].includes('\r'), false);
assert.equal(response.headers['content-disposition'].includes('\n'), false);
assert.match(response.headers['content-disposition'], /^inline; filename\*=UTF-8''/);

const parsed = new Map();
for (const raw of response.headers['content-security-policy'].split(';')) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean); const name = tokens.shift();
  assert.ok(name && !parsed.has(name), `response CSP directive ${name} is unique`); parsed.set(name, tokens);
}
const inner = new Map(HTML_PREVIEW_CSP.split(';').map((raw) => { const tokens = raw.trim().split(/\s+/); return [tokens.shift(), tokens]; }));
assert.deepEqual(new Map([...parsed].filter(([name]) => inner.has(name))), inner);
assert.deepEqual(parsed.get('sandbox'), [], 'response CSP sandbox has zero capabilities');
assert.deepEqual(parsed.get('frame-ancestors'), ["'self'"]);

assert.equal((await call(goodClient, '/api/html-preview/WIRE%2F%E2%9C%93', 'HEAD')).statusCode, 404, 'HEAD is fail-closed');
const secret = 'SECRET-/private/path'; const originalWarn = console.warn; console.warn = () => {};
let failed; try { failed = await call({ getFileInfo: async () => record(), fetchFile: async () => { throw new Error(secret); } }, '/api/html-preview/WIRE'); } finally { console.warn = originalWarn; }
assert.equal(failed.statusCode, 500); assert.equal(failed.body().includes(secret), false, 'fetch errors are redacted');

console.log('html-preview response OK — explicit authorization, exact transformed headers/CSP, bounded fail-closed errors');
