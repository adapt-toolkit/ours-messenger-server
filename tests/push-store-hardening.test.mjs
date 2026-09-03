import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { PushStore } from '../src/push.ts';

const root = mkdtempSync(join(tmpdir(), 'messenger-push-hardening-'));
const vapid = webpush.generateVAPIDKeys();
const env = {
  OURS_MESSENGER_VAPID_PUBLIC_KEY: vapid.publicKey,
  OURS_MESSENGER_VAPID_PRIVATE_KEY: vapid.privateKey,
  OURS_MESSENGER_VAPID_SUBJECT: 'mailto:test@example.com',
};
const valid = {
  endpoint: 'https://push.example/device-capability',
  keys: {
    p256dh: Buffer.alloc(65, 9).toString('base64url'),
    auth: Buffer.alloc(16, 8).toString('base64url'),
  },
  label: 'Phone',
  preview: 'full',
};

try {
  const first = PushStore.open(root, 'CID-A', env);
  const ack = first.ensure(valid);
  assert.match(ack.bindingId, /^[0-9a-f-]{36}$/i, 'server assigns an opaque binding id');
  assert.equal(first.bindingCount, 1);
  assert.equal(lstatSync(join(root, 'push.json')).mode & 0o777, 0o600, 'push state remains owner-only');
  const disk = JSON.parse(readFileSync(join(root, 'push.json'), 'utf8'));
  assert.equal(disk.version, 3, 'atomic state has an explicit schema version');
  assert.ok(disk.identities['CID-A'], 'bindings are nested under the configured identity CID');

  const idempotent = first.ensure(valid);
  assert.equal(idempotent.bindingId, ack.bindingId, 'same endpoint ensure is idempotent');
  assert.equal(first.bindingCount, 1);
  assert.equal(first.ensure({ ...valid, preview: 'private' }).preview, 'private');
  assert.equal(first.ensure({ endpoint: valid.endpoint, keys: valid.keys }).preview, 'private',
    'health re-ensure without a preview preserves the device privacy choice');

  const other = PushStore.open(root, 'CID-B', env);
  assert.equal(other.bindingCount, 0, 'a different configured identity sees no prior bindings');
  assert.equal(other.delete(ack.bindingId), false, 'a different identity cannot delete another identity binding');

  for (const bad of [
    { ...valid, endpoint: 'http://push.example/device' },
    { ...valid, endpoint: 'https://user:pass@push.example/device' },
    { ...valid, keys: { ...valid.keys, p256dh: 'not-base64url!' } },
    { ...valid, keys: { ...valid.keys, auth: Buffer.alloc(15).toString('base64url') } },
    { ...valid, label: 'x'.repeat(161) },
  ]) assert.throws(() => first.ensure(bad), /subscription|endpoint|key|label/i);

  const rotated = webpush.generateVAPIDKeys();
  const afterRotation = PushStore.open(root, 'CID-A', {
    ...env,
    OURS_MESSENGER_VAPID_PUBLIC_KEY: rotated.publicKey,
    OURS_MESSENGER_VAPID_PRIVATE_KEY: rotated.privateKey,
  });
  assert.ok(afterRotation.publicConfig.configEpoch > first.publicConfig.configEpoch, 'VAPID rotation advances config epoch');
  assert.equal(afterRotation.bindingCount, 0, 'old-key bindings become repair-required rather than false-active');
  assert.equal(afterRotation.delete(ack.bindingId), true, 'the owning identity can delete an old binding by opaque id');

  for (let index = 0; index < 32; index++) {
    afterRotation.ensure({ ...valid, endpoint: `https://push.example/device-${index}` });
  }
  assert.throws(
    () => afterRotation.ensure({ ...valid, endpoint: 'https://push.example/device-over-limit' }),
    /limit/i,
    'the per-identity binding count is bounded',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const legacyRoot = mkdtempSync(join(tmpdir(), 'messenger-push-migration-'));
try {
  writeFileSync(join(legacyRoot, 'push.json'), JSON.stringify({
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: env.OURS_MESSENGER_VAPID_SUBJECT },
    subscriptions: [{ ...valid, createdAt: '2026-08-15T00:00:00.000Z' }],
  }), { mode: 0o600 });
  const migrated = PushStore.open(legacyRoot, 'CID-MIGRATED', env);
  assert.equal(migrated.bindingCount, 1, 'a valid version-1 subscription is preserved during migration');
  const disk = JSON.parse(readFileSync(join(legacyRoot, 'push.json'), 'utf8'));
  assert.equal(disk.version, 3, 'legacy push state migrates atomically to the current schema');
  assert.equal(Object.keys(disk.identities['CID-MIGRATED'].bindings).length, 1,
    'legacy subscription is assigned only to the startup-bound identity');
  assert.equal(lstatSync(join(legacyRoot, 'push.json')).mode & 0o777, 0o600,
    'migration preserves the owner-only file mode');
} finally {
  rmSync(legacyRoot, { recursive: true, force: true });
}

console.log('push-store-hardening OK — identity scope, validation, migration, opaque lifecycle, owner-only schema, and rotation');
