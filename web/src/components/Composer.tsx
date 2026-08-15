import type { KeyboardEvent } from 'react';

export function Composer(props: {
  draft: string;
  replyText: string | null;
  sending: boolean;
  onDraft(value: string): void;
  onCancelReply(): void;
  onSend(): void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      props.onSend();
    }
  };

  return (
    <div className="composer-wrap">
      {props.replyText && (
        <div className="reply-context">
          <span>Replying to: {props.replyText}</span>
          <button type="button" className="icon-button" aria-label="Cancel reply" onClick={props.onCancelReply}>×</button>
        </div>
      )}
      <div className="composer">
        <textarea
          className="composer-input"
          rows={1}
          placeholder="Write a message"
          aria-label="Message"
          value={props.draft}
          disabled={props.sending}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="primary send-button"
          disabled={props.sending || props.draft.trim().length === 0}
          onClick={props.onSend}
        >
          {props.sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
