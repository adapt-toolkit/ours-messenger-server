/**
 * Ephemeral browser invalidations. Conversation history in MUFL remains the only
 * canonical state; nothing in this module applies or persists receipt state.
 */

export type SyncReason =
  | 'connected'
  | 'daemon_unavailable'
  | 'daemon_reconnected'
  | 'overflow'
  | 'unknown_event'
  | 'legacy_event';

export type MessengerEvent =
  | { readonly type: 'sync_required'; readonly reason: SyncReason }
  | {
      readonly type: 'message_received';
      readonly contact_id: string;
      readonly wire_id: string;
      readonly date: string;
    }
  | {
      readonly type: 'receipt_received';
      readonly contact_id: string;
      readonly kind: 'delivered' | 'read';
      readonly wire_ids: readonly string[];
      readonly date: string;
    };

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Reduce an SDK notification record to the public metadata contract.
 *
 * Old actors identify message senders only by display name and omit wire IDs;
 * guessing a CID from that name would turn unauthenticated presentation data
 * into an authorization/correlation key. Incomplete old records therefore
 * become a generic snapshot invalidation.
 */
export function normalizeNotification(record: Record<string, unknown>): MessengerEvent {
  if (record.event === 'message_received') {
    if (!nonEmpty(record.sender_id) || !nonEmpty(record.wire_id) || !nonEmpty(record.date)) {
      return { type: 'sync_required', reason: 'legacy_event' };
    }
    return {
      type: 'message_received',
      contact_id: record.sender_id,
      wire_id: record.wire_id,
      date: record.date,
    };
  }

  if (record.event === 'receipt_received') {
    const kind = record.kind;
    const wireIds = record.wire_ids;
    if (
      !nonEmpty(record.sender_id) ||
      (kind !== 'delivered' && kind !== 'read') ||
      !Array.isArray(wireIds) ||
      !wireIds.every(nonEmpty)
    ) {
      return { type: 'sync_required', reason: 'legacy_event' };
    }
    return {
      type: 'receipt_received',
      contact_id: record.sender_id,
      kind,
      wire_ids: [...wireIds],
      // Receipt time is not present in the currently published actor contract.
      // A fixed actor should supply it; observation time is the explicit fallback.
      date: nonEmpty(record.date) ? record.date : new Date().toISOString(),
    };
  }

  return { type: 'sync_required', reason: 'unknown_event' };
}

export interface EventSubscription {
  next(): Promise<MessengerEvent | null>;
  close(): void;
}

interface Subscriber {
  readonly limit: number;
  readonly queue: MessengerEvent[];
  waiting: ((event: MessengerEvent | null) => void) | null;
  closed: boolean;
  overflowed: boolean;
}

/** One process-local, bounded fan-out bus. It is deliberately not a replay log. */
export class MessengerEventBus {
  readonly #subscribers = new Set<Subscriber>();

  get size(): number {
    return this.#subscribers.size;
  }

  subscribe(limit = 64): EventSubscription {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('subscriber queue limit must be a positive integer');
    const sub: Subscriber = { limit, queue: [], waiting: null, closed: false, overflowed: false };
    this.#subscribers.add(sub);

    return {
      next: () => {
        if (sub.queue.length > 0) {
          const event = sub.queue.shift()!;
          if (event.type === 'sync_required' && event.reason === 'overflow') sub.overflowed = false;
          return Promise.resolve(event);
        }
        if (sub.closed) return Promise.resolve(null);
        if (sub.waiting) throw new Error('only one pending next() is allowed per event subscriber');
        return new Promise<MessengerEvent | null>((resolve) => { sub.waiting = resolve; });
      },
      close: () => this.#close(sub),
    };
  }

  publish(event: MessengerEvent): void {
    for (const sub of this.#subscribers) {
      if (sub.closed) continue;
      if (sub.waiting) {
        const resolve = sub.waiting;
        sub.waiting = null;
        resolve(event);
        continue;
      }
      if (sub.overflowed) continue;
      if (sub.queue.length >= sub.limit) {
        sub.queue.splice(0, sub.queue.length, { type: 'sync_required', reason: 'overflow' });
        sub.overflowed = true;
        continue;
      }
      sub.queue.push(event);
    }
  }

  close(): void {
    for (const sub of [...this.#subscribers]) this.#close(sub);
  }

  #close(sub: Subscriber): void {
    if (sub.closed) return;
    sub.closed = true;
    sub.queue.length = 0;
    this.#subscribers.delete(sub);
    const resolve = sub.waiting;
    sub.waiting = null;
    resolve?.(null);
  }
}

export function toSse(event: MessengerEvent, identity?: string): { event: string; data: Record<string, unknown> } {
  if (event.type === 'sync_required') {
    return {
      event: event.type,
      data: { v: 1, reason: event.reason, ...(identity ? { identity } : {}) },
    };
  }
  const { type, ...metadata } = event;
  return { event: type, data: { v: 1, ...metadata } };
}
