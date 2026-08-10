// THE ACCEPTANCE TEST for the read-receipt design — the one the owner personally
// asked us to get right, so that both UXes survive.
//
// THE CONTRACT:
//   list a conversation      -> the peer sees NO read receipt
//   a human marks read       -> the peer sees EXACTLY ONE read receipt
//                               for EXACTLY those wire_ids
//
// AND THE COUNTERFACTUAL IS RUN, not described. Section 5 does the forbidden
// thing — reads the same conversation through `getMessages`, the consuming agent
// path a frontend might reach for — and asserts that the peer THEN sees a read
// receipt with no human having marked anything. That is the hazard this design
// exists to avoid, demonstrated live. If a future edit routes the REST read path
// through getMessages, section 3 goes red and section 5 stops being a
// counterfactual, which is the point of having both.
//
// ONE ASSERTION SHAPE IS DELIBERATELY AVOIDED HERE. "no read receipt" is NOT
// asserted as `receipts == {}`: an empty map is also what a broken conversation,
// a wrong contact name, or an identity with history switched off would return, so
// that assertion would stay green forever while measuring nothing. Section 3
// instead requires the DELIVERED receipts to be PRESENT for exactly the wire_ids
// in play, and only the READ state to be absent. A green there means the receipt
// channel is demonstrably working and read specifically has not fired.

import { counter, memSample, startHarnessDaemon, until } from './harness.mjs';

const t = counter();
memSample('before');

const daemon = await startHarnessDaemon('receipts');
const { OursClient } = daemon.sdk;

// ---- two identities in ONE daemon -------------------------------------------
// BOTH keep history, and that is a precondition rather than a preference:
// receipts only exist for an identity that keeps a conversation. The peer needs
// history to HOLD receipts; the human's side needs it for markRead to have unread
// inbound entries to transition.
const human = new OursClient({ url: daemon.url, leaseToken: 'human-lease' });
const peer = new OursClient({ url: daemon.url, leaseToken: 'peer-lease' });

await human.createIdentity({ name: 'Human', bio: 'the messenger identity', exposeLocal: false, localAutoAccept: true });
await peer.createIdentity({ name: 'Peer', bio: 'the other end', exposeLocal: false, localAutoAccept: true });

await human.setConversationPolicy({ keep_history: true });
await peer.setConversationPolicy({ keep_history: true });
// The capability has to be advertised BEFORE the contact link forms, or the two
// sides settle on caps that do not include receipts and nothing in this test
// would say why.
await human.readvertiseOnUpgrade();
await peer.readvertiseOnUpgrade();

const invite = await human.generateInvite({});
await peer.addContact({ invite: invite.blob });
await until('the contact link to settle', async () => {
  const v = await peer.listContacts();
  return v.contacts.some((c) => c.name === 'Human') ? v : undefined;
});
t.ok(true, 'Peer and Human are contacts in the same daemon');

// ---- 1. the peer sends two messages -----------------------------------------
await peer.sendMessage({ contact: 'Human', text: 'first' });
await peer.sendMessage({ contact: 'Human', text: 'second' });

const arrived = await until('both messages to land in Human\'s conversation', async () => {
  const v = await human.getConversation({ contact: 'Peer' });
  return v.messages.filter((m) => m.dir === 'in').length >= 2 ? v : undefined;
});
t.eq(
  arrived.messages.filter((m) => m.dir === 'in').map((m) => m.text),
  ['first', 'second'],
  'both messages are in Human\'s conversation, oldest first',
);

// The wire_ids as the PEER knows them — its own outbound entries. These are the
// exact ids the read receipts must name.
const sentIds = (await peer.getConversation({ contact: 'Human' })).messages
  .filter((m) => m.dir === 'out')
  .map((m) => m.wire_id);
t.eq(sentIds.length, 2, 'the peer has two outbound entries with wire_ids');
t.ok(sentIds.every((id) => typeof id === 'string' && id.length > 0), 'both wire_ids are non-empty');

// ---- 2. DELIVERED arrives on its own, from the receive choke point ----------
// DELIVERED and READ are two different receipts from two different mechanisms.
// The core emits delivered the moment a message lands; read comes only from
// markRead. One tick versus two ticks in a UI IS this distinction.
const delivered = await until('delivered receipts to reach the peer', async () => {
  const r = await peer.getReceipts({ contact: 'Human' });
  return sentIds.every((id) => r.receipts[id] !== undefined) ? r : undefined;
});
t.ok(
  sentIds.every((id) => delivered.receipts[id] === 'delivered'),
  'DELIVERED fired for both messages without anyone reading anything (one tick)',
);

