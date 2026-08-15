import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindIdentity } from '../src/daemon.ts';
import { initializeMessengerState, migrateMessengerState } from '../src/lifecycle.ts';

const cfg = (stateDir, identity = 'Human') => ({
  host: '127.0.0.1', port: 0, identity, force: false, stateDir, keepHistory: true,
  runtime: { brokerUrl: 'wss://invalid.local/none' },
});

const noSuch = () => Object.assign(new Error('missing'), { code: 'NO_SUCH_IDENTITY' });

// Empty serve is a typed, non-mutating refusal. In particular it never falls
// back to the flat createIdentity API and never changes conversation policy.
{
  let creates = 0;
  let policyWrites = 0;
  const client = {
    chooseIdentity: async () => { throw noSuch(); },
    listIdentities: async () => [],
    createIdentity: async () => { creates++; throw new Error('must not run'); },
    setConversationPolicy: async () => { policyWrites++; throw new Error('must not run'); },
  };
  const error = await bindIdentity({ client }, cfg('/tmp/not-used')).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(error?.code, 'INITIALIZATION_REQUIRED');
  assert.equal(creates, 0);
  assert.equal(policyWrites, 0);
}

// A non-empty store missing the configured name remains the SDK's hard error.
{
  let creates = 0;
  const missing = noSuch();
  const client = {
    chooseIdentity: async () => { throw missing; },
    listIdentities: async () => [{ name: 'SomeoneElse', cid: 'CID-OTHER', kind: 'root' }],
    createIdentity: async () => { creates++; },
  };
  await assert.rejects(() => bindIdentity({ client }, cfg('/tmp/not-used', 'Absent')), (error) => error === missing);
  assert.equal(creates, 0);
}

