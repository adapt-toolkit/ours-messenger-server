import { isValidElement, memo, type ReactElement, type ReactNode, RefObject, useEffect, useRef, useState } from 'react';
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
import { MermaidDiagram } from './MermaidDiagram';

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
          pre: ({ children }) => {
            const child = isValidElement(children) ? children as ReactElement<{ className?: string; children?: ReactNode }> : null;
            return child?.props.className === 'language-mermaid'
              ? <MermaidDiagram source={String(child.props.children).replace(/\n$/, '')} />
              : <pre>{children}</pre>;
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
  const [fullscreen, setFullscreen] = useState(false);
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
      className={'markdown-modal' + (fullscreen ? ' markdown-reader-fullscreen' : '')}
    >
      <div className="markdown-preview">
        <div className="markdown-review-toolbar">
          <button
            className="btn sm"
            type="button"
            aria-label={fullscreen ? 'Exit reader fullscreen' : 'View reader fullscreen'}
            aria-pressed={fullscreen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setFullscreen((value) => !value)}
          >
            <Icon name="maximize" size={14} />
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
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
