import type { ContactVM, RootMetaVM } from './viewmodel';

export type ConversationListMode = 'recent' | 'identity';

export const CONVERSATION_LIST_MODE_KEY: string;
export const DEFAULT_CONVERSATION_LIST_MODE: 'recent';

export interface ConversationListStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ConversationIdentityGroup {
  id: string;
  rootId: string | null;
  label: string;
  note: string;
  contacts: ContactVM[];
}

export function readConversationListMode(
  storage?: ConversationListStorage,
): ConversationListMode;
export function writeConversationListMode(
  mode: ConversationListMode,
  storage?: ConversationListStorage,
): ConversationListMode;
export function compareConversationActivity(a: ContactVM, b: ContactVM): number;
export function sortConversationsByActivity(contacts: ContactVM[]): ContactVM[];
export function groupConversationsByIdentity(
  contacts: ContactVM[],
  roots: Record<string, RootMetaVM>,
): ConversationIdentityGroup[];
