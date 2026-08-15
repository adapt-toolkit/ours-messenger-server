import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../web/public/manifest.webmanifest', import.meta.url), 'utf8'));
assert.equal(manifest.start_url, '/chats');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));

const sw = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');
assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/, 'service worker bypasses every API/SSE request');
assert.doesNotMatch(sw, /caches\.put\([^\n]*api/i, 'service worker never writes API responses to Cache Storage');
assert.match(sw, /addEventListener\('push'/);
assert.match(sw, /showNotification/);
assert.match(sw, /notificationclick/);
assert.match(sw, /openWindow\(url\)/);

console.log('pwa-contract OK — install manifest, offline shell boundary, push display, and dialog click-through');
