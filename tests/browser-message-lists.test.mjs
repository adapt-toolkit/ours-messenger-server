// LIST MARKERS IN MESSAGES, ASSERTED IN A BROWSER AGAINST THE SHIPPED CSS.
//
// Tailwind's preflight emits `ol,ul,menu{list-style:none}` and it was the only
// list-style rule in the bundle, so a message list kept its indentation (from the
// app's own padding-left) and lost its bullet or number. Indented lines with
// nothing in front of them.
//
// BOTH HALVES OF THIS TEST ARE REAL, which matters for a rendering assertion:
//   - the MARKUP is produced by the real MessageMarkdown component, server-
//     rendered here, so a future change that stops emitting <ul> is caught;
//   - the CSS is the real built bundle from dist/web/assets, so the preflight
//     reset and every override are in play exactly as shipped.
//
// AND IT ASSERTS THE MARKER IS DRAWN, NOT MERELY THAT AN <li> EXISTS. A
// list-style-type of 'disc' with the marker clipped outside the bubble looks
// identical to the bug being fixed, so the geometry is checked too: the marker
// gutter must be inside the bubble's painted box, and the marker must occupy it.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from '../web/src/ui/MessageMarkdown.js';

globalThis.window = { location: { origin: 'https://messenger.example' } };

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the message-list browser gate');
const cssFiles = readdirSync(join(webRoot, 'assets')).filter((name) => name.endsWith('.css'));
assert.ok(cssFiles.length > 0, 'the built bundle ships a stylesheet');
const css = cssFiles.map((name) => readFileSync(join(webRoot, 'assets', name), 'utf8')).join('\n');

// The reset this test exists because of. If Tailwind ever stops shipping it the
// override becomes dead code, and this says so rather than passing quietly.
assert.match(css, /ol,ul,menu\{list-style:none\}/,
  'the preflight reset is still in the bundle — this override is still load-bearing');

const MESSAGE = [
  '- first bullet',
  '- second bullet',
  '  - nested bullet',
  '',
  '1. first number',
  '2. second number',
].join('\n');

const markup = renderToStaticMarkup(createElement(MessageMarkdown, { text: MESSAGE }));
assert.match(markup, /<ul>/, 'the renderer emits a real <ul> — the markers have something to hang on');
assert.match(markup, /<ol>/, 'and a real <ol>');

const page404 = '<!doctype html><meta charset="utf-8"><title>404</title>';
const html = `<!doctype html>
<meta charset="utf-8">
<style>${css}</style>
<style>
  /* Only to give the bubble a deterministic box to measure against. */
  body { margin: 0; background: #fff; }
  .harness { width: 420px; padding: 20px; }
</style>
<div class="harness">
  <div class="ours-message ours-message--in">
    <div class="bubble-text message-markdown" id="subject">${markup}</div>
  </div>
</div>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(page404);
});
await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(origin, { waitUntil: 'load' });

const measured = await page.evaluate(() => {
  const bubble = document.getElementById('subject');
  const ul = bubble.querySelector('ul');
  const ol = bubble.querySelector('ol');
  const nested = ul.querySelector('ul');

  const typeOf = (element) => getComputedStyle(element).listStyleType;
  const positionOf = (element) => getComputedStyle(element).listStylePosition;

  // Where the marker is painted: for `list-style-position: outside` it sits in
  // the gutter between the list's border-box left and its content-box left.
  const gutter = (list) => {
    const rect = list.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(list).paddingLeft);
    return { left: rect.left, contentLeft: rect.left + padding, width: padding };
  };

  // Where the item's TEXT starts, measured from the text node itself rather than
  // from the <li> box: if a marker is drawn the text is inset from the list's
  // border-box left by roughly the gutter, and if it is not the two coincide.
  const textLeft = (item) => {
    const range = document.createRange();
    range.selectNodeContents(item);
    return range.getBoundingClientRect().left;
  };

  const firstItem = ul.querySelector('li');
  return {
    ulType: typeOf(ul),
    olType: typeOf(ol),
    nestedType: nested ? typeOf(nested) : null,
    position: positionOf(ul),
    ulGutter: gutter(ul),
    bubbleRect: (({ left, right }) => ({ left, right }))(bubble.getBoundingClientRect()),
    bubbleOverflowX: getComputedStyle(bubble).overflowX,
    firstItemTextLeft: textLeft(firstItem),
    olFirstItemTextLeft: textLeft(ol.querySelector('li')),
  };
});

// ---- the markers exist ------------------------------------------------------
assert.notEqual(measured.ulType, 'none',
  'an unordered message list has a marker — this is the reported bug');
assert.equal(measured.ulType, 'disc', 'and it is the browser default disc');
assert.notEqual(measured.olType, 'none',
  'AN ORDERED LIST HAS ONE TOO — a list-style reset takes numbers with it, so this is asserted, not assumed');
assert.equal(measured.olType, 'decimal', 'and it is the browser default decimal');
assert.equal(measured.nestedType, 'circle',
  'a nested list gets the next marker in the sequence rather than a frozen disc at every depth');

// ---- and they are actually drawn, inside the bubble -------------------------
assert.equal(measured.position, 'outside', 'markers hang in the list gutter, as the padding-left assumes');
assert.ok(measured.ulGutter.width > 0,
  `the list reserves a gutter for the marker (${measured.ulGutter.width}px)`);
assert.ok(measured.ulGutter.left >= measured.bubbleRect.left - 0.5,
  `the marker gutter starts inside the bubble (gutter ${measured.ulGutter.left} vs bubble ${measured.bubbleRect.left}) — a marker painted left of this edge would be invisible`);
assert.ok(measured.firstItemTextLeft - measured.ulGutter.left > 1,
  `the item text is inset from the list edge, so the marker occupies the gutter rather than the text starting flush (inset ${(measured.firstItemTextLeft - measured.ulGutter.left).toFixed(1)}px)`);
assert.ok(measured.olFirstItemTextLeft - measured.ulGutter.left > 1,
  'the ordered list is inset the same way');
assert.notEqual(measured.bubbleOverflowX, 'hidden',
  'the bubble does not clip horizontally, so nothing crops the gutter');

await browser.close();
server.close();
console.log('browser-message-lists OK — bullets and numbers render, nest, and sit inside the bubble');
