import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { timeline } from '../src/App.js';
import { Conversation } from '../src/ui/Chats.js';
import { registerMediaRecords } from '../src/ui/fileStore.js';
import type { ConversationPage } from '../src/types.js';

const muflPage: ConversationPage = {
  contact: 'ALICE-CID',
  messages: [
    { dir: 'in', text: 'older inbound', date: '2026-08-15 15:30:00.111111111 (UTC)', read: true, wire_id: 'ZZ-OLD-IN', receipt: null },
    { dir: 'out', text: 'older outbound', date: '2026-08-15 15:31:00.222222222 (UTC)', read: true, wire_id: 'YY-OLD-OUT', receipt: 'read' },
    { dir: 'in', text: 'new inbound', date: '2026-08-15 15:32:00.333333333 (UTC)', read: false, wire_id: 'AA-NEW-IN', receipt: null },
    { dir: 'out', text: 'new outbound', date: '2026-08-15 15:33:00.444444444 (UTC)', read: true, wire_id: '00-NEW-OUT', receipt: 'delivered' },
  ],
  total: 4, unread: 1, hasMore: false, nextBefore: null,
};

// V8 accepts MUFL's non-ISO transaction timestamp leniently. Proxy Date to
// reproduce JavaScriptCore's strict constructor while retaining strict-ISO
// Date.parse, so this regression fails on every development/CI engine.
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
  const ordered = timeline(muflPage, []);
  assert.deepEqual(
    ordered.map(({ wireId, dir }) => [wireId, dir]),
    [['ZZ-OLD-IN', 'in'], ['YY-OLD-OUT', 'out'], ['AA-NEW-IN', 'in'], ['00-NEW-OUT', 'out']],
    'JSC-invalid MUFL dates still sort chronologically in both directions',
  );
  assert.equal(ordered.at(-1)?.text, 'new outbound', 'the newest row remains at the bottom-pinned edge');

  const equal = timeline({
    ...muflPage,
    messages: [
      { ...muflPage.messages[0], wire_id: 'Z-EQUAL' },
      { ...muflPage.messages[0], wire_id: 'A-EQUAL', dir: 'out' },
    ],
  }, []);
  assert.deepEqual(equal.map(({ wireId }) => wireId), ['A-EQUAL', 'Z-EQUAL'], 'equal timestamps retain the stable wire-id tie break');

  const invalid = timeline({
    ...muflPage,
    messages: [
      { ...muflPage.messages[0], date: 'not-a-date', wire_id: 'B-INVALID' },
      { ...muflPage.messages[1], date: 'also-not-a-date', wire_id: 'A-INVALID' },
      { ...muflPage.messages[2], wire_id: '0-VALID' },
    ],
  }, []);
  assert.deepEqual(invalid.map(({ wireId }) => wireId), ['A-INVALID', 'B-INVALID', '0-VALID'], 'invalid dates use epoch fallback without poisoning valid chronology');
} finally {
  globalThis.Date = nativeDate;
}

registerMediaRecords([
  {
    wire_id: 'WIRE-MEDIA-IN', contact_id: 'ALICE-CID', dir: 'in', sender_id: 'ALICE-CID', sender_name: 'Alice',
    filename: 'voice-message-now.webm', logical_name: 'voice-message-now.webm', version: 1,
    mime: 'audio/webm;codecs=opus;x-ours-kind=voice-message', size: 1234, sha256: 'a'.repeat(64),
    date: '2026-08-15T00:00:30Z', date_source: 'protocol', kind: 'voice_message', reply_to: { wire_id: 'WIRE-0' }, available: true,
  },
  {
    wire_id: 'WIRE-MEDIA-OUT', contact_id: 'ALICE-CID', dir: 'out', sender_id: 'ME', sender_name: 'Me',
    filename: 'photo.png', logical_name: 'photo.png', version: 1, mime: 'image/png', size: 456,
    sha256: 'b'.repeat(64), date: '2026-08-15T00:01:30Z', date_source: 'server_observed', kind: 'photo', reply_to: null, available: true,
  },
]);

