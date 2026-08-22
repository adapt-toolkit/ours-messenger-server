// THE PUSH TRIGGER.
//
// We watch the daemon's own content-free notification stream and turn an arrival
// into a WebPush. Two properties of that stream are why this is the right source
// rather than a poll:
//
//   1. IT IS NON-CONSUMING. Watching does not read the inbox, does not mark
//      anything, and emits no receipt. A server that instead polled `getMessages`
//      to find out whether to push would send a READ RECEIPT FOR EVERY MESSAGE the
//      instant it arrived — before any human had seen it, and while their phone
//      was still in their pocket. That is the exact hazard this whole design
//      exists to avoid, and a push loop is the most natural place to reintroduce
//      it, which is why the warning lives here and not only in the README.
//
//   2. IT IS CONTENT-FREE. The record carries stable authenticated correlation
//      metadata, never bodies. For an explicitly subscribed owner we use that
//      correlation to read the canonical conversation/file projection and build
//      one encrypted Web Push payload. SSE remains metadata-only.
//
// The stream PRIMES AT EOF — a restart does not replay the backlog. That is
// deliberate. Re-pushing every message received while the server was down would
// mean a user who closes their laptop for a week gets a week of notifications at
// once, and none of them are news by then.

import type { OursClient } from '@ours.network/sdk';
import { MessengerEventBus, normalizeNotification } from './events.js';
import type { PushEvent, PushStore } from './push.js';
import { reportFailure } from './security.js';
import type { PushDeliveryQueue } from './push-delivery.js';
// @ts-ignore -- shared pure-JS core, typed by its sibling .d.mts at this seam.
import { contactMessagePreview } from '../shared/roomMessageCore.mjs';

export interface WatcherLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface WatcherHandle {
  stop(): Promise<void>;
  /** Counters, for /api/state and for tests to assert against. */
  readonly stats: { pushes: number; events: number; reconnects: number };
}

