import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';
import { countAt, isPending, markTargetRead, resolveRequest, seedNotifications, type FleetNotification } from './notifications';
import { fleet, messenger } from './live-api';
import { roleNotifications, roomTarget, notificationIsRead, retainedOfflineMessages } from './live-notifications';
import { MessageCircle, ShieldQuestion } from 'lucide-react';
import { Button, MenuAction } from './components';
import { agentPreview, externalPreview, type ChatPreview } from './chat-previews';
const READ_KEY='fleet-acp-read-v1';
function storedReads():Record<string,number>{try{const v=JSON.parse(localStorage.getItem(READ_KEY)??'{}');return v && typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}}
const Context = createContext({ items: [] as FleetNotification[], previews: {} as Record<string, ChatPreview>, live: false, error: '', read: (_chat: string, _cursor?:number, _sessionId?:string) => {}, resolve: async (_id: string, _decision = 'approved') => {} });
export function NotificationProvider({ children, live = false }: { children: ReactNode; live?: boolean }) {
 const [items,setItems]=useState<FleetNotification[]>(live?[]:seedNotifications);
 const [error,setError]=useState('');
 const [previews,setPreviews]=useState<Record<string,ChatPreview>>({});
 const readCursors=useRef<Record<string,number>>(storedReads());const acknowledged=useRef(new Set<string>());
 const loadReads=()=>{try{readCursors.current=JSON.parse(localStorage.getItem(READ_KEY)??'{}');}catch{readCursors.current={};}};
 useEffect(()=>{loadReads();const sync=()=>{loadReads();setItems(items=>applyRead(items));};addEventListener('storage',sync);return()=>removeEventListener('storage',sync);},[]);
 const applyRead=(rows:FleetNotification[])=>rows.map(n=>({...n,read:notificationIsRead(n,readCursors.current,acknowledged.current)}));
 const refresh=async()=>{
  const [roles,tasks,contacts]=await Promise.all([fleet('/roles?includeTemporary=true'),fleet('/tasks'),messenger.contacts()]);
  const liveTasks=tasks.tasks.filter((t:any)=>['active','review','provisioning'].includes(t.state));
  const previewRoles=roles.roles;
  const offline=new Set<string>(roles.roles.filter((r:any)=>r.status.session?.reachability!=='online').map((r:any)=>r.role.id));
  const nextPreviews:Record<string,ChatPreview>={};
  const sourceChats=[...previewRoles.map((r:any)=>r.role.id),...contacts.contacts.map((c:any)=>roomTarget(liveTasks,c.container_id).chat)];
  const results=await Promise.allSettled([
   ...previewRoles.map(async(row:any)=>{
    const events:any[]=[];let after='';let page:any;
    do{page=await fleet(`/roles/${encodeURIComponent(row.role.id)}/conversation?limit=1000${after?'&after='+encodeURIComponent(after):''}`);events.push(...page.events);if(!page.hasMore||page.nextCursor===after)break;after=page.nextCursor;}while(after);
    nextPreviews[row.role.id]=agentPreview(events);
    return row.status.session?.reachability==='online' ? roleNotifications(row,events,page.snapshot,liveTasks) : [];
   }),
   ...contacts.contacts.map(async(c:any)=>{
    const page=await messenger.conversation(c.container_id);
    nextPreviews[roomTarget(liveTasks,c.container_id).chat]=externalPreview(page,c.name);
    return page.messages.filter((m:any)=>m.dir==='in'&&!m.read).map((m:any)=>({id:'messenger:'+m.wire_id,kind:'message' as const,target:roomTarget(liveTasks,c.container_id),title:`${c.display_name??c.name}: New message`,read:false,resolved:false}));
   })
  ]);
  const successful=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  // A failed source must not erase its previous pending permissions or unread items.
  const failedChats=new Set(results.flatMap((r,i)=>r.status==='rejected'?[sourceChats[i]]:[]));
  setPreviews(previous=>Object.fromEntries(sourceChats.map((id:string)=>[id,nextPreviews[id] ?? {...(previous[id] ?? {text:'Preview unavailable',at:''}),unavailable:true}])));
  setItems(previous=>applyRead([...previous.filter(n=>failedChats.has(n.target.chat)&&!offline.has(n.target.chat)),...retainedOfflineMessages(previous,roles.roles),...successful]));
  setError(results.some((r,i)=>r.status==='rejected'&&!offline.has(sourceChats[i]))?'Some conversations could not be refreshed. Retrying…':'');
 };
 useEffect(()=>{if(!live)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{await refresh();}catch(e){if(!stopped)setError((e as Error).message);}finally{if(!stopped)timer=setTimeout(tick,4000);}};void tick();return()=>{stopped=true;clearTimeout(timer);};},[live]);
 const read=(chat:string,cursor?:number,sessionId?:string)=>{
  if(cursor!==undefined && sessionId){const key=chat+':'+sessionId;readCursors.current[key]=Math.max(cursor,readCursors.current[key]??0);try{localStorage.setItem(READ_KEY,JSON.stringify(readCursors.current));}catch{}}
  setItems(rows=>{for(const n of rows.filter(n=>n.target.chat===chat&&n.kind==='message')){
   if(cursor!==undefined && n.cursor!==undefined && n.cursor>cursor)continue;
   if(n.cursor===undefined)acknowledged.current.add(n.id);
   if(n.cursor!==undefined){const key=chat+':'+n.sessionId;readCursors.current[key]=Math.max(n.cursor,readCursors.current[key]??0);}
  }try{localStorage.setItem(READ_KEY,JSON.stringify(readCursors.current));}catch{}return applyRead(rows);});
 };
 const resolve=async(id:string,decision='approved')=>{
  if(!live){setItems(x=>resolveRequest(x,id,decision==='declined'?'declined':'approved'));return;}
  const item=items.find(n=>n.id===id);
  if(!item?.permissionId||!item.options?.some(o=>o.optionId===decision))throw new Error('Permission request is no longer available.');
  await fleet(`/roles/${encodeURIComponent(item.target.chat)}/permissions/${encodeURIComponent(item.permissionId)}`,{commandId:crypto.randomUUID(),sessionGeneration:item.sessionGeneration,optionId:decision});await refresh();
 };
 return <Context.Provider value={{items,previews,live,error,read,resolve}}>{children}</Context.Provider>;
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
 return <div className="fleet-notification-panel">{error && <p role="alert">Cannot check notifications: {error}</p>}<p>{pending.length ? 'Unread messages and requests needing your decision.' : 'You’re all caught up.'}</p>{pending.map(n=><MenuAction key={n.id} icon={n.kind==='request'?ShieldQuestion:MessageCircle} title={n.title} description={`${n.kind==='request'?'Decision needed':'Unread message'} · ${n.target.section==='messenger'?'External':'Workspace'}`} onClick={()=>open(n.target)} />)}</div>;
}
