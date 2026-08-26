import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HTML_PREVIEW_CSP, HTML_PREVIEW_SANDBOX, NEUTRAL_DOWNLOAD_MIME,
  attachmentBlobMime, attachmentExtension, buildSandboxedHtmlDocument,
  isHtmlAttachment, isHtmlFilename,
} from '../web/src/ui/htmlPreviewCore.mjs';

assert.equal(HTML_PREVIEW_SANDBOX, '', 'iframe sandbox has no capability token');
const expectedCsp = new Map([
  ['default-src', ["'none'"]], ['script-src', ["'none'"]], ['connect-src', ["'none'"]],
  ['frame-src', ["'none'"]], ['child-src', ["'none'"]], ['object-src', ["'none'"]],
  ['worker-src', ["'none'"]], ['manifest-src', ["'none'"]], ['form-action', ["'none'"]],
  ['base-uri', ["'none'"]], ['img-src', ['data:', 'blob:']], ['media-src', ['data:', 'blob:']],
  ['font-src', ['data:']], ['style-src', ["'unsafe-inline'"]],
]);
const parsedCsp = new Map();
for (const raw of HTML_PREVIEW_CSP.split(';')) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const name = tokens.shift();
  assert.ok(name, 'CSP has no empty directive');
  assert.equal(parsedCsp.has(name), false, `CSP directive ${name} is unique`);
  parsedCsp.set(name, tokens);
}
assert.deepEqual(parsedCsp, expectedCsp, 'CSP directive names and token sets are exact; additive loosening fails');

const hostile = '<script>top.location="https://evil.test"</script><form action="https://evil.test"><input></form><img src="https://evil.test/x"><p id="verbatim">unchanged</p>';
const document = buildSandboxedHtmlDocument(hostile);
assert.ok(document.indexOf('Content-Security-Policy') < document.indexOf(hostile), 'CSP precedes hostile markup');
assert.ok(document.includes(hostile), 'hostile attachment body remains verbatim');
assert.match(document, /<meta name="referrer" content="no-referrer">/);
assert.match(document, /html\{background:#fff\}/);
assert.match(document, /color:#0f172a/);

assert.equal(attachmentExtension('plan.md.txt'), 'txt');
assert.equal(isHtmlFilename('report.HTML'), true);
assert.equal(isHtmlAttachment('report.html.txt', 'text/html'), false);
assert.equal(isHtmlAttachment('README', 'text/html; charset=utf-8'), true);
assert.equal(attachmentBlobMime('text/html; charset=utf-8', 'report.html'), NEUTRAL_DOWNLOAD_MIME);
assert.equal(attachmentBlobMime('text/plain', 'report.html'), NEUTRAL_DOWNLOAD_MIME);
assert.equal(attachmentBlobMime('image/png; x-test=1', 'image.png'), 'image/png');

const component = readFileSync(new URL('../web/src/ui/HtmlPreview.tsx', import.meta.url), 'utf8');
const markdown = readFileSync(new URL('../web/src/ui/MarkdownPreview.tsx', import.meta.url), 'utf8');
assert.match(component, /sandbox=\{HTML_PREVIEW_SANDBOX\}/);
assert.match(component, /referrerPolicy="no-referrer"/);
assert.match(component, /download=\{rec\.filename\}/);
const executableComponent = component.replace(/\/\/.*$/gm, '');
assert.doesNotMatch(executableComponent, /target="_blank"|window\.open|open original/i, 'no top-level open path exists');
assert.match(component, /URL\.revokeObjectURL\(objectUrl\)/, 'object URL is revoked on cleanup');
assert.match(markdown, /securityLevel:\s*'strict'/, 'Mermaid keeps strict security');
assert.match(markdown, /mermaidRenderQueue\.then[\s\S]*initialize[\s\S]*mermaid\.render/, 'Mermaid initialize and render remain serialized');
assert.match(markdown, /finally[\s\S]*getElementById\(id\)[\s\S]*getElementById\(`d\$\{id\}`\)/,
  'Mermaid render seam removes both unique temporary ids on success and failure');

// WCAG relative luminance: #0f172a on #fff comfortably exceeds 7:1.
const linear = (n) => { const value = n / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
const ink = 0.2126 * linear(0x0f) + 0.7152 * linear(0x17) + 0.0722 * linear(0x2a);
assert.ok((1.05 / (ink + 0.05)) >= 7, 'isolated document paper/ink exception has enhanced contrast');

console.log('html-preview security OK — empty sandbox, deny-first CSP, verbatim hostile body, neutral download, no top-level open path');
