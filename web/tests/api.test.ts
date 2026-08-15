import assert from 'node:assert/strict';
import { ApiError, createApi, type Fetcher } from '../src/api.js';

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const fetcher: Fetcher = async (input, init) => {
  calls.push({ input, init });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const client = createApi(fetcher);
await client.contacts();
assert.equal(calls[0].input, '/api/contacts');
assert.equal(calls[0].init?.cache, 'no-store', 'REST snapshots opt out of browser HTTP caching');
assert.equal(calls[0].init?.credentials, 'same-origin', 'REST stays same-origin');

await client.send('CONTACT/A', 'hello', 'WIRE-1');
const mutation = calls[1].init!;
assert.equal(mutation.method, 'POST');
assert.deepEqual(mutation.headers, {
  'content-type': 'application/json',
  'X-Ours-Messenger-CSRF': '1',
}, 'mutations carry the JSON and fixed CSRF intent gates');
assert.deepEqual(JSON.parse(String(mutation.body)), {
  contact: 'CONTACT/A', text: 'hello', reply_to_wire_id: 'WIRE-1',
});

const rejected = createApi(async () => new Response(
  JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'text must be a non-empty string' } }),
  { status: 400 },
));
await assert.rejects(() => rejected.send('A', ''), (error: unknown) =>
  error instanceof ApiError && error.status === 400 && error.message === 'text must be a non-empty string');

console.log('api-client OK — no-store REST, same-origin credentials, and mutation intent headers');
