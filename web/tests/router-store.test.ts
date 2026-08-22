import assert from 'node:assert/strict';
import { chatPath, parseRoute } from '../src/router.js';
import { appReducer, dialogKey, initialState, pageFor } from '../src/store.js';
import type { ConversationPage } from '../src/types.js';

assert.deepEqual(parseRoute('/'), { name: 'chats', contactCid: null });
assert.deepEqual(parseRoute('/chats'), { name: 'chats', contactCid: null });
assert.deepEqual(parseRoute('/chats/A%2FB'), { name: 'chats', contactCid: 'A/B' });
assert.deepEqual(parseRoute('/settings'), { name: 'not_found', pathname: '/settings' });
assert.equal(chatPath('A/B'), '/chats/A%2FB');

const contacts = { contacts: [{ name: 'Alice', container_id: 'A' }], pending: [] };
const page: ConversationPage = {
  contact: 'A', messages: [{ dir: 'in', text: 'secret', date: 'DATE', read: false, wire_id: 'W', receipt: null }],
  total: 1, unread: 1, hasMore: false, nextBefore: null,
};
let state = initialState({ name: 'chats', contactCid: 'A' });
state = appReducer(state, { type: 'snapshot', identity: { name: 'Me', cid: 'IDENTITY-1' }, contacts });
state = appReducer(state, { type: 'page', contactCid: 'A', page });
state = appReducer(state, { type: 'draft', contactCid: 'A', value: 'draft secret' });
assert.equal(pageFor(state, 'A')?.messages[0].text, 'secret');
assert.equal(state.drafts[dialogKey('IDENTITY-1', 'A')], 'draft secret');

const newest = {
  ...page,
  messages: Array.from({ length: 50 }, (_, index) => ({
    dir: 'in' as const, text: `message ${index + 51}`, date: `DATE-${index + 51}`,
    read: true, wire_id: `W${index + 51}`, receipt: null,
  })),
  total: 100, unread: 0, hasMore: true, nextBefore: 'W51',
  preview: 'message 100',
};
state = appReducer(state, { type: 'page', contactCid: 'A', page: newest });
const older = {
  ...page,
  messages: Array.from({ length: 50 }, (_, index) => ({
    dir: 'in' as const, text: `message ${index + 1}`, date: `DATE-${index + 1}`,
    read: true, wire_id: `W${index + 1}`, receipt: null,
  })),
  total: 100, unread: 0, hasMore: false, nextBefore: null,
  preview: 'message 50',
};
state = appReducer(state, { type: 'older_page', contactCid: 'A', page: older, newer: newest.messages });
assert.deepEqual(pageFor(state, 'A')?.messages.map((message) => message.wire_id),
  Array.from({ length: 100 }, (_, index) => `W${index + 1}`),
  'older pages prepend in deterministic chronological order');
assert.equal(pageFor(state, 'A')?.preview, 'message 100',
  'an older page cannot replace the newest chat-list preview');
state = appReducer(state, { type: 'older_page', contactCid: 'A', page: older, newer: newest.messages });
assert.equal(pageFor(state, 'A')?.messages.length, 100, 'replayed cursor responses de-duplicate stable wire ids');

const sentMessage = {
  dir: 'out' as const, text: 'optimistic canonical send', date: 'DATE-101', read: true,
  wire_id: 'SENT-101', receipt: null,
};
state = appReducer(state, { type: 'sent_message', contactCid: 'A', message: sentMessage });
assert.equal(pageFor(state, 'A')?.messages.at(-1)?.wire_id, 'SENT-101',
  'the settled send response becomes visible without waiting for conversation polling');
assert.equal(pageFor(state, 'A')?.total, 101);
state = appReducer(state, { type: 'page', contactCid: 'A', page: { ...older, total: 100 } });
assert.equal(pageFor(state, 'A')?.messages.at(-1)?.wire_id, 'SENT-101',
  'a lagging conversation refresh cannot erase a locally settled send');
state = appReducer(state, { type: 'sent_message', contactCid: 'A', message: sentMessage });
assert.equal(pageFor(state, 'A')?.messages.filter((message) => message.wire_id === 'SENT-101').length, 1,
  'replayed send responses de-duplicate by canonical wire id');
state = appReducer(state, {
  type: 'page', contactCid: 'A',
  page: { ...older, messages: [...older.messages, sentMessage], total: 101 },
});
assert.equal(state.pendingSends[dialogKey('IDENTITY-1', 'A')], undefined,
  'the canonical page retires the local send overlay by wire id');

let raceState = initialState({ name: 'chats', contactCid: 'A' });
raceState = appReducer(raceState, { type: 'snapshot', identity: { name: 'Me', cid: 'IDENTITY-1' }, contacts });
raceState = appReducer(raceState, { type: 'page', contactCid: 'A', page: newest });
const shifted = {
  ...newest,
  messages: Array.from({ length: 50 }, (_, index) => ({
    dir: 'in' as const, text: `message ${index + 52}`, date: `DATE-${index + 52}`,
    read: true, wire_id: `W${index + 52}`, receipt: null,
  })),
  total: 101, nextBefore: 'W52',
};
raceState = appReducer(raceState, { type: 'page', contactCid: 'A', page: shifted });
raceState = appReducer(raceState, { type: 'older_page', contactCid: 'A', page: older, newer: newest.messages });
assert.deepEqual(pageFor(raceState, 'A')?.messages.map((message) => message.wire_id),
  Array.from({ length: 101 }, (_, index) => `W${index + 1}`),
  'a concurrent newest-page refresh cannot open a gap behind an in-flight older cursor');

state = appReducer(state, { type: 'snapshot', identity: { name: 'Other', cid: 'IDENTITY-2' }, contacts });
assert.equal(pageFor(state, 'A'), null, 'an identity change cannot reuse another identity conversation snapshot');
assert.deepEqual(state.drafts, {}, 'an identity change drops in-memory drafts instead of crossing scopes');
assert.deepEqual(state.replies, {}, 'an identity change drops reply context');

console.log('router-store OK — encoded chat routes, deterministic cursor merge, and identity/dialog-scoped state');
