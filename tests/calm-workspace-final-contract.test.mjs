import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(new URL('../web/src', import.meta.url).pathname);
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (['.css', '.ts', '.tsx', '.mjs'].includes(extname(path))) files.push(path);
  }
};
walk(root);

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const rawPattern = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)|\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|\b(?:black|white)\b(?!-)/gi;
const findings = new Map();
for (const path of files) {
  const matches = [...stripComments(readFileSync(path, 'utf8')).matchAll(rawPattern)].map((match) => match[0]);
  if (matches.length) findings.set(relative(root, path), matches);
}

assert.deepEqual([...findings.keys()].sort(), [
  'theme.css',
  'ui/QRDisplay.tsx',
  'ui/htmlPreviewCore.mjs',
  'ui/imageCompression.ts',
], 'raw values occur only in the token authority or exact functional exception files');
assert.deepEqual(findings.get('ui/QRDisplay.tsx'), ['#000000', '#ffffff'], 'QR encoder exception is exact');
assert.deepEqual(findings.get('ui/htmlPreviewCore.mjs'), ['#fff', '#0f172a'], 'isolated srcdoc paper/ink exception is exact');
assert.deepEqual(findings.get('ui/imageCompression.ts'), ['#fff'], 'JPEG output matte exception is exact');
assert.equal(findings.get('theme.css').filter((value) => /gradient/i.test(value)).length, 0,
  'token authority contains no decorative gradients');

const main = readFileSync(join(root, 'main.tsx'), 'utf8');
assert.doesNotMatch(main, /dark-v3\.css|onboarding\.css/, 'dead theme/onboarding sheets are not shipped');
for (const path of files.filter((path) => path !== join(root, 'theme.css'))) {
  assert.doesNotMatch(stripComments(readFileSync(path, 'utf8')), /\.theme-dark\b/,
    `${relative(root, path)} does not own dark-theme presentation`);
}
const allSource = files.map((path) => readFileSync(path, 'utf8')).join('\n');
assert.doesNotMatch(allSource, /\bonb-(?:warning|error)\b|\bTabIntro\b|\bagi-(?:backdrop|scene|medal)\b/,
  'deleted onboarding/intro ownership has no source or runtime-string reference');

console.log('calm-workspace final contract OK — exhaustive raw syntax scan, exact exceptions, no legacy theme/onboarding owner');
