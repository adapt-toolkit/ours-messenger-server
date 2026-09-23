import { Bot, MessageCircle, ListTodo, UserRound, Settings, Bell, ChevronRight } from 'lucide-react';
import { Button, MenuAction } from './components';
import { NotificationBadge } from './Notifications';
import type { Section } from './model';
export function Navigation({ current, select, profile, settings, notifications }: { current: Section; select: (s: Section) => void; profile: () => void; settings: () => void; notifications: () => void }) {
  const destinations = [
    { id: 'work' as const, title: 'Chats', description: 'Your workspace and external conversations in one place.', icon: MessageCircle },
    { id: 'tasks' as const, title: 'Tasks', description: 'Plan work, bring a team together and follow its progress.', icon: ListTodo },
  ];
  return <div className="fleet-navigation"><p>Choose where you want to go.</p>{destinations.map(({id, title, description, icon: Icon}) => <Button className="fleet-destination" key={id} aria-current={(current === 'messenger' ? 'work' : current) === id ? 'page' : undefined} onClick={() => select(id)}><span className="fleet-destination-icon"><Icon size={24} /></span><span><strong>{title}<NotificationBadge node={id === 'work' ? 'root' : id} />{(current === 'messenger' ? 'work' : current) === id && <small>Current</small>}</strong><span>{description}</span></span><ChevronRight size={18} /></Button>)}<div className="fleet-menu-divider" /><MenuAction title="Notifications" icon={Bell} onClick={notifications} /><MenuAction title="My profile" icon={UserRound} onClick={profile} /><MenuAction title="Settings" icon={Settings} onClick={settings} /></div>;
}
