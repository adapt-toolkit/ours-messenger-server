// Chats section — grouped contact list + conversation. Ported from the design
// prototype (app/Chats.jsx) and wired to MessengerHost data via the view model.
import { ReactNode, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { ContactVM, RootMetaVM, fmtTime } from './viewmodel';
import type { ChatMessage } from './chatTypes';
import { FileRecord, MAX_FILE_BYTES, fileRecord, fmtSize, isVoiceNote } from './fileStore';
import { FileBubble, AttachPreview, VoiceComposer, PendingAttachment } from './FileBubbles';
import { MarkdownPreview } from './MarkdownPreview';
import { HtmlPreview } from './HtmlPreview';
import { isHtmlAttachment } from './htmlPreviewCore.mjs';
import { ChatMediaPanel } from './ChatMediaPanel';
import { compressImageForSend } from './imageCompression';
import { isCompressibleImage } from './imageCompressionCore.mjs';
import { MessageReceipt } from './MessageReceipt';
import { MessageMarkdown } from './MessageMarkdown';
import { ApiError } from '../api';
import { AnimatePresence, motion } from 'framer-motion';
import { interfaceSpring } from './motionSystem';
import { SWIPE_DISTANCE_PX, classifyReplyIntent, shouldCommitReply } from './swipeReplyCore';
import {
  groupConversationsByIdentity,
  readConversationListMode,
  sortConversationsByActivity,
  writeConversationListMode,
  type ConversationListMode,
} from './conversationListCore.mjs';
import {
  roomLineForContact,
  roomMessagePreview,
  type RoomLine,
} from '../../../shared/roomMessageCore.mjs';

const TEXT_SEND_TIMEOUT_MS = 15_000;

function ContactRow(props: {
  c: ContactVM;
  active: boolean;
  grouped?: boolean;
  onClick: () => void;
  onApprove?: () => Promise<boolean>;
  onReject?: () => Promise<boolean>;
}) {
  const { c, active, grouped } = props;
  const [decisionBusy, setDecisionBusy] = useState(false);
  const decide = async (action: (() => Promise<boolean>) | undefined, target: HTMLButtonElement) => {
    if (!action || decisionBusy) return;
    setDecisionBusy(true);
    try {
      const removed = await action();
      requestAnimationFrame(() => {
        if (removed) document.getElementById('chat-list-title')?.focus();
        else target.focus();
      });
    } finally {
      setDecisionBusy(false);
    }
  };
  const contents = <>
    <span className="contact-avatar" aria-hidden>{c.initials}</span>
    <span className="contact-copy">
      <span className="contact-row-topline">
        <span className="contact-name">{c.name}</span>
        {c.when && <span className="contact-time">{c.when}</span>}
      </span>
      <span className="contact-row-bottomline">
        <span className="contact-last">{c.last}</span>
        {c.status === 'pending' && <span className="chip">pending approval</span>}
        {!!c.unread && <span className="contact-unread">{c.unread}</span>}
      </span>
    </span>
    {c.status === 'pending' && <span className="pending-actions" role="group" aria-label={`Decide whether to accept ${c.name}`}>
      <button type="button" className="linkbtn" disabled={decisionBusy} onClick={(event) => void decide(props.onApprove, event.currentTarget)}>Approve</button>
      <button type="button" className="linkbtn quiet" disabled={decisionBusy} onClick={(event) => void decide(props.onReject, event.currentTarget)}>Reject</button>
    </span>}
    {active && <motion.span className="contact-active-glow" layoutId="active-contact" transition={interfaceSpring} />}
  </>;
  const className = 'contact-row' + (active ? ' active' : '') + (grouped ? ' grouped' : '') + (c.status === 'pending' ? ' pending' : '');
  if (c.status === 'pending') {
    return <div className={className}>{contents}</div>;
  }
  return (
    <motion.button
      type="button"
      className={className}
      onClick={props.onClick}
    >
      {contents}
    </motion.button>
  );
}

export function ChatList(props: {
  contacts: ContactVM[];
  roots: Record<string, RootMetaVM>;
  selected: string | null;
  onSelect: (id: string) => void;
  onInvite: () => void;
  onSettings: () => void;
  onApprovePending: (cid: string) => Promise<boolean>;
  onRejectPending: (cid: string) => Promise<boolean>;
}) {
  const { contacts, roots, selected } = props;
  const [q, setQ] = useState('');
  const [listMode, setListMode] = useState<ConversationListMode>(
    () => readConversationListMode(),
  );
  const match = (c: ContactVM) => c.name.toLowerCase().includes(q.toLowerCase());

  const active = contacts.filter((c) => c.status !== 'pending' && match(c));
  const pending = contacts.filter((c) => c.status === 'pending' && match(c));
  const recent = sortConversationsByActivity(active);
  const identityGroups = groupConversationsByIdentity(active, roots);

  const empty = active.length === 0 && pending.length === 0;
  const chooseMode = (mode: ConversationListMode) => {
    setListMode(writeConversationListMode(mode));
  };
  const modeOptions: Array<{ id: ConversationListMode; label: string }> = [
    { id: 'recent', label: 'Recent' },
    { id: 'identity', label: 'By identity' },
  ];
  const moveModeFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: ConversationListMode,
  ) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'recent'
        : event.key === 'End'
          ? 'identity'
          : current === 'recent'
            ? 'identity'
            : 'recent';
    chooseMode(next);
    document.getElementById(`conversation-list-${next}`)?.focus();
  };

  return (
    <div className="listcol">
      <div className="listcol-head">
        <div className="listcol-titlebar">
          <h2 id="chat-list-title" className="listcol-title messenger-lockup" tabIndex={-1}>
            <span className="messenger-brand-ours">Ours</span>{' '}
            <span className="messenger-brand-product">Messenger</span>
          </h2>
          <div className="listcol-actions">
            <button className="btn sm primary" onClick={props.onInvite}>
              <Icon name="invite" size={15} />
              Invite
            </button>
            <button className="btn sm" onClick={props.onSettings}>
              <Icon name="settings" size={15} />
              Settings
            </button>
          </div>
        </div>
        <div className="search">
          <Icon name="search" />
          <input
            className="field"
            placeholder="Search people, agents, apps…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="conversation-list-modes" role="tablist" aria-label="Conversation list layout">
          {modeOptions.map((option) => (
            <button
              key={option.id}
              id={`conversation-list-${option.id}`}
              type="button"
              role="tab"
              aria-selected={listMode === option.id}
              aria-controls="conversation-list-panel"
              tabIndex={listMode === option.id ? 0 : -1}
              className={listMode === option.id ? 'active' : ''}
              onClick={() => chooseMode(option.id)}
              onKeyDown={(event) => moveModeFocus(event, option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div
        id="conversation-list-panel"
        className="listcol-scroll"
        role="tabpanel"
        aria-labelledby={`conversation-list-${listMode}`}
      >
        {listMode === 'recent' && recent.length > 0 && (
          <div className="conversation-group">
            {recent.map((c) => (
              <ContactRow key={c.id} c={c} active={selected === c.id} onClick={() => props.onSelect(c.id)} />
            ))}
          </div>
        )}

        {listMode === 'identity' && identityGroups.map((group) => (
          <div key={group.id}>
            <div className="group-label" title={group.note}>
              {group.rootId && <Icon name="clusters" />}
              <span>{group.label}</span>
              {group.note && <span className="gl-note">· {group.note}</span>}
            </div>
            <div className="conversation-group">
              {group.contacts.map((c) => (
                <ContactRow
                  key={c.id}
                  c={c}
                  grouped={group.rootId !== null}
                  active={selected === c.id}
                  onClick={() => props.onSelect(c.id)}
                />
              ))}
            </div>
          </div>
        ))}

        {pending.length > 0 && (
          <div>
            <div className="group-label">
              <span>Pending</span>
            </div>
            <div className="conversation-group">
              {pending.map((c) => (
                <ContactRow
                  key={c.id}
                  c={c}
                  active={false}
                  onClick={() => {}}
                  onApprove={() => props.onApprovePending(c.id.slice('pending:'.length))}
                  onReject={() => props.onRejectPending(c.id.slice('pending:'.length))}
                />
              ))}
            </div>
          </div>
        )}

        {empty && (
          <p className="muted" style={{ padding: '14px 10px', fontSize: '0.85rem' }}>
            No contacts yet — share an invite to start.
          </p>
        )}
      </div>
    </div>
  );
}

export function ContactScreen(props: {
  contact: ContactVM;
  messages: ChatMessage[];
  onBack: () => void;
  onRename: (alias: string) => void;
  onRemove: () => void;
  onOpenMessage: (key: string) => void;
  indexOffset?: number;
  onSendText: (text: string, replyToWireId?: string) => Promise<string | void>;
  onSendFile?: (att: PendingAttachment, replyToWireId?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.contact.name);
  const [showMedia, setShowMedia] = useState(false);
  const [previewRec, setPreviewRec] = useState<FileRecord | null>(null);
  const renameSettledRef = useRef(false);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || showMedia || previewRec || editing) return;
      event.preventDefault();
      props.onBack();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [editing, previewRec, props.onBack, showMedia]);
  const saveName = () => {
    if (renameSettledRef.current) return;
    renameSettledRef.current = true;
    const next = name.trim();
    if (next && next !== props.contact.name) props.onRename(next);
    else setName(props.contact.name);
    setEditing(false);
  };
  return <div className="detail contact-screen">
    <div className="detail-head contact-screen-head">
      <button type="button" className="icon-btn detail-back contact-back" aria-label="Back to conversation" onClick={props.onBack}><Icon name="back" /></button>
      <strong>Contact</strong>
    </div>
    <div className="contact-screen-scroll">
      <section className="contact-hero" aria-labelledby="contact-screen-name">
        <div className="avatar accent contact-avatar-large" aria-hidden>{props.contact.initials}</div>
        {editing ? <input id="contact-screen-name" className="field contact-name-input" value={name} autoFocus onChange={(event) => setName(event.target.value)} onBlur={saveName} onKeyDown={(event) => { if (event.key === 'Enter') saveName(); if (event.key === 'Escape') { renameSettledRef.current = true; setName(props.contact.name); setEditing(false); } }} /> : <h2 id="contact-screen-name">{props.contact.name}</h2>}
        <p><Icon name="lock" size={13} /> End-to-end encrypted connection</p>
      </section>
      <section className="contact-action-group" aria-label="Contact actions">
        <button type="button" onClick={() => setShowMedia(true)}><span><Icon name="paperclip" />Shared photos, files, and links</span><Icon name="chevron" /></button>
        <button type="button" onClick={() => { renameSettledRef.current = false; setName(props.contact.name); setEditing(true); }}><span><Icon name="edit" />Rename contact</span><Icon name="chevron" /></button>
      </section>
      <section className="contact-identity" aria-labelledby="contact-identity-title">
        <h3 id="contact-identity-title">Verified identity</h3>
        {props.contact.roleId && <p>Role <strong>{props.contact.roleId}</strong> of <strong>{props.contact.rootName}</strong></p>}
        <code>{props.contact.id}</code>
        <button type="button" className="btn sm" onClick={() => void navigator.clipboard.writeText(props.contact.id)}><Icon name="copy" size={14} />Copy identity</button>
      </section>
      <button type="button" className="contact-remove" onClick={props.onRemove}><Icon name="trash" />Remove contact</button>
    </div>
    {showMedia && <ChatMediaPanel messages={props.messages} indexOffset={props.indexOffset} onClose={() => setShowMedia(false)} onJump={props.onOpenMessage} onPreview={(record) => { setShowMedia(false); setPreviewRec(record); }} />}
    {previewRec && (isHtmlAttachment(previewRec.filename, previewRec.mime)
      ? <HtmlPreview rec={previewRec} onClose={() => setPreviewRec(null)} />
      : <MarkdownPreview rec={previewRec} onClose={() => setPreviewRec(null)} onSendText={props.onSendText} onSendFile={props.onSendFile} />)}
  </div>;
}

interface ReplyDraft {
  wireId: string;
  author: string;
  text: string;
}

const timelineMessageId = (key: string) => `chat-message-${encodeURIComponent(key)}`;

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Swipe-to-reply: drag any eligible bubble inward toward the conversation
// centre. Touch/pen only — a mouse keeps text selection and
// the hover Reply button. `touch-action: pan-y` leaves vertical scrolling with
// the browser until the 10px horizontal-intent threshold wins.
function SwipeReplyRow(props: {
  dir: 'in' | 'out';
  canReply: boolean;
  onReply: () => void;
  children: ReactNode;
  after?: ReactNode; // desktop hover reply button — outside the translating wrap
  rowClass?: string; // full msg-row modifier string (dir + grouping); defaults to dir
}) {
  const { dir, canReply, onReply } = props;
  const row = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLDivElement>(null);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  // Swipe inward toward the conversation: right for a left-aligned incoming
  // bubble, left for a right-aligned outgoing bubble.
  const REPLY_DIRECTION = dir === 'in' ? 1 : -1;
  const THRESH = SWIPE_DISTANCE_PX;
  const MAX = 84; // rubber-band cap
  const idleGesture = () => ({
    id: -1, x0: 0, y0: 0, mode: 'idle' as 'idle' | 'maybe' | 'drag', armed: false,
    distance: 0, samples: [] as Array<{ x: number; time: number }>,
  });
  const st = useRef(idleGesture());

  const paint = (dx: number) => {
    const s = slider.current;
    const c = cue.current;
    const reduce = reducedMotion();
    if (s) s.style.transform = dx && !reduce ? `translateX(${dx}px)` : '';
    if (c) {
      const p = Math.min(1, Math.abs(dx) / THRESH);
      c.style.opacity = String(p);
      c.style.transform = reduce ? 'scale(1)' : `scale(${0.5 + 0.5 * p})`;
    }
  };

  const clearGesture = (pointerId: number, commit: boolean) => {
    const s = st.current;
    if (s.id !== pointerId) return;
    const fire = commit && s.mode === 'drag' && shouldCommitReply(s.distance, s.samples);
    // Clear ownership before releasePointerCapture: releasing can synchronously
    // dispatch lostpointercapture, whose cleanup must remain idempotent.
    st.current = idleGesture();
    slider.current?.classList.remove('swiping');
    cue.current?.classList.remove('armed');
    paint(0);
    const owner = row.current;
    if (owner?.hasPointerCapture?.(pointerId)) owner.releasePointerCapture(pointerId);
    if (fire) onReplyRef.current();
  };

  useEffect(() => {
    const owner = row.current;
    if (!owner) return;
    // React's synthetic lost-capture event is not delivered consistently by
    // every touch/pen path. Listen at the capture owner as the native source of
    // truth; the React handler below is a harmless idempotent fallback.
    const lost = (event: PointerEvent) => clearGesture(event.pointerId, false);
    owner.addEventListener('lostpointercapture', lost);
    return () => {
      owner.removeEventListener('lostpointercapture', lost);
      const pointerId = st.current.id;
      if (pointerId !== -1) clearGesture(pointerId, false);
    };
  }, []);

  const onDown = (e: React.PointerEvent) => {
    const target = e.target as Element;
    const selection = window.getSelection?.();
    if (!canReply || !e.isPrimary || e.pointerType === 'mouse' || e.button !== 0 || st.current.id !== -1
      || (selection && !selection.isCollapsed)
      || target.closest('a, button, input, textarea, select, [role="button"], audio, video, img, [draggable="true"], .filecard, .filecard-bubble, .image-bubble, .voice-bubble, .ours-message-file, .attachment')) return;
    st.current = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: 'maybe', armed: false,
      distance: 0, samples: [{ x: e.clientX * REPLY_DIRECTION, time: e.timeStamp }],
    };
    paint(0);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = st.current;
    if (s.id !== e.pointerId || s.mode === 'idle') return;
    const dxr = e.clientX - s.x0;
    const dyr = e.clientY - s.y0;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) {
      clearGesture(e.pointerId, false);
      return;
    }
    if (s.mode === 'maybe') {
      const intent = classifyReplyIntent(dxr * REPLY_DIRECTION, dyr);
      if (intent === 'pending') return;
      // Commit only after horizontal inward intent wins. Until then pan-y
      // remains browser-owned, preserving native conversation scrolling.
      if (intent === 'drag') {
        s.mode = 'drag';
        e.currentTarget.setPointerCapture?.(e.pointerId);
        slider.current?.classList.add('swiping');
      } else {
        s.mode = 'idle';
        return;
      }
    }
    e.preventDefault();
    const time = e.timeStamp;
    s.samples.push({ x: e.clientX * REPLY_DIRECTION, time });
    s.samples = s.samples.filter((sample) => time - sample.time <= 120);
    // Inward magnitude, rubber-banded past the threshold and hard-capped.
    let d = dxr * REPLY_DIRECTION;
    if (d < 0) d = 0;
    if (d > THRESH) d = THRESH + (d - THRESH) * 0.35;
    d = Math.min(d, MAX);
    s.distance = d;
    const dx = d * REPLY_DIRECTION;
    const armed = Math.abs(dx) >= THRESH;
    if (armed !== s.armed) {
      s.armed = armed;
      cue.current?.classList.toggle('armed', armed);
      if (armed) navigator.vibrate?.(10);
    }
    paint(dx);
  };
  const onUp = (e: React.PointerEvent) => {
    const s = st.current;
    if (s.id === e.pointerId && s.mode === 'drag') {
      s.samples.push({ x: e.clientX * REPLY_DIRECTION, time: e.timeStamp });
      s.distance = Math.max(0, (e.clientX - s.x0) * REPLY_DIRECTION);
      s.armed = s.distance >= THRESH;
    }
    clearGesture(e.pointerId, true);
  };

  return (
    <div
      ref={row}
      className={'msg-row ' + (props.rowClass ?? dir)}
      style={canReply ? { touchAction: 'pan-y' } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={(e) => clearGesture(e.pointerId, false)}
      onLostPointerCapture={(e) => clearGesture(e.pointerId, false)}
    >
      {canReply && (
        <span className="swipe-cue" ref={cue} aria-hidden>
          <Icon name="reply" size={16} />
        </span>
      )}
      <div className="bubble-wrap" ref={slider}>
        {props.children}
      </div>
      {props.after}
    </div>
  );
}

export function Conversation(props: {
  contact: ContactVM | null;
  // A bounded page of the history, newest-last. `hiddenEarlier` is how many
  // older entries exist above the page; onLoadEarlier widens the window.
  messages: ChatMessage[];
  unreadOpen?: { wireId: string; count: number } | null;
  hiddenEarlier?: number;
  onLoadEarlier?: () => void;
  onBack: () => void;
  onOpenContact?: () => void;
  /** Resolves with the canonical wire id of the delivered message when it has one. */
  onSend: (text: string, replyToWireId?: string, signal?: AbortSignal) => Promise<string | void>;
  /** Canonical state is still catching up: shown inline, never as a screen. */
  syncing?: 'connecting' | 'updating' | null;
  /** @deprecated Contact management lives on ContactScreen. */
  onRemove?: () => void;
  /** @deprecated Contact management lives on ContactScreen. */
  onRename?: (alias: string) => void;
  onDraftChange?: (hasText: boolean) => void;
  emptyOverride?: ReactNode;
  onSendFile?: (att: PendingAttachment, replyToWireId?: string) => Promise<void>;
  onFetchFile?: (wireId: string) => Promise<void>;
}) {
  const { contact, messages } = props;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // A submitted message is ONE timeline entry from the moment it is typed: the
  // locally rendered bubble and the server-confirmed message that replaces it
  // share a key and are never both on screen. `wireId` is filled in when the
  // send resolves and is what the confirmation is recognised by.
  const [optimisticSend, setOptimisticSend] = useState<
    { key: string; message: ChatMessage; wireId: string | null } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [unknownSend, setUnknownSend] = useState<{
    draft: string;
    text: string;
    reply: ReplyDraft | null;
    wireIds: ReadonlySet<string>;
  } | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // attachments: picked/recorded file awaiting send; active voice recording
  const [pendingAtt, setPendingAtt] = useState<PendingAttachment | null>(null);
  const [voiceActive, setVoiceActive] = useState(false); // hold-to-record in progress
  const [sendingFile, setSendingFile] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const [previewRec, setPreviewRec] = useState<FileRecord | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const unreadPlacedRef = useRef(false);
  const [jumpLatest, setJumpLatest] = useState(false);
  const [newSinceAway, setNewSinceAway] = useState(0);
  const jumpMeasureFrameRef = useRef<number | null>(null);
  const pinnedToBottomRef = useRef(true);
  const previousContactRef = useRef<string | null>(null);
  const fileReadGenerationRef = useRef(0);
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  // wire id -> the key its optimistic bubble already rendered under, so the
  // confirmation reuses that element instead of mounting a second one.
  const sentKeysRef = useRef(new Map<string, string>());
  const sendSeqRef = useRef(0);
  // Target and last observed position of a scroll WE started, so its own
  // frames are not mistaken for the reader choosing to leave the newest
  // message — and so a scroll that moves the other way is recognised as
  // someone else taking over.
  const followTargetRef = useRef<number | null>(null);
  const followTopRef = useRef<number | null>(null);
  const messageCountRef = useRef(0);
  const newestMessageRef = useRef<string | null>(null);
  useEffect(() => {
    setDraft('');
    setError(null);
    setUnknownSend(null);
    setOptimisticSend(null);
    setReplyTo(null);
    setPendingAtt(null);
    setVoiceActive(false);
    setSendingFile(false);
    setProcessingFile(false);
    fileReadGenerationRef.current += 1;
    setPreviewRec(null);
    sentKeysRef.current.clear();
    followTargetRef.current = null;
    followTopRef.current = null;
  }, [contact?.id]);

  useEffect(() => {
    if (!unknownSend) return;
    const replyWireId = unknownSend.reply?.wireId;
    const confirmed = messages.some((message) =>
      message.kind !== 'file'
      && message.dir === 'out'
      && !!message.wireId
      && !unknownSend.wireIds.has(message.wireId)
      && message.text === unknownSend.text
      && (message.replyTo?.wireId ?? undefined) === replyWireId);
    if (!confirmed) return;
    setUnknownSend(null);
    setError(null);
    setDraft((current) => current === unknownSend.draft ? '' : current);
    setReplyTo((current) => current === unknownSend.reply ? null : current);
  }, [messages, unknownSend]);

  // The confirmation of a send and its optimistic bubble are the same message.
  // Rendering both — even for one frame — grows the timeline by a row that then
  // collapses, which is exactly the jump the reader sees. Dropping the local
  // copy in the SAME render that the canonical one arrives in keeps the height
  // constant across the swap.
  const confirmed = !!optimisticSend?.wireId
    && messages.some((message) => message.wireId === optimisticSend.wireId);
  const displayMessages = useMemo(
    () => optimisticSend && !confirmed ? [...messages, optimisticSend.message] : messages,
    [messages, optimisticSend, confirmed],
  );
  useEffect(() => {
    if (confirmed) setOptimisticSend(null);
  }, [confirmed]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = '0px';
    const height = Math.max(44, Math.min(input.scrollHeight, 132));
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > 132 ? 'auto' : 'hidden';
  }, [draft, contact?.id]);

  // Following the newest message is a movement, not a teleport. Assigning
  // scrollTop drags the whole thread past the reader's eyes in a single frame,
  // which is what reads as a jerk; an opened thread has nothing to follow yet
  // and still lands instantly.
  const followBottom = (smooth: boolean) => {
    const scroller = messageScrollRef.current;
    if (!scroller) return;
    const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (Math.abs(scroller.scrollTop - target) < 1) {
      followTargetRef.current = null;
      followTopRef.current = null;
      return;
    }
    const animate = smooth && !reducedMotion();
    followTargetRef.current = animate ? target : null;
    followTopRef.current = animate ? scroller.scrollTop : null;
    if (animate) scroller.scrollTo({ top: target, behavior: 'smooth' });
    else scroller.scrollTop = target;
  };

  const measureJumpLatest = () => {
    if (jumpMeasureFrameRef.current !== null) return;
    jumpMeasureFrameRef.current = requestAnimationFrame(() => {
      jumpMeasureFrameRef.current = null;
      const scroller = messageScrollRef.current;
      if (!scroller) return;
      const away = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 48;
      setJumpLatest(away);
      if (!away) setNewSinceAway(0);
    });
  };

  // The custom timeline owns its scroll behavior. Every opened/switched thread
  // starts at the newest message. Subsequent messages follow only while the
  // reader is already near the bottom, so reading history is never interrupted.
  useLayoutEffect(() => {
    if (!contact) {
      previousContactRef.current = null;
      pinnedToBottomRef.current = true;
      messageCountRef.current = 0;
      return;
    }
    const scroller = messageScrollRef.current;
    if (!scroller) return;
    const switched = previousContactRef.current !== contact.id;
    const previousCount = messageCountRef.current;
    const grew = displayMessages.length !== previousCount;
    const newestMessage = displayMessages.at(-1);
    const newestKey = newestMessage ? (newestMessage.wireId || `${newestMessage.date}:${newestMessage.text}`) : null;
    const previousNewest = newestMessageRef.current;
    messageCountRef.current = displayMessages.length;
    newestMessageRef.current = newestKey;
    // When nothing was added the scroller itself is the authority on where the
    // reader is. Scroll events arrive a frame late, and this component
    // re-renders on every refresh, so a stale "pinned" left over from before
    // the reader scrolled away would drag them back to the bottom.
    if (!switched && !grew && followTargetRef.current === null) {
      pinnedToBottomRef.current = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 48;
    }
    if (switched || pinnedToBottomRef.current) {
      followBottom(grew && !switched && previousContactRef.current !== null);
      pinnedToBottomRef.current = true;
    } else if (grew && displayMessages.length > previousCount && newestKey !== previousNewest) {
      const previousIndex = previousNewest === null ? -1 : displayMessages.findIndex((message) =>
        (message.wireId || `${message.date}:${message.text}`) === previousNewest);
      setNewSinceAway((count) => count + Math.max(1, displayMessages.length - Math.max(0, previousIndex + 1)));
    }
    previousContactRef.current = contact.id;
    measureJumpLatest();
  }, [contact, displayMessages.length]);

  useLayoutEffect(() => {
    if (unreadPlacedRef.current || !props.unreadOpen || window.location.hash.startsWith('#chat-message-')) return;
    const scroller = messageScrollRef.current;
    const target = document.getElementById(`unread-${timelineMessageId(props.unreadOpen.wireId)}`);
    if (!scroller || !target) return;
    scroller.scrollTop = Math.max(0, target.offsetTop - 16);
    pinnedToBottomRef.current = false;
    unreadPlacedRef.current = true;
    measureJumpLatest();
  }, [props.unreadOpen, displayMessages.length]);

  useLayoutEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#chat-message-')) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    pinnedToBottomRef.current = false;
  }, [contact?.id, displayMessages.length]);

  // Loading older entries prepends DOM above the current viewport. Compensate
  // by the exact height delta so the message the reader was looking at does
  // not jump away.
  useLayoutEffect(() => {
    const previous = prependScrollRef.current;
    const scroller = messageScrollRef.current;
    if (previous === null || !scroller) return;
    // AnimatePresence commits its motion children after this component's
    // layout effect. Measure on the next frame so their real heights are part
    // of the compensation rather than clearing the anchor too early.
    const frame = requestAnimationFrame(() => {
      if (prependScrollRef.current !== previous) return;
      scroller.scrollTop = previous.top + scroller.scrollHeight - previous.height;
      prependScrollRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [displayMessages.length]);

  useEffect(() => {
    const scroller = messageScrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const content = scroller.firstElementChild;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      // Content that grows on its own (an image finishing, a bubble reflowing)
      // is not a new message: follow it instantly, unless an animated follow is
      // already running, in which case retarget it instead of cutting it off.
      if (pinnedToBottomRef.current) followBottom(followTargetRef.current !== null);
      measureJumpLatest();
    });
    observer.observe(content);
    // Composer/reply rows and mobile browser chrome resize the viewport without
    // changing the timeline content. Observe both boxes so an intentionally
    // pinned reader stays on the newest message through those interactions.
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      if (jumpMeasureFrameRef.current !== null) cancelAnimationFrame(jumpMeasureFrameRef.current);
    };
  }, [contact?.id]);

  const acceptFile = async (f: File) => {
    const generation = ++fileReadGenerationRef.current;
    setError(null);
    setProcessingFile(true);
    try {
      if (f.size > MAX_FILE_BYTES && isCompressibleImage(f.type, f.name)) {
        const compressed = await compressImageForSend(f, MAX_FILE_BYTES);
        if (generation !== fileReadGenerationRef.current) return;
        setPendingAtt({
          filename: compressed.filename,
          mime: compressed.mime,
          bytes: compressed.bytes,
          originalSize: compressed.originalSize,
        });
        return;
      }
      if (f.size > MAX_FILE_BYTES) {
        setError(`"${f.name}" is ${fmtSize(f.size)} — files up to ${fmtSize(MAX_FILE_BYTES)} can be sent.`);
        return;
      }
      const buf = await f.arrayBuffer();
      if (generation !== fileReadGenerationRef.current) return;
      setPendingAtt({
        filename: f.name || 'file',
        mime: f.type || 'application/octet-stream',
        bytes: new Uint8Array(buf),
      });
    } catch (err) {
      if (generation === fileReadGenerationRef.current) {
        setError(`Photo optimization failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (generation === fileReadGenerationRef.current) setProcessingFile(false);
    }
  };

  const sendPendingFile = () => {
    if (!pendingAtt || !props.onSendFile || sendingFile) return;
    setSendingFile(true);
    props.onSendFile(pendingAtt, replyTo?.wireId)
      .then(() => { setPendingAtt(null); setReplyTo(null); })
      .catch((err) => setError(`File send failed: ${String(err)} — it was not delivered.`))
      .finally(() => setSendingFile(false));
  };

  // Report whether the composer holds unsent text, so an update reload can defer
  // to a banner rather than discard a half-written message.
  const onDraftChange = props.onDraftChange;
  useEffect(() => {
    onDraftChange?.(draft.trim().length > 0 || sending);
    return () => onDraftChange?.(false);
  }, [draft, sending, onDraftChange]);

  // Resolve a message's reply pointer (wire id) back to the quoted message we
  // still hold, so the bubble can render the author + snippet.
  const byWireId = new Map<string, ChatMessage>();
  for (const m of displayMessages) if (m.wireId) byWireId.set(m.wireId, m);
  // A cowork room relays every message as a signed JSON body, so this is where a
  // room conversation stops being a wall of JSON: the body becomes an author +
  // role + what they said, and the room's own notices become system lines. Any
  // message that is not a room body renders exactly as it did before.
  // The mounted message window is bounded; keep room decoding bounded too by
  // parsing each visible message once per page refresh, not at every call site.
  const roomLines = useMemo(() => {
    const lines = new Map<ChatMessage, RoomLine | null>();
    for (const message of displayMessages) {
      lines.set(
        message,
        message.kind === 'file'
          ? null
          : message.dir === 'in'
            ? roomLineForContact(contact?.announcedName ?? '', message.text)
            : null,
      );
    }
    return lines;
  }, [displayMessages, contact?.announcedName]);
  const roomLineOf = (m: ChatMessage): RoomLine | null => roomLines.get(m) ?? null;
  const authorOf = (m: ChatMessage) => {
    if (m.dir === 'out') return 'You';
    const room = roomLineOf(m);
    if (room) return room.variant === 'chat' ? room.author : contact?.name ?? 'Them';
    return contact?.name ?? 'Them';
  };
  // A short label for the reply-bar + quote snippet — text for text messages, a
  // type label for files/photos/voice (their text summary is empty), so replying
  // to a file bubble quotes "Photo"/"Voice message"/filename, not a blank line.
  const msgPreviewText = (m: ChatMessage): string => {
    if (m.kind === 'file') {
      if (m.mime?.startsWith('image/')) return 'Photo';
      if (isVoiceNote(m.mime ?? '', m.filename ?? '')) return 'Voice message';
      return m.filename || 'File';
    }
    const room = roomLineOf(m);
    // Quoting a room message quotes what was SAID, not the envelope it arrived in.
    return room ? room.text || roomMessagePreview(room) : m.text;
  };
  const quoteFor = (m: ChatMessage): { author: string; text: string } | null => {
    if (!m.replyTo) return null;
    const src = byWireId.get(m.replyTo.wireId);
    return src ? { author: authorOf(src), text: msgPreviewText(src) } : { author: '', text: 'Original message' };
  };

  if (!contact) {
    if (props.emptyOverride) return <>{props.emptyOverride}</>;
    return (
      <div className="detail">
        <div className="detail-empty">
          <Icon name="chat" />
          <div>
            <div style={{ fontWeight: 650, color: 'var(--text-2)' }}>Select a conversation</div>
            <div style={{ fontSize: '0.85rem' }}>Chat with people, agents and apps across ours.</div>
          </div>
        </div>
      </div>
    );
  }

  const send = async () => {
    const submittedDraft = draft;
    const text = submittedDraft.trim();
    const repeatsUnknown = !!unknownSend
      && submittedDraft === unknownSend.draft
      && (replyTo?.wireId ?? undefined) === unknownSend.reply?.wireId;
    if (!text || sendingRef.current || repeatsUnknown) return;
    if (unknownSend) setUnknownSend(null);
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const submittedReply = replyTo;
    const replyWireId = submittedReply?.wireId;
    const controller = new AbortController();
    let timedOut = false;
    let timeout = 0;
    // A submitted draft is no longer editable content. Clear it immediately so
    // a healthy send feels instant, while keeping the exact snapshot available
    // for a deterministic restore if the transaction fails or becomes unknown.
    setDraft('');
    setReplyTo(null);
    const optimisticKey = `optimistic-${++sendSeqRef.current}`;
    setOptimisticSend({
      key: optimisticKey,
      wireId: null,
      message: {
        dir: 'out', text, date: new Date().toISOString(), read: true, wireId: '',
        replyTo: replyWireId ? { wireId: replyWireId } : null,
      },
    });
    try {
      const wireId = await Promise.race([
        props.onSend(text, replyWireId, controller.signal),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('send timeout'));
          }, TEXT_SEND_TIMEOUT_MS);
        }),
      ]);
      // Hand the bubble already on screen over to its confirmation: same key,
      // same element, so the reader never sees the message twice or the row
      // re-enter. Without a wire id there is nothing to hand over to, and the
      // local copy simply retires.
      if (wireId) {
        sentKeysRef.current.set(wireId, optimisticKey);
        setOptimisticSend((current) => current?.key === optimisticKey ? { ...current, wireId } : current);
      } else {
        setOptimisticSend((current) => current?.key === optimisticKey ? null : current);
      }
      setUnknownSend(null);
    } catch (err) {
      setOptimisticSend(null);
      setDraft((current) => current === '' ? submittedDraft : current);
      setReplyTo((current) => current === null ? submittedReply : current);
      if (timedOut || !(err instanceof ApiError)) {
        setUnknownSend({
          draft: submittedDraft,
          text,
          reply: submittedReply,
          wireIds: new Set(messages.flatMap((message) => message.wireId ? [message.wireId] : [])),
        });
        setError(`${timedOut ? 'Send timed out' : 'Send connection was interrupted'} — delivery status is unknown. Check the conversation; edit the draft before sending again.`);
      } else {
        setError(`Send failed: ${String(err)} — the message was not delivered.`);
      }
    } finally {
      window.clearTimeout(timeout);
      sendingRef.current = false;
      setSending(false);
    }
  };

  const unknownDuplicate = !!unknownSend
    && draft === unknownSend.draft
    && (replyTo?.wireId ?? undefined) === unknownSend.reply?.wireId;

  // A message can only be replied to once it has a wire id (pre-1.4 entries
  // restored from an old backup have none).
  const startReply = (m: ChatMessage) => {
    if (!m.wireId) return;
    setReplyTo({ wireId: m.wireId, author: authorOf(m), text: msgPreviewText(m) });
  };

  return (
    <div className="detail detail-chat">
      <div className="detail-head">
        <div className="conv-peer">
          <button className="icon-btn detail-back" onClick={props.onBack}>
            <Icon name="back" />
          </button>
          <button type="button" className="conv-contact-trigger" data-contact-trigger onClick={props.onOpenContact} disabled={!props.onOpenContact} aria-label={`Open contact details for ${contact.name}`}>
            <span className="avatar accent">{contact.initials}</span>
            <span className="conv-peer-meta">
              <span className="conv-peer-name">{contact.name}</span>
            {/* Opening the app from a notification lands here before the
                messages do. An empty thread with no explanation reads as a
                lost message, so the header says what is happening — inline,
                never a screen, and driven by state so it cannot stick on. */}
            {props.syncing && (
              <div className="conv-sync" role="status" aria-live="polite">
                <span className="conv-sync-dot" aria-hidden />
                {props.syncing === 'connecting' ? 'Connecting…' : 'Updating…'}
              </div>
            )}
            {!props.syncing && <span className="conv-contact-status"><Icon name="lock" size={11} />Encrypted connection</span>}
            </span>
          </button>
        </div>
      </div>
      <div
        key={contact.id}
        className="messages"
        ref={messageScrollRef}
        tabIndex={-1}
        aria-label="Conversation timeline"
        onScroll={(e) => {
          const el = e.currentTarget;
          const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
          // Frames of our own animated follow are not the reader scrolling
          // away — reading them as such would strand the thread mid-animation
          // and stop it following the next message. That follow only ever
          // moves toward the newest message, so a scroll that goes the other
          // way is someone else steering and takes the scroller back.
          if (followTargetRef.current !== null) {
            const previous = followTopRef.current;
            if (previous === null || el.scrollTop >= previous - 1) {
              followTopRef.current = el.scrollTop;
              if (distance <= 4) {
                followTargetRef.current = null;
                followTopRef.current = null;
              }
              return;
            }
            followTargetRef.current = null;
            followTopRef.current = null;
          }
          pinnedToBottomRef.current = distance <= 48;
          measureJumpLatest();
        }}
        // Any deliberate gesture hands scrolling back to the reader, even
        // mid-animation, so an interrupted follow can never latch.
        onPointerDown={() => { followTargetRef.current = null; followTopRef.current = null; }}
        onTouchStart={() => { followTargetRef.current = null; followTopRef.current = null; }}
        onWheel={() => { followTargetRef.current = null; followTopRef.current = null; }}
        onDragOver={(e) => { if (props.onSendFile) e.preventDefault(); }}
        onDrop={(e) => {
          if (!props.onSendFile) return;
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) acceptFile(f);
        }}
      >
        <div className="messages-inner">
          <div className="e2e-note">
            <Icon name="lock" />
            End-to-end encrypted · the broker only sees ciphertext
          </div>
          {(props.hiddenEarlier ?? 0) > 0 && props.onLoadEarlier && (
            <button
              className="btn sm chat-load-earlier"
              onClick={() => {
                // A programmatic scrollIntoView or a very fast tap can precede
                // the browser's scroll event. Loading history is itself proof
                // that the reader is not pinned to the newest message.
                pinnedToBottomRef.current = false;
                const scroller = messageScrollRef.current;
                prependScrollRef.current = scroller ? { height: scroller.scrollHeight, top: scroller.scrollTop } : null;
                props.onLoadEarlier?.();
              }}
            >
              Load earlier messages ({props.hiddenEarlier} remaining)
            </button>
          )}
          {/* A bounded newest-last page from packet history. Files resolve
              their bytes independently by wire id; ordering stays exact. Keys
              use the ABSOLUTE history index so loading earlier entries never
              re-keys (and never re-animates) the ones already on screen. */}
          <AnimatePresence initial={false}>
            {displayMessages.map((m, i) => {
              // A message the reader has already seen keeps its element for as
              // long as it is on screen: a confirmed send inherits the key its
              // own optimistic bubble used, so the swap is a re-render and not
              // an exit + enter that would briefly double the row.
              const key = m === optimisticSend?.message
                ? optimisticSend.key
                : (m.wireId && sentKeysRef.current.get(m.wireId))
                  || m.wireId
                  || `${m.date}-${(props.hiddenEarlier ?? 0) + i}`;
              // The anchor stays addressable by wire id — that is what push
              // notification deep links and reply jumps resolve.
              const domId = timelineMessageId(m.wireId || key);
              const prev = displayMessages[i - 1];
              const next = displayMessages[i + 1];
              const room = roomLineOf(m);
              // A system line breaks the bubble run on either side of it, and a
              // room chat line groups by SPEAKER — consecutive members are
              // different people arriving on the same 'in' side.
              const speaker = (x?: ChatMessage) => {
                if (!x) return null;
                const line = roomLineOf(x);
                if (line) {
                  return line.variant === 'system'
                    ? 'room:system'
                    : `room:chat:${line.author}\u001f${line.role}`;
                }
                return x.dir;
              };
              const me = speaker(m);
              const contTop = !!prev && speaker(prev) === me && me !== 'room:system';
              const contBot = !!next && speaker(next) === me && me !== 'room:system';
              const grpCls =
                (m.dir === 'out' ? 'out' : 'in') + (contTop ? ' cont-top' : '') + (contBot ? ' cont-bot' : '');
              const replyButton = m.wireId ? (
                <button className="msg-reply" title="Reply" onClick={() => startReply(m)}>
                  <Icon name="reply" size={15} />
                </button>
              ) : null;

              // The room speaking in its own voice — a briefing, a membership
              // change, an operator notice. Centred, unbubbled, unmistakably
              // not a person talking, and never replied to.
              if (room && room.variant === 'system') {
                const presentation = room.presentation ?? 'system';
                return (
                  <motion.div
                    className="message-motion"
                    key={key}
                    id={domId}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={interfaceSpring}
                  >
                    {m.wireId === props.unreadOpen?.wireId && <div id={`unread-${domId}`} className="unread-divider" role="separator"><span>Unread messages</span></div>}
                    <div className={`room-system room-${presentation}-card`} role="note">
                      {room.label && <span className="room-system-label">{room.label}</span>}
                      {room.roomName && <strong className="room-card-name">{room.roomName}</strong>}
                      <MessageMarkdown text={room.text} className="room-system-text message-markdown" />
                      {!!room.details?.length && (
                        <ul className="room-card-details" aria-label="Room event details">
                          {room.details.map((detail) => <li key={detail}>{detail}</li>)}
                        </ul>
                      )}
                      <span className="room-card-provenance">
                        {room.authoredBy && <span className="room-card-author">{room.authoredBy}</span>}
                        <span className="room-system-at">{fmtTime(room.authoredAt || m.date)}</span>
                      </span>
                    </div>
                  </motion.div>
                );
              }

              if (m.kind === 'file') {
                const rec: FileRecord = fileRecord(m.wireId) ?? {
                  id: m.wireId,
                  dir: m.dir,
                  filename: m.filename ?? 'file',
                  mime: m.mime ?? 'application/octet-stream',
                  size: 0,
                  date: m.date,
                };
                return (
                  <motion.div
                    className="message-motion"
                    key={key}
                    id={domId}
                    initial={{ opacity: 0, y: 12, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={interfaceSpring}
                  >
                    {m.wireId === props.unreadOpen?.wireId && <div id={`unread-${domId}`} className="unread-divider" role="separator"><span>Unread messages</span></div>}
                    <SwipeReplyRow
                      dir={m.dir === 'out' ? 'out' : 'in'}
                      rowClass={grpCls}
                      canReply={!!m.wireId}
                      onReply={() => startReply(m)}
                      after={replyButton}
                    >
                      <div className={`ours-message ours-message-file ours-message--${m.dir}`}>
                        <FileBubble rec={rec} receipt={m.receipt} receiptless={m.receiptless} onPreview={setPreviewRec} onFetch={props.onFetchFile} />
                      </div>
                    </SwipeReplyRow>
                  </motion.div>
                );
              }

              const quote = quoteFor(m);
              return (
                <motion.div
                  className="message-motion"
                  key={key}
                  id={domId}
                  initial={{ opacity: 0, y: 12, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={interfaceSpring}
                >
                  {m.wireId === props.unreadOpen?.wireId && <div id={`unread-${domId}`} className="unread-divider" role="separator"><span>Unread messages</span></div>}
                  <SwipeReplyRow
                    dir={m.dir === 'out' ? 'out' : 'in'}
                    rowClass={grpCls}
                    canReply={!!m.wireId}
                    onReply={() => startReply(m)}
                    after={replyButton}
                  >
                    <div className={`ours-message ours-message--${m.dir}`}>
                      {quote && (
                        <div className="quote">
                          {quote.author && <span className="quote-author">{quote.author}</span>}
                          <span className="quote-text">{quote.text}</span>
                        </div>
                      )}
                      {/* Room chat: who is speaking, in what role. The header is
                          dropped on a continuation so a run by one member reads
                          as one turn. In an anonymous room this name is the
                          ALIAS the server put on the wire — the real identity
                          never reaches the client. */}
                      {room && !contTop && (
                        <>
                          {room.roomName && <div className="room-message-room">{room.roomName}</div>}
                          <div className="room-author">
                            <span className="room-author-name">{room.author}</span>
                            {room.role && <span className="room-author-role">{room.role}</span>}
                          </div>
                        </>
                      )}
                      <MessageMarkdown text={room ? room.text : m.text} />
                      <div className="bubble-at">
                        {fmtTime(room?.authoredAt || m.date)}
                        {m.dir === 'out' && <MessageReceipt receipt={m.receipt} receiptless={m.receiptless} />}
                      </div>
                    </div>
                  </SwipeReplyRow>
                </motion.div>
              );
            })}
          </AnimatePresence>
          <div className="thread-end" aria-hidden />
        </div>
      </div>
      {jumpLatest && (
        <button
          type="button"
          className="jump-latest btn sm"
          aria-label={newSinceAway ? `Jump to latest, ${newSinceAway} new messages` : 'Jump to latest'}
          onClick={(event) => {
            const restoreFocus = event.currentTarget === document.activeElement;
            setNewSinceAway(0);
            followBottom(true);
            if (restoreFocus) requestAnimationFrame(() => messageScrollRef.current?.focus({ preventScroll: true }));
          }}
        >
          <span>Jump to latest</span>
          {!!newSinceAway && <span className="jump-latest-count" aria-live="polite">{newSinceAway}</span>}
        </button>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
          {error.startsWith('Send failed:') && (
            <span className="banner-actions">
              <button className="linkbtn" onClick={() => void send()}>
                retry
              </button>
            </span>
          )}
        </div>
      )}
      <div className="composer-wrap">
        {replyTo && (
          <div className="reply-bar">
            <div className="reply-bar-line" />
            <div className="reply-bar-body">
              <div className="reply-bar-author">Replying to {replyTo.author}</div>
              <div className="reply-bar-text">{replyTo.text}</div>
            </div>
            <button className="icon-btn" title="Cancel reply" onClick={() => setReplyTo(null)}>
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {pendingAtt && (
          <AttachPreview
            att={pendingAtt}
            sending={sendingFile}
            onSend={sendPendingFile}
            onDiscard={() => setPendingAtt(null)}
          />
        )}
        {processingFile && (
          <div className="attachment-processing" role="status">
            Optimizing photo for secure delivery…
          </div>
        )}
        <div className={'composer' + (voiceActive ? ' recording' : '')}>
          {props.onSendFile && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void acceptFile(f);
                  e.target.value = '';
                }}
              />
              <button
                className="icon-btn composer-tool"
                title="Attach a file or photo"
                disabled={sendingFile || processingFile || voiceActive}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="paperclip" size={18} />
              </button>
            </>
          )}
          <textarea
            ref={composerInputRef}
            className="field"
            rows={1}
            placeholder={(replyTo ? 'Reply to ' + replyTo.author : 'Message ' + contact.name) + '…'}
            value={draft}
            aria-busy={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const mobileComposer = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 860;
                if (!mobileComposer && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              } else if (e.key === 'Escape') setReplyTo(null);
            }}
          />
          {props.onSendFile && !draft.trim() && !pendingAtt && !processingFile && !sendingFile ? <VoiceComposer
            key={contact.id}
            disabled={sendingFile || processingFile || !!pendingAtt}
            onReady={(att) => { setVoiceActive(false); setPendingAtt(att); }}
            onError={(err) => { setVoiceActive(false); setError(err); }}
            onActiveChange={setVoiceActive}
          /> : <button
            className="btn primary"
            aria-label="Send"
            onPointerDown={(e) => {
              // Preserve the focused textarea under the submitting touch. A
              // post-request focus() cannot reopen iOS's software keyboard.
              if (e.button === 0 && document.activeElement === composerInputRef.current) e.preventDefault();
            }}
            onClick={() => void send()}
            disabled={sending || unknownDuplicate || !draft.trim()}
            title={unknownDuplicate ? 'Delivery status unknown — edit before sending again' : undefined}
          >
            <Icon name="send" size={16} />
            <span className="btn-label">Send</span>
          </button>}
        </div>
      </div>
      {/* One preview slot, two documents. HTML gets the sandboxed viewer and
          NO review/feedback composer — review stays a Markdown-only flow. */}
      {previewRec && (
        isHtmlAttachment(previewRec.filename, previewRec.mime) ? (
          <HtmlPreview rec={previewRec} onClose={() => setPreviewRec(null)} />
        ) : (
          <MarkdownPreview
            rec={previewRec}
            onClose={() => setPreviewRec(null)}
            onSendText={props.onSend}
            onSendFile={props.onSendFile}
          />
        )
      )}
    </div>
  );
}
