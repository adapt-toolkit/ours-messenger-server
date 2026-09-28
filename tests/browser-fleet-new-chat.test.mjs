import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});let created=false;let running=false;let interrupted=0;let historyCalls=[];const mutations=[];let request;const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const role={role:{id:'fixture-chat',lifetime:'temporary',config:{name:'fixture-chat',harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'fixture-session'}},capabilities:{}};
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;const method=r.request().method();let data;
 if(method==='POST'&&!path.includes('/auth/'))mutations.push({path,body:r.request().postDataJSON()});
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={model:{manifest:{defaults:{permissions:{approval:'ask',filesystem:'workspace',unattended:'deny'}}},roles:{Assistant:{},Developer:{}},brains:{normal:{harness:'codex',model:'default'},fast:{harness:'codex',model:'fast-model'}},agent_templates:{},room_templates:{}},revision:'fixture'};
 else if(path.endsWith('/roles/preview')){request=r.request().postDataJSON();await new Promise(r=>setTimeout(r,250));data={request,previewHash:'reviewed',prerequisites:[]};}
 else if(path.endsWith('/roles')&&method==='POST'){created=true;data={actionId:'creation'};}
 else if(path.endsWith('/roles'))data={roles:created?[role]:[]};
 else if(path.endsWith('/creation-actions/creation'))data={state:'session_reachable',roleId:'fixture-chat'};
 else if(path.endsWith('/roles/fixture-chat/interrupt')){interrupted++;running=false;data={state:'accepted'};}
 else if(path.endsWith('/roles/fixture-chat/contacts')){historyCalls.push({operation:'contacts',method});data={contacts:[{name:'Fixture peer',container_id:'A'.repeat(64)}]};}
 else if(path.endsWith('/roles/fixture-chat/messages')){const q=Object.fromEntries(new URL(r.request().url()).searchParams);historyCalls.push({operation:'history',method,args:q});data={items:[{seq:q.before_seq?1:2,direction:q.before_seq?'in':'out',text:q.before_seq?'Earlier reply':'Agent sent this',date:'2026-09-28T08:00:00Z'}],next_cursor:q.before_seq?null:2};}
 else if(path.endsWith('/roles/fixture-chat/removal-preview'))data={lifetime:'temporary'};
 else if(path.endsWith('/roles/fixture-chat/remove')){created=false;data={removed:true};}
 else if(path.endsWith('/roles/fixture-chat/input'))data={promptId:'first-message',state:'queued'};
 else if(path.endsWith('/roles/fixture-chat'))data=role;
 else if(path.endsWith('/conversation'))data={events:[{kind:'message.replace',eventId:'reply',messageId:'reply',seq:1,at:new Date().toISOString(),payload:{role:'assistant',content:{type:'text',text:'First message received'}}}],snapshot:{readiness:running?'running':'idle',pendingPermissionIds:[],queueDepth:running?1:0},nextCursor:'1',hasMore:false};
 else if(path.endsWith('/tasks'))data={tasks:[]};else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};else throw new Error('Unexpected '+path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',r=>r.fulfill({json:{contacts:[],pending:[],files:[],messages:[]}}));
 await p.goto(base+'/fleet');await p.getByRole('button',{name:'Add or connect',exact:true}).click();await p.getByRole('button',{name:'New chat',exact:true}).click();await p.getByLabel('New chat settings').waitFor();
 assert.equal(mutations.length,0);assert.equal(await p.getByLabel('Role',{exact:true}).inputValue(),'Assistant');
 await p.getByLabel('Agent name',{exact:true}).fill('fixture-chat');await p.getByLabel('Role',{exact:true}).selectOption('Developer');await p.getByLabel('Brain',{exact:true}).selectOption('fast');
 await p.getByRole('button',{name:'More options',exact:true}).click();await p.getByLabel('Permissions',{exact:true}).selectOption('Read only');await p.getByRole('button',{name:'Done',exact:true}).click();await p.getByLabel('Effort',{exact:true}).selectOption('high');await p.getByLabel('Permissions',{exact:true}).selectOption('Allow · Full access');
 await p.getByLabel('Message agent',{exact:true}).fill('hello once');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByText('Session settings · Locked',{exact:true}).waitFor();await p.getByText('First message received',{exact:true}).waitFor();
 assert.deepEqual(mutations.map(x=>x.path),['/fleet/api/v1/roles/preview','/fleet/api/v1/roles','/fleet/api/v1/roles/fixture-chat/input']);
 assert.equal(request.role.ref,'Developer');assert.equal(request.brain.inline.model,'fast-model');assert.equal(request.brain.inline.effort,'high');assert.equal(request.permissions.approval,'allow');assert.equal(request.permissions.filesystem,'unrestricted');assert.equal(request.highRiskAcknowledged,true);assert.equal(request.permissions.unattended,'deny');assert.equal(mutations[1].body.previewHash,'reviewed');assert.equal(mutations[2].body.text,'hello once');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 running=true;await p.getByRole('button',{name:'Stop',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Send',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Stop',exact:true}).getAttribute('type'),'button');
 await p.getByLabel('Message agent',{exact:true}).fill('do not send on stop');await p.getByRole('button',{name:'Stop',exact:true}).click();await p.getByRole('button',{name:'Send',exact:true}).waitFor();assert.equal(interrupted,1);assert.equal(mutations.filter(x=>x.path.endsWith('/input')).length,1);
 await p.getByRole('button',{name:'Agent actions',exact:true}).click();await p.getByRole('button',{name:'Contacts & conversations',exact:true}).click();await p.getByRole('button',{name:'Fixture peer',exact:false}).click();await p.getByText('Agent sent this',{exact:true}).waitFor();await p.getByRole('button',{name:'Load older messages',exact:true}).click();await p.getByText('Earlier reply',{exact:true}).waitFor();assert.deepEqual(historyCalls.map(x=>x.operation),['contacts','history','history']);assert.equal(historyCalls[1].args.peer_cid,'A'.repeat(64));assert.equal(historyCalls[2].args.before_seq,'2');assert.equal(await p.locator('.fleet-correspondence-message.sent').innerText().then(x=>x.includes('fixture-chat')),true);
 assert.equal(historyCalls.every(x=>x.method==='GET'),true);
 console.log('Stop replaces Send and interrupts once without sending; selected-agent contacts and read-only paginated correspondence PASS');
 console.log('New chat opens draft; actual defaults/options; no early creation; first send locks selected settings and sends once PASS');
} finally {await browser.close();await new Promise(r=>server.close(r));}
