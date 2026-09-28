import { MessageCircle, Users, Bot, ClipboardList, Link, ScanLine, FolderInput, Ban, Trash2, Folder, CheckCheck, Archive, XCircle, Unlock } from 'lucide-react';
import { useEffect, useState } from 'react';
import DialogShell from '../ui/DialogShell';
import { Button, Field, Row, Property, MenuAction } from './components';
import { Navigation } from './Navigation';
import { useConfiguration } from './Configuration';
import { NotificationPanel } from './Notifications';
import { fleet, messenger } from './live-api';
import type { Agent, Task, Page, Modal, Section } from './model';
export function LiveDialogs(p: { modal: NonNullable<Modal>; close: () => void; setModal: (m: Modal) => void; section: Section;
  agents: Agent[]; tasks: Task[]; lists: string[]; go: (p: Page) => void; switchSection: (s: Section) => void;
  openChat: (id: string, s?: Section) => void; refresh: () => Promise<void>; notify: (s: string) => void; newChat: () => void; closedChat: (id:string) => void }) {
  const { modal: m } = p;
  const configuration = useConfiguration();
  useEffect(() => { void configuration.refresh().catch(() => {}); }, [m.kind]);
  const [name, setName] = useState('');
  const [value, setValue] = useState(['new-agent', 'new-chat'].includes(m.kind) ? Object.keys(configuration.data.role)[0] ?? '' : '');
  const [list, setList] = useState(['new-agent', 'new-chat'].includes(m.kind) ? Object.keys(configuration.data.brain)[0] ?? '' : p.lists.find(l => m.kind !== 'delete-list' || l !== m.id) ?? 'default');
  const [template, setTemplate] = useState(Object.keys(configuration.data.tasks)[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removal,setRemoval]=useState<any>(null);
  useEffect(()=>{if(m.kind==='finish-chat')fleet(`/roles/${encodeURIComponent(m.id!)}/removal-preview`).then(setRemoval).catch(e=>setError(e.message));},[m.kind,m.id]);
  const [result, setResult] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  useEffect(() => { if (!configuration.loaded) return; if (['new-agent','new-chat'].includes(m.kind)) { if (!value) setValue(Object.keys(configuration.data.role)[0] ?? ''); if (!list) setList(Object.keys(configuration.data.brain)[0] ?? ''); } }, [configuration.loaded, configuration.data, m.kind]);
  const task = p.tasks.find(t => t.id === m.id);
  const agent = p.agents.find(a => a.id === m.id);
  const next = (kind: string, id = m.id) => p.setModal({ kind, id });
  const run = async (fn: () => Promise<unknown>, close = true) => {
    setBusy(true); setError('');
    try { const value = await fn(); if (!close) setResult(JSON.stringify(value, null, 2)); await p.refresh(); if (close) p.close(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const terminal = async (action: string) => { const result = await fleet(`/tasks/${m.id}/${action}`, {}); if (result.pending) throw new Error(result.task?.terminal_intent?.error ?? 'Request accepted. Room cleanup is still pending; check the task status.'); return result; };
  const input = (label: string, val: string, setter: (x: string) => void) => <Field label={label}><input value={val} onChange={e => { setter(e.target.value); setResult(''); }} /></Field>;
  const chooseList = <Field label="List"><select value={list} onChange={e => setList(e.target.value)}>{p.lists.filter(l => m.kind !== 'delete-list' || l !== m.id).map(l => <option key={l}>{l}</option>)}</select></Field>;
  let title = 'Fleet'; let body;
  switch (m.kind) {
    case 'notifications': title = 'Notifications'; body = <NotificationPanel open={target => p.openChat(target.chat, target.section)} />; break;
    case 'navigation': title = 'Navigation'; body = <Navigation current={p.section} select={p.switchSection} notifications={() => next('notifications')} profile={() => p.go({ kind: 'profile', id: 'human' })} settings={() => p.go({ kind: 'settings' })} />; break;
    case 'add': title = 'Add or connect'; body = <>{([{kind:'new-chat',title:'New chat',icon:MessageCircle},{kind:'new-agent',title:'New agent',icon:Bot},{kind:'new-task',title:'New task',icon:ClipboardList},{kind:'generate',title:'Generate invite',icon:Link},{kind:'accept',title:'Accept invite',icon:ScanLine}]).map(({kind,title,icon}) => <MenuAction key={kind} title={title} icon={icon} onClick={() => kind==='new-chat' ? p.newChat() : next(kind)} />)}</>; break;
    case 'new-task': title = 'Create task'; body = <>{input('Task name', name, setName)}<Field label="Description"><textarea value={value} onChange={e => setValue(e.target.value)} /></Field>{chooseList}<Field label="Task template"><select value={template} onChange={e => setTemplate(e.target.value)}><option value="">Fleet default</option>{Object.keys(configuration.data.tasks).map(id => <option key={id}>{id}</option>)}</select></Field><p>Room templates come from this Fleet’s configuration. Save to Backlog, then start from the task page.</p><Button primary disabled={busy || !name.trim()} onClick={() => run(() => fleet('/tasks', { title: name, brief: value, list, ...(template ? { template } : {}), backlog: true, idempotencyKey: key }))}>Create task</Button></>; break;
    case 'lists': title = 'Manage lists'; body = <>{p.lists.map(l => <MenuAction key={l} title={l} icon={Folder} disabled={l === 'default'} onClick={() => next('delete-list', l)} />)}<Button onClick={() => next('new-list')}>New list</Button></>; break;
    case 'new-list': title = 'New list'; body = <>{input('List name', name, setName)}<Button disabled={busy || !name.trim()} onClick={() => run(() => fleet('/task-lists', { name }))}>Create list</Button></>; break;
    case 'delete-list': title = `Delete list ${m.id}`; body = <>{chooseList}<Button disabled={busy || list === m.id} onClick={() => run(() => fleet(`/task-lists/${encodeURIComponent(m.id!)}?destination=${encodeURIComponent(list)}`, undefined, 'DELETE'))}>Move tasks and delete list</Button></>; break;
    case 'move-task': title = 'Move task'; body = <>{chooseList}<Button disabled={busy} onClick={() => run(() => fleet(`/tasks/${m.id}/list`, { list }, 'PATCH'))}>Move task</Button></>; break;
    case 'task-menu': title = task?.name ?? 'Task'; body = <>{([{kind:'move-task',title:'Move to list',icon:FolderInput},{kind:'block-task',title:'Block task',icon:Ban},{kind:'delete-task',title:'Delete task',icon:Trash2}]).map(({kind,title,icon}) => <MenuAction key={kind} title={title} icon={icon} danger={kind==='delete-task'} onClick={() => next(kind)} />)}{task?.blocked && <MenuAction title="Unblock" icon={Unlock} disabled={busy} onClick={() => run(() => fleet(`/tasks/${m.id}/unblock`, {}))} />}<MenuAction title="Send to review" icon={CheckCheck} disabled={busy} onClick={() => run(() => fleet(`/tasks/${m.id}/review`, {}))} /><MenuAction title="Finish task" icon={Archive} disabled={busy} onClick={() => run(() => terminal('finish'))} /><MenuAction title="Cancel task" icon={XCircle} disabled={busy} onClick={() => run(() => terminal('cancel'))} /></>; break;
    case 'block-task': title = 'Block task'; body = <>{input('Reason', value, setValue)}<Button disabled={busy || !value.trim()} onClick={() => run(() => fleet(`/tasks/${m.id}/block`, { reason: value }))}>Block task</Button></>; break;
    case 'delete-task': title = 'Delete task'; body = <><p>Delete this task and its owned room and agents.</p>{input(`Repeat task ID: ${m.id}`, value, setValue)}<Button disabled={busy || value !== m.id} onClick={() => run(async () => { const result = await fleet(`/tasks/${m.id}?confirm=${encodeURIComponent(value)}`, undefined, 'DELETE'); if (!result.deleted && !result.already_absent) throw new Error('Deletion accepted; cleanup is still pending. Refresh to check progress.'); })}>Delete task</Button></>; break;
    case 'stop-agent': title='Stop agent';body=<><p>Stop this persistent agent. Its configuration and session history are kept.</p><Button disabled={busy} onClick={()=>run(async()=>{const action=await fleet(`/roles/${encodeURIComponent(m.id!)}/actions`,{action:'stop',actionId:key});for(let i=0;i<30;i++){const receipt=await fleet(`/actions/${action.actionId}`);if(receipt.state==='succeeded'){p.notify('Agent stopped.');return;}if(['failed','uncertain'].includes(receipt.state))throw new Error(receipt.error?.message??'The stop result is not confirmed.');await new Promise(r=>setTimeout(r,1000));}throw new Error('Stop is still pending. Check the agent status.');})}>Stop agent</Button></>;break;
    case 'finish-chat': title='Finish chat'; body=<><p>Stop this temporary agent and archive its session history.</p>{removal?.lifetime==='temporary' ? <Button disabled={busy} onClick={()=>run(async()=>{const result=await fleet(`/roles/${encodeURIComponent(m.id!)}/remove`,{confirmed:true});if(!result.removed)throw new Error('Closure has not been confirmed.');p.closedChat(m.id!);p.notify('Chat finished; session history archived.');})}>Finish chat</Button> : !error&&<p>{removal?'This agent is not a temporary chat.':'Checking chat…'}</p>}</>;break;
    case 'agent-generate': title = `Invite to ${agent?.name ?? m.id}`; body = <><p>The invitation belongs to this agent’s identity.</p><Button disabled={busy || !!result} onClick={() => run(async () => {
      const response = await fleet(`/roles/${encodeURIComponent(m.id!)}/ours/call`, { tool:'generate_invite', arguments:{mode:'one_time'} });
      if (response.result.isError) throw new Error('Agent could not generate the invite. Check its status before trying again.');
      const text = response.result.content?.filter((c:any) => c.type === 'text').map((c:any)=>c.text).join('\n') ?? '';
      const blob = response.result.structuredContent?.blob ?? text.trim().split(/\n\s*\n/).at(-1);
      if (!blob || !/^[A-Za-z0-9+/=_-]+$/.test(blob)) throw new Error('Invite created, but its format was not recognized. Do not generate another automatically.');
      return {blob};
    }, false)}>Generate one-time invite</Button></>; break;
    case 'agent-accept': title = `Accept invite as ${agent?.name ?? m.id}`; body = <><Field label="Invitation code"><textarea value={value} onChange={e=>setValue(e.target.value)}/></Field><Button disabled={busy || !value.trim()} onClick={() => run(async () => { const response = await fleet(`/roles/${encodeURIComponent(m.id!)}/ours/call`, {tool:'add_contact',arguments:{invite:value.trim()}}); if(response.result.isError) throw new Error('Agent could not accept this invitation. Check its state before trying again.'); return response; })}>Accept invite</Button></>; break;
    case 'new-chat':
    case 'new-agent': title = m.kind === 'new-chat' ? 'New chat' : 'Create agent'; body = <><p>This creates a temporary agent. Role and Brain options come from this Fleet’s configuration.</p>{input('Agent name', name, setName)}<Field label="Role"><select value={value} onChange={e => { setValue(e.target.value); setResult(''); }}>{Object.keys(configuration.data.role).map(id => <option key={id}>{id}</option>)}</select></Field><Field label="Brain"><select value={list} onChange={e => { setList(e.target.value); setResult(''); }}>{Object.entries(configuration.data.brain).map(([id,brain]) => <option key={id} value={id}>{brain.harness} · {brain.model ?? 'Default model'} · {brain.effort ?? 'Default effort'}</option>)}</select></Field><Button disabled={busy || !name || !value || !list} onClick={() => run(async () => { const request = { name, brain: { ref: list }, role: { ref: value }, lifetime: 'temporary', permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' }, openAfterCreate: true }; const preview = await fleet('/roles/preview', request); setResult(JSON.stringify(preview, null, 2)); return preview; }, false)}>Preview creation</Button><p>Review the effective settings and prerequisites before creating.</p>{result && JSON.parse(result).previewHash && <Button disabled={busy || JSON.parse(result).prerequisites?.length > 0} onClick={() => run(async () => { const preview = JSON.parse(result); const action = await fleet('/roles', { request: preview.request, previewHash: preview.previewHash, idempotencyKey: key }); for (let attempt = 0; attempt < 60; attempt++) { const current = await fleet(`/creation-actions/${action.actionId}`); setResult(JSON.stringify(current, null, 2)); if (current.error) throw new Error(current.error.message); if (current.state === 'launched_unconfirmed') throw new Error('Launch requested, but the session is not reachable yet. Check the agent status before trying again.'); if (['session_reachable', 'attention'].includes(current.state)) { p.openChat(current.roleId); return current; } await new Promise(resolve => setTimeout(resolve,1000)); } throw new Error('Creation is still running. Check the agent list before starting another session.'); })}>Create reviewed agent</Button>}</>; break;
    case 'generate': title = 'Generate invite'; body = <><p>Invite someone to the local Messenger identity.</p><Button disabled={busy} onClick={() => run(() => messenger.createInvite(), false)}>Generate one-time invite</Button></>; break;
    case 'accept': title = 'Accept invite'; body = <><Field label="Invitation code"><textarea value={value} onChange={e => setValue(e.target.value)} /></Field><Button disabled={busy || !value.trim()} onClick={() => run(() => messenger.addContact(value))}>Accept invite</Button></>; break;
    case 'members': title = 'Task agents'; body = <>{task?.agents.map(id => <Row key={id} title={p.agents.find(a => a.id === id)?.name ?? id} onClick={() => p.openChat(id)} />)}</>; break;
    default: title = 'Not available'; body = <p>This operation is not connected in this local version.</p>;
  }
  return <DialogShell title={title} onClose={p.close} className="fleet-modal"><div className="fleet-dialog-content">{body}{busy && <p role="status">Waiting for server…</p>}{error && <p role="alert">{error}</p>}{result && <ActionResult value={JSON.parse(result)} />}</div></DialogShell>;
}

function ActionResult({ value }: { value: any }) {
  if (value.previewHash) return <section aria-label="Creation review"><h3>{value.effective.name}</h3><p>{value.effective.lifetime} agent · {value.effective.harness} · {value.effective.model ?? 'Default model'}</p><Property title="Working folder" subtitle={value.effective.cwd ?? 'Fleet default'} /><Property title="Permissions" subtitle={`${value.effective.permissions.approval} approval · ${value.effective.permissions.filesystem} files · unattended ${value.effective.permissions.unattended}`} />{value.warnings.map((warning: string) => <p key={warning}>{warning}</p>)}{value.prerequisites.map((issue: string) => <p role="alert" key={issue}>{issue}</p>)}</section>;
  if (value.blob) return <Field label="Invitation code"><textarea readOnly value={value.blob} onFocus={e => e.target.select()} /></Field>;
  return <section role="status"><p>{value.state ?? (value.accepted ? 'Request accepted' : 'Server response received')}</p>{value.roleId && <p>{value.roleId}</p>}{value.error && <p role="alert">{value.error.message ?? String(value.error)}</p>}</section>;
}
