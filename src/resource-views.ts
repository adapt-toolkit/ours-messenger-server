import { projectHistoryPage, type ConversationPage, type ConversationMessage } from './conversation.js';
import type { HistoryMessage, IdentityResourcePosition, OursClient } from '@ours.network/sdk';

/** Retire publication ownership without waiting for a legacy abort-ignoring RPC. */
export async function abortableProjection<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('resource projection aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([read, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Capture under an already-installed committed observer. Source position comes
 * from the producer, never from the number of wakes received by Messenger. */
export async function captureResourceProjection<T>(
  client: Pick<OursClient, 'resourcePosition'>,
  identity: string,
  project: () => Promise<T>,
  signal: AbortSignal,
  localRevision: () => number = () => 0,
): Promise<{ source: IdentityResourcePosition; payload: T }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const local = localRevision();
    const before = await abortableProjection(client.resourcePosition(identity, { signal }), signal);
    signal.throwIfAborted();
    const payload = await abortableProjection(project(), signal);
    signal.throwIfAborted();
    const after = await abortableProjection(client.resourcePosition(identity, { signal }), signal);
    signal.throwIfAborted();
    if (before.producerGeneration === after.producerGeneration && before.position === after.position
        && local === localRevision()) return { source: after, payload };
  }
  throw new Error('resource projection unstable');
}

export interface ResourceFrameBinding {
  readonly protocolVersion: 1;
  readonly producerGeneration: string;
  readonly subscriptionEpoch: number;
  readonly viewId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly baselineId?: string;
}
export type ResourceHealthReason = 'auth_required' | 'unsupported' | 'upstream_unavailable';
export type ResourceEnvelope = ResourceFrameBinding & { readonly source?: IdentityResourcePosition } & (
  | { readonly kind: 'snapshot'; readonly payload: unknown }
  | { readonly kind: 'upsert'; readonly payload: MessageResourceDelta }
  | { readonly kind: 'delete'; readonly payload: { readonly id: string; readonly revision: number } }
  | { readonly kind: 'ready'; readonly payload: { readonly baselineId: string; readonly source: IdentityResourcePosition } }
  | { readonly kind: 'coverage'; readonly payload: { readonly source: IdentityResourcePosition } }
  | { readonly kind: 'resync'; readonly payload: { readonly reason: 'capacity' | 'projection_unavailable' } }
  | { readonly kind: 'health'; readonly payload: { readonly healthy: false; readonly reason: ResourceHealthReason } }
);
export interface ResourceCoverage { readonly protocolVersion: 1; readonly producerGeneration: string; readonly views: readonly (ResourceFrameBinding & {readonly source: IdentityResourcePosition})[] }
export interface ResourceWireFrame { event: 'resource' | 'resource-chunk' | 'resource-coverage'; data: Record<string, unknown> }
export const RESOURCE_FRAME_BYTES = 512 * 1024;
export const RESOURCE_PENDING_BYTES = 8 * 1024 * 1024;
export const RESOURCE_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** Lazily yield byte chunks so backpressure never queues an entire large record.
 * Base64 prevents splitting a Unicode scalar from corrupting JSON/SSE parsing. */
