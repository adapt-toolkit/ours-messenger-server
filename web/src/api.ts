import type { ContactsResponse, ConversationPage, IdentityView } from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  const res = await fetch(path, {
    ...init,
    headers: mutating
      ? { 'content-type': 'application/json', 'X-Ours-Messenger-CSRF': '1', ...init?.headers }
      : init?.headers,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  identity: () => request<IdentityView>('/api/identity'),
  contacts: () => request<ContactsResponse>('/api/contacts'),
  invites: () => request<Array<{ invite_id: string; mode: string; assigned: string }>>('/api/invites'),
  conversation: (cid: string) =>
    request<ConversationPage>(`/api/conversations/${encodeURIComponent(cid)}/page?limit=50`),
  markRead: (cid: string) =>
    request<{ contact: string; marked: number }>(`/api/conversations/${encodeURIComponent(cid)}/read`, { method: 'POST' }),
  send: (contact: string, text: string, replyTo?: string) =>
    request<unknown>('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify({ contact, text, ...(replyTo ? { reply_to_wire_id: replyTo } : {}) }),
    }),
  createInvite: (mode: 'one_time' | 'public' = 'one_time') =>
    request<{ blob: string; inviteId: string; mode: string }>('/api/invites', {
      method: 'POST', body: JSON.stringify({ mode }),
    }),
  addContact: (invite: string, name?: string) =>
    request<unknown>('/api/contacts/add', {
      method: 'POST', body: JSON.stringify({ invite, ...(name ? { name } : {}) }),
    }),
};
