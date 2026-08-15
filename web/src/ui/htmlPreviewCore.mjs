// Classification + containment helpers for the in-app HTML attachment viewer.
// Received HTML is HOSTILE INPUT: it arrives from a peer and is never authored
// by us. Everything here is deliberately React-free so the security decisions
// are unit-testable without a DOM (see tests/html-preview.test.mjs).
//
// The containment model has two INDEPENDENT layers, neither of which parses or
// rewrites the attachment (a sanitiser is a bypass surface; we do not run one):
//
//   1. The document is rendered ONLY inside an iframe with an EMPTY sandbox
//      attribute. No allow-scripts, no allow-same-origin, no forms, popups,
//      downloads, top-navigation, modals or pointer-lock. Scripts, event
//      handlers and javascript: URLs therefore never execute, and the frame
//      sits in an opaque origin with no access to app storage or the parent.
//   2. A restrictive CSP is emitted BEFORE the untrusted markup, so it is
//      already in force when the parser reaches it. Everything is denied by
//      default; only inert, self-contained subresources (data:/blob: images,
//      media and fonts, plus inline styles) are permitted. Nothing may open a
//      connection, so there is no exfiltration channel even for CSS.
//
// A page cannot loosen this: additional CSP policies in the attachment are
// enforced alongside ours, never instead of it.

// Keep every value single-quoted: this string is embedded in a double-quoted
// HTML attribute, and a stray `"` would let the attachment break out of it.
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "style-src 'unsafe-inline'",
].join('; ');

// The iframe sandbox attribute. Empty string = every sandbox restriction
// applies. This must never gain a token; the unit tests assert it stays empty.
export const HTML_PREVIEW_SANDBOX = '';

// A blob: URL inherits the ORIGIN OF THE PAGE THAT CREATED IT. A text/html
// blob that reaches a top-level navigation (copied link, middle-click, an
// `<a>` without `download`) would therefore run the attachment's scripts with
// the app's own origin and storage. HTML attachments are handed to
// URL.createObjectURL under a neutral type instead, which the browser will not
// render. The stored bytes are untouched — `download` still saves the original
// file under its original name.
export const NEUTRAL_DOWNLOAD_MIME = 'application/octet-stream';

const EXTENSION = /\.([A-Za-z0-9]{1,12})$/;

function mimeBase(mime) {
  return String(mime ?? '').split(';')[0].trim().toLowerCase();
}

// The final filename extension, lowercased and without the dot ('' when the
// name carries none). `plan.md.txt` → 'txt': only the LAST extension counts.
export function attachmentExtension(filename) {
  const match = EXTENSION.exec(String(filename ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

export function isHtmlFilename(filename) {
  const extension = attachmentExtension(filename);
  return extension === 'html' || extension === 'htm';
}

// An attachment is previewable as HTML when its filename says so, or — only
// when the filename carries NO extension to contradict it, which is how
// incomplete file metadata reaches us — when the declared type does.
// An explicit non-HTML extension always wins, so `report.html.txt` and a
// `.txt` mislabelled `text/html` both stay out of the viewer.
export function isHtmlAttachment(filename, mime) {
  if (isHtmlFilename(filename)) return true;
  if (attachmentExtension(filename)) return false;
  return mimeBase(mime) === 'text/html';
}

// The type to hand to URL.createObjectURL for an attachment: the base type
// with our own mime parameters stripped (a voice note rides
// `<container>; x-ours-kind=voice-message`), except for HTML — see
// NEUTRAL_DOWNLOAD_MIME.
export function attachmentBlobMime(mime, filename) {
  const base = mimeBase(mime);
  if (base === 'text/html' || isHtmlAttachment(filename, mime)) return NEUTRAL_DOWNLOAD_MIME;
  return base;
}

// Deliberately minimal: enough that an unstyled document is readable and that
// oversized media cannot push the frame into a horizontal scroll. Declared
// before the attachment so the attachment's own styling still wins.
const BASE_STYLE = [
  ':root{color-scheme:light}',
  'html{background:#fff}',
  "body{margin:0;padding:24px;color:#0f172a;font:15px/1.65 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;overflow-wrap:break-word}",
  'img,video,svg,canvas,iframe{max-width:100%;height:auto}',
  'pre{overflow:auto}',
  'table{max-width:100%}',
].join('');

// Wrap the attachment in a document whose head carries the CSP. The untrusted
// markup is appended VERBATIM after that head — its own <html>/<head> tags are
// folded into the document by the parser, and the policy above is already
// enforced by the time any of it is read.
export function buildSandboxedHtmlDocument(html) {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${BASE_STYLE}</style>`,
    '</head>',
    '<body>',
    String(html ?? ''),
    '</body>',
    '</html>',
  ].join('\n');
}
