import { isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">{children}</a>
  ),
  img: ({ alt }) => <span className="message-image-placeholder">[image: {alt || 'remote image blocked'}]</span>,
  pre: FencedCodeBlock,
  code: ({ node: _node, className, children, ...props }) => (
    <code className={className} data-language={languageFromClassName(className)} {...props}>
      {children}
    </code>
  ),
} satisfies Components;

/** Safe CommonMark/GFM renderer for text messages. Raw HTML is never enabled. */
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="bubble-text message-markdown">
      <ReactMarkdown
        remarkPlugins={MESSAGE_REMARK_PLUGINS}
        components={MESSAGE_COMPONENTS}
      >
        {normalizeMessageMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});
