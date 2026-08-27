import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'parse5';
import {
  HtmlPreviewTransformError, MAX_HTML_PREVIEW_BYTES, transformHtmlPreview,
} from '../src/html-preview-transform.ts';
import {
  HTML_PREVIEW_CSP, HTML_PREVIEW_SANDBOX, NEUTRAL_DOWNLOAD_MIME,
  attachmentBlobMime, attachmentExtension, isHtmlAttachment, isHtmlFilename,
} from '../web/src/ui/htmlPreviewCore.mjs';

assert.equal(HTML_PREVIEW_SANDBOX, '');
const expectedCsp = new Map([
  ['default-src', ["'none'"]], ['script-src', ["'none'"]], ['connect-src', ["'none'"]],
  ['frame-src', ["'none'"]], ['child-src', ["'none'"]], ['object-src', ["'none'"]],
  ['worker-src', ["'none'"]], ['manifest-src', ["'none'"]], ['form-action', ["'none'"]],
  ['base-uri', ["'none'"]], ['img-src', ['data:', 'blob:']], ['media-src', ['data:', 'blob:']],
  ['font-src', ['data:']], ['style-src', ["'unsafe-inline'"]],
]);
const parsedCsp = new Map();
for (const raw of HTML_PREVIEW_CSP.split(';')) { const tokens = raw.trim().split(/\s+/); parsedCsp.set(tokens.shift(), tokens); }
assert.deepEqual(parsedCsp, expectedCsp);
assert.equal(attachmentExtension('plan.md.txt'), 'txt'); assert.equal(isHtmlFilename('report.HTML'), true);
assert.equal(isHtmlAttachment('report.html.txt', 'text/html'), false); assert.equal(isHtmlAttachment('README', 'text/html'), true);
assert.equal(attachmentBlobMime('text/html', 'report.html'), NEUTRAL_DOWNLOAD_MIME);

const hostile = `<!doctype html><html><head><base href="https://evil.test/"><meta HTTP-EQUIV="  ReFrEsH  " content="0;url=/leak">
<style>:root{--ink:#15213a}body{display:grid;color:var(--ink)}</style><script src=/leak>evil()</script></head><body onload=evil()>
<a id=safe href="  #section ">safe</a><area href="&#x23;map" target=_top><a href="&#x6a;avascript:evil()" ping=/leak download>bad</a>
<form action=/leak target=_top><button formaction=/leak formtarget=_blank onclick=evil()>go</button></form>
<iframe src=/leak srcdoc=x></iframe><frame src=/leak><object data=/leak></object><embed src=/leak><portal src=/leak></portal>
<svg><a xlink:href="#svg" target=_top><text>svg</text></a><use href=" /relative "/></svg>
<math><a href="#math" onmouseover=evil()>math</a></math><h2 id=section style="color:red">Привет</h2></body></html>`;
const transformed = transformHtmlPreview(Buffer.from(hostile));
assert.deepEqual(transformHtmlPreview(transformed), transformed, 'normalization is byte-idempotent');
const tree = parse(transformed.toString('utf8')); const nodes = [tree]; const tags = []; const attrs = [];
while (nodes.length) { const node = nodes.pop(); if (node.tagName) tags.push(node.tagName); if (node.attrs) attrs.push(...node.attrs.map((attr) => ({ tag: node.tagName, name: attr.name, prefix: attr.prefix, value: attr.value }))); if (node.content) nodes.push(node.content); if (node.childNodes) nodes.push(...node.childNodes); }
for (const tag of ['base', 'script', 'iframe', 'frame', 'object', 'embed', 'portal']) assert.equal(tags.includes(tag), false, `${tag} removed`);
for (const attr of attrs) {
  assert.equal(attr.name.startsWith('on'), false, JSON.stringify(attr));
  assert.equal(['target', 'ping', 'download', 'action', 'formaction', 'formtarget', 'srcdoc'].includes(attr.name), false, JSON.stringify(attr));
  if (attr.name === 'href') assert.ok(attr.value.startsWith('#'), JSON.stringify(attr));
}
assert.ok(attrs.some((attr) => attr.value === '#section') && attrs.some((attr) => attr.value === '#svg') && attrs.some((attr) => attr.value === '#math'));
assert.match(transformed.toString(), /display:grid/); assert.match(transformed.toString(), /style="color:red"/); assert.match(transformed.toString(), /Привет/);

for (const value of ['https://e.test', '//e.test', '/relative', 'relative', 'mailto:x@y', 'tel:1', 'javascript:x', 'data:text/html,x', 'blob:x', '\u0000#bad', '\u200b#bad']) {
  const output = transformHtmlPreview(Buffer.from(`<a href="${value}">x</a>`)).toString(); assert.doesNotMatch(output, / href=/, value);
}
const malformed = Buffer.from('<DIV><a href=&#35;ok>ok<a href=HTTPS://evil>x<svg><use xlink:href=&#35;s>');
const once = transformHtmlPreview(malformed); assert.deepEqual(transformHtmlPreview(once), once, 'malformed/namespaced output is stable');
assert.throws(() => transformHtmlPreview(Buffer.alloc(MAX_HTML_PREVIEW_BYTES + 1)), (error) => error instanceof HtmlPreviewTransformError && error.kind === 'oversize');
const deep = Buffer.from('<div>'.repeat(12000) + 'x' + '</div>'.repeat(12000));
try { transformHtmlPreview(deep); } catch (error) { assert.ok(error instanceof HtmlPreviewTransformError, 'deep input fails as a controlled transform error'); }

const component = readFileSync(new URL('../web/src/ui/HtmlPreview.tsx', import.meta.url), 'utf8');
assert.match(component, /sandbox=\{HTML_PREVIEW_SANDBOX\}/); assert.match(component, /key=\{rec\.id\}/);
assert.match(component, /src=\{`\/api\/html-preview\/\$\{encodeURIComponent\(rec\.id\)\}`\}/);
assert.doesNotMatch(component, /srcDoc|buildSandboxedHtmlDocument/); assert.match(component, /attachmentBlobMime/);
assert.match(component, /URL\.revokeObjectURL\(objectUrl\)/); assert.match(component, /Transformed safe preview/);

console.log('html-preview transform OK — standards parsing, inert fragments, bounded/idempotent output');
