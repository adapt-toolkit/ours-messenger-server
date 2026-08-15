import { receiptPresentation } from './receiptCore.mjs';

export type MessageReceiptState = 'delivered' | 'read' | undefined;

export function MessageReceipt({
  receipt,
  content = 'Message',
}: {
  receipt: MessageReceiptState;
  content?: 'Message' | 'File' | 'Voice message';
}) {
  const presentation = receiptPresentation(receipt);
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
