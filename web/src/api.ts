import type { ContactsResponse, ConversationPage, CreatedInvite, IdentityView, InviteView } from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createApi(fetcher: Fetcher = globalThis.fetch.bind(globalThis)) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD';
    const res = await fetcher(path, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: mutating
        ? { 'content-type': 'application/json', 'X-Ours-Messenger-CSRF': '1', ...init?.headers }
        : init?.headers,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, res.ok ? 'Server returned an invalid response' : `HTTP ${res.status}`);
      }
    }
    if (!res.ok) {
      const message = data && typeof data === 'object' && 'error' in data
        && data.error && typeof data.error === 'object' && 'message' in data.error
        && typeof data.error.message === 'string'
        ? data.error.message
        : `HTTP ${res.status}`;
      throw new ApiError(res.status, message);
    }
    return data as T;
  }

  return {
    identity: () => request<IdentityView>('/api/identity'),
    contacts: () => request<ContactsResponse>('/api/contacts'),
    invites: () => request<InviteView[]>('/api/invites'),
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
      request<CreatedInvite>('/api/invites', { method: 'POST', body: JSON.stringify({ mode }) }),
    addContact: (invite: string, name?: string) =>
      request<unknown>('/api/contacts/add', {
        method: 'POST', body: JSON.stringify({ invite, ...(name ? { name } : {}) }),
      }),
    respondToIntroduction: (contact: string, action: 'approve' | 'reject') =>
      request<unknown>('/api/contacts/introductions', {
        method: 'POST', body: JSON.stringify({ contact, action }),
      }),
  };
}

export const api = createApi();
