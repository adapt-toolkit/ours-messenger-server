import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  closeSync, fsyncSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface ReplyReference {
  readonly wire_id: string;
  readonly sentence?: number;
}

export interface MediaRecord {
  readonly wire_id: string;
  readonly contact_id: string;
  readonly dir: 'in' | 'out';
  readonly sender_id: string;
  readonly sender_name: string;
  readonly filename: string;
  readonly logical_name: string;
  readonly version: number;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly date: string;
  readonly date_source: 'protocol' | 'server_observed';
  readonly kind: 'file' | 'photo' | 'voice_message';
  readonly reply_to: ReplyReference | null;
  readonly available: boolean;
  readonly transcription?: unknown;
}

interface MediaState {
  version: 1;
  files: MediaRecord[];
  replies: Record<string, ReplyReference>;
}

export interface IncomingMediaMetadata {
  readonly wire_id: string;
  readonly from: { readonly id: string; readonly name: string };
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly date: string;
  readonly kind: 'file' | 'voice_message';
  readonly reply_to: ReplyReference | null;
  readonly transcription?: unknown;
}

export interface OutgoingMediaMetadata {
  readonly wire_id: string;
  readonly contact_id: string;
  readonly sender_id: string;
  readonly sender_name: string;
  readonly filename: string;
  readonly mime: string;
  readonly date?: string;
  readonly reply_to?: ReplyReference | null;
}

const emptyState = (): MediaState => ({ version: 1, files: [], replies: {} });

function logicalName(filename: string): string {
  return filename.normalize('NFC').toLocaleLowerCase('en-US');
}

function mediaKind(mime: string, filename: string, sdkKind?: string): MediaRecord['kind'] {
  if (sdkKind === 'voice_message' || (
    mime.toLowerCase().split(';').slice(1).map((part) => part.trim()).includes('x-ours-kind=voice-message')
  ) || (mime.toLowerCase().startsWith('audio/') && filename.toLowerCase().startsWith('voice-message-'))) {
    return 'voice_message';
  }
  return mime.toLowerCase().split(';', 1)[0].trim().startsWith('image/') ? 'photo' : 'file';
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function blobName(wireId: string): string {
  return `${createHash('sha256').update(wireId).digest('hex')}.bin`;
}

function validState(value: unknown): value is MediaState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<MediaState>;
  return state.version === 1 && Array.isArray(state.files) && !!state.replies && typeof state.replies === 'object';
}

/**
 * Messenger-owned metadata missing from the SDK conversation projection.
 * Message bodies remain in MUFL; this store contains reply correlations and
 * immutable file bytes/metadata only. It lives inside the messenger state root
 * with owner-only permissions and never overwrites a wire-id blob.
 */
export class MediaStore {
  readonly #root: string;
  readonly #file: string;
  readonly #blobs: string;
  #state: MediaState;

  private constructor(root: string, state: MediaState) {
    this.#root = root;
    this.#file = join(root, 'index.json');
    this.#blobs = join(root, 'blobs');
    this.#state = state;
  }

