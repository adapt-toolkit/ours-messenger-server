import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { safePatternError, matchesPattern, patternBudget, PatternBudgetError } from '../src/ui/command-pattern.js';

test('supported AST matches native /u for generated small inputs', () => {
  const patterns = ['^a|b$', '^(a|ab)*b$', '^(a?){0,4}$','^(a?){2,4}$','^(a?){2,}$','^(?:a?)*$',
    '^(?:a?)+$', '^(?:a|)*$', '^(a*)*$', '^(?!a*b)a*$', '^(?=a|b)(a|b)*$', '^(?!a(?=b))..$',
    '^a*?b?$', '^a\\b$', '^a\\B.$', '^[^a-c]*$', '^\\p{L}+$', '^\\P{Cc}+$', '^.$', '^\\u{1F600}$'];
  let values = [''];
  let level = [''];
  for (let length=1; length<=5; length++) {
    level = level.flatMap(prefix => ['a','b',' ','😀'].map(char=>prefix+char));
    values.push(...level);
  }
  values.push('\n','\r\n','\u2028','\u00a0','\ufeff','\ud800','é');
  for (const pattern of patterns) {
    assert.equal(safePatternError(pattern),null);
    const native = new RegExp(pattern,'u');
    for (const value of values) assert.equal(matchesPattern(pattern,value,patternBudget()),native.test(value),`${pattern}: ${JSON.stringify(value)}`);
  }
});
test('unsupported syntax, depth and compile sizes have precise errors', () => {
  for (const [pattern, error] of [
    ['^(a)\\1$',/Backreference/], ['^(?<=a)b$',/lookbehind/], ['^a{257}$',/repetition/],
    ['^'+ '('.repeat(25)+'a'+')'.repeat(25)+'$',/depth/], ['^[$',/syntax/], ['a',/anchored/], ['a'.repeat(257),/256 characters/],
  ] as const) assert.match(safePatternError(pattern)!,error);
});
test('budget is shared across evaluations and cannot silently become a mismatch', () => {
  const budget = patternBudget();
  assert.equal(matchesPattern('^a{256}$','a'.repeat(256),budget),true);
  assert.ok(budget.remaining < 100_000);
  budget.remaining=0;
  assert.throws(()=>matchesPattern('^a$','a',budget),PatternBudgetError);
});
test('hostile patterns and long repetitions terminate within a subprocess deadline', () => {
  const result = spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {validateCommandValue} from './web/src/ui/CommandPanel.tsx';
    const cases = [
      ['^'+'a?'.repeat(80)+'a'.repeat(80)+'b$', 'a'.repeat(160), 'Arguments does not match the required format'],
      ['^(a+)+$', 'a'.repeat(400)+'!'],
      ['^(a*)*$', 'a'.repeat(400)+'!'],
      ['^a*$', 'a'.repeat(65000)],
      ['^(?!(a+)+$)[\\\\s\\\\S]*$', 'a'.repeat(400)+'!'],
      ['^(?:a?){256}(?:a?){256}$', 'a'.repeat(600)],
    ];
    for (const [pattern,value,expected] of cases) {
      if (expected) { assert.equal(validateCommandValue({type:'string',pattern},value),expected); continue; }
      assert.match(validateCommandValue({type:'string',pattern},value),/cannot be validated safely: pattern validation work limit exceeded/);
    }
    console.log('bounded hostile patterns OK');
  `],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined, String(result.error));
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/bounded hostile patterns OK/);
});
