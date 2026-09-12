import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPanel, validateCommandValue } from '../src/ui/CommandPanel.js';
import type { CommandDefinition, JsonValue } from '../src/types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cowork-command-schemas.json', import.meta.url), 'utf8'));
const commands = fixture.commands as CommandDefinition[];
const grant = commands.find(c => c.name === 'room.command.grant')!.input_schema;
const thread = commands.find(c => c.name === 'start_thread')!.input_schema;
const participant = '01jd7q4h9m2v8xk3znbc5regty';
const validThread = { topic: 'Review changes', participant_ids: [participant], idempotency_key: 'review:1' };
function panel(schema: CommandDefinition['input_schema']) {
  return renderToStaticMarkup(<CommandPanel catalog={{recipient_cid:'PEER',fingerprint:'A'.repeat(43),commands:[{name:'generic',input_schema:schema}]}}
    recipientName="Peer" busy={false} onRefresh={()=>{}} onClose={()=>{}} onSend={async()=>{throw Error('must not send');}} />);
}
for (const command of commands) test(`actual registered ${command.name} schema renders`, () => {
  assert.doesNotMatch(panel(command.input_schema), /Cannot render this command safely/);
});
test('grant accepts each alternative and rejects invalid values and siblings', () => {
  for (const command of ['list-members', 'consumer.example', '*', 'room.*', 'consumer.deep-name.*']) {
    assert.equal(validateCommandValue(grant, {caller_cid:'A'.repeat(64),command}), null, command);
  }
  for (const command of ['unknown', 'room.*.bad', 'consumer.*.bad', 'Consumer.x', '', 5, null]) {
    assert.match(validateCommandValue(grant, {caller_cid:'A'.repeat(64),command})!, /alternative/);
  }
  assert.match(validateCommandValue(grant, {caller_cid:'bad',command:'*'})!, /format/);
  assert.match(validateCommandValue(grant, {caller_cid:'A'.repeat(64),command:'*',extra:true})!, /not declared/);
});
test('actual thread validates Unicode, uniqueness and identifier boundaries', () => {
  for (const topic of ['Review changes', '  review  ', '😀'.repeat(120), '\u00a0review\u00a0', 'a\u2028b']) {
    assert.equal(validateCommandValue(thread, {...validThread,topic}), null, JSON.stringify(topic));
  }
  for (const topic of ['', ' ', '\u00a0', '\ufeff', 'a\n', 'a\u200b', '\u0000x', '😀'.repeat(121)]) {
    assert.notEqual(validateCommandValue(thread, {...validThread,topic}), null, JSON.stringify(topic));
  }
  for (const participant_ids of [[], [participant,participant], ['bad'], ['8'+'0'.repeat(25)]]) {
    assert.notEqual(validateCommandValue(thread, {...validThread,participant_ids}), null);
  }
  assert.notEqual(validateCommandValue(thread, {...validThread,idempotency_key:'x'.repeat(129)}), null);
});
test('anyOf OR allows overlap, keeps sibling rules, and validates branches before input', () => {
  const schema: CommandDefinition['input_schema'] = {type:'integer', minimum:2, anyOf:[{type:'number',maximum:5},{enum:[3,8]}]};
  for (const value of [2,3,5,8]) assert.equal(validateCommandValue(schema,value),null);
  for (const value of [1,6,2.5,'3']) assert.notEqual(validateCommandValue(schema,value),null);
  for (const anyOf of [[], null, [true], [{type:'string'},{type:'object',oneOf:[]}], Array.from({length:65},()=>({type:'string'}))]) {
    const bad = {anyOf} as CommandDefinition['input_schema'];
    assert.match(panel(bad), /Cannot render this command safely/);
    assert.match(validateCommandValue(bad, 'x')!, /cannot be validated safely/);
  }
});
test('uniqueItems uses JSON equality independent of property order', () => {
  const schema = {type:'array',uniqueItems:true};
  assert.notEqual(validateCommandValue(schema,[{a:1,b:[2]},{b:[2],a:1}]),null);
  assert.equal(validateCommandValue(schema,[{a:1},{a:'1'},false,0,null]),null);
  assert.equal(validateCommandValue({type:'array',uniqueItems:false},[1,1]),null);
  assert.match(panel({type:'array',uniqueItems:'yes'}), /uniqueItems must be boolean/);
});
test('mixed unions render a JSON editor while homogeneous string unions stay text inputs', () => {
  assert.match(panel({anyOf:[{type:'string'},{type:'integer'}]}), /<textarea/);
  const html=panel({anyOf:[{type:'string',enum:['a']},{type:'string',pattern:'^b+$'}]});
  assert.match(html, /type="text"/);
  assert.doesNotMatch(html, /<textarea/);
});
test('supported pattern subset agrees with Unicode ECMAScript matching', () => {
  const patterns = ['^a+$','^(a|ab)*b$','^(a?){2,4}$','^(?:)*$','^(?:a?)*$', '^(?!.*bad)[\\s\\S]*\\S[\\s\\S]*$',
    '^(?=a)a.*$', '^\\p{L}+$', '^a{1,2}a{1,2}$', '^a.b$', '^a\\b$', '^[\\s\\S]*$', '^\\S+$', '^😀{1,3}$', '^a$'];
  const values = ['', 'a','aa','aaa','aaaa','ab','aab','abab','bad','abc','😀','😀😀','é','a\n','a\r\n','\n',' ','\u00a0','\ufeff','\u2028','\ud800'];
  for (const pattern of patterns) for (const value of values) {
    const result = validateCommandValue({type:'string',pattern}, value);
    assert.equal(result===null, new RegExp(pattern,'u').test(value), `${pattern} on ${JSON.stringify(value)}: ${result}`);
    assert.doesNotMatch(result??'', /cannot be validated safely/);
  }
});

test('typeless anyOf siblings and type arrays are honestly unsupported', () => {
  const schemas: CommandDefinition['input_schema'][] = [
    {anyOf:[{type:'object'}],required:['x']},
    {anyOf:[{type:'object'}],properties:{x:{type:'integer'}}},
    {anyOf:[{type:'array'}],items:{type:'integer'}},
    {type:['string'],anyOf:[{type:'integer'}]},
  ];
  for (const schema of schemas) {
    assert.match(panel(schema),/Cannot render this command safely/);
    assert.match(validateCommandValue(schema, {})!,/cannot be validated safely/);
  }
});

test('pattern work budget is shared across anyOf alternatives', () => {
  const branch = {type:'string',pattern:'^a{256}b$'};
  const value = 'a'.repeat(256);
  assert.match(validateCommandValue(branch,value)!,/does not match/);
  assert.match(validateCommandValue({anyOf:Array.from({length:60},()=>branch)},value)!,/work limit exceeded/);
});
test('aggregate object pattern budget failure is visible even when each field is valid', () => {
  const child = {type:'string',default:'a'.repeat(100),pattern:'^a{0,100}a{0,100}$'};
  assert.equal(validateCommandValue(child, child.default),null);
  const schema = {type:'object',properties:{a:child,b:child,c:child,d:child}};
  const roots: CommandDefinition['input_schema'][] = [schema, {anyOf:[schema]}, {type:'array',items:child,default:Array(4).fill(child.default)}];
  for (const root of roots) {
    assert.match(panel(root), /Arguments cannot be validated safely: pattern validation work limit exceeded/);
  }
});
