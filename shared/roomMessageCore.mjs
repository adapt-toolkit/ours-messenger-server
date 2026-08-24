// Room messages — the wire body a cowork room relays, turned into a line a
// person can read. A room contact's conversation is otherwise a wall of signed
// JSON: every relayed body is canonical JSON, so the raw $text of each entry is
// `{"at":…,"author":{…},"kind":"room_msg",…}`.
//
// The cowork relay body is
//   {version:1, kind, room_id, message_id, author:{identity,display_name,role},
//    text, at, briefing_role?, briefing_version?, membership?, signature}
// and a removed sender receives the content-free
//   {version:1, kind:'room_not_member', room_id, signature}.
// Room-voice notices are authored by the room's own identity with role 'room';
// a participant's message carries their seat.
//
// THIS MODULE IS SHARED BY THE BROWSER AND THE SERVER, and lives outside web/
// for that reason. A room payload reaches THREE surfaces — the conversation, the
// chat-list preview, and the push notification the server composes — and the
// notification cannot be built in the browser. One parser is the only thing that
// keeps the three from drifting; a second one written for the server would drift
// on the first additive kind.
//
// TWO RULES THIS FILE EXISTS TO KEEP, and they now bind those three surfaces
// rather than one:
//
// 1. Additive JSON: the kind set grows server-side without a client
//    release. A kind this build has never seen MUST still render its `text` as
//    a readable line — never raw JSON, never blank. Everything below funnels
//    through `renderRoomMessage`, whose default branch is exactly that.
// 2. Anonymity: in an anonymous room the author envelope carries an
//    ALIAS and a room-scoped participant id, and the real cid never leaves the
//    server. `author.identity` is NEVER read for display here — only
//    `display_name` and `role` — so a body that did leak one could not put it
//    on screen through this path.

/** Wire kinds this build understands. Anything else takes the text fallback. */
export const KNOWN_ROOM_KINDS = [
  'room_msg',
  'room_briefing',
  'room_role_briefing',
  'room_membership',
  'room_not_member',
];

/** The role a room's own identity signs its notices with (cowork ROOM_ROLE). */
export const ROOM_VOICE_ROLE = 'room';

const ROOM_KIND_PREFIX = 'room_';
/** Prefix used by the server-announced contact identity (cowork 0.4.x). */
export const ROOM_IDENTITY_PREFIX = 'ours-cowork-room:';
/** Prefix emitted by ours-cowork >= 0.5.1 room identities (ULID-based). */
export const CURRENT_ROOM_IDENTITY_PREFIX = 'ours-cowork-';
/** Exact prefix emitted by ours-cowork <= 0.3.3 room identities. */
export const LEGACY_ROOM_IDENTITY_PREFIX = 'cowork-room-';

// A ULID is 26 Crockford base32 characters and its 128-bit range constrains
// the first character to 0-7. Lowercase is part of the legacy producer
// contract; accepting case folds or ambiguous i/l/o/u characters would let an
// ordinary look-alike name cross the room-contact trust boundary.
const LOWER_CROCKFORD_ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
// Cowork's configured friendly mode freezes a bounded ASCII reconstruction of
// the creation-time room_name into the identity. The original Unicode spelling
// and later mutable room_name are not protocol metadata, so Messenger can only
// render this authenticated slug rather than claim to recover either one.
const FRIENDLY_ROOM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FRIENDLY_ROOM_SLUG_LENGTH = 25;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * Recognize a relayed room body in a message's raw text.
 *
 * Deliberately strict: a member could type a JSON object into the composer, and
 * that must keep rendering as the text they typed. Every relayed body is signed
 * and room-scoped, so version + `room_`-prefixed kind + room_id + signature is
 * required before this claims a message. Returns null for anything else — the
 * caller then renders the message exactly as it does today.
 */
