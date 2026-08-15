// Conversation window math. The window bounds BOTH what getConversationPage
// extracts from the packet and what the timeline renders; "Load earlier"
// grows it one step at a time, and a media-panel jump widens it just enough
// to cover the target entry.

export const INITIAL_CHAT_WINDOW = 80;
export const CHAT_WINDOW_STEP = 80;

export function growChatWindow(current, total, step = CHAT_WINDOW_STEP) {
  return Math.min(Math.max(0, total), Math.max(0, current) + Math.max(1, step));
}
