export type RoomLineVariant = 'chat' | 'system';

/** A relayed cowork room body, as it arrives on the wire (additive: unknown keys allowed). */
export interface RoomBody {
  version: 1;
  kind: string;
  room_id: string;
  signature: string;
  message_id?: string;
  at?: string;
  text?: string;
  author?: { identity?: string; display_name?: string; role?: string };
  briefing_role?: string;
  briefing_version?: number;
  membership?: { action?: string; alias?: string; role?: string; epoch?: number };
  [key: string]: unknown;
}

/** One renderable line. `text` is always readable; the body is never echoed as JSON. */
export interface RoomLine {
  variant: RoomLineVariant;
  kind: string;
  /** Speaker's display name — an ALIAS in an anonymous room. '' on system lines. */
  author: string;
  /** Speaker's room role. '' on system lines. */
  role: string;
  /** System-line label ('Briefing · reviewer · v2', 'Membership', …). '' on chat lines. */
  label: string;
  text: string;
}

export const KNOWN_ROOM_KINDS: string[];
export const ROOM_VOICE_ROLE: 'room';
export const ROOM_IDENTITY_PREFIX: 'ours-cowork-room:';
export const CURRENT_ROOM_IDENTITY_PREFIX: 'ours-cowork-';
export const LEGACY_ROOM_IDENTITY_PREFIX: 'cowork-room-';

export function parseRoomBody(text: string): RoomBody | null;
export function renderRoomMessage(body: RoomBody | null): RoomLine | null;
export function roomLineForContact(announcedContact: string, text: string): RoomLine | null;
export function isCoworkRoomContact(announced: string): boolean;
export function contactMessagePreview(announcedContact: string, text: string): string;
export function roomMessagePreview(line: RoomLine | null): string;
export function humanizeRoomKind(kind: string): string;
export function roomContactLabel(announced: string): string | null;
export function contactDisplayName(announced: string): string;
