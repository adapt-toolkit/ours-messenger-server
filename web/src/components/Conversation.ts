import type { ContactView, ConversationPage } from '../types.js';
import { button, element } from './dom.js';
import { Composer } from './Composer.js';
import { MessageReceipt } from './MessageReceipt.js';

const time = (date: string) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function Conversation(opts: {
  contact: ContactView | null;
  page: ConversationPage | null;
  draft: string;
  replyWire: string | null;
  sending: boolean;
  mobileOpen: boolean;
  onBack(): void;
  onDraft(value: string): void;
  onReply(wireId: string): void;
  onCancelReply(): void;
  onSend(): void;
}): HTMLElement {
  const pane = element('section', `conversation-pane${opts.mobileOpen ? ' mobile-open' : ''}`);
  if (!opts.contact) {
    const blank = element('div', 'conversation-empty');
    blank.append(element('div', 'empty-orbit', '↗'), element('h2', '', 'Choose a conversation'), element('p', '', 'Messages stay in your ours identity.'));
    pane.append(blank);
    return pane;
  }

  const head = element('div', 'conversation-head');
  const back = button('←', 'icon-button mobile-back', opts.onBack);
  back.setAttribute('aria-label', 'Back to contacts');
  const title = element('div', 'conversation-title');
  title.append(element('strong', '', opts.contact.name), element('small', '', `Verified identity · ${opts.contact.container_id.slice(0, 12)}…`));
  head.append(back, element('span', 'avatar', opts.contact.name.slice(0, 1).toUpperCase()), title);
  pane.append(head);

  const thread = element('div', 'thread');
  thread.setAttribute('aria-live', 'polite');
  for (const message of opts.page?.messages ?? []) {
    const row = element('div', `message-row ${message.dir}`);
    const bubble = element('button', `bubble ${message.dir}`) as HTMLButtonElement;
    bubble.type = 'button';
    bubble.title = message.wire_id ? 'Reply to message' : '';
    if (message.wire_id) bubble.addEventListener('click', () => opts.onReply(message.wire_id));
    bubble.append(element('span', 'message-text', message.text));
    const meta = element('span', 'message-meta');
    meta.append(element('time', '', time(message.date)));
    if (message.dir === 'out') meta.append(MessageReceipt(message.receipt));
    bubble.append(meta);
    row.append(bubble);
    thread.append(row);
  }
  if (!opts.page) thread.append(element('p', 'empty-copy', 'Loading conversation…'));
  pane.append(thread);
  const replyText = opts.replyWire
    ? opts.page?.messages.find((message) => message.wire_id === opts.replyWire)?.text.slice(0, 80) ?? 'message'
    : null;
  pane.append(Composer({ ...opts, replyText }));
  queueMicrotask(() => { thread.scrollTop = thread.scrollHeight; });
  return pane;
}
