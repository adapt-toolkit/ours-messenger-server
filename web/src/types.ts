export type Receipt = 'delivered' | 'read' | null;

export interface IdentityView {
  name: string;
  cid: string;
  bio?: string;
  rootName?: string;
  isRoot?: boolean;
}

export interface ContactView {
  name: string;
  container_id: string;
}

export interface ContactsResponse {
  contacts: ContactView[];
  pending: Array<{ container_id: string; name: string; queued: number }>;
}

export interface ConversationMessage {
  dir: 'in' | 'out';
  text: string;
  date: string;
  read: boolean;
  wire_id: string;
  receipt: Receipt;
}

export interface ConversationPage {
  contact: string;
  messages: ConversationMessage[];
  total: number;
  unread: number;
  hasMore: boolean;
  nextBefore: string | null;
}

export type ServerEvent =
  | { v: 1; type: 'sync_required'; reason: string; identity?: string }
  | { v: 1; type: 'message_received'; contact_id: string; wire_id: string; date: string }
  | {
      v: 1;
      type: 'receipt_received';
      contact_id: string;
      kind: 'delivered' | 'read';
      wire_ids: string[];
      date: string;
    };

export type ConnectionState = 'connecting' | 'live' | 'retrying';
