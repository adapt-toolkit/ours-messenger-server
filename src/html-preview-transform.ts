import { parse, serialize } from 'parse5';

export const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024;

const DROP_ELEMENTS = new Set(['base', 'embed', 'frame', 'iframe', 'object', 'portal', 'script']);
const DROP_ATTRIBUTES = new Set([
  'action', 'download', 'formaction', 'formtarget', 'ping', 'srcdoc', 'target',
]);

type Node = {
  nodeName?: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string; prefix?: string }>;
  childNodes?: Node[];
  content?: Node;
};

export class HtmlPreviewTransformError extends Error {
  constructor(readonly kind: 'oversize' | 'invalid') {
    super(kind === 'oversize' ? 'HTML preview is too large' : 'HTML preview could not be transformed');
  }
}

const asciiLower = (value: string) => value.replace(/[A-Z]/g, (character) => character.toLowerCase());

function isMetaRefresh(node: Node): boolean {
  if (asciiLower(node.tagName ?? '') !== 'meta') return false;
  return node.attrs?.some((attribute) => asciiLower(attribute.name) === 'http-equiv'
    && asciiLower(attribute.value.trim()) === 'refresh') ?? false;
}

function safeAttributes(node: Node): void {
  if (!node.attrs) return;
  node.attrs = node.attrs.filter((attribute) => {
    const name = asciiLower(attribute.name);
    if (name.startsWith('on') || DROP_ATTRIBUTES.has(name)) return false;
    if (name === 'href' || (attribute.prefix === 'xlink' && name === 'href')) {
      const value = attribute.value.trim();
      if (!value.startsWith('#')) return false;
      attribute.value = value;
    }
    return true;
  });
}

/** Parse hostile HTML with a standards parser, then retain only inert navigation. */
export function transformHtmlPreview(bytes: Uint8Array): Buffer {
  if (bytes.byteLength > MAX_HTML_PREVIEW_BYTES) throw new HtmlPreviewTransformError('oversize');
  try {
    const document = parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)) as Node;
    const stack: Node[] = [document];
    while (stack.length) {
      const node = stack.pop()!;
      safeAttributes(node);
      if (node.content) stack.push(node.content);
      if (!node.childNodes) continue;
      node.childNodes = node.childNodes.filter((child) => {
        const tag = asciiLower(child.tagName ?? child.nodeName ?? '');
        return !DROP_ELEMENTS.has(tag) && !isMetaRefresh(child);
      });
      for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index]);
    }
    return Buffer.from(serialize(document as never), 'utf8');
  } catch (error) {
    if (error instanceof HtmlPreviewTransformError) throw error;
    throw new HtmlPreviewTransformError('invalid');
  }
}
