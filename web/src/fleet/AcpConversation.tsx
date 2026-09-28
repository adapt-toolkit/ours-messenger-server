import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { I18nProvider, MessageBubble, StreamingIndicator } from '@acp-components/react';
import type { Message } from '@acp-components/core';
import '@acp-components/react/styles.css';
import { fleet } from './live-api';
import { acpMessages } from './acp-adapter';
import { AgentRequests, useNotifications } from './Notifications';
import { Button } from './components';
import './acp.css';
export function AcpConversation({ id, name, active, dark, back, actions }: { id:string; name:string; active:boolean; dark:boolean; back:()=>void; actions:()=>void }) {
  const notifications=useNotifications(); const read=useRef(notifications.read);read.current=notifications.read;
  const latest=useRef<{cursor:number;sessionId:string}|null>(null);
  const [messages,setMessages]=useState<Message[]>([]);
  const [snapshot,setSnapshot]=useState<any>(null);
  const [online,setOnline]=useState(false);
  const [error,setError]=useState('');
  const [text,setText]=useState('');
  const [sending,setSending]=useState(false);
  const [receipt,setReceipt]=useState<any>(null);
  const [model,setModel]=useState('');
  const [revision,setRevision]=useState(0);
  const bottom=useRef<HTMLDivElement>(null);const scroll=useRef<HTMLDivElement>(null);const follow=useRef(true);const userScroll=useRef(0);
  useEffect(()=>{
    if(!active)return;
    let alive=true;let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{try {
      const role=await fleet(`/roles/${encodeURIComponent(id)}`);
      if(!alive)return;
      setModel(role.status.session?.runtimeModel?.label ?? role.role.config?.harness ?? '');
      const reachable=role.status.session?.reachability==='online';setOnline(reachable);
      if(!reachable){setSnapshot(null);setError('');return;}
      let after='';const events:any[]=[];let page:any;
      do {page=await fleet(`/roles/${encodeURIComponent(id)}/conversation?limit=1000${after?'&after='+encodeURIComponent(after):''}`);events.push(...page.events);if(!page.hasMore || page.nextCursor===after)break;after=page.nextCursor;}while(after);
      if(!alive)return;setMessages(acpMessages(events));setSnapshot(page.snapshot);setError('');
      latest.current={cursor:Number(page.nextCursor),sessionId:role.status.session.sessionId}; if(follow.current && document.visibilityState==='visible')read.current(id,latest.current.cursor,latest.current.sessionId);
      setReceipt((r:any)=>r && !events.some(e=>e.kind==='turn.completed' && e.promptId===r.promptId) ? r : null);
    }catch(e){if(alive)setError((e as Error).message.includes('ENOENT')?'Agent is starting. Reconnecting…':(e as Error).message);}finally{if(alive)timer=setTimeout(tick,2000);}};
    void tick();return()=>{alive=false;clearTimeout(timer);};
  },[id,active,revision]);
  useLayoutEffect(()=>{if(active && follow.current && scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[messages,active,sending]);
  const groups: Message[][]=[]; for(const m of messages) { const previous=groups[groups.length-1];if(m.role==='agent'&&previous?.[0].role==='agent')previous.push(m);else groups.push([m]); }
  useEffect(()=>{const el=scroll.current;if(!el)return;const observer=new ResizeObserver(()=>{if(follow.current)el.scrollTop=el.scrollHeight;});observer.observe(el);return()=>observer.disconnect();},[]);
  const pending=snapshot?.pendingPermissionIds?.length>0;
  const running=!!receipt || snapshot?.readiness==='running' || snapshot?.queueDepth>0;
  const state=sending?'Sending…':pending?'Waiting for your approval':!online?'Connecting to agent…':running?(receipt?.state==='queued'?'Message queued · Agent is working':'Agent is thinking…'):'Ready';
  const send=async()=>{if(!text.trim()||sending)return;const prompt=text;setSending(true);setError('');follow.current=true;try{const result=await fleet(`/roles/${encodeURIComponent(id)}/input`,{text:prompt,commandId:crypto.randomUUID()});setReceipt(result);setMessages(m=>[...m,{id:result.promptId,role:'user',timestamp:Date.now(),parts:[{type:'content',content:[{type:'text',text:prompt}]}]}]);setText('');setRevision(r=>r+1);}catch(e){setError((e as Error).message);}finally{setSending(false);}};
  return <I18nProvider defaultLocale="en-US"><div className="fleet-acp" data-acp-theme={dark?'dark':'light'}>
    <header className="fleet-acp-header"><Button onClick={back}>‹ Chats</Button><div><strong>{name}</strong><small>{model} · Agent session</small></div><Button aria-label="Agent actions" onClick={actions}>⋯</Button></header>
    <div ref={scroll} className="fleet-acp-scroll" onWheel={()=>{userScroll.current=Date.now();}} onTouchMove={()=>{userScroll.current=Date.now();}} onPointerDown={()=>{userScroll.current=Date.now();}} onScroll={e=>{const el=e.currentTarget;if(Date.now()-userScroll.current<500)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;if(follow.current&&active&&latest.current&&document.visibilityState==='visible')read.current(id,latest.current.cursor,latest.current.sessionId);}}>
      <div className="fleet-acp-thread">{messages.length===0 && <div className="fleet-acp-empty"><h2>What would you like to work on?</h2><p>Send a message to {name}.</p></div>}
      {groups.map(group=><article key={group[0].id} className={'fleet-acp-message '+group[0].role} aria-label={group[0].role==='user'?'You':'Agent'}><small>{group[0].role==='user'?'You':name}</small><MessageBubble messages={group} /></article>)}
      {active && <AgentRequests chat={id}/>}<div ref={bottom}/></div>
    </div>
    <form className="fleet-acp-composer" onSubmit={e=>{e.preventDefault();void send();}}>
      <div className="fleet-acp-state" role="status">{(running||sending)&&!pending&&<StreamingIndicator/>}<span>{state}</span>{running&&online&&<Button onClick={()=>{void fleet(`/roles/${encodeURIComponent(id)}/interrupt`,{commandId:crypto.randomUUID()}).then(()=>setRevision(r=>r+1)).catch(e=>setError(e.message));}}>Stop</Button>}</div>
      {error&&<p role="alert">{error}</p>}
      <div className="fleet-acp-input"><textarea aria-label="Message agent" placeholder="Message your agent…" value={text} rows={2} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><Button primary type="submit" disabled={sending||!online||!text.trim()}>{sending?'Sending…':'Send'}</Button></div>
    </form>
  </div></I18nProvider>;
}
