import { roomLineForContact } from '../../../shared/roomMessageCore.mjs';
import { useEffect, useState } from 'react';
import { fleet } from './live-api';
import { Button, PageHeader, Row, SearchField } from './components';
import type { Agent, Page } from './model';

async function readAgent(id: string, operation: 'contacts'|'history', args: Record<string, unknown>) {
  const query=new URLSearchParams(Object.entries(args).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
  const data=await fleet(`/roles/${encodeURIComponent(id)}/${operation==='contacts'?'contacts':'messages?'+query}`);
  if(!Array.isArray(operation==='contacts'?data.contacts:data.items))throw new Error('Supervisor returned an invalid correspondence response.');
  return data;
}
export function LiveAgentConversations({agent, peer, go}: {agent: Agent; peer?: string; go: (page: Page) => void}) {
  const [contacts,setContacts]=useState<any[]>([]), [messages,setMessages]=useState<any[]>([]);
  const [cursor,setCursor]=useState<number>(), [busy,setBusy]=useState(false), [error,setError]=useState(''), [search,setSearch]=useState('');
  const open=(peer?:string)=>go({kind:'contacts',id:agent.id,peer});
  useEffect(()=>{let live=true;setContacts([]);setError('');setBusy(true);readAgent(agent.id,'contacts',{}).then(data=>{if(live)setContacts(data.contacts??[]);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false};},[agent.id]);
  useEffect(()=>{let live=true;setMessages([]);setCursor(undefined);setError('');if(!peer)return;setBusy(true);readAgent(agent.id,'history',{peer_cid:peer,limit:50}).then(data=>{if(live){setMessages(data.messages??data.items??[]);setCursor(data.next_cursor??undefined);}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false};},[agent.id,peer]);
  const more=async()=>{setBusy(true);setError('');try{const data=await readAgent(agent.id,'history',{peer_cid:peer,limit:50,before_seq:cursor});setMessages(old=>[...old,...(data.messages??data.items??[]).filter((m:any)=>!old.some(x=>x.seq===m.seq))]);setCursor(data.next_cursor??undefined);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const selected=contacts.find(c=>(c.container_id??c.id??c.cid)===peer);
  const name=(c:any)=>c.display_name??c.name??c.container_id??c.id??c.cid;
  return <section className="fleet-agent-contacts"><PageHeader title={peer ? name(selected??{id:peer}) : 'Contacts & conversations'} subtitle={`${agent.name} · View only`} onBack={()=>peer?open():go({kind:'profile',id:agent.id})}/>{error&&<p role="alert">{error}</p>}{!peer?<><SearchField value={search} onChange={setSearch} placeholder="Search agent’s contacts"/>{contacts.filter(c=>String(name(c)).toLowerCase().includes(search.toLowerCase())).map(c=><Row key={c.container_id??c.id??c.cid} title={name(c)} onClick={()=>open(c.container_id??c.id??c.cid)}/>)}{!busy&&!contacts.length&&!error&&<p>No contacts yet.</p>}</>:<><ol className="fleet-correspondence-history" aria-label="Agent message history">{[...messages].sort((a,b)=>a.seq-b.seq).map(m=>{const body=m.text??m.body??(m.message_kind==='file'?'File attachment':'No message body available');const room=roomLineForContact(selected?.name,body);return <li key={m.seq} className={'fleet-correspondence-message'+(m.direction==='out'?' sent':'')}><small>{m.direction==='out'?agent.name:room?.author??name(selected??{id:peer})} · <time>{m.date}</time></small><p>{room?.text??body}</p></li>})}</ol>{cursor!=null&&<Button disabled={busy} onClick={()=>void more()}>Load older messages</Button>}{!busy&&!messages.length&&!error&&<p>No messages yet.</p>}<p className="muted">Viewing agent history · Read only</p></>}{busy&&<p role="status">Loading…</p>}</section>;
}
