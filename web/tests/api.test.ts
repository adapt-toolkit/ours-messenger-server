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

await client.sendFile('CONTACT/A', new Blob([Uint8Array.from([0, 1, 2, 255])]), 'photo.png', 'image/png', 'WIRE-1');
const fileMutation = calls[2].init!;
assert.deepEqual(JSON.parse(String(fileMutation.body)), {
  contact: 'CONTACT/A', data_base64: 'AAEC/w==', filename: 'photo.png', mime: 'image/png', reply_to_wire_id: 'WIRE-1',
}, 'browser file bytes use the capped REST upload contract and never enter the DOM');

await client.fetchFiles(['FILE-WIRE']);
assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { wire_ids: ['FILE-WIRE'] });

await client.subscribePush({ endpoint: 'https://push.example/device', keys: { p256dh: 'P', auth: 'A' } }, 'browser');
assert.equal(calls[4].input, '/api/push/subscribe');

await client.renameContact('CONTACT/A', 'Alice');
assert.equal(calls[5].input, '/api/contacts/rename');
assert.deepEqual(JSON.parse(String(calls[5].init?.body)), { contact: 'CONTACT/A', name: 'Alice' });
await client.removeContact('CONTACT/A');
assert.equal(calls[6].input, '/api/contacts/remove');
assert.deepEqual(JSON.parse(String(calls[6].init?.body)), { contact: 'CONTACT/A' });

const rejected = createApi(async () => new Response(
  JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'text must be a non-empty string' } }),
  { status: 400 },
));
await assert.rejects(() => rejected.send('A', ''), (error: unknown) =>
  error instanceof ApiError && error.status === 400 && error.message === 'text must be a non-empty string');

console.log('api-client OK — no-store REST, same-origin credentials, and mutation intent headers');
