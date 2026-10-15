import assert from 'node:assert/strict';
import { buildTimestamp } from '../scripts/build-epoch.mjs';
assert.equal(buildTimestamp('0'), '1970-01-01T00:00:00.000Z');
assert.equal(buildTimestamp('1789572600'), '2026-09-16T15:30:00.000Z');
assert.equal(buildTimestamp('8640000000000'), '+275760-09-13T00:00:00.000Z');
for (const value of ['', '-1', '1.5', '1e3', 'Infinity', ' 1', '8640000000001', '999999999999999999999']) {
  assert.throws(() => buildTimestamp(value), /SOURCE_DATE_EPOCH/);
}
const before = Date.now();
const timestamp = Date.parse(buildTimestamp(undefined));
assert(timestamp >= before && timestamp <= Date.now());
console.log('build-epoch: boundaries, invalid inputs and ordinary wallclock fallback passed');