export interface WatcherOptions {
  /** Test seam; production uses the SDK generator. */
  readonly watch?: (identity: string, signal: AbortSignal) => AsyncIterable<Record<string, unknown>>;
  /** Test seam for deterministic reconnect/backoff checks. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A successful probe defines "reattached" before the sync broadcast. */
  readonly probe?: () => Promise<unknown>;
  /** Durable production delivery; direct PushStore.send remains a test seam. */
  readonly delivery?: Pick<PushDeliveryQueue, 'enqueue'>;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

async function pushEventFor(client: OursClient, record: Record<string, unknown>): Promise<PushEvent | null> {
  if (!nonEmpty(record.sender_id) || !nonEmpty(record.wire_id)) return null;
  const contactId = record.sender_id;
  const wireId = record.wire_id;
  const url = `/chats/${encodeURIComponent(contactId)}`;

  if (record.event === 'message_received') {
    let message: Awaited<ReturnType<OursClient['getHistoryItem']>> | undefined;
    for (const delay of [0, 50, 200, 500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      message = await client.getHistoryItem({ wire_id: wireId }) ?? undefined;
      if (message?.direction !== 'in' || message.peer.id !== contactId) message = undefined;
      if (message) break;
    }
    if (!message) throw new Error('canonical message was not available for push projection');
    const sender = nonEmpty(record.sender_name) ? record.sender_name : 'New message';
    // A COWORK ROOM RELAYS SIGNED JSON, and a notification is the one surface a
    // user cannot scroll past. `contactMessagePreview` is the same recogniser the
    // conversation renders with, so an unknown-but-additive kind degrades to its
    // readable text here exactly as it does in the chat (INV-R6), and the author
    // identity is never read for display (INV-R3). An ordinary contact's text is
    // returned untouched.
    const body = contactMessagePreview(sender, message.text) as string;
    return { v: 1, kind: 'message', title: sender, body, contact_id: contactId, wire_id: wireId, url };
  }

  if (record.event === 'file_received') {
    let file: Awaited<ReturnType<OursClient['getFileInfo']>> | undefined;
    for (const delay of [0, 50, 200, 500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      file = await client.getFileInfo({ wire_id: wireId }) ?? undefined;
      if (file?.direction !== 'in' || file.peer.id !== contactId) file = undefined;
      if (file) break;
    }
    if (!file) throw new Error('canonical file metadata was not available for push projection');
    const kind: PushEvent['kind'] = file.kind === 'voice_message'
      ? 'voice'
      : file.mime.toLowerCase().startsWith('image/') ? 'photo' : 'file';
    const label = kind === 'voice' ? 'Voice message' : kind === 'photo' ? 'Photo' : 'File';
    return {
      v: 1,
      kind,
      title: file.from.name || label,
      body: `${label}: ${file.filename}`,
      contact_id: contactId,
      wire_id: wireId,
      url,
    };
  }

  return null;
}

// ============================================================================
// RECONCILE — why a reconnect is not enough on its own
// ============================================================================
// `client.watchNotifications(name, { signal })` is called with NO `since`, so the
// SDK defaults it to "tip" and the daemon answers a tip request with the current
// cursor and ZERO events. That is right for a cold start and WRONG for a
// reconnect: `startWatcher`'s outer loop re-enters the same call after every
// transient failure, so each reconnect jumps to the tip and silently discards
// every notification that arrived while the stream was down. Not deferred —
// discarded. The messages are fine (they are in the packet and readable over
// REST); only the notification is lost, which is exactly the "it was there when
// I opened the app, but nobody told me" report.
//
// Measured on the live messenger: 16 reconnects in ~7.5 hours on an idle fleet.
//
// PASSING THE CURSOR IS NOT AVAILABLE TO US. `r.cursor` lives inside the SDK
// generator's own loop and is never yielded; the records carry no cursor field.
// The messenger cannot remember what it was never told. (Surfacing it is a
// worthwhile ours-sdk change, but it is a public API change, and it would still
// only cover gaps THIS process was awake for.)
//
// So we reconcile from canonical state instead, which is strictly stronger: it
// also recovers notifications lost while the messenger process was entirely
// DOWN — this one has died twice in 24h on a 2 GiB WASM ceiling — a window no
// cursor held in memory could ever have covered.
//
// *** THE DEDUPE IN PushStore.enqueueJob IS LOAD-BEARING FOR CORRECTNESS. ***
// It keys on `${identityCid}:${wireId}:${kind}` and returns false for a job that
// already exists, and terminal jobs are RETAINED for TERMINAL_RETENTION_MS (7
// days) rather than deleted. That is the ONLY thing standing between this
// reconcile and re-pushing every unread message on every reconnect — 16 times a
// night, on the same wire_ids. Deliberately no second guard here: two
// overlapping dedupes would let someone weaken either one and still see green.
// If you are changing that key, or shortening that retention, this is the caller
// that breaks, and it breaks by spamming a human's phone.
async function reconcileMissed(
  client: OursClient,
  delivery: Pick<PushDeliveryQueue, 'enqueue'>,
  log: WatcherLog,
): Promise<number> {
  let queued = 0;
  // Unread is the right filter: a message the owner has already read needs no
  // notification, and anything still unread is something they were plausibly
  // never told about.
  const messages = await client.listIncomingMessages();
  for (const m of messages) {
    if (m.status !== 'unread') continue;
    if (delivery.enqueue({
      event: 'message_received',
      sender_id: m.from.id,
      sender_name: m.from.name,
      wire_id: m.wire_id,
    })) queued++;
  }
  const files = await client.listIncomingFiles();
  for (const f of files) {
    if (f.status !== 'unread') continue;
    if (delivery.enqueue({
      event: 'file_received',
      sender_id: f.from.id,
      sender_name: f.from.name,
      wire_id: f.wire_id,
      // notificationKind() reads `kind` to split voice from file; passing the
      // raw value keeps that decision in one place rather than duplicating it
      // here, and matches what the live daemon record carries.
      kind: f.kind,
    })) queued++;
  }
  if (queued > 0) log.info(`watch reconcile: queued ${queued} push(es) for notifications missed while disconnected`);
  return queued;
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Watch `identity` forever, pushing on each arrival, until `stop()`.
 *
 * RECONNECTION IS NOT OPTIONAL. `watchNotifications` long-polls, so a daemon
 * restart, a proxy timeout or a dropped socket ends the generator with a throw
 * rather than a clean return. Without the outer loop the server keeps serving REST
 * and silently stops pushing — the failure mode that looks exactly like "nobody
 * messaged me".
 */
export function startWatcher(
  client: OursClient,
  identity: string,
  push: PushStore,
  log: WatcherLog,
  events: MessengerEventBus,
  options: WatcherOptions = {},
): WatcherHandle {
  const controller = new AbortController();
  const stats = { pushes: 0, events: 0, reconnects: 0 };
  let backoffMs = 500;
  let reconnecting = false;
  const watch = options.watch ?? ((name, signal) => client.watchNotifications(name, { signal }));
  const wait = options.wait ?? abortableWait;
  const probe = options.probe ?? (() => client.version());

  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        if (reconnecting) {
          await probe();
          if (controller.signal.aborted) break;
          events.publish({ type: 'sync_required', reason: 'daemon_reconnected' });
          reconnecting = false;
        }
        const upstream = watch(identity, controller.signal);
        // Before consuming the (tip-primed) stream, recover anything it will not
        // replay. This runs on the FIRST pass too, not only on reconnects: the
        // gap a cold start leaves is the messenger having been down, which is
        // the widest gap of all and the one a cursor could never have closed.
        // Failure here must not cost us the watch — an unqueued push is degraded
        // UX, a dead watcher is a broken one, which is the same rule the push
        // block below follows.
        if (options.delivery) {
          try {
            await reconcileMissed(client, options.delivery, log);
          } catch (e) {
            reportFailure(log.warn, 'watch reconcile', e);
          }
        }
        for await (const record of upstream) {
          if (controller.signal.aborted) break;
          stats.events++;
          backoffMs = 500; // a delivered event proves the link; forget the last failure

          // Publish a closed, metadata-only shape. The bridge never applies the
          // event to history; browsers recover truth from REST.
          events.publish(normalizeNotification(record));

          try {
            // Persist the correlation job before any best-effort media index
            // convergence. A temporarily unavailable canonical file projection
            // must become a durable push retry, not a lost notification.
            if (options.delivery) options.delivery.enqueue(record);
            if (options.delivery) continue;
            const event = await pushEventFor(client, record);
            if (!event) continue;
            const result = await push.send(event);
            stats.pushes += result.sent;
            if (result.pruned) log.info(`push: pruned ${result.pruned} dead subscription(s)`);
            if (result.failed) {
              log.warn(`push: ${result.failed} subscription(s) failed (kept for retry)`);
            }
          } catch (e) {
            // A PUSH FAILURE MUST NOT KILL THE WATCH. The message is already in the
            // packet and readable over REST; losing the notification is a degraded
            // UX, losing the watcher is a broken one.
            reportFailure(log.warn, 'push send', e);
          }
        }
        if (!controller.signal.aborted) throw new Error('notification stream ended');
      } catch (e) {
        if (controller.signal.aborted) break;
        stats.reconnects++;
        reconnecting = true;
        events.publish({ type: 'sync_required', reason: 'daemon_unavailable' });
        reportFailure(log.warn, `watch stream; reconnecting in ${backoffMs}ms`, e);
        await wait(backoffMs, controller.signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  })();

  return {
    stats,
    async stop() {
      controller.abort();
      await loop;
    },
  };
}
