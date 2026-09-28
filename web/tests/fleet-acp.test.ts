import assert from 'node:assert/strict';
import { acpMessages } from '../src/fleet/acp-adapter';
const event=(kind:string,payload:any,extra:any={})=>({kind,payload,eventId:kind,at:'2026-09-28T07:00:00Z',...extra});
const messages=acpMessages([
 event('prompt.admitted',{text:{text:'startup'}},{source:'startup',promptId:'boot'}),
 event('prompt.admitted',{text:{text:'Hello'}},{source:'owner_admin_console',promptId:'p'}),
 event('message.chunk',{role:'assistant',content:{type:'text',text:'RE'}},{messageId:'m'}),
 event('message.chunk',{role:'assistant',content:{type:'text',text:'ADY'}},{messageId:'m'}),
 event('message.chunk',{role:'assistant',content:{type:'text',text:'secret',redacted:true}},{messageId:'hidden'}),
 event('tool.upsert',{toolCallId:'t',title:'Read file',status:'in_progress',content:[{type:'content',content:{type:'text',text:'secret tool',redacted:true}}]}),
 event('tool.upsert',{toolCallId:'t',status:'completed'}),
]);
assert.deepEqual(messages.map(m=>m.id),['p','m','tool:t']);
assert.equal((messages[1].parts[0] as any).content[0].text,'READY');
assert.equal((messages[2].parts[0] as any).toolCalls[0].status,'completed');
assert.ok(!JSON.stringify(messages).includes('secret'));
assert.ok(!JSON.stringify(messages).includes('startup'));
console.log('ACP adapter: assembled text, current tool state, startup/redaction filtering PASS');
const {roleNotifications,roomTarget}=await import('../src/fleet/live-notifications');
const {countAt}=await import('../src/fleet/notifications');
const tasks=[{task_id:'task1',room_identity_cid:'ROOM',member_roles:[{name:'agent1'}]}];
const notices=roleNotifications({role:{id:'agent1',lifetime:'temporary'}},[
 event('message.chunk',{role:'assistant',content:{type:'text',text:'A'}},{messageId:'answer',seq:5,acpSessionId:'session'}),
 event('message.chunk',{role:'assistant',content:{type:'text',text:'B'}},{messageId:'answer',seq:6,acpSessionId:'session'}),
 event('permission.requested',{title:'Read',options:[{optionId:'allow-once',name:'Allow once'}]},{permissionId:'p'}),
],{sessionGeneration:'g',pendingPermissionIds:['p']},tasks);
assert.equal(notices.length,2);assert.equal(notices[0].cursor,6);
const room={id:'room-message',kind:'message' as const,target:roomTarget(tasks,'ROOM'),title:'Room reply',read:false,resolved:false};
assert.equal(room.target.chat,'room-task1');
assert.equal(countAt([...notices,room],'tasks'),3);
assert.equal(countAt([...notices,room],'task:task1'),3);
assert.equal(countAt([...notices,room],'agents'),2);
assert.equal(countAt([...notices,room],'chat:room-task1'),1);
assert.equal(countAt([...notices,room],'messenger'),0);
console.log('Unread: one streamed reply, exact permission, room/agent/task ancestors PASS');
const {notificationIsRead,retainedOfflineMessages}=await import('../src/fleet/live-notifications');
assert.equal(notificationIsRead(notices[0],{'agent1:session':5},new Set([notices[0].id])),false);
assert.equal(notificationIsRead(notices[0],{'agent1:session':6},new Set()),true);
assert.equal(retainedOfflineMessages(notices,[{role:{id:'agent1'},status:{session:{reachability:'offline'}}}]).length,1);
assert.equal(retainedOfflineMessages(notices,[]).length,0);
console.log('Unread regression: later chunk unread despite same message ID; offline preserves unread, deleted role removes it PASS');
