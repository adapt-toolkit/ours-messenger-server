import { useEffect, useRef } from 'react';
import type { ContactView, ConversationPage } from '../types.js';
import { Composer } from './Composer.js';
import { MessageReceipt } from './MessageReceipt.js';

const time = (date: string) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function Conversation(props: {
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
}) {
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [props.page?.messages.length, props.contact?.container_id]);

  if (!props.contact) {
    return (
      <section className={`conversation-pane${props.mobileOpen ? ' mobile-open' : ''}`}>
        <div className="conversation-empty">
          <div className="empty-orbit" aria-hidden="true">↗</div>
          <h2>Choose a conversation</h2>
          <p>Messages stay in your ours identity.</p>
        </div>
      </section>
    );
  }

  const replyText = props.replyWire
    ? props.page?.messages.find((message) => message.wire_id === props.replyWire)?.text.slice(0, 80) ?? 'message'
    : null;

  return (
    <section className={`conversation-pane${props.mobileOpen ? ' mobile-open' : ''}`} aria-label={`Conversation with ${props.contact.name}`}>
      <div className="conversation-head">
        <button type="button" className="icon-button mobile-back" aria-label="Back to contacts" onClick={props.onBack}>←</button>
        <span className="avatar" aria-hidden="true">{props.contact.name.slice(0, 1).toUpperCase()}</span>
        <div className="conversation-title">
          <strong>{props.contact.name}</strong>
          <small>Verified identity · {props.contact.container_id.slice(0, 12)}…</small>
        </div>
      </div>
      <div className="thread" ref={thread} aria-live="polite">
        {props.page?.messages.map((message) => (
          <div className={`message-row ${message.dir}`} key={`${message.wire_id}:${message.date}`}>
            <button
              type="button"
              className={`bubble ${message.dir}`}
              title={message.wire_id ? 'Reply to message' : undefined}
              disabled={!message.wire_id}
              onClick={() => message.wire_id && props.onReply(message.wire_id)}
            >
              <span className="message-text">{message.text}</span>
              <span className="message-meta">
                <time dateTime={message.date}>{time(message.date)}</time>
                {message.dir === 'out' && <MessageReceipt receipt={message.receipt} />}
              </span>
            </button>
          </div>
        ))}
        {!props.page && <p className="empty-copy">Loading conversation…</p>}
      </div>
      <Composer
        draft={props.draft}
        replyText={replyText}
        sending={props.sending}
        onDraft={props.onDraft}
        onCancelReply={props.onCancelReply}
        onSend={props.onSend}
      />
    </section>
  );
}
