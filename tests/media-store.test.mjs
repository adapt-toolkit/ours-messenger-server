import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore } from '../src/media.ts';

const root = mkdtempSync(join(tmpdir(), 'messenger-media-'));
try {
  const store = MediaStore.open(root);
  assert.equal(lstatSync(join(root, 'media')).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(root, 'media', 'index.json')).mode & 0o777, 0o600);

  const first = store.recordOutgoing({
    wire_id: 'OUT-1', contact_id: 'PEER', sender_id: 'ME', sender_name: 'Me',
    filename: 'Report.md', mime: 'text/markdown', reply_to: { wire_id: 'MSG-1' },
  }, Buffer.from('# first'));
  const second = store.recordOutgoing({
    wire_id: 'OUT-2', contact_id: 'PEER', sender_id: 'ME', sender_name: 'Me',
    filename: 'report.md', mime: 'text/markdown', reply_to: null,
  }, Buffer.from('# second'));
  assert.equal(first.version, 1);
  assert.equal(second.version, 2, 'case-normalized logical filenames form an ordered version history');
  assert.deepEqual(store.replyFor('OUT-1'), { wire_id: 'MSG-1' });
  assert.equal(store.read('OUT-1').bytes.toString(), '# first');
  assert.throws(() => store.recordOutgoing({
    wire_id: 'OUT-1', contact_id: 'PEER', sender_id: 'ME', sender_name: 'Me',
    filename: 'Report.md', mime: 'text/markdown', reply_to: null,
  }, Buffer.from('different bytes')), /different bytes/, 'a wire id can never overwrite prior bytes');

  store.reconcileIncoming([{
    wire_id: 'IN-1', from: { id: 'PEER', name: 'Peer' }, filename: 'voice-message-now.ogg',
    mime: 'audio/ogg;codecs=opus;x-ours-kind=voice-message', size: 4, date: '2026-08-15T00:00:00Z',
    kind: 'voice_message', reply_to: { wire_id: 'MSG-2', sentence: 1 },
  }]);
  const incoming = store.get('IN-1');
  assert.equal(incoming.kind, 'voice_message');
  assert.equal(incoming.available, false);
  store.storeIncoming('IN-1', Buffer.from('opus'), { transcription: { status: 'succeeded', text: 'hello' } });
  assert.equal(store.get('IN-1').available, true);
  assert.equal(store.get('IN-1').sha256.length, 64);
  assert.equal(store.get('IN-1').transcription.text, 'hello');

  const reopened = MediaStore.open(root);
  assert.equal(reopened.list('PEER').length, 3, 'media/version metadata survives restart');
  assert.equal(reopened.read('IN-1').bytes.toString(), 'opus', 'immutable bytes survive restart with hash verification');
  for (const name of readdirSync(join(root, 'media', 'blobs'))) {
    assert.equal(lstatSync(join(root, 'media', 'blobs', name)).mode & 0o777, 0o600);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('media-store OK — private immutable bytes, provenance, reply correlations, and version history');
