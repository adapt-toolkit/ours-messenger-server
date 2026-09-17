import { LayoutGroup } from 'framer-motion';
import { SearchInput } from '../ui/SearchInput';
import { ContactRow } from '../ui/Chats';
import { Button } from './components';
import { contact, type Agent, type Task } from './model';

import { NotificationBadge, useNotifications } from './Notifications';
import { countAt } from './notifications';

type Props = {
  agents: Agent[]; tasks: Task[]; task?: Task; selected: string | null;
  lifetime: string; search: string;
  setLifetime: (value: string) => void; setSearch: (value: string) => void;
  leaveTask: () => void; openChat: (id: string) => void;
  openRoom: (id: string, showChat?: boolean) => void; taskMenu: (id: string) => void;
};

export function SessionList(p: Props) {
  const { items } = useNotifications();
  const matches = (name: string) => name.toLowerCase().includes(p.search.toLowerCase());
  const row = (id: string, name: string, last: string, onClick: () => void, unread = countAt(items, `chat:${id}`)) => <ContactRow key={id} c={{ ...contact(id, name), last, when: '', unread }} active={p.selected === id} onClick={onClick} />;
  const choices = ['Persistent', 'Temporary'];
  return <LayoutGroup id="fleet-sessions"><div className="listcol">
    <div className="listcol-head">
      <div className="conversation-list-modes" role="tablist" aria-label="Session lifetime" data-mode={p.lifetime === 'Temporary' ? 'identity' : 'recent'}>
        {choices.map((value, index) => <button key={value} role="tab" aria-label={value} aria-description={`${countAt(items, `lifetime:${value}`)} notifications`} id={`session-tab-${value}`} aria-controls="session-list-panel" aria-selected={value === p.lifetime} tabIndex={value === p.lifetime ? 0 : -1} className={value === p.lifetime ? 'active' : ''} onClick={() => p.setLifetime(value)} onKeyDown={event => {
          if(!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
          p.setLifetime(choices[next]); document.getElementById(`session-tab-${choices[next]}`)?.focus();
        }}>{value}<NotificationBadge node={`lifetime:${value}`} /></button>)}
      </div>
    </div>
    <div className="listcol-scroll" id="session-list-panel" role="tabpanel" aria-labelledby={`session-tab-${p.lifetime}`}>
      {p.task ? <>
        <div className="fleet-session-context"><Button onClick={p.leaveTask}>‹ Temporary<NotificationBadge node="lifetime:Temporary" /></Button><h2>{p.task.name}</h2><Button onClick={() => p.taskMenu(p.task!.id)}>Task ⋯</Button></div>
        <div className="conversation-group">
          {matches('Room') && row(`room-${p.task.id}`, 'Room', 'Shared chat', () => p.openRoom(p.task!.id))}
          {p.task.agents.map(id => p.agents.find(a => a.id === id)).filter((a): a is Agent => !!a && matches(a.name)).map(a => row(a.id, a.name, `Direct agent chat · ${a.state}`, () => p.openChat(a.id)))}
        </div>
      </> : <>
        {p.lifetime === 'Temporary' && <><div className="group-label">Tasks</div><div className="conversation-group">{p.tasks.filter(t => matches(t.name)).map(t => row(t.id, t.name, `Task · ${t.agents.length} agents · ${t.status}`, () => p.openRoom(t.id, false), countAt(items, `task:${t.id}`)))}</div><div className="group-label">Chats</div></>}
        <div className="conversation-group">{p.agents.filter(a => a.lifetime === p.lifetime && !a.taskId && matches(a.name)).map(a => row(a.id, a.name, `${a.lifetime} · ${a.state}`, () => p.openChat(a.id)))}</div>
      </>}
    </div>
    <div className="list-bottom-chrome"><SearchInput value={p.search} onChange={p.setSearch} label="Search sessions" placeholder={p.lifetime === 'Persistent' ? 'Search agents' : 'Search chats and tasks'} /></div>
  </div></LayoutGroup>;
}
