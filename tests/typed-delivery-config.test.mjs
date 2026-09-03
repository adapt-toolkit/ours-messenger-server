import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\[main, prerelease\]/,
  'typed-command prerelease pull requests run the full gate');
assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/,
  'only main pushes enter the publish workflow');
assert.match(workflow, /version-bump:[\s\S]*if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  'version bumps remain main-only');

console.log('typed-delivery-config OK — prerelease PR gate, main-only publishing');
