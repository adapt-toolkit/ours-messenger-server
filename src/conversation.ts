// Conversation pages are a host-side projection of shared-daemon history.
//
// The daemon pages external history newest-first by stable sequence. The browser
// renders oldest-first, so `projectHistoryPage` reverses one bounded page while
// preserving the daemon's exclusive next cursor and whole-dialog summary.
//
// `projectPage` remains as a pure compatibility/test seam for already-projected
// arrays. Its receipt overlay is monotonic — null < delivered < read — so a stale
// receipt map can never walk a tick backwards.
//
// THIS PATH IS NON-CONSUMING AND SENDS NOTHING. Reading a page does not mark
// anything read and does not emit a receipt. The explicit read route selects the
// visible peer's unread wire IDs and consumes only that subset through the SDK.

import type { HistoryMessage, HistoryPage } from '@ours.network/sdk';
import { parseTypedEnvelope, type TypedEnvelope } from './typed-commands.js';
// @ts-ignore -- shared pure-JS core, typed by its sibling .d.mts at this seam.
import { contactMessagePreview } from '../shared/roomMessageCore.mjs';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;

export type Receipt = 'delivered' | 'read' | null;

export interface ConversationMessage {
  readonly dir: 'in' | 'out';
  readonly text: string;
  readonly date: string;
  readonly read: boolean;
  readonly wire_id: string;
  readonly peer_cid: string;
  readonly receipt: Receipt;
  readonly reply_to?: { readonly wire_id: string; readonly sentence?: number } | null;
  readonly message_kind?: string;
  readonly typed?: TypedEnvelope | null;
}

export interface ReceiptsResult {
  readonly contact: string;
  readonly receipts: Readonly<Record<string, Exclude<Receipt, null>>>;
}

export interface ConversationPage {
  readonly contact: string;
  /** Oldest first, as the engine orders them. */
  readonly messages: readonly ConversationMessage[];
  /** Total entries in the conversation, not in this page. */
  readonly total: number;
  /** Inbound entries a human has not seen. What the explicit read route transitions. */
  readonly unread: number;
  /** True when older entries exist before this page. */
  readonly hasMore: boolean;
  /**
   * The newest entry as ONE READABLE LINE, for a chat-list row.
   *
   * Computed here rather than in the browser because a cowork room relays signed
   * JSON and the same body also has to reach a push notification, which only the
   * server can compose. Two places deriving that line means two places to drift;
   * this is the one source both surfaces read. Empty when the page is empty or
   * the newest entry is a file, which the frontend labels from its own metadata.
   */
  readonly preview: string;
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
  opts: { readonly limit?: number; readonly before?: string; readonly announcedContact?: string } = {},
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
    // The NEWEST entry in the whole conversation, not in this page: a chat-list
    // row shows the latest line, and paging backwards must not rewrite it.
    preview: previewOf(opts.announcedContact ?? contact, messages.at(-1)),
  };
}

function previewOf(announcedContact: string, newest: ConversationMessage | undefined): string {
  if (!newest) return '';
  // Only inbound history is authenticated as authored by the room contact.
  // A user may type JSON to a room; it remains their literal outgoing text.
  if (newest.dir !== 'in') return newest.text;
  return contactMessagePreview(announcedContact, newest.text) as string;
}

/** Project one newest-first daemon history page into the browser's oldest-first shape. */
export function projectHistoryPage(
  contact: string,
  history: HistoryPage<HistoryMessage>,
  summary: { readonly total: number; readonly unread: number },
  opts: { readonly announcedContact?: string } = {},
): ConversationPage {
  const messages: ConversationMessage[] = history.items.map((row) => ({
    dir: row.direction,
    text: row.text,
    date: row.date,
    read: row.direction === 'out' || row.inbox_state === 'read',
    wire_id: row.wire_id,
    peer_cid: row.peer.id,
    receipt: row.direction === 'out' && (row.delivery_state === 'delivered' || row.delivery_state === 'read')
      ? row.delivery_state
      : null,
    reply_to: row.reply_to,
    message_kind: row.message_kind ?? 'text',
    typed: parseTypedEnvelope(row.message_kind ?? 'text', row.body),
  })).reverse();
  return {
    contact,
    messages,
    total: summary.total,
    unread: summary.unread,
    hasMore: history.next_cursor !== null,
    nextBefore: history.next_cursor === null ? null : String(history.next_cursor),
    preview: previewOf(opts.announcedContact ?? contact, messages.at(-1)),
  };
}