  static open(stateDir: string): MediaStore {
    const root = join(stateDir, 'media');
    const blobs = join(root, 'blobs');
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(blobs, 0o700);
    const file = join(root, 'index.json');
    let state = emptyState();
    if (existsSync(file)) {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('messenger media index is not a safe regular file');
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!validState(parsed)) throw new Error('messenger media index has an unsupported or invalid shape');
      state = parsed;
      chmodSync(file, 0o600);
    }
    const store = new MediaStore(root, state);
    if (!existsSync(file)) store.#persist();
    return store;
  }

  #persist(): void {
    const tmp = join(this.#root, `.index.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(this.#state, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
    chmodSync(this.#file, 0o600);
  }

  #nextVersion(contactId: string, filename: string): number {
    const logical = logicalName(filename);
    return this.#state.files.reduce(
      (max, row) => row.contact_id === contactId && row.logical_name === logical ? Math.max(max, row.version) : max,
      0,
    ) + 1;
  }

  #writeBlobOnce(wireId: string, bytes: Uint8Array): string {
    const path = join(this.#blobs, blobName(wireId));
    const hash = digest(bytes);
    if (existsSync(path)) {
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('messenger media blob is not a safe regular file');
      const existing = readFileSync(path);
      if (digest(existing) !== hash) throw new Error('wire-id media blob already exists with different bytes');
      return hash;
    }
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
    return hash;
  }

  recordReply(wireId: string | undefined, reply: ReplyReference | null | undefined): void {
    if (!wireId || !reply?.wire_id) return;
    const current = this.#state.replies[wireId];
    if (current && JSON.stringify(current) !== JSON.stringify(reply)) {
      throw new Error('wire-id reply correlation already exists with a different target');
    }
    if (current) return;
    this.#state.replies[wireId] = { ...reply };
    this.#persist();
  }

  replyFor(wireId: string): ReplyReference | null {
    const reply = this.#state.replies[wireId];
    return reply ? { ...reply } : null;
  }

  recordOutgoing(meta: OutgoingMediaMetadata, bytes: Uint8Array): MediaRecord {
    const existing = this.#state.files.find((row) => row.wire_id === meta.wire_id);
    const sha256 = this.#writeBlobOnce(meta.wire_id, bytes);
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error('outgoing media metadata conflicts with immutable bytes');
      return existing;
    }
    const record: MediaRecord = {
      wire_id: meta.wire_id,
      contact_id: meta.contact_id,
      dir: 'out',
      sender_id: meta.sender_id,
      sender_name: meta.sender_name,
      filename: meta.filename,
      logical_name: logicalName(meta.filename),
      version: this.#nextVersion(meta.contact_id, meta.filename),
      mime: meta.mime,
      size: bytes.byteLength,
      sha256,
      date: meta.date ?? new Date().toISOString(),
      date_source: meta.date ? 'protocol' : 'server_observed',
      kind: mediaKind(meta.mime, meta.filename),
      reply_to: meta.reply_to ?? null,
      available: true,
    };
    this.#state.files.push(record);
    if (record.reply_to) this.#state.replies[record.wire_id] = { ...record.reply_to };
    this.#persist();
    return record;
  }

  reconcileIncoming(rows: readonly IncomingMediaMetadata[]): readonly MediaRecord[] {
    let changed = false;
    for (const row of rows) {
      const at = this.#state.files.findIndex((entry) => entry.wire_id === row.wire_id);
      if (at >= 0) {
        const current = this.#state.files[at];
        const next = { ...current, transcription: row.transcription ?? current.transcription };
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          this.#state.files[at] = next;
          changed = true;
        }
        continue;
      }
      this.#state.files.push({
        wire_id: row.wire_id,
        contact_id: row.from.id,
        dir: 'in',
        sender_id: row.from.id,
        sender_name: row.from.name,
        filename: row.filename,
        logical_name: logicalName(row.filename),
        version: this.#nextVersion(row.from.id, row.filename),
        mime: row.mime,
        size: row.size,
        sha256: null,
        date: row.date,
        date_source: 'protocol',
        kind: mediaKind(row.mime, row.filename, row.kind),
        reply_to: row.reply_to,
        available: false,
        ...(row.transcription === undefined ? {} : { transcription: row.transcription }),
      });
      if (row.reply_to) this.#state.replies[row.wire_id] = { ...row.reply_to };
      changed = true;
    }
    if (changed) this.#persist();
    return this.list();
  }

  storeIncoming(wireId: string, bytes: Uint8Array, metadata?: Partial<IncomingMediaMetadata>): MediaRecord {
    const at = this.#state.files.findIndex((row) => row.wire_id === wireId);
    if (at < 0) throw new Error('incoming file metadata must be reconciled before storing bytes');
    const current = this.#state.files[at];
    const sha256 = this.#writeBlobOnce(wireId, bytes);
    const next: MediaRecord = {
      ...current,
      size: bytes.byteLength,
      sha256,
      available: true,
      ...(metadata?.transcription === undefined ? {} : { transcription: metadata.transcription }),
    };
    this.#state.files[at] = next;
    this.#persist();
    return next;
  }

  list(contactId?: string): readonly MediaRecord[] {
    return this.#state.files
      .filter((row) => !contactId || row.contact_id === contactId)
      .map((row) => ({ ...row, reply_to: row.reply_to ? { ...row.reply_to } : null }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.version - b.version);
  }

  get(wireId: string): MediaRecord | null {
    return this.list().find((row) => row.wire_id === wireId) ?? null;
  }

  read(wireId: string): { readonly record: MediaRecord; readonly bytes: Buffer } {
    const record = this.get(wireId);
    if (!record?.available || !record.sha256) throw new Error('media bytes are not available; fetch the received file first');
    const path = join(this.#blobs, blobName(wireId));
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('messenger media blob is not a safe regular file');
    const bytes = readFileSync(path);
    if (digest(bytes) !== record.sha256) throw new Error('messenger media blob failed its integrity check');
    return { record, bytes };
  }
}
