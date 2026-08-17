export type ReceiptPresentation = {
  /** 'untracked' is a sent message that can never acquire a receipt (no wire id). */
  state: 'sent' | 'untracked' | 'delivered' | 'read';
  label: 'sent' | 'sent, and cannot report delivery' | 'delivered' | 'read';
  glyph: '\u2713' | '\u2713\u2713';
};

export function receiptPresentation(
  receipt: 'delivered' | 'read' | null | undefined | string,
  /** True when the entry has no wire id, so no receipt is coming. */
  receiptless?: boolean,
): ReceiptPresentation;
