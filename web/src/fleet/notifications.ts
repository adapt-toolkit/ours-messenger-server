import type { Section } from './model';
export interface FleetNotification {
  id: string;
  kind: 'message' | 'request';
  target: { section: Section; chat: string; lifetime?: 'Persistent' | 'Temporary'; task?: string };
  title: string;
  messageId?: string;
  read: boolean;
  resolved: boolean;
  decision?: 'approved' | 'declined';
}
export const isPending = (n: FleetNotification) => n.kind === 'request' ? !n.resolved : !n.read;
export function ancestors(n: FleetNotification): string[] {
  return ['root', n.target.section, `chat:${n.target.chat}`, ...(n.target.lifetime ? [`lifetime:${n.target.lifetime}`] : []), ...(n.target.task ? [`task:${n.target.task}`] : [])];
}
export function countAt(items: FleetNotification[], node: string): number {
  return new Set(items.filter(n => isPending(n) && ancestors(n).includes(node)).map(n => n.id)).size;
}
export function markTargetRead(items: FleetNotification[], chat: string): FleetNotification[] {
  return items.map(n => n.target.chat === chat ? { ...n, read: true } : n);
}
export function resolveRequest(items: FleetNotification[], id: string, decision: 'approved' | 'declined' = 'approved'): FleetNotification[] {
  return items.map(n => n.id === id && n.kind === 'request' && !n.resolved ? { ...n, read: true, resolved: true, decision } : n);
}
export function seedNotifications(): FleetNotification[] {
  return [
    { id: 'message-maya', kind: 'message', target: { section: 'messenger', chat: 'maya' }, title: 'Maya sent an agent invitation', messageId: 'maya-1', read: false, resolved: false },
    { id: 'message-alex', kind: 'message', target: { section: 'messenger', chat: 'alex-reviewer' }, title: 'Alex’s reviewer finished the review', messageId: 'alex-reviewer-1', read: false, resolved: false },
    { id: 'request-researcher', kind: 'request', target: { section: 'work', chat: 'researcher', lifetime: 'Persistent' }, title: 'Choose the research scope: compare the three leading products?', read: false, resolved: false },
    { id: 'request-writer', kind: 'request', target: { section: 'work', chat: 'writer', lifetime: 'Temporary' }, title: 'Approve the outline before I draft the launch announcement.', read: false, resolved: false },
    { id: 'request-developer', kind: 'request', target: { section: 'work', chat: 'developer', lifetime: 'Temporary', task: '0mu1gv4ndd96af6f4' }, title: 'Approve the proposed heading and form-label changes.', read: false, resolved: false },
  ];
}
