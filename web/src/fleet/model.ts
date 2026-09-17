import type { ContactVM } from '../ui/viewmodel';
import type { ChatMessage } from '../ui/chatTypes';
export type Status = 'Backlog' | 'Provisioning' | 'Active' | 'Review' | 'Done' | 'Cancelled' | 'Failed';
export const statuses: Status[] = ['Backlog', 'Provisioning', 'Active', 'Review', 'Done', 'Cancelled', 'Failed'];
export interface Agent { id: string; name: string; lifetime: 'Persistent' | 'Temporary'; state: string; role: string; folder: string; taskId?: string; brain?: string; permissions?: string }
export interface Task { id: string; name: string; list: string; status: Status; description: string; agents: string[]; blocked?: string; closed?: boolean }
export const initialAgents: Agent[] = [
  { id: 'coordinator', name: 'Coordinator', lifetime: 'Persistent', state: 'Ready', role: 'Coordinator', folder: '/home/you/work' },
  { id: 'researcher', name: 'Research assistant', lifetime: 'Persistent', state: 'Idle', role: 'Researcher', folder: '/home/you/work/research' },
  { id: 'developer', name: 'Developer', lifetime: 'Temporary', state: 'Working', role: 'Developer', folder: '/home/you/work/website', taskId: '0mu1gv4ndd96af6f4' },
  { id: 'critic', name: 'Critic', lifetime: 'Temporary', state: 'Ready', role: 'Critic', folder: '/home/you/work/website', taskId: '0mu1gv4ndd96af6f4' },
  { id: 'writer', name: 'Writer', lifetime: 'Temporary', state: 'Ready', role: 'Writer', folder: '/home/you/work' },
];
export const initialTasks: Task[] = [
  { id: '0mu1gv4ndd96af6f4', name: 'Launch website', list: 'Website', status: 'Active', description: 'Refine the public website, check mobile layouts and deliver the final pages for review.', agents: ['developer', 'critic'] },
  ...(['Improve onboarding', 'Refresh help pages', 'Connect analytics', 'Review API coverage', 'Polish task board', 'Refine Work lists', 'Old landing concept', 'Prepare staging', 'Research pricing'] as const).map((name, i): Task => ({ id: `task-${i}`, name, list: i === 3 ? 'Website' : 'Product', status: (['Backlog', 'Backlog', 'Provisioning', 'Active', 'Review', 'Done', 'Cancelled', 'Failed', 'Done'] as Status[])[i], description: `Coordinate the work to ${name.toLowerCase()} and provide verification evidence.`, agents: [], ...(i === 3 ? { blocked: 'Needs decision' } : {}) })),
];
export function contact(id: string, name: string, kind: 'agent' | 'person' = 'agent'): ContactVM {
  return { id, name, initials: name.split(' ').map(x => x[0]).join('').slice(0, 2), when: '10:43', activityAt: '2026-09-17T10:43:00Z', last: 'Ready when you are', unread: 0, status: 'active', root: null, sub: '', roleId: null, rootName: null, mine: kind === 'agent', kind };
}
export const initialContacts = [contact('maya', 'Maya', 'person'), contact('messenger-developer', 'Developer'), contact('alex-reviewer', 'Alex’s reviewer'), { ...contact('noor', 'Noor', 'person'), status: 'pending' as const }];
function messages(id: string, lines: string[]): ChatMessage[] { return lines.map((text, i) => ({ dir: i === 0 ? 'out' : 'in', text, date: `2026-09-17T10:${42 + i}:00Z`, read: true, wireId: `${id}-${i}`, replyTo: null, receipt: 'read' })); }
export const initialMessages: Record<string, ChatMessage[]> = {
  coordinator: messages('coordinator', ['Create a task to review our launch website with a Developer and a Critic.', 'The task is ready. Both agents are connected to their shared room.']),
  developer: messages('developer', ['Review the page structure and explain your findings.', 'I’m checking the heading hierarchy and form labels.']),
  critic: messages('critic', ['Review the launch website.', 'I’ll review contrast and keyboard navigation.']),
  maya: messages('maya', ['Can our agents review the launch together?', 'Yes. Send an agent invite. I’ll connect my reviewer.']),
  'messenger-developer': messages('messenger-developer', ['Here is the launch brief.', 'Ready when you are.']),
  'alex-reviewer': messages('alex-reviewer', ['Please review the launch.', 'Review complete.']),
  'room-0mu1gv4ndd96af6f4': messages('room', ['Please share your findings here when your individual reviews are ready.', 'Developer: I’m checking the page structure.', 'Critic: I’ll review contrast and keyboard navigation.']),
};
export type Section = 'work' | 'messenger' | 'tasks';
export type Page = { kind: 'home' } | { kind: 'task'; id: string } | { kind: 'profile'; id: string } | { kind: 'contacts'; id: string } | { kind: 'settings'; editor?: string } | { kind: 'account'; step: string } | { kind: 'empty' };
export type Modal = { kind: string; id?: string; actor?: string; locked?: boolean } | null;
export const previewRoot = '/fleet';
