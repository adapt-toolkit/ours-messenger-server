import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'messenger-release-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OURS_|GITHUB_|GIT_|NPM_CONFIG_)/i.test(k)));
  mkdirSync(join(dir, 'home')); env.HOME = join(dir, 'home'); env.GIT_CONFIG_NOSYSTEM = '1';
  function run(command, args) { return spawnSync(command, args, { cwd: dir, env, encoding: 'utf8', timeout: 30_000 }); }
  try { fn({ dir, env, run }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const [channel, branch, version, tag, ok] of [
  ['stable','main','1.2.3','latest',true],
  ['nightly','prerelease','1.2.4-nightly.2','nightly',true],
  ['stable','prerelease','1.2.3','latest',false],
  ['stable','main','1.2.4-nightly.2','latest',false],
  ['nightly','main','1.2.4-nightly.2','nightly',false],
  ['nightly','prerelease','1.2.4-nightly.2','latest',false],
  ['nightly','prerelease','1.2.3','nightly',false],
  ['stable','main','garbage','latest',false],
  ['nightly','prerelease','1.2.4-nightly.bad','nightly',false],
]) test(`${channel}/${branch}/${version}/${tag}: ${ok ? 'accept' : 'refuse'}`, () => fixture(({dir,env,run}) => {
  writeFileSync(join(dir,'package.json'), JSON.stringify({ name:'@ours.network/messenger-server',version }));
  env.GITHUB_REF = `refs/heads/${branch}`;
  const r = run('bash',[join(root,'.github/workflows/scripts/publish-guard.sh'),channel,'package.json',tag]);
  assert.equal(r.status,ok?0:1,r.stdout+r.stderr);
}));
test('nightly bump selects next available index without changing dependencies or committing', () => fixture(({dir,env,run}) => {
  mkdirSync(join(dir,'bin'));
  writeFileSync(join(dir,'bin/npm'), '#!/bin/sh\ncase "$3" in version) echo 1.0.30;; versions) echo \'["1.0.31-nightly.2","1.0.31-nightly.4"]\';; *) exit 90;; esac\n', {mode:0o755});
  env.PATH = `${join(dir,'bin')}:${env.PATH}`;
  env.OURS_BUMP_DRY_RUN = '1';
  cpSync(join(root,'package.json'),join(dir,'package.json'));
  const before = JSON.parse(readFileSync(join(dir,'package.json')));
  before.version = '1.0.30';
  writeFileSync(join(dir,'package.json'), JSON.stringify(before, null, 2) + '\n');
  assert.equal(run('git',['init','-q']).status,0);
  assert.equal(run('git',['add','package.json']).status,0);
  assert.equal(run('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']).status,0);
  const head=run('git',['rev-parse','HEAD']).stdout;
  const r=run('bash',[join(root,'.github/workflows/scripts/bump-nightly.sh')]);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const after=JSON.parse(readFileSync(join(dir,'package.json')));
  assert.equal(after.version,'1.0.31-nightly.5');
  assert.deepEqual(after.dependencies,before.dependencies);
  assert.equal(run('git',['rev-parse','HEAD']).stdout,head);
}));
