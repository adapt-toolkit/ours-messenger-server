// getConversationPage — A HOST-SIDE PROJECTION, WITH NO MUFL BEHIND IT.
//
// `getConversation` returns the WHOLE conversation, oldest first. That is the
// right shape for the engine to expose and the wrong shape for a scrollback: a
// frontend opening a two-year-old thread does not want two years of it. Paging is
// therefore done HERE, over the array the SDK already returned, which is why this
// needed no SDK change and no MUFL.
//
// `getReceipts` is overlaid on top even though `ConversationMessage.receipt`
// already carries one. The two come from different reads, and the receipts map is
// the authoritative one; overlaying it costs a merge and removes a class of
// "the tick did not update until I reloaded" bug. The overlay is MONOTONIC in the
// same direction the engine guarantees — null < delivered < read — so a stale map
// can never walk a tick backwards.
//
// THIS PATH IS NON-CONSUMING AND SENDS NOTHING. Reading a page does not mark
// anything read and does not emit a receipt. `markRead` is a separate, explicit
// call the frontend makes when a HUMAN actually sees the messages. That
// separation is the whole reason this surface exists — see README, "Two ticks".

import type { ConversationMessage, ReceiptsResult } from '@ours.network/sdk';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;

export interface ConversationPage {
  readonly contact: string;
  /** Oldest first, as the engine orders them. */
  readonly messages: readonly ConversationMessage[];
  /** Total entries in the conversation, not in this page. */
  readonly total: number;
  /** Inbound entries a human has not seen. What `markRead` would transition. */
  readonly unread: number;
  /** True when older entries exist before this page. */
  readonly hasMore: boolean;
  /**
   * Cursor for the NEXT (older) page: pass it back as `before`. Null when this
   * page reaches the start of the conversation, or when the oldest entry in it is
   * a pre-1.4 row with no stable id — see `cursorFor`.
   */
  readonly nextBefore: string | null;
}

export class ConversationPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationPageError';
  }
}

const RANK = { read: 2, delivered: 1 } as const;

/** Monotonic merge: only ever moves a receipt forward. */
function strongerReceipt(
  a: ConversationMessage['receipt'],
  b: ConversationMessage['receipt'],
): ConversationMessage['receipt'] {
  const ra = a ? RANK[a] : 0;
  const rb = b ? RANK[b] : 0;
  return rb > ra ? b : a;
}

/**
 * A pre-1.4 entry has `wire_id === ''` and therefore cannot be a cursor. Returning
 * `''` would make the next request paginate from "the first empty id", i.e. from
 * the wrong place, quietly. Null instead: the caller sees the page cannot be
 * continued rather than being handed a page from somewhere else.
 */
function cursorFor(m: ConversationMessage | undefined): string | null {
  return m && m.wire_id !== '' ? m.wire_id : null;
}

export function projectPage(
  contact: string,
  messages: readonly ConversationMessage[],
  receipts: ReceiptsResult,
  opts: { readonly limit?: number; readonly before?: string } = {},
): ConversationPage {
  const limit = opts.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ConversationPageError(`limit must be an integer in 1..${MAX_PAGE_LIMIT}, got ${String(opts.limit)}`);
  }

  // Where the page ENDS (exclusive). Without a cursor that is the newest entry.
  let end = messages.length;
  if (opts.before !== undefined) {
    const idx = messages.findIndex((m) => m.wire_id === opts.before && m.wire_id !== '');
    // AN UNRESOLVED CURSOR IS AN ERROR, NOT "start from the top". A frontend that
    // pages past a message which has since been GC'd would otherwise silently
    // receive the NEWEST page again and render it as older history — an infinite
    // scrollback of the same messages, with nothing anywhere reporting a fault.
    if (idx === -1) {
      throw new ConversationPageError(
        `before cursor ${JSON.stringify(opts.before)} is not in this conversation`,
      );
    }
    end = idx;
  }

  const start = Math.max(0, end - limit);
  const page = messages.slice(start, end).map((m) => ({
    ...m,
    receipt: strongerReceipt(m.receipt, receipts.receipts[m.wire_id] ?? null),
  }));

  return {
    contact,
    messages: page,
    total: messages.length,
    // Counted over the WHOLE conversation, not the page: an unread badge that only
    // counts what is currently on screen is not an unread badge.
    unread: messages.filter((m) => m.dir === 'in' && !m.read).length,
    hasMore: start > 0,
    nextBefore: start > 0 ? cursorFor(page[0]) : null,
  };
}