// ---- 3. THE CENTRAL ASSERTION -----------------------------------------------
// Read the conversation the way the REST surface does: non-consuming, no marking.
// This is `GET /api/conversations/:contact`.
const listed = await human.getConversation({ contact: 'Peer' });
t.ok(listed.messages.length >= 2, 'the non-consuming read returned the conversation');
// …and again through the page projection, since that is what a frontend calls.
const { projectPage } = await import('../src/conversation.ts');
const page = projectPage('Peer', listed.messages, await human.getReceipts({ contact: 'Peer' }), { limit: 50 });
t.eq(page.unread, 2, 'the page reports 2 unread inbound entries — nothing has been marked');

const afterListing = await peer.getReceipts({ contact: 'Human' });
t.ok(
  sentIds.every((id) => afterListing.receipts[id] === 'delivered'),
  'after listing the conversation TWICE the peer still sees delivered — the delivered channel is live',
);
t.ok(
  sentIds.every((id) => afterListing.receipts[id] !== 'read'),
  'AND NO READ RECEIPT: listing a conversation tells the peer nothing about a human having seen it',
);

// ---- 4. the human marks read — exact-once, exactly those ids ----------------
const marked = await human.markRead({ contact: 'Peer' });
t.eq(marked.marked, 2, 'markRead transitioned exactly the 2 unread inbound entries');

const afterRead = await until('read receipts to reach the peer', async () => {
  const r = await peer.getReceipts({ contact: 'Human' });
  return sentIds.every((id) => r.receipts[id] === 'read') ? r : undefined;
});
t.ok(sentIds.every((id) => afterRead.receipts[id] === 'read'), 'the peer now sees READ for both (two ticks)');
t.eq(
  Object.keys(afterRead.receipts).filter((id) => afterRead.receipts[id] === 'read').sort(),
  [...sentIds].sort(),
  'EXACTLY those wire_ids are read — no id the human never saw is marked',
);

// EXACT-ONCE. The transition is the event, not the call.
const twice = await human.markRead({ contact: 'Peer' });
t.eq(twice.marked, 0, 'a second markRead marks 0 and emits nothing — the transition is the event');

const afterTwice = await peer.getReceipts({ contact: 'Human' });
t.eq(afterTwice.receipts, afterRead.receipts, 'and the peer\'s receipt map is unchanged by the second call');

// The page projection now agrees.
const page2 = projectPage(
  'Peer',
  (await human.getConversation({ contact: 'Peer' })).messages,
  await human.getReceipts({ contact: 'Peer' }),
  { limit: 50 },
);
t.eq(page2.unread, 0, 'the page reports 0 unread after the human read them');

// ---- 5. THE COUNTERFACTUAL, ACTUALLY RUN ------------------------------------
// Break the design on purpose and watch the guard's premise hold: `getMessages`
// is the CONSUMING agent path, and reading through it emits a read receipt with
// no human involved. This is why `getMessages` is not on the REST surface.
await peer.sendMessage({ contact: 'Human', text: 'third — nobody will look at this one' });
const third = await until('the third message to land', async () => {
  const v = await peer.getConversation({ contact: 'Human' });
  const out = v.messages.filter((m) => m.dir === 'out');
  return out.length === 3 ? out[2].wire_id : undefined;
});
t.ok(
  (await peer.getReceipts({ contact: 'Human' })).receipts[third] !== 'read',
  'the third message is not read yet',
);

const pulled = await human.getMessages();
t.ok(pulled.count >= 1, 'getMessages consumed the third message (the agent path, unchanged)');

const afterPull = await until('the counterfactual receipt', async () => {
  const r = await peer.getReceipts({ contact: 'Human' });
  return r.receipts[third] === 'read' ? r : undefined;
}, 30_000);
t.eq(
  afterPull.receipts[third],
  'read',
  'COUNTERFACTUAL CONFIRMED: getMessages sent a READ receipt for a message no human saw — ' +
    'which is precisely why the REST surface does not expose it',
);

await daemon.close();
memSample('after');
console.log(`\nreceipts OK (${t.count} checks) — the non-consuming read path emits no read receipt; markRead does, exact-once`);
process.exit(0);
