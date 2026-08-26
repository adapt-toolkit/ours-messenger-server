import { memo, RefObject, useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DialogShell from './DialogShell';
import { AttachPreview, PendingAttachment, VoiceComposer } from './FileBubbles';
import { FileRecord, getFileBytes } from './fileStore';
import {
  formatMarkdownFeedback,
  formatReviewDocument,
  reviewFilename,
  selectionOccurrence,
} from './markdownReviewCore.mjs';
import { Icon } from './icons';

const MERMAID_MIN_SCALE = 0.25;
const MERMAID_MAX_SCALE = 8;

type MermaidTheme = 'default' | 'dark';

let mermaidRenderQueue: Promise<void> = Promise.resolve();

function readMermaidTheme(): MermaidTheme {
  return document.documentElement.classList.contains('theme-dark') ? 'dark' : 'default';
}

function useMermaidTheme(): MermaidTheme {
  const [theme, setTheme] = useState<MermaidTheme>(readMermaidTheme);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setTheme(readMermaidTheme());
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    syncTheme();
    return () => observer.disconnect();
  }, []);

  return theme;
}

function renderMermaid(id: string, source: string, theme: MermaidTheme) {
  const render = mermaidRenderQueue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    // Mermaid configuration is global. Keep initialize + render in one
    // serialized critical section so another diagram cannot replace the
    // palette between those calls.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: 'var(--sans)',
    });
    return mermaid.render(id, source);
  });
  mermaidRenderQueue = render.then(() => undefined, () => undefined);
  return render;
}

function clampMermaidScale(value: number) {
  return Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, value));
}

function MermaidFullscreen(props: { svg: string; theme: MermaidTheme; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const resetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const zoomAt = (nextScale: number, clientX?: number, clientY?: number) => {
    const clamped = clampMermaidScale(nextScale);
    if (clamped === scale) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) {
      const offsetX = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const offsetY = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const ratio = clamped / scale;
      setPan((current) => ({
        x: offsetX - ratio * (offsetX - current.x),
        y: offsetY - ratio * (offsetY - current.y),
      }));
    }
    setScale(clamped);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomAt(scale * 1.25);
      } else if (event.key === '-') {
        event.preventDefault();
        zoomAt(scale / 1.25);
      } else if (event.key === '0') {
        event.preventDefault();
        resetView();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="mermaid-fullscreen-backdrop" />
        <Dialog.Content
          className="mermaid-fullscreen"
          data-mermaid-theme={props.theme}
          aria-describedby="mermaid-fullscreen-help"
        >
          <Dialog.Title className="mermaid-fullscreen-title">Diagram viewer</Dialog.Title>
          <div className="mermaid-fullscreen-tools">
            <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt(scale / 1.25)}>
              <Icon name="minus" />
            </button>
            <button className="mermaid-zoom-value" onClick={resetView} title="Reset zoom and position">
              {Math.round(scale * 100)}%
            </button>
            <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(scale * 1.25)}>
              <Icon name="plus" />
            </button>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="Close diagram viewer" title="Close (Esc)">
                <Icon name="close" />
              </button>
            </Dialog.Close>
          </div>
          <div
            ref={viewportRef}
            className={'mermaid-fullscreen-viewport' + (dragging ? ' dragging' : '')}
            onWheel={(event) => {
              event.preventDefault();
              zoomAt(scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
            }}
            onDoubleClick={(event) => zoomAt(scale * 1.5, event.clientX, event.clientY)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                panX: pan.x,
                panY: pan.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setPan({
                x: drag.panX + event.clientX - drag.startX,
                y: drag.panY + event.clientY - drag.startY,
              });
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return;
              dragRef.current = null;
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setDragging(false);
            }}
          >
            <div
              className="mermaid-fullscreen-canvas"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
              dangerouslySetInnerHTML={{ __html: props.svg }}
            />
          </div>
          <Dialog.Description id="mermaid-fullscreen-help" className="mermaid-fullscreen-help">
            Scroll to zoom · drag to move · double-click to zoom in
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MermaidDiagram({ source }: { source: string }) {
  const rawId = useId();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [renderedTheme, setRenderedTheme] = useState<MermaidTheme>('default');
  const [fullscreen, setFullscreen] = useState(false);
  const theme = useMermaidTheme();

  useEffect(() => {
    let live = true;
    const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    setSvg('');
    setError('');
    void renderMermaid(id, source, theme)
      .then((rendered) => {
        if (live) {
          setRenderedTheme(theme);
          setSvg(rendered.svg);
        }
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
      document.getElementById(`d${id}`)?.remove();
    };
  }, [rawId, source, theme]);

  if (error) return <pre className="markdown-mermaid-error">Mermaid error: {error}</pre>;
  if (!svg) return <div className="markdown-mermaid-loading">Rendering diagram…</div>;
  return (
    <>
      <div className="markdown-mermaid" data-mermaid-theme={renderedTheme}>
        <button
          className="icon-btn markdown-mermaid-expand"
          aria-label="View diagram fullscreen"
          title="View diagram fullscreen"
          onClick={() => setFullscreen(true)}
        >
          <Icon name="maximize" />
        </button>
        <div className="markdown-mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      {fullscreen && (
        <MermaidFullscreen svg={svg} theme={renderedTheme} onClose={() => setFullscreen(false)} />
      )}
    </>
  );
}

