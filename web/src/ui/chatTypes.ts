import type { Receipt, TypedEnvelope } from '../types.js';

/** Messenger timeline shape, normalized exclusively by App's REST adapter. */
export interface ChatMessage {
  dir: 'in' | 'out';
  text: string;
  date: string;
  read: boolean;
  wireId: string;
  /** Authenticated peer CID from the server's peer-filtered history row. */
  peerCid?: string;
  replyTo: { wireId: string } | null;
  kind?: 'file';
  filename?: string;
  mime?: string;
  receipt?: Exclude<Receipt, null>;
  /**
   * No wire id, so no receipt can ever name this entry: an introduction-carried
   * send, or a pre-1.4 entry restored from an old backup. Distinct from "no
   * receipt yet", which is the ordinary case and does resolve.
   */
  receiptless?: boolean;
  messageKind?: string;
  typed?: TypedEnvelope | null;
}
