import type { Receipt } from '../types.js';

/** Canonical control-plane timeline shape, normalized exclusively by App's REST adapter. */
export interface ChatMessage {
  dir: 'in' | 'out';
  text: string;
  date: string;
  read: boolean;
  wireId: string;
  replyTo: { wireId: string } | null;
  kind?: 'file';
  filename?: string;
  mime?: string;
  receipt?: Exclude<Receipt, null>;
  _dbg?: {
    fnNil: boolean; fnRaw: string; kindNil: boolean; kindRaw: string; mimeNil: boolean;
    dir: string; textHead: string; src: 'field' | 'summary' | 'none';
  };
}
