import { gfmFromMarkdown } from 'mdast-util-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';

export function isMarkdownFilename(filename) {
  return typeof filename === 'string' && /\.md$/i.test(filename.trim());
}

export function formatMarkdownFeedback(selection, comment) {
  const quoted = String(selection ?? '')
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const body = String(comment ?? '').trim();
  return quoted && body ? `${quoted}\n\n${body}` : quoted || body;
}

export function reviewFilename(filename) {
  const original = String(filename ?? '');
  const lastDot = original.lastIndexOf('.');
  const basename = lastDot > 0 ? original.slice(0, lastDot) : original;
  return `${basename}_review.md`;
}

export function selectionOccurrence(text, selection, startOffset) {
  const source = String(text ?? '');
  const needle = String(selection ?? '');
  const limit = Math.max(0, Number(startOffset) || 0);
  if (!needle) return 0;

  let occurrence = 0;
  let searchFrom = 0;
  while (searchFrom <= source.length) {
    const found = source.indexOf(needle, searchFrom);
    if (found < 0 || found >= limit) return occurrence;
    occurrence += 1;
    searchFrom = found + Math.max(needle.length, 1);
  }
  return occurrence;
}

export function extractMessageLinks(text) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s<>()\[\]{}"']+/gi) ?? [];
  return matches.map((url) => url.replace(/[.,!?;:]+$/, ''));
}

export function messageMediaKind(message) {
  if (message?.kind !== 'file') return null;
  return String(message.mime ?? '').toLowerCase().startsWith('image/') ? 'photo' : 'file';
}

export function groupFileVersions(items) {
  const dateValue = (value) => {
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const groups = new Map();
  for (const item of items ?? []) {
    const filename = String(item?.message?.filename || 'file');
    const versions = groups.get(filename) ?? [];
    versions.push(item);
    groups.set(filename, versions);
  }
  return [...groups.entries()]
    .map(([filename, versions]) => ({
      filename,
      versions: versions.sort((a, b) => dateValue(b.message?.date) - dateValue(a.message?.date)),
    }))
    .sort(
      (a, b) =>
        dateValue(b.versions[0]?.message?.date) -
        dateValue(a.versions[0]?.message?.date),
    );
}

const TRAILING_MARKUP_TYPES = new Set([
  'delete',
  'emphasis',
  'inlineCode',
  'link',
  'linkReference',
  'strong',
]);

function markdownRenderedIndex(source) {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const text = [];
  const rawEnds = [];
  const trailingRanges = [];

  const appendValue = (value, node) => {
    const visible = String(value ?? '');
    const rawStart = node.position?.start?.offset;
    const rawEnd = node.position?.end?.offset;
    if (!visible || !Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return;

    const raw = source.slice(rawStart, rawEnd);
    const exactStart = raw.indexOf(visible);
    if (exactStart >= 0) {
      for (let index = 0; index < visible.length; index += 1) {
        text.push(visible[index]);
        rawEnds.push(rawStart + exactStart + index + 1);
      }
      return;
    }

    let cursor = 0;
    for (const character of visible) {
      const found = raw.indexOf(character, cursor);
      const position = found >= 0 ? found : Math.min(cursor, Math.max(raw.length - 1, 0));
      text.push(character);
      rawEnds.push(rawStart + position + 1);
      cursor = position + 1;
    }
  };

  const visit = (node) => {
    const visibleStart = text.length;
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      appendValue(node.value, node);
    } else {
      for (const child of node.children ?? []) visit(child);
    }
    const visibleEnd = text.length;
    const rawEnd = node.position?.end?.offset;
    if (
      visibleEnd > visibleStart
      && TRAILING_MARKUP_TYPES.has(node.type)
      && Number.isInteger(rawEnd)
    ) {
      trailingRanges.push({ visibleEnd, rawEnd });
    }
  };

  visit(tree);
  return { text: text.join(''), rawEnds, trailingRanges };
}

function findOccurrence(text, selection, occurrence) {
  let found = -1;
  let searchFrom = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    found = text.indexOf(selection, searchFrom);
    if (found < 0) return -1;
    searchFrom = found + Math.max(selection.length, 1);
  }
  return found;
}

export function formatReviewDocument(markdown, comments) {
  const source = String(markdown ?? '');
  const rendered = markdownRenderedIndex(source);
  const placements = new Map();
  const unplaced = [];

  for (const [index, item] of (comments ?? []).entries()) {
    const selection = String(item?.selection ?? '').trim();
    const comment = String(item?.comment ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\]\]/g, '] ]');
    if (!comment) continue;

    const marker = `[[REVIEW COMMENT ${index + 1}: ${comment}]]`;
    const occurrence = Number.isInteger(item?.occurrence) && item.occurrence >= 0
      ? item.occurrence
      : 0;
    const visibleStart = selection
      ? findOccurrence(rendered.text, selection, occurrence)
      : -1;
    const visibleEnd = visibleStart + selection.length;
    let anchorEnd = visibleStart >= 0 ? rendered.rawEnds[visibleEnd - 1] : undefined;
    if (!Number.isInteger(anchorEnd)) {
      unplaced.push(`[[REVIEW COMMENT ${index + 1} — ANCHOR NOT FOUND: ${comment}]]`);
      continue;
    }
    for (const range of rendered.trailingRanges) {
      if (range.visibleEnd === visibleEnd) anchorEnd = Math.max(anchorEnd, range.rawEnd);
    }
    const markers = placements.get(anchorEnd) ?? [];
    markers.push(marker);
    placements.set(anchorEnd, markers);
  }

  let reviewed = source;
  const positions = [...placements.keys()].sort((a, b) => b - a);
  for (const position of positions) {
    reviewed = `${reviewed.slice(0, position)} ${placements.get(position).join(' ')}${reviewed.slice(position)}`;
  }
  if (unplaced.length > 0) {
    reviewed = `${reviewed.trimEnd()}\n\n${unplaced.join('\n')}\n`;
  }
  return reviewed;
}
