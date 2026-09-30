import { join } from 'node:path';
import { NotificationOutbox, type ProducerConfig } from './notification-outbox.js';
import { projectPushEvent, type PushDeliveryOptions } from './push-delivery.js';
import type { PushAdmission, PushJob } from './push.js';

/** Durable event producer even when the user has no registered push devices. */
export class MessengerNotificationProducer {
  readonly outbox: NotificationOutbox;
  constructor(stateDir: string, config: ProducerConfig, private readonly identityCid: string,
    client: PushDeliveryOptions['client'], warn: (message: string) => void) {
    this.outbox = new NotificationOutbox(join(stateDir, 'notification-outbox.json'), config, async (value, eventId) => {
      const record = value as { sender_id: string; wire_id: string; event: string; sender_name?: string };
      const event = await projectPushEvent(client, { contactId: record.sender_id, wireId: record.wire_id,
        kind: record.event === 'message_received' ? 'message' : 'file', senderName: record.sender_name } as PushJob);
      return { eventId, title: event.title.slice(0, 160), body: event.body.slice(0, 512) || 'New message',
        url: `/fleet/chats?source=messenger&chat=${encodeURIComponent(record.sender_id)}&detail=1#chat-message-${encodeURIComponent(record.wire_id)}` };
    }, warn);
  }
  admit(record: Record<string, unknown>): PushAdmission {
    if (!['message_received', 'file_received'].includes(String(record.event))
      || typeof record.sender_id !== 'string' || record.sender_id.length > 512
      || typeof record.wire_id !== 'string' || record.wire_id.length > 1024) return { status: 'no_targets' };
    const admitted = this.outbox.enqueue(`${this.identityCid}:${record.wire_id}:${record.event}`, {
      event: record.event, sender_id: record.sender_id, wire_id: record.wire_id,
      ...(typeof record.sender_name === 'string' ? { sender_name: record.sender_name.slice(0, 512) } : {}),
    });
    return { status: admitted ? 'queued' : 'saturated' };
  }
  close(): Promise<void> { return this.outbox.close(); }
}