const conversation = renderToStaticMarkup(<Conversation
  contact={{ id: 'ALICE-CID', name: 'Alice', announcedName: 'Alice', initials: 'A', when: '', activityAt: '', last: '', unread: 0, status: 'active', root: null, sub: '', roleId: null, rootName: null, mine: false, kind: 'person' }}
  messages={[
    { dir: 'in', text: '**original source**', date: '2026-08-15T00:00:00Z', read: true, wireId: 'WIRE-0', replyTo: null },
    { dir: 'in', text: '', date: '2026-08-15T00:00:30Z', read: true, wireId: 'WIRE-MEDIA-IN', replyTo: { wireId: 'WIRE-0' }, kind: 'file', filename: 'voice-message-now.webm', mime: 'audio/webm;codecs=opus;x-ours-kind=voice-message' },
    { dir: 'out', text: '<img src=x onerror=alert(1)> **safe**', date: '2026-08-15T00:01:00Z', read: true, wireId: 'WIRE-1', replyTo: { wireId: 'WIRE-0' }, receipt: 'read' },
    { dir: 'out', text: '', date: '2026-08-15T00:01:30Z', read: true, wireId: 'WIRE-MEDIA-OUT', replyTo: null, kind: 'file', filename: 'photo.png', mime: 'image/png' },
  ]}
  hiddenEarlier={1} onLoadEarlier={() => {}} onBack={() => {}} onSend={async () => {}} onSendFile={async () => {}} onFetchFile={async () => {}} onRemove={() => {}} onRename={() => {}}
/>);

assert.ok(conversation.includes('&lt;img src=x onerror=alert(1)&gt;'), 'message text is escaped');
assert.ok(!conversation.includes('<img src=x'), 'message content is never raw HTML');
assert.match(conversation, /aria-label="Message read"/, 'receipt state is accessible');
assert.match(conversation, /Encrypted connection/, 'compact conversation header preserves connection provenance');
assert.match(conversation, /Load earlier messages/, 'bounded history control renders');
assert.match(conversation, /voice-bubble/, 'received voice renders as a canonical timeline bubble');
assert.match(conversation, /image-bubble/, 'sent photo renders as a canonical timeline bubble');
const composerTextarea = conversation.match(/<textarea[^>]*>/)?.[0] ?? '';
assert.match(composerTextarea, /aria-busy="false"/, 'composer exposes async send state without disabling its focus anchor');
assert.doesNotMatch(composerTextarea, /\sdisabled(?:=|\s|>)/, 'composer textarea remains focusable for mobile keyboard continuity');
assert.ok(conversation.indexOf('chat-message-WIRE-0') < conversation.indexOf('chat-message-WIRE-MEDIA-IN'));
assert.ok(conversation.indexOf('chat-message-WIRE-MEDIA-IN') < conversation.indexOf('chat-message-WIRE-1'));
assert.ok(conversation.indexOf('chat-message-WIRE-1') < conversation.indexOf('chat-message-WIRE-MEDIA-OUT'));
assert.match(conversation, /<strong>safe<\/strong>/, 'safe GFM renders without raw HTML');
assert.match(conversation, /quote-text[^>]*>\*\*original source\*\*</,
  'reply snippets preserve the canonical source instead of renderer-normalized markup');

const roomEnvelope = (kind: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  kind,
  room_id: '01hzyk8m0000000000000000aa',
  message_id: `MESSAGE-${kind}`,
  signature: 'SIGNED-BY-ROOM',
  at: '2026-08-15T00:00:00Z',
  author: {
    identity: 'CID-NEVER-DISPLAYED',
    display_name: kind === 'room_msg' ? 'Secretary' : 'Room',
    role: kind === 'room_msg' ? 'Secretary' : 'room',
  },
  text,
  ...extra,
});

