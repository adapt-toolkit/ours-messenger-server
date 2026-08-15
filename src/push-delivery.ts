import type { OursClient } from '@ours.network/sdk';
import type { PushEvent, PushJob, PushKind, PushStore } from './push.js';
import { reportFailure } from './security.js';

export interface PushDeliveryLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface PushDeliveryOptions {
  readonly store: PushStore;
  readonly client: Partial<Pick<OursClient, 'getConversation' | 'listIncomingFiles'>>;
  readonly identityCid: string;
  readonly log: PushDeliveryLog;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly project?: (job: PushJob) => Promise<PushEvent>;
  readonly autoStart?: boolean;
}

export interface PushDeliveryStats {
  queued: number;
  sent: number;
  pruned: number;
  retried: number;
  dropped: number;
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
  const url = `/chats/${encodeURIComponent(job.contactId)}`;
  if (job.kind === 'message') {
    if (!client.getConversation) throw new Error('message projection is unavailable');
    const conversation = await client.getConversation({ contact: job.contactId });
    const message = conversation.messages.find((row) => row.wire_id === job.wireId && row.dir === 'in');
    if (!message) throw new Error('canonical message projection is not ready');
    return {
      v: 1, kind: 'message', title: job.senderName ?? 'New message', body: message.text,
      contact_id: job.contactId, wire_id: job.wireId, url,
    };
  }

  if (!client.listIncomingFiles) throw new Error('file projection is unavailable');
  const files = await client.listIncomingFiles();
  const file = files.find((row) => row.wire_id === job.wireId && row.from.id === job.contactId);
  if (!file) throw new Error('canonical file projection is not ready');
  const kind: PushKind = file.kind === 'voice_message'
    ? 'voice' : file.mime.toLowerCase().startsWith('image/') ? 'photo' : 'file';
  const label = kind === 'voice' ? 'Voice message' : kind === 'photo' ? 'Photo' : 'File';
  return {
    v: 1, kind, title: file.from.name || job.senderName || label, body: `${label}: ${file.filename}`,
    contact_id: job.contactId, wire_id: job.wireId, url,
  };
}

/**
 * Durable Web Push delivery derived only from authenticated SDK notification
 * records. Jobs contain correlation metadata, never message/file content; each
 * attempt re-reads the canonical SDK projection before encrypted delivery.
 */
export class PushDeliveryQueue {
  readonly stats: PushDeliveryStats = { queued: 0, sent: 0, pruned: 0, retried: 0, dropped: 0 };
  private readonly store: PushStore;
  private readonly client: PushDeliveryOptions['client'];
  private readonly identityCid: string;
  private readonly log: PushDeliveryLog;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly project: (job: PushJob) => Promise<PushEvent>;
  private readonly automatic: boolean;
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
