// Unit tests for the host-side page projection.
//
// Pure function, no daemon: this is the half of getConversationPage that can be
// wrong in ways an end-to-end test would not notice, because an e2e run has one
// conversation of three messages and every cursor resolves.

import assert from 'node:assert/strict';
import { counter } from './harness.mjs';
import { ConversationPageError, projectPage } from '../src/conversation.ts';

const t = counter();

const msg = (i, over = {}) => ({
  dir: i % 2 === 0 ? 'in' : 'out',
  text: `m${i}`,
  date: `2026-08-10T00:${String(i).padStart(2, '0')}:00Z`,
  read: true,
  wire_id: `W${i}`,
  receipt: null,
  ...over,
});

const many = Array.from({ length: 10 }, (_, i) => msg(i));
const noReceipts = { contact: 'Peer', receipts: {} };

// ---- paging -----------------------------------------------------------------
const last3 = projectPage('Peer', many, noReceipts, { limit: 3 });
t.eq(last3.messages.map((m) => m.text), ['m7', 'm8', 'm9'], 'a page is the NEWEST n, still oldest-first within the page');
t.eq(last3.total, 10, 'total counts the whole conversation, not the page');
t.eq(last3.hasMore, true, 'hasMore is true when older entries exist');
t.eq(last3.nextBefore, 'W7', 'nextBefore is the oldest id IN the page — the exclusive bound for the next one');

const prev3 = projectPage('Peer', many, noReceipts, { limit: 3, before: last3.nextBefore });
t.eq(prev3.messages.map((m) => m.text), ['m4', 'm5', 'm6'], 'paging back with that cursor returns the previous three, no overlap and no gap');

const first = projectPage('Peer', many, noReceipts, { limit: 50 });
t.eq(first.hasMore, false, 'a limit larger than the conversation reports no more');
t.eq(first.nextBefore, null, 'and offers no cursor');

t.eq(projectPage('Peer', [], noReceipts, {}).messages.length, 0, 'an empty conversation is an empty page, not an error');
t.eq(projectPage('Peer', [], noReceipts, {}).nextBefore, null, 'and has no cursor');

// The server contract is plaintext. Markdown is a web projection only: Fleet
// final answers, direct peer messages, reply snippets, and copy paths all keep
// the exact authenticated history text, including oversized bodies that the
// browser intentionally renders through its lossless plaintext fallback.
const canonicalMarkdown = '# Tool result\n\n- **first**\n- `second`\n';
const oversizedMarkdown = `# Direct peer message\n${'x'.repeat(60_000)}`;
const canonicalPage = projectPage('Peer', [
  msg(0, { text: canonicalMarkdown, wire_id: 'W-MARKDOWN' }),
  msg(1, { text: oversizedMarkdown, wire_id: 'W-OVERSIZED' }),
], noReceipts, {});
t.eq(canonicalPage.messages[0].text, canonicalMarkdown,
  'the server returns Fleet/tool-result Markdown byte-for-byte rather than rendering or normalizing it');
t.eq(canonicalPage.messages[1].text, oversizedMarkdown,
  'the server never truncates an oversized peer message before the lossless browser fallback');

// ---- THE CURSOR THAT MUST NOT SILENTLY RESET --------------------------------
// A frontend paging past a GC'd message would otherwise get the NEWEST page back
// and render it as older history: an infinite scrollback of the same messages,
// with nothing anywhere reporting a fault.
assert.throws(
  () => projectPage('Peer', many, noReceipts, { limit: 3, before: 'W-DOES-NOT-EXIST' }),
  ConversationPageError,
  'an unresolvable cursor must throw',
);
t.ok(true, 'an unresolvable `before` cursor THROWS rather than silently returning the newest page');

// A pre-1.4 entry has wire_id '' and cannot be a cursor. Offering '' would make
// the next request paginate from "the first empty id", i.e. from the wrong place.
const withLegacy = [msg(0, { wire_id: '' }), msg(1, { wire_id: '' }), msg(2), msg(3)];
const legacyPage = projectPage('Peer', withLegacy, noReceipts, { limit: 2 });
t.eq(legacyPage.hasMore, true, 'older entries exist behind a page whose predecessors are legacy rows');
const legacyBoundary = projectPage('Peer', withLegacy, noReceipts, { limit: 3 });
t.eq(legacyBoundary.nextBefore, null, 'but nextBefore is null when the oldest entry in the page has no stable id');
assert.throws(
  () => projectPage('Peer', withLegacy, noReceipts, { before: '' }),
  ConversationPageError,
  'and an empty-string cursor is rejected rather than matching a legacy row',
);
t.ok(true, "and `before: ''` is rejected rather than matching the first legacy row");

// ---- receipt overlay is MONOTONIC -------------------------------------------
const outbound = [
  msg(1, { receipt: null }),
  msg(3, { receipt: 'delivered' }),
  msg(5, { receipt: 'read' }),
];
const overlaid = projectPage('Peer', outbound, {
  contact: 'Peer',
  receipts: { W1: 'delivered', W3: 'read', W5: 'delivered' },
}, {});
t.eq(overlaid.messages.map((m) => m.receipt), ['delivered', 'read', 'read'],
     'the overlay moves receipts FORWARD (null->delivered, delivered->read) and never backwards (read stays read against a stale delivered)');

const noOverlay = projectPage('Peer', outbound, noReceipts, {});
t.eq(noOverlay.messages.map((m) => m.receipt), [null, 'delivered', 'read'],
     'and an empty receipts map leaves the embedded receipts alone rather than clearing them');

// ---- unread counts the CONVERSATION, not the page ---------------------------
const mixed = [
  msg(0, { dir: 'in', read: false }),
  msg(2, { dir: 'in', read: false }),
  msg(4, { dir: 'in', read: true }),
  msg(5, { dir: 'out', read: false }), // outbound "unread" is not a thing a human owes
  msg(6, { dir: 'in', read: false }),
];
const tail = projectPage('Peer', mixed, noReceipts, { limit: 1 });
t.eq(tail.messages.length, 1, 'a one-entry page');
t.eq(tail.unread, 3, 'unread counts unread INBOUND across the whole conversation — a badge that only counts what is on screen is not a badge');

// ---- limit validation --------------------------------------------------------
for (const bad of [0, -1, 1.5, 501, NaN]) {
  assert.throws(() => projectPage('Peer', many, noReceipts, { limit: bad }), ConversationPageError, `limit ${bad}`);
}
t.ok(true, 'limits of 0, -1, 1.5, 501 and NaN are all rejected');

console.log(`\nconversation-page OK (${t.count} checks)`);
process.exit(0);