export function* resourceFrames(envelope: ResourceEnvelope): Generator<ResourceWireFrame> {
  const bytes = Buffer.from(JSON.stringify(envelope));
  if (bytes.length > RESOURCE_ASSEMBLY_BYTES) throw new Error('resource assembly limit exceeded');
  const ordinary = { event: 'resource' as const, data: envelope as unknown as Record<string, unknown> };
  if (Buffer.byteLength(`event: resource\ndata: ${bytes.toString('utf8')}\n\n`) <= RESOURCE_FRAME_BYTES) {
    yield ordinary; return;
  }
  const id = `${envelope.viewId}:${envelope.subscriptionEpoch}:${envelope.sequence}`;
  const binding = { protocolVersion: 1, id, producerGeneration: envelope.producerGeneration,
    viewId: envelope.viewId, subscriptionEpoch: envelope.subscriptionEpoch, revision: envelope.revision,
    sequence: envelope.sequence };
  yield { event: 'resource-chunk', data: { ...binding, type: 'start', totalBytes: bytes.length, parts: Math.ceil(bytes.length / CHUNK_BYTES) } };
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index++) {
    yield { event: 'resource-chunk', data: { ...binding, type: 'chunk', index, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') } };
  }
  yield { event: 'resource-chunk', data: { ...binding, type: 'commit', totalBytes: bytes.length } };
}

export interface ResourceDescriptor {
  readonly viewId: string;
  readonly resource: 'contacts' | 'identity' | 'messages' | 'files' | 'commands' | 'activity';
  readonly entityId?: string;
  readonly addressing?: 'cid';
  readonly window?: { readonly limit: number; readonly retainedPages: number; readonly oldestSequence?: number };
}
/** Canonical supported read shapes only. Entity names remain data, never paths. */
export function canonicalResourceDescriptor(value: unknown): ResourceDescriptor {
  const invalid = (): never => { throw new Error('invalid resource descriptor'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['viewId', 'resource', 'entityId', 'window', 'addressing'].includes(key))
      || typeof row.viewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.viewId)
      || !['contacts', 'identity', 'messages', 'files', 'commands', 'activity'].includes(String(row.resource))) return invalid();
  const resource = row.resource as ResourceDescriptor['resource'];
  const scoped = ['messages', 'files', 'commands'].includes(resource);
  if (scoped ? typeof row.entityId !== 'string' || !row.entityId : row.entityId !== undefined) return invalid();
  if (row.addressing !== undefined && (row.addressing !== 'cid'
      || !['messages', 'files'].includes(resource) || !/^[a-f0-9]{64}$/i.test(String(row.entityId)))) return invalid();
  if (resource !== 'messages' && row.window !== undefined) return invalid();
  let window: ResourceDescriptor['window'];
  if (resource === 'messages') {
    const raw = row.window ?? { limit: 50, retainedPages: 1 };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const w = raw as Record<string, unknown>;
    if (Object.keys(w).some(key => !['limit', 'retainedPages', 'oldestSequence'].includes(key))
        || !Number.isInteger(w.limit) || (w.limit as number) < 1 || (w.limit as number) > 200
        || !Number.isSafeInteger(w.retainedPages) || (w.retainedPages as number) < 1
        || (w.oldestSequence !== undefined && (!Number.isSafeInteger(w.oldestSequence) || (w.oldestSequence as number) < 1))) return invalid();
    window = { limit: w.limit as number, retainedPages: w.retainedPages as number,
      ...(w.oldestSequence === undefined ? {} : { oldestSequence: w.oldestSequence as number }) };
  }
  return { viewId: row.viewId, resource, ...(scoped ? { entityId: row.entityId as string } : {}),
    ...(row.addressing === 'cid' ? { addressing: 'cid' as const } : {}), ...(window ? { window } : {}) };
}

export type ContactActivity = { readonly at: string } | { readonly unavailable: true };
/** Preserve the existing request-owned activity budget; no periodic work. */
export const ACTIVITY_DEADLINE_MS = 5000;

/** Metadata-only SDK operation. Unsupported daemons fail explicitly; no body-history fallback. */
export async function projectActivity(
  client: Pick<OursClient, 'getContactActivity'>,
  signal?: AbortSignal,
  expectedSource?: IdentityResourcePosition,
): Promise<{ activity: Record<string, ContactActivity> }> {
  signal?.throwIfAborted();
  // Once admitted, this RPC remains owned until it settles. Cancelling a
  // projection suppresses publication, not synchronous provider SQL.
  const snapshot = await client.getContactActivity();
  signal?.throwIfAborted();
  if (expectedSource && (snapshot.source.producerGeneration !== expectedSource.producerGeneration
      || snapshot.source.position !== expectedSource.position)) throw new Error('activity source changed');
  return { activity: snapshot.activity };
}

