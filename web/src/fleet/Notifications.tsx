import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { countAt, isPending, markTargetRead, resolveRequest, seedNotifications, type FleetNotification } from './notifications';
import { fleet, messenger, permissionRequests } from './live-api';
import { Button, Row } from './components';
const Context = createContext({ items: [] as FleetNotification[], live: false, error: '', read: (_chat: string) => {}, resolve: async (_id: string, _decision = 'approved') => {} });
export function NotificationProvider({ children, live = false }: { children: ReactNode; live?: boolean }) {
  const [items, setItems] = useState<FleetNotification[]>(live ? [] : seedNotifications);
  const [error, setError] = useState('');
  const [messageError, setMessageError] = useState('');
  const refresh = async () => {
    const roles = await fleet('/roles?includeTemporary=true');
    const pending = roles.roles.filter((r: any) => r.status.session.readiness === 'awaiting_permission');
    const requests = (await Promise.all(pending.map((r: any) => permissionRequests(r.role.id)))).flat();
    setItems(previous => [...previous.filter(n => n.kind !== 'request'), ...requests]); setError('');
  };
  useEffect(() => {
    if (!live) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { await refresh(); } catch(e) { if (!stopped) setError((e as Error).message); } finally { if (!stopped) timer = setTimeout(tick, 4000); } };
    void tick(); return () => { stopped = true; clearTimeout(timer); };
  }, [live]);
  useEffect(() => {
    if (!live) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const contacts = await messenger.contacts();
        const messages = (await Promise.all(contacts.contacts.map(async c => {
          const page = await messenger.conversation(c.container_id);
          return page.messages.filter(m => m.dir === 'in' && !m.read).map(m => ({ id: m.wire_id, kind: 'message' as const,
            target: { section: 'messenger' as const, chat: c.container_id }, title: `${c.display_name ?? c.name}: ${page.preview ?? 'New message'}`, read: false, resolved: false }));
        }))).flat();
        if (!stopped) { setItems(previous => [...previous.filter(n => n.kind !== 'message'), ...messages]); setMessageError(''); }
      } catch(e) { if (!stopped) setMessageError((e as Error).message); }
      finally { if (!stopped) timer = setTimeout(tick,15000); }
    };
    void tick(); return () => { stopped = true; clearTimeout(timer); };
  },[live]);
  const resolve = async (id: string, decision = 'approved') => {
    if (!live) { setItems(x => resolveRequest(x,id,decision === 'declined' ? 'declined' : 'approved')); return; }
    const item = items.find(n => n.id === id);
    if (!item?.permissionId || !item.options?.some(o => o.optionId === decision)) throw new Error('Permission request is no longer available.');
    await fleet(`/roles/${encodeURIComponent(item.target.chat)}/permissions/${encodeURIComponent(item.permissionId)}`, { commandId: crypto.randomUUID(), sessionGeneration: item.sessionGeneration, optionId: decision });
    await refresh();
  };
  return <Context.Provider value={{ items, live, error: error || messageError, read: chat => setItems(x => markTargetRead(x,chat)), resolve }}>{children}</Context.Provider>;
}
export const useNotifications = () => useContext(Context);
export function NotificationBadge({ node, excludeChat }: { node: string; excludeChat?: string }) {
  const { items } = useNotifications();
  const count = countAt(items.filter(n => n.target.chat !== excludeChat), node);
  return count ? <span className="fleet-notification-badge" role="img" aria-label={`${count} notifications`} data-notification-node={node}>{count}</span> : null;
}
export function AgentRequests({ chat }: { chat: string }) {
  const { items, resolve, live, error: loadError } = useNotifications();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const decide = async (id: string, option: string) => { setBusy(true); setError(''); try { await resolve(id,option); } catch(e) {setError((e as Error).message);} finally {setBusy(false);} };
  const requests = items.filter(n => n.kind === 'request' && n.target.chat === chat);
  if(!requests.length) return loadError ? <p role="alert">Cannot check agent permissions: {loadError}</p> : null;
  return <div className="fleet-agent-requests" aria-label="Agent requests">{error && <p role="alert">{error}</p>}{requests.map(n => <section key={n.id} className="fleet-agent-request" aria-label={n.title}>
    <strong>{isPending(n) ? 'Needs your decision' : 'Decision sent'}</strong><p>{n.title}</p>
    {isPending(n) ? <div className="fleet-actions">{live ? n.options?.map(o => <Button key={o.optionId} disabled={busy} onClick={() => void decide(n.id,o.optionId)}>{o.name}</Button>) : <><Button primary onClick={() => void decide(n.id,'approved')}>Approve request</Button><Button onClick={() => void decide(n.id,'declined')}>Decline request</Button></>}</div> : <p role="status">Request resolved in this preview. Decision: {n.decision}.</p>}
  </section>)}</div>;
}

export function NotificationPanel({open}:{open:(target:FleetNotification['target'])=>void}) {
 const {items,error}=useNotifications();
 const pending=items.filter(isPending);
 return <div className="fleet-notification-panel">{error && <p role="alert">Cannot check notifications: {error}</p>}<p>{pending.length ? 'Unread messages and requests needing your decision.' : 'You’re all caught up.'}</p>{pending.map(n=><Row key={n.id} title={n.title} subtitle={`${n.kind==='request'?'Decision needed':'Unread message'} · ${n.target.section==='messenger'?'External':'Workspace'}`} onClick={()=>open(n.target)} />)}</div>;
}
