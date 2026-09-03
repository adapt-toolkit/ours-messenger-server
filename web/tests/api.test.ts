import assert from 'node:assert/strict';
import { ApiError, createApi, type Fetcher } from '../src/api.js';

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const fetcher: Fetcher = async (input, init) => {
  calls.push({ input, init });
  return new Response(JSON.stringify({ wire_id: 'WIRE-SENT', ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
const client = createApi(fetcher);
await client.contacts();
assert.equal(calls[0].input, '/api/contacts');
assert.equal(calls[0].init?.cache, 'no-store', 'REST snapshots opt out of browser HTTP caching');
assert.equal(calls[0].init?.credentials, 'same-origin', 'REST stays same-origin');

const sendController = new AbortController();
const sendResult = await client.send('CONTACT/A', 'hello', 'WIRE-1', sendController.signal);
assert.equal(sendResult.wire_id, 'WIRE-SENT', 'send exposes the stable wire id for history convergence');
const mutation = calls[1].init!;
assert.equal(mutation.method, 'POST');
assert.equal(mutation.signal, sendController.signal, 'text sends accept a bounded UI abort signal');
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

await client.ensurePush({
  endpoint: 'https://push.example/device', keys: { p256dh: 'P', auth: 'A' }, label: 'browser', preview: 'private',
});
assert.equal(calls[4].input, '/api/push/subscriptions/ensure');
assert.deepEqual(JSON.parse(String(calls[4].init?.body)), {
  endpoint: 'https://push.example/device', keys: { p256dh: 'P', auth: 'A' }, label: 'browser', preview: 'private',
});

await client.deletePush('opaque-binding');
assert.equal(calls[5].input, '/api/push/subscriptions/delete');
assert.deepEqual(JSON.parse(String(calls[5].init?.body)), { binding_id: 'opaque-binding' });

await client.renameContact('CONTACT/A', 'Alice');
assert.equal(calls[6].input, '/api/contacts/rename');
assert.deepEqual(JSON.parse(String(calls[6].init?.body)), { contact: 'CONTACT/A', name: 'Alice' });
await client.removeContact('CONTACT/A');
assert.equal(calls[7].input, '/api/contacts/remove');
assert.deepEqual(JSON.parse(String(calls[7].init?.body)), { contact: 'CONTACT/A' });

await client.conversation('CONTACT/A', 'WIRE/51');
assert.equal(
  calls[8].input,
  '/api/conversations/CONTACT%2FA/page?limit=50&before=WIRE%2F51',
  'older history uses the server cursor and encodes both identifiers',
);

await client.setBio('Secure messenger profile');
assert.equal(calls.at(-1)?.input, '/api/identity/bio');
assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { bio: 'Secure messenger profile' });

await client.createInvite('public', 'Community link');
assert.equal(calls.at(-1)?.input, '/api/invites');
assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { mode: 'public', name: 'Community link' });

await client.buildInfo();
assert.equal(calls.at(-1)?.input, '/api/build-info');

const commandController = new AbortController();
await client.commands('CONTACT/A', commandController.signal);
assert.equal(calls.at(-1)?.input, '/api/contacts/CONTACT%2FA/commands');
assert.equal(calls.at(-1)?.init?.signal, commandController.signal);

await client.sendCommand(
  'CONTACT/A', 'notes.create', { '': '', nested: [null, true, 0] },
  '73ee164e-1cf9-41e8-8409-f3775591beef', 'A'.repeat(43), commandController.signal,
);
assert.equal(calls.at(-1)?.input, '/api/commands/send');
assert.equal(calls.at(-1)?.init?.signal, commandController.signal);
assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), {
  contact: 'CONTACT/A', recipient_cid: 'CONTACT/A', command: 'notes.create',
  arguments: { '': '', nested: [null, true, 0] },
  invocation_id: '73ee164e-1cf9-41e8-8409-f3775591beef',
  catalog_fingerprint: 'A'.repeat(43), confirmed: true,
}, 'typed send binds the confirmed JSON payload and catalog to the recipient CID');

const rejected = createApi(async () => new Response(
  JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'text must be a non-empty string' } }),
  { status: 400 },
));
await assert.rejects(() => rejected.send('A', ''), (error: unknown) =>
  error instanceof ApiError && error.status === 400 && error.message === 'text must be a non-empty string');

console.log('api-client OK — no-store REST, same-origin credentials, and mutation intent headers');
