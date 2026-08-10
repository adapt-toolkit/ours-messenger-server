// THE REST SURFACE — the messaging half of what the browser calls today, plus
// the one new push-subscription endpoint.
//
// WHAT IS DELIBERATELY ABSENT, because an absence is invisible unless it is written
// down:
//
//   * `getMessages` IS NOT EXPOSED. It is the CONSUMING read: it hands messages to
//     an agent and emits a read receipt on the way past. A frontend polling it would
//     silently tell every peer that a human had read messages nobody had looked at.
//     The frontend's read path is `GET /api/conversations/:contact` (non-consuming)
//     and `POST /api/conversations/:contact/read` when a person actually sees them.
//     The agent path — getMessages, consuming, receipt-on-pull — is UNCHANGED and
//     still reached through ours-mcp by agents. It is simply not this server's.
//
//   * THE CONTROL-PLANE METHODS ARE NOT PORTED. sendControl, manageRoot,
//     listManagedRoots, disableMonitoring belong to the browser-node surface being
//     dismantled. Porting them would carry the thing this repo exists to end.
//
//   * `a2a_notifications` IN ITS ENTIRETY — handout ledger, token issue/rotate/
//     revoke, five hooks. It existed so a browser node could hand tokens to a
//     third-party notifier. This server IS the notifier.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { OursError, type OursClient } from '@ours.network/sdk';
import { ConversationPageError, DEFAULT_PAGE_LIMIT, projectPage } from './conversation.js';
import type { PushStore } from './push.js';
import type { Attachment } from './daemon.js';
import type { MessengerConfig } from './config.js';

export const API_PREFIX = '/api/';

export interface ApiDeps {
  readonly attachment: Attachment;
  readonly push: PushStore;
  readonly config: MessengerConfig;
  readonly buildInfo: { readonly name: string; readonly version: string };
  readonly watcherStats: () => Record<string, number>;
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

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += (c as Buffer).length;
    // A cap, because this process has no auth in front of it and an unbounded
    // body is the cheapest way to take a self-hosted box down. sendFile's
    // base64 path is the largest legitimate body, hence 32 MiB rather than 1.
    if (bytes > 32 * 1024 * 1024) throw new HttpError(413, 'request body too large (32 MiB cap)');
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

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
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
}) => Promise<unknown>;

