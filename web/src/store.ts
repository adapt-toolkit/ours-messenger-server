import type {
  ConnectionState,
  ContactsResponse,
  ConversationPage,
  IdentityView,
} from './types.js';
import type { AppRoute } from './router.js';

export interface AppState {
  identity: IdentityView | null;
  contacts: ContactsResponse;
  route: AppRoute;
  pages: Record<string, ConversationPage | undefined>;
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
    drafts: {},
    replies: {},
    connection: 'connecting',
    search: '',
    mobileDetailOpen: route.name === 'chats' && route.contactCid !== null,
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
  return state.route.name === 'chats' ? state.route.contactCid : null;
}

export function selectedDialogKey(state: AppState): string | null {
  const contactCid = selectedContactCid(state);
  return state.identity && contactCid ? dialogKey(state.identity.cid, contactCid) : null;
}

export function pageFor(state: AppState, contactCid: string): ConversationPage | null {
  return state.identity ? state.pages[dialogKey(state.identity.cid, contactCid)] ?? null : null;
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
          pages: {}, drafts: {}, replies: {}, sendingDialog: null,
          generatedInvite: null, coveringDialog: false, dialogBusy: false,
        } : {}),
      };
    }
    case 'contacts': return { ...state, contacts: action.contacts };
    case 'page': {
      if (!state.identity) return state;
      return { ...state, pages: { ...state.pages, [dialogKey(state.identity.cid, action.contactCid)]: action.page } };
    }
    case 'route': return {
      ...state,
      route: action.route,
      mobileDetailOpen: action.mobileDetailOpen ?? (action.route.name === 'chats' && action.route.contactCid !== null),
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
