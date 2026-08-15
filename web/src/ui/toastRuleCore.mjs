// The in-app message-notification rule, kept DOM-free so it can be tested with
// `node --test` (tests/toast-rule.test.mjs) the same way the other *Core.mjs
// modules are.
//
// One question decides everything: is the sender's conversation ACTUALLY on
// screen? Not "is it selected" — selection outlives visibility in three ways the
// app hits daily:
//
//   • the Fleet tab is showing (AppShell sets `mode` but `selContact` stays put),
//   • mobile has backed out to the chat list (`showDetail` false, detail pane
//     translated off-screen by @media (max-width: 860px) in app.css),
//   • a blocking overlay is up (a modal dialog, the tab intro),
//   • the browser tab is hidden.
//
// The same predicate gates mark-read. Marking a message read because it happened
// to arrive for the last-opened chat — while the user was looking at something
// else entirely — is how messages were being swallowed with no badge and no trace.

// Above the 860px breakpoint the list and the conversation are both on screen
// (`.section { grid-template-columns: 320px 1fr }`), so `showDetail` says nothing
// about visibility there and must not be consulted.
//
// `overlay` is "a blocking overlay covers the conversation" — see the derivation
// in AppShell for which ones count. Only a strict `true` hides the chat, so an
// absent flag keeps the plain behaviour.
export function isChatOnScreen({ visibility, mode, selContact, showDetail, desktop, overlay, cid }) {
  if (cid == null || selContact == null) return false;
  return (
    visibility === 'visible' &&
    overlay !== true &&
    mode === 'chats' &&
    selContact === cid &&
    (desktop === true || showDetail === true)
  );
}

export function shouldNotify(state) {
  return !isChatOnScreen(state);
}

// At most one toast per contact, newest first, and never more than this many on
// screen at once.
export const TOAST_CAP = 3;

// A second message from a sender who already has a toast up replaces it rather
// than stacking — the caller mints a fresh `id`, which restarts the auto-dismiss
// timer instead of letting the first message's timer cut the second one short.
export function coalesceToasts(items, incoming, cap = TOAST_CAP) {
  return [incoming, ...items.filter((t) => t.cid !== incoming.cid)].slice(0, cap);
}

export function dropToast(items, id) {
  return items.filter((t) => t.id !== id);
}

// How long a live `message_received` suppresses the service worker's
// `push-suppressed` backstop for the same sender.
export const SUPPRESSED_DEDUP_MS = 10_000;

// public/sw.js:161 posts `{kind:'push-suppressed', …}` whenever it declines to
// show an OS notification because the app is frontmost. The live broker event
// almost always beats it, so this path is a backstop for a blipped connection —
// which means the common case is a duplicate that must be dropped.
//
// `recent` maps a sender key to the ms timestamp of the last live toast. A `now`
// EARLIER than the recorded stamp (clock step, or a stamp from a monotonic-ish
// source) is treated as "just seen" rather than as an elapsed window, so a
// backwards jump can't wedge the backstop permanently open.
export function shouldAcceptSuppressed({ recent, key, now, windowMs = SUPPRESSED_DEDUP_MS }) {
  const seen = recent?.[key];
  if (seen == null) return true;
  return now - seen > windowMs;
}

// The suppressed-push payload identifies the sender by NAME only, and a name is
// not a key: two contacts can announce the same one, and nothing in the payload
// tells them apart. A first-wins lookup therefore had a way to deep-link the
// banner into the WRONG conversation — and clicking it marks that conversation
// read, so the guess was destructive rather than merely unhelpful.
//
// So: resolve only when the answer is unambiguous. `cid` is non-null exactly when
// one contact answers to the name; an ambiguous name still raises a banner (the
// user must hear about the message) but the banner is not clickable — AppShell
// keys it "name:<sender>", which its onOpen refuses to open. `candidates` is
// every cid the name could mean, so the caller can still suppress and
// de-duplicate against ALL of them.
export function resolveSuppressedSender({ cidsByName, from }) {
  const candidates = cidsByName?.[from] ?? [];
  return { cid: candidates.length === 1 ? candidates[0] : null, candidates };
}
