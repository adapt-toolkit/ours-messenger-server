import { isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Parsing cost is bounded per mounted message. Larger peer messages remain
 * complete and selectable, but deliberately fall back to literal plaintext.
 * The high threshold keeps normal messages on the Markdown path while placing
 * a deterministic ceiling on parser work for untrusted peer input.
 */
export const MAX_MARKDOWN_INPUT_LENGTH = 50_000;

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** An explicit outbound-link allowlist; relative and active schemes are inert. */
export function safeMessageUrl(value?: string): string | undefined {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol.toLowerCase()) ? value : undefined;
  } catch {
    return undefined;
  }
}

function languageFromClassName(className?: string) {
  const prefix = 'language-';
  return className?.startsWith(prefix) ? className.slice(prefix.length) || undefined : undefined;
}

// Agent and transport output can carry a paragraph-wide tab or indentation
// level even though it is prose. CommonMark interprets that as an indented code
// block, producing a large, misleading inset in the bubble. Remove indentation
// shared by every non-empty line in each prose block. Explicit fenced blocks
// remain untouched because their opening fence starts at column zero.
export function normalizeMessageMarkdown(text: string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((block) => {
      if (/^\n[ \t]*\n$/.test(block)) return block;
      const lines = block.split('\n');
      const contentLines = lines.filter((line) => line.trim().length > 0);
      if (contentLines.length === 0) return block;
      const indents = contentLines.map((line) => line.match(/^[ \t]+/)?.[0] ?? '');
      if (indents.some((indent) => indent.length === 0)) return block;
      const width = Math.min(...indents.map((indent) => indent.length));
      return lines.map((line) => line.trim().length > 0 ? line.slice(width) : line).join('\n');
    })
    .join('');
}

function FencedCodeBlock({ children }: { children?: ReactNode }) {
  const child = isValidElement(children) ? children as ReactElement<{ className?: string }> : null;
  const language = languageFromClassName(child?.props.className);
  return (
    <div className="message-code-block" data-language={language || undefined}>
      {language && <div className="message-code-language">{language}</div>}
      <pre>{children}</pre>
    </div>
  );
}

// Keep both renderer configuration objects stable. More importantly,
// MessageMarkdown itself is memoized below: the composer state lives in the
// Conversation component, so without that boundary every keystroke reparses
// every historical message through the Markdown/GFM pipeline.
const MESSAGE_REMARK_PLUGINS = [remarkGfm];
const MESSAGE_COMPONENTS = {
  a: ({ node: _node, children, href, ...props }) => {
    const safe = safeMessageUrl(href);
    return safe
      ? <a {...props} href={safe} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span className="message-link-blocked">{children}</span>;
  },
  img: ({ alt }) => <span className="message-image-placeholder">[image: {alt || 'remote image blocked'}]</span>,
  pre: FencedCodeBlock,
  code: ({ node: _node, className, children, ...props }) => (
    <code className={className} data-language={languageFromClassName(className)} {...props}>
      {children}
    </code>
  ),
} satisfies Components;

/** Safe CommonMark/GFM renderer for text messages. Raw HTML is never enabled. */
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  className = 'bubble-text message-markdown',
}: {
  text: string;
  className?: string;
}) {
  if (text.length > MAX_MARKDOWN_INPUT_LENGTH) {
    return (
      <div className={`${className} message-markdown-plaintext`} data-render-mode="plaintext">
        {text}
      </div>
    );
  }
  return (
    <div className={className} data-render-mode="markdown">
      <ReactMarkdown
        remarkPlugins={MESSAGE_REMARK_PLUGINS}
        components={MESSAGE_COMPONENTS}
        urlTransform={(url) => safeMessageUrl(url) ?? ''}
      >
        {normalizeMessageMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});
