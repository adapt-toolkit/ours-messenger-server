// APPLYING A RECEIPT FROM THE EVENT THAT ANNOUNCED IT, AND THE ORDERING THAT
// MAKES THAT SAFE.
//
// The client used to discard the live event's payload — its kind and its wire
// ids — and go back to the server to rediscover what it had just been told. It
// now applies it directly, which means the tick no longer waits for a poll to
// land at the right moment. The poll stays as confirmation.
//
// Applying directly is only safe if it is MONOTONIC. Live events can arrive out
// of order, and a page response that was already in flight when the event landed
// is honest and older. Both must be unable to walk a tick backwards.

import assert from 'node:assert/strict';
import { appReducer, initialState, pageFor, type AppState } from '../src/store.js';
import { receiptRank, strongerReceipt, walksBackwards } from '../src/receiptOrder.mjs';
import type { ConversationMessage } from '../src/types.js';

// ---- the ordering rule itself ----------------------------------------------
assert.equal(receiptRank(null), 0, 'no receipt ranks below every receipt');
assert.equal(receiptRank(undefined), 0, 'and so does an absent one');
assert.ok(receiptRank('delivered') > receiptRank(null), 'delivered outranks nothing');
assert.ok(receiptRank('read') > receiptRank('delivered'), 'and read outranks delivered');
assert.equal(receiptRank('nonsense' as never), 0, 'an unrecognised value is treated as absent, not as strongest');

assert.equal(strongerReceipt(null, 'delivered'), 'delivered', 'null -> delivered moves forward');
assert.equal(strongerReceipt('delivered', 'read'), 'read', 'delivered -> read moves forward');
assert.equal(strongerReceipt('read', 'delivered'), 'read', 'READ -> DELIVERED DOES NOT MOVE BACK');
assert.equal(strongerReceipt('delivered', null), 'delivered', 'and neither does delivered -> nothing');
assert.equal(strongerReceipt('read', 'read'), 'read', 'a tie keeps what is there rather than churning');
assert.ok(walksBackwards('read', 'delivered'), 'walksBackwards names the case this exists to prevent');
assert.ok(!walksBackwards('delivered', 'read'), 'and does not fire on the forward direction');

// ---- the reducer -----------------------------------------------------------
const CID = 'PEER';
const IDENTITY = { cid: 'ME', name: 'Me' } as AppState['identity'];

const message = (wireId: string, receipt: ConversationMessage['receipt'] = null): ConversationMessage => ({
  dir: 'out', text: `msg ${wireId}`, date: '2026-08-17T00:00:00.000Z', read: true, wire_id: wireId, receipt,
});

const withPage = (messages: ConversationMessage[]): AppState => {
  let state = initialState({ name: 'chats', contactCid: CID });
  state = appReducer(state, { type: 'snapshot', identity: IDENTITY!, contacts: { contacts: [], pending: [] } });
  return appReducer(state, {
    type: 'page',
    contactCid: CID,
    page: { contact: CID, messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null },
  });
};

const receiptOf = (state: AppState, wireId: string) =>
  pageFor(state, CID)?.messages.find((m) => m.wire_id === wireId)?.receipt ?? null;

const receipt = (kind: 'delivered' | 'read', wireIds: string[]) =>
  ({ type: 'receipt', contactCid: CID, kind, wireIds }) as const;

// 1. THE CASE THE FIX EXISTS FOR: a delivered event with NO read receipt yet
//    must show delivered, and must stay there.
{
  let state = withPage([message('W1')]);
  assert.equal(receiptOf(state, 'W1'), null, 'the message starts with no receipt — one tick');
  state = appReducer(state, receipt('delivered', ['W1']));
  assert.equal(receiptOf(state, 'W1'), 'delivered',
    'the delivered event alone puts it at delivered, with no page response involved');
  state = appReducer(state, receipt('delivered', ['W1']));
  assert.equal(receiptOf(state, 'W1'), 'delivered', 'AND IT STAYS THERE — a repeat event changes nothing');
}

