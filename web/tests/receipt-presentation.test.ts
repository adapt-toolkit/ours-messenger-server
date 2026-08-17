// The tick a message carries when NO RECEIPT IS COMING.
//
// Receipt absence normally means "not yet" — a legacy or offline peer may take a
// while, or never answer, and the honest baseline for that is "sent". An entry
// with no wire id is a different thing: nothing can ever name it in a receipt, so
// the reader is not waiting for anything. That is an introduction-carried first
// message, or a pre-1.4 entry restored from an old backup.
//
// The distinction lives in the LABEL ONLY. Giving it a second tick would claim a
// delivery report we do not have, which is the same class of lie as the HTTP 500
// that claimed a delivered message had failed.

import assert from 'node:assert/strict';
import { receiptPresentation } from '../src/ui/receiptCore.mjs';
import { timeline } from '../src/App.js';

const ONE_TICK = '✓';
const TWO_TICKS = '✓✓';

// ---- the presentation itself ------------------------------------------------
assert.deepEqual(receiptPresentation(null), { state: 'sent', label: 'sent', glyph: ONE_TICK },
  'no receipt yet is still the honest baseline "sent"');
assert.deepEqual(receiptPresentation(undefined, false), { state: 'sent', label: 'sent', glyph: ONE_TICK },
  'and an explicit tracked:true entry is unchanged — the default is not a behaviour change');

const untracked = receiptPresentation(null, true);
assert.equal(untracked.state, 'untracked', 'an entry that can never be receipted is its own state');
assert.equal(untracked.glyph, ONE_TICK, 'AND IT KEEPS ONE TICK — no second tick is invented for it');
assert.notEqual(untracked.label, 'sent', 'but the label says why the tick will not advance');
assert.match(untracked.label, /cannot report delivery/, 'in terms a reader can act on');

// A receipt that DID arrive outranks the flag: if a receipt exists the entry was
// evidently trackable, and the receipt is the stronger fact.
assert.equal(receiptPresentation('delivered', true).state, 'delivered',
  'a real delivered receipt wins over the receiptless flag');
assert.equal(receiptPresentation('read', true).state, 'read',
  'and so does a real read receipt');
assert.equal(receiptPresentation('read', true).glyph, TWO_TICKS, 'with its two ticks intact');

// ---- and where the flag comes from ------------------------------------------
// `timeline` is the only place that decides it, from the canonical page.
const page = {
  contact: 'Peer',
  total: 3,
  unread: 0,
  hasMore: false,
  nextBefore: null,
  messages: [
    { dir: 'out' as const, text: 'introduction-carried', date: '2026-08-17T00:00:01Z', read: true, wire_id: '', receipt: null },
    { dir: 'out' as const, text: 'ordinary', date: '2026-08-17T00:00:02Z', read: true, wire_id: 'WIRE-1', receipt: 'delivered' as const },
    { dir: 'in' as const, text: 'inbound with no id', date: '2026-08-17T00:00:03Z', read: true, wire_id: '', receipt: null },
  ],
};
const rows = timeline(page, []);
const byText = (text: string) => rows.find((row) => row.text === text)!;

assert.equal(byText('introduction-carried').receiptless, true,
  'an OUTBOUND entry with no wire id is marked receiptless');
assert.equal(byText('ordinary').receiptless, false,
  'an outbound entry with a wire id is not');
assert.equal(byText('inbound with no id').receiptless, false,
  'and an INBOUND entry is never marked — we do not report our own receipts to ourselves');

console.log('receipt-presentation OK — an entry that can never be receipted says so, and still shows one tick');
