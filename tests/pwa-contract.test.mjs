import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../web/public/manifest.webmanifest', import.meta.url), 'utf8'));
assert.equal(manifest.start_url, '/chats');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));

const sw = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');
assert.match(sw, /const SW_BUILD = '__MESSENGER_BUILD_SHA__'/, 'service-worker bytes carry the immutable release stamp');
assert.match(sw, /self\.skipWaiting\(\)/, 'new workers activate without waiting for installed-PWA windows to close');
assert.match(sw, /self\.clients\.claim\(\)/, 'new workers immediately control existing installed-PWA windows');
assert.match(sw, /keys\.map\(\(key\) => caches\.delete\(key\)\)/, 'activation purges every legacy app-shell cache');
assert.doesNotMatch(sw, /addEventListener\('fetch'/, 'control-plane updater never caches HTML or hashed application assets');
assert.doesNotMatch(sw, /client\.navigate/, 'activation never navigates a client from inside its own lifecycle promise');
assert.match(sw, /addEventListener\('push'/);
assert.match(sw, /showNotification/);
assert.match(sw, /notificationclick/);
assert.match(sw, /openWindow\(url\)/);

console.log('pwa-contract OK — install manifest, control-plane update lifecycle, push display, and dialog click-through');
