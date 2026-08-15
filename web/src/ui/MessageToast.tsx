// In-app message banner.
//
// Browser push already covers "app closed or backgrounded" — public/sw.js
// deliberately SUPPRESSES the OS notification while the app is frontmost (:155-164)
// so it doesn't fire an OS banner for a chat you are actively reading. That left
// the foreground case with no signal at all: a message for a chat you are not
// looking at produced nothing. This is that signal.
//
// It renders into the existing `.app-banners` stack so position, z-index,
// safe-area and mobile behaviour come from CSS that already ships.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { initials } from './viewmodel';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- pure JS core, typed here.
import { coalesceToasts as coalesceJs, dropToast as dropJs, TOAST_CAP } from './toastRuleCore.mjs';

export interface ToastItem {
  id: string;
  cid: string;
  name: string;
  /** Empty unless SHOW_MESSAGE_PREVIEW is on — see below. */
  preview: string;
  at: number;
}

// PRIVACY CALL — deliberately one constant, and deliberately off.
//
// The chat list already shows message text, but a toast is different: it floats
// over whatever is on screen, including a shared screen or a screen someone else
// is standing next to, and it appears without the user choosing to look. Off
// means the banner reads "New message" and the sender's name only. Flip to true
// to show a one-line clamped preview; nothing else has to change.
export const SHOW_MESSAGE_PREVIEW = false;

// Matches the ~6s the design specifies. Long enough to read a name and reach for
// it, short enough not to sit on top of the conversation.
const AUTO_DISMISS_MS = 6000;

const coalesce = coalesceJs as (items: ToastItem[], incoming: ToastItem, cap?: number) => ToastItem[];
const drop = dropJs as (items: ToastItem[], id: string) => ToastItem[];

/**
 * Toast queue. `push` coalesces per contact: a second message from a sender who
 * already has a banner up replaces it and restarts its timer rather than stacking.
 */
export function useMessageToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Monotonic within a page load, so two messages landing in the same millisecond
  // still mint distinct ids (a repeated id would leave a stuck banner).
  const seq = useRef(0);

  // All three are stable: AppShell hands them to a once-registered broker
  // subscription and to the effect that owns the presence socket, so a fresh
  // identity every render would tear those down and rebuild them continuously.
  const push = useCallback((cid: string, name: string, preview: string) => {
    const at = Date.now();
    const item: ToastItem = {
      id: `${cid}:${at}:${seq.current++}`,
      cid,
      name,
      preview: SHOW_MESSAGE_PREVIEW ? preview : '',
      at,
    };
    setToasts((items) => coalesce(items, item, TOAST_CAP as number));
  }, []);

  const dismiss = useCallback((id: string) => setToasts((items) => drop(items, id)), []);
  const clear = useCallback((cid: string) => setToasts((items) => items.filter((t) => t.cid !== cid)), []);

  return { toasts, push, dismiss, clear };
}

function Toast(props: { item: ToastItem; onOpen: (cid: string) => void; onDismiss: (id: string) => void }) {
  const { item, onOpen, onDismiss } = props;
  // Hover and keyboard focus can overlap. Keep them independent: a mouseleave
  // must not resume the timer while a keyboard user still has focus inside the
  // banner (and a blur must not resume it while the pointer remains over it).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // Auto-dismiss, paused while the pointer or keyboard focus is on the banner so
  // it can't vanish mid-click.
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismiss(item.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
    // item.id changes when a newer message from the same sender replaces this
    // one, which is what restarts the timer.
  }, [item.id, paused, onDismiss]);

  return (
    <div
      className="banner msg"
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // React focus events bubble. Moving between the open and dismiss buttons
        // stays within the banner and must not briefly resume the timer.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <button
        className="msg-open"
        title={`Open the conversation with ${item.name}`}
        onClick={() => onOpen(item.cid)}
      >
        <span className="avatar sm accent" aria-hidden="true">{initials(item.name)}</span>
        <span className="msg-text">
          <strong className="msg-name">{item.name}</strong>
          <span className="msg-preview">{item.preview || 'New message'}</span>
        </span>
      </button>
      <button
        className="icon-btn msg-close"
        title="Dismiss"
        aria-label={`Dismiss the notification from ${item.name}`}
        onClick={() => onDismiss(item.id)}
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}

export default function MessageToasts(props: {
  items: ToastItem[];
  onOpen: (cid: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <>
      {props.items.map((t) => (
        <Toast key={t.id} item={t} onOpen={props.onOpen} onDismiss={props.onDismiss} />
      ))}
    </>
  );
}