export interface MessageResourceSnapshot extends ConversationPage { readonly oldestSequence: number | null }
export interface MessageResourceDelta {
  readonly type: 'message-delta';
  readonly upserts: readonly { readonly id: string; readonly item: ConversationMessage }[];
  readonly deletes: readonly string[];
  readonly window: Omit<MessageResourceSnapshot, 'messages'> & { readonly orderedIds: readonly string[] };
}

/** Reuse the HTTP serializer for every row and page metadata. Reads are passive.
 * Explicit oldestSequence keeps loaded history live as new arrivals grow it. */
export async function projectMessageWindow(
  client: Pick<OursClient, 'listHistory' | 'getHistorySummary'>,
  contact: string,
  announcedContact: string,
  window: NonNullable<ResourceDescriptor['window']>,
  signal: AbortSignal,
  options: { readonly preview?: false } = {},
): Promise<MessageResourceSnapshot> {
  let before: number | undefined;
  const rows: HistoryMessage[] = [];
  let next: number | null = null;
  let totalBytes = 0;
  for (let pageIndex = 0; ; pageIndex++) {
    signal.throwIfAborted();
    const page = await client.listHistory({ peer_cid: contact, before_seq: before, limit: window.limit });
    signal.throwIfAborted();
    if (page.next_cursor !== null && (!Number.isSafeInteger(page.next_cursor)
        || (before !== undefined && page.next_cursor >= before))) throw new Error('invalid history continuation');
    const selected = window.oldestSequence === undefined ? page.items : page.items.filter(row => row.seq >= window.oldestSequence!);
    totalBytes += Buffer.byteLength(JSON.stringify(projectHistoryPage(contact, { items: selected, next_cursor: null },
      { total: 0, unread: 0 }, { announcedContact, ...options }).messages));
    if (totalBytes > RESOURCE_ASSEMBLY_BYTES) throw new Error('resource assembly limit exceeded');
    rows.push(...selected);
    next = page.next_cursor;
    const crossedLowerBound = window.oldestSequence !== undefined
      && page.items.some(row => row.seq <= window.oldestSequence!);
    if (next === null || crossedLowerBound || (window.oldestSequence === undefined && pageIndex + 1 >= window.retainedPages)) {
      // If the lower bound lies within a page, continuation must point at the
      // oldest included row rather than skipping the unused rest of that page.
      if (selected.length !== page.items.length) next = selected.at(-1)?.seq ?? window.oldestSequence!;
      break;
    }
    before = next;
  }
  const ids = new Set(rows.map(row => row.wire_id));
  if (ids.has('') || ids.size !== rows.length) throw new Error('message view lacks stable IDs');
  const summary = await client.getHistorySummary({ peer_cid: contact });
  signal.throwIfAborted();
  return { ...projectHistoryPage(contact, { items: rows, next_cursor: next }, summary, { announcedContact, ...options }),
    oldestSequence: rows.at(-1)?.seq ?? window.oldestSequence ?? null };
}

/** A completed delta is one atomic logical update. Ordering removes departed
 * window members; deletes separately certify actual absence at the source. */
export async function messageProjectionDelta(
  client: Pick<OursClient, 'getHistoryItem'>,
  previous: MessageResourceSnapshot,
  current: MessageResourceSnapshot,
  signal: AbortSignal,
): Promise<MessageResourceDelta> {
  const old = new Map(previous.messages.map(item => [item.wire_id, item]));
  const ids = new Set(current.messages.map(item => item.wire_id));
  if (ids.has('') || ids.size !== current.messages.length) throw new Error('message view lacks stable IDs');
  const deletes: string[] = [];
  for (const id of old.keys()) {
    signal.throwIfAborted();
    if (!ids.has(id) && await client.getHistoryItem({ wire_id: id }) === null) deletes.push(id);
  }
  signal.throwIfAborted();
  const { messages, ...metadata } = current;
  return { type: 'message-delta', upserts: messages.filter(item => JSON.stringify(old.get(item.wire_id)) !== JSON.stringify(item))
    .map(item => ({ id: item.wire_id, item })), deletes,
    window: { ...metadata, orderedIds: messages.map(item => item.wire_id) } };
}
