// The browser surface projected from the shared daemon's durable history.
//
// WHAT IS DELIBERATELY ABSENT, because an absence is invisible unless it is written
// down:
//
//   * `getMessages` IS NOT EXPOSED. It is the CONSUMING read: it hands messages to
//     an agent and emits a read receipt on the way past. A frontend polling it would
//     silently tell every peer that a human had read messages nobody had looked at.
//     The frontend's read path is `GET /api/conversations/:contact` (non-consuming)
//     and `POST /api/conversations/:contact/read` when a person actually sees them.
//     The consuming agent path remains an SDK-host concern outside this server;
//     messenger neither exposes it nor includes an MCP transport.
//
//   * THE CONTROL-PLANE METHODS ARE NOT PORTED. sendControl, manageRoot,
//     listManagedRoots, disableMonitoring belong to the browser-node surface being
//     dismantled. Porting them would carry the thing this repo exists to end.
//
//   * `a2a_notifications` IN ITS ENTIRETY — handout ledger, token issue/rotate/
//     revoke, five hooks. It existed so a browser node could hand tokens to a
//     third-party notifier. This server IS the notifier.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HistoryFile, OursClient, OursError } from '@ours.network/sdk';
import { ConversationPageError, DEFAULT_PAGE_LIMIT, projectHistoryPage } from './conversation.js';
import type { PushStore } from './push.js';
import { mediaResponsePolicy } from './media-response.js';
import type { Runtime } from './daemon.js';
import type { MessengerConfig } from './config.js';
import type { BuildInfo } from './build-info.js';
import { type MessengerEvent, MessengerEventBus, toSse } from './events.js';
import { publicEngineError, publicInternalError } from './security.js';
// @ts-ignore -- shared pure-JS core, typed by its sibling .d.mts at this seam.
import { contactDisplayName } from '../shared/roomMessageCore.mjs';

interface ReplyReference {
  readonly wire_id: string;
  readonly sentence?: number;
}

export const API_PREFIX = '/api/';
export const MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PUSH_BODY_BYTES = 16 * 1024;

