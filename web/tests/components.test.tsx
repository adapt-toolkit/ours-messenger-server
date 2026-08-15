import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/components/Conversation.js';
import { IdentityHeader } from '../src/components/IdentityHeader.js';

const header = renderToStaticMarkup(
  <IdentityHeader
    identity={{ name: 'Me', cid: 'CID-1234567890' }}
    connection="retrying"
    openInvite={() => {}}
    openSettings={() => {}}
    installable={false}
    install={() => {}}
  />,
);
assert.match(header, /Reconnecting/);
assert.match(header, /role="status"/);

const conversation = renderToStaticMarkup(
  <Conversation
    contact={{ name: 'Alice', container_id: 'ALICE-CID' }}
    page={{
      contact: 'ALICE-CID', total: 2, unread: 0, hasMore: true, nextBefore: 'WIRE-0',
      messages: [
        {
          dir: 'in', text: 'original', date: '2026-08-15T00:00:00Z',
          read: true, wire_id: 'WIRE-0', receipt: null,
        },
        {
          dir: 'out', text: '<img src=x onerror=alert(1)> **safe**', date: '2026-08-15T00:01:00Z',
          read: true, wire_id: 'WIRE-1', receipt: 'read', reply_to: { wire_id: 'WIRE-0' },
        },
      ],
    }}
    draft=""
    replyWire={null}
    sending={false}
    sendingLabel={null}
    files={[]}
    busyWire={null}
    contactBusy={false}
    loadingOlder={false}
    mobileOpen={false}
    onBack={() => {}}
    onLoadOlder={async () => true}
    onDraft={() => {}}
    onReply={() => {}}
    onCancelReply={() => {}}
    onSend={() => {}}
    onFiles={() => {}}
    onVoice={() => {}}
    onFetch={() => {}}
    onRename={() => {}}
    onRemove={() => {}}
    onError={() => {}}
  />,
);
assert.ok(conversation.includes('&lt;img src=x onerror=alert(1)&gt;'), 'message text is escaped by React');
assert.ok(!conversation.includes('<img src=x'), 'message content is never raw HTML');
assert.match(conversation, /aria-label="Read"/, 'receipt state has an accessible label');
assert.match(conversation, /aria-label="Conversation with Alice"/);
assert.match(conversation, /<strong>original<\/strong>/, 'reply reference renders the quoted target');
assert.match(conversation, /<strong>safe<\/strong>/, 'safe inline Markdown renders without raw HTML');
assert.match(conversation, /Load older messages/, 'a cursor-bearing page exposes the history control');

console.log('components OK — connection surface, escaped message text, and accessible receipt state');
