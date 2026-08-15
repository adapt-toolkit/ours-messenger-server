import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown, SafeMarkdown } from '../src/components/Markdown.js';

globalThis.window = { location: { origin: 'https://messenger.example' } } as Window & typeof globalThis;

const hostile = '<img src=x onerror=alert(1)> **bold** [bad](javascript:alert(1)) [good](https://example.com/x)';
const inline = renderToStaticMarkup(<span><InlineMarkdown text={hostile} /></span>);
assert.ok(inline.includes('&lt;img src=x onerror=alert(1)&gt;'));
assert.ok(!inline.includes('<img src=x'));
assert.ok(!inline.includes('href="javascript:'));
assert.ok(inline.includes('href="https://example.com/x"'));
assert.ok(inline.includes('<strong>bold</strong>'));

const document = renderToStaticMarkup(<SafeMarkdown text={'# Title\n```html\n<script>alert(1)</script>\n```'} />);
assert.ok(document.includes('<h1>Title</h1>'));
assert.ok(document.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(!document.includes('<script>'));

console.log('markdown OK — inline/file rendering escapes HTML and rejects active link schemes');
