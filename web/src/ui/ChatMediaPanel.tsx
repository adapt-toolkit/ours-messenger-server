import { useEffect, useState } from 'react';
import type { ChatMessage } from './chatTypes';
import DialogShell from './DialogShell';
import { FileRecord, fileRecord, fmtSize, getFileBytes, isVoiceNote } from './fileStore';
import {
  extractMessageLinks,
  groupFileVersions,
  isMarkdownFilename,
  messageMediaKind,
} from './markdownReviewCore.mjs';
import { attachmentBlobMime, isHtmlAttachment } from './htmlPreviewCore.mjs';
import { fmtTime } from './viewmodel';
import { Icon } from './icons';

type MediaTab = 'photo' | 'file' | 'link';

function FileMediaItem(props: {
  message: ChatMessage;
  messageKey: string;
  onJump: (key: string) => void;
  onPreview: (rec: FileRecord) => void;
  versionLabel?: string;
}) {
  const { message } = props;
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const rec: FileRecord = fileRecord(message.wireId) ?? {
    id: message.wireId,
    dir: message.dir,
    filename: message.filename ?? 'file',
    mime: message.mime ?? 'application/octet-stream',
    size,
    date: message.date,
  };

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    if (!message.wireId) return;
    void getFileBytes(message.wireId)
      .then((bytes) => {
        if (!live || !bytes) return;
        setSize(bytes.byteLength);
        objectUrl = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: attachmentBlobMime(rec.mime, rec.filename) }),
        );
        setUrl(objectUrl);
      })
      .catch(() => {
        // Metadata remains useful for timeline jumps when device-local bytes
        // are unavailable or IndexedDB cannot be read.
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [message.wireId, rec.mime, rec.filename]);

  const photo = messageMediaKind(message) === 'photo';
  const voice = isVoiceNote(rec.mime, rec.filename);
  return (
    <div className={'shared-media-item' + (photo ? ' shared-photo-item' : '')}>
      <button className="shared-media-jump" onClick={() => props.onJump(props.messageKey)}>
        {photo && url ? (
          <img src={url} alt={rec.filename} />
        ) : (
          <span className="shared-media-icon"><Icon name={voice ? 'mic' : 'copy'} size={18} /></span>
        )}
        <span className="shared-media-copy">
          <strong>{photo ? rec.filename || 'Photo' : voice ? 'Voice message' : rec.filename}</strong>
          <span>{props.versionLabel ? `${props.versionLabel} · ` : ''}{fmtTime(rec.date)}{size ? ` · ${fmtSize(size)}` : ''}</span>
        </span>
      </button>
      <span className="shared-media-actions">
        {isMarkdownFilename(rec.filename) && url && (
          <button className="icon-btn" title="Preview markdown" onClick={() => props.onPreview(rec)}>
            <Icon name="monitor" size={16} />
          </button>
        )}
        {isHtmlAttachment(rec.filename, rec.mime) && url && (
          <button className="icon-btn" title="Preview HTML" onClick={() => props.onPreview(rec)}>
            <Icon name="monitor" size={16} />
          </button>
        )}
        <a
          className={'icon-btn' + (url ? '' : ' disabled')}
          href={url ?? undefined}
          download={rec.filename}
          title="Download"
        >
          <Icon name="download" size={16} />
        </a>
      </span>
    </div>
  );
}

type KeyedMessage = { message: ChatMessage; key: string };

