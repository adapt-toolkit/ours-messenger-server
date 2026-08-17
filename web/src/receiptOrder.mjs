// The receipt ordering rule, in one place on the client.
//
// `null < delivered < read` is the direction the engine guarantees and the
// direction src/conversation.ts already enforces server-side WITHIN one
// response. The client needs the same rule for a different reason: it now
// applies a receipt straight from the SSE event that announced it, and that
// value has to survive a page response which was already in flight when the
// event landed — a response that is honest, and older.
//
// Anything that moves a tick must go through here. A comparison written inline
// is a comparison that will eventually be written backwards.

const RANK = { read: 2, delivered: 1 };

/** Rank a receipt; absent is 0, and anything unrecognised is treated as absent. */
export function receiptRank(receipt) {
  return receipt && Object.hasOwn(RANK, receipt) ? RANK[receipt] : 0;
}

/**
 * The stronger of two receipts. Ties keep `a`, so an equal-ranked overwrite is
 * a no-op rather than a churn of identical values through the reducer.
 */
export function strongerReceipt(a, b) {
  return receiptRank(b) > receiptRank(a) ? b : a;
}

/** True when `next` would move the tick BACKWARDS — the thing that must never happen. */
export function walksBackwards(current, next) {
  return receiptRank(next) < receiptRank(current);
}
