// Messenger-only view model ported from adapt-toolkit/ours-control-plane
// bc0183c80e9ee0ea2dd5adecb58460b0564e90d5. Fleet/control models are excluded.
// @ts-ignore -- canonical pure-JS helper is typed at this seam.
import { toDate as toDateJs } from './timelineCore.mjs';
import { roomContactLabel } from '../../../shared/roomMessageCore.mjs';

const toDate = toDateJs as (value: string) => Date | null;

export interface ContactVM {
  id: string;
  name: string;
  announcedName?: string;
  initials: string;
  when: string;
  activityAt: string;
  last: string;
  unread: number;
  status: 'active' | 'pending';
  root: string | null;
  sub: string;
  roleId: string | null;
  rootName: string | null;
  mine: boolean;
  kind: 'agent' | 'person';
}

export interface RootMetaVM { label: string; note: string }

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const firstCp = (word: string) => Array.from(word).find((char) => /[\p{L}\p{N}]/u.test(char)) ?? Array.from(word)[0] ?? '';
  if (words.length === 1) {
    const cps = Array.from(words[0]);
    const alnum = cps.filter((char) => /[\p{L}\p{N}]/u.test(char));
    return (alnum.length ? alnum.slice(0, 2).join('') : cps[0] ?? '?').toUpperCase();
  }
  return (firstCp(words[0]) + firstCp(words.at(-1) ?? '')).toUpperCase();
}

export function fmtWhen(date: string): string {
  const value = toDate(date);
  if (!value) return '';
  const today = new Date();
  return value.toDateString() === today.toDateString()
    ? value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : value.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function fmtTime(date: string): string {
  const value = toDate(date);
  return value ? value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function fmtFull(date: string): string {
  const value = toDate(date);
  return value ? value.toLocaleString() : date;
}

export function shortCid(cid: string): string {
  return cid.length <= 14 ? cid : `${cid.slice(0, 8)}…${cid.slice(-4)}`;
}

export function isCidLike(value: string): boolean { return /^[0-9A-Fa-f]{40,}$/.test(value.trim()); }

export function displayName(announced: string, alias?: string | null, roleName?: string | null): string {
  const chosen = alias?.trim();
  if (chosen) return chosen;
  const name = (announced ?? '').trim();
  const room = roomContactLabel(name);
  if (room) return room;
  if (name && !isCidLike(name)) return name;
  const role = roleName?.trim();
  if (role && !isCidLike(role)) return role;
  return name ? shortCid(name) : 'Unnamed';
}

/** One API-contact presentation path for rows, toasts, and introduction banners. */
export function contactName(contact: { name: string; display_name?: string }): string {
  return contact.display_name?.trim() || displayName(contact.name);
}
