import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAX_MARKDOWN_INPUT_LENGTH,
  MessageMarkdown,
  normalizeMessageMarkdown,
  safeMessageUrl,
} from '../src/ui/MessageMarkdown.js';

const source = [
  '# Tool result',
  '**bold** and *emphasis* with `inline()`',
  '- first',
  '- second',
  '',
  'soft',
  'break  ',
  'hard',
  '',
  '```ts',
  '<script>alert(1)</script>',
  '```',
].join('\n');
const sourceSnapshot = source;
const document = renderToStaticMarkup(<MessageMarkdown text={source} />);

assert.equal(source, sourceSnapshot, 'rendering never mutates the canonical wire/reply/copy source');
assert.match(document, /data-render-mode="markdown"/);
assert.match(document, /<h1>Tool result<\/h1>/, 'headings render');
assert.match(document, /<strong>bold<\/strong>/, 'strong emphasis renders');
assert.match(document, /<em>emphasis<\/em>/, 'emphasis renders');
assert.match(document, /<code[^>]*>inline\(\)<\/code>/, 'inline code renders');
assert.match(document, /<ul>/, 'lists render');
assert.match(document, /<br\/>/, 'a CommonMark hard break renders as a br');
assert.match(document, /message-code-block/, 'fenced code uses the bounded scroll container');
assert.match(document, /data-language="ts"/, 'a fenced-code language remains available to the UI');
assert.ok(document.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'HTML in code stays literal');
assert.ok(!document.includes('<script>'), 'raw HTML never becomes an active element');

const hostile = [
  '<img src=x onerror=alert(1)>',
  '[https](https://example.com/x)',
  '[http](http://example.com/x)',
  '[mail](mailto:person@example.com)',
  '[script](javascript:alert(1))',
  '[encoded](jav&#x61;script:alert(1))',
  '[data](data:text/html,boom)',
  '[file](file:///etc/passwd)',
  '[ftp](ftp://example.com/file)',
  '[relative](/admin)',
  '[protocol-relative](//example.com/x)',
  '![tracker](https://tracker.example/pixel.png)',
].join(' ');
const inline = renderToStaticMarkup(<MessageMarkdown text={hostile} />);
assert.ok(inline.includes('&lt;img src=x onerror=alert(1)&gt;'), 'raw HTML is inert literal text');
assert.ok(!inline.includes('<img'), 'neither HTML nor Markdown images create an img element');
assert.match(inline, /\[image: tracker\]/, 'remote images become a readable placeholder');
for (const href of ['https://example.com/x', 'http://example.com/x', 'mailto:person@example.com']) {
  assert.ok(inline.includes(`href="${href}"`), `${href} is explicitly allowed`);
}
assert.equal((inline.match(/<a /g) ?? []).length, 3, 'only allowlisted protocols become links');
assert.ok(!/href="(?:javascript|data|file|ftp|\/|\/\/)/i.test(inline), 'unsafe and relative hrefs stay inert');
assert.equal((inline.match(/target="_blank"/g) ?? []).length, 3, 'safe links open in a new tab');
assert.equal((inline.match(/rel="noopener noreferrer"/g) ?? []).length, 3, 'safe links isolate the opener and referrer');

for (const value of ['https://example.com', 'http://example.com', 'mailto:person@example.com']) {
  assert.equal(safeMessageUrl(value), value);
}
for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'ftp://example.com', '/relative', '//example.com', ' https://example.com', 'https://example.com\n']) {
  assert.equal(safeMessageUrl(value), undefined, `${JSON.stringify(value)} is rejected by the explicit protocol policy`);
}

const atLimit = '# rendered\n' + 'x'.repeat(MAX_MARKDOWN_INPUT_LENGTH - 11);
const atLimitMarkup = renderToStaticMarkup(<MessageMarkdown text={atLimit} />);
assert.match(atLimitMarkup, /data-render-mode="markdown"/, 'the documented threshold remains Markdown-capable');
assert.match(atLimitMarkup, /<h1>rendered<\/h1>/);

const oversized = '# literal\n' + 'x'.repeat(MAX_MARKDOWN_INPUT_LENGTH);
const oversizedMarkup = renderToStaticMarkup(<MessageMarkdown text={oversized} />);
assert.match(oversizedMarkup, /data-render-mode="plaintext"/, 'oversized input uses the bounded plaintext fallback');
assert.match(oversizedMarkup, /message-markdown-plaintext/);
assert.ok(oversizedMarkup.includes('# literal\n'), 'fallback keeps Markdown syntax literal');
assert.ok(oversizedMarkup.includes('x'.repeat(MAX_MARKDOWN_INPUT_LENGTH)), 'fallback is lossless, never truncated');

const indented = '    Fleet result\n    - evidence';
assert.equal(normalizeMessageMarkdown(indented), 'Fleet result\n- evidence');
assert.equal(indented, '    Fleet result\n    - evidence', 'normalization returns a projection and preserves its input');

console.log('markdown OK — safe CommonMark rendering, explicit URLs, inert HTML/images, and lossless long-input fallback');
