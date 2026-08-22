// A first send through a registrar-verified local introduction must be delivered
// and create the edge. Current shared-daemon history can track that send from the
// outset; the separate introduction-send-guard unit contract retains coverage of
// peers that report the legacy delivered-without-wire-id `introduced` outcome.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.ts';
import { counter, memSample, startHarnessDaemon, until } from './harness.mjs';

const t = counter();
memSample('before');

const daemon = await startHarnessDaemon('introsend');
const messengerState = mkdtempSync(join(tmpdir(), 'messenger-introsend-app-'));
let server;
let peer;
try {
  const { OursClient } = daemon.sdk;
  const provision = new OursClient({ url: daemon.url, leaseToken: 'provision' });
  const human = await provision.createRootIdentity({
    name: 'Me', bio: 'messenger identity', exposeLocal: true,
    localAutoAccept: true, skipIfRootExists: false,
  });
  await provision.releaseLease();

  peer = new OursClient({ url: daemon.url, leaseToken: 'peer' });
  await peer.createTemporaryIdentity({
    name: 'Peer', bio: 'the other end', exposeLocal: true, localAutoAccept: true,
  });

  const publicOrigin = 'http://messenger.test';
  server = await start({
    host: '127.0.0.1', port: 0, publicOrigin, identity: 'Me', force: false,
    stateDir: messengerState,
  }, {
    name: '@ours.network/messenger-server', version: '0.1.0',
    sha: 'introduction-send-test', dirty: false,
  });

  const base = `http://127.0.0.1:${server.port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: method === 'GET' ? {} : {
        'content-type': 'application/json', origin: publicOrigin,
        'x-ours-messenger-csrf': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  t.eq((await api('GET', '/api/contacts')).json.contacts, [],
    'no contact edge exists before the first send');

  const introText = 'the first message, carried by the introduction';
  const introduced = await api('POST', '/api/messages/send', { contact: 'Peer', text: introText });
  t.eq(introduced.status, 200, 'an introduction-carried send answers 200');
  t.eq(introduced.json.delivery, 'tracked', 'and reports the current tracked introduction outcome');
  t.ok(typeof introduced.json.wire_id === 'string' && introduced.json.wire_id.length > 0,
    'with the canonical history wire id');

  const landed = await until('the introduction-carried message to reach Peer', async () => {
    const history = await peer.listHistory({ peer_cid: human.info.cid, limit: 10 });
    return history.items.find((message) => message.text === introText) ?? undefined;
  });
  t.ok(landed, 'the peer actually received the message');
  t.eq(landed.wire_id, introduced.json.wire_id, 'and both histories agree on the wire id');

  await until('the contact edge created by the introduction', async () => {
    const contacts = (await api('GET', '/api/contacts')).json.contacts;
    return contacts.some((contact) => contact.name === 'Peer') ? contacts : undefined;
  });
  t.ok(true, 'the introduction created the contact edge');

  const trackedText = 'the second message, over the established edge';
  const tracked = await api('POST', '/api/messages/send', { contact: 'Peer', text: trackedText });
  t.eq(tracked.status, 200, 'the ordinary send still answers 200');
  t.eq(tracked.json.delivery, 'tracked', 'and reports tracked delivery');
  t.ok(typeof tracked.json.wire_id === 'string' && tracked.json.wire_id.length > 0,
    'with the canonical wire id');

  await until('the tracked message to acquire a delivered receipt', async () => {
    const row = await server.runtime.client.getHistoryItem({ wire_id: tracked.json.wire_id });
    return row?.delivery_state === 'delivered' ? row : undefined;
  });
  t.ok(true, 'the tracked send acquires a delivered receipt');
} finally {
  await server?.close();
  await peer?.releaseLease();
  await daemon.close();
  rmSync(messengerState, { recursive: true, force: true });
}

memSample('after');
console.log(`\nintroduction-send OK (${t.count} checks) — registrar introduction creates a tracked edge and receipts`);
process.exit(0);
