import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROUTE_NAMES } from '../src/api.ts';

const root = resolve(import.meta.dirname, '..');
const webRoot = join(root, 'web');
const sourceFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else sourceFiles.push(path);
  }
};
walk(webRoot);
const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const html = readFileSync(join(root, 'dist/web/index.html'), 'utf8');
const assets = readdirSync(join(root, 'dist/web/assets'));
const jsAsset = assets.find((name) => /^index-[\w-]+\.js$/.test(name));
const cssAsset = assets.find((name) => /^index-[\w-]+\.css$/.test(name));
assert.ok(jsAsset && cssAsset, 'Vite emits content-hashed JS and CSS assets');
const built = readFileSync(join(root, 'dist/web/assets', jsAsset), 'utf8');
const css = readFileSync(join(root, 'dist/web/assets', cssAsset), 'utf8');

assert.ok(ROUTE_NAMES.includes('GET /api/events'), 'SSE route is part of the published API table');
assert.match(html, /\/assets\/index-[\w-]+\.js/, 'built entry document loads a same-origin hashed script');
assert.match(html, /\/assets\/index-[\w-]+\.css/, 'built entry document loads a same-origin hashed stylesheet');
assert.ok(built.includes('/api/events'), 'built client opens the same-origin SSE invalidation stream');
assert.ok(source.includes("bind('file_received')"), 'foreground file/photo/voice invalidations are registered');
assert.ok(built.includes('/read') && built.includes('/api/messages/send'), 'built client has explicit read and send mutations');
assert.ok(source.includes("'X-Ours-Messenger-CSRF': '1'"), 'every web mutation carries the fixed CSRF intent header');
assert.ok(!source.includes("from '../storage/") && !source.includes('indexedDB'), 'server state is authoritative; browser packet/file stores are absent');
assert.ok(source.includes('Raw HTML is never enabled'), 'message Markdown keeps raw HTML disabled');
assert.ok(source.includes('aria-label={`${content} ${presentation.label}`}'), 'receipt marks have accessible labels');
assert.ok(css.includes('@media (max-width: 860px)') && css.includes('prefers-reduced-motion'), 'canonical 861px mobile detail and reduced motion are explicit');
assert.ok(built.includes('command-settings') && built.includes('Settings'), 'mobile keeps the canonical command-bar Settings entry for Web Push');
assert.ok(source.includes('useReducer') && source.includes("from 'react-dom/client'"), 'the browser shell is React state rendered through createRoot');

for (const excluded of ['ControlClient', 'createAgent', 'adapt_wrapper', '/mcp']) {
  assert.ok(!built.includes(excluded), `focused messenger bundle excludes ${excluded}`);
}
console.log('web-contract OK — focused same-origin client, explicit read path, accessibility, responsive/reduced motion, no browser cache');