export interface ApiDeps {
  readonly runtime: Runtime;
  readonly push: PushStore;
  readonly config: MessengerConfig;
  readonly buildInfo: BuildInfo;
  readonly watcherStats: () => Record<string, number>;
  readonly events: MessengerEventBus;
  readonly identityCid: string;
  /** Test seams; production uses the contract defaults. */
  readonly sseHeartbeatMs?: number;
  readonly sseQueueLimit?: number;
  readonly healthTimeoutMs?: number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const bad = (m: string) => new HttpError(400, m);

/** A required string body field. Rejects empty and non-strings alike. */
function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v === '') throw bad(`${key} must be a non-empty string`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v === '') throw bad(`${key}, when present, must be a non-empty string`);
  return v;
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${key}, when present, must be a boolean`);
  return v;
}

function filename(body: Record<string, unknown>): string {
  const value = str(body, 'filename').normalize('NFC');
  if (value.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(value) || value === '.' || value === '..') {
    throw bad('filename must be a safe basename of at most 255 characters');
  }
  return value;
}

function mime(body: Record<string, unknown>): string {
  const value = body.mime === undefined ? 'application/octet-stream' : str(body, 'mime');
  if (value.length > 255 || /[\r\n]/.test(value) || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=[\w!#$&^_.+:-]+)*$/i.test(value)) {
    throw bad('mime must be a safe MIME type with optional token parameters');
  }
  return value;
}

function replyReference(body: Record<string, unknown>): ReplyReference | null {
  const wireId = optStr(body, 'reply_to_wire_id');
  if (!wireId) return null;
  if (body.reply_to_sentence === undefined) return { wire_id: wireId };
  const sentence = Number(body.reply_to_sentence);
  if (!Number.isSafeInteger(sentence) || sentence < 1) throw bad('reply_to_sentence must be a positive integer');
  return { wire_id: wireId, sentence };
}

function outcomeWireId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wireId = (value as Record<string, unknown>).wireId;
  return typeof wireId === 'string' && wireId ? wireId : undefined;
}

function outcomeKind(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * A SEND THAT RODE A CONTACT INTRODUCTION IS NOT A FAILED SEND.
 *
 * `sendMessage` to an identity this one has no contact edge with cannot use the
 * ordinary send transaction — there is no edge to send over. The SDK connects on
 * the way past and carries the text INSIDE the introduction, and reports
 * `{ kind: 'introduced' }`. The message arrives. What it does not get is a wire
 * id, because the introduction carries no slot for one, and everything keyed by a
 * wire id is therefore permanently unavailable for that one message: it is absent
 * from the sender's own conversation history, and no delivered or read receipt can
 * ever name it.
 *
 * THIS ROUTE USED TO THROW ON THE MISSING WIRE ID, which answered a successful
 * send with HTTP 500 and made the client render "the message was not delivered"
 * over a message the peer had already received — the surface asserting a
 * falsehood about a delivered message. The outcome is now reported for what it
 * is: delivered, and untracked. The client keeps the message on screen, does not
 * wait for a canonical row that will never appear, and does not invent a receipt
 * it cannot have.
 *
 * A missing wire id on any OTHER outcome kind is still a fault and still throws:
 * those paths promise a tracked send and a silent downgrade would hide it.
 */
const INTRODUCED = 'introduced';

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_HTTP_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += (c as Buffer).length;
    // A cap, because this process has no auth in front of it and an unbounded
    // body is the cheapest way to take a self-hosted box down. sendFile's
    // base64 path is the largest legitimate body, hence 32 MiB rather than 1.
    if (bytes > maxBytes) throw new HttpError(413, `request body too large (${maxBytes} byte cap)`);
    chunks.push(c as Buffer);
  }
  if (bytes === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw bad('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const pushMutationWindows = new WeakMap<PushStore, Map<string, { startedAt: number; count: number }>>();
const MAX_PUSH_RATE_CLIENTS = 1_024;
function requirePushMutationRate(store: PushStore, req: IncomingMessage, now = Date.now()): void {
  const key = req.socket.remoteAddress ?? 'unknown';
  const windows = pushMutationWindows.get(store) ?? new Map<string, { startedAt: number; count: number }>();
  pushMutationWindows.set(store, windows);
  if (!windows.has(key) && windows.size >= MAX_PUSH_RATE_CLIENTS) {
    for (const [address, window] of windows) {
      if (now - window.startedAt >= 60_000) windows.delete(address);
    }
    if (windows.size >= MAX_PUSH_RATE_CLIENTS) throw new HttpError(429, 'push mutation rate limit exceeded');
  }
  const existing = windows.get(key);
  const current = !existing || now - existing.startedAt >= 60_000 ? { startedAt: now, count: 0 } : existing;
  current.count++;
  windows.set(key, current);
  if (current.count > 30) throw new HttpError(429, 'push mutation rate limit exceeded');
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  const raw = req.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i].toLowerCase() === name) values.push(raw[i + 1]);
  }
  if (values.length !== 0 || raw.length !== 0) return values;
  const fallback = req.headers[name];
  return Array.isArray(fallback) ? fallback : typeof fallback === 'string' ? [fallback] : [];
}

/** Enforce browser mutation intent before body iteration or route dispatch. */
function requireMutationIntent(req: IncomingMessage, expectedOrigin: string): void {
  const contentTypes = rawHeaderValues(req, 'content-type');
  const mediaType = contentTypes.length === 1 ? contentTypes[0].split(';', 1)[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');

  const origins = rawHeaderValues(req, 'origin');
  if (origins.length !== 1 || origins[0] !== expectedOrigin) {
    throw new HttpError(403, 'Request origin is not allowed');
  }

  const csrf = rawHeaderValues(req, 'x-ours-messenger-csrf');
  if (csrf.length !== 1 || csrf[0] !== '1') throw new HttpError(403, 'CSRF header is required');
}

function inlineBase64(body: Record<string, unknown>): string {
  if (Object.hasOwn(body, 'path')) throw bad('path is not accepted; use data_base64');
  const value = body.data_base64;
  if (typeof value !== 'string') throw bad('data_base64 must be a base64 string');
  if (value.length % 4 !== 0) throw bad('data_base64 must be valid canonical base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > MAX_INLINE_FILE_BYTES) {
    throw new HttpError(413, `decoded file exceeds ${MAX_INLINE_FILE_BYTES} byte cap`);
  }
  const contentLength = value.length - padding;
  for (let i = 0; i < contentLength; i++) {
    const code = value.charCodeAt(i);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!valid) throw bad('data_base64 must be valid canonical base64');
  }
  for (let i = contentLength; i < value.length; i++) {
    if (value.charCodeAt(i) !== 61) throw bad('data_base64 must be valid canonical base64');
  }
  return value;
}

function publicIdentity(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object') return {};
  const identity = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  if (typeof identity.cid === 'string') out.cid = identity.cid;
  if (typeof identity.name === 'string') out.name = identity.name;
  if (typeof identity.bio === 'string') out.bio = identity.bio;
  return out;
}

function publicFetchedFiles(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return { files: [] };
  const result = value as Record<string, unknown>;
  const files = Array.isArray(result.files) ? result.files.map((entry) => {
    if (entry === null || typeof entry !== 'object') return {};
    const file = entry as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of [
      'file_id', 'wire_id', 'from', 'filename', 'mime', 'size', 'sha256',
      'status', 'date', 'kind', 'transcription',
    ]) {
      if (file[key] !== undefined) safe[key] = file[key];
    }
    return safe;
  }) : [];
  return {
    files,
    ...(result.mode === 'all_unread' || result.mode === 'selected' ? { mode: result.mode } : {}),
    ...(Array.isArray(result.requested) || result.requested === null ? { requested: result.requested } : {}),
  };
}

/** Preserve the SDK contact name and add the label presentation surfaces should render. */
export function presentContacts(value: Awaited<ReturnType<OursClient['listContacts']>>) {
  return {
    ...value,
    contacts: value.contacts.map((contact) => ({
      ...contact,
      display_name: contactDisplayName(contact.name) as string,
    })),
    pending: value.pending.map((contact) => ({
      ...contact,
      display_name: contactDisplayName(contact.name) as string,
    })),
  };
}

async function resolveContact(client: OursClient, contact: string): Promise<{
  readonly cid: string;
  readonly announcedName: string;
}> {
  const contacts = await client.listContacts();
  const row = contacts.contacts.find((item) => item.container_id === contact || item.name === contact);
  return { cid: row?.container_id ?? contact, announcedName: row?.name ?? contact };
}

function beforeSequence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConversationPageError(`before cursor ${JSON.stringify(raw)} is invalid`);
  }
  return value;
}

async function listAllFiles(client: OursClient, peerCid: string): Promise<HistoryFile[]> {
  const files: HistoryFile[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await client.listFiles({ peer_cid: peerCid, before_seq: before, limit: 200 });
    files.push(...page.items);
    if (page.next_cursor === null) return files;
    before = page.next_cursor;
  }
}

function publicMediaRecord(
  row: HistoryFile,
  identity: { readonly cid: string; readonly name: string },
  version: number,
): Readonly<Record<string, unknown>> {
  const inbound = row.direction === 'in';
  const kind = row.kind === 'voice_message'
    ? 'voice_message'
    : row.mime.toLowerCase().split(';', 1)[0].trim().startsWith('image/') ? 'photo' : 'file';
  return {
    wire_id: row.wire_id,
    contact_id: row.peer.id,
    dir: row.direction,
    sender_id: inbound ? row.peer.id : identity.cid,
    sender_name: inbound ? row.peer.name : identity.name,
    filename: row.filename,
    logical_name: row.filename.normalize('NFC').toLocaleLowerCase('en-US'),
    version,
    mime: row.mime,
    size: row.byte_length,
    sha256: row.sha256,
    date: row.date,
    date_source: 'protocol',
    kind,
    reply_to: row.reply_to,
    available: !inbound || row.inbox_state === 'read',
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('health deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One route table, keyed `METHOD /path`. Path parameters are handled by the small
 * matcher below rather than a router dependency: there is exactly one shape of
 * parameter in this surface (`:contact`, `:wireId`) and a regex router would be
 * more machinery than the thing it routes.
 */
type Handler = (ctx: {
  deps: ApiDeps;
  client: OursClient;
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: URLSearchParams;
  res: ServerResponse;
  req: IncomingMessage;
}) => Promise<unknown>;

function writeSse(res: ServerResponse, event: MessengerEvent, identity?: string): boolean {
  const encoded = toSse(event, identity);
  return res.write(`event: ${encoded.event}\ndata: ${JSON.stringify(encoded.data)}\n\n`);
}

async function serveEvents(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const subscription = deps.events.subscribe(deps.sseQueueLimit ?? 64);
  let closed = false;
  let drainWait: Promise<void> | null = null;
  let releaseDrain: (() => void) | null = null;
  const onDrain = () => {
    const release = releaseDrain;
    releaseDrain = null;
    drainWait = null;
    release?.();
  };
  const waitForDrain = (): Promise<void> => {
    if (drainWait) return drainWait;
    drainWait = new Promise<void>((resolve) => { releaseDrain = resolve; });
    res.once('drain', onDrain);
    return drainWait;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    subscription.close();
    res.removeListener('drain', onDrain);
    const release = releaseDrain;
    releaseDrain = null;
    drainWait = null;
    release?.();
  };
  req.once('close', close);
  res.once('close', close);
  const heartbeat = setInterval(() => {
    // A heartbeat is disposable while the previous write is backpressured. It
    // must share the same drain barrier as event frames or it can become a
    // second unbounded producer in ServerResponse's internal buffer.
    if (!closed && !res.destroyed && !drainWait && !res.write(': keepalive\n\n')) {
      void waitForDrain();
    }
  }, deps.sseHeartbeatMs ?? 20_000);
  heartbeat.unref?.();

  try {
    if (!writeSse(res, { type: 'sync_required', reason: 'connected' }, deps.identityCid)) {
      await waitForDrain();
    }
    while (!closed) {
      const event = await subscription.next();
      if (event === null || closed) break;
      // Do not consume another bus item until Node confirms its HTTP buffer has
      // drained. While blocked, the subscription's fixed-size queue collapses
      // missed details to one overflow sync hint.
      if (drainWait) await drainWait;
      if (closed || res.destroyed) break;
      if (!writeSse(res, event)) await waitForDrain();
    }
  } finally {
    clearInterval(heartbeat);
    close();
    req.removeListener('close', close);
    res.removeListener('close', close);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

/** `undefined` from a handler means "already responded" (used by the raw-bytes route). */
const ROUTES: Record<string, Handler> = {
  // ---- live metadata invalidations (canonical state remains REST/MUFL) ------
  'GET /api/events': async ({ req, res, deps }) => {
    await serveEvents(req, res, deps);
    return undefined;
  },

  // ---- messaging -----------------------------------------------------------
  'POST /api/messages/send': async ({ client, body }) => {
    const reply = replyReference(body);
    const result = await client.sendMessage({
      contact: str(body, 'contact'),
      text: str(body, 'text'),
      reply_to_wire_id: reply?.wire_id,
      reply_to_sentence: reply?.sentence,
    });
    const wireId = outcomeWireId(result);
    if (!wireId) {
      if (outcomeKind(result) !== INTRODUCED) throw new Error('SDK sendMessage returned no wire id');
      // No wire id to record a reply reference against, and none is coming.
      return { wire_id: null, delivery: INTRODUCED };
    }
    return { wire_id: wireId, delivery: 'tracked' };
  },

  'POST /api/messages/send-file': async ({ client, body }) => {
    const dataBase64 = inlineBase64(body);
    const contact = str(body, 'contact');
    const safeFilename = filename(body);
    const safeMime = mime(body);
    const reply = replyReference(body);
    const result = await client.sendFile({
      contact,
      data_base64: dataBase64,
      filename: safeFilename,
      mime: safeMime,
      reply_to_wire_id: reply?.wire_id,
      reply_to_sentence: reply?.sentence,
    });
    return result;
  },

  // ---- conversations: THE NON-CONSUMING READ PATH --------------------------
  'GET /api/conversations/:contact': async ({ client, params }) => {
    const peer = await resolveContact(client, params.contact);
    const history = await client.listHistory({ peer_cid: peer.cid, limit: 200 });
    return {
      messages: projectHistoryPage(params.contact, history, await client.getHistorySummary({ peer_cid: peer.cid }), {
        announcedContact: peer.announcedName,
      }).messages,
    };
  },

  'GET /api/conversations/:contact/page': async ({ client, params, query }) => {
    const contact = params.contact;
    const rawLimit = query.get('limit');
    const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ConversationPageError(`limit must be an integer in 1..200, got ${String(rawLimit)}`);
    }
    const peer = await resolveContact(client, contact);
    const before = beforeSequence(query.get('before') ?? undefined);
    const [history, summary, newest] = await Promise.all([
      client.listHistory({
        peer_cid: peer.cid,
        before_seq: before,
        limit,
      }),
      client.getHistorySummary({ peer_cid: peer.cid }),
      before === undefined ? Promise.resolve(null) : client.listHistory({ peer_cid: peer.cid, limit: 1 }),
    ]);
    const projected = projectHistoryPage(contact, history, summary, { announcedContact: peer.announcedName });
    if (!newest) return projected;
    return {
      ...projected,
      preview: projectHistoryPage(contact, newest, summary, { announcedContact: peer.announcedName }).preview,
    };
  },

  'GET /api/conversations/:contact/receipts': async ({ client, params }) => {
    const peer = await resolveContact(client, params.contact);
    const receipts: Record<string, 'delivered' | 'read'> = {};
    let before: number | undefined;
    for (;;) {
      const page = await client.listHistory({ peer_cid: peer.cid, direction: 'out', before_seq: before, limit: 200 });
      for (const row of page.items) {
        if (row.delivery_state === 'delivered' || row.delivery_state === 'read') {
          receipts[row.wire_id] = row.delivery_state;
        }
      }
      if (page.next_cursor === null) break;
      before = page.next_cursor;
    }
    return { contact: params.contact, receipts };
  },

  // THE HUMAN READ EVENT. The only thing in this server that emits a read receipt.
  'POST /api/conversations/:contact/read': async ({ client, params }) => {
    const peer = await resolveContact(client, params.contact);
    const unread = (await client.listIncomingMessages()).filter((row) => row.from.id === peer.cid);
    let marked = 0;
    for (let offset = 0; offset < unread.length; offset += 200) {
      const wireIds = unread.slice(offset, offset + 200).map((row) => row.wire_id);
      if (wireIds.length === 0) continue;
      const result = await client.getMessages({ wire_ids: wireIds });
      marked += result.messages.length;
    }
    return { contact: params.contact, marked };
  },

  // The non-consuming inbox summary. Metadata only — it does NOT hand over bodies
  // and does NOT mark anything, so it is safe for a frontend in a way getMessages
  // is not.
  'GET /api/messages/incoming': async ({ client }) => client.listIncomingMessages(),

  // ---- contacts ------------------------------------------------------------
  'GET /api/contacts': async ({ client }) => presentContacts(await client.listContacts()),

  // The old browser surface called this `listContactRoots`. It is not a separate
  // operation: roots ride along on the contacts view.
  'GET /api/contacts/roots': async ({ client }) => ({ roots: (await client.listContacts()).roots }),

  'POST /api/contacts/add': async ({ client, body }) =>
    client.addContact({ invite: str(body, 'invite'), name: optStr(body, 'name') }),

  'POST /api/contacts/remove': async ({ client, body }) =>
    client.removeContact({ contact: str(body, 'contact') }),

  'POST /api/contacts/rename': async ({ client, body }) =>
    client.renameContact({ contact: str(body, 'contact'), name: str(body, 'name') }),

  'GET /api/contacts/local-book': async ({ client }) => client.listLocalContactBook(),

  'POST /api/contacts/local-book/policy': async ({ client, body }) =>
    client.setLocalBookPolicy({ expose: optBool(body, 'expose'), auto_accept: optBool(body, 'auto_accept') }),

  // The RESPONDER side of an introduction. There is no initiator-side `introduce`
  // anywhere in the SDK or the daemon — see README, "Surface mapping".
  'POST /api/contacts/introductions': async ({ client, body }) => {
    const action = str(body, 'action');
    if (action !== 'approve' && action !== 'reject') throw bad("action must be 'approve' or 'reject'");
    return client.respondToIntroduction({ contact: str(body, 'contact'), action });
  },

  // ---- invites -------------------------------------------------------------
  'POST /api/invites': async ({ client, body }) => {
    const mode = optStr(body, 'mode');
    if (mode !== undefined && mode !== 'one_time' && mode !== 'public') {
      throw bad("mode, when present, must be 'one_time' or 'public'");
    }
    return client.generateInvite({ name: optStr(body, 'name'), mode });
  },

  // The old browser surface called this `listPendingInvites`.
  'GET /api/invites': async ({ client }) => client.listInvites(),

  'POST /api/invites/revoke': async ({ client, body }) =>
    client.revokeInvite({ invite_id: str(body, 'invite_id') }),

  // ---- identity / profile --------------------------------------------------
  // The old browser surface called the read half `getProfileName`; the name is a
  // field on this result.
  'GET /api/identity': async ({ client }) => publicIdentity(await client.currentIdentity()),

  'GET /api/identities': async ({ client }) => client.listIdentities(),

  'POST /api/identity/bio': async ({ client, body }) => {
    const bio = body.bio;
    if (typeof bio !== 'string') throw bad('bio must be a string (empty clears it)');
    return client.setBio({ bio });
  },

  'POST /api/identity/persona': async ({ client, body }) => {
    const persona = body.persona;
    if (typeof persona !== 'string') throw bad('persona must be a string (empty clears it)');
    return client.setPersona({ persona });
  },

  // ---- files ---------------------------------------------------------------
  'GET /api/files/incoming': async ({ client }) => client.listIncomingFiles(),

  'GET /api/conversations/:contact/files': async ({ client, deps, params }) => {
    const peer = await resolveContact(client, params.contact);
    const files = (await listAllFiles(client, peer.cid)).reverse();
    const versions = new Map<string, number>();
    return {
      contact: params.contact,
      files: files.map((row) => {
        const logicalName = row.filename.normalize('NFC').toLocaleLowerCase('en-US');
        const version = (versions.get(logicalName) ?? 0) + 1;
        versions.set(logicalName, version);
        return publicMediaRecord(row, {
          cid: deps.identityCid,
          name: deps.config.identity,
        }, version);
      }),
    };
  },

  'POST /api/files/fetch': async ({ client, body }) => {
    const ids = body.wire_ids;
    if (ids === undefined || ids === null) throw bad('wire_ids is required for browser file retrieval');
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string' && v !== '')) {
      throw bad('wire_ids, when present, must be an array of non-empty strings');
    }
    const requested = ids as string[];
    const unread = new Set((await client.listIncomingFiles()).map((row) => row.wire_id));
    const pending = requested.filter((wireId) => unread.has(wireId));
    if (pending.length === 0) {
      return publicFetchedFiles({
        files: (await Promise.all(requested.map((wireId) => client.getFileInfo({ wire_id: wireId })))).filter(Boolean),
      });
    }
    return publicFetchedFiles(await client.getFiles({ wire_ids: pending }));
  },

  'GET /api/files/:wireId': async ({ client, params, res }) => {
    const record = await client.getFileInfo({ wire_id: params.wireId });
    if (!record) throw new HttpError(404, 'file not found');
    if (record.direction === 'in' && record.inbox_state !== 'read') {
      throw new HttpError(409, 'file must be explicitly fetched first');
    }
    const bytes = await client.fetchFile(params.wireId);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    });
    res.end(Buffer.from(bytes));
    return undefined;
  },

  'GET /api/media/:wireId': async ({ client, params, res }) => {
    const record = await client.getFileInfo({ wire_id: params.wireId });
    if (!record) throw new HttpError(404, 'media not found');
    if (record.direction === 'in' && record.inbox_state !== 'read') {
      throw new HttpError(409, 'media must be explicitly fetched first');
    }
    const bytes = await client.fetchFile(params.wireId);
    const encodedName = encodeURIComponent(record.filename).replaceAll("'", '%27');
    const policy = mediaResponsePolicy(record.mime);
    res.writeHead(200, {
      'content-type': policy.mime,
      'content-length': String(bytes.byteLength),
      'content-disposition': `${policy.disposition}; filename*=UTF-8''${encodedName}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    });
    res.end(Buffer.from(bytes));
    return undefined;
  },

  // ---- push: the one endpoint that is genuinely new ------------------------
  'GET /api/push/vapid-public-key': async ({ deps }) => ({ ...deps.push.publicConfig }),

  'POST /api/push/subscriptions/ensure': async ({ deps, body, req }) => {
    requirePushMutationRate(deps.push, req);
    const keys = body.keys;
    if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
      throw bad('keys must be an object with p256dh and auth');
    }
    const k = keys as Record<string, unknown>;
    if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') {
      throw bad('keys.p256dh and keys.auth must be strings');
    }
    let saved: ReturnType<PushStore['ensure']>;
    try {
      saved = deps.push.ensure({
        endpoint: str(body, 'endpoint'),
        keys: { p256dh: k.p256dh, auth: k.auth },
        label: optStr(body, 'label'),
        preview: body.preview === undefined ? undefined : str(body, 'preview') as 'full' | 'private',
        bindingId: optStr(body, 'binding_id'),
      });
    } catch {
      throw bad('push subscription is malformed or exceeds configured limits');
    }
    // Endpoint and keys are capabilities; only the opaque server identifier and
    // public VAPID generation metadata may cross back into the browser.
    return {
      status: 'on', binding_id: saved.bindingId, createdAt: saved.createdAt,
      fingerprint: saved.fingerprint, configEpoch: saved.configEpoch, preview: saved.preview,
    };
  },

  'POST /api/push/subscriptions/delete': async ({ deps, body, req }) => {
    requirePushMutationRate(deps.push, req);
    return { removed: deps.push.delete(str(body, 'binding_id')) };
  },

  // ---- state & build info --------------------------------------------------
  'GET /api/state': async ({ deps, client }) => {
    const identity = await client.currentIdentity();
    return {
      identity: publicIdentity(identity),
      runtime: deps.runtime.described,
      watcher: deps.watcherStats(),
      pushSubscriptions: deps.push.bindingCount,
      pushQueue: deps.push.queueStats(),
    };
  },

  'GET /api/build-info': async ({ deps }) => ({ ...deps.buildInfo }),

  'GET /api/healthz': async ({ deps, client, res }) => {
    const unavailable = {
      status: 'unavailable',
      message: 'Service unavailable',
      version: deps.buildInfo.version,
      sha: deps.buildInfo.sha,
    };
    try {
      const current = await within(client.currentIdentity(), deps.healthTimeoutMs ?? 1_500);
      const identity = publicIdentity(current);
      if (identity.cid !== deps.identityCid) throw new Error('bound identity mismatch');
      sendJson(res, 200, {
        status: 'ok',
        version: deps.buildInfo.version,
        sha: deps.buildInfo.sha,
        identityCid: deps.identityCid,
      });
    } catch {
      sendJson(res, 503, unavailable);
    }
    return undefined;
  },
};

