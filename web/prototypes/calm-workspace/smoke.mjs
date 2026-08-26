import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const [html, css, js] = await Promise.all([
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('styles.css', root), 'utf8'),
  readFile(new URL('prototype.js', root), 'utf8'),
]);

for (const fixture of ['Empty', 'Loading', 'Error', 'Pending verification', 'Delivery failed', 'Unavailable']) {
  assert.match(html, new RegExp(fixture), `missing ${fixture} fixture`);
}
for (const role of ['--color-canvas', '--color-action-primary', '--color-success-background', '--color-error-border']) {
  assert.match(css, new RegExp(role), `missing ${role}`);
}
assert.match(html, /class="room selected"[^>]*aria-current="page"/);
assert.match(html, /class="room unread"[^>]*aria-label="Research agent, 2 unread"/);
assert.match(js, /mobile-rooms/);
assert.match(js, /theme-dark/);
console.log('calm-workspace prototype smoke OK');
