import { useLayoutEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { LayoutGroup } from 'framer-motion';
import { SearchInput } from '../ui/SearchInput';
import { ChatList, ContactRow } from '../ui/Chats';
import type { ContactVM } from '../ui/viewmodel';
import { Button } from './components';
import { contact, type Agent, type Task } from './model';
import { NotificationBadge, useNotifications } from './Notifications';
import { countAt } from './notifications';

export type ChatScope = 'All' | 'Workspace' | 'External';
export type WorkspaceView = 'All work' | 'Agents' | 'Tasks';

type Props = {
  agents: Agent[]; tasks: Task[]; contacts: ContactVM[]; task?: Task; selected: string | null;
  scope: ChatScope; workspaceView: WorkspaceView; lifetime: string; search: string;
  setScope: (value: ChatScope) => void; setWorkspaceView: (value: WorkspaceView) => void;
  setLifetime: (value: string) => void; setSearch: (value: string) => void;
  leaveTask: () => void; openChat: (id: string) => void; openExternal: (id: string) => void;
  openRoom: (id: string, showChat?: boolean) => void; taskMenu: (id: string) => void;
  invite: () => void; settings: () => void;
  approve: (id: string) => Promise<boolean>; reject: (id: string) => Promise<boolean>;
};

function Filters<T extends string>({ label, choices, value, change }: { label: string; choices: T[]; value: T; change: (v: T) => void }) {
  return <div className="fleet-chat-filters" role="tablist" aria-label={label}>{choices.map((v, index) => <button key={v} role="tab" aria-selected={value === v} tabIndex={value === v ? 0 : -1} className={value === v ? 'active' : ''} onClick={() => change(v)} onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
    change(choices[next]); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
  }}>{v}</button>)}</div>;
}

function FilterSelect<T extends string>({ label, choices, value, change }: { label: string; choices: T[]; value: T; change: (v: T) => void }) {
  return <span className="fleet-filter-select">
    <select aria-label={label} value={value} onChange={event => change(event.target.value as T)}>
      {choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
    </select>
    <ChevronDown size={14} aria-hidden />
  </span>;
}

export function SessionList(p: Props) {
  const { items } = useNotifications();
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const scrollKey = p.task?.id ?? `${p.scope}:${p.workspaceView}:${p.lifetime}`;
  useLayoutEffect(() => {
    const element = scroll.current;
    if(element) element.scrollTop = positions.current.get(scrollKey) ?? 0;
  }, [scrollKey]);
  const matches = (name: string) => name.toLowerCase().includes(p.search.toLowerCase());
  const row = (id: string, name: string, last: string, onClick: () => void, unread = countAt(items, `chat:${id}`)) => <ContactRow key={id} c={{ ...contact(id, name), last, when: '', unread }} active={p.selected === id} onClick={onClick} />;
  const showWorkspace = p.scope !== 'External';
  const agentsOnly = p.scope === 'Workspace' && p.workspaceView === 'Agents';
  const visibleAgents = p.agents.filter(a => (agentsOnly || !a.taskId) && (!agentsOnly || p.lifetime === 'All agents' || a.lifetime === p.lifetime) && matches(a.name));
  const visibleTasks = p.tasks.filter(t => matches(t.name));
  const visibleContacts = p.contacts.filter(c => !c.id.startsWith('messenger-') && matches(c.name));
  const showAgents = showWorkspace && (p.scope === 'All' || p.workspaceView !== 'Tasks');
  const showTasks = showWorkspace && (p.scope === 'All' || p.workspaceView !== 'Agents');
  const showExternal = p.scope !== 'Workspace';
  const count = (showAgents ? visibleAgents.length : 0) + (showTasks ? visibleTasks.length : 0) + (showExternal ? visibleContacts.length : 0);
  return <LayoutGroup id="fleet-sessions"><div className="listcol">
    <div className="listcol-head fleet-session-head">
      {p.task ? <div className="fleet-session-context"><div className="fleet-task-toolbar"><Button onClick={p.leaveTask}>‹ Back to chats</Button><Button onClick={() => p.taskMenu(p.task!.id)}>Task ⋯</Button></div><div className="fleet-task-summary"><h2>{p.task.name}</h2><p className="muted">{p.task.status} · {p.task.agents.length} agents<NotificationBadge node={`task:${p.task.id}`} /></p></div></div> : <>
        <Filters label="Chat source" choices={['All', 'Workspace', 'External']} value={p.scope} change={p.setScope} />
        {p.scope === 'Workspace' && <div className="fleet-filter-refinements">
          <FilterSelect label="Workspace conversations" choices={['All work', 'Agents', 'Tasks']} value={p.workspaceView} change={p.setWorkspaceView} />
          {agentsOnly && <FilterSelect label="Agent lifetime" choices={['All agents', 'Temporary', 'Persistent']} value={p.lifetime} change={p.setLifetime} />}
        </div>}
      </>}
    </div>
    <div className="fleet-external-list" hidden={p.scope !== 'External' || !!p.task}>
      <ChatList contacts={p.contacts.map(c => ({ ...c, id: c.status === 'pending' ? `pending:${c.id}` : c.id, unread: countAt(items, `chat:${c.id}`) }))} roots={{}} selected={p.selected} onSelect={p.openExternal} onInvite={p.invite} onSettings={p.settings} onApprovePending={p.approve} onRejectPending={p.reject} />
    </div>
    <div ref={scroll} onScroll={event => positions.current.set(scrollKey, event.currentTarget.scrollTop)} className="listcol-scroll" hidden={p.scope === 'External' && !p.task} aria-label={p.task ? `${p.task.name} conversations` : 'Chats'}>
      {p.task ? <div className="conversation-group">
        {matches('Room') && row(`room-${p.task.id}`, 'Room', 'Shared chat', () => p.openRoom(p.task!.id))}
        {p.task.agents.map(id => p.agents.find(a => a.id === id)).filter((a): a is Agent => !!a && matches(a.name)).map(a => row(a.id, a.name, `Direct agent chat · ${a.state}`, () => p.openChat(a.id)))}
      </div> : <div className="conversation-group">
        {showAgents && visibleAgents.map(a => row(a.id, a.name, `${a.lifetime} · ${a.state}`, () => p.openChat(a.id)))}
        {showTasks && visibleTasks.map(t => row(t.id, t.name, `Task · ${t.agents.length} agents · ${t.status}`, () => p.openRoom(t.id, false), countAt(items, `task:${t.id}`)))}
        {showExternal && visibleContacts.map(c => <ContactRow key={c.id} c={{ ...c, last: `External · ${c.kind === 'person' ? 'Person' : 'Agent'}`, unread: countAt(items, `chat:${c.id}`) }} active={p.selected === c.id} onClick={() => p.openExternal(c.id)} onApprove={() => p.approve(c.id)} onReject={() => p.reject(c.id)} />)}
        {!count && <p className="fleet-session-context muted">No chats match these filters.</p>}
      </div>}
    </div>
    <div className="list-bottom-chrome" hidden={p.scope === 'External' && !p.task}><SearchInput value={p.search} onChange={p.setSearch} label={p.task ? 'Search this task' : 'Search chats'} placeholder={p.task ? 'Search this task' : 'Search chats'} /></div>
  </div></LayoutGroup>;
}
