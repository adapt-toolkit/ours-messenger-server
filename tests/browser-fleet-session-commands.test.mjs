import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});const calls=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
 let inputAbort=false,actionAbort=false,actionReject=true;
 const role={role:{id:'fixture-agent',lifetime:'permanent',config:{name:'Fixture agent',harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'fixture-session'}},capabilities:{}};
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;let data;
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={revision:'fixture',model:{roles:{},brains:{},agent_templates:{},room_templates:{}}};
 else if(path.endsWith('/roles'))data={roles:[role]};
 else if(path.endsWith('/roles/fixture-agent'))data=role;
 else if(path.endsWith('/conversation'))data={events:[{kind:'capabilities.updated',sessionGeneration:'g',payload:{commands:[{name:'compact',description:{text:'Compact context'}}]}},...(calls.some(c=>c.path.endsWith('/input'))?[{kind:'turn.completed',promptId:'compact-prompt',payload:{outcome:'completed'}}]:[])],snapshot:{sessionGeneration:'g',readiness:'idle',pendingPermissionIds:[],queueDepth:0},hasMore:false};
 else if(path.endsWith('/input')){calls.push({path,body:r.request().postDataJSON()});if(inputAbort){await r.abort('failed');return;}data={promptId:'compact-prompt',state:'accepted'};}
 else if(path.endsWith('/actions')){const body=r.request().postDataJSON();if(actionReject){actionReject=false;await r.fulfill({status:409,json:{accepted:false,error:{code:'action_not_accepted',message:'Fixture pre-admission rejection'}}});return;}calls.push({path,body});if(actionAbort){await r.abort('failed');return;}data={actionId:body.actionId,state:'accepted'};}
 else if(path.includes('/actions/'))data={state:actionAbort?'uncertain':'succeeded'};
 else if(path.endsWith('/ours/call')){calls.push({path,body:r.request().postDataJSON()});data={result:{structuredContent:{blob:'fixture-agent-code'}}};}
 else if(path.endsWith('/tasks'))data={tasks:[]};else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};else throw Error(path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',async r=>{const path=new URL(r.request().url()).pathname;if(path.endsWith('/invites')&&r.request().method()==='POST'){calls.push({path,body:r.request().postDataJSON()});await r.fulfill({json:{blob:'fixture-human-code'}});}else await r.fulfill({json:{contacts:[],pending:[],messages:[],files:[]}});});
 await p.goto(base+'/fleet/chats?chat=fixture-agent&detail=1');
 assert.equal(await p.getByRole('button',{name:'Session commands',exact:true}).count(),0);await p.getByLabel('Message agent',{exact:true}).fill('/co');await p.getByRole('option',{name:'/compact Compact context',exact:true}).waitFor();await p.getByLabel('Message agent',{exact:true}).press('Enter');assert.equal(await p.getByLabel('Message agent',{exact:true}).inputValue(),'/compact');assert.equal(calls.length,0);
 await p.getByRole('button',{name:'Send',exact:true}).click();await p.waitForTimeout(300);assert.equal(calls.at(-1).body.text,'/compact');assert.equal(calls.at(-1).path,'/fleet/api/v1/roles/fixture-agent/input');
 await p.waitForTimeout(2300);await p.getByLabel('Message agent',{exact:true}).fill('/unknown');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('alert').filter({hasText:'not available'}).waitFor();assert.equal(calls.length,1);
 await p.getByLabel('Message agent',{exact:true}).fill('/restart');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('button',{name:'Restart',exact:true}).click();await p.getByRole('dialog').getByRole('alert').waitFor();await p.getByRole('button',{name:'Restart',exact:true}).click();await p.getByRole('dialog').waitFor({state:'hidden'});assert.equal(calls.at(-1).body.action,'restart_resume');assert.equal(calls.filter(c=>c.path.endsWith('/input')).length,1);
 await p.getByRole('button',{name:'Agent actions',exact:true}).click();await p.getByRole('button',{name:'Force restart',exact:true}).click();const force=p.getByRole('button',{name:'Force restart',exact:true});assert.equal(await force.isDisabled(),true);await p.getByLabel('Confirm agent ID: fixture-agent',{exact:true}).fill('wrong-agent');assert.equal(await force.isDisabled(),true);await p.getByLabel('Confirm agent ID: fixture-agent',{exact:true}).fill('fixture-agent');await force.click();await p.getByRole('dialog',{name:'Force restart agent',exact:true}).waitFor({state:'hidden'});assert.equal(calls.at(-1).body.action,'restart_fresh');assert.equal(calls.at(-1).body.confirmation,'fixture-agent');assert.equal(calls.at(-1).path,'/fleet/api/v1/roles/fixture-agent/actions');assert.equal(calls.length,3);
 await p.keyboard.press('Escape');inputAbort=true;
 await p.getByLabel('Message agent',{exact:true}).fill('/compact');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('alert').waitFor();const firstRetry=calls.at(-1).body.commandId;
 await p.reload();await p.getByLabel('Message agent',{exact:true}).waitFor();assert.equal(await p.getByLabel('Message agent',{exact:true}).inputValue(),'/compact');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('alert').waitFor();assert.equal(calls.at(-1).body.commandId,firstRetry);
 actionAbort=true;await p.getByLabel('Message agent',{exact:true}).fill('/restart');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('button',{name:'Restart',exact:true}).click();await p.getByRole('dialog').getByRole('alert').waitFor();const total=calls.length;await p.keyboard.press('Escape');await p.getByRole('button',{name:'Send',exact:true}).click();await p.getByRole('button',{name:'Check restart status',exact:true}).click();await p.getByRole('dialog').getByRole('alert').waitFor();assert.equal(calls.length,total);
 assert.deepEqual(errors,[]);console.log('Session commands: advertised compact, unknown refusal, slash restart route, persistent force-restart exact ID confirmation PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));}
