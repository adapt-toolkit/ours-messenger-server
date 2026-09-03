import assert from 'node:assert/strict';
import './command-invocations.test.mjs';
import './typed-delivery-config.test.mjs';
import {
  MAX_COMMANDS,
  parseTypedEnvelope,
  projectCatalog,
  requireBoundedJson,
} from '../src/typed-commands.ts';

const recipient = 'CID-RECIPIENT';
const command = {
  name: 'notes.create',
  description: '<img src=x onerror=alert(1)>',
  input_schema: {
    type: 'object',
    required: [''],
    properties: { '': { type: 'string', default: '' }, priority: { enum: [0, 1] } },
  },
};
const catalog = projectCatalog(recipient, [command]);
assert.equal(catalog.recipient_cid, recipient);
assert.match(catalog.fingerprint, /^[A-Za-z0-9_-]{43}$/);
assert.deepEqual(catalog.commands[0].input_schema.properties[''], { type: 'string', default: '' });
assert.equal(projectCatalog(recipient, [command]).fingerprint, catalog.fingerprint, 'fingerprint is deterministic');
const otherRecipientCatalog = projectCatalog('OTHER', [command]);
assert.notEqual(otherRecipientCatalog.recipient_cid, catalog.recipient_cid, 'recipient binding is explicit');
assert.notEqual(otherRecipientCatalog.fingerprint, catalog.fingerprint, 'catalog fingerprint is bound to the recipient CID');
assert.throws(() => projectCatalog(recipient, Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => ({
  name: `c${i}`, input_schema: { type: 'null' },
}))));

const safeJson = JSON.parse('{"":"","nested":[null,true,0,{"__proto__":"data"}]}');
requireBoundedJson(safeJson);
assert.equal(Object.getPrototypeOf(safeJson), Object.prototype);
assert.equal(safeJson.nested[3].__proto__, 'data');
assert.throws(() => requireBoundedJson({ value: Number.NaN }));
assert.throws(() => requireBoundedJson({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } }));

assert.deepEqual(
  parseTypedEnvelope('command', JSON.stringify({ command: 'notes.create', arguments: { '': '' } })),
  { kind: 'command', command: 'notes.create', arguments: { '': '' } },
);
assert.deepEqual(parseTypedEnvelope('command_result', '{"ok":true,"result":0}'), {
  kind: 'command_result', outcome: { ok: true, result: 0 },
});
assert.deepEqual(parseTypedEnvelope('command', '{bad'), { kind: 'unknown', wire_kind: 'command', malformed: true });
assert.deepEqual(parseTypedEnvelope('future_command_v2', '{}'), {
  kind: 'unknown', wire_kind: 'future_command_v2', malformed: false,
});
assert.equal(parseTypedEnvelope('text', 'ordinary'), null);

console.log('typed-commands-core OK — bounded catalog/JSON, deterministic recipient binding, safe envelope fallback');
