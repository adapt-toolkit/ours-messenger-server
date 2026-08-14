// STATIC ARCHITECTURE GATE FOR THE MESSENGER-OWNED SDK RUNTIME.
//
// Runtime tests prove that the server boots and stops. This scan proves the
// dependency boundary that runtime behavior alone cannot distinguish: the
// messenger embeds @ours.network/sdk/daemon directly, never ours-mcp, and has
// no compatibility branch that can attach to an operator-selected daemon.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { counter } from './harness.mjs';

const t = counter();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const files = sourceFiles(SRC);
assert.ok(files.length >= 5, `expected at least 5 source files under src/, found ${files.length}`);
t.ok(true, `scanning ${files.length} source files under src/`);

const code = files
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

assert.match(code, /import\(['"]@ours\.network\/sdk\/daemon['"]\)/,
  'production must dynamically import the SDK daemon after owned env isolation');
t.ok(true, 'production imports @ours.network/sdk/daemon dynamically');
assert.doesNotMatch(
  code,
  /import\s+(?!type\b)[^;]*\sfrom\s*['"]@ours\.network\/sdk['"]/,
  'a static value import could evaluate the SDK before owned runtime isolation',
);
t.ok(true, 'all static SDK imports are type-only');
assert.match(code, /\bstartDaemon\s*\(/, 'production must start the SDK daemon it owns');
t.ok(true, 'production calls startDaemon');

for (const forbidden of [
  ['@ours.network/mcp', 'ours-mcp runtime dependency'],
  ['OURS_MESSENGER_' + 'DAEMON_', 'external-daemon environment compatibility'],
  ['resolve' + 'DaemonConfig', 'external daemon selection'],
  ['assert' + 'DaemonStateDir', 'external daemon attach assertion'],
]) {
  assert.ok(!code.includes(forbidden[0]), `src/ still contains ${forbidden[1]} (${forbidden[0]})`);
}
t.ok(true, 'src/ has no MCP import or external-daemon selection compatibility');

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
assert.ok(!Object.keys(packageJson.dependencies ?? {}).some((name) => name.includes('/mcp')),
  'package dependencies must not include ours-mcp');
t.ok(true, 'package dependencies are MCP-free');

console.log(`\nowned-runtime OK (${t.count} checks)`);
process.exit(0);
