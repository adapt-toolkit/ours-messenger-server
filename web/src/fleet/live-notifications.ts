import type { FleetNotification } from './notifications';
export function taskForRole(tasks:any[],role:string) { return tasks.find(t=>t.member_roles.some((m:any)=>m.name===role)); }
export function roomTarget(tasks:any[],cid:string):FleetNotification['target'] {
 const task=tasks.find(t=>t.room_identity_cid===cid);
 return task?{section:'work',chat:`room-${task.task_id}`,task:task.task_id}:{section:'messenger',chat:cid};
}
export function roleNotifications(row:any,events:any[],snapshot:any,tasks:any[]):FleetNotification[] {
 const id=row.role.id;const task=taskForRole(tasks,id);const target: FleetNotification['target']={section:'work',chat:id,lifetime:row.role.lifetime==='permanent'?'Persistent':'Temporary',...(task?{task:task.task_id}:{})};
 const messages=new Map<string,FleetNotification>();const requests=new Map<string,FleetNotification>();
 for(const e of events){
  if(['message.chunk','message.replace'].includes(e.kind) && e.payload.role==='assistant' && e.payload.content?.type==='text'){
   const key=e.messageId??e.eventId;if(e.payload.content.redacted){messages.delete(key);continue;}
   messages.set(key,{id:`acp:${id}:${key}`,kind:'message',target,title:`${id}: New reply`,messageId:key,cursor:e.seq,sessionId:e.acpSessionId,read:false,resolved:false});
  }
  if(e.kind==='permission.requested')requests.set(e.permissionId,{id:`${id}:${e.permissionId}`,kind:'request',target,title:e.payload.title??'Agent requests permission',permissionId:e.permissionId,sessionGeneration:snapshot.sessionGeneration,options:e.payload.options,read:false,resolved:false});
  if(e.kind==='permission.resolved')requests.delete(e.permissionId);
 }
 return [...messages.values(),...requests.values()].filter(n=>n.kind==='message'||snapshot.pendingPermissionIds.includes(n.permissionId));
}
export function notificationIsRead(n:FleetNotification,cursors:Record<string,number>,acknowledged:Set<string>):boolean {
 return n.cursor!==undefined ? n.cursor <= (cursors[n.target.chat+':'+n.sessionId]??0) : n.read || acknowledged.has(n.id);
}
export function retainedOfflineMessages(previous:FleetNotification[],roles:any[]):FleetNotification[] {
 const offline=new Set(roles.filter(r=>r.status.session?.reachability!=='online').map(r=>r.role.id));
 return previous.filter(n=>n.kind==='message'&&n.cursor!==undefined&&offline.has(n.target.chat));
}
