import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { timeline } from '../src/App.js';
import { Conversation } from '../src/ui/Chats.js';
import { CommandPanel, validateCommandValue } from '../src/ui/CommandPanel.js';
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
    { dir: 'out', text: '', date: '2026-08-15T00:02:00Z', read: true, wireId: 'WIRE-COMMAND', replyTo: null, messageKind: 'command', typed: { kind: 'command', command: '<img onerror=run()>', arguments: { '': '', nested: [null, true, 0] } } },
    { dir: 'in', text: '', date: '2026-08-15T00:02:30Z', read: true, wireId: 'WIRE-RESULT', replyTo: { wireId: 'WIRE-COMMAND' }, messageKind: 'command_result', typed: { kind: 'command_result', outcome: { ok: false, status: 'policy_denied', message: '<script>unsafe</script>' } } },
    { dir: 'in', text: '', date: '2026-08-15T00:03:00Z', read: true, wireId: 'WIRE-FUTURE', replyTo: null, messageKind: 'future_v2', typed: { kind: 'unknown', wire_kind: 'future_v2', malformed: false } },
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
const composerTextarea = conversation.match(/<textarea[^>]*>/)?.[0] ?? '';
assert.match(composerTextarea, /aria-busy="false"/, 'composer exposes async send state without disabling its focus anchor');
assert.doesNotMatch(composerTextarea, /\sdisabled(?:=|\s|>)/, 'composer textarea remains focusable for mobile keyboard continuity');
assert.ok(conversation.indexOf('chat-message-WIRE-0') < conversation.indexOf('chat-message-WIRE-MEDIA-IN'));
assert.ok(conversation.indexOf('chat-message-WIRE-MEDIA-IN') < conversation.indexOf('chat-message-WIRE-1'));
assert.ok(conversation.indexOf('chat-message-WIRE-1') < conversation.indexOf('chat-message-WIRE-MEDIA-OUT'));
assert.match(conversation, /<strong>safe<\/strong>/, 'safe GFM renders without raw HTML');
assert.match(conversation, /quote-text[^>]*>\*\*original source\*\*</,
  'reply snippets preserve the canonical source instead of renderer-normalized markup');
assert.match(conversation, /Accepted · pending result/, 'outbound commands expose their accepted/pending state');
assert.match(conversation, /Result for &lt;img onerror=run\(\)&gt;/,
  'results correlate to their command through the preserved reply wire id and escape the command name');
assert.match(conversation, /Policy denied/, 'structured denial status is distinct from success');
assert.ok(!conversation.includes('<script>unsafe</script>'), 'typed results never become raw HTML');
assert.match(conversation, /Future typed message preserved/, 'unknown future typed kinds fail visibly and safely');

const commandPanel = renderToStaticMarkup(<CommandPanel
  catalog={{
    recipient_cid: 'ALICE-CID', fingerprint: 'A'.repeat(43), commands: [{
      name: 'notes.create', description: '<img src=x onerror=alert(1)>',
      input_schema: {
        type: 'object', required: [''], properties: {
          '': { type: 'string', title: 'Empty key value', default: '' },
          priority: { type: 'integer', enum: [0, 1], description: '<script>priority</script>' },
          tags: { type: 'array', items: { type: 'string' }, default: [] },
        },
      },
    }],
  }}
  busy={false} onRefresh={() => {}} onClose={() => {}} onSend={async () => ({
    invocation_id: crypto.randomUUID(), recipient_cid: 'ALICE-CID', catalog_fingerprint: 'A'.repeat(43),
    command: 'notes.create', wire_id: 'WIRE', delivery: 'e2e', status: 'accepted',
    payload_fingerprint: 'B'.repeat(43), deduplicated: false,
  })}
/>);
assert.match(commandPanel, /aria-label="Send a typed command"/, 'command form has an accessible name');
assert.match(commandPanel, /Empty key value \*/, 'required empty-string object keys remain editable');
assert.match(commandPanel, /Confirm sending this command/, 'mutation confirmation is explicit');
assert.ok(!commandPanel.includes('<img src=x'), 'untrusted command documentation is escaped');

const unsupportedPanel = renderToStaticMarkup(<CommandPanel
  catalog={{ recipient_cid: 'ALICE-CID', fingerprint: 'A'.repeat(43), commands: [{
    name: 'unsafe', input_schema: { type: 'object', oneOf: [{ type: 'string' }] },
  }] }} busy={false} onRefresh={() => {}} onClose={() => {}} onSend={async () => { throw new Error('must not run'); }}
/>);
assert.match(unsupportedPanel, /role="alert"/, 'unsupported schema constructs are visibly refused');
assert.match(unsupportedPanel, /Unsupported JSON Schema keyword: oneOf/);
assert.equal(validateCommandValue({ type: 'array', minItems: 1, items: { type: 'integer' } }, []),
  'Arguments has too few items');
assert.equal(validateCommandValue({ type: 'array', items: { type: 'integer' } }, [1.5]),
  'Arguments[0] must be an integer');
assert.equal(validateCommandValue({ type: 'object', required: [''], properties: { '': { type: 'string' } } }, { '': '' }), null,
  'an empty-string key and value remain valid JsonValue rather than disappearing in truthiness checks');

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
  ]}
  onBack={() => {}} onSend={async () => {}} onRemove={() => {}} onRename={() => {}}
/>);

assert.match(roomConversation, /room-author-name[^>]*>Secretary<\//,
  'a signed room_msg attributes the pair result to its room alias');
assert.match(roomConversation, /<h2>Pair result<\/h2>/,
  'a signed room_msg tool/result body uses the shared Markdown renderer');
assert.match(roomConversation, /<strong>approved<\/strong>/);
assert.match(roomConversation, /class="room-system" role="note"/,
  'Fleet system output keeps the accessible room-note wrapper');
assert.match(roomConversation, /room-system-label[^>]*>Role briefing · Secretary · v2<\//,
  'the authenticated Fleet label remains separate from body Markdown');
assert.match(roomConversation, /room-system-text message-markdown[^>]*data-render-mode="markdown"/,
  'only the room system text child enters the shared renderer');
assert.match(roomConversation, /<h1>Fleet task<\/h1>/);
assert.match(roomConversation, /room-system-at/, 'the system timestamp remains a separate child');
assert.doesNotMatch(roomConversation, /CID-NEVER-DISPLAYED/, 'room rendering never exposes author.identity');

console.log('components OK — canonical timeline and ordinary/room/Fleet Markdown paths preserve source and accessibility');
