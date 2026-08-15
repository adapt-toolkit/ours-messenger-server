import { timeMs } from './timelineCore.mjs';

export const CONVERSATION_LIST_MODE_KEY = 'ours.chats.listMode';
export const DEFAULT_CONVERSATION_LIST_MODE = 'recent';

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readConversationListMode(storage = defaultStorage()) {
  try {
    return storage?.getItem(CONVERSATION_LIST_MODE_KEY) === 'identity'
      ? 'identity'
      : DEFAULT_CONVERSATION_LIST_MODE;
  } catch {
    return DEFAULT_CONVERSATION_LIST_MODE;
  }
}

export function writeConversationListMode(mode, storage = defaultStorage()) {
  const next = mode === 'identity' ? 'identity' : DEFAULT_CONVERSATION_LIST_MODE;
  try {
    storage?.setItem(CONVERSATION_LIST_MODE_KEY, next);
    return storage?.getItem(CONVERSATION_LIST_MODE_KEY) === next
      ? next
      : DEFAULT_CONVERSATION_LIST_MODE;
  } catch {
    return DEFAULT_CONVERSATION_LIST_MODE;
  }
}

function stableText(value) {
  return typeof value === 'string' ? value : '';
}

function compareStableText(a, b) {
  const left = stableText(a);
  const right = stableText(b);
  const foldedLeft = left.normalize().toLowerCase();
  const foldedRight = right.normalize().toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// Newest dialogue activity first. Empty/malformed/equal timestamps never make
// Array.sort engine-dependent: display label, then the immutable identity id,
// provide a total order (including renamed and duplicate-name contacts).
export function compareConversationActivity(a, b) {
  const delta = timeMs(stableText(b.activityAt)) - timeMs(stableText(a.activityAt));
  if (delta !== 0) return delta;
  const byName = compareStableText(a.name, b.name);
  if (byName !== 0) return byName;
  return compareStableText(a.id, b.id);
}

export function sortConversationsByActivity(contacts) {
  return [...contacts].sort(compareConversationActivity);
}

function groupActivity(group) {
  return group.contacts.length > 0 ? timeMs(stableText(group.contacts[0].activityAt)) : 0;
}

export function groupConversationsByIdentity(contacts, roots) {
  const groups = new Map();
  const rootless = [];

  for (const contact of contacts) {
    // A Human/root contact has no delegation root of its own, but belongs beside
    // its verified roles when its cid is a known root id.
    const rootId = contact.root || (roots?.[contact.id] ? contact.id : null);
    if (!rootId) {
      rootless.push(contact);
      continue;
    }
    const meta = roots?.[rootId] || { label: rootId, note: '' };
    let group = groups.get(rootId);
    if (!group) {
      group = { id: `root:${rootId}`, rootId, label: meta.label, note: meta.note, contacts: [] };
      groups.set(rootId, group);
    }
    group.contacts.push(contact);
  }

  const out = [...groups.values()].map((group) => ({
    ...group,
    contacts: sortConversationsByActivity(group.contacts),
  }));
  if (rootless.length > 0) {
    out.push({
      id: 'rootless',
      rootId: null,
      label: 'Independent identities',
      note: 'People, agents and apps without a verified Human/root group',
      contacts: sortConversationsByActivity(rootless),
    });
  }

  return out.sort((a, b) => {
    const delta = groupActivity(b) - groupActivity(a);
    if (delta !== 0) return delta;
    const byLabel = compareStableText(a.label, b.label);
    if (byLabel !== 0) return byLabel;
    return compareStableText(a.id, b.id);
  });
}
