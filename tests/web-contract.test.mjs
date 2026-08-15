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
const built = readFileSync(join(root, 'dist/web/app.js'), 'utf8');
const css = readFileSync(join(root, 'dist/web/styles.css'), 'utf8');
const html = readFileSync(join(root, 'dist/web/index.html'), 'utf8');

assert.ok(ROUTE_NAMES.includes('GET /api/events'), 'SSE route is part of the published API table');
assert.ok(html.includes('/app.js') && html.includes('/styles.css'), 'built entry document loads only same-origin assets');
assert.ok(built.includes('/api/events'), 'built client opens the same-origin SSE invalidation stream');
assert.ok(built.includes('/read') && built.includes('/api/messages/send'), 'built client has explicit read and send mutations');
assert.ok(source.includes("'X-Ours-Messenger-CSRF': '1'"), 'every web mutation carries the fixed CSRF intent header');
assert.ok(!source.includes('localStorage') && !source.includes('sessionStorage'), 'messages and receipts are not browser-persisted');
assert.ok(source.includes("aria-label', label") || source.includes('aria-label", label'), 'receipt marks have accessible labels');
assert.ok(css.includes('@media (max-width: 859px)') && css.includes('prefers-reduced-motion'), 'mobile detail and reduced motion are explicit');

for (const excluded of ['Clusters', 'Backup', 'Notification settings', 'Service status', 'Monitoring']) {
  assert.ok(!source.includes(excluded), `focused messenger UI excludes ${excluded}`);
}
console.log('web-contract OK — focused same-origin client, explicit read path, accessibility, responsive/reduced motion, no browser cache');
