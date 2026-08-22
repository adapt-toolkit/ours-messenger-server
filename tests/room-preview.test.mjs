// A COWORK ROOM MUST NEVER REACH A HUMAN AS RAW JSON.
//
// A room relays signed canonical JSON, so every entry's raw text is
// `{"version":1,"kind":"room_msg",...}`. The conversation already renders that
// through shared/roomMessageCore. The chat-list row and the push notification
// did not, and showed the envelope verbatim.
//
// Both are now derived server-side from THAT SAME MODULE, which is the whole
// point: INV-R6 says the kind set grows server-side without a client release, so
// a second parser written for notifications would diverge on the first new kind
// — and diverge into exactly the raw JSON this is fixing.
//
// The two invariants are asserted here because they now bind two more surfaces
// than when they were written:
//   INV-R6  an unknown kind degrades to readable text, never to JSON, never blank
//   INV-R3  author.identity is never shown

import assert from 'node:assert/strict';
import { counter } from './harness.mjs';
import { projectPage } from '../src/conversation.ts';
import { startWatcher } from '../src/watch.ts';
import { MessengerEventBus } from '../src/events.ts';

const t = counter();

const ROOM = 'ours-cowork-room:atelier';
const PERSON = 'Alice';

const roomBody = (extra) => JSON.stringify({
  version: 1,
  room_id: '01hzyk8m0000000000000000aa',
  signature: 'SIG',
  author: { identity: 'CID-THAT-MUST-NEVER-BE-SHOWN', display_name: 'Mallory', role: 'member' },
  ...extra,
});

const msg = (text, index) => ({
  dir: 'in', text, date: `2026-08-17T00:00:${String(index).padStart(2, '0')}.000Z`,
  read: true, wire_id: `W${index}`, receipt: null,
});

const pageFor = (announcedContact, messages) =>
  projectPage(announcedContact, messages, { receipts: {} }, { limit: 50, announcedContact });

// ---- 1. the chat-list preview ----------------------------------------------
const chat = pageFor(ROOM, [msg(roomBody({ kind: 'room_msg', text: 'pushed the branch' }), 1)]);
t.eq(chat.preview, 'Mallory · pushed the branch', 'a room message previews as speaker and words');
t.ok(!chat.preview.includes('{'), 'and carries no JSON');

const briefing = pageFor(ROOM, [msg(roomBody({ kind: 'room_briefing', briefing_version: 2, text: 'Ship on Friday.' }), 1)]);
t.eq(briefing.preview, 'Room briefing · v2 · Ship on Friday.', 'a system notice is labelled as one, not mistaken for someone talking');

// INV-R6: a kind this build has never seen.
const future = pageFor(ROOM, [msg(roomBody({ kind: 'room_something_new', text: 'a kind from a newer server' }), 1)]);
t.eq(future.preview, 'Mallory · a kind from a newer server',
     'INV-R6: an unknown kind still reads as its text, attributed to whoever said it — additive kinds must not regress to JSON');
t.ok(!future.preview.includes('{'), 'and still carries no JSON');

const futureNoText = pageFor(ROOM, [msg(roomBody({ kind: 'room_something_new' }), 1)]);
t.eq(futureNoText.preview, 'Something new · Something new from the room.',
     'an unknown kind with NO text is named in a sentence rather than left blank or dumped raw');

// INV-R3: the real identity never leaves the server, and must not leave here either.
for (const page of [chat, briefing, future, futureNoText]) {
  assert.ok(!page.preview.includes('CID-THAT-MUST-NEVER-BE-SHOWN'),
    `INV-R3: the author identity is never shown (${page.preview})`);
}
t.ok(true, 'INV-R3: no preview exposes author.identity');

// ---- 2. what must NOT be claimed -------------------------------------------
// A person typing JSON into the composer keeps seeing what they typed.
const typed = '{"version":1,"kind":"room_msg","text":"look what I can type"}';
t.eq(pageFor(PERSON, [msg(typed, 1)]).preview, typed,
     'an ORDINARY contact\'s message is never reinterpreted — contact scoping is the trust boundary');
t.eq(pageFor(ROOM, [msg('{"version":1,"kind":"room_msg"', 1)]).preview, '{"version":1,"kind":"room_msg"',
     'and a malformed body in a room is left as the text it is, rather than half-parsed');
t.eq(pageFor(ROOM, [msg('just a sentence', 1)]).preview, 'just a sentence',
     'a plain sentence in a room stays a plain sentence');

// ---- 3. the preview tracks the NEWEST entry, not the page window ------------
const many = Array.from({ length: 60 }, (_, i) => msg(roomBody({ kind: 'room_msg', text: `line ${i}` }), i));
const newest = pageFor(ROOM, many);
t.eq(newest.preview, 'Mallory · line 59', 'the preview is the newest entry in the conversation');
const older = projectPage(ROOM, many, { receipts: {} }, { limit: 10, before: 'W20', announcedContact: ROOM });
t.eq(older.preview, 'Mallory · line 59',
     'and paging backwards does not rewrite the chat-list row to an old line');
t.eq(pageFor(ROOM, []).preview, '', 'an empty conversation has no preview');

// ---- 4. the push notification, through the real watcher --------------------
const roomText = roomBody({ kind: 'room_msg', text: 'the deploy is green' });
const pushed = [];
const client = {
  getHistoryItem: async () => ({
    ...msg(roomText, 1), direction: 'in', peer: { id: 'CID-ROOM', name: ROOM },
  }),
  listIncomingFiles: async () => [],
  version: async () => ({ ok: true }),
};
const events = new MessengerEventBus();
const watcher = startWatcher(
  client,
  'Me',
  { send: async (event) => { pushed.push(event); return { sent: 1, pruned: 0, failed: 0 }; } },
  { info() {}, warn() {} },
  events,
  {
    watch: async function* () {
      yield { event: 'message_received', sender_id: 'CID-ROOM', sender_name: ROOM, wire_id: 'W1', date: 'D1' };
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    wait: async () => {},
  },
);
await new Promise((resolve) => setTimeout(resolve, 400));
await watcher.stop();

t.eq(pushed.length >= 1, true, 'the watcher composed a push for the room message');
t.eq(pushed[0].body, 'Mallory · the deploy is green',
     'AND ITS BODY IS THE READABLE LINE — this is the surface a user cannot scroll past');
t.ok(!pushed[0].body.includes('{'), 'the notification carries no JSON');
t.ok(!JSON.stringify(pushed[0]).includes('CID-THAT-MUST-NEVER-BE-SHOWN'),
     'INV-R3 holds on the notification too — nothing in the payload names the author identity');

console.log(`\nroom-preview OK (${t.count} checks) — one recogniser, three surfaces, no raw JSON and no leaked identity`);
process.exit(0);
