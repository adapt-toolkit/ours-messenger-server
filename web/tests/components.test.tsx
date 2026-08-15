import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Conversation } from '../src/components/Conversation.js';
import { IdentityHeader } from '../src/components/IdentityHeader.js';

const header = renderToStaticMarkup(
  <IdentityHeader identity={{ name: 'Me', cid: 'CID-1234567890' }} connection="retrying" openInvite={() => {}} />,
);
assert.match(header, /Reconnecting/);
assert.match(header, /role="status"/);

const conversation = renderToStaticMarkup(
  <Conversation
    contact={{ name: 'Alice', container_id: 'ALICE-CID' }}
    page={{
      contact: 'ALICE-CID', total: 1, unread: 0, hasMore: false, nextBefore: null,
      messages: [{
        dir: 'out', text: '<img src=x onerror=alert(1)>', date: '2026-08-15T00:00:00Z',
        read: true, wire_id: 'WIRE-1', receipt: 'read',
      }],
    }}
    draft=""
    replyWire={null}
    sending={false}
    mobileOpen={false}
    onBack={() => {}}
    onDraft={() => {}}
    onReply={() => {}}
    onCancelReply={() => {}}
    onSend={() => {}}
  />,
);
assert.ok(conversation.includes('&lt;img src=x onerror=alert(1)&gt;'), 'message text is escaped by React');
assert.ok(!conversation.includes('<img src=x'), 'message content is never raw HTML');
assert.match(conversation, /aria-label="Read"/, 'receipt state has an accessible label');
assert.match(conversation, /aria-label="Conversation with Alice"/);

console.log('components OK — connection surface, escaped message text, and accessible receipt state');
