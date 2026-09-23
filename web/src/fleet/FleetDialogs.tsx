import { useEffect, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { Link, ScanLine, Users, MessageCircle, SlidersHorizontal, Trash2, UserRound, Bot, ClipboardList, UserPlus, Square, FolderInput, Ban, CheckCheck, Archive, XCircle, Activity } from 'lucide-react';
import { NotificationPanel } from './Notifications';
import { Navigation } from './Navigation';
import { FolderPicker } from './FolderPicker';
import DialogShell from '../ui/DialogShell';
import { Button, Field, Row, SearchField, MenuAction } from './components';
import type { Agent, Task, Page, Modal, Section } from './model';
interface Props {
  embedded?: boolean;
  newChat: () => void;
  section: Section;
  modal: NonNullable<Modal>; close: () => void; setModal: (m: Modal) => void;
  agents: Agent[]; setAgents: Dispatch<SetStateAction<Agent[]>>;
  tasks: Task[]; setTasks: Dispatch<SetStateAction<Task[]>>;
  lists: string[]; setLists: Dispatch<SetStateAction<string[]>>; taskId?: string;
  openChat: (id: string, s?: Section) => void; openRoom: (id: string, show?: boolean) => void;
  go: (p: Page) => void; switchSection: (s: Section) => void; notify: (s: string) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
}
export function FleetDialogs(p: Props) {
  const { modal: m, close, setModal, agents, tasks, notify } = p;
  const agent = agents.find(a => a.id === m.id);
  const task = tasks.find(t => t.id === (m.id ?? p.taskId));
  const actor = agents.find(a => a.id === m.actor)?.name ?? (m.actor?.startsWith('room-') ? tasks.find(t => t.id === m.actor?.slice(5))?.name : null) ?? 'Vitalii Shakhmatov';
  const [name, setName] = useState(m.kind === 'new-task' ? 'Launch website' : m.kind === 'new-list' ? '' : 'Tester');
  const lifetime = m.kind === 'new-agent' ? 'Persistent' : 'Temporary';
  const [template, setTemplate] = useState(m.kind === 'new-task' ? 'pair' : 'Tester');
  const [direct, setDirect] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folder, setFolder] = useState('/home/you/work/website');
  const [brain, setBrain] = useState('Codex');
  const [permissions, setPermissions] = useState('Read-only review');
  const [value, setValue] = useState('');
  const [targetList, setTargetList] = useState(p.lists.find(l => l !== task?.list) ?? 'Default');
  const [inviteType, setInviteType] = useState('One-time');
  const [generated, setGenerated] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => {
    if(m.kind === 'new-task') { setName('Launch website'); setTemplate('pair'); }
    if(m.kind === 'new-agent' || m.kind === 'add-agent') { setName('Tester'); setTemplate('Tester'); setDirect(false); }
    if(m.kind === 'new-list') setName('');
    if(m.kind === 'generate') { setGenerated(null); setInviteType('One-time'); }
    if(m.kind === 'delete-task' || m.kind === 'block-task') setValue('');
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('.fleet-modal input, .fleet-modal textarea, .fleet-modal select, .fleet-modal .fleet-dialog-content button')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [m.kind, m.actor]);
  let title = ''; let body: ReactNode;
  const next = (kind: string, id = m.id) => setModal({ kind, id, actor: m.actor, locked: m.locked });
  const actions = (label: string, action: () => void, disabled = false) => <div className="fleet-dialog-actions"><Button onClick={close}>Cancel</Button><Button primary disabled={disabled} onClick={action}>{label}</Button></div>;
  const select = (label: string, val: string, change: (v: string) => void, choices: string[]) => <Field label={label}><select value={val} onChange={e => change(e.target.value)}>{choices.map(c => <option key={c}>{c}</option>)}</select></Field>;
  const folderPicker = <><Row title="Working folder" subtitle={`Workstation ${folder}`} onClick={() => setFolderOpen(true)} /></>;
  const makeAgent = (taskId?: string) => {
    const id = `agent-${crypto.randomUUID()}`;
    const a: Agent = { id, name: name.trim() || template, lifetime: taskId ? 'Temporary' : lifetime as Agent['lifetime'], state: 'Ready', role: template, folder, taskId, brain, permissions };
    p.setAgents(x => [...x, a]);
    if(taskId) p.setTasks(x => x.map(t => t.id === taskId ? { ...t, agents: [...t.agents, id] } : t));
    p.openChat(id); notify(`${a.name} created · ${a.lifetime}`);
  };
  const closeTask = (remove = false) => {
    if(!task) return;
    p.setAgents(x => x.filter(a => !task.agents.includes(a.id)));
    if(remove) { p.setTasks(x => x.filter(t => t.id !== task.id)); p.switchSection('tasks'); }
    else p.updateTask(task.id, { agents: [], closed: true, status: m.kind === 'cancel-task' ? 'Cancelled' : 'Done' });
    close(); notify(remove ? 'Task deleted' : 'Task closed');
  };
  switch(m.kind) {
    case 'navigation': title = 'Navigation'; body = <Navigation notifications={() => next('notifications')} current={p.section} select={p.switchSection} profile={() => p.go({ kind: 'profile', id: 'human' })} settings={() => p.go({ kind: 'settings' })} />; break;
    case 'notifications': title = 'Notifications'; body = <NotificationPanel open={target => p.openChat(target.chat, target.section)} />; break;
    case 'add': title = 'Add or connect'; body = <><MenuAction title="Generate invite" icon={Link} onClick={() => next('generate')} /><MenuAction title="Accept invite" icon={ScanLine} onClick={() => next('accept')} /><div className="fleet-menu-divider" /><MenuAction title="New chat" description="Starts a chat with a temporary agent" icon={MessageCircle} onClick={p.newChat} /><MenuAction title="New persistent agent" description="Creates an agent you can return to across tasks" icon={Bot} onClick={() => next('new-agent')} /><MenuAction title="New task" description="Groups agents and a shared room around one task" icon={ClipboardList} onClick={() => next('new-task')} />{p.taskId && <MenuAction title="Add to this task" icon={UserPlus} onClick={() => next('add-agent', p.taskId)} />}</>; break;
    case 'new-agent': case 'add-agent': {
      title = m.kind === 'add-agent' ? 'Add task agent' : 'New persistent agent';
      body = <><p>{m.kind === 'add-agent' ? task?.name : 'An agent that stays in your fleet.'}</p><Field label="Agent name"><input value={name} onChange={e => setName(e.target.value)} /></Field>{select(direct ? 'Role' : 'Agent Template', template, setTemplate, ['Tester', 'Developer', 'Critic', 'Writer', 'Researcher', 'Coordinator'])}{direct ? <>{select('Brain', brain, setBrain, ['Codex', 'Claude'])}{select('Permissions', permissions, setPermissions, ['Read-only review', 'Workspace edits', 'Restricted workspace'])}<details><summary>Edit reusable definitions</summary><p>Definitions are managed in Settings. These session selections stay separate.</p><a href="/fleet/settings" target="_blank" rel="noreferrer">Open Settings separately ↗</a></details></> : <Button onClick={() => setDirect(true)}>More options</Button>}{folderPicker}<Row title="Destination" subtitle={m.kind === 'add-agent' ? `${task?.name} → ${name}` : `Chats → Workspace → ${name}`} />{lifetime === 'Persistent' && <p>Stopping this agent keeps its saved definition.</p>}{actions(m.kind === 'add-agent' ? `Add ${name || template}` : `Create ${lifetime.toLowerCase()} agent`, () => makeAgent(m.kind === 'add-agent' ? m.id : undefined), !name.trim())}</>; break;
    }
    case 'new-task': title = 'Start a task session'; body = <><p>One work container, direct chats for each agent, and a shared room.</p><Field label="Task name"><input value={name} onChange={e => setName(e.target.value)} /></Field><div className="fleet-template-options">{[['single', 'Developer'], ['pair', 'Developer + Critic'], ['team', 'LocalCoordinator + Developer + Critic'], ['custom', 'Create an empty room; add temporary agents later']].map(([key, label]) => <Button key={key} primary={template === key} onClick={() => setTemplate(key)} aria-pressed={template === key}><strong>{key === 'custom' ? 'Empty / custom' : key}</strong><small>{label}</small></Button>)}</div>{folderPicker}{actions('Create task session', () => { const id = `task-${crypto.randomUUID().slice(0, 8)}`; const roles = template === 'custom' ? [] : template === 'single' ? ['Developer'] : template === 'pair' ? ['Developer', 'Critic'] : ['LocalCoordinator', 'Developer', 'Critic']; const newAgents: Agent[] = roles.map(role => ({ id: `agent-${crypto.randomUUID()}`, name: role, lifetime: 'Temporary', state: 'Ready', role, folder, taskId: id })); p.setAgents(x => [...x, ...newAgents]); p.setTasks(x => [...x, { id, name: name.trim(), list: 'Default', status: roles.length ? 'Provisioning' : 'Active', description: 'Work together and provide verification evidence.', agents: newAgents.map(a => a.id) }]); p.go({ kind: 'task', id }); setModal({ kind: roles.length ? 'provisioning' : 'empty-task', id }); }, !name.trim())}</>; break;
    case 'provisioning': title = 'Preparing task'; body = <><h2>{task?.name}</h2><Row title="Shared room" subtitle="Created" />{task?.agents.map(id => <Row key={id} title={agents.find(a => a.id === id)?.name ?? 'Agent'} subtitle="Ready · Briefing delivered" />)}<Row title="Room admission & briefing" subtitle="Ready to continue" /><Button primary onClick={() => { if(task) { p.updateTask(task.id, { status: 'Active' }); p.openRoom(task.id, false); } }}>Open task</Button>{task?.agents[0] && <Button onClick={() => p.openChat(task.agents[0])}>Open Developer chat</Button>}</>; break;
    case 'empty-task': title = task?.name ?? 'Task session'; body = <><p>Custom task session · Room created · No agents yet</p><Row title="Agents · 0" subtitle="Add your first temporary task agent" onClick={() => next('add-agent')} /><Row title="Shared room · Ready" subtitle="You are the only participant" onClick={() => task && p.openRoom(task.id)} /><Row title="Invite an external participant" onClick={() => setModal({ kind: 'generate', actor: `room-${task?.id}` })} />{folderPicker}<Button primary onClick={() => next('add-agent')}>Add agent</Button></>; break;
    case 'agent-menu': title = agent?.name ?? 'Agent'; body = <><p className="muted">{agent?.lifetime} agent · Workstation</p>{agent?.taskId && <><MenuAction title="Room" icon={Users} onClick={() => p.openRoom(agent.taskId!)} /><MenuAction title="View task" icon={ClipboardList} onClick={() => p.go({ kind: 'task', id: agent.taskId! })} /><div className="fleet-menu-divider" /></>}<MenuAction title="Generate invite" icon={Link} onClick={() => setModal({ kind: 'generate', actor: agent!.id, locked: true })} /><MenuAction title="Accept invite" icon={ScanLine} onClick={() => setModal({ kind: 'accept', actor: agent!.id, locked: true })} /><MenuAction title="Contacts & conversations" icon={Users} onClick={() => p.go({ kind: 'contacts', id: agent!.id })} /><MenuAction title="Message agent" icon={MessageCircle} onClick={() => p.openChat(`messenger-${agent!.id}`, 'messenger')} /><div className="fleet-menu-divider" /><MenuAction title="Session details" icon={SlidersHorizontal} onClick={() => next('session-details')} /><MenuAction title="Profile" icon={UserRound} onClick={() => p.go({ kind: 'profile', id: agent!.id })} /><MenuAction title={agent?.lifetime === 'Persistent' ? 'Stop agent' : 'Delete session'} icon={agent?.lifetime === 'Persistent' ? Square : Trash2} danger onClick={() => next(agent?.lifetime === 'Persistent' ? 'stop-agent' : 'delete-agent')} /></>; break;
    case 'session-details': title = 'Session details'; body = <>{[['Template', agent?.role], ['Role', agent?.role], ['Brain', agent?.brain ?? 'Codex'], ['Permissions', agent?.permissions ?? 'Restricted workspace'], ['Folder', agent?.folder], ['Lifetime', agent?.lifetime]].map(([title, subtitle]) => <Row key={title} title={title!} subtitle={subtitle} />)}<Button onClick={() => next('agent-menu')}>Back</Button></>; break;
    case 'task-menu': title = task?.name ?? 'Task actions'; body = <div className="fleet-task-menu">
      <MenuAction title="Move to list" icon={FolderInput} onClick={() => next('move-task')} />
      <MenuAction title="Block task" icon={Ban} onClick={() => next('block-task')} />
      <MenuAction title="Finish & close room" icon={CheckCheck} onClick={() => next('finish-task')} />
      <MenuAction title="Close task" icon={Archive} onClick={() => next('close-task')} />
      {task?.status === 'Provisioning' && <MenuAction title="View provisioning" icon={Activity} onClick={() => next('provisioning')} />}
      <MenuAction title="View task" icon={ClipboardList} onClick={() => p.go({ kind: 'task', id: m.id! })} />
      <div className="fleet-menu-divider" />
      <MenuAction title="Cancel task" icon={XCircle} onClick={() => next('cancel-task')} />
      <MenuAction title="Delete task" icon={Trash2} danger onClick={() => next('delete-task')} />
    </div>; break;
    case 'move-task': title = 'Move task'; body = <><p>{task?.name}</p>{select('Move to list', targetList, setTargetList, p.lists)}{actions('Move task', () => { p.updateTask(m.id!, { list: targetList }); close(); notify('Task moved'); })}</>; break;
    case 'block-task': title = 'Block task'; body = <><p>{task?.name}</p><Field label="Reason"><textarea placeholder="Waiting for the final copy from the owner." value={value} onChange={e => setValue(e.target.value)} /></Field>{actions('Block task', () => { p.updateTask(m.id!, { blocked: value }); close(); }, !value.trim())}</>; break;
    case 'finish-task': case 'close-task': case 'cancel-task': case 'delete-task': {
      const verb = m.kind === 'finish-task' ? 'Finish' : m.kind === 'close-task' ? 'Close' : m.kind === 'cancel-task' ? 'Cancel' : 'Delete'; title = `${verb} this task?`; body = <><p>This will {verb.toLowerCase()} {task?.name}, {verb === 'Delete' ? 'delete' : 'close'} its room and delete this task’s agents.</p>{verb === 'Delete' && <Field label={`Task ID · ${task?.id}`}><input placeholder="Repeat task ID to confirm" value={value} onChange={e => setValue(e.target.value)} /></Field>}{actions(`${verb} task`, () => closeTask(verb === 'Delete'), verb === 'Delete' && value !== task?.id)}</>; break;
    }
    case 'delete-agent': case 'stop-agent': case 'remove-agent': {
      const stop = m.kind === 'stop-agent'; title = stop ? 'Stop this agent?' : m.kind === 'remove-agent' ? 'Remove this agent?' : 'Delete this session?'; body = <><p>{stop ? `${agent?.name} will stop until you start it again.` : `${agent?.name} will leave this task’s room and its temporary session will be deleted.`}</p>{actions(stop ? 'Stop agent' : m.kind === 'remove-agent' ? 'Remove agent' : 'Delete session', () => { if(stop) p.setAgents(x => x.map(a => a.id === m.id ? { ...a, state: 'Stopped' } : a)); else { p.setAgents(x => x.filter(a => a.id !== m.id)); p.setTasks(x => x.map(t => ({ ...t, agents: t.agents.filter(id => id !== m.id) }))); p.openChat('coordinator'); } close(); notify(stop ? 'Agent stopped' : 'Agent removed'); })}</>; break;
    }
    case 'lists': title = 'Manage lists'; body = <>{p.lists.map(l => <div className="fleet-member" key={l}><Row title={l} subtitle={l === 'Default' ? 'System list' : `${tasks.filter(t => t.list === l).length} tasks`} />{l !== 'Default' && <Button onClick={() => next('delete-list', l)}>Delete</Button>}</div>)}<Button primary onClick={() => next('new-list')}>New list</Button></>; break;
    case 'new-list': title = 'New list'; body = <><Field label="List name"><input value={name} onChange={e => setName(e.target.value)} /></Field>{actions('Create list', () => { p.setLists(x => [...x, name.trim()]); next('lists'); }, !name.trim() || p.lists.includes(name.trim()))}</>; break;
    case 'delete-list': title = 'Delete this list?'; body = <><p>Move {m.id}’s tasks to another list, then delete {m.id}.</p>{select('Move tasks to', targetList === m.id ? 'Default' : targetList, setTargetList, p.lists.filter(l => l !== m.id))}{actions('Delete list', () => { p.setTasks(x => x.map(t => t.list === m.id ? { ...t, list: targetList === m.id ? 'Default' : targetList } : t)); p.setLists(x => x.filter(l => l !== m.id)); next('lists'); })}</>; break;
    case 'generate': title = 'Generate an invite'; body = <><Row title={actor} subtitle={m.actor?.startsWith('room-') ? 'Shared room' : m.actor ? 'Agent' : 'Human identity'} />{generated ? <><p>{inviteType} invitation</p><Field label="Invitation code"><textarea readOnly value={generated} /></Field><Button primary onClick={() => { void navigator.clipboard.writeText(generated).then(() => notify('Invitation copied')).catch(() => notify('Copy unavailable. Select and copy the code.')); }}>Copy invitation</Button></> : <>{select('Invitation type', inviteType, setInviteType, ['One-time', 'Public'])}<p>{inviteType === 'One-time' ? 'One connection' : 'Multiple connections'}</p><Button primary onClick={() => setGenerated(`ours://preview-invite/${m.actor ?? 'myself'}/${crypto.randomUUID()}`)}>Generate an invite</Button></>}</>; break;
    case 'accept': title = 'Accept invite'; body = <><Row title={actor} subtitle={m.actor ? 'Agent · Vitalii · Work' : 'Human identity'} /><Field label="Invitation code"><textarea placeholder="Paste invitation code" value={value} onChange={e => setValue(e.target.value)} /></Field><Button primary disabled={!value.trim()} onClick={() => { next('admission'); }}>{m.actor ? `Accept as ${actor}` : 'Accept invite'}</Button>{!m.locked && <Button onClick={() => next('agent-picker')}>Accept on behalf of an agent</Button>}</>; break;
    case 'agent-picker': title = 'Choose an agent'; body = <><SearchField value={search} onChange={setSearch} placeholder="Search agents" />{agents.filter(a => a.name.toLowerCase().includes(search.toLowerCase())).map(a => <Row key={a.id} title={a.name} subtitle="Vitalii · Work" onClick={() => setModal({ kind: 'accept', actor: a.id, locked: true })} />)}<Button onClick={() => setModal({ kind: 'accept' })}>Back</Button></>; break;
    case 'members': title = 'Room members'; body = <><h2>{task?.name}</h2>{task && <Row title="View task" onClick={() => p.go({ kind: 'task', id: task.id })} />}<Row title="You" subtitle="Owner · Joined" onClick={() => p.go({ kind: 'profile', id: 'human' })} />{task?.agents.map(id => <Row key={id} title={agents.find(a => a.id === id)?.name ?? 'Agent'} subtitle="Internal agent · Joined" onClick={() => p.go({ kind: 'profile', id })} />)}<Row title="Alex’s reviewer" subtitle="External Critic · Joined" onClick={() => p.go({ kind: 'profile', id: 'alex-reviewer' })} /><Row title="Alex" subtitle="Invited as Tester" onClick={() => next('admission')} /><Row title="Critic" subtitle="Awaiting verification" onClick={() => next('admission')} /><Button primary onClick={() => setModal({ kind: 'generate', actor: `room-${m.id}` })}>Invite participant</Button><Button onClick={() => next('room-info')}>Room information</Button></>; break;
    case 'admission': title = 'Joining room'; body = <><Row title={m.actor ? actor : 'Maya’s reviewer'} subtitle="Your agent · Critic" /><Row title="Launch website" subtitle="Room · Alex" /><Row title="Invite accepted" subtitle="Complete" /><Row title="Room verification" subtitle={admitted ? 'Complete' : 'In progress'} /><Row title="Task briefing" subtitle={admitted ? 'Delivered' : 'Waiting for admission'} />{admitted ? <Button primary onClick={() => p.openRoom('0mu1gv4ndd96af6f4')}>Open room</Button> : <Button primary onClick={() => setAdmitted(true)}>Preview completed admission</Button>}<Button onClick={() => next('room-info')}>Room information</Button></>; break;
    case 'room-info': title = 'Room information'; body = <><Row title="Room messages" subtitle="Shared with room members" /><Row title="Direct chats" subtitle="Visible only to chat participants" /><Row title="Your agent" subtitle="Stays under your control" /><Button onClick={() => next('admission')}>Back to admission</Button></>; break;
    case 'tool-output': title = 'Read files · Output'; body = <><pre className="fleet-output">{`$ inspect index.html styles.css app.tsx\n\n✓ Heading hierarchy is sequential.\n✓ Form controls have accessible labels.\n✓ Mobile layout uses a single conversation pane.\n\n3 files inspected. No changes made.\nNext step: npm test`}</pre><Button onClick={close}>Done</Button></>; break;
    default: title = 'Details'; body = <Button onClick={close}>Done</Button>;
  }
  if(folderOpen) { title = 'Choose folder'; body = <FolderPicker value={folder} onCancel={() => setFolderOpen(false)} onSelect={value => { setFolder(value); setFolderOpen(false); }} />; }
  if(p.embedded) return <div className="fleet-dialog-content"><Button onClick={close}>‹ Contacts</Button><h2>{title}</h2>{body}</div>;
  return <DialogShell title={title} onClose={folderOpen ? () => setFolderOpen(false) : close} className="fleet-modal"><div className="fleet-dialog-content">{body}</div></DialogShell>;
}