/** `undefined` from a handler means "already responded" (used by the raw-bytes route). */
const ROUTES: Record<string, Handler> = {
  // ---- messaging -----------------------------------------------------------
  'POST /api/messages/send': async ({ client, body }) =>
    client.sendMessage({
      contact: str(body, 'contact'),
      text: str(body, 'text'),
      reply_to_wire_id: optStr(body, 'reply_to_wire_id'),
      reply_to_sentence: body.reply_to_sentence === undefined ? undefined : Number(body.reply_to_sentence),
    }),

  'POST /api/messages/send-file': async ({ client, body }) =>
    client.sendFile({
      contact: str(body, 'contact'),
      path: optStr(body, 'path'),
      data_base64: optStr(body, 'data_base64'),
      filename: optStr(body, 'filename'),
      mime: optStr(body, 'mime'),
      reply_to_wire_id: optStr(body, 'reply_to_wire_id'),
      reply_to_sentence: body.reply_to_sentence === undefined ? undefined : Number(body.reply_to_sentence),
    }),

  // ---- conversations: THE NON-CONSUMING READ PATH --------------------------
  'GET /api/conversations/:contact': async ({ client, params }) =>
    client.getConversation({ contact: params.contact }),

  'GET /api/conversations/:contact/page': async ({ client, params, query }) => {
    const contact = params.contact;
    const rawLimit = query.get('limit');
    const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
    const before = query.get('before') ?? undefined;
    const [conversation, receipts] = await Promise.all([
      client.getConversation({ contact }),
      client.getReceipts({ contact }),
    ]);
    return projectPage(contact, conversation.messages, receipts, { limit, before });
  },

  'GET /api/conversations/:contact/receipts': async ({ client, params }) =>
    client.getReceipts({ contact: params.contact }),

  // THE HUMAN READ EVENT. The only thing in this server that emits a read receipt.
  'POST /api/conversations/:contact/read': async ({ client, params }) =>
    client.markRead({ contact: params.contact }),

  'POST /api/conversations/policy': async ({ client, body }) => {
    const keep = optBool(body, 'keep_history');
    if (keep === undefined) throw bad('keep_history must be a boolean');
    const result = await client.setConversationPolicy({ keep_history: keep });
    // Same reasoning as bindIdentity: enabling history adds a capability that
    // existing contacts do not learn until our next send.
    const readvertised = keep ? await client.readvertiseOnUpgrade() : null;
    return { ...result, readvertised };
  },

  // The non-consuming inbox summary. Metadata only — it does NOT hand over bodies
  // and does NOT mark anything, so it is safe for a frontend in a way getMessages
  // is not.
  'GET /api/messages/incoming': async ({ client }) => client.listIncomingMessages(),

  // ---- contacts ------------------------------------------------------------
  'GET /api/contacts': async ({ client }) => client.listContacts(),

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
  'GET /api/identity': async ({ client }) => client.currentIdentity(),

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

  'POST /api/files/fetch': async ({ client, body }) => {
    const ids = body.wire_ids;
    if (ids === undefined || ids === null) return client.getFiles(undefined);
    if (!Array.isArray(ids) || !ids.every((v) => typeof v === 'string' && v !== '')) {
      throw bad('wire_ids, when present, must be an array of non-empty strings');
    }
    return client.getFiles({ wire_ids: ids as string[] });
  },

  // NOTE THE IDENTIFIER SPLIT, which reads as a typo and gets "fixed": deferFiles
  // takes FILE_IDs, which are NUMBERS, while getFiles selects by WIRE_IDs, which
  // are strings. Two different identifiers on the same file. JSON from a browser
  // will happily carry "3" where 3 is meant, and the engine keys on
  // `$file_ids -> ids: int[]`, so a string would select nothing and report
  // `deferred: 0` — a silent no-op that looks like a successful retry.
  'POST /api/files/defer': async ({ client, body }) => {
    const ids = body.file_ids;
    if (!Array.isArray(ids) || !ids.every((v) => Number.isInteger(v))) {
      throw bad('file_ids must be an array of integers (not strings)');
    }
    return client.deferFiles({ file_ids: ids as number[] });
  },

  'GET /api/files/:wireId': async ({ client, params, res }) => {
    const bytes = await client.fetchFile(params.wireId);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    });
    res.end(Buffer.from(bytes));
    return undefined;
  },

  // ---- push: the one endpoint that is genuinely new ------------------------
  'GET /api/push/vapid-public-key': async ({ deps }) => ({ publicKey: deps.push.publicKey }),

  'POST /api/push/subscribe': async ({ deps, body }) => {
    const keys = body.keys;
    if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
      throw bad('keys must be an object with p256dh and auth');
    }
    const k = keys as Record<string, unknown>;
    if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') {
      throw bad('keys.p256dh and keys.auth must be strings');
    }
    const saved = deps.push.subscribe({
      endpoint: str(body, 'endpoint'),
      keys: { p256dh: k.p256dh, auth: k.auth },
      label: optStr(body, 'label'),
    });
    // The endpoint is echoed but the keys are not: they are the subscription's
    // credential, and there is no reason for a response to repeat one.
    return { subscribed: true, endpoint: saved.endpoint, createdAt: saved.createdAt };
  },

  'POST /api/push/unsubscribe': async ({ deps, body }) => ({
    removed: deps.push.unsubscribe(str(body, 'endpoint')),
  }),

  // ---- state & build info --------------------------------------------------
  'GET /api/state': async ({ deps, client }) => {
    const [identity, daemon] = await Promise.all([client.currentIdentity(), client.version()]);
    return {
      identity,
      keepHistory: deps.config.keepHistory,
      daemon,
      // The REDACTED selection. `describeDaemonConfig` reports token PROVENANCE,
      // never the token — this route is unauthenticated like every other.
      selection: deps.attachment.described,
      watcher: deps.watcherStats(),
      pushSubscriptions: deps.push.list().length,
    };
  },

  'GET /api/build-info': async ({ deps }) => ({
    ...deps.buildInfo,
    node: process.version,
    pid: process.pid,
  }),
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
  const hit = match(req.method ?? 'GET', url.pathname);

  if (!hit) {
    sendJson(res, 404, { error: { code: 'NO_SUCH_ROUTE', message: `no route for ${req.method} ${url.pathname}` } });
    return;
  }

  try {
    const body = req.method === 'GET' ? {} : await readJsonBody(req);
    const out = await ROUTES[hit.key]({
      deps,
      client: deps.attachment.client,
      body,
      params: hit.params,
      query: url.searchParams,
      res,
    });
    if (out === undefined) return; // handler already wrote the response
    sendJson(res, 200, out);
  } catch (e) {
    // AN ENGINE ERROR KEEPS ITS OWN CODE AND MESSAGE. `OursError.message` is
    // byte-identical to what the operation raised, and a frontend showing a user
    // "the identity is bound elsewhere" is showing them the truth. Flattening
    // everything to 500 would throw that away.
    if (e instanceof OursError) {
      sendJson(res, 400, { error: { code: e.code, message: e.message } });
    } else if (e instanceof HttpError) {
      sendJson(res, e.status, { error: { code: 'BAD_REQUEST', message: e.message } });
    } else if (e instanceof ConversationPageError) {
      sendJson(res, 400, { error: { code: 'BAD_CURSOR', message: e.message } });
    } else {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (e as Error).message } });
    }
  }
}
