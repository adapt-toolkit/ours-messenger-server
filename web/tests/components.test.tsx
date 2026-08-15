import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/ui/Chats.js';
import { registerMediaRecords } from '../src/ui/fileStore.js';

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
