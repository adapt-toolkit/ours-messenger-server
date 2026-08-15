// In-app viewer for received .html/.htm attachments. Mirrors the Markdown
// preview's modal, byte-loading and off-device behaviour, but the document is
// hostile input: it is NEVER injected into this React tree, only handed to a
// fully sandboxed iframe. See htmlPreviewCore.mjs for the containment model.
//
// There is deliberately no "open original in a new tab": a blob: URL inherits
// this app's origin, so a top-level navigation to the attachment would run its
// scripts as us. Download is the one way to get the original bytes, and it
// hands them over under a neutral type (attachmentBlobMime).
import { useEffect, useState } from 'react';
import DialogShell from './DialogShell';
import { FileRecord, fmtSize, getFileBytes } from './fileStore';
import {
  attachmentBlobMime,
  buildSandboxedHtmlDocument,
  HTML_PREVIEW_SANDBOX,
} from './htmlPreviewCore.mjs';
import { Icon } from './icons';

export function HtmlPreview(props: { rec: FileRecord; onClose: () => void }) {
  const { rec } = props;
  const [doc, setDoc] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

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
        setDoc(buildSandboxedHtmlDocument(new TextDecoder('utf-8').decode(bytes)));
        setSize(bytes.byteLength);
        objectUrl = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: attachmentBlobMime(rec.mime, rec.filename) }),
        );
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
  }, [rec.id, rec.mime, rec.filename]);

  return (
    <DialogShell
      title={rec.filename}
      description="HTML preview · sandboxed, static rendering only"
      onClose={props.onClose}
      wide
      className="markdown-modal html-modal"
    >
      <div className="html-preview">
        <div className="html-preview-toolbar">
          <span className="html-preview-shield">
            <Icon name="shield" size={14} />
            Scripts, forms and network requests are blocked
          </span>
          {url && (
            <a className="btn sm" href={url} download={rec.filename}>
              <Icon name="download" size={14} />
              Download original{size ? ` · ${fmtSize(size)}` : ''}
            </a>
          )}
        </div>

        <div className="html-preview-frame">
          {loadState === 'loading' && <div className="markdown-empty">Loading preview…</div>}
          {loadState === 'missing' && (
            <div className="markdown-empty">This file is available on the original device only.</div>
          )}
          {loadState === 'error' && <div className="markdown-empty">The file could not be opened.</div>}
          {loadState === 'ready' && (
            <iframe
              className="html-preview-iframe"
              title={`Sandboxed preview of ${rec.filename}`}
              sandbox={HTML_PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              srcDoc={doc}
            />
          )}
        </div>
      </div>
    </DialogShell>
  );
}
