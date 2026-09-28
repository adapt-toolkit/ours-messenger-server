import { AcpVoice, type VoiceIntent } from './AcpVoice';
import DialogShell from '../ui/DialogShell';
import { AgentLifecycle } from './AgentLifecycle';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { I18nProvider, MessageBubble, StreamingIndicator } from '@acp-components/react';
import type { Message } from '@acp-components/core';
import '@acp-components/react/styles.css';
import { fleet } from './live-api';
import { acpMessages } from './acp-adapter';
import { AgentRequests, useNotifications } from './Notifications';
import { Button, BackButton } from './components';
import { IconButton } from '../ui/Button';
import { ArrowUp, MoreHorizontal, Square } from 'lucide-react';
import './acp.css';
import { useGlassChrome } from './useGlassChrome';
export function AcpConversation({ id, name, active, dark, back, actions }: { id:string; name:string; active:boolean; dark:boolean; back:()=>void; actions:()=>void }) {
  const chrome=useGlassChrome();
  const notifications=useNotifications(); const read=useRef(notifications.read);read.current=notifications.read;
  const latest=useRef<{cursor:number;sessionId:string}|null>(null);
  const [messages,setMessages]=useState<Message[]>([]);
  const [snapshot,setSnapshot]=useState<any>(null);
  const [online,setOnline]=useState(false);
  const [error,setError]=useState('');
  const [text,setText]=useState('');
  const [voiceBusy,setVoiceBusy]=useState(false);
  const [sending,setSending]=useState(false);const [stopping,setStopping]=useState(false);
  const [receipt,setReceipt]=useState<any>(null);
  const [taskCards,setTaskCards]=useState<Array<{operationId:string;taskId:string;title:string;state:string;at:string}>>([]);
  const [commands,setCommands]=useState<Array<{name:string;description?:{text?:string};inputHint?:string}>>([]);
  const [permanent,setPermanent]=useState(false);const [suggestionsHidden,setSuggestionsHidden]=useState(false);const [commandIndex,setCommandIndex]=useState(0);const composerInput=useRef<HTMLTextAreaElement>(null);const [restart,setRestart]=useState<'restart_resume'|'restart_fresh'|null>(null);
  const [model,setModel]=useState('');
  const [revision,setRevision]=useState(0);
  const bottom=useRef<HTMLDivElement>(null);const scroll=useRef<HTMLDivElement>(null);const follow=useRef(true);const userScroll=useRef(0);
  useEffect(()=>{
    if(!active)return;
    let alive=true;let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{try {
      const role=await fleet(`/roles/${encodeURIComponent(id)}`);
      if(!alive)return;
      setPermanent(role.role.lifetime==='permanent');
      setModel(role.status.session?.runtimeModel?.label ?? role.role.config?.harness ?? '');
      const reachable=role.status.session?.reachability==='online';setOnline(reachable);
      if(!reachable){setSnapshot(null);setCommands([]);setError('');return;}
      let after='';const events:any[]=[];let page:any;
      do {page=await fleet(`/roles/${encodeURIComponent(id)}/conversation?limit=1000${after?'&after='+encodeURIComponent(after):''}`);events.push(...page.events);if(!page.hasMore || page.nextCursor===after)break;after=page.nextCursor;}while(after);
      if(!alive)return;setMessages(acpMessages(events));setTaskCards([...new Map(events.filter(e=>e.kind==='fleet.task_created'&&e.source==='fleet_lifecycle'&&e.promptId&&/^[a-z0-9]{17}$/.test(e.payload?.taskId)).map(e=>[e.payload.operationId,{...e.payload,at:e.at}])).values()] as any);setSnapshot(page.snapshot);setCommands(events.filter(e=>e.kind==='capabilities.updated'&&e.sessionGeneration===page.snapshot.sessionGeneration&&Array.isArray(e.payload?.commands)).at(-1)?.payload.commands??[]);setError('');
      latest.current={cursor:Number(page.nextCursor),sessionId:role.status.session.sessionId}; if(follow.current && document.visibilityState==='visible')read.current(id,latest.current.cursor,latest.current.sessionId);
      setReceipt((r:any)=>r && !events.some(e=>e.kind==='turn.completed' && e.promptId===r.promptId) ? r : null);
    }catch(e){if(alive)setError((e as Error).message.includes('ENOENT')?'Agent is starting. Reconnecting…':(e as Error).message);}finally{if(alive)timer=setTimeout(tick,2000);}};
    void tick();return()=>{alive=false;clearTimeout(timer);};
  },[id,active,revision]);
  useLayoutEffect(()=>{if(active && follow.current && scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[messages,active,sending]);
  const groups: Message[][]=[]; for(const m of messages) { const previous=groups[groups.length-1];if(m.role==='agent'&&previous?.[0].role==='agent')previous.push(m);else groups.push([m]); }
  useEffect(()=>{const el=scroll.current;if(!el)return;const observer=new ResizeObserver(()=>{if(follow.current)el.scrollTop=el.scrollHeight;});observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{try{const saved=sessionStorage.getItem('fleet-pending-input:'+id);if(saved)setText(JSON.parse(saved).text);}catch{}},[id]);
  const pending=snapshot?.pendingPermissionIds?.length>0;
  const running=!!receipt || snapshot?.readiness==='running' || snapshot?.queueDepth>0;
  const state=sending?'Sending…':pending?'Waiting for your approval':!online?'Connecting to agent…':running?(receipt?.state==='queued'?'Message queued · Agent is working':'Agent is thinking…'):'Ready';
  const commandChoices:Array<{name:string;description:string;inputHint?:string}>=[...commands.filter(c=>!['help','restart','force-restart'].includes(c.name)).map(c=>({name:c.name,description:c.description?.text??'',inputHint:c.inputHint})),...(permanent?[{name:'restart',description:'Restart and resume the saved session'},{name:'force-restart',description:'Restart with fresh conversation context'}]:[])];
  const commandPrefix=text.match(/^\/([a-z0-9_-]*)$/i)?.[1];
  const suggestions=commandPrefix===undefined?[]:commandChoices.filter(c=>c.name.startsWith(commandPrefix));
  const showSuggestions=online&&!suggestionsHidden&&commandPrefix!==undefined;
  const chooseCommand=(c:typeof commandChoices[number])=>{setText('/'+c.name+(c.inputHint?' ':''));setSuggestionsHidden(true);composerInput.current?.focus();};
  const send=async()=>{if(!text.trim()||sending||running||voiceBusy)return;const prompt=text;const command=prompt.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/s);if(command){const [,name,args]=command;if(name==='help'){setText('/');setSuggestionsHidden(false);setCommandIndex(0);return;}if(['restart','force-restart'].includes(name)){if(!permanent||args){setError('Restart commands require a persistent agent and take no arguments.');return;}setRestart(name==='restart'?'restart_resume':'restart_fresh');return;}const available=commands.find(c=>c.name===name);if(!available){setError(`/${name} is not available in this session. Type / to see supported commands.`);return;}if(args&&!available.inputHint){setError(`/${name} takes no arguments.`);return;}}const intentKey='fleet-pending-input:'+id;let intent:{text:string;commandId:string};try{const saved=sessionStorage.getItem(intentKey);intent=saved?JSON.parse(saved):{text:prompt,commandId:crypto.randomUUID()};if(intent.text!==prompt){setError('A previous send is unconfirmed. Restore its text to retry the same request.');setText(intent.text);return;}sessionStorage.setItem(intentKey,JSON.stringify(intent));}catch{setError('Cannot retain this request safely in browser storage.');return;}setSending(true);setError('');follow.current=true;try{const result=await fleet(`/roles/${encodeURIComponent(id)}/input`,intent);sessionStorage.removeItem(intentKey);setReceipt(result);setMessages(m=>[...m,{id:result.promptId,role:'user',timestamp:Date.now(),parts:[{type:'content',content:[{type:'text',text:prompt}]}]}]);setText('');setRevision(r=>r+1);}catch(e){setError((e as Error).message);}finally{setSending(false);}};
  const sendVoice = async (intent: VoiceIntent) => {
    if (!intent.expectedSessionGeneration) throw Object.assign(new Error('Agent session is not ready.'), { code: 'stale_state' });
    if (sessionStorage.getItem('fleet-pending-input:'+id)) throw Object.assign(new Error('Resolve the pending text message before sending voice.'), { code: 'conflict' });
    setSending(true);
    try {
      const result = await fleet(`/roles/${encodeURIComponent(id)}/input`, intent);
      setReceipt(result); follow.current = true;
      setMessages(m => [...m, { id: result.promptId, role: 'user', timestamp: Date.now(), parts: [{ type: 'content', content: [{ type: 'text', text: intent.text }] }] }]);
      setRevision(r => r + 1);
    } finally { setSending(false); }
  };
  return <I18nProvider defaultLocale="en-US"><div ref={chrome} className="fleet-acp" data-acp-theme={dark?'dark':'light'}>
    <header className="fleet-acp-header"><BackButton onClick={back} label="Back to chats" /><div><strong>{name}</strong><small>{model} · Agent session</small></div><IconButton aria-label="Agent actions" onClick={actions}><MoreHorizontal size={22}/></IconButton></header>
    <div ref={scroll} className="fleet-acp-scroll" onWheel={()=>{userScroll.current=Date.now();}} onTouchMove={()=>{userScroll.current=Date.now();}} onPointerDown={()=>{userScroll.current=Date.now();}} onScroll={e=>{const el=e.currentTarget;if(Date.now()-userScroll.current<500)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;if(follow.current&&active&&latest.current&&document.visibilityState==='visible')read.current(id,latest.current.cursor,latest.current.sessionId);}}>
      <div className="fleet-acp-thread">{messages.length===0 && <div className="fleet-acp-empty"><h2>What would you like to work on?</h2><p>Send a message to {name}.</p></div>}
      {[...groups.map(group=>({time:group[0].timestamp,node:<article key={group[0].id} className={'fleet-acp-message '+group[0].role} aria-label={group[0].role==='user'?'You':'Agent'}><small>{group[0].role==='user'?'You':name}</small><MessageBubble messages={group}/></article>})),...taskCards.map(card=>({time:Date.parse(card.at),node:<section key={'task:'+card.operationId} className="fleet-task-notice" aria-label="Task created"><small>Task created · {card.state}</small><strong>{card.title}</strong><a href={'/fleet/tasks/'+encodeURIComponent(card.taskId)}>Open task →</a></section>}))].sort((a,b)=>a.time-b.time).map(item=>item.node)}
      {active && <AgentRequests chat={id}/>}<div ref={bottom}/></div>
    </div>
    <form className="fleet-acp-composer" onSubmit={e=>{e.preventDefault();void send();}}>
      <div className="fleet-acp-state" role="status">{(running||sending)&&!pending&&<StreamingIndicator/>}<span>{state}</span></div>
      {error&&<p role="alert">{error}</p>}
      {showSuggestions&&<div className="fleet-command-suggestions" role="listbox" id="session-command-suggestions" aria-label="Command suggestions">{suggestions.map((c,i)=><button type="button" role="option" aria-selected={i===commandIndex} id={'session-command-'+i} key={c.name} onMouseDown={e=>e.preventDefault()} onClick={()=>chooseCommand(c)}><strong>/{c.name}</strong><small>{c.description}</small></button>)}{!suggestions.length&&<p>No matching commands available.</p>}</div>}
      <div className="fleet-acp-input"><AcpVoice onBusy={setVoiceBusy} active={active} disabled={sending||!online||running} generation={snapshot?.sessionGeneration} onSend={sendVoice}/><textarea ref={composerInput} role="combobox" aria-autocomplete="list" aria-expanded={showSuggestions} aria-controls={showSuggestions?'session-command-suggestions':undefined} aria-activedescendant={showSuggestions&&suggestions[commandIndex]?'session-command-'+commandIndex:undefined} aria-label="Message agent" placeholder="Message your agent…" value={text} rows={1} onChange={e=>{setText(e.target.value);setSuggestionsHidden(false);setCommandIndex(0);}} onKeyDown={e=>{if(showSuggestions&&!e.nativeEvent.isComposing){if(e.key==='Escape'){e.preventDefault();setSuggestionsHidden(true);return;}if(suggestions.length&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setCommandIndex(i=>(i+(e.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length);return;}if(suggestions[commandIndex]&&(e.key==='Tab'||(e.key==='Enter'&&!e.shiftKey))){e.preventDefault();chooseCommand(suggestions[commandIndex]);return;}}if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>{running&&online?<Button className="fleet-acp-send" aria-label="Stop" title="Stop" type="button" disabled={stopping} onClick={()=>{setStopping(true);void fleet(`/roles/${encodeURIComponent(id)}/interrupt`,{commandId:crypto.randomUUID()}).then(()=>{setReceipt(null);setRevision(r=>r+1);}).catch(e=>setError(e.message)).finally(()=>setStopping(false));}}><Square size={17} fill="currentColor"/></Button>:<Button primary className="fleet-acp-send" aria-label="Send" title="Send" type="submit" disabled={sending||voiceBusy||!online||!text.trim()}><ArrowUp size={20}/></Button>}</div>
    </form>

    {restart&&<DialogShell title={restart==='restart_fresh'?'Force restart agent':'Restart agent'} onClose={()=>setRestart(null)}><AgentLifecycle id={id} action={restart} done={async()=>{setRestart(null);setText('');setRevision(r=>r+1);}}/></DialogShell>}
  </div></I18nProvider>;
}
