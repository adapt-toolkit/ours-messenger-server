import type { OursClient } from '@ours.network/sdk';
import { join } from 'node:path';
import { NotificationOutbox, type ProducerConfig } from './notification-outbox.js';
import { projectPushEvent, type PushDeliveryOptions } from './push-delivery.js';
import type { PushAdmission, PushJob } from './push.js';

/** Unsupported persisted links must not authorize contact cleanup. */
function contactTargetId(path: string): string | null {
  try {
    if (typeof path !== 'string' || /[\\\x00-\x20]|%(?:2f|5c|00|0[ad])/i.test(path)) return null;
    const match = /^\/fleet\/chats\/contacts\/([^/?#]+)(?:[?#]|$)/.exec(path);
    if (!match) return null;
    const url = new URL(path, 'https://ours.invalid');
    if (['source', 'chat', 'task', 'detail'].some(key => url.searchParams.has(key))) return null;
    const id = decodeURIComponent(match[1]);
    return id && id !== '.' && id !== '..' && !/[\x00-\x1f\x7f]/.test(id) ? id : null;
  } catch { return null; }
}

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
      return [...view.contacts,...view.pending].some(contact=>contact.container_id.toLowerCase()===cid.toLowerCase());
    };
    this.outbox = new NotificationOutbox(join(stateDir, 'notification-outbox.json'), config, async (value, eventId) => {
      const record = value as { sender_id: string; wire_id: string; event: string; sender_name?: string };
      if(await knownContact(record.sender_id)===false)return;
      const event = await projectPushEvent(client, { contactId: record.sender_id, wireId: record.wire_id,
        kind: record.event === 'message_received' ? 'message' : 'file', senderName: record.sender_name } as PushJob);
      return { eventId, title: event.title.slice(0, 160), body: event.body.slice(0, 512) || 'New message',
        url: `/fleet/chats/contacts/${encodeURIComponent(record.sender_id)}#chat-message-${encodeURIComponent(record.wire_id)}` };
    }, warn, async url=>{
      const cid=contactTargetId(url);
      if(!cid)return undefined;
      return await knownContact(cid)!==true;
    });
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
  retireContact(cid: string): void {
    const url = `/fleet/chats/contacts/${encodeURIComponent(cid)}`;
    this.outbox.retireTarget(url, (value, payload) => {
      const record = value as { sender_id?: unknown };
      if (typeof record?.sender_id === 'string' && record.sender_id.toLowerCase() === cid.toLowerCase()) return true;
      if (!payload) return false;
      return contactTargetId(payload.url)?.toLowerCase() === cid.toLowerCase();
    });
    void this.outbox.drain();
  }
  close(): Promise<void> { return this.outbox.close(); }
}
