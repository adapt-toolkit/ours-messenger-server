import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandInvocationStore, invocationFingerprint } from '../src/command-invocations.ts';

const stateDir = mkdtempSync(join(tmpdir(), 'messenger-command-invocations-'));
try {
  const payload = {
    recipient_cid: 'CID-A', command: 'notes.create', arguments: { '': '', count: 0 },
    catalog_fingerprint: 'CATALOG-A',
  };
  const payloadFingerprint = invocationFingerprint(payload);
  assert.equal(invocationFingerprint(payload), payloadFingerprint, 'payload fingerprint is deterministic');
  assert.notEqual(invocationFingerprint({ ...payload, recipient_cid: 'CID-B' }), payloadFingerprint);
  assert.notEqual(invocationFingerprint({ ...payload, arguments: { '': 'changed', count: 0 } }), payloadFingerprint);

  const invocation = {
    invocation_id: '73ee164e-1cf9-41e8-8409-f3775591beef', recipient_cid: payload.recipient_cid,
    payload_fingerprint: payloadFingerprint, command: payload.command,
    catalog_fingerprint: payload.catalog_fingerprint,
  };
  const first = CommandInvocationStore.open(stateDir, 'CID-MESSENGER').begin(invocation);
  assert.equal(first.fresh, true);
  assert.equal(first.record.status, 'indeterminate', 'reservation is durable before the network send begins');

  const afterCrash = CommandInvocationStore.open(stateDir, 'CID-MESSENGER');
  const replayAfterCrash = afterCrash.begin(invocation);
  assert.equal(replayAfterCrash.fresh, false);
  assert.equal(replayAfterCrash.record.status, 'indeterminate', 'restart never resends an unknown-outcome invocation');
  assert.throws(() => afterCrash.begin({ ...invocation, recipient_cid: 'CID-B' }), /different recipient or payload/);
  assert.throws(() => afterCrash.begin({ ...invocation, payload_fingerprint: 'DIFFERENT' }), /different recipient or payload/);

  const accepted = afterCrash.complete(invocation.invocation_id, { wire_id: 'WIRE-1', delivery: 'e2e' });
  assert.equal(accepted.status, 'accepted');
  const replayAccepted = CommandInvocationStore.open(stateDir, 'CID-MESSENGER').begin(invocation);
  assert.equal(replayAccepted.fresh, false);
  assert.equal(replayAccepted.record.wire_id, 'WIRE-1');
  assert.equal(replayAccepted.record.status, 'accepted');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log('command-invocations OK — durable reservation, restart replay, CID/payload conflict');
