import { Fragment, type ReactNode } from 'react';

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function inlineMarkdown(text: string): ReactNode[] {
  const pattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > at) nodes.push(text.slice(at, index));
    const token = match[0];
    const key = `${index}:${token}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = parts ? safeHref(parts[2]) : null;
      nodes.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{parts![1]}</a>
        : <Fragment key={key}>{token}</Fragment>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    at = index + token.length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

export function InlineMarkdown(props: { text: string }) {
  return <>{inlineMarkdown(props.text)}</>;
}

export function SafeMarkdown(props: { text: string }) {
  const lines = props.text.replaceAll('\r\n', '\n').split('\n');
  const blocks: ReactNode[] = [];
  let fenced = false;
  let code: string[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (fenced) {
        blocks.push(<pre key={`code-${index}`}><code>{code.join('\n')}</code></pre>);
        code = [];
      }
      fenced = !fenced;
      return;
    }
    if (fenced) { code.push(line); return; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = inlineMarkdown(heading[2]);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={index}>{content}</Tag>);
      return;
    }
    const list = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (list) {
      blocks.push(<div className="markdown-list-row" key={index}>• <span>{inlineMarkdown(list[1])}</span></div>);
      return;
    }
    blocks.push(line
      ? <p key={index}>{inlineMarkdown(line)}</p>
      : <div className="markdown-gap" key={index} aria-hidden="true" />);
  });
  if (fenced && code.length) blocks.push(<pre key="code-final"><code>{code.join('\n')}</code></pre>);
  return <div className="safe-markdown">{blocks}</div>;
}
