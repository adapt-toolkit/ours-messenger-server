import type { OursClient } from '@ours.network/sdk';
import { join } from 'node:path';
import { NotificationOutbox, contactId, contactTarget, contactIdentity, type ProducerConfig } from './notification-outbox.js';
import { projectPushEvent, type PushDeliveryOptions } from './push-delivery.js';
import type { PushAdmission, PushJob } from './push.js';

/** Durable event producer even when the user has no registered push devices. */
export class MessengerNotificationProducer {
  readonly outbox: NotificationOutbox;
  constructor(stateDir: string, config: ProducerConfig, private readonly identityCid: string,
    client: PushDeliveryOptions['client'] & Partial<Pick<OursClient, 'listContacts'>>, warn: (message: string) => void) {
    const knownContact=async(cid:string) => {
      if(!client.listContacts)return undefined;
      const view=await client.listContacts();
      if(!Array.isArray(view.contacts) || !Array.isArray(view.pending)
        || [...view.contacts,...view.pending].some(contact=>typeof contact?.container_id!=='string'))throw Error('Contact inventory unavailable');
      return [...view.contacts,...view.pending].some(contact=>contactIdentity(contact.container_id)===contactIdentity(cid));
    };
    this.outbox = new NotificationOutbox(join(stateDir, 'notification-outbox.json'), config, async (value, eventId) => {
      const record = value as { sender_id: string; wire_id: string; event: string; sender_name?: string };
      if(await knownContact(record.sender_id)===false)return;
      const event = await projectPushEvent(client, { contactId: record.sender_id, wireId: record.wire_id,
        kind: record.event === 'message_received' ? 'message' : 'file', senderName: record.sender_name } as PushJob);
      return { eventId, title: event.title.slice(0, 160), body: event.body.slice(0, 512) || 'New message',
        target: { kind: 'contact', contactId: record.sender_id }, anchor: { kind: 'messenger-message', wireId: record.wire_id } };
    }, warn, async target=>{
      if(!contactTarget(target))return undefined;
      const known = await knownContact(target.contactId);
      return known === undefined ? undefined : !known;
    });
  }
  admit(record: Record<string, unknown>): PushAdmission {
    if (!['message_received', 'file_received'].includes(String(record.event))
      || !contactId(record.sender_id)
      || typeof record.wire_id !== 'string' || !record.wire_id.trim() || record.wire_id.length > 1024 || /[\x00-\x1f\x7f]/.test(record.wire_id)) return { status: 'no_targets' };
    const eventId = `${this.identityCid}:${record.wire_id}:${record.event}`;
    if (eventId.length > 512) return { status: 'no_targets' };
    const admitted = this.outbox.enqueue(eventId, {
      event: record.event, sender_id: record.sender_id, wire_id: record.wire_id,
      ...(typeof record.sender_name === 'string' ? { sender_name: record.sender_name.slice(0, 512) } : {}),
    });
    return { status: admitted ? 'queued' : 'saturated' };
  }
  retireContact(cid: string): void {
    if (!contactId(cid)) throw new Error('Invalid notification contact');
    const target = {kind: 'contact' as const, contactId: cid};
    this.outbox.retireTarget(target, (value, payload) => {
      const record = value as { sender_id?: unknown };
      if (typeof record?.sender_id === 'string' && contactIdentity(record.sender_id) === contactIdentity(cid)) return true;
      if (!payload) return false;
      return contactIdentity(payload.target.contactId) === contactIdentity(cid);
    });
    void this.outbox.drain();
  }
  close(): Promise<void> { return this.outbox.close(); }
}