const root = mkdtempSync(join(tmpdir(), 'messenger-lifecycle-gate-'));
try {
  // Missing/empty init fields fail before starting a runtime or touching state.
  for (const [name, bio] of [['', 'bio'], ['   ', 'bio'], ['Human', ''], ['Human', '   ']]) {
    const stateDir = join(root, `invalid-${Math.random().toString(16).slice(2)}`);
    let starts = 0;
    await assert.rejects(
      () => initializeMessengerState(cfg(stateDir), { name, bio, confirmed: true }, { startRuntime: async () => { starts++; } }),
      /non-empty/i,
    );
    assert.equal(starts, 0);
    assert.equal(readdirSync(root).includes(stateDir.split('/').at(-1)), false);
  }

  // Explicit init uses the Human/root API, writes stable CID provenance with
  // owner-only permissions, and a second init refuses before runtime startup.
  const initState = join(root, 'init-state');
  let starts = 0;
  let createArgs;
  const fakeRuntime = {
    client: {
      listIdentities: async () => createArgs
        ? [{ name: 'Ada@server', cid: 'CID-STABLE', kind: 'root' }]
        : [],
      createRootIdentity: async (args) => {
        createArgs = args;
        return { info: { name: args.name, cid: 'CID-STABLE', bio: args.bio }, hierarchy: 'root' };
      },
    },
    close: async () => {},
  };
  const receipt = await initializeMessengerState(
    cfg(initState, 'Ada@server'),
    { name: 'Ada@server', bio: 'The human owner', confirmed: true },
    { startRuntime: async () => { starts++; return fakeRuntime; }, now: () => new Date('2026-08-14T00:00:00.000Z') },
  );
  assert.equal(starts, 1);
  assert.deepEqual(createArgs, {
    name: 'Ada@server', bio: 'The human owner', exposeLocal: true, localAutoAccept: true, skipIfRootExists: false,
  });
  assert.equal(receipt.identity.cid, 'CID-STABLE');
  assert.equal(receipt.identity.hierarchy, 'root');
  const receiptPath = join(initState, 'initialization.json');
  assert.equal(statSync(initState).mode & 0o077, 0);
  assert.equal(statSync(receiptPath).mode & 0o077, 0);
  assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).identity.cid, 'CID-STABLE');
  await assert.rejects(
    () => initializeMessengerState(
      cfg(initState, 'Ada@server'),
      { name: 'Ada@server', bio: 'The human owner', confirmed: true },
      { startRuntime: async () => { starts++; return fakeRuntime; } },
    ),
    /already initialized/i,
  );
  assert.equal(starts, 1, 'second init refuses before starting/mutating the runtime');

  // The normal restart bind must resolve to the CID pinned by initialization.
  const bound = await bindIdentity({ client: {
    chooseIdentity: async () => ({ cid: 'CID-STABLE' }),
    setConversationPolicy: async () => ({ keepHistory: true }),
    readvertiseOnUpgrade: async () => ({ ok: true }),
  } }, cfg(initState, 'Ada@server'));
  assert.equal(bound.cid, 'CID-STABLE');
  await assert.rejects(
    () => bindIdentity({ client: {
      chooseIdentity: async () => ({ cid: 'CID-DIFFERENT' }),
      setConversationPolicy: async () => ({ keepHistory: true }),
      readvertiseOnUpgrade: async () => ({ ok: true }),
    } }, cfg(initState, 'Ada@server')),
    /provenance mismatch/i,
  );

  // Migration is a byte-complete offline copy with explicit source and backup.
  // Representative history + receipt files make incompleteness observable.
  const source = join(root, 'source-runtime');
  const destination = join(root, 'destination');
  const backup = join(root, 'backup');
  mkdirSync(join(source, 'Ada@server', 'history'), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, 'Ada@server', 'identity.key'), 'KEY-CID-STABLE', { mode: 0o600 });
  writeFileSync(join(source, 'Ada@server', 'state_data.bin'), Buffer.from([0, 1, 2, 3]), { mode: 0o600 });
  writeFileSync(join(source, 'Ada@server', 'history', 'messages.json'), '[{"wire_id":"W1"}]', { mode: 0o600 });
  writeFileSync(join(source, 'Ada@server', 'history', 'receipts.json'), '{"W1":"read"}', { mode: 0o600 });

  const migration = migrateMessengerState({ source, destinationStateDir: destination, backupDir: backup, confirmed: true });
  assert.equal(migration.sourceManifest.digest, migration.destinationManifest.digest);
  assert.equal(migration.sourceManifest.files, 4);
  assert.deepEqual(
    readFileSync(join(destination, 'runtime', 'Ada@server', 'history', 'messages.json')),
    readFileSync(join(source, 'Ada@server', 'history', 'messages.json')),
  );
  assert.deepEqual(
    readFileSync(join(backup, 'source', 'Ada@server', 'history', 'receipts.json')),
    readFileSync(join(source, 'Ada@server', 'history', 'receipts.json')),
  );
  assert.equal(statSync(destination).mode & 0o077, 0);
  assert.equal(statSync(join(destination, 'migration.json')).mode & 0o077, 0);

  // An existing messenger root contributes both its nested SDK runtime and the
  // outer push state; neither may be silently dropped.
  const messengerSource = join(root, 'messenger-source');
  const messengerDestination = join(root, 'messenger-destination');
  const messengerBackup = join(root, 'messenger-backup');
  mkdirSync(join(messengerSource, 'runtime', 'Human'), { recursive: true });
  writeFileSync(join(messengerSource, 'runtime', 'Human', 'identity.key'), 'KEY-HUMAN');
  writeFileSync(join(messengerSource, 'runtime', 'Human', 'state_data.bin'), 'ACTOR-WITH-HISTORY-AND-RECEIPTS');
  writeFileSync(join(messengerSource, 'push.json'), '{"subscriptions":[{"endpoint":"opaque"}]}');
  const messengerMigration = migrateMessengerState({
    source: messengerSource,
    destinationStateDir: messengerDestination,
    backupDir: messengerBackup,
    confirmed: true,
  });
  assert.equal(messengerMigration.sourceKind, 'messenger-root');
  assert.equal(messengerMigration.sourceManifest.files, 3);
  assert.equal(messengerMigration.sourceManifest.digest, messengerMigration.destinationManifest.digest);
  assert.deepEqual(readFileSync(join(messengerDestination, 'push.json')), readFileSync(join(messengerSource, 'push.json')));
  assert.deepEqual(
    readFileSync(join(messengerDestination, 'runtime', 'Human', 'state_data.bin')),
    readFileSync(join(messengerSource, 'runtime', 'Human', 'state_data.bin')),
  );
  assert.deepEqual(readFileSync(join(messengerBackup, 'source', 'push.json')), readFileSync(join(messengerSource, 'push.json')));

  // Invalid/non-empty destination is checked before backup or destination mutation.
  const blockedDestination = join(root, 'blocked-destination');
  const blockedBackup = join(root, 'blocked-backup');
  mkdirSync(blockedDestination, { recursive: true });
  writeFileSync(join(blockedDestination, 'sentinel'), 'DO-NOT-CHANGE');
  const before = readFileSync(join(blockedDestination, 'sentinel'));
  await assert.rejects(
    async () => migrateMessengerState({
      source, destinationStateDir: blockedDestination, backupDir: blockedBackup, confirmed: true,
    }),
    /destination.*non-empty/i,
  );
  assert.deepEqual(readFileSync(join(blockedDestination, 'sentinel')), before);
  assert.equal(readdirSync(root).includes('blocked-backup'), false);

  // Unsupported source entries are invalid input and are rejected before a
  // backup or destination is created.
  const linkedSource = join(root, 'linked-source');
  const linkedDestination = join(root, 'linked-destination');
  const linkedBackup = join(root, 'linked-backup');
  mkdirSync(join(linkedSource, 'Human'), { recursive: true });
  writeFileSync(join(linkedSource, 'Human', 'identity.key'), 'KEY');
  writeFileSync(join(linkedSource, 'Human', 'state_data.bin'), 'STATE');
  symlinkSync(join(linkedSource, 'Human', 'identity.key'), join(linkedSource, 'unsafe-link'));
  assert.throws(
    () => migrateMessengerState({
      source: linkedSource, destinationStateDir: linkedDestination, backupDir: linkedBackup, confirmed: true,
    }),
    /symbolic link/i,
  );
  assert.equal(existsSync(linkedDestination), false);
  assert.equal(existsSync(linkedBackup), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('lifecycle-gate OK');
