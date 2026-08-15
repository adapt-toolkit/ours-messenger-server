import type { Receipt } from '../types.js';

export function MessageReceipt({ receipt }: { receipt: Receipt }) {
  const label = receipt === 'read' ? 'Read' : receipt === 'delivered' ? 'Delivered' : 'Sent';
  return (
    <span className={`receipt receipt-${receipt ?? 'sent'}`} aria-label={label} title={label}>
      {receipt ? '✓✓' : '✓'}
    </span>
  );
}
