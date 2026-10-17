// Push is driven only by the daemon's durable, content-free notification log.
// Messenger checkpoints that source independently from its pending delivery
// work. A fresh installation primes at EOF; after that every restart resumes
// from the last page committed after durable admission. It never scans unread
// message history and therefore cannot turn an old inbox into a push storm.

import { createHash } from 'node:crypto';
import type { OursClient } from '@ours.network/sdk';
import { MessengerEventBus, normalizeNotification } from './events.js';
import type { PushStore } from './push.js';
import { reportFailure } from './security.js';
import type { PushDeliveryQueue } from './push-delivery.js';

export interface NotificationPage {
  readonly cursor: number;
  readonly events: ReadonlyArray<Record<string, unknown>>;
}

export interface WatcherLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface WatcherStats {
  pushes: number;
  events: number;
  reconnects: number;
  cursorCommits: number;
  saturationEvents: number;
}

export interface WatcherHandle {
  stop(): Promise<void>;
  readonly stats: WatcherStats;
}

export interface WatcherOptions {
  /** One authenticated long-poll page. Production supplies Runtime's reader. */
  readonly readPage: (
    identity: string,
    since: number | 'tip',
    signal: AbortSignal,
  ) => Promise<NotificationPage>;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly probe?: () => Promise<unknown>;
  readonly delivery: Pick<PushDeliveryQueue, 'admit'>;
}

function pageDigest(events: ReadonlyArray<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('base64url');
}

/**
 * Admit a complete source page before committing its cursor. Jobs are persisted
 * one by one, so a crash before the cursor write replays the page and converges
 * through pending/tombstone dedupe. Saturation deliberately leaves the cursor
 * behind the refused event: the next poll retries it after delivery frees room.
 */
export function applyNotificationPage(
  page: NotificationPage,
  push: PushStore,
  delivery: Pick<PushDeliveryQueue, 'admit'>,
  events: MessengerEventBus,
  stats: WatcherStats,
  log: WatcherLog,
): boolean {
  if (!Number.isSafeInteger(page.cursor) || page.cursor < 0 || !Array.isArray(page.events)) {
    throw new Error('daemon notification page is malformed');
  }
  const fromCursor = push.notificationCursor;
  // A fresh store asks the daemon for `tip`, whose contract is an empty prime
  // page. Refuse an unexpected backlog so startup can never become an unread-
  // history-style bulk replay through a malformed reader.
  if (fromCursor === null) {
    if (page.events.length > 0) throw new Error('daemon notification tip page unexpectedly contained events');
    push.commitNotificationCursor(page.cursor);
    stats.cursorCommits++;
    return true;
  }

  let progress = push.notificationPageProgress;
  if (progress) {
    // The daemon reads through current EOF, so a page can grow while capacity is
    // being freed. Its original prefix must remain byte-log stable; finish only
    // that prefix, commit its end cursor, then fetch the appended suffix.
    const prefix = page.events.slice(0, progress.eventCount);
    if (progress.fromCursor !== fromCursor || page.cursor < progress.cursor
      || page.events.length < progress.eventCount || pageDigest(prefix) !== progress.digest) {
      throw new Error('daemon notification page changed while a checkpoint was in progress');
    }
  } else {
    progress = push.beginNotificationPage({
      fromCursor, cursor: page.cursor, eventCount: page.events.length, digest: pageDigest(page.events),
    });
  }

  for (let index = progress.nextIndex; index < progress.eventCount; index++) {
    const record = page.events[index];
    const admission = delivery.admit(record, index + 1);
    if (admission.status === 'saturated') {
      // Pin the exact refused boundary even for a test delivery seam that does
      // not itself persist the shared store.
      push.checkpointNotificationPage();
      stats.saturationEvents++;
      log.warn(`event=push_cursor_blocked status=saturated source_cursor=${page.cursor}`);
      return false;
    }
    stats.events++;
    // The bridge remains metadata-only. Browser clients recover canonical state
    // from REST; this event never consumes or mutates inbox history.
    events.publish(normalizeNotification(record));
    if (!admission.checkpointed) push.advanceNotificationPage(index + 1);
  }
  push.commitNotificationPage();
  stats.cursorCommits++;
  return true;
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

export function startWatcher(
  client: OursClient,
  identity: string,
  push: PushStore,
  log: WatcherLog,
  events: MessengerEventBus,
  options: WatcherOptions,
): WatcherHandle {
  const controller = new AbortController();
  const stats: WatcherStats = { pushes: 0, events: 0, reconnects: 0, cursorCommits: 0, saturationEvents: 0 };
  let backoffMs = 500;
  let reconnecting = false;
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
        const since = push.notificationCursor ?? 'tip';
        const page = await options.readPage(identity, since, controller.signal);
        if (controller.signal.aborted) break;
        const committed = applyNotificationPage(page, push, options.delivery, events, stats, log);
        if (!committed) {
          await wait(backoffMs, controller.signal);
          backoffMs = Math.min(backoffMs * 2, 30_000);
          continue;
        }
        backoffMs = 500;
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

export interface ResourceObserverHandle {
  readonly ready: Promise<void>;
  readonly healthy: boolean;
  readonly generation: string | undefined;
  stop(): Promise<void>;
}

/** Independent from durable push observation: neither notification long-poll
 * success nor browser keepalives certify this committed resource source. SDK
 * resourceEvents owns its opening and six-second producer-coverage deadlines. */
export function startResourceObserver(
  client: Pick<OursClient, 'resourceEvents'>,
  identity: string,
  callbacks: {
    committed(frame: import('@ours.network/sdk').IdentityResourceFrame): void;
    failed(error: Error): void;
  },
): ResourceObserverHandle {
  const controller = new AbortController();
  let healthy = false;
  let failed = false;
  let lastCoverage = 0;
  let generation: string | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Ownership may be disposed before anyone awaits startup. The caller still
  // receives the original rejection; this prevents an unhandled orphan promise.
  void ready.catch(() => {});
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    healthy = false;
    if (!readySettled) { readySettled = true; readyReject(error); }
    if (!controller.signal.aborted) callbacks.failed(error);
  };
  const loop = (async () => {
    try {
      for await (const frame of client.resourceEvents(identity, { signal: controller.signal })) {
        if (controller.signal.aborted) break;
        if (frame.kind === 'resync' || (generation !== undefined && generation !== frame.producerGeneration)) {
          throw new Error('resource source continuity lost');
        }
        lastCoverage = Date.now();
        if (frame.kind === 'ready') {
          generation = frame.producerGeneration;
          healthy = true;
          if (!readySettled) { readySettled = true; readyResolve(); }
        }
        callbacks.committed(frame);
      }
      if (!controller.signal.aborted) fail(new Error('resource source ended'));
    } catch (error) {
      fail(error instanceof Error ? error : new Error('resource source failed'));
    } finally { healthy = false; }
  })();
  return { ready, get healthy() {
      if (healthy && Date.now() - lastCoverage >= 6_000) {
        fail(new Error('resource source coverage expired'));
        controller.abort();
      }
      return healthy;
    }, get generation() { return generation; },
    async stop() {
      healthy = false;
      controller.abort();
      if (!readySettled) { readySettled = true; readyReject(new Error('resource source aborted')); }
      await loop;
    },
  };
}
