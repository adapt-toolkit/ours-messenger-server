// A COWORK ROOM MUST NEVER REACH A HUMAN AS RAW JSON.
//
// A room relays signed canonical JSON, so every entry's raw text is
// `{"version":1,"kind":"room_msg",...}`. The conversation already renders that
// through shared/roomMessageCore. The chat-list row and the push notification
// did not, and showed the envelope verbatim.
//
// Both are now derived server-side from THAT SAME MODULE. The kind set grows
// server-side without a client release, so a second parser written for
// notifications would diverge on the first new kind — and diverge into exactly
// the raw JSON this is fixing.
//
// The two invariants asserted across all presentation surfaces are:
//   - an unknown kind degrades to readable text, never to JSON and never blank;
//   - author.identity is never shown.

import assert from 'node:assert/strict';
import { counter } from './harness.mjs';
import { projectPage } from '../src/conversation.ts';
import { startWatcher } from '../src/watch.ts';
import { MessengerEventBus } from '../src/events.ts';
import { contactDisplayName, isCoworkRoomContact, roomContactLabel } from '../shared/roomMessageCore.mjs';
import { presentContacts } from '../src/api.ts';
import { contactName, displayName } from '../web/src/ui/viewmodel.ts';

const t = counter();

const ROOM = 'ours-cowork-room:atelier';
const ROOM_V051 = 'ours-cowork-01hzyk8m0000000000000000aa';
const ROOM_FRIENDLY = 'ours-cowork-release-2-room-01hzyk8m0000000000000000aa';
const ROOM_LEGACY = 'cowork-room-01hzyk8m0000000000000000aa';
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

const markdownResult = '# Result\n\n- **passed**\n- `evidence`';
const resultPage = pageFor(ROOM, [msg(roomBody({ kind: 'room_msg', text: markdownResult }), 1)]);
t.eq(resultPage.messages[0].text, roomBody({ kind: 'room_msg', text: markdownResult }),
  'the server preserves the signed room/Fleet envelope and canonical Markdown body exactly');
t.eq(resultPage.preview, 'Mallory · # Result - **passed** - `evidence`',
  'the plaintext preview collapses but does not render or discard Markdown syntax');

// A kind this build has never seen.
const future = pageFor(ROOM, [msg(roomBody({ kind: 'room_something_new', text: 'a kind from a newer server' }), 1)]);
t.eq(future.preview, 'Mallory · a kind from a newer server',
     'an unknown kind still reads as its text, attributed to whoever said it — additive kinds must not regress to JSON');
t.ok(!future.preview.includes('{'), 'and still carries no JSON');

const futureNoText = pageFor(ROOM, [msg(roomBody({ kind: 'room_something_new' }), 1)]);
t.eq(futureNoText.preview, 'Something new · Something new from the room.',
     'an unknown kind with NO text is named in a sentence rather than left blank or dumped raw');

// The real identity never leaves the server, and must not leave here either.
for (const page of [chat, briefing, future, futureNoText]) {
  assert.ok(!page.preview.includes('CID-THAT-MUST-NEVER-BE-SHOWN'),
    `the author identity is never shown (${page.preview})`);
}
t.ok(true, 'no preview exposes author.identity');

// ---- 1b. every supported room-identity generation, one recogniser ----------
// The server announces the room's contact name; three generations of cowork
// emit three grammars. All must be recognised, and near-misses must stay
// ordinary contacts — a false positive would reinterpret a person's messages.
t.ok(isCoworkRoomContact(ROOM), 'a named room identity (ours-cowork-room:<name>) is a room');
t.ok(isCoworkRoomContact(ROOM_V051), 'a ULID room identity (ours-cowork-<ulid>) is a room');
t.ok(isCoworkRoomContact(ROOM_FRIENDLY), 'a configured friendly room identity is a room');
t.ok(isCoworkRoomContact(ROOM_LEGACY), 'a legacy room identity (cowork-room-<ulid>) is a room');
t.ok(!isCoworkRoomContact('ours-cowork-'), 'the bare ULID prefix alone is not a room');
t.ok(!isCoworkRoomContact('ours-cowork-not-a-ulid'), 'a ULID-prefixed name with an invalid ULID is not a room');
t.ok(!isCoworkRoomContact('ours-cowork-01HZYK8M0000000000000000AA'), 'an uppercase ULID is not a room — the grammar is lowercase Crockford');
t.ok(!isCoworkRoomContact(PERSON), 'an ordinary contact is not a room');

