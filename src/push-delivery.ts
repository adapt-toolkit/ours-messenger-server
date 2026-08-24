import type { OursClient } from '@ours.network/sdk';
import type { PushEvent, PushJob, PushKind, PushStore } from './push.js';
import { reportFailure } from './security.js';
// @ts-ignore -- shared pure-JS core, typed by its sibling .d.mts at this seam.
import { contactDisplayName, contactMessagePreview } from '../shared/roomMessageCore.mjs';

export interface PushDeliveryLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface PushDeliveryOptions {
  readonly store: PushStore;
  readonly client: Partial<Pick<OursClient, 'getHistoryItem' | 'getFileInfo'>>;
  readonly identityCid: string;
  readonly log: PushDeliveryLog;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly project?: (job: PushJob) => Promise<PushEvent>;
  readonly isForeground?: () => boolean;
  readonly foregroundBindingIds?: () => ReadonlySet<string>;
  readonly autoStart?: boolean;
}

export interface PushDeliveryStats {
  queued: number;
  sent: number;
  pruned: number;
  retried: number;
  dropped: number;
  suppressed: number;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function notificationKind(record: Record<string, unknown>): PushKind | null {
  if (record.event === 'message_received') return 'message';
  if (record.event !== 'file_received') return null;
  if (record.kind === 'voice_message' || record.kind === 'voice') return 'voice';
  if (record.kind === 'photo') return 'photo';
  return 'file';
}

async function projectFromSdk(
  client: PushDeliveryOptions['client'],
  job: PushJob,
): Promise<PushEvent> {
  const url = `/chats/${encodeURIComponent(job.contactId)}#chat-message-${encodeURIComponent(job.wireId)}`;
  if (job.kind === 'message') {
    if (!client.getHistoryItem) throw new Error('message projection is unavailable');
    const message = await client.getHistoryItem({ wire_id: job.wireId });
    if (!message || message.direction !== 'in' || message.peer.id !== job.contactId) {
      throw new Error('canonical message projection is not ready');
    }
    const announcedSender = job.senderName ?? message.peer.name ?? 'New message';
    return {
      v: 1, kind: 'message', title: contactDisplayName(announcedSender) as string,
      body: contactMessagePreview(announcedSender, message.text) as string,
      contact_id: job.contactId, wire_id: job.wireId, url,
    };
  }

  if (!client.getFileInfo) throw new Error('file projection is unavailable');
  const file = await client.getFileInfo({ wire_id: job.wireId });
  if (!file || file.direction !== 'in' || file.peer.id !== job.contactId) {
    throw new Error('canonical file projection is not ready');
  }
  const kind: PushKind = file.kind === 'voice_message'
    ? 'voice' : file.mime.toLowerCase().startsWith('image/') ? 'photo' : 'file';
  const label = kind === 'voice' ? 'Voice message' : kind === 'photo' ? 'Photo' : 'File';
  return {
    v: 1, kind, title: contactDisplayName(file.from.name || job.senderName || label) as string,
    body: `${label}: ${file.filename}`,
    contact_id: job.contactId, wire_id: job.wireId, url,
  };
}

/**
 * Durable Web Push delivery derived only from authenticated SDK notification
 * records. Jobs contain correlation metadata, never message/file content; each
 * attempt re-reads the canonical SDK projection before encrypted delivery.
 */
export class PushDeliveryQueue {
  readonly stats: PushDeliveryStats = { queued: 0, sent: 0, pruned: 0, retried: 0, dropped: 0, suppressed: 0 };
  private readonly store: PushStore;
  private readonly client: PushDeliveryOptions['client'];
  private readonly identityCid: string;
  private readonly log: PushDeliveryLog;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly project: (job: PushJob) => Promise<PushEvent>;
  private readonly automatic: boolean;
  private readonly isForeground: () => boolean;
  private readonly foregroundBindingIds: () => ReadonlySet<string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  private stopped = false;

  constructor(options: PushDeliveryOptions) {
    this.store = options.store;
    this.client = options.client;
    this.identityCid = options.identityCid;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.project = options.project ?? ((job) => projectFromSdk(this.client, job));
    this.isForeground = options.isForeground ?? (() => false);
    this.foregroundBindingIds = options.foregroundBindingIds ?? (() => new Set());
    this.automatic = options.autoStart !== false;
    if (this.automatic) this.schedule(0);
  }

  enqueue(record: Record<string, unknown>): boolean {
    if (!nonEmpty(record.sender_id) || !nonEmpty(record.wire_id)) return false;
    const kind = notificationKind(record);
    if (!kind || !this.store.hasBindings()) return false;
    const queued = this.store.enqueueJob({
      wireId: record.wire_id,
      kind,
      contactId: record.sender_id,
      senderName: nonEmpty(record.sender_name) ? record.sender_name : undefined,
    }, this.now());
    if (queued) {
      this.stats.queued++;
      const jobId = `${this.identityCid}:${record.wire_id}:${kind}`;
      const suppressedBindings = this.store.suppressBindings(jobId, this.foregroundBindingIds(), this.now());
      if (suppressedBindings > 0) {
        this.stats.suppressed += suppressedBindings;
        this.log.info(`push queue: suppressed ${suppressedBindings} foreground binding(s) kind=${kind} wire=${record.wire_id}`);
        if (this.store.queueStats().pending === 0) return true;
      } else if (this.isForeground() && this.store.suppressJob(jobId, this.now())) {
        this.stats.suppressed++;
        this.log.info(`push queue: suppressed foreground kind=${kind} wire=${record.wire_id}`);
        return true;
      }
      this.log.info(`push queue: queued kind=${kind} wire=${record.wire_id} depth=${this.store.queueStats().pending}`);
      if (this.automatic) this.schedule(0);
    }
    return queued;
  }

  async drainDue(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainOnce().finally(() => {
      this.draining = undefined;
      if (this.automatic && !this.stopped) {
        const delay = this.store.nextJobDelay(this.now());
        if (delay !== null) this.schedule(Math.min(delay, 60_000));
      }
    });
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    for (const job of this.store.dueJobs(this.now())) {
      if (this.stopped) return;
      let event: PushEvent;
      try {
        event = await this.project(job);
      } catch (error) {
        const retried = this.store.retryJob(job.id, this.now(), this.random);
        if (retried) this.stats.retried++;
        else this.stats.dropped++;
        reportFailure(this.log.warn, `push projection ${retried ? 'retry' : 'drop'} wire=${job.wireId}`, error);
        continue;
      }
      try {
        const outcome = await this.store.dispatchJob(job.id, event, this.now(), this.random);
        this.stats.sent += outcome.sent;
        this.stats.pruned += outcome.pruned;
        this.stats.retried += outcome.retried;
        this.stats.dropped += outcome.dropped;
        this.log.info(
          `push delivery: wire=${job.wireId} sent=${outcome.sent} pruned=${outcome.pruned} `
          + `retried=${outcome.retried} dropped=${outcome.dropped} depth=${this.store.queueStats().pending}`,
        );
      } catch (error) {
        const retried = this.store.retryJob(job.id, this.now(), this.random);
        if (retried) this.stats.retried++;
        else this.stats.dropped++;
        reportFailure(this.log.warn, `push dispatch ${retried ? 'retry' : 'drop'} wire=${job.wireId}`, error);
      }
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drainDue();
    }, Math.max(0, delay));
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.draining;
  }
}
