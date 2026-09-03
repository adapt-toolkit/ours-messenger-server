import type {
  BuildInfoView, CommandCatalog, ContactsResponse, ConversationPage, CreatedInvite, DialogFiles, IdentityTreeRow, IdentityView, InviteView,
  JsonValue, PushPreviewMode, SendCommandResult, SendMessageResult,
} from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

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
    setBio: (bio: string) => request<unknown>('/api/identity/bio', {
      method: 'POST', body: JSON.stringify({ bio }),
    }),
    buildInfo: () => request<BuildInfoView>('/api/build-info'),
    identities: () => request<IdentityTreeRow[]>('/api/identities'),
    contacts: () => request<ContactsResponse>('/api/contacts'),
    invites: () => request<InviteView[]>('/api/invites'),
    conversation: (cid: string, before?: string) =>
      request<ConversationPage>(
        `/api/conversations/${encodeURIComponent(cid)}/page?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      ),
    markRead: (cid: string) =>
      request<{ contact: string; marked: number }>(`/api/conversations/${encodeURIComponent(cid)}/read`, { method: 'POST' }),
    send: (contact: string, text: string, replyTo?: string, signal?: AbortSignal) =>
      request<SendMessageResult>('/api/messages/send', {
        method: 'POST',
        signal,
        body: JSON.stringify({ contact, text, ...(replyTo ? { reply_to_wire_id: replyTo } : {}) }),
      }),
    commands: (contact: string, signal?: AbortSignal) =>
      request<CommandCatalog>(`/api/contacts/${encodeURIComponent(contact)}/commands`, { signal }),
    sendCommand: (
      contact: string,
      command: string,
      args: JsonValue,
      invocationId: string,
      catalogFingerprint: string,
      signal?: AbortSignal,
    ) => request<SendCommandResult>('/api/commands/send', {
      method: 'POST', signal,
      body: JSON.stringify({
        contact, recipient_cid: contact, command, arguments: args, invocation_id: invocationId,
        catalog_fingerprint: catalogFingerprint, confirmed: true,
      }),
    }),
    sendFile: async (contact: string, file: Blob, filename: string, mime: string, replyTo?: string) =>
      request<unknown>('/api/messages/send-file', {
        method: 'POST',
        body: JSON.stringify({
          contact,
          data_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
          filename,
          mime,
          ...(replyTo ? { reply_to_wire_id: replyTo } : {}),
        }),
      }),
    files: (cid: string) =>
      request<DialogFiles>(`/api/conversations/${encodeURIComponent(cid)}/files`),
    fetchFiles: (wireIds: string[]) => request<unknown>('/api/files/fetch', {
      method: 'POST', body: JSON.stringify({ wire_ids: wireIds }),
    }),
    mediaUrl: (wireId: string) => `/api/media/${encodeURIComponent(wireId)}`,
    createInvite: (mode: 'one_time' | 'public' = 'one_time', name?: string) =>
      request<CreatedInvite>('/api/invites', { method: 'POST', body: JSON.stringify({ mode, ...(name ? { name } : {}) }) }),
    addContact: (invite: string, name?: string) =>
      request<unknown>('/api/contacts/add', {
        method: 'POST', body: JSON.stringify({ invite, ...(name ? { name } : {}) }),
      }),
    renameContact: (contact: string, name: string) => request<unknown>('/api/contacts/rename', {
      method: 'POST', body: JSON.stringify({ contact, name }),
    }),
    removeContact: (contact: string) => request<unknown>('/api/contacts/remove', {
      method: 'POST', body: JSON.stringify({ contact }),
    }),
    revokeInvite: (inviteId: string) => request<unknown>('/api/invites/revoke', {
      method: 'POST', body: JSON.stringify({ invite_id: inviteId }),
    }),
    respondToIntroduction: (contact: string, action: 'approve' | 'reject') =>
      request<unknown>('/api/contacts/introductions', {
        method: 'POST', body: JSON.stringify({ contact, action }),
      }),
    vapidPublicKey: () => request<{ publicKey: string; fingerprint: string; configEpoch: number }>('/api/push/vapid-public-key'),
    ensurePush: (subscription: PushSubscriptionJSON & {
      label?: string; preview?: PushPreviewMode; binding_id?: string;
    }) => request<{
      status: 'on'; binding_id: string; fingerprint: string; configEpoch: number; preview: PushPreviewMode;
    }>('/api/push/subscriptions/ensure', {
      method: 'POST', body: JSON.stringify(subscription),
    }),
    deletePush: (bindingId: string) => request<{ removed: boolean }>('/api/push/subscriptions/delete', {
      method: 'POST', body: JSON.stringify({ binding_id: bindingId }),
    }),
  };
}

export const api = createApi();
