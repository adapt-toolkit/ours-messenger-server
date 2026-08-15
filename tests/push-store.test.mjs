import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore } from '../src/push.ts';

const root = mkdtempSync(join(tmpdir(), 'messenger-push-store-'));
try {
  const created = PushStore.open(root, {});
  assert.ok(created.publicKey.length > 20, 'an absent push state is initialized');
  const validBytes = readFileSync(join(root, 'push.json'));

  const corrupt = Buffer.from('{"vapid":');
  writeFileSync(join(root, 'push.json'), corrupt);
  assert.throws(
    () => PushStore.open(root, {}),
    /push state.*(invalid|corrupt).*unchanged/i,
    'malformed existing state fails closed with recovery guidance',
  );
  assert.deepEqual(readFileSync(join(root, 'push.json')), corrupt, 'malformed state is never overwritten');
  assert.deepEqual(readdirSync(root).sort(), ['push.json'], 'failure leaves no replacement/temp file behind');

  const invalidShape = Buffer.from(JSON.stringify({ vapid: { publicKey: 'kept-public', privateKey: 'kept-private' }, subscriptions: [{}] }));
  writeFileSync(join(root, 'push.json'), invalidShape);
  assert.throws(
    () => PushStore.open(root, {
      OURS_MESSENGER_VAPID_PUBLIC_KEY: 'environment-public',
      OURS_MESSENGER_VAPID_PRIVATE_KEY: 'environment-private',
    }),
    /push state.*schema.*unchanged/i,
    'schema-invalid state is not silently replaced even when environment keys exist',
  );
  assert.deepEqual(readFileSync(join(root, 'push.json')), invalidShape, 'invalid subscriptions and stored keys remain recoverable');

  chmodSync(join(root, 'push.json'), 0o000);
  assert.throws(
    () => PushStore.open(root, {}),
    /push state.*unreadable.*unchanged/i,
    'an unreadable existing state fails closed instead of being treated as absent',
  );
  assert.equal(lstatSync(join(root, 'push.json')).mode & 0o777, 0o000, 'failure does not chmod or replace the unreadable state');
  chmodSync(join(root, 'push.json'), 0o600);
  assert.deepEqual(readFileSync(join(root, 'push.json')), invalidShape, 'unreadable-state bytes survive recovery unchanged');

  renameSync(join(root, 'push.json'), join(root, 'push.json.invalid-preserved'));
  const recovered = PushStore.open(root, {});
  assert.ok(recovered.publicKey.length > 20, 'operator recovery by moving the bad file permits clean initialization');
  assert.deepEqual(readFileSync(join(root, 'push.json.invalid-preserved')), invalidShape, 'the preserved bad state remains available for manual recovery');
  assert.notDeepEqual(readFileSync(join(root, 'push.json')), validBytes, 'recovery creates an explicit new state instead of pretending the old one loaded');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('push-store OK — absent initialization, corrupt/schema fail-closed preservation, and explicit recovery');
