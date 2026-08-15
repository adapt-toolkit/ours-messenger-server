import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { startVoiceRecording, type VoiceRecording } from '../voice.js';

export function Composer(props: {
  draft: string;
  replyText: string | null;
  sending: boolean;
  sendingLabel: string | null;
  onDraft(value: string): void;
  onCancelReply(): void;
  onSend(): void;
  onFiles(files: File[]): void;
  onVoice(blob: Blob, filename: string, mime: string): void;
  onError(message: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [voice, setVoice] = useState<VoiceRecording | null>(null);
  const voiceRef = useRef<VoiceRecording | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!voice) return;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1_000)), 250);
    return () => window.clearInterval(timer);
  }, [voice]);

  useEffect(() => () => voiceRef.current?.cancel(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      props.onSend();
    }
  };

  const attach = (files: FileList | File[]) => {
    const selected = Array.from(files);
    if (selected.length) props.onFiles(selected);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length) {
      event.preventDefault();
      attach(event.clipboardData.files);
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    attach(event.dataTransfer.files);
  };

  const record = async () => {
    try {
      const next = await startVoiceRecording();
      setSeconds(0);
      voiceRef.current = next;
      setVoice(next);
    } catch (error) {
      props.onError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : error instanceof Error ? error.message : 'Voice recording could not start.');
    }
  };

  const stop = async () => {
    const active = voice;
    if (!active) return;
    voiceRef.current = null;
    setVoice(null);
    try {
      const result = await active.stop();
      props.onVoice(result.blob, result.filename, result.mime);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Voice recording failed.');
    }
  };

  const cancel = () => {
    voice?.cancel();
    voiceRef.current = null;
    setVoice(null);
    setSeconds(0);
  };

  return (
    <div
      className={`composer-wrap${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      {props.replyText && (
        <div className="reply-context">
          <span>Replying to: {props.replyText}</span>
          <button type="button" className="icon-button" aria-label="Cancel reply" onClick={props.onCancelReply}>×</button>
        </div>
      )}
      <div className="composer">
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          multiple
          aria-label="Choose files"
          onChange={(event) => { if (event.target.files) attach(event.target.files); event.target.value = ''; }}
        />
        <button type="button" className="icon-button" aria-label="Attach files" disabled={props.sending || !!voice} onClick={() => input.current?.click()}>＋</button>
        <textarea
          className="composer-input"
          rows={1}
          placeholder="Write a message"
          aria-label="Message"
          value={props.draft}
          disabled={props.sending}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {voice ? (
          <div className="recording-controls" role="status">
            <span className="recording-dot" aria-hidden="true" />
            <span>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
            <button type="button" className="secondary compact" onClick={cancel}>Cancel</button>
            <button type="button" className="primary compact" onClick={() => void stop()}>Send voice</button>
          </div>
        ) : (
          <button type="button" className="icon-button" aria-label="Record voice message" disabled={props.sending} onClick={() => void record()}>●</button>
        )}
        <button
          type="button"
          className="primary send-button"
          disabled={props.sending || props.draft.trim().length === 0}
          onClick={props.onSend}
        >
          {props.sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {props.sending && props.sendingLabel && <div className="transfer-status" role="status">{props.sendingLabel}</div>}
      {dragging && <div className="drop-hint">Drop files to send</div>}
    </div>
  );
}
