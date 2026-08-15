import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessUpdate } from '../web/src/updateCheckCore.mjs';

test('same sha is current', () => {
  assert.equal(assessUpdate('abc', { sha: 'abc' }, {
    remoteSha: null, firstMismatchAt: null, controllerChanged: false,
  }, 1_000), 'current');
});

test('first mismatch records time and requests the newer worker', () => {
  const state = { remoteSha: null, firstMismatchAt: null, controllerChanged: false };
  assert.equal(assessUpdate('abc', { sha: 'def' }, state, 1_000), 'newer-available');
  assert.equal(state.remoteSha, 'def');
  assert.equal(state.firstMismatchAt, 1_000);
});

test('persistent mismatch without controllerchange is stuck', () => {
  const state = { remoteSha: 'def', firstMismatchAt: 1_000, controllerChanged: false };
  assert.equal(assessUpdate('abc', { sha: 'def' }, state, 62_000, 60_000), 'stuck');
});

test('controllerchange means the clean reload is already underway', () => {
  const state = { remoteSha: 'def', firstMismatchAt: 1_000, controllerChanged: true };
  assert.equal(assessUpdate('abc', { sha: 'def' }, state, 122_000, 60_000), 'newer-available');
});

test('an unavailable manifest fails quietly', () => {
  assert.equal(assessUpdate('abc', null, {
    remoteSha: null, firstMismatchAt: null, controllerChanged: false,
  }, 0), 'current');
});
