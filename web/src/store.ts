import type {
  ConnectionState,
  ConversationMessage,
  ContactsResponse,
  ConversationPage,
  IdentityView,
} from './types.js';
import type { AppRoute } from './router.js';
import { strongerReceipt } from './receiptOrder.mjs';

export interface AppState {
  identity: IdentityView | null;
  contacts: ContactsResponse;
  route: AppRoute;
  pages: Record<string, ConversationPage | undefined>;
  pendingSends: Record<string, ConversationMessage[] | undefined>;
  drafts: Record<string, string | undefined>;
  replies: Record<string, string | undefined>;
  connection: ConnectionState;
  search: string;
  mobileDetailOpen: boolean;
  coveringDialog: boolean;
  dialogBusy: boolean;
  generatedInvite: string | null;
  sendingDialog: string | null;
  error: string | null;
  loaded: boolean;
}

export type AppAction =
  | { type: 'snapshot'; identity: IdentityView; contacts: ContactsResponse }
  | { type: 'contacts'; contacts: ContactsResponse }
  | { type: 'page'; contactCid: string; page: ConversationPage }
  | { type: 'sent_message'; contactCid: string; message: ConversationMessage }
  /**
   * Apply a receipt the SERVER ALREADY TOLD US ABOUT, from the live event's own
   * payload, instead of going back to the server to rediscover it. The event
   * carries the kind and the wire ids; throwing that away and polling for it is
   * what made the tick depend on a poll landing at the right moment.
   */
  | { type: 'receipt'; contactCid: string; kind: 'delivered' | 'read'; wireIds: readonly string[] }
  | {
      type: 'older_page'; contactCid: string; page: ConversationPage;
      /** Snapshot that followed this cursor when the request began; closes refresh races without gaps. */
      newer: ConversationPage['messages'];
    }
  | { type: 'route'; route: AppRoute; mobileDetailOpen?: boolean }
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'search'; search: string }
  | { type: 'draft'; contactCid: string; value: string }
  | { type: 'reply'; contactCid: string; wireId: string | null }
  | { type: 'sending'; dialog: string | null }
  | { type: 'dialog'; open: boolean }
  | { type: 'dialog_busy'; busy: boolean }
  | { type: 'generated_invite'; blob: string | null }
  | { type: 'error'; message: string | null };

const emptyContacts = (): ContactsResponse => ({ contacts: [], pending: [] });

export function initialState(route: AppRoute): AppState {
  return {
    identity: null,
    contacts: emptyContacts(),
    route,
    pages: {},
    pendingSends: {},
    drafts: {},
    replies: {},
    connection: 'connecting',
    search: '',
    mobileDetailOpen: (route.name === 'chats' && route.contactCid !== null) || route.name === 'contact',
    coveringDialog: false,
    dialogBusy: false,
    generatedInvite: null,
    sendingDialog: null,
    error: null,
    loaded: false,
  };
}

export function dialogKey(identityCid: string, contactCid: string): string {
  return `${identityCid}:${contactCid}`;
}

export function selectedContactCid(state: AppState): string | null {
  return state.route.name === 'chats' || state.route.name === 'contact' ? state.route.contactCid : null;
}

export function selectedDialogKey(state: AppState): string | null {
  const contactCid = selectedContactCid(state);
  return state.identity && contactCid ? dialogKey(state.identity.cid, contactCid) : null;
}

export function pageFor(state: AppState, contactCid: string): ConversationPage | null {
  return state.identity ? state.pages[dialogKey(state.identity.cid, contactCid)] ?? null : null;
}

/**
 * Overwrite a row with a newer copy WITHOUT losing a receipt it already has.
 *
 * src/conversation.ts enforces `null < delivered < read` within one response and
 * says so: "a stale map can never walk a tick backwards". Nothing enforced it
 * ACROSS responses. `refreshPage` is called, unawaited, from six places — the
 * convergence schedule alone fires at 0/100/400/1000/3000/6000ms, and live
 * events, markRead and the per-contact snapshot sweep add more — so several
 * /page GETs are in flight at once as a matter of course, and they complete in
 * whatever order the network gives them.
 *
 * An older response is not wrong. It is honest and out of date, and applying it
 * on top of a newer one walked the tick from delivered back to one tick, where
 * it stayed until something else happened to refresh. It also made the receipt
 * applied straight from a live event undurable: the next poll already in flight
 * would undo it.
 */
function keepStrongerReceipt(
  current: ConversationPage['messages'][number],
  next: ConversationPage['messages'][number],
): ConversationPage['messages'][number] {
  const receipt = strongerReceipt(current.receipt, next.receipt);
  return receipt === next.receipt ? next : { ...next, receipt };
}

