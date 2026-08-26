import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('web/src/main.tsx');
const theme = read('web/src/theme.css');
const layout = read('web/src/layout-v4.css');
const redesign = read('web/src/redesign.css');
const qrDisplay = read('web/src/ui/QRDisplay.tsx');
const qrScanner = read('web/src/ui/QRScanner.tsx');
const appTsx = read('web/src/App.tsx');
const chatsTsx = read('web/src/ui/Chats.tsx');
const modalsTsx = read('web/src/ui/MessengerModals.tsx');
const toastTsx = read('web/src/ui/MessageToast.tsx');
const appCss = read('web/src/app.css');

const cssImports = [...main.matchAll(/import ['"]\.\/[^'"]+\.css['"]/g)].map((match) => match[0]);
assert.equal(cssImports.length, 5, 'dead imported stylesheets are removed from the shipped cascade');
assert.deepEqual(cssImports, [
  "import './theme.css'", "import './motion.css'", "import './app.css'",
  "import './redesign.css'", "import './layout-v4.css'",
], 'remaining stylesheet order stays explicit');
for (const path of ['web/src/onboarding.css', 'web/src/dark-v3.css']) {
  assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} is deleted, not disabled`);
}

for (const token of ['--color-canvas', '--color-surface', '--color-text-primary', '--color-action-primary', '--color-focus']) {
  assert.match(theme, new RegExp(`${token}:`), `${token} is defined by theme.css`);
}
assert.match(theme, /Private primitives:[\s\S]*--primitive-linen: #f4f1ea/);
assert.match(theme, /Compatibility aliases \(40\)/);
assert.doesNotMatch(theme, /radial-gradient|--glow-accent:\s*0\s+0/, 'token authority has no ambient gradient or luminous glow');

const owned = layout.slice(layout.indexOf('calm workspace vertical slice'), layout.indexOf(':is(.command-copy strong'));
for (const selector of ['.signal-app .contact-row', '.signal-app .ours-message', '.signal-app .composer']) {
  assert.match(owned, new RegExp(selector.replaceAll('.', '\\.')), `${selector} belongs to layout-v4`);
}
assert.doesNotMatch(owned, /#[0-9a-f]{3,8}|rgba?\(|radial-gradient|glow-accent/i,
  'migrated component declarations consume semantic roles without raw colors, ambient gradients, or glow aliases');
assert.doesNotMatch(owned, /\.theme-dark/, 'migrated component declarations are theme-independent');

for (const [name, source] of [['redesign.css', redesign]]) {
  assert.doesNotMatch(source, /legacy-(?:dark|light)-slice|legacy-[\w-]*token-map(?:-disabled)?/,
    `${name} contains no renamed or disabled legacy ownership blocks`);
}
const migratedSelector = /^\s*[^@\n][^{]*(?:\.app(?=[\s.#:{>,]|$)|\.(?:section|listcol(?:-head|-title|-scroll)?|detail(?:-head|-empty)?|contact-row|messages|msg-row|bubble-wrap|ours-message|composer(?:-wrap)?)(?=[\s.#:{>,]|$))[^\{]*\{/gm;
const remainingOverlap = [...redesign.matchAll(migratedSelector)];
assert.equal(remainingOverlap.length, 0,
  `redesign.css has no migrated slice selector ownership; remaining: ${remainingOverlap.map((match) => match[0].trim()).join(', ')}`);

for (const [name, source] of [['redesign.css', redesign]]) {
  assert.doesNotMatch(source, /\.(?:modal(?:-backdrop|-head|-body|-tabs)?|onb(?:-[\w-]+)?|preview-badge)(?=[\s.#:[{>,]|$)/,
    `${name} has no slice-2 dialog/onboarding/preview ownership`);
}
for (const utility of ['.status-warning', '.field-error']) assert.match(layout, new RegExp(utility.replace('.', '\\.') + '[^{]*\\{[^}]*var\\(--'),
  `${utility} is a neutral semantic hook in the component owner`);
assert.match(qrDisplay, /color:\s*\{\s*dark:\s*'#000000',\s*light:\s*'#ffffff'\s*\}/,
  'QR encoder keeps the exact machine-readable black/white exception');
assert.match(qrDisplay, /margin:\s*4,/, 'QR encoder keeps the required four-module quiet zone');
assert.equal((qrDisplay.match(/#[0-9a-f]{3,8}/gi) ?? []).length, 2,
  'QR encoder file contains only its two bound raw-color exceptions');
assert.doesNotMatch(qrScanner, /#[0-9a-f]{3,8}|rgba?\(/i,
  'scanner component contains no raw presentation colors');
assert.match(theme, /--color-media-void:\s*#000000;/,
  'camera black is bound to the documented media-viewport semantic role');
assert.match(layout, /\.qr-scanner-viewport[^}]*background:\s*var\(--color-media-void\)/s,
  'media-void role is consumed only by the scanner viewport owner');
const previewBadgeReferences = [appTsx, chatsTsx, modalsTsx, toastTsx].join('\n');
assert.doesNotMatch(previewBadgeReferences, /preview-badge/, 'dead preview badge has no production component reference');
for (const [name, source] of [['app.css', appCss], ['redesign.css', redesign]]) {
  assert.doesNotMatch(source, /\.(?:preview-badge|message-code-block|message-code-language)(?=[\s.#:[{>,]|$)/, `${name} has no dead badge or migrated code-block ownership`);
}
const rendererSlice = layout.slice(layout.indexOf('.modal.modal-wide.markdown-modal'), layout.indexOf('.modal.modal-wide.shared-media-modal'));
assert.doesNotMatch(rendererSlice, /#[0-9a-f]{3,8}|rgba?\(/i, 'application-owned renderer chrome uses semantic roles');

for (const [surface, source, selector] of [
  ['commandbar/account/banner', appTsx, /commandbar[\s\S]*command-me[\s\S]*app-banners/],
  ['ChatList pending actions', chatsTsx, /contact-row[\s\S]*pending-actions/],
  ['Settings', modalsTsx, /settings-modal/],
  ['message toast', toastTsx, /banner msg/],
]) assert.match(source, selector, `${surface} has a reachable production component mapping`);
assert.doesNotMatch(appTsx, /rail-me/, 'reachable account avatar has one command-me owner');
const deadFamily = /\.(?:operations-stage|cfg-[\w-]*|mon-[\w-]*|rail-(?:brand|btn|switches|foot|me)|command-modes)(?=[\s.#:[{>,]|$)/;
for (const [name, source] of [['app.css', appCss], ['redesign.css', redesign], ['layout-v4.css', layout]]) {
  assert.doesNotMatch(source, deadFamily, `${name} contains no proven-unreachable selector family`);
}
for (const [name, source] of [['App.tsx', appTsx], ['Chats.tsx', chatsTsx], ['MessengerModals.tsx', modalsTsx], ['MessageToast.tsx', toastTsx]]) {
  assert.doesNotMatch(source, /(?:operations-stage|cfg-|mon-|rail-(?:brand|btn|switches|foot|me)|command-modes)/, `${name} does not construct a deleted family at runtime`);
}

console.log('calm-workspace slice contract OK — stable imports, one token authority, semantic component ownership');