// Selection changes update the preview toolbar. Keep those state commits out
// of the rendered document: iOS owns the native selection handles, and a
// React commit over their DOM after touch release can detach that editing
// session even when the visible text did not change.
const MarkdownDocument = memo(function MarkdownDocument(props: {
  markdown: string;
  contentRef: RefObject<HTMLDivElement>;
}) {
  return (
    <article className="markdown-body" ref={props.contentRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...anchorProps }) => (
            <a {...anchorProps} target="_blank" rel="noreferrer">{children}</a>
          ),
          code: ({ className, children, ...codeProps }) => {
            const language = /language-([\w-]+)/.exec(className ?? '')?.[1];
            const source = String(children).replace(/\n$/, '');
            return language === 'mermaid'
              ? <MermaidDiagram source={source} />
              : <code className={className} {...codeProps}>{children}</code>;
          },
        }}
      >
        {props.markdown}
      </ReactMarkdown>
    </article>
  );
});

export function MarkdownPreview(props: {
  rec: FileRecord;
  onClose: () => void;
  onSendText: (text: string, replyToWireId?: string) => Promise<string | void>;
  onSendFile?: (att: PendingAttachment, replyToWireId?: string) => Promise<void>;
}) {
  const { rec } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const [markdown, setMarkdown] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [selection, setSelection] = useState('');
  const [selectedOccurrence, setSelectedOccurrence] = useState(0);
  const [feedbackSelection, setFeedbackSelection] = useState('');
  const [feedbackOccurrence, setFeedbackOccurrence] = useState(0);
  const [showFeedback, setShowFeedback] = useState(false);
  const [comment, setComment] = useState('');
  const [sendingText, setSendingText] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewComments, setReviewComments] = useState<Array<{
    selection: string;
    comment: string;
    occurrence: number;
  }>>([]);
  const [sendingReview, setSendingReview] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<PendingAttachment | null>(null);
  const [sendingVoice, setSendingVoice] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setLoadState('loading');
    void getFileBytes(rec.id)
      .then((bytes) => {
        if (!live) return;
        if (!bytes) {
          setLoadState('missing');
          return;
        }
        setMarkdown(new TextDecoder('utf-8').decode(bytes));
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/markdown;charset=utf-8' }));
        setUrl(objectUrl);
        setLoadState('ready');
      })
      .catch(() => {
        if (live) setLoadState('error');
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rec.id]);

  useEffect(() => {
    const readSelection = () => {
      const selected = window.getSelection();
      const root = contentRef.current;
      if (!selected || selected.isCollapsed || !root) {
        setSelection('');
        setSelectedOccurrence(0);
        return;
      }
      if (!root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) {
        setSelection('');
        setSelectedOccurrence(0);
        return;
      }
      const selectedRange = selected.getRangeAt(0);
      const rawSelection = selected.toString();
      const leadingWhitespace = rawSelection.length - rawSelection.trimStart().length;
      const selectedText = rawSelection.trim().slice(0, 4000);
      const prefix = document.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(selectedRange.startContainer, selectedRange.startOffset);
      const selectedStart = prefix.toString().length + leadingWhitespace;
      setSelection(selectedText);
      setSelectedOccurrence(
        selectionOccurrence(root.textContent, selectedText, selectedStart),
      );
    };
    document.addEventListener('selectionchange', readSelection);
    return () => document.removeEventListener('selectionchange', readSelection);
  }, []);

  const openFeedback = () => {
    if (!selection) return;
    setFeedbackSelection(selection);
    setFeedbackOccurrence(selectedOccurrence);
    setShowFeedback(true);
    setStatus('');
  };

  const sendFeedback = async () => {
    if (reviewMode) {
      if (!feedbackSelection || !comment.trim()) return;
      setReviewComments((items) => [
        ...items,
        {
          selection: feedbackSelection,
          comment: comment.trim(),
          occurrence: feedbackOccurrence,
        },
      ]);
      setComment('');
      setShowFeedback(false);
      setStatus('Comment added to review');
      return;
    }
    const text = formatMarkdownFeedback(feedbackSelection, comment);
    if (!text || !comment.trim() || sendingText) return;
    setSendingText(true);
    setStatus('');
    try {
      await props.onSendText(text, rec.id || undefined);
      setComment('');
      setShowFeedback(false);
      setStatus('Feedback sent');
    } catch (err) {
      setStatus(`Send failed: ${String(err)}`);
    } finally {
      setSendingText(false);
    }
  };

  const submitReview = async () => {
    if (reviewComments.length === 0 || sendingReview) return;
    const reviewMarkdown = formatReviewDocument(markdown, reviewComments);
    setSendingReview(true);
    setStatus('');
    try {
      if (props.onSendFile) {
        await props.onSendFile({
          filename: reviewFilename(rec.filename),
          mime: 'text/markdown',
          bytes: new TextEncoder().encode(reviewMarkdown),
        }, rec.id || undefined);
      } else {
        await props.onSendText(reviewMarkdown, rec.id || undefined);
      }
      setReviewComments([]);
      setReviewMode(false);
      setStatus('Review submitted');
    } catch (err) {
      setStatus(`Review send failed: ${String(err)}`);
    } finally {
      setSendingReview(false);
    }
  };

  const sendVoice = async () => {
    if (!pendingVoice || !props.onSendFile || sendingVoice) return;
    setSendingVoice(true);
    setStatus('');
    try {
      await props.onSendFile(pendingVoice, rec.id || undefined);
      setPendingVoice(null);
      setStatus('Voice feedback sent');
    } catch (err) {
      setStatus(`Voice send failed: ${String(err)}`);
    } finally {
      setSendingVoice(false);
    }
  };

  return (
    <DialogShell
      title={rec.filename}
      description="Markdown preview · select text to send precise feedback"
      onClose={props.onClose}
      wide
      className="markdown-modal"
    >
      <div className="markdown-preview">
        <div className="markdown-review-toolbar">
          <button
            className="btn sm"
            disabled={!selection}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openFeedback}
          >
            <Icon name="reply" size={14} />
            {reviewMode ? 'Add review comment' : 'Quick message'}{selection ? ` (${selection.length})` : ''}
          </button>
          {!reviewMode ? (
            <button
              className="btn sm"
              onClick={() => {
                setReviewMode(true);
                setReviewComments([]);
                setStatus('Review started — select passages to add comments');
              }}
            >
              <Icon name="edit" size={14} />
              Start review
            </button>
          ) : (
            <button
              className="btn sm"
              onClick={() => {
                setReviewMode(false);
                setReviewComments([]);
                setShowFeedback(false);
                setStatus('Review discarded');
              }}
            >
              Cancel review
            </button>
          )}
          {url && (
            <a className="btn sm" href={url} download={rec.filename}>
              <Icon name="download" size={14} />
              Download
            </a>
          )}
          {props.onSendFile && (
            <VoiceComposer
              disabled={!!pendingVoice || sendingVoice}
              onReady={setPendingVoice}
              onError={setStatus}
            />
          )}
          <span className="markdown-review-hint">
            {selection ? 'Selection ready for feedback' : 'Highlight any passage to comment on it'}
          </span>
        </div>

        {showFeedback && (
          <div className="markdown-feedback">
            <blockquote>{feedbackSelection}</blockquote>
            <textarea
              className="field"
              rows={3}
              autoFocus
              placeholder="What should change?"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
            <div className="markdown-feedback-actions">
              <button className="btn sm" onClick={() => setShowFeedback(false)}>Cancel</button>
              <button className="btn sm primary" disabled={!comment.trim() || sendingText} onClick={() => void sendFeedback()}>
                <Icon name="send" size={14} />
                {reviewMode ? 'Add to review' : sendingText ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </div>
        )}

        {reviewMode && (
          <div className="markdown-review-draft">
            <div className="markdown-review-draft-head">
              <strong>Review · {reviewComments.length} comment{reviewComments.length === 1 ? '' : 's'}</strong>
              <button
                className="btn sm primary"
                disabled={reviewComments.length === 0 || sendingReview}
                onClick={() => void submitReview()}
              >
                <Icon name="send" size={14} />
                {sendingReview ? 'Submitting…' : 'Submit review'}
              </button>
            </div>
            {reviewComments.map((item, index) => (
              <div className="markdown-review-comment" key={`${index}-${item.selection.slice(0, 24)}`}>
                <span>{index + 1}</span>
                <div>
                  <blockquote>{item.selection}</blockquote>
                  <p>{item.comment}</p>
                </div>
                <button
                  className="icon-btn"
                  title="Remove comment"
                  onClick={() => setReviewComments((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {pendingVoice && (
          <AttachPreview
            att={pendingVoice}
            sending={sendingVoice}
            onSend={() => void sendVoice()}
            onDiscard={() => setPendingVoice(null)}
          />
        )}
        {status && <div className="markdown-review-status" role="status">{status}</div>}

        <div className="markdown-preview-scroll">
          {loadState === 'loading' && <div className="markdown-empty">Loading preview…</div>}
          {loadState === 'missing' && <div className="markdown-empty">This file is available on the original device only.</div>}
          {loadState === 'error' && <div className="markdown-empty">The file could not be opened.</div>}
          {loadState === 'ready' && (
            <MarkdownDocument markdown={markdown} contentRef={contentRef} />
          )}
        </div>
      </div>
    </DialogShell>
  );
}
