import type { ConversationPage } from '../types';
import { acpMessages } from './acp-adapter';
import { roomLineForContact, roomMessagePreview } from '../../../shared/roomMessageCore.mjs';
export type ChatPreview = { text: string; at: string; unavailable?: boolean };
const line = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);
export const emptyPreview = (): ChatPreview => ({ text: 'No messages yet', at: '' });
/** Project the same visible ACP messages as the conversation, never tool payloads. */
export function agentPreview(events: any[]): ChatPreview {
  const messages = acpMessages(events).filter(m => m.role === 'user' || m.role === 'agent');
  let newest: ChatPreview | undefined;
  let newestAt = -Infinity;
  for (const message of messages) {
    const text = message.parts.flatMap(p => p.type === 'content' ? p.content.flatMap(c => c.type === 'text' ? [c.text] : []) : []).join(' ');
    if (!text.trim() || message.timestamp < newestAt) continue;
    newestAt = message.timestamp;
    newest = { text: `${message.role === 'user' ? 'You' : 'Incoming'}: ${line(text)}`, at: Number.isFinite(message.timestamp) ? new Date(message.timestamp).toISOString() : '' };
  }
  return newest ?? emptyPreview();
}
/** Newest-last history includes file/voice rows without fetching their bytes. */
export function externalPreview(page: ConversationPage, announcedName: string): ChatPreview {
  const newest = page.messages.at(-1);
  if (!newest) return emptyPreview();
  const room = newest.dir === 'in' ? roomLineForContact(announcedName, newest.text) : null;
  const text = line(page.preview ?? (room ? roomMessagePreview(room) : newest.text));
  const fallback = newest.message_kind === 'file' ? 'File attachment' : 'Message';
  return { text: `${newest.dir === 'out' ? 'You' : 'Incoming'}: ${text || fallback}`, at: newest.date };
}