function FileVersionStack(props: {
  filename: string;
  versions: KeyedMessage[];
  onJump: (key: string) => void;
  onPreview: (rec: FileRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.versions.length === 1) {
    const item = props.versions[0];
    return (
      <FileMediaItem
        message={item.message}
        messageKey={item.key}
        onJump={props.onJump}
        onPreview={props.onPreview}
      />
    );
  }

  return (
    <div className={'file-version-stack' + (expanded ? ' expanded' : '')}>
      <button className="file-version-stack-head" onClick={() => setExpanded((value) => !value)}>
        <span className="shared-media-icon"><Icon name="copy" size={18} /></span>
        <span className="shared-media-copy">
          <strong>{props.filename}</strong>
          <span>{props.versions.length} versions · newest {fmtTime(props.versions[0].message.date)}</span>
        </span>
        <Icon name={expanded ? 'chevronDown' : 'chevron'} size={16} />
      </button>
      {expanded && (
        <div className="file-version-stack-list">
          {props.versions.map((item, index) => (
            <FileMediaItem
              key={item.key}
              message={item.message}
              messageKey={item.key}
              versionLabel={`Version ${props.versions.length - index}`}
              onJump={props.onJump}
              onPreview={props.onPreview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatMediaPanel(props: {
  messages: ChatMessage[];
  // First message's absolute history index — keeps these keys identical to the
  // timeline's when `messages` is a bounded page rather than the full history.
  indexOffset?: number;
  onClose: () => void;
  onJump: (messageKey: string) => void;
  onPreview: (rec: FileRecord) => void;
}) {
  const [tab, setTab] = useState<MediaTab>('photo');
  const keyed = props.messages.map((message, index) => ({
    message,
    key: message.wireId || `${message.date}-${(props.indexOffset ?? 0) + index}`,
  }));
  const photos = keyed.filter(({ message }) => messageMediaKind(message) === 'photo');
  const files = keyed.filter(({ message }) => messageMediaKind(message) === 'file');
  const fileGroups = groupFileVersions(files);
  const links = keyed.flatMap(({ message, key }) =>
    message.kind === 'file'
      ? []
      : extractMessageLinks(message.text).map((url) => ({ url, message, key })),
  );
  const tabs: Array<{ id: MediaTab; label: string; count: number }> = [
    { id: 'photo', label: 'Photos', count: photos.length },
    { id: 'file', label: 'Files', count: files.length },
    { id: 'link', label: 'Links', count: links.length },
  ];

  return (
    <DialogShell
      title="Shared media"
      description="Photos, files, and links from this conversation"
      onClose={props.onClose}
      wide
      className="shared-media-modal"
      tabs={(
        <div className="shared-media-tabs" role="tablist" aria-label="Shared media type">
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => setTab(item.id)}
            >
              {item.label} <span>{item.count}</span>
            </button>
          ))}
        </div>
      )}
    >
      <div className={'shared-media-list' + (tab === 'photo' ? ' photos' : '')}>
        {tab === 'photo' && photos.map((item) => (
          <FileMediaItem
            key={item.key}
            message={item.message}
            messageKey={item.key}
            onJump={props.onJump}
            onPreview={props.onPreview}
          />
        ))}
        {tab === 'file' && fileGroups.map((group) => (
          <FileVersionStack
            key={group.filename}
            filename={group.filename}
            versions={group.versions}
            onJump={props.onJump}
            onPreview={props.onPreview}
          />
        ))}
        {tab === 'link' && links.map((item, index) => (
          <div className="shared-media-item" key={`${item.key}-${item.url}-${index}`}>
            <a className="shared-media-jump" href={item.url} target="_blank" rel="noreferrer">
              <span className="shared-media-icon"><Icon name="link" size={18} /></span>
              <span className="shared-media-copy">
                <strong>{item.url}</strong>
                <span>{fmtTime(item.message.date)}</span>
              </span>
            </a>
            <button className="icon-btn" title="Jump to message" onClick={() => props.onJump(item.key)}>
              <Icon name="reply" size={16} />
            </button>
          </div>
        ))}
        {((tab === 'photo' && photos.length === 0) ||
          (tab === 'file' && files.length === 0) ||
          (tab === 'link' && links.length === 0)) && (
          <div className="markdown-empty">No {tab === 'photo' ? 'photos' : `${tab}s`} in this chat yet.</div>
        )}
      </div>
    </DialogShell>
  );
}
