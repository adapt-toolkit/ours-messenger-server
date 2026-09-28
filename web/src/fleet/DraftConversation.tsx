import { AcpVoice, appendTranscript, type VoiceIntent } from './AcpVoice';
import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useConfiguration } from './Configuration';
import { ChatSetup, type DraftAgent } from './ChatSetup';
import { BackButton, Button } from './components';
import { fleet } from './live-api';
import './acp.css';
import { useGlassChrome } from './useGlassChrome';
export function DraftConversation({dark,back,ready,active}:{active:boolean;dark:boolean;back:()=>void;ready:(id:string)=>Promise<void>}) {
 const chrome=useGlassChrome();
 const config=useConfiguration();const keyName=useRef(crypto.randomUUID().slice(0,8));
 const [draft,setDraft]=useState<DraftAgent|null>(null);
 const template=config.data.template.Assistant ?? Object.values(config.data.template).find(t=>t.role?.ref==='Assistant');
 const current:DraftAgent=draft ?? {id:'draft',name:'chat-'+keyName.current,role:template?.role?.ref ?? (config.data.role.Assistant?'Assistant':Object.keys(config.data.role)[0] ?? ''),brain:template?.brain?.ref ?? Object.keys(config.data.brain)[0] ?? '',folder:template?.cwd ?? '',permissions:(template?.permissions?.approval ?? config.defaults.permissions?.approval)==='allow' || (template?.permissions?.filesystem ?? config.defaults.permissions?.filesystem)==='unrestricted'?'Allow · Full access':(template?.permissions?.filesystem ?? config.defaults.permissions?.filesystem)==='read-only'?'Read only':(template?.permissions?.approval ?? config.defaults.permissions?.approval)==='auto'?'Workspace edits':'Ask before changes',unattended:template?.permissions?.unattended ?? config.defaults.permissions?.unattended ?? 'wait'};
 const [voiceBusy,setVoiceBusy]=useState(false);const [hasVoice,setHasVoice]=useState(false);const [text,setText]=useState('');const [prompt,setPrompt]=useState('');const [state,setState]=useState('');const [error,setError]=useState('');const [locked,setLocked]=useState(false);
 const busy=useRef(false);const creation=useRef(crypto.randomUUID());const command=useRef(crypto.randomUUID());const [submitted,setSubmitted]=useState(false);const frozen=useRef<any>();const action=useRef<string>();const role=useRef<string>();const voiceGeneration=useRef<string>();const voiceIntent=useRef<VoiceIntent>();
 async function awaitReady(){
  for(let i=0;i<60;i++){const value=await fleet(`/creation-actions/${action.current}`);if(value.error)throw new Error(value.error.message);if(['session_reachable','attention'].includes(value.state)){role.current=value.roleId;return;}if(value.state==='launched_unconfirmed')throw new Error('Agent is still starting. Check its status before continuing.');await new Promise(r=>setTimeout(r,1000));}
  throw new Error('Agent is still starting. Check its status before continuing.');
 }
 async function deliver(message:string, voice?:VoiceIntent){
  if(busy.current)throw Object.assign(new Error('A message is already being sent.'),{code:'conflict'});
  busy.current=true;setError('');setState('Starting your agent…');setDraft({...current});setLocked(true);setPrompt(message);
  let inputAttempted=false;
  try{
   if(!frozen.current){
    const request={name:current.name,role:{ref:current.role},brain:current.effort!==undefined?{inline:{...config.data.brain[current.brain],effort:current.effort||undefined}}:{ref:current.brain},...(current.folder?{cwd:current.folder}:{}),lifetime:'temporary',permissions:{approval:current.permissions==='Allow · Full access'?'allow':current.permissions==='Workspace edits'?'auto':'ask',filesystem:current.permissions==='Allow · Full access'?'unrestricted':current.permissions==='Read only'?'read-only':'workspace',unattended:current.unattended ?? 'wait'},openAfterCreate:true,...(current.permissions==='Allow · Full access'?{highRiskAcknowledged:true}:{})};
    const preview=await fleet('/roles/preview',request);if(preview.prerequisites?.length)throw new Error(preview.prerequisites.join('; '));
    frozen.current={request:preview.request,previewHash:preview.previewHash,idempotencyKey:creation.current};setSubmitted(true);
   }
   if(!action.current){const result=await fleet('/roles',frozen.current);action.current=result.actionId;}
   await awaitReady();setState('Sending your first message…');
   if(voice && !voiceGeneration.current){const page=await fleet(`/roles/${encodeURIComponent(role.current!)}/conversation?limit=1`);voiceGeneration.current=page.snapshot.sessionGeneration;}
   inputAttempted=true;
   await fleet(`/roles/${encodeURIComponent(role.current!)}/input`,{text:message,commandId:voice?.commandId??command.current,...(voice?{expectedSessionGeneration:voiceGeneration.current}:{})});
   await ready(role.current!);
  }catch(e){if(!inputAttempted)Object.assign(e as Error,{accepted:false});throw e;}finally{busy.current=false;setState('');}
 }
 async function send(){if(!text.trim()||locked||busy.current||voiceBusy)return;try{const message=hasVoice&&text.trimStart().startsWith('/')?'Voice message:\n'+text:text;if(hasVoice)voiceIntent.current={text:message,commandId:command.current};await deliver(message,voiceIntent.current);}catch(e){setError((e as Error).message);}}
 return <div ref={chrome} className="fleet-acp" data-acp-theme={dark?'dark':'light'}><header className="fleet-acp-header"><BackButton label="Back to chats" onClick={back}/><div><strong>New chat</strong><small>Temporary agent</small></div></header><div className="fleet-acp-scroll"><div className="fleet-acp-thread">{config.loaded?<><ChatSetup draft={current} onChange={setDraft} locked={locked||voiceBusy}/><p className="muted">Temporary chats close after 24 hours without activity. Active work and pending approvals keep them open.</p></>:<p role="status">Loading defaults…</p>}{prompt&&<article className="fleet-acp-message user"><small>You</small><p style={{whiteSpace:'pre-wrap'}}>{prompt}</p></article>}{error&&<div role="alert"><p>{error}</p>{!submitted&&<Button onClick={()=>{setLocked(false);setPrompt('');setError('');}}>Edit settings</Button>}{submitted&&<Button onClick={()=>{if(busy.current)return;setError('');void deliver(prompt,voiceIntent.current).catch(e=>setError(e.message));}}>Resume first message</Button>}<p>Your message remains here if it could not be sent.</p></div>}</div></div><form className="fleet-acp-composer" onSubmit={e=>{e.preventDefault();void send();}}><div className="fleet-acp-state" role="status">{state||'Settings lock when you send your first message.'}</div><div className="fleet-acp-input"><AcpVoice onBusy={setVoiceBusy} active={active} disabled={!config.loaded||!current.role||!current.brain||locked} onTranscript={transcript=>{setText(current=>appendTranscript(current,transcript));setHasVoice(true);}}/><textarea aria-label="Message agent" placeholder="Message your agent…" rows={1} value={text} readOnly={locked} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><Button primary className="fleet-acp-send" aria-label="Send" type="submit" disabled={locked||voiceBusy||!config.loaded||!current.role||!current.brain||!text.trim()}><ArrowUp size={20}/></Button></div></form></div>;
}
