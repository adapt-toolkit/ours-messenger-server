import type { Receipt } from '../types.js';
import { element } from './dom.js';

export function MessageReceipt(receipt: Receipt): HTMLElement {
  const label = receipt === 'read' ? 'Read' : receipt === 'delivered' ? 'Delivered' : 'Sent';
  const marks = receipt ? '✓✓' : '✓';
  const node = element('span', `receipt receipt-${receipt ?? 'sent'}`, marks);
  node.setAttribute('aria-label', label);
  node.title = label;
  return node;
}
