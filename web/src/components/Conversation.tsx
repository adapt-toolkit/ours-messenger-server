import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContactView, ConversationPage, MediaRecord } from '../types.js';
import { Composer } from './Composer.js';
import { MessageReceipt } from './MessageReceipt.js';
import { InlineMarkdown } from './Markdown.js';
import { MediaInventory } from './MediaInventory.js';

const time = (date: string) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function Conversation(props: {
  contact: ContactView | null;
  page: ConversationPage | null;
  draft: string;
  replyWire: string | null;
  sending: boolean;
  sendingLabel: string | null;
  files: readonly MediaRecord[];
  busyWire: string | null;
  contactBusy: boolean;
  loadingOlder: boolean;
  mobileOpen: boolean;
  onBack(): void;
  onLoadOlder(): Promise<boolean>;
  onDraft(value: string): void;
  onReply(wireId: string): void;
  onCancelReply(): void;
  onSend(): void;
  onFiles(files: File[]): void;
  onVoice(blob: Blob, filename: string, mime: string): void;
  onFetch(file: MediaRecord): void;
  onRename(name: string): void;
  onRemove(): void;
  onError(message: string): void;
}) {
  const thread = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const priorThread = useRef({ contact: props.contact?.container_id, count: props.page?.messages.length ?? 0 });
  const [tab, setTab] = useState<'chat' | 'files'>('chat');
  const [managing, setManaging] = useState(false);
  const [contactName, setContactName] = useState(props.contact?.name ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setTab('chat'), [props.contact?.container_id]);
  useEffect(() => {
    setManaging(false);
    setConfirmRemove(false);
    setContactName(props.contact?.name ?? '');
  }, [props.contact?.container_id, props.contact?.name]);
  useBrowserLayoutEffect(() => {
    const node = thread.current;
    if (!node) return;
    const current = { contact: props.contact?.container_id, count: props.page?.messages.length ?? 0 };
    if (scrollAnchor.current) {
      node.scrollTop = scrollAnchor.current.top + (node.scrollHeight - scrollAnchor.current.height);
      scrollAnchor.current = null;
    } else if (priorThread.current.contact !== current.contact || priorThread.current.count !== current.count) {
      node.scrollTop = node.scrollHeight;
    }
    priorThread.current = current;
  }, [props.page?.messages.length, props.contact?.container_id]);

  const loadOlder = async () => {
    const node = thread.current;
    if (!node || props.loadingOlder) return;
    scrollAnchor.current = { height: node.scrollHeight, top: node.scrollTop };
    if (!await props.onLoadOlder()) scrollAnchor.current = null;
  };

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
        <div className="conversation-tabs" role="tablist" aria-label="Dialog view">
          <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
          <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>Files <span>{props.files.length}</span></button>
        </div>
        <div className="contact-tools">
          <button type="button" className="icon-button" aria-label="Manage contact" aria-expanded={managing} onClick={() => { setManaging((open) => !open); setConfirmRemove(false); }}>⋯</button>
          {managing && (
            <div className="contact-menu" role="dialog" aria-label="Manage contact">
              <label>Display name<input value={contactName} disabled={props.contactBusy} onChange={(event) => setContactName(event.target.value)} /></label>
              <button type="button" className="secondary compact" disabled={props.contactBusy || !contactName.trim()} onClick={() => { props.onRename(contactName.trim()); setManaging(false); }}>Rename</button>
              <button
                type="button"
                className="danger-button compact"
                disabled={props.contactBusy}
                onClick={() => confirmRemove ? props.onRemove() : setConfirmRemove(true)}
              >
                {confirmRemove ? 'Confirm remove' : 'Remove contact'}
              </button>
            </div>
          )}
        </div>
      </div>
      {tab === 'chat' ? (
        <>
          <div className="thread" ref={thread} aria-live="polite">
            {props.page?.hasMore && props.page.nextBefore && (
              <button type="button" className="secondary load-older" disabled={props.loadingOlder} onClick={() => void loadOlder()}>
                {props.loadingOlder ? 'Loading older messages…' : 'Load older messages'}
              </button>
            )}
            {props.page?.hasMore && !props.page.nextBefore && (
              <p className="muted history-unavailable">Older legacy history has no stable cursor.</p>
            )}
            {props.page?.messages.map((message) => {
              const target = message.reply_to
                ? props.page?.messages.find((candidate) => candidate.wire_id === message.reply_to?.wire_id)
                : null;
              return (
                <div className={`message-row ${message.dir}`} key={`${message.wire_id}:${message.date}`} id={`message-${message.wire_id}`}>
                  <article className={`bubble ${message.dir}`}>
                    {message.reply_to && (
                      <button
                        type="button"
                        className="reply-reference"
                        onClick={() => document.getElementById(`message-${message.reply_to!.wire_id}`)?.scrollIntoView({ block: 'center' })}
                      >
                        <span>Reply</span>
                        <strong>{target?.text.slice(0, 100) ?? `message ${message.reply_to.wire_id.slice(0, 10)}…`}</strong>
                      </button>
                    )}
                    <span className="message-text"><InlineMarkdown text={message.text} /></span>
                    <span className="message-meta">
                      {message.wire_id && <button type="button" className="reply-action" aria-label="Reply to message" onClick={() => props.onReply(message.wire_id)}>↩</button>}
                      <time dateTime={message.date}>{time(message.date)}</time>
                      {message.dir === 'out' && <MessageReceipt receipt={message.receipt} />}
                    </span>
                  </article>
                </div>
              );
            })}
            {props.page && props.page.messages.length === 0 && <p className="empty-copy">No messages yet. Say hello.</p>}
            {!props.page && <p className="empty-copy">Loading conversation…</p>}
          </div>
          <Composer
            draft={props.draft}
            replyText={replyText}
            sending={props.sending}
            sendingLabel={props.sendingLabel}
            onDraft={props.onDraft}
            onCancelReply={props.onCancelReply}
            onSend={props.onSend}
            onFiles={props.onFiles}
            onVoice={props.onVoice}
            onError={props.onError}
          />
        </>
      ) : (
        <div className="files-pane">
          <MediaInventory files={props.files} busyWire={props.busyWire} onFetch={props.onFetch} />
        </div>
      )}
    </section>
  );
}
