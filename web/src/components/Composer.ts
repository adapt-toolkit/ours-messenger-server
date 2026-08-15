import { button, element } from './dom.js';

export function Composer(opts: {
  draft: string;
  replyText: string | null;
  sending: boolean;
  onDraft(value: string): void;
  onCancelReply(): void;
  onSend(): void;
}): HTMLElement {
  const wrap = element('div', 'composer-wrap');
  if (opts.replyText) {
    const reply = element('div', 'reply-context');
    reply.append(element('span', '', `Replying to: ${opts.replyText}`), button('×', 'icon-button', opts.onCancelReply));
    wrap.append(reply);
  }
  const composer = element('div', 'composer');
  const input = element('textarea', 'composer-input') as HTMLTextAreaElement;
  input.rows = 1;
  input.placeholder = 'Write a message';
  input.setAttribute('aria-label', 'Message');
  input.value = opts.draft;
  input.disabled = opts.sending;
  const send = button(opts.sending ? 'Sending…' : 'Send', 'primary send-button', opts.onSend);
  send.disabled = opts.sending || opts.draft.trim().length === 0;
  input.addEventListener('input', () => {
    opts.onDraft(input.value);
    send.disabled = opts.sending || input.value.trim().length === 0;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      opts.onSend();
    }
  });
  composer.append(input, send);
  wrap.append(composer);
  return wrap;
}
