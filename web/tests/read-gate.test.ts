import assert from 'node:assert/strict';
import { canMarkRead, ReadCoordinator, type ReadGateState } from '../src/readGate.js';
import { MessengerApp } from '../src/App.js';
import { api } from '../src/api.js';
import type { ConversationPage } from '../src/types.js';

const base: ReadGateState = {
  visibility: 'visible', appRoute: 'chats', selectedContactCid: 'A', desktopLayout: true,
  mobileDetailOpen: false, conversationCoveringDialogOpen: false,
};
assert.equal(canMarkRead('A', base), true, 'exact selected desktop dialog is readable');
assert.equal(canMarkRead('B', base), false, 'a different dialog is never marked');
assert.equal(canMarkRead('A', { ...base, visibility: 'hidden' }), false, 'hidden tab is not readable');
assert.equal(canMarkRead('A', { ...base, desktopLayout: false }), false, 'mobile list with selected state is not readable');
assert.equal(canMarkRead('A', { ...base, desktopLayout: false, mobileDetailOpen: true }), true, 'open mobile detail is readable');
assert.equal(canMarkRead('A', { ...base, conversationCoveringDialogOpen: true }), false, 'covering dialog blocks reads');

const coordinator = new ReadCoordinator();
let release!: () => void;
let calls = 0;
const action = async () => {
  calls++;
  if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
};
const first = coordinator.request('A', action);
const duplicate = coordinator.request('A', action);
coordinator.request('A', action);
assert.equal(calls, 1, 'only one read action is in flight per CID');
release();
await Promise.all([first, duplicate]);
assert.equal(calls, 2, 'concurrent requests collapse to one rerun');

let bCalls = 0;
await Promise.all([
  coordinator.request('A', async () => { calls++; }),
  coordinator.request('B', async () => { bCalls++; }),
]);
assert.equal(bCalls, 1, 'different CIDs do not share a global debounce');

const media = {
  matches: true,
  addEventListener() {},
};
Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => media });
const documentState = { visibilityState: 'visible' as DocumentVisibilityState };
Object.defineProperty(globalThis, 'document', { configurable: true, value: documentState });

const page = (cid: string): ConversationPage => ({
  contact: cid,
  messages: [{ dir: 'in', text: 'private', date: 'DATE', read: false, wire_id: `WIRE-${cid}`, receipt: null }],
  total: 1,
  unread: 1,
  hasMore: false,
  nextBefore: null,
});
api.identity = async () => ({ name: 'Me', cid: 'ME' });
api.contacts = async () => ({
  contacts: [
    { name: 'Alice', container_id: 'A' },
    { name: 'Bob', container_id: 'B' },
  ],
  pending: [],
});
api.conversation = async (cid: string) => page(cid);
const readPosts: string[] = [];
api.markRead = async (cid: string) => {
  readPosts.push(cid);
  return { contact: cid, marked: 1 };
};

const app = new MessengerApp({} as HTMLElement);
app.render = () => {};
app.selectedContactCid = 'A';
await app.onServerEvent({ v: 1, type: 'sync_required', reason: 'overflow' });
assert.deepEqual(readPosts, ['A'], 'sync snapshot marks the exact visible selected dialog after rendering');

readPosts.length = 0;
documentState.visibilityState = 'hidden';
await app.onServerEvent({ v: 1, type: 'sync_required', reason: 'daemon_reconnected' });
assert.deepEqual(readPosts, [], 'sync snapshot never marks a hidden selected dialog');

documentState.visibilityState = 'visible';
media.matches = false;
app.mobileDetailOpen = false;
await app.onServerEvent({ v: 1, type: 'sync_required', reason: 'connected' });
assert.deepEqual(readPosts, [], 'sync snapshot never marks a mobile list-only selection');

media.matches = true;
app.coveringDialog = 'contact';
await app.onServerEvent({ v: 1, type: 'sync_required', reason: 'connected' });
assert.deepEqual(readPosts, [], 'sync snapshot never marks through a covering dialog');

app.coveringDialog = null;
app.selectedContactCid = 'B';
await app.onServerEvent({ v: 1, type: 'sync_required', reason: 'connected' });
assert.deepEqual(readPosts, ['B'], 'sync snapshot marks only the currently selected exact CID');

readPosts.length = 0;
const fetches: string[] = [];
let releaseSelectedA!: () => void;
const selectedAStarted = new Promise<void>((resolve) => {
  api.conversation = async (cid: string) => {
    fetches.push(cid);
    if (cid === 'A' && fetches.length === 1) {
      resolve();
      await new Promise<void>((release) => { releaseSelectedA = release; });
    }
    if (cid === 'B') throw new Error('selected B snapshot failed');
    return page(cid);
  };
});
const racedApp = new MessengerApp({} as HTMLElement);
racedApp.render = () => {};
racedApp.selectedContactCid = 'A';
const reconnect = racedApp.onServerEvent({ v: 1, type: 'sync_required', reason: 'daemon_reconnected' });
await selectedAStarted;
racedApp.selectedContactCid = 'B';
releaseSelectedA();
await reconnect;
assert.deepEqual({
  fetches,
  selected: racedApp.selectedContactCid,
  selectedPagePresent: racedApp.pages.has('B'),
  readPosts,
  surfacedError: racedApp.error,
}, {
  fetches: ['A', 'A', 'B'],
  selected: 'B',
  selectedPagePresent: false,
  readPosts: [],
  surfacedError: 'selected B snapshot failed',
}, 'contact switch plus failed authoritative snapshot suppresses the read POST');

console.log('read-gate OK — gate/coalescing matrix and sync snapshot exact-visible convergence');
