import assert from 'node:assert/strict';
import { canMarkRead, ReadCoordinator, type ReadGateState } from '../src/readGate.js';

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
console.log('read-gate OK — desktop/mobile/visibility/dialog matrix and per-CID coalescing');
