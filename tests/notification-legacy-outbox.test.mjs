import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessengerNotificationProducer } from '../src/notification-producer.ts';

// Outbox entries written before typed targets: every earlier release persisted the
// projected payload before its first send, so an entry without one was never sent.
mkdirSync('.test-artifacts', { recursive: true });
const dir = mkdtempSync(join('.test-artifacts', 'notification-legacy-outbox-'));
const accepted = [], cleanups = []; let fail = true;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (fail) { res.writeHead(503); res.end(); return; }
  (req.url === '/api/v1/delete-target' ? cleanups : accepted).push(JSON.parse(body)); res.end('{}');
}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const config = { origin: `http://127.0.0.1:${server.address().port}`, token: 'p'.repeat(40) };
const client = { listContacts: async () => ({ contacts: [{ container_id: 'PEER' }], pending: [] }),
  getHistoryItem: async ({ wire_id }) => ({ wire_id, direction: 'in', text: 'Hello ' + wire_id, peer: { id: 'PEER', name: 'Alice' } }),
  getFileInfo: async () => { throw new Error('unexpected file lookup'); } };
const file = join(dir, 'notification-outbox.json');
const raw = (wire, sender = 'PEER') => ({ id: `USER:${wire}:message_received`, value: { event: 'message_received', sender_id: sender, wire_id: wire, sender_name: 'Alice' } });
const frozen = { ...raw('FROZEN'), payload: { eventId: 'USER:FROZEN:message_received', title: 'Alice', body: 'Original', url: '/fleet/chats/contacts/PEER#chat-message-FROZEN' } };
const malformed = raw('BAD', 'a/b');
const oldCleanup = { id: 'delete-target:/fleet/chats/contacts/OLD', value: { url: '/fleet/chats/contacts/OLD' }, operation: 'delete-target' };
// Present-but-falsy fields, other envelopes and other identities are not proof of a never-sent record.
const ambiguous = [
  ...[null, false, 0, ''].map((payload, i) => ({ ...raw('PAYLOAD' + i, 'GONE'), payload })),
  ...[null, false, ''].map((operation, i) => ({ ...raw('OPERATION' + i, 'GONE'), operation })),
  { ...raw('VERSION', 'GONE'), targetVersion: null },
  { ...raw('ENVELOPE', 'GONE'), attempted: true },
  { ...raw('IDENTITY', 'GONE'), id: 'OTHER:IDENTITY:message_received' },
  { ...raw('VALUE', 'GONE'), value: { ...raw('VALUE', 'GONE').value, extra: true } },
];
const retained = [frozen, malformed, oldCleanup, ...ambiguous].map(entry => JSON.stringify(entry));
writeFileSync(file, JSON.stringify({ entries: [raw('PENDING'), frozen, malformed, oldCleanup, ...ambiguous, raw('RETIRED', 'GONE')], cursor: 7 }));
let producer = new MessengerNotificationProducer(dir, config, 'USER', client, () => {});
try {
  producer.retireContact('GONE');
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved().entries.map(entry => entry.id).filter(id => id.includes('RETIRED')), [], 'contact retirement still covers never-sent legacy events');
  assert.deepEqual(saved().entries.slice(4, 4 + ambiguous.length).map(entry => JSON.stringify(entry)), ambiguous.map(entry => JSON.stringify(entry)), 'retirement keeps ambiguous records');
  await producer.outbox.drain();
  const pending = saved().entries.find(entry => entry.id === 'USER:PENDING:message_received');
  assert.deepEqual(pending.payload, { eventId: 'USER:PENDING:message_received', title: 'Alice', body: 'Hello PENDING',
    target: { kind: 'contact', contactId: 'PEER' }, anchor: { kind: 'messenger-message', wireId: 'PENDING' } }, 'typed projection is frozen before the first attempt');
  assert.deepEqual(pending.value, raw('PENDING').value);
  await producer.close(); producer = new MessengerNotificationProducer(dir, config, 'USER', client, () => {});
  fail = false; await producer.outbox.drain();
  assert.deepEqual(accepted, [pending.payload], 'the frozen typed payload replays with the original event ID');
  assert.deepEqual(cleanups, [{ target: { kind: 'contact', contactId: 'GONE' } }]);
  const after = saved();
  assert.equal(after.cursor, 7);
  assert.deepEqual(after.entries.map(entry => JSON.stringify(entry)), retained, 'sent-or-unknown legacy entries are kept byte-for-byte and never sent');
  console.log('Never-sent legacy outbox events deliver as typed notifications; frozen and malformed entries stay retained');
} finally { await producer.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
