import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import type { MediaRecord } from '../types.js';
import { SafeMarkdown } from './Markdown.js';

const size = (bytes: number) => bytes < 1024
  ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

function MediaPreview({ file }: { file: MediaRecord }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseMime = file.mime.split(';', 1)[0].toLowerCase();

  useEffect(() => {
    if (!file.available) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetch(api.mediaUrl(file.wire_id), { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed (HTTP ${response.status})`);
        const blob = await response.blob();
        if (cancelled) return;
        if (baseMime === 'text/markdown' || file.filename.toLowerCase().endsWith('.md') || baseMime === 'text/html') {
          setText(await blob.text());
        } else if (baseMime.startsWith('image/') || baseMime.startsWith('audio/')) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Preview failed'); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [baseMime, file.available, file.filename, file.wire_id]);

  if (error) return <p className="media-error">{error}</p>;
  if (baseMime.startsWith('image/') && url) return <img className="photo-preview" src={url} alt={file.filename} />;
  if ((baseMime.startsWith('audio/') || file.kind === 'voice_message') && url) {
    return <audio className="audio-preview" src={url} controls preload="metadata" />;
  }
  if ((baseMime === 'text/markdown' || file.filename.toLowerCase().endsWith('.md')) && text !== null) {
    return <SafeMarkdown text={text} />;
  }
  if (baseMime === 'text/html' && text !== null) {
    const source = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${text}`;
    return <iframe className="html-preview" title={`Safe preview of ${file.filename}`} sandbox="" srcDoc={source} />;
  }
  return null;
}

export function MediaInventory(props: {
  files: readonly MediaRecord[];
  busyWire: string | null;
  onFetch(file: MediaRecord): void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, MediaRecord[]>();
    for (const file of props.files) map.set(file.logical_name, [...(map.get(file.logical_name) ?? []), file]);
    return [...map.values()].map((versions) => versions.sort((a, b) => b.version - a.version));
  }, [props.files]);

  if (!groups.length) return <p className="empty-copy">No files in this dialog.</p>;
  return (
    <div className="media-inventory">
      {groups.map((versions) => {
        const latest = versions[0];
        return (
          <details className="media-group" key={latest.logical_name} open={groups.length === 1}>
            <summary><strong>{latest.filename}</strong><span>{versions.length} version{versions.length === 1 ? '' : 's'}</span></summary>
            {versions.map((file) => (
              <article className="media-version" key={file.wire_id}>
                <div className="media-version-head">
                  <span>v{file.version} · {file.dir === 'in' ? `from ${file.sender_name}` : 'sent by you'}</span>
                  <time dateTime={file.date}>{new Date(file.date).toLocaleString()}</time>
                </div>
                <small>{file.mime} · {size(file.size)} · wire {file.wire_id.slice(0, 12)}…</small>
                {file.sha256 && <small>sha256 {file.sha256}</small>}
                {file.available ? (
                  <>
                    <MediaPreview file={file} />
                    <a className="secondary compact download-link" href={api.mediaUrl(file.wire_id)} download={file.filename}>Download</a>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={props.busyWire === file.wire_id}
                    onClick={() => props.onFetch(file)}
                  >
                    {props.busyWire === file.wire_id ? 'Fetching…' : 'Fetch preview & download'}
                  </button>
                )}
                {file.transcription?.text && <p className="transcript"><strong>Transcript:</strong> {file.transcription.text}</p>}
                {file.kind === 'voice_message' && file.transcription && !file.transcription.text && (
                  <p className="muted">Transcription: {file.transcription.status ?? 'unavailable'}{file.transcription.error_category ? ` (${file.transcription.error_category})` : ''}</p>
                )}
              </article>
            ))}
          </details>
        );
      })}
    </div>
  );
}
