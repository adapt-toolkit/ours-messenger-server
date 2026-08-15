// Receipt presentation is deliberately small and shared by every outgoing
// content type. A history entry proves the send transaction completed; the
// optional receipt then upgrades monotonically from sent → delivered → read.
// Receipt absence is not evidence of failure (legacy/offline peers may never
// send one), so the UI must keep the honest baseline "sent" state.
export function receiptPresentation(receipt) {
  if (receipt === 'read') {
    return { state: 'read', label: 'read', glyph: '\u2713\u2713' };
  }
  if (receipt === 'delivered') {
    return { state: 'delivered', label: 'delivered', glyph: '\u2713\u2713' };
  }
  return { state: 'sent', label: 'sent', glyph: '\u2713' };
}
