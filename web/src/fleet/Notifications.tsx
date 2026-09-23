import { createContext, useContext, useState, type ReactNode } from 'react';
import { countAt, isPending, markTargetRead, resolveRequest, seedNotifications, type FleetNotification } from './notifications';
import { Button, Row } from './components';
const Context = createContext({ items: [] as FleetNotification[], read: (_chat: string) => {}, resolve: (_id: string, _decision: 'approved' | 'declined' = 'approved') => {} });
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState(seedNotifications);
  return <Context.Provider value={{ items, read: chat => setItems(x => markTargetRead(x, chat)), resolve: (id, decision) => setItems(x => resolveRequest(x, id, decision)) }}>{children}</Context.Provider>;
}
export const useNotifications = () => useContext(Context);
export function NotificationBadge({ node, excludeChat }: { node: string; excludeChat?: string }) {
  const { items } = useNotifications();
  const count = countAt(items.filter(n => n.target.chat !== excludeChat), node);
  return count ? <span className="fleet-notification-badge" role="img" aria-label={`${count} notifications`} data-notification-node={node}>{count}</span> : null;
}
export function AgentRequests({ chat }: { chat: string }) {
  const { items, resolve } = useNotifications();
  const requests = items.filter(n => n.kind === 'request' && n.target.chat === chat);
  if(!requests.length) return null;
  return <div className="fleet-agent-requests" aria-label="Agent requests">{requests.map(n => <section key={n.id} className="fleet-agent-request" aria-label={n.title}>
    <strong>{isPending(n) ? 'Needs your decision' : 'Decision sent'}</strong><p>{n.title}</p>
    {isPending(n) ? <div className="fleet-actions"><Button primary onClick={() => resolve(n.id)}>Approve request</Button><Button onClick={() => resolve(n.id, 'declined')}>Decline request</Button></div> : <p role="status">Request resolved in this preview. Decision: {n.decision}.</p>}
  </section>)}</div>;
}

export function NotificationPanel({open}:{open:(target:FleetNotification['target'])=>void}) {
 const {items}=useNotifications();
 const pending=items.filter(isPending);
 return <div className="fleet-notification-panel"><p>{pending.length ? 'Unread messages and requests needing your decision.' : 'You’re all caught up.'}</p>{pending.map(n=><Row key={n.id} title={n.title} subtitle={`${n.kind==='request'?'Decision needed':'Unread message'} · ${n.target.section==='messenger'?'External':'Workspace'}`} onClick={()=>open(n.target)} />)}</div>;
}
