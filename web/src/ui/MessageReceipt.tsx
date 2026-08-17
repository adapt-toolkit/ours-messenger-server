import { receiptPresentation } from './receiptCore.mjs';

export type MessageReceiptState = 'delivered' | 'read' | undefined;

export function MessageReceipt({
  receipt,
  content = 'Message',
  receiptless = false,
}: {
  receipt: MessageReceiptState;
  content?: 'Message' | 'File' | 'Voice message';
  /** This entry has no wire id, so no receipt can ever name it. */
  receiptless?: boolean;
}) {
  const presentation = receiptPresentation(receipt, receiptless);
  return (
    <span
      className={'ticks' + (presentation.state === 'read' ? ' read' : '')}
      data-receipt-status={presentation.state}
      role="img"
      aria-label={`${content} ${presentation.label}`}
      title={presentation.label}
    >
      {presentation.glyph}
    </span>
  );
}
