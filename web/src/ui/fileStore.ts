// Server-media adapter for the messenger file UI. The server is authoritative;
// browser IndexedDB persistence is intentionally absent.
import type { MediaRecord } from '../types.js';

export const OURS_VOICE_PARAM = 'x-ours-kind=voice-message';
export const VOICE_FILE_PREFIX = 'voice-message-';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface FileRecord {
  id: string;
  dir: 'in' | 'out';
  filename: string;
  mime: string;
  size: number;
  date: string;
  available?: boolean;
  logicalName?: string;
  version?: number;
  transcription?: MediaRecord['transcription'];
}

export interface MediaProvider {
  url(wireId: string): string | null;
  bytes(wireId: string): Promise<Uint8Array | null>;
  fetch(wireId: string): Promise<void>;
}

let provider: MediaProvider | null = null;
let providerWaiters: Array<(value: MediaProvider) => void> = [];
const records = new Map<string, FileRecord>();

export function configureMediaProvider(next: MediaProvider): void {
  provider = next;
  for (const resolve of providerWaiters) resolve(next);
  providerWaiters = [];
}

export function registerMediaRecords(media: readonly MediaRecord[]): void {
  for (const item of media) {
    records.set(item.wire_id, {
      id: item.wire_id,
      dir: item.dir,
      filename: item.filename,
      mime: item.mime,
      size: item.size,
      date: item.date,
      available: item.available,
      logicalName: item.logical_name,
      version: item.version,
      transcription: item.transcription,
    });
  }
}

export function clearMediaRecords(): void { records.clear(); }

export function fileRecord(wireId: string): FileRecord | null { return records.get(wireId) ?? null; }
export function getFileUrl(wireId: string): string | null { return provider?.url(wireId) ?? null; }

export function voiceMime(baseContainerMime: string): string { return `${baseContainerMime}; ${OURS_VOICE_PARAM}`; }

export function isVoiceNote(mime: string, filename: string): boolean {
  return /x-ours-kind\s*=\s*voice-message/i.test(mime)
    || (filename.toLowerCase().startsWith(VOICE_FILE_PREFIX) && mime.toLowerCase().startsWith('audio/'));
}

export function baseMime(mime: string): string { return mime.split(';')[0].trim(); }

export function filePreviewLabel(filename?: string, mime?: string): string {
  const name = filename ?? 'file';
  const type = mime ?? '';
  if (isVoiceNote(type, name)) return '🎤 Voice message';
  if (type.toLowerCase().startsWith('image/')) return '🖼 Photo';
  return `📎 ${name}`;
}

export async function getFileBytes(id: string): Promise<Uint8Array | null> {
  const current = provider ?? await new Promise<MediaProvider>((resolve) => providerWaiters.push(resolve));
  return current.bytes(id);
}

export async function fetchFile(id: string): Promise<void> {
  if (!provider) throw new Error('Media provider is not ready');
  await provider.fetch(id);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
