import { createApi } from '../api';
import { configureMediaProvider, registerMediaRecords } from '../ui/fileStore';
import type { Agent, Task, Status } from './model';
import type { ChatMessage } from '../ui/chatTypes';
import type { ContactVM } from '../ui/viewmodel';
import { initials, contactName } from '../ui/viewmodel';
let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function fleet<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch('/fleet/api/v1' + path, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-CSRF-Token': csrf, ...(body && typeof body === 'object' && 'idempotencyKey' in body ? { 'Idempotency-Key': String(body.idempotencyKey) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) dispatchEvent(new Event('fleet-session-expired'));
    throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
  }
  return data as T;
}
export const messenger = createApi((input, init) => fetch('/messenger' + String(input), {
  ...init, headers: { ...init?.headers, 'X-CSRF-Token': csrf },
}));
export type RoleRow = { role: { id: string; lifetime: string; config?: { name: string; cwd?: string; mission?: string; harness?: string; permissions?: unknown } }; status: { overall: string }; capabilities: any };
export function agentView(row: RoleRow): Agent {
  return { id: row.role.id, name: row.role.config?.name ?? row.role.id,
    lifetime: row.role.lifetime === 'permanent' ? 'Persistent' : 'Temporary',
    state: row.status.overall, role: row.role.config?.mission ?? '', folder: row.role.config?.cwd ?? '' };
}
export function taskView(row: any): Task {
  return { id: row.task_id, name: row.title, list: row.list_name, roomCid: row.room_identity_cid,
    status: (row.state[0].toUpperCase() + row.state.slice(1)) as Status, description: row.brief ?? '',
    agents: row.member_roles.map((r: any) => r.name), blocked: row.blocked?.reason,
    pending: row.terminal_intent?.status === 'pending' ? row.terminal_intent.error ?? 'Closing the room…' : undefined, closed: ['done', 'cancelled'].includes(row.state) };
}
export async function contactViews(): Promise<ContactVM[]> {
  const data = await messenger.contacts();
  return [...data.contacts.map(c => ({ ...c, status: 'active' as const })), ...data.pending.map(c => ({ ...c, status: 'pending' as const }))].map(c => ({
    id: c.container_id, name: contactName(c), announcedName: c.name, initials: initials(contactName(c)), when: '', activityAt: '', last: '', unread: 0,
    status: c.status, root: null, sub: '', roleId: null, rootName: null, mine: false, kind: 'person',
  }));
}
export async function messengerHistory(id: string): Promise<ChatMessage[]> {
  const [page, files] = await Promise.all([messenger.conversation(id), messenger.files(id)]);
  registerMediaRecords(files.files);
  const rows: ChatMessage[] = page.messages.map(m => ({ dir: m.dir, text: m.text, date: m.date, read: m.read, wireId: m.wire_id,
    peerCid: m.peer_cid, replyTo: m.reply_to ? { wireId: m.reply_to.wire_id } : null, receipt: m.receipt ?? undefined,
    receiptless: m.dir === 'out' && !m.wire_id, messageKind: m.message_kind, typed: m.typed }));
  for (const file of files.files) {
    const message = rows.find(m => m.wireId === file.wire_id);
    if (message) Object.assign(message, { kind: 'file', filename: file.filename, mime: file.mime });
    else rows.push({ dir: file.dir, text: '', date: file.date, read: true, wireId: file.wire_id, replyTo: null, kind: 'file', filename: file.filename, mime: file.mime });
  }
  return rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}
export async function agentHistory(id: string): Promise<ChatMessage[]> {
  const rows = new Map<string, ChatMessage>();
  let after: string | undefined;
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    const page = await fleet(`/roles/${encodeURIComponent(id)}/conversation?limit=1000${after ? '&after=' + encodeURIComponent(after) : ''}`);
    for (const e of page.events) {
      if (e.kind === 'prompt.admitted') {
        rows.set(e.promptId ?? e.eventId, { dir: 'out', text: e.payload.text?.text ?? e.payload.text ?? '', date: e.at, read: true, wireId: e.promptId ?? e.eventId, replyTo: null });
      } else if (e.kind === 'message.chunk' || e.kind === 'message.replace') {
        if (e.payload.content?.type !== 'text') continue;
        const key = e.messageId ?? e.eventId;
        const previous = rows.get(key);
        rows.set(key, { dir: e.payload.role === 'user' ? 'out' : 'in', text: e.payload.content.redacted ? '[Content hidden by server]' : (e.kind === 'message.chunk' ? previous?.text ?? '' : '') + e.payload.content.text,
          date: e.at, read: true, wireId: key, replyTo: null });
      }
    }
    if (!page.hasMore || !page.nextCursor || page.nextCursor === after) break;
    after = page.nextCursor;
  }
  return [...rows.values()];
}

configureMediaProvider({
  url: id => '/messenger/api/media/' + encodeURIComponent(id),
  bytes: async id => { const response = await fetch('/messenger/api/media/' + encodeURIComponent(id)); if (!response.ok) throw new Error(`File download failed: ${response.status}`); return new Uint8Array(await response.arrayBuffer()); },
  fetch: async id => { await messenger.fetchFiles([id]); },
});

export async function permissionRequests(id: string) {
  const requests = new Map<string, any>();
  let after: string | undefined; let snapshot: any;
  do {
    const page = await fleet(`/roles/${encodeURIComponent(id)}/conversation?limit=1000${after ? '&after=' + encodeURIComponent(after) : ''}`);
    snapshot = page.snapshot;
    for (const event of page.events) {
      if (event.kind === 'permission.requested') requests.set(event.permissionId, event);
      if (event.kind === 'permission.resolved') requests.delete(event.permissionId);
    }
    if (!page.hasMore || !page.nextCursor || page.nextCursor === after) break;
    after = page.nextCursor;
  } while (true);
  return [...requests.values()].filter(e => snapshot.pendingPermissionIds.includes(e.permissionId)).map(e => ({
    id: `${id}:${e.permissionId}`, kind: 'request' as const, target: { section: 'work' as const, chat: id },
    title: e.payload.title ?? 'Agent requests permission', read: false, resolved: false,
    permissionId: e.permissionId, sessionGeneration: snapshot.sessionGeneration, options: e.payload.options,
  }));
}

export async function cowork(method:string,params:Record<string,unknown>):Promise<any> {
  const response=await fetch('/cowork/browser/rpc',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({version:1,id:crypto.randomUUID(),method,params})});
  const data=await response.json();if(!response.ok||data.error)throw new Error(data.error?.message??`HTTP ${response.status}`);return data.result;
}
