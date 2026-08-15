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
    { dir: 'in', text: 'original', date: '2026-08-15T00:00:00Z', read: true, wireId: 'WIRE-0', replyTo: null },
    { dir: 'in', text: '', date: '2026-08-15T00:00:30Z', read: true, wireId: 'WIRE-MEDIA-IN', replyTo: { wireId: 'WIRE-0' }, kind: 'file', filename: 'voice-message-now.webm', mime: 'audio/webm;codecs=opus;x-ours-kind=voice-message' },
    { dir: 'out', text: '<img src=x onerror=alert(1)> **safe**', date: '2026-08-15T00:01:00Z', read: true, wireId: 'WIRE-1', replyTo: { wireId: 'WIRE-0' }, receipt: 'read' },
    { dir: 'out', text: '', date: '2026-08-15T00:01:30Z', read: true, wireId: 'WIRE-MEDIA-OUT', replyTo: null, kind: 'file', filename: 'photo.png', mime: 'image/png' },
  ]}
  hiddenEarlier={1} onLoadEarlier={() => {}} onBack={() => {}} onSend={async () => {}} onSendFile={async () => {}} onFetchFile={async () => {}} onRemove={() => {}} onRename={() => {}}
/>);

assert.ok(conversation.includes('&lt;img src=x onerror=alert(1)&gt;'), 'message text is escaped');
assert.ok(!conversation.includes('<img src=x'), 'message content is never raw HTML');
assert.match(conversation, /aria-label="Message read"/, 'receipt state is accessible');
assert.match(conversation, /verified identity/, 'canonical identity header renders');
assert.match(conversation, /Load earlier messages/, 'bounded history control renders');
assert.match(conversation, /voice-bubble/, 'received voice renders as a canonical timeline bubble');
assert.match(conversation, /image-bubble/, 'sent photo renders as a canonical timeline bubble');
assert.ok(conversation.indexOf('chat-message-WIRE-0') < conversation.indexOf('chat-message-WIRE-MEDIA-IN'));
assert.ok(conversation.indexOf('chat-message-WIRE-MEDIA-IN') < conversation.indexOf('chat-message-WIRE-1'));
assert.ok(conversation.indexOf('chat-message-WIRE-1') < conversation.indexOf('chat-message-WIRE-MEDIA-OUT'));
assert.match(conversation, /<strong>safe<\/strong>/, 'safe GFM renders without raw HTML');

console.log('components OK — canonical timeline renders text/media chronology, replies, receipts, and safe content');
