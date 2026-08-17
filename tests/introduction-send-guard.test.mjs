// The narrowed guard, driven directly against `serveApi` with a stub client.
//
// `POST /api/messages/send` used to throw on ANY outcome without a wire id. That
// guard was right about every outcome except one: `introduced`, which is a
// delivered message that legitimately has no id. Narrowing it is only safe if the
// guard still fires for the others — an `e2e` send that came back without a wire
// id is a genuine fault and must not be reported to the user as a success.
//
// A stub client is used deliberately: these outcome shapes are what the SDK
// returns, and reaching them all through a live daemon would mean provoking
// migration and downgrade states that have nothing to do with this route.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { counter } from './harness.mjs';
import { serveApi } from '../src/api.ts';

const t = counter();

let outcome = null;
const deps = {
  runtime: { client: { sendMessage: async () => outcome } },
  push: {},
  config: { identity: 'Me', publicOrigin: 'http://messenger.test' },
  buildInfo: { name: 'test', version: '0', sha: 'test', dirty: false },
  watcherStats: () => ({}),
  events: { subscribe: () => ({ next: async () => null, close: () => {} }) },
  identityCid: 'CID-ME',
};

const server = createServer((req, res) => { void serveApi(req, res, deps); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const send = async () => {
  const res = await fetch(`${base}/api/messages/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://messenger.test',
      'x-ours-messenger-csrf': '1',
    },
    body: JSON.stringify({ contact: 'Peer', text: 'hello' }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

// ---- the one outcome that legitimately has no wire id ----------------------
outcome = { kind: 'introduced', text: '"Peer" was not a contact yet — connected and delivered the message.' };
const introduced = await send();
t.eq(introduced.status, 200, 'kind "introduced" with no wire id answers 200');
t.eq(introduced.json, { wire_id: null, delivery: 'introduced' }, 'and reports wire_id null, delivery introduced');

// ---- every other outcome without one is still a fault ----------------------
for (const kind of ['e2e', 'sent', 'deferred', 'migrating', 'refused']) {
  outcome = { kind, wireId: '' };
  const broken = await send();
  t.eq(broken.status, 500, `kind "${kind}" with no wire id is still an error, not a silent success`);
  assert.ok(
    !JSON.stringify(broken.json).includes('introduced'),
    `and is not reported as an introduction — kind "${kind}" promised a tracked send`,
  );
}

// ---- and the ordinary outcome is unchanged ---------------------------------
outcome = { kind: 'e2e', wireId: 'WIRE-1', cid: 'CID-PEER', notRetained: false };
const tracked = await send();
t.eq(tracked.status, 200, 'an ordinary e2e send answers 200');
t.eq(tracked.json, { wire_id: 'WIRE-1', delivery: 'tracked' }, 'and reports its wire id with delivery tracked');

server.close();
console.log(`\nintroduction-send-guard OK (${t.count} checks) — the missing-wire-id guard is narrowed to "introduced" only`);
process.exit(0);
