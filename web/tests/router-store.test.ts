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

state = appReducer(state, { type: 'snapshot', identity: { name: 'Other', cid: 'IDENTITY-2' }, contacts });
assert.equal(pageFor(state, 'A'), null, 'an identity change cannot reuse another identity conversation snapshot');
assert.deepEqual(state.drafts, {}, 'an identity change drops in-memory drafts instead of crossing scopes');
assert.deepEqual(state.replies, {}, 'an identity change drops reply context');

console.log('router-store OK — encoded chat routes and identity/dialog-scoped ephemeral state');