const roomConversation = renderToStaticMarkup(<Conversation
  contact={{ id: 'ROOM-CID', name: 'Release room', announcedName: 'ours-cowork-room:release', initials: 'R', when: '', activityAt: '', last: '', unread: 0, status: 'active', root: null, sub: '', roleId: null, rootName: null, mine: false, kind: 'person' }}
  messages={[
    { dir: 'in', text: roomEnvelope('room_msg', '## Pair result\n**approved**\n1. evidence'), date: '2026-08-15T00:00:00Z', read: true, wireId: 'ROOM-CHAT', replyTo: null },
    { dir: 'in', text: roomEnvelope('room_role_briefing', '# Fleet task\n- audit\n- ship', { briefing_role: 'Secretary', briefing_version: 2 }), date: '2026-08-15T00:01:00Z', read: true, wireId: 'ROOM-SYSTEM', replyTo: null },
    { dir: 'in', text: roomEnvelope('room_briefing', 'Проверьте, что постоянные инвайты сохраняются после перезапуска комнаты.', { room_name: 'Постоянные инвайты должны сохраняться', briefing_version: 7 }), date: '2026-08-15T00:02:00Z', read: true, wireId: 'ROOM-BRIEFING', replyTo: null },
    { dir: 'in', text: roomEnvelope('room_membership', 'Рецензент покинул комнату.', { membership: { action: 'remove', alias: 'Рецензент', role: 'Reviewer', epoch: 7 } }), date: '2026-08-15T00:03:00Z', read: true, wireId: 'ROOM-MEMBERSHIP', replyTo: null },
    { dir: 'in', text: roomEnvelope('room_file', '', { filename: 'отчёт.pdf', mime: 'application/pdf', size: 1536, sha256: 'a'.repeat(64) }), date: '2026-08-15T00:04:00Z', read: true, wireId: 'ROOM-FILE', replyTo: null },
    { dir: 'in', text: roomEnvelope('room_not_member', '', { author: undefined, at: undefined }), date: '2026-08-15T00:05:00Z', read: true, wireId: 'ROOM-NOT-MEMBER', replyTo: null },
  ]}
  onBack={() => {}} onSend={async () => {}} onRemove={() => {}} onRename={() => {}}
/>);

assert.match(roomConversation, /room-author-name[^>]*>Secretary<\//,
  'a signed room_msg attributes the pair result to its room alias');
assert.match(roomConversation, /<h2>Pair result<\/h2>/,
  'a signed room_msg tool/result body uses the shared Markdown renderer');
assert.match(roomConversation, /<strong>approved<\/strong>/);
assert.match(roomConversation, /class="room-system room-role-card" role="note"/,
  'Fleet system output keeps the accessible room-note wrapper');
assert.match(roomConversation, /room-system-label[^>]*>Role briefing · Secretary · v2<\//,
  'the authenticated Fleet label remains separate from body Markdown');
assert.match(roomConversation, /room-system-text message-markdown[^>]*data-render-mode="markdown"/,
  'only the room system text child enters the shared renderer');
assert.match(roomConversation, /<h1>Fleet task<\/h1>/);
assert.match(roomConversation, /room-system-at/, 'the system timestamp remains a separate child');
assert.doesNotMatch(roomConversation, /CID-NEVER-DISPLAYED/, 'room rendering never exposes author.identity');
assert.match(roomConversation, /room-briefing-card/, 'common briefing has its dedicated card');
assert.match(roomConversation, /Постоянные инвайты должны сохраняться/, 'exact Unicode room_name is retained');
assert.match(roomConversation, /Проверьте, что постоянные инвайты сохраняются после перезапуска комнаты\./,
  'Russian room_briefing payload is retained exactly');
assert.match(roomConversation, /room-membership-card/);
assert.match(roomConversation, /Status: Remove/);
assert.match(roomConversation, /Epoch: 7/);
assert.match(roomConversation, /room-file-card/);
assert.match(roomConversation, /отчёт\.pdf/);
assert.match(roomConversation, /Size: 1\.5 KiB/);
assert.match(roomConversation, /room-lifecycle-card/);
assert.match(roomConversation, /You are no longer a member of this room\./);
assert.doesNotMatch(roomConversation, /\{&quot;kind&quot;/, 'no supported room envelope renders as JSON');

console.log('components OK — canonical timeline and ordinary/room/Fleet Markdown paths preserve source and accessibility');
