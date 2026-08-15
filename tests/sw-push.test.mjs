import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');
const utilities = source.split("self.addEventListener('install'")[0];
const exported = {};
// eslint-disable-next-line no-new-func
new Function('exports', 'MessageChannel', `${utilities}; Object.assign(exports, {
  shouldSuppressNotification, queryClientsVisible, safeNotificationUrl, selectClickTarget
});`)(exported, MessageChannel);

const { shouldSuppressNotification, queryClientsVisible, safeNotificationUrl, selectClickTarget } = exported;
assert.equal(shouldSuppressNotification([], null, 10_000, 30_000, false), false, 'closed app shows');
assert.equal(shouldSuppressNotification([{ visibilityState: 'visible' }], { state: 'visible', ts: 1_000 }, 2_000, 30_000, false), true,
  'fresh page-owned non-iOS visibility suppresses');
assert.equal(shouldSuppressNotification([{ visibilityState: 'visible' }], { state: 'hidden', ts: 1_000 }, 2_000, 30_000, false), false,
  'mobile WindowClient over-report cannot swallow a hidden app notification');
assert.equal(shouldSuppressNotification([{ visibilityState: 'visible' }], { state: 'visible', ts: 1_000 }, 40_001, 30_000, false), false,
  'stale visibility is uncertain and therefore shows');
assert.equal(shouldSuppressNotification([{ visibilityState: 'visible' }], { state: 'visible', ts: 1_000 }, 2_000, 30_000, true), false,
  'installed iOS always shows without an authorized presence design');

const client = (state, iosStandalone = false) => ({
  postMessage(_message, transfer) {
    transfer[0].postMessage({ type: 'ours-visibility-reply', state, iosStandalone });
  },
});
assert.equal(await queryClientsVisible([client('visible')], 100), true, 'live non-iOS visible page suppresses');
assert.equal(await queryClientsVisible([client('visible', true)], 100), false, 'live installed-iOS page does not suppress');
assert.equal(await queryClientsVisible([{ postMessage() {} }], 20), false, 'uncertain/frozen page shows after a bounded query');

assert.equal(safeNotificationUrl('/chats/CID?wire=1', 'https://messenger.example'), '/chats/CID?wire=1');
for (const hostile of ['//evil.example/chats/CID', 'https://evil.example/chats/CID', 'javascript:alert(1)']) {
  assert.equal(safeNotificationUrl(hostile, 'https://messenger.example'), '/chats', `${hostile} fails closed`);
}
assert.equal(selectClickTarget([
  { url: 'https://other.example/chats', focused: true },
  { url: 'https://messenger.example/chats', focused: false },
], 'https://messenger.example')?.url, 'https://messenger.example/chats', 'click targets only a same-origin client');

console.log('sw-push OK — mobile/iOS foreground policy, bounded live query, safe URLs, and click targeting');
