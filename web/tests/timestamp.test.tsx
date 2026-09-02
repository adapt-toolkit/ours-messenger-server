import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { timeline } from '../src/App.js';
import { appReducer, initialState, pageFor } from '../src/store.js';
import { Conversation } from '../src/ui/Chats.js';
import { FileBubble } from '../src/ui/FileBubbles.js';
// @ts-ignore -- canonical pure-JS helper is typed at its production seams.
import { timeMs, toDate, toIsoUtc } from '../src/ui/timelineCore.mjs';
import { fmtTime, fmtWhen } from '../src/ui/viewmodel.js';
import type { ChatMessage } from '../src/ui/chatTypes.js';
import type { ConversationMessage, ConversationPage } from '../src/types.js';

process.env.TZ = 'Europe/Prague';

assert.equal(toIsoUtc('2026-09-02T08:34:00.123456Z'), '2026-09-02T08:34:00.123Z',
  'a strict UTC input remains the same instant');
assert.equal(toIsoUtc('2026-09-02 08:34:00.123456789 (UTC)'), '2026-09-02T08:34:00.123Z',
  'a persisted MUFL UTC timestamp becomes strict ISO');
assert.equal(toIsoUtc('2026-09-02T10:34:00.123456+02:00'), '2026-09-02T08:34:00.123Z',
  'an explicit offset is applied once instead of being relabelled as UTC');
assert.equal(toIsoUtc('2026-09-02T03:04:05-05:30'), '2026-09-02T08:34:05.000Z',
  'negative non-hour offsets are preserved');
assert.equal(toIsoUtc('2026-09-02T08:34:00Z trailing'), null,
  'a date prefix with trailing junk is not silently accepted');
assert.equal(toIsoUtc('2026-13-02T08:34:00Z'), null, 'invalid calendar values are rejected');
assert.equal(toIsoUtc('2026-02-31T08:34:00Z'), null, 'rollover calendar dates are rejected');

const roomCid = 'ROOM-CID';
const historyRow = (wire_id: string, date: string, text = wire_id): ConversationMessage => ({
  dir: 'in', text, date, read: true, wire_id, receipt: null, reply_to: null,
});
const conversationPage = (messages: ConversationMessage[]): ConversationPage => ({
  contact: roomCid, messages, total: messages.length, unread: 0, hasMore: false, nextBefore: null,
});

let state = initialState({ name: 'chats', contactCid: roomCid });
state = appReducer(state, {
  type: 'snapshot',
  identity: { name: 'Me', cid: 'ME-CID' },
  contacts: { contacts: [{ name: 'ours-cowork:Timestamp parity', container_id: roomCid }], pending: [] },
});
state = appReducer(state, {
  type: 'page', contactCid: roomCid,
  page: conversationPage([historyRow('HISTORY', '2026-09-02 08:34:00.000000000 (UTC)')]),
});
assert.equal(timeMs(pageFor(state, roomCid)!.messages[0].date), Date.parse('2026-09-02T08:34:00.000Z'),
  'persisted history hydration retains the canonical instant');

const live = historyRow('LIVE', '2026-09-02T10:35:00+02:00');
state = appReducer(state, {
  type: 'page', contactCid: roomCid,
  page: conversationPage([pageFor(state, roomCid)!.messages[0], live]),
});
assert.equal(timeMs(pageFor(state, roomCid)!.messages[1].date), Date.parse('2026-09-02T08:35:00.000Z'),
  'a refreshed page hydrates an explicit-offset message exactly once');
assert.deepEqual(timeline(pageFor(state, roomCid), []).map((message) => message.wireId), ['HISTORY', 'LIVE'],
  'persisted and refreshed representations share chronological ordering');

const now = new Date();
const localDate = (hour: number, minute: number) => new Date(
  now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0,
).toISOString();
const localDay = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
const canonicalChatAt = localDate(10, 34);
const canonicalSystemAt = localDate(10, 35);
const divergentEnvelopeAt = `${localDay}T08:34:00+02:00`;
assert.notEqual(fmtTime(divergentEnvelopeAt), fmtTime(canonicalChatAt),
  'the fixture reproduces a room envelope time that diverges from canonical history');

const roomBody = (kind: string, text: string) => JSON.stringify({
  version: 1, kind, room_id: 'ROOM-ID', room_name: 'Timestamp parity',
  author: { display_name: kind === 'room_msg' ? 'Member' : 'Room', role: kind === 'room_msg' ? 'Developer' : 'room' },
  text, at: divergentEnvelopeAt,
});
const roomMessages: ChatMessage[] = [
  { dir: 'in', text: roomBody('room_msg', 'chat'), date: canonicalChatAt, read: true, wireId: 'ROOM-CHAT', replyTo: null },
  { dir: 'in', text: roomBody('room_briefing', 'system'), date: canonicalSystemAt, read: true, wireId: 'ROOM-SYSTEM', replyTo: null },
];
const renderedRoom = renderToStaticMarkup(<Conversation
  contact={{ id: roomCid, name: 'Timestamp parity', announcedName: 'ours-cowork:Timestamp parity', initials: 'T', when: fmtWhen(canonicalSystemAt), activityAt: canonicalSystemAt, last: 'system', unread: 0, status: 'active', root: null, sub: '', roleId: null, rootName: null, mine: false, kind: 'person' }}
  messages={roomMessages} onBack={() => {}} onSend={async () => {}} onRemove={() => {}} onRename={() => {}}
/>);
assert.match(renderedRoom, new RegExp(`class="bubble-at">${fmtTime(canonicalChatAt)}`),
  'room chat detail uses canonical history time');
assert.match(renderedRoom, new RegExp(`class="room-system-at">${fmtTime(canonicalSystemAt)}`),
  'room system detail uses canonical history time');
assert.equal(fmtWhen(canonicalSystemAt), fmtTime(canonicalSystemAt),
  'today\'s chat-list time matches the opened room detail');

const nativeDate = globalThis.Date;
globalThis.Date = new Proxy(nativeDate, {
  construct(target, args) {
    if (args.length === 1 && typeof args[0] === 'string' && args[0].endsWith('(UTC)')) {
      return Reflect.construct(target, [Number.NaN]);
    }
    return Reflect.construct(target, args);
  },
});
try {
  const mufl = `${localDay} 08:34:00.000000000 (UTC)`;
  const file = renderToStaticMarkup(<FileBubble rec={{
    id: 'FILE', dir: 'in', filename: 'history.pdf', mime: 'application/pdf', size: 1, date: mufl,
  }} />);
  assert.match(file, new RegExp(`class="bubble-at">${fmtTime(mufl)}`),
    'file and voice bubbles use the same engine-independent formatter as list and text detail');
} finally {
  globalThis.Date = nativeDate;
}

assert.ok(toDate('2026-09-02T10:34:00+02:00') instanceof nativeDate);
console.log('timestamp OK — UTC, offsets, history/live hydration, room list/detail parity, and media variants');