t.eq(roomContactLabel(ROOM), 'atelier', 'a named room labels as its name');
t.eq(roomContactLabel(ROOM_V051), 'Room 01hzyk8m', 'a ULID room labels as Room <8chars>');
t.eq(roomContactLabel(ROOM_FRIENDLY), 'Release 2 room', 'a friendly identity reconstructs its slug readably');
t.eq(roomContactLabel(ROOM_LEGACY), 'Room 01hzyk8m', 'a legacy room labels as Room <8chars>');
t.eq(roomContactLabel(PERSON), null, 'an ordinary contact has no room label');

const ROOM_ID = '01hzyk8m0000000000000000aa';
for (const [slug, label] of [
  ['a', 'A'],
  ['a'.repeat(25), 'A' + 'a'.repeat(24)],
  ['2fa-release-7', '2Fa release 7'],
]) {
  const identity = `ours-cowork-${slug}-${ROOM_ID}`;
  t.ok(isCoworkRoomContact(identity), `friendly slug boundary is accepted: ${slug}`);
  t.eq(roomContactLabel(identity), label, `friendly slug boundary labels readably: ${slug}`);
}

for (const identity of [
  `ours-cowork--${ROOM_ID}`,
  `ours-cowork-${'a'.repeat(26)}-${ROOM_ID}`,
  `ours-cowork-Release-${ROOM_ID}`,
  `ours-cowork-release_room-${ROOM_ID}`,
  `ours-cowork-release--room-${ROOM_ID}`,
  `ours-cowork--release-${ROOM_ID}`,
  `ours-cowork-release--${ROOM_ID}`,
  `ours-cowork-release-${ROOM_ID.toUpperCase()}`,
  `ours-cowork-release-${ROOM_ID.slice(1)}`,
  `ours-cowork-release-${ROOM_ID}-junk`,
  `junk-${ROOM_FRIENDLY}`,
]) t.ok(!isCoworkRoomContact(identity), `friendly grammar rejects near-miss: ${identity}`);

for (const identity of [ROOM_FRIENDLY, ROOM_V051, ROOM_LEGACY]) {
  for (const wrapped of [` ${identity}`, `${identity} `]) {
    t.ok(!isCoworkRoomContact(wrapped), `ULID identity grammar rejects outer whitespace: ${wrapped}`);
    t.eq(roomContactLabel(wrapped), null, `outer-whitespace near-miss has no room label: ${wrapped}`);
  }
}

t.eq(contactDisplayName(ROOM_FRIENDLY), 'Release 2 room', 'the shared presentation helper uses the strict parser');
t.eq(displayName(ROOM_FRIENDLY), 'Release 2 room', 'the browser view model uses the same room label');
t.eq(displayName(ROOM_FRIENDLY, 'Local alias'), 'Local alias', 'an explicit local alias remains authoritative for presentation');

const contacts = presentContacts({
  contacts: [{ name: ROOM_FRIENDLY, container_id: 'CID-FRIENDLY' }, { name: PERSON, container_id: 'CID-PERSON' }],
  pending: [{ name: ROOM_FRIENDLY, container_id: 'CID-PENDING', queued: 1 }],
  roots: {}, degraded: [], renames: {},
});
t.eq(contacts.contacts[0].name, ROOM_FRIENDLY, 'the API preserves the SDK contact name for room-shape recognition');
t.eq(contacts.contacts[0].display_name, 'Release 2 room', 'the API exposes the intended presentation label additively');
t.eq(contacts.contacts[1].display_name, PERSON, 'the API leaves ordinary contact labels unchanged');
t.eq(contacts.pending[0].display_name, 'Release 2 room', 'the API presents pending friendly rooms consistently');
t.eq(contactName(contacts.pending[0]), 'Release 2 room', 'the shared browser helper keeps introduction banners off the raw identity');

// A message relayed under the v0.5.1 identity renders through the same funnel.
const v051 = pageFor(ROOM_V051, [msg(roomBody({ kind: 'room_msg', text: 'pushed the branch' }), 1)]);
t.eq(v051.preview, 'Mallory · pushed the branch', 'a v0.5.1 room message previews as speaker and words');
t.ok(!v051.preview.includes('{'), 'and carries no JSON');

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
      yield { event: 'message_received', sender_id: 'CID-ROOM', sender_name: ROOM_FRIENDLY, wire_id: 'W1', date: 'D1' };
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
     'nothing in the notification payload names the author identity');
t.eq(pushed[0].title, 'Release 2 room', 'the immediate push title uses the configured friendly room label');
t.ok(!JSON.stringify(pushed[0]).includes(ROOM_FRIENDLY), 'the immediate push leaks no generated room identity label');

console.log(`\nroom-preview OK (${t.count} checks) — one recogniser across presentation surfaces, no raw JSON and no leaked identity`);
process.exit(0);