// 2. delivered THEN read leaves it read.
{
  let state = withPage([message('W1')]);
  state = appReducer(state, receipt('delivered', ['W1']));
  state = appReducer(state, receipt('read', ['W1']));
  assert.equal(receiptOf(state, 'W1'), 'read', 'delivered followed by read ends at read');
}

// 3. read THEN a late delivered event must NOT walk it back.
//    Live events are not ordered, and slow links can deliver the two receipts
//    in this sequence.
{
  let state = withPage([message('W1')]);
  state = appReducer(state, receipt('read', ['W1']));
  state = appReducer(state, receipt('delivered', ['W1']));
  assert.equal(receiptOf(state, 'W1'), 'read',
    'A DELIVERED EVENT ARRIVING AFTER READ LEAVES IT READ — out-of-order events cannot walk the tick backwards');
}

// 4. Only the named messages move.
{
  let state = withPage([message('W1'), message('W2', 'read'), message('W3')]);
  state = appReducer(state, receipt('delivered', ['W1', 'W3']));
  assert.deepEqual(
    pageFor(state, CID)!.messages.map((m) => m.receipt),
    ['delivered', 'read', 'delivered'],
    'a receipt names its wire ids and touches nothing else',
  );
}

// 5. An event naming messages we do not hold is a no-op, not a crash — and does
//    not churn state, since every dispatch re-renders the conversation.
{
  const state = withPage([message('W1', 'delivered')]);
  assert.equal(appReducer(state, receipt('read', ['UNKNOWN'])), state,
    'an event for an unheld message returns the same state object');
  assert.equal(appReducer(state, receipt('delivered', ['W1'])), state,
    'and so does one that changes nothing');
}

// 6. The optimistic row a send puts in pendingSends is receipted too, so a
//    receipt that arrives before the canonical page does is not lost.
{
  let state = initialState({ name: 'chats', contactCid: CID });
  state = appReducer(state, { type: 'snapshot', identity: IDENTITY!, contacts: { contacts: [], pending: [] } });
  state = appReducer(state, { type: 'sent_message', contactCid: CID, message: message('W9') });
  state = appReducer(state, receipt('delivered', ['W9']));
  const pending = state.pendingSends['ME:PEER'];
  assert.equal(pending?.[0]?.receipt, 'delivered',
    'a receipt reaches the optimistic row, which is all that exists until the page arrives');
}

// ---- and a page response that is honest but OLDER cannot undo any of it ----
// Several /page GETs are in flight at once as a matter of course, and they
// complete in whatever order the network gives them. src/conversation.ts
// enforces this direction within one response; nothing enforced it across two.
{
  let state = withPage([message('W1')]);
  state = appReducer(state, receipt('delivered', ['W1']));
  // A response issued before the receipt existed, landing after it was applied.
  state = appReducer(state, {
    type: 'page',
    contactCid: CID,
    page: { contact: CID, messages: [message('W1', null)], total: 1, unread: 0, hasMore: false, nextBefore: null },
  });
  assert.equal(receiptOf(state, 'W1'), 'delivered',
    'A STALE PAGE RESPONSE DOES NOT WALK THE TICK BACK — this is what makes applying the event durable');

  state = appReducer(state, receipt('read', ['W1']));
  state = appReducer(state, {
    type: 'page',
    contactCid: CID,
    page: { contact: CID, messages: [message('W1', 'delivered')], total: 1, unread: 0, hasMore: false, nextBefore: null },
  });
  assert.equal(receiptOf(state, 'W1'), 'read', 'and a page still reporting delivered does not undo read');
}

// A page response that moves a receipt FORWARD is still applied, since it is the
// canonical source and the events only ever announce what it will confirm.
{
  let state = withPage([message('W1')]);
  state = appReducer(state, {
    type: 'page',
    contactCid: CID,
    page: { contact: CID, messages: [message('W1', 'read')], total: 1, unread: 0, hasMore: false, nextBefore: null },
  });
  assert.equal(receiptOf(state, 'W1'), 'read', 'a page response carrying a stronger receipt is applied');
}

console.log('receipt-apply OK — and a stale page response cannot walk a tick backwards');