/** Split `METHOD /a/:b/c` patterns against a concrete path. */
function match(method: string, pathname: string): { key: string; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  for (const key of Object.keys(ROUTES)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { key, params };
  }
  return null;
}

/** Every route name, for the README table and for tests to count. */
export const ROUTE_NAMES: readonly string[] = Object.keys(ROUTES);

export async function serveApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') requireMutationIntent(req, deps.config.publicOrigin);
    const hit = match(method, url.pathname);
    if (!hit) {
      sendJson(res, 404, { error: { code: 'NO_SUCH_ROUTE', message: 'No such route' } });
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(
      req,
      url.pathname.startsWith('/api/push/') ? MAX_PUSH_BODY_BYTES : MAX_HTTP_BODY_BYTES,
    );
    const out = await ROUTES[hit.key]({
      deps,
      client: deps.runtime.client,
      body,
      params: hit.params,
      query: url.searchParams,
      res,
      req,
    });
    if (out === undefined) return; // handler already wrote the response
    sendJson(res, 200, out);
  } catch (e) {
    // Engine text is untrusted: it may contain local paths, endpoints, or packet
    // content. Only fixed code/message pairs from the central allowlist survive.
    if (isOursError(e)) {
      sendJson(res, 400, { error: publicEngineError(e.code) });
    } else if (e instanceof HttpError) {
      const code = e.status === 403 ? 'FORBIDDEN'
        : e.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE'
          : e.status === 413 ? 'PAYLOAD_TOO_LARGE'
            : e.status === 429 ? 'RATE_LIMITED'
            : 'BAD_REQUEST';
      sendJson(res, e.status, { error: { code, message: e.message } });
    } else if (e instanceof ConversationPageError) {
      sendJson(res, 400, { error: { code: 'BAD_CURSOR', message: 'Invalid conversation cursor' } });
    } else {
      sendJson(res, 500, { error: publicInternalError(e, 'API request') });
    }
  }
}

function isOursError(error: unknown): error is OursError {
  return error instanceof Error && error.name === 'OursError' &&
    'code' in error && typeof (error as Error & { code?: unknown }).code === 'string';
}