export function parseRoomBody(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!isNonEmptyString(parsed.kind) || !parsed.kind.startsWith(ROOM_KIND_PREFIX)) return null;
  if (!isNonEmptyString(parsed.room_id)) return null;
  if (!isNonEmptyString(parsed.signature)) return null;
  return parsed;
}

/** The author envelope, reduced to what may be shown. Never the identity. */
function authorOf(body) {
  const author = isObject(body.author) ? body.author : {};
  return {
    name: isNonEmptyString(author.display_name) ? author.display_name : '',
    role: isNonEmptyString(author.role) ? author.role : '',
  };
}

/** 'room_role_briefing' -> 'Role briefing'; used to label a kind we don't know. */
export function humanizeRoomKind(kind) {
  const words = String(kind).replace(/^room_/, '').split('_').filter(Boolean);
  if (words.length === 0) return 'Room notice';
  return words.join(' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Turn a parsed body into one renderable line.
 *
 * variant 'chat'   — a person talking: name + role + what they said.
 * variant 'system' — the room's own voice: briefings, membership changes.
 *
 * `text` is always a non-empty readable string. `body` is never echoed as JSON.
 */
export function renderRoomMessage(body) {
  if (!isObject(body)) return null;
  const kind = isNonEmptyString(body.kind) ? body.kind : '';
  const author = authorOf(body);
  const text = typeof body.text === 'string' ? body.text : '';
  const version = Number.isSafeInteger(body.briefing_version) && body.briefing_version > 0
    ? body.briefing_version
    : null;

  switch (kind) {
    case 'room_msg':
      // A room may also speak in the plain chat kind (operator postMessage),
      // and that is a system line, not a participant talking.
      return author.role === ROOM_VOICE_ROLE
        ? systemLine(kind, 'Room', text || 'Room notice')
        : { variant: 'chat', kind, author: author.name || 'Unknown member', role: author.role, label: '', text };

    case 'room_briefing':
      return systemLine(kind, version === null ? 'Room briefing' : `Room briefing · v${version}`, text || 'The room briefing was updated.');

    case 'room_role_briefing': {
      const role = isNonEmptyString(body.briefing_role) ? body.briefing_role : '';
      const label = ['Role briefing', role, version === null ? '' : `v${version}`].filter(Boolean).join(' · ');
      return systemLine(kind, label, text || 'Your role briefing was updated.');
    }

    case 'room_membership':
      return systemLine(kind, 'Membership', text || membershipFallback(body.membership));

    case 'room_not_member':
      // The content-free bounce: there is no text field on the wire at all.
      return systemLine(kind, 'Room', 'You are no longer a member of this room.');

    default:
      // A kind from a newer server than this build: show its text. Only
      // when the body carries none do we fall back to naming the notice — still
      // a sentence, still never JSON, still never blank.
      return text
        ? {
            variant: author.role && author.role !== ROOM_VOICE_ROLE ? 'chat' : 'system',
            kind,
            author: author.role && author.role !== ROOM_VOICE_ROLE ? author.name || 'Unknown member' : '',
            role: author.role && author.role !== ROOM_VOICE_ROLE ? author.role : '',
            label: author.role && author.role !== ROOM_VOICE_ROLE ? '' : humanizeRoomKind(kind),
            text,
          }
        : systemLine(kind, humanizeRoomKind(kind), `${humanizeRoomKind(kind)} from the room.`);
  }
}

/**
 * Render a room envelope in one authenticated contact's conversation.
 *
 * Contact scoping is the trust boundary; body shape and the envelope's opaque
 * signature string are not client-side proof by themselves.
 */
export function roomLineForContact(announcedContact, text) {
  if (!isCoworkRoomContact(announcedContact)) return null;
  return renderRoomMessage(parseRoomBody(text));
}

function legacyRoomId(announced) {
  if (typeof announced !== 'string' || !announced.startsWith(LEGACY_ROOM_IDENTITY_PREFIX)) return null;
  const roomId = announced.slice(LEGACY_ROOM_IDENTITY_PREFIX.length);
  return LOWER_CROCKFORD_ULID.test(roomId) ? roomId : null;
}

function currentRoomMetadata(announced) {
  if (typeof announced !== 'string' || !announced.startsWith(CURRENT_ROOM_IDENTITY_PREFIX)) return null;
  const suffix = announced.slice(CURRENT_ROOM_IDENTITY_PREFIX.length);
  if (LOWER_CROCKFORD_ULID.test(suffix)) return { roomId: suffix, slug: null };

  // Parse from the full ULID suffix. A slug can contain hyphens, and splitting
  // from the left would either truncate it or make the stable form ambiguous.
  const roomId = suffix.slice(-26);
  const separator = suffix.at(-27);
  const slug = suffix.slice(0, -27);
  if (separator !== '-' || !LOWER_CROCKFORD_ULID.test(roomId)) return null;
  if (slug.length < 1 || slug.length > MAX_FRIENDLY_ROOM_SLUG_LENGTH) return null;
  return FRIENDLY_ROOM_SLUG.test(slug) ? { roomId, slug } : null;
}

/** True only for a current or exact legacy server-announced room identity. */
export function isCoworkRoomContact(announced) {
  const identity = String(announced ?? '').trim();
  const v04 = identity.startsWith(ROOM_IDENTITY_PREFIX)
    && identity.slice(ROOM_IDENTITY_PREFIX.length).trim().length > 0;
  // v0.4 historically tolerated outer whitespace. Current and legacy ULID
  // grammars are exact protocol identities and must parse the raw announcement.
  return v04 || currentRoomMetadata(announced) !== null || legacyRoomId(announced) !== null;
}

/** Safe contact-row/toast preview: ordinary contacts always keep raw content. */
export function contactMessagePreview(announcedContact, text) {
  const line = roomLineForContact(announcedContact, text);
  return line ? roomMessagePreview(line) : String(text ?? '');
}

function systemLine(kind, label, text) {
  return { variant: 'system', kind, author: '', role: '', label, text };
}

function membershipFallback(membership) {
  if (!isObject(membership)) return 'The room membership changed.';
  const who = isNonEmptyString(membership.alias) ? membership.alias : 'A member';
  return membership.action === 'remove' ? `${who} left the room.` : 'The room membership changed.';
}

/**
 * One line for a contact row or a notification banner. Names the speaker so a
 * room preview reads "Alice · Pushed the branch", and prefixes a system notice
 * with its label so a briefing is not mistaken for somebody talking.
 */
export function roomMessagePreview(line) {
  if (!line) return '';
  const lead = line.variant === 'chat' ? line.author : line.label;
  const text = collapse(line.text);
  if (!lead) return text;
  return text ? `${lead} · ${text}` : lead;
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the server-announced short room name.
 *
 * The current namespace exposes its friendly suffix. A legacy identity exposes
 * only an opaque room ULID, so give it the same deterministic fallback label as
 * ours-cowork without pretending that a local alias is authenticated metadata.
 * Arbitrary colons and near-miss legacy names are never structural.
 */
export function roomContactLabel(announced) {
  const identity = String(announced ?? '').trim();
  if (identity.startsWith(ROOM_IDENTITY_PREFIX)) {
    const shortName = identity.slice(ROOM_IDENTITY_PREFIX.length).trim();
    return shortName || null;
  }
  const current = currentRoomMetadata(announced);
  if (current?.slug) {
    const readable = current.slug.replace(/-/g, ' ');
    return readable.replace(/[a-z]/, (letter) => letter.toUpperCase());
  }
  if (current) return `Room ${current.roomId.slice(0, 8)}`;
  const roomId = legacyRoomId(announced);
  return roomId === null ? null : `Room ${roomId.slice(0, 8)}`;
}

/** Render a room label when authenticated naming metadata exists; otherwise preserve the contact name. */
export function contactDisplayName(announced) {
  return roomContactLabel(announced) ?? String(announced ?? '');
}
