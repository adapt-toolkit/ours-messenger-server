// Receipt presentation is deliberately small and shared by every outgoing
// content type. A history entry proves the send transaction completed; the
// optional receipt then upgrades monotonically from sent → delivered → read.
// Receipt absence is not evidence of failure (legacy/offline peers may never
// send one), so the UI must keep the honest baseline "sent" state.
//
// `receiptless` narrows that baseline for the one case where absence is not
// merely "not yet": an outbound entry with NO WIRE ID can never be named by a
// receipt, so none is coming. That is an introduction-carried first message, or
// a pre-1.4 entry restored from an old backup. THE GLYPH IS UNCHANGED — one
// tick, no invented second tick and no colour that would claim a receipt we do
// not have — and only the label tells the reader why it will stay that way.
export function receiptPresentation(receipt, receiptless = false) {
  if (receipt === 'read') {
    return { state: 'read', label: 'read', glyph: '\u2713\u2713' };
  }
  if (receipt === 'delivered') {
    return { state: 'delivered', label: 'delivered', glyph: '\u2713\u2713' };
  }
  if (receiptless) {
    return { state: 'untracked', label: 'sent, and cannot report delivery', glyph: '\u2713' };
  }
  return { state: 'sent', label: 'sent', glyph: '\u2713' };
}
