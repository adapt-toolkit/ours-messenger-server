export type Receipt = 'delivered' | 'read' | null;

export interface IdentityView {
  name: string;
  cid: string;
  bio?: string;
  rootName?: string;
  rootCid?: string;
  roleId?: string;
  isRoot?: boolean;
  temporary?: boolean;
}

export interface IdentityTreeRow {
  name: string;
  cid: string;
  kind: 'root' | 'role' | 'flat';
  session: 'mine' | 'other-live' | null;
  temp: null | { state: string; ownerPid: number };
}

export interface ContactView {
  name: string;
  container_id: string;
}

export interface PendingContactView {
  name: string;
  container_id: string;
  queued: number;
}

export interface ContactsResponse {
  contacts: ContactView[];
  pending: PendingContactView[];
  roots?: Record<string, unknown>;
}

export interface ConversationMessage {
  dir: 'in' | 'out';
  text: string;
  date: string;
  read: boolean;
  wire_id: string;
  receipt: Receipt;
  reply_to?: ReplyReference | null;
}

export interface ReplyReference {
  wire_id: string;
  sentence?: number;
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
    }
  | { v: 1; type: 'file_received'; contact_id: string; wire_id: string; date: string };

export type ConnectionState = 'connecting' | 'live' | 'retrying';

export interface InviteView {
  invite_id: string;
  mode: 'one_time' | 'public';
  assigned?: string;
}

export interface CreatedInvite {
  blob: string;
  invite_id?: string;
  inviteId?: string;
  mode?: 'one_time' | 'public';
}

export interface MediaRecord {
  wire_id: string;
  contact_id: string;
  dir: 'in' | 'out';
  sender_id: string;
  sender_name: string;
  filename: string;
  logical_name: string;
  version: number;
  mime: string;
  size: number;
  sha256: string | null;
  date: string;
  date_source: 'protocol' | 'server_observed';
  kind: 'file' | 'photo' | 'voice_message';
  reply_to: ReplyReference | null;
  available: boolean;
  transcription?: {
    configured?: boolean;
    attempted?: boolean;
    status?: string;
    provider?: string | null;
    text?: string | null;
    error_category?: string | null;
  };
}

export interface DialogFiles {
  contact: string;
  files: MediaRecord[];
}

export type PushState = 'unsupported' | 'idle' | 'blocked' | 'subscribed' | 'busy' | 'error';