function mergeMessages(
  first: ConversationPage['messages'],
  second: ConversationPage['messages'],
): ConversationPage['messages'] {
  const merged = [...first];
  const stable = new Map<string, number>();
  merged.forEach((message, index) => { if (message.wire_id) stable.set(message.wire_id, index); });
  for (const message of second) {
    const existing = message.wire_id ? stable.get(message.wire_id) : undefined;
    if (existing === undefined) {
      if (message.wire_id) stable.set(message.wire_id, merged.length);
      merged.push(message);
    } else {
      merged[existing] = keepStrongerReceipt(merged[existing], message);
    }
  }
  return merged;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'snapshot': {
      const identityChanged = state.identity !== null && state.identity.cid !== action.identity.cid;
      return {
        ...state,
        identity: action.identity,
        contacts: action.contacts,
        loaded: true,
        error: null,
        ...(identityChanged ? {
          pages: {}, pendingSends: {}, drafts: {}, replies: {}, sendingDialog: null,
          generatedInvite: null, coveringDialog: false, dialogBusy: false,
        } : {}),
      };
    }
    case 'contacts': return { ...state, contacts: action.contacts };
    case 'page': {
      if (!state.identity) return state;
      const key = dialogKey(state.identity.cid, action.contactCid);
      const current = state.pages[key];
      const pending = state.pendingSends[key] ?? [];
      const canonicalWireIds = new Set(action.page.messages.map((message) => message.wire_id));
      const remainingPending = pending.filter((message) => !canonicalWireIds.has(message.wire_id));
      // The wholesale-replacement branch needs the same protection as the merge
      // branch: replacing the page with an older response drops every receipt
      // the page had learned since that request was issued.
      const held = new Map(current?.messages.map((message) => [message.wire_id, message.receipt]) ?? []);
      const reconciled = current
        ? action.page.messages.map((message) => {
            const receipt = strongerReceipt(held.get(message.wire_id) ?? null, message.receipt);
            return receipt === message.receipt ? message : { ...message, receipt };
          })
        : action.page.messages;
      const canonicalPage = current && current.messages.length > 50
        ? {
            ...action.page,
            messages: mergeMessages(current.messages, reconciled),
            hasMore: current.hasMore,
            nextBefore: current.nextBefore,
          }
        : { ...action.page, messages: reconciled };
      const messages = mergeMessages(canonicalPage.messages, remainingPending);
      const page = {
        ...canonicalPage,
        messages,
        total: Math.max(canonicalPage.total + remainingPending.length, messages.length),
      };
      return {
        ...state,
        pages: { ...state.pages, [key]: page },
        pendingSends: { ...state.pendingSends, [key]: remainingPending.length ? remainingPending : undefined },
      };
    }
    case 'sent_message': {
      if (!state.identity) return state;
      const key = dialogKey(state.identity.cid, action.contactCid);
      const current = state.pages[key];
      if (current?.messages.some((message) => message.wire_id === action.message.wire_id)) return state;
      const pending = mergeMessages(state.pendingSends[key] ?? [], [action.message]);
      if (!current) return { ...state, pendingSends: { ...state.pendingSends, [key]: pending } };
      const messages = mergeMessages(current.messages, [action.message]);
      return {
        ...state,
        pages: {
          ...state.pages,
          [key]: { ...current, messages, total: Math.max(current.total + 1, messages.length) },
        },
        pendingSends: { ...state.pendingSends, [key]: pending },
      };
    }
    case 'receipt': {
      if (!state.identity) return state;
      const key = dialogKey(state.identity.cid, action.contactCid);
      const current = state.pages[key];
      const pending = state.pendingSends[key];
      const named = new Set(action.wireIds);
      // MONOTONIC, like the server's own overlay: a receipt only ever moves
      // forward. Live events can arrive out of order, and a delivered event
      // landing after a read one must not walk the tick back to one tick.
      const apply = (messages: ConversationPage['messages']) => {
        let changed = false;
        const next = messages.map((message) => {
          if (!message.wire_id || !named.has(message.wire_id)) return message;
          const receipt = strongerReceipt(message.receipt, action.kind);
          if (receipt === message.receipt) return message;
          changed = true;
          return { ...message, receipt };
        });
        return changed ? next : messages;
      };
      const messages = current ? apply(current.messages) : undefined;
      const nextPending = pending ? apply(pending) : undefined;
      // Identity comparison, so an event naming messages we do not hold — or one
      // that changes nothing — does not re-render the conversation.
      if (messages === current?.messages && nextPending === pending) return state;
      return {
        ...state,
        pages: current && messages ? { ...state.pages, [key]: { ...current, messages } } : state.pages,
        pendingSends: pending && nextPending ? { ...state.pendingSends, [key]: nextPending } : state.pendingSends,
      };
    }
    case 'older_page': {
      if (!state.identity) return state;
      const key = dialogKey(state.identity.cid, action.contactCid);
      const current = state.pages[key];
      if (!current) return state;
      const messages = mergeMessages(mergeMessages(action.page.messages, action.newer), current.messages);
      const page = {
        ...action.page,
        // An older page's rows cannot define the chat-list preview. Preserve the
        // newest snapshot even when talking to an older server that projects the
        // preview from the requested page instead of whole-dialog history.
        preview: current.preview,
        total: Math.max(action.page.total, current.total, messages.length),
        messages,
      };
      return { ...state, pages: { ...state.pages, [key]: page } };
    }
    case 'route': return {
      ...state,
      route: action.route,
      mobileDetailOpen: action.mobileDetailOpen ?? ((action.route.name === 'chats' && action.route.contactCid !== null) || action.route.name === 'contact'),
    };
    case 'connection': return { ...state, connection: action.connection };
    case 'search': return { ...state, search: action.search };
    case 'draft': {
      if (!state.identity) return state;
      return { ...state, drafts: { ...state.drafts, [dialogKey(state.identity.cid, action.contactCid)]: action.value } };
    }
    case 'reply': {
      if (!state.identity) return state;
      return { ...state, replies: { ...state.replies, [dialogKey(state.identity.cid, action.contactCid)]: action.wireId ?? undefined } };
    }
    case 'sending': return { ...state, sendingDialog: action.dialog };
    case 'dialog': return {
      ...state,
      coveringDialog: action.open,
      dialogBusy: action.open ? state.dialogBusy : false,
      generatedInvite: action.open ? state.generatedInvite : null,
      error: null,
    };
    case 'dialog_busy': return { ...state, dialogBusy: action.busy };
    case 'generated_invite': return { ...state, generatedInvite: action.blob };
    case 'error': return { ...state, error: action.message };
  }
}
