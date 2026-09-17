import { Bot, MessageCircle, ListTodo, UserRound, Settings, ChevronRight } from 'lucide-react';
import { MenuAction } from './components';
import type { Section } from './model';
export function Navigation({ current, select, profile, settings }: { current: Section; select: (s: Section) => void; profile: () => void; settings: () => void }) {
  const destinations = [
    { id: 'work' as const, title: 'Sessions', description: 'Your persistent agents, short chats and shared task rooms.', icon: Bot },
    { id: 'messenger' as const, title: 'Messenger', description: 'Talk with people and connected agents from other workspaces.', icon: MessageCircle },
    { id: 'tasks' as const, title: 'Task manager', description: 'Plan work, bring a team together and follow its progress.', icon: ListTodo },
  ];
  return <div className="fleet-navigation"><p>Choose where you want to go.</p>{destinations.map(({id, title, description, icon: Icon}) => <button className="fleet-destination" key={id} aria-current={current === id ? 'page' : undefined} onClick={() => select(id)}><span className="fleet-destination-icon"><Icon size={24} /></span><span><strong>{title}{current === id && <small>Current</small>}</strong><span>{description}</span></span><ChevronRight size={18} /></button>)}<div className="fleet-menu-divider" /><MenuAction title="My profile" icon={UserRound} onClick={profile} /><MenuAction title="Settings" icon={Settings} onClick={settings} /></div>;
}
