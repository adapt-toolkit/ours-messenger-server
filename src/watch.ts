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
//   2. IT IS CONTENT-FREE. The record carries who and when, not what. So the push
//      we build from it cannot leak message text even by accident: there is no
//      text in our hands at this point.
//
// The stream PRIMES AT EOF — a restart does not replay the backlog. That is
// deliberate. Re-pushing every message received while the server was down would
// mean a user who closes their laptop for a week gets a week of notifications at
// once, and none of them are news by then.

import type { OursClient } from '@ours.network/sdk';
import type { PushEvent, PushStore } from './push.js';

/** Events that mean "something arrived for the human". Anything else is not a push. */
const PUSHABLE: Record<string, PushEvent['kind']> = {
  message_received: 'message',
  pending_message: 'message',
  file_received: 'file',
};

export interface WatcherLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface WatcherHandle {
  stop(): Promise<void>;
  /** Counters, for /api/state and for tests to assert against. */
  readonly stats: { pushes: number; events: number; reconnects: number };
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
): WatcherHandle {
  const controller = new AbortController();
  const stats = { pushes: 0, events: 0, reconnects: 0 };
  let backoffMs = 500;

  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const record of client.watchNotifications(identity, { signal: controller.signal })) {
          if (controller.signal.aborted) break;
          stats.events++;
          backoffMs = 500; // a delivered event proves the link; forget the last failure

          const name = typeof record.event === 'string' ? record.event : '';
          const kind = PUSHABLE[name];
          if (!kind) continue;

          const from = typeof record.from === 'string' ? record.from : undefined;
          try {
            const result = await push.send({ kind, from, count: 1 });
            stats.pushes += result.sent;
            if (result.pruned) log.info(`push: pruned ${result.pruned} dead subscription(s)`);
            if (result.failed) log.warn(`push: ${result.failed} subscription(s) failed (kept for retry)`);
          } catch (e) {
            // A PUSH FAILURE MUST NOT KILL THE WATCH. The message is already in the
            // packet and readable over REST; losing the notification is a degraded
            // UX, losing the watcher is a broken one.
            log.warn(`push: send threw: ${(e as Error).message}`);
          }
        }
        // A clean return means the signal fired; the while condition ends it.
      } catch (e) {
        if (controller.signal.aborted) break;
        stats.reconnects++;
        log.warn(`watch: stream ended (${(e as Error).message}); reconnecting in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
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
