export type ReceiptPresentation = {
  state: 'sent' | 'delivered' | 'read';
  label: 'sent' | 'delivered' | 'read';
  glyph: '\u2713' | '\u2713\u2713';
};

export function receiptPresentation(
  receipt: 'delivered' | 'read' | null | undefined | string,
): ReceiptPresentation;
