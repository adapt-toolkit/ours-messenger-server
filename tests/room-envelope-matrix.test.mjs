import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roomLineForContact, roomMessagePreview } from '../shared/roomMessageCore.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cowork-room-envelopes.json', import.meta.url), 'utf8'));
const lines = fixture.cases.map(({ kind, body }) => {
  const line = roomLineForContact(fixture.announced_contact, JSON.stringify(body));
  assert.ok(line, `${kind} from the authenticated standard room is recognized`);
  assert.equal(line.kind, kind);
  assert.ok(!roomMessagePreview(line).includes('{'), `${kind} preview is never raw JSON`);
  assert.ok(!JSON.stringify(line).includes('CID-MUST-NOT-RENDER'), `${kind} drops author identity bytes`);
  return line;
});

assert.deepEqual(lines.map(({ kind }) => kind), fixture.cases.map(({ kind }) => kind));
const [chat, briefing, role, membership, file, removed, future] = lines;
assert.deepEqual(
  { variant: chat.variant, author: chat.author, role: chat.role, roomName: chat.roomName, at: chat.authoredAt },
  { variant: 'chat', author: 'Секретарь', role: 'Reviewer', roomName: 'Комната релиза', at: '2026-08-25T10:00:00.000Z' },
);
assert.deepEqual(
  { presentation: briefing.presentation, roomName: briefing.roomName, text: briefing.text, author: briefing.authoredBy },
  { presentation: 'briefing', roomName: 'Постоянные инвайты должны сохраняться', text: 'Проверьте, что постоянные инвайты сохраняются после перезапуска комнаты.', author: 'Координатор' },
);
assert.deepEqual(role.details, ['Role: Reviewer']);
assert.deepEqual(membership.details, ['Status: Remove', 'Member: Рецензент', 'Role: Reviewer', 'Epoch: 7']);
assert.equal(file.text, 'отчёт.pdf');
assert.deepEqual(file.details, ['Type: application/pdf', 'Size: 1.5 KiB', 'SHA-256: aaaaaaaaaaaa…aaaaaa']);
assert.deepEqual(removed.details, ['Status: Removed']);
assert.equal(future.text, 'Future status from the room.');
assert.ok(!JSON.stringify(future).includes('future-secret-shape'), 'future fallback does not stringify unknown metadata');

const mismatch = JSON.stringify({ ...fixture.cases[0].body, room_id: '01hzyk8m0000000000000000zz' });
const rejected = roomLineForContact(fixture.announced_contact, mismatch);
assert.equal(rejected?.text, 'This room envelope could not be displayed safely.',
  'a provenance mismatch becomes a bounded notice instead of leaking raw JSON');
assert.deepEqual(rejected?.details, ['Status: Room provenance mismatch']);
assert.equal(roomLineForContact('Alice', JSON.stringify(fixture.cases[0].body)), null,
  'ordinary 1:1 contacts never reinterpret JSON as a room envelope');
assert.equal(roomLineForContact('ours-cowork-room:legacy', JSON.stringify(fixture.cases[0].body)), null,
  'legacy/custom room contacts still require their application signature');

const longFuture = JSON.stringify({
  ...fixture.cases.at(-1).body,
  kind: `room_${'future_'.repeat(30)}`,
  text: 'Ж'.repeat(1_500),
});
const bounded = roomLineForContact(fixture.announced_contact, longFuture);
assert.ok(bounded, 'future envelope remains renderable');
assert.equal(Array.from(bounded.text).length, 1_001, 'future content is bounded to 1000 Unicode characters plus ellipsis');
assert.ok(bounded.text.endsWith('…'));
assert.ok(bounded.label.length <= 80, 'future kind label is bounded');

console.log('room-envelope-matrix OK — all Cowork wire kinds are structured, bounded, and provenance-scoped');
