import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dotGit = join(root, '.git');
const gitDir = statSync(dotGit).isDirectory()
  ? dotGit
  : resolve(root, readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, ''));
const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
const commonDir = existsSync(join(gitDir, 'commondir'))
  ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
  : gitDir;
let sha = head;
if (head.startsWith('ref: ')) {
  const ref = head.slice(5);
  const loose = join(commonDir, ref);
  if (existsSync(loose)) sha = readFileSync(loose, 'utf8').trim();
  else {
    const packed = readFileSync(join(commonDir, 'packed-refs'), 'utf8')
      .split('\n').find((line) => line.endsWith(` ${ref}`));
    sha = packed?.split(' ', 1)[0] ?? '';
  }
}
assert.match(sha, /^[0-9a-f]{40}$/);

const jsFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.js')) jsFiles.push(path);
  }
};
walk(join(root, 'dist'));
const artifact = jsFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
assert.ok(artifact.includes(sha), 'artifact embeds the full source commit');
assert.doesNotMatch(artifact, /rev-parse|git status|\.git\/HEAD/, 'artifact never consults git at runtime');
const builtWorker = readFileSync(join(root, 'dist', 'web', 'sw.js'), 'utf8');
assert.match(builtWorker, new RegExp(`const SW_BUILD = '${sha}'`), 'service-worker bytes carry the release SHA');
assert.doesNotMatch(builtWorker, /__MESSENGER_BUILD_SHA__/);
const version = JSON.parse(readFileSync(join(root, 'dist', 'web', 'version.json'), 'utf8'));
assert.equal(version.sha, sha, 'independent update manifest carries the same release SHA');

// The copied artifact has no source tree or .git directory and remains
// self-describing; bundle-smoke separately executes the exact emitted CLI.
const isolated = mkdtempSync(join(tmpdir(), 'messenger-artifact-'));
try {
  cpSync(join(root, 'dist'), join(isolated, 'dist'), { recursive: true });
  const copied = [];
  const copyWalk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) copyWalk(path);
      else if (entry.name.endsWith('.js')) copied.push(readFileSync(path, 'utf8'));
    }
  };
  copyWalk(join(isolated, 'dist'));
  assert.ok(copied.join('\n').includes(sha));
} finally {
  rmSync(isolated, { recursive: true, force: true });
}

const buildSource = readFileSync(join(root, 'build.mjs'), 'utf8');
assert.match(buildSource, /OURS_MESSENGER_RELEASE_BUILD/);
assert.match(buildSource, /release build refused: source tree is dirty/);
console.log(`build-metadata OK — artifact embeds ${sha} and runs without source/git metadata`);
