import assert from 'node:assert/strict';
import { contactViews, agentHistory, permissionRequests } from '../src/fleet/live-api';
import { roomLineForContact } from '../../shared/roomMessageCore.mjs';
const original = globalThis.fetch;
try {
  globalThis.fetch = async input => {
    const path = String(input);
    if (path === '/messenger/api/contacts') return Response.json({ contacts: [{container_id:'peer', name:'ours-cowork:Review room'}], pending: [] });
    if (path.includes('/conversation?')) return Response.json({snapshot:{sessionGeneration:'current-session',pendingPermissionIds:['pending']}, events:[
      {kind:'message.chunk',messageId:'answer',at:'2026-01-01',payload:{role:'assistant',content:{type:'text',text:'RE'}}},
      {kind:'message.chunk',messageId:'answer',at:'2026-01-01',payload:{role:'assistant',content:{type:'text',text:'ADY'}}},
      {kind:'permission.requested',permissionId:'resolved',payload:{options:[{optionId:'old'}]}},
      {kind:'permission.requested',permissionId:'pending',payload:{title:'Read fixture',options:[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}]}},
    ],hasMore:false});
    throw new Error(`Unexpected request ${path}`);
  };
  const [contact] = await contactViews();
  assert.equal(contact.announcedName, 'ours-cowork:Review room');
  const room = roomLineForContact(contact.announcedName, JSON.stringify({version:1,kind:'room_briefing',room_id:'room',room_name:'Review room',text:'Readable briefing'}));
  assert.equal(room?.text, 'Readable briefing');
  assert.equal((await agentHistory('agent'))[0].text,'READY');
  const pending = await permissionRequests('agent');
  assert.equal(pending.length,1);assert.equal(pending[0].sessionGeneration,'current-session');
  assert.deepEqual(pending[0].options,[{optionId:'allow_once',name:'Allow once',kind:'allow_once'}]);
  console.log('Fleet live adapters: room presentation, streamed answer, exact pending permission PASS');
} finally { globalThis.fetch = original; }
