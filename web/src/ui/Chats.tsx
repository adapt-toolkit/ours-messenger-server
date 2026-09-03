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
import type { CommandCatalog, CommandDefinition, JsonValue, SendCommandResult } from '../types.js';
import { CommandPanel } from './CommandPanel.js';
import { AnimatePresence, motion } from 'framer-motion';
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
}) {
  const { c, active, grouped } = props;
  return (
    <motion.button
      type="button"
      layout
      className={
        'contact-row' +
        (active ? ' active' : '') +
        (grouped ? ' grouped' : '') +
        (c.status === 'pending' ? ' pending' : '')
      }
      onClick={props.onClick}
      whileHover={{ x: 3 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <span className="contact-avatar" aria-hidden>{c.initials}</span>
      <span className="contact-copy">
        <span className="contact-row-topline">
          <span className="contact-name">{c.name}</span>
          {c.when && <span className="contact-time">{c.when}</span>}
        </span>
        <span className="contact-row-bottomline">
          <span className="contact-last">{c.last}</span>
          {c.status === 'pending' && <span className="chip">invited</span>}
          {!!c.unread && <span className="contact-unread">{c.unread}</span>}
        </span>
      </span>
      {active && <motion.span className="contact-active-glow" layoutId="active-contact" />}
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
          <h2 className="listcol-title">Chats</h2>
          <div className="listcol-actions">
            <button className="btn sm primary" onClick={props.onInvite}>
              <Icon name="plus" size={15} />
              Invite
            </button>
            <button className="icon-btn" title="Settings" onClick={props.onSettings}>
              <Icon name="settings" />
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
                <ContactRow key={c.id} c={c} active={false} onClick={() => {}} />
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

interface ReplyDraft {
  wireId: string;
  author: string;
  text: string;
}

const timelineMessageId = (key: string) => `chat-message-${encodeURIComponent(key)}`;

const reducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Swipe-to-reply: drag a bubble toward screen centre (incoming → right,
// outgoing → left) to reply, Telegram/WhatsApp style. Touch/pen only — a mouse
// keeps text-selection + the hover reply button (see .msg-reply, @media hover).
// touch-action: pan-y lets the browser own vertical scroll while we own the
// horizontal drag, so the thread never fights the gesture (verified on WebKit).
function SwipeReplyRow(props: {
  dir: 'in' | 'out';
  canReply: boolean;
  onReply: () => void;
  children: ReactNode;
  after?: ReactNode; // desktop hover reply button — outside the translating wrap
  rowClass?: string; // full msg-row modifier string (dir + grouping); defaults to dir
}) {
  const { dir, canReply, onReply } = props;
  const slider = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLDivElement>(null);
  const toCenter = dir === 'out' ? -1 : 1; // sign of a valid (toward-centre) drag
  const ACTIVATE = 8; // px of travel before we commit to horizontal vs vertical
  const THRESH = 56; // px to arm the reply
  const MAX = 84; // rubber-band cap
  const st = useRef({ id: -1, x0: 0, y0: 0, mode: 'idle' as 'idle' | 'maybe' | 'drag', armed: false });

  const paint = (dx: number) => {
    const s = slider.current;
    const c = cue.current;
    if (s) s.style.transform = dx ? `translateX(${dx}px)` : '';
    if (c) {
      const p = Math.min(1, Math.abs(dx) / THRESH);
      c.style.opacity = String(p);
      c.style.transform = `scale(${0.5 + 0.5 * p})`;
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if (!canReply || e.pointerType === 'mouse') return;
    st.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: 'maybe', armed: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const s = st.current;
    if (s.id !== e.pointerId || s.mode === 'idle') return;
    const dxr = e.clientX - s.x0;
    const dyr = e.clientY - s.y0;
    if (s.mode === 'maybe') {
      if (Math.abs(dxr) < ACTIVATE && Math.abs(dyr) < ACTIVATE) return;
      // commit to the drag only if it's horizontal AND toward centre; anything
      // else (vertical, or a wrong-way drag) releases the gesture back to scroll.
      if (Math.abs(dxr) > Math.abs(dyr) && Math.sign(dxr) === toCenter) {
        s.mode = 'drag';
        slider.current?.classList.add('swiping');
      } else {
        s.mode = 'idle';
        return;
      }
    }
    // magnitude toward centre, rubber-banded past the threshold, hard-capped
    let d = dxr * toCenter;
    if (d < 0) d = 0;
    if (d > THRESH) d = THRESH + (d - THRESH) * 0.35;
    d = Math.min(d, MAX);
    const dx = d * toCenter;
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
    if (s.id !== e.pointerId) return;
    const fire = s.mode === 'drag' && s.armed;
    st.current = { id: -1, x0: 0, y0: 0, mode: 'idle', armed: false };
    slider.current?.classList.remove('swiping');
    cue.current?.classList.remove('armed');
    paint(0); // spring back (transition re-enabled with .swiping removed)
    if (fire) onReply();
  };

  return (
    <div
      className={'msg-row ' + (props.rowClass ?? dir)}
      style={canReply ? { touchAction: 'pan-y' } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
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
  hiddenEarlier?: number;
  onLoadEarlier?: () => void;
  onBack: () => void;
  /** Resolves with the canonical wire id of the delivered message when it has one. */
  onSend: (text: string, replyToWireId?: string, signal?: AbortSignal) => Promise<string | void>;
  onLoadCommands?: (contactCid: string, signal?: AbortSignal) => Promise<CommandCatalog>;
  onSendCommand?: (
    contactCid: string, command: string, args: JsonValue, invocationId: string,
    catalogFingerprint: string, signal?: AbortSignal,
  ) => Promise<SendCommandResult>;
  /** Canonical state is still catching up: shown inline, never as a screen. */
  syncing?: 'connecting' | 'updating' | null;
  onRemove: () => void;
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
  // header: inline rename + the verified-identity popover
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showIdCard, setShowIdCard] = useState(false);
  // attachments: picked/recorded file awaiting send; active voice recording
  const [pendingAtt, setPendingAtt] = useState<PendingAttachment | null>(null);
  const [voiceActive, setVoiceActive] = useState(false); // hold-to-record in progress
  const [sendingFile, setSendingFile] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const [previewRec, setPreviewRec] = useState<FileRecord | null>(null);
  const [showSharedMedia, setShowSharedMedia] = useState(false);
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalog | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const commandLoadRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    setDraft('');
    setError(null);
    setUnknownSend(null);
    setOptimisticSend(null);
    setReplyTo(null);
    setEditingName(null);
    setShowIdCard(false);
    setPendingAtt(null);
    setVoiceActive(false);
    setSendingFile(false);
    setProcessingFile(false);
    fileReadGenerationRef.current += 1;
    setPreviewRec(null);
    setShowSharedMedia(false);
    commandLoadRef.current?.abort();
    setCommandCatalog(null);
    setCommandOpen(false);
    setCommandBusy(false);
    sentKeysRef.current.clear();
    followTargetRef.current = null;
    followTopRef.current = null;
  }, [contact?.id]);

  const loadCommands = async () => {
    if (!contact || !props.onLoadCommands) return;
    commandLoadRef.current?.abort();
    const controller = new AbortController();
    commandLoadRef.current = controller;
    setCommandBusy(true);
    setError(null);
    try {
      const catalog = await props.onLoadCommands(contact.id, controller.signal);
      if (!controller.signal.aborted && catalog.recipient_cid === contact.id) {
        setCommandCatalog(catalog);
        setCommandOpen(true);
      } else if (!controller.signal.aborted) {
        setError('Command discovery was refused because the authenticated recipient changed.');
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof ApiError
        ? `Command discovery failed: ${err.message}`
        : 'Command discovery failed safely. The recipient may be offline or unsupported.');
    } finally {
      if (commandLoadRef.current === controller) setCommandBusy(false);
    }
  };

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
    const grew = displayMessages.length !== messageCountRef.current;
    messageCountRef.current = displayMessages.length;
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
    }
    previousContactRef.current = contact.id;
  }, [contact, displayMessages.length]);

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
    });
    observer.observe(content);
    // Composer/reply rows and mobile browser chrome resize the viewport without
    // changing the timeline content. Observe both boxes so an intentionally
    // pinned reader stays on the newest message through those interactions.
    observer.observe(scroller);
    return () => observer.disconnect();
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
          : roomLineForContact(contact?.announcedName ?? '', message.text),
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
          <div className="avatar accent">{contact.initials}</div>
          <div className="conv-peer-meta">
            {editingName !== null ? (
              <input
                className="field name-edit"
                value={editingName}
                autoFocus
                placeholder={contact.name}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    props.onRename?.(editingName);
                    setEditingName(null);
                  } else if (e.key === 'Escape') setEditingName(null);
                }}
                onBlur={() => setEditingName(null)}
              />
            ) : (
              <div className="conv-peer-name">
                {contact.name}
                {props.onRename && (
                  <button
                    className="icon-btn name-pencil"
                    title="Rename (only changes how they appear to you)"
                    onClick={() => setEditingName(contact.name)}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                )}
              </div>
            )}
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
            {/* Delegation + id demoted to a verification badge — tap for the
                full story. The raw 'role X of Y' subtitle read like a broken
                name; it is actually the anti-impersonation proof. */}
            {!props.syncing && (contact.roleId ? (
              <button className="idchip" onClick={() => setShowIdCard(true)}>
                <Icon name="shield" size={11} />
                verified role of {contact.rootName}
              </button>
            ) : (
              contact.status !== 'pending' && (
                <button className="idchip quiet" onClick={() => setShowIdCard(true)}>
                  <Icon name="lock" size={11} />
                  verified identity
                </button>
              )
            ))}
          </div>
        </div>
        {showIdCard && (
          <>
            <div className="pop-backdrop" onClick={() => setShowIdCard(false)} />
            <div className="idcard anim-scale">
              <h4>Verified identity</h4>
              {contact.roleId && (
                <p>
                  This is the role <strong>“{contact.roleId}”</strong> of{' '}
                  <strong>{contact.rootName}</strong> — the link is cryptographically signed, not
                  self-declared.
                </p>
              )}
              <div className="idcard-fp mono">{contact.id}</div>
              <p className="idcard-note">
                This id is the fingerprint of their key. Names are what people show you; the
                fingerprint is what guarantees you&apos;re always talking to the same identity — no
                one can impersonate it. Renaming only changes how they appear to you.
              </p>
            </div>
          </>
        )}
        <div className="conv-actions">
          <button className="btn sm" title="Shared photos, files, and links" onClick={() => setShowSharedMedia(true)}>
            <Icon name="paperclip" size={14} />
            Media
          </button>
          <button className="btn sm danger" title="Remove contact" onClick={props.onRemove}>
            <Icon name="trash" size={14} />
            Remove
          </button>
        </div>
      </div>
      <div
        key={contact.id}
        className="messages"
        ref={messageScrollRef}
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
                return (
                  <motion.div
                    className="message-motion"
                    key={key}
                    id={domId}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="room-system" role="note">
                      {room.label && <span className="room-system-label">{room.label}</span>}
                      <MessageMarkdown text={room.text} className="room-system-text message-markdown" />
                      <span className="room-system-at">{fmtTime(m.date)}</span>
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
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  >
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

              if (m.typed) {
                const request = m.typed.kind === 'command_result' && m.replyTo
                  ? byWireId.get(m.replyTo.wireId)
                  : undefined;
                const outcome = m.typed.kind === 'command_result' ? m.typed.outcome : null;
                const outcomeRecord = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
                  ? outcome as Record<string, JsonValue>
                  : null;
                const errorRecord = outcomeRecord?.error && typeof outcomeRecord.error === 'object'
                  && !Array.isArray(outcomeRecord.error) ? outcomeRecord.error as Record<string, JsonValue> : null;
                const denial = String(outcomeRecord?.status ?? outcomeRecord?.code ?? errorRecord?.code ?? '').toLowerCase();
                const state = m.typed.kind === 'command'
                  ? (m.dir === 'out' ? 'Accepted · pending result' : 'Received command')
                  : m.typed.kind === 'unknown'
                    ? 'Safe failure'
                    : denial.includes('validation') ? 'Validation denied'
                      : denial.includes('policy') || denial.includes('unauthorized') || denial.includes('forbidden') ? 'Policy denied'
                        : outcomeRecord?.ok === false ? 'Failed' : 'Completed';
                const title = m.typed.kind === 'command'
                  ? m.typed.command
                  : m.typed.kind === 'command_result'
                    ? `Result for ${request?.typed?.kind === 'command' ? request.typed.command : m.replyTo?.wireId ?? 'unknown command'}`
                    : `Unsupported ${m.typed.wire_kind}`;
                const detail = m.typed.kind === 'command' ? m.typed.arguments
                  : m.typed.kind === 'command_result' ? m.typed.outcome
                    : { safe_failure: m.typed.malformed ? 'Malformed typed message' : 'Future typed message preserved' };
                return <motion.div className="message-motion" key={key} id={domId}
                  initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <SwipeReplyRow dir={m.dir} rowClass={grpCls} canReply={!!m.wireId} onReply={() => startReply(m)} after={replyButton}>
                    <div className={`ours-message typed-message ours-message--${m.dir}`}>
                      <div className="typed-message-kind">{m.typed.kind === 'command' ? 'Command' : m.typed.kind === 'command_result' ? 'Result' : 'Typed message'}</div>
                      <strong>{title}</strong>
                      <div className="typed-message-state" role="status">{state}</div>
                      <pre>{JSON.stringify(detail, null, 2)}</pre>
                      <div className="bubble-at">{fmtTime(m.date)}{m.dir === 'out' && <MessageReceipt receipt={m.receipt} receiptless={m.receiptless} />}</div>
                    </div>
                  </SwipeReplyRow>
                </motion.div>;
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
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
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
                        <div className="room-author">
                          <span className="room-author-name">{room.author}</span>
                          {room.role && <span className="room-author-role">{room.role}</span>}
                        </div>
                      )}
                      <MessageMarkdown text={room ? room.text : m.text} />
                      <div className="bubble-at">
                        {fmtTime(m.date)}
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
        {commandBusy && !commandOpen && <div className="command-status" role="status" aria-live="polite">Loading recipient commands…</div>}
        {commandOpen && commandCatalog && props.onSendCommand && (
          <CommandPanel
            key={`${commandCatalog.recipient_cid}:${commandCatalog.fingerprint}`}
            catalog={commandCatalog}
            busy={commandBusy}
            onRefresh={() => void loadCommands()}
            onClose={() => setCommandOpen(false)}
            onSend={async (command: CommandDefinition, args, invocationId) => {
              if (!contact || contact.id !== commandCatalog.recipient_cid) throw new Error('Recipient changed; refresh commands');
              setCommandBusy(true);
              try {
                return await props.onSendCommand!(contact.id, command.name, args, invocationId, commandCatalog.fingerprint);
              } finally { setCommandBusy(false); }
            }}
          />
        )}
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
          {props.onLoadCommands && (
            <button type="button" className="icon-btn composer-tool command-trigger" title="Recipient commands"
              aria-label="Recipient commands" aria-expanded={commandOpen}
              disabled={commandBusy} onClick={() => commandOpen ? setCommandOpen(false) : void loadCommands()}>
              /
            </button>
          )}
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
              <VoiceComposer
                key={contact.id}
                disabled={sendingFile || processingFile || !!pendingAtt}
                onReady={(att) => { setVoiceActive(false); setPendingAtt(att); }}
                onError={(err) => { setVoiceActive(false); setError(err); }}
                onActiveChange={setVoiceActive}
              />
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
          <button
            className="btn primary"
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
            Send
          </button>
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
      {showSharedMedia && (
        <ChatMediaPanel
          messages={messages}
          indexOffset={props.hiddenEarlier ?? 0}
          onClose={() => setShowSharedMedia(false)}
          onPreview={(rec) => {
            setShowSharedMedia(false);
            setPreviewRec(rec);
          }}
          onJump={(key) => {
            document.getElementById(timelineMessageId(key))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setShowSharedMedia(false);
          }}
        />
      )}
    </div>
  );
}
