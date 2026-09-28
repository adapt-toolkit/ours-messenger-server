import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});const writes=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
 const id='0mul7vkrx8f79074b';let brief='Original\nDescription',reject=true;
 const task=()=>({task_id:id,title:'Fixture task',brief,state:'backlog',list_name:'default',member_roles:[]});
 const role={role:{id:'fixture-agent',lifetime:'permanent',config:{name:'Fixture agent',harness:'codex'}},status:{overall:'ready',session:{reachability:'online',readiness:'idle',sessionId:'fixture-session'}},capabilities:{}};
 const card={kind:'fleet.task_created',source:'fleet_lifecycle',promptId:'p',at:new Date().toISOString(),payload:{operationId:'o',taskId:id,title:'Fixture task',state:'backlog'}};
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;let data;
 if(path.includes('/auth/'))data={csrfToken:'fixture'};
 else if(path.endsWith('/configuration'))data={revision:'fixture',model:{roles:{},brains:{},agent_templates:{},room_templates:{}}};
 else if(path.endsWith('/roles'))data={roles:[role]};
 else if(path.endsWith('/roles/fixture-agent'))data=role;
 else if(path.endsWith('/conversation'))data={events:[card,card,{...card,source:'agent',payload:{...card.payload,operationId:'fake'}}],snapshot:{sessionGeneration:'g',readiness:'idle',pendingPermissionIds:[],queueDepth:0},hasMore:false};
 else if(path.endsWith('/description')){writes.push({path,body:r.request().postDataJSON(),method:r.request().method()});if(reject){reject=false;await r.fulfill({status:409,json:{error:{message:'Fixture save failure'}}});return;}brief=r.request().postDataJSON().brief;data={task:task()};}
 else if(path.endsWith('/tasks'))data={tasks:[task()]};
 else if(path.endsWith('/tasks/'+id))data={task:task()};
 else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};
 else throw Error(path);
 await r.fulfill({json:data});});
 await p.route('**/messenger/api/**',r=>r.fulfill({json:{contacts:[],pending:[],messages:[],files:[]}}));
 await p.goto(base+'/fleet/tasks/'+id);
 await p.getByRole('button',{name:'Edit description',exact:true}).click();
 assert.equal(await p.getByLabel('Description',{exact:true}).inputValue(),brief);
 await p.getByLabel('Description',{exact:true}).fill('Edited\nSecond line');
 await p.waitForTimeout(2300);assert.equal(await p.getByLabel('Description',{exact:true}).inputValue(),'Edited\nSecond line');
 await p.getByRole('button',{name:'Save',exact:true}).click();await p.getByRole('alert').filter({hasText:'Fixture save failure'}).waitFor();
 assert.equal(await p.getByLabel('Description',{exact:true}).inputValue(),'Edited\nSecond line');
 await p.getByRole('button',{name:'Save',exact:true}).click();await p.getByRole('button',{name:'Edit description',exact:true}).waitFor();
 await p.reload();await p.getByRole('button',{name:'Edit description',exact:true}).click();assert.equal(await p.getByLabel('Description',{exact:true}).inputValue(),'Edited\nSecond line');
 await p.getByLabel('Description',{exact:true}).fill('Cancelled');await p.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(writes.length,2);assert(writes.every(w=>w.method==='PATCH'&&w.path.endsWith('/tasks/'+id+'/description')&&w.body.expectedBrief==='Original\nDescription'));
 await p.goto(base+'/fleet/chats?chat=fixture-agent&detail=1');await p.getByRole('region',{name:'Task created',exact:true}).waitFor();assert.equal(await p.getByRole('region',{name:'Task created',exact:true}).count(),1);
 await p.reload();await p.getByRole('region',{name:'Task created',exact:true}).waitFor();assert.equal(await p.getByRole('region',{name:'Task created',exact:true}).count(),1);
 assert.equal(await p.getByRole('link',{name:'Open task →'}).getAttribute('href'),'/fleet/tasks/'+id);await p.getByRole('link',{name:'Open task →'}).click();await p.getByRole('button',{name:'Edit description',exact:true}).waitFor();assert.equal(writes.length,2);assert.deepEqual(errors,[]);
 console.log('Description save/error/draft/reload/cancel and typed task receipt dedup/link/no lifecycle mutation PASS');
}finally{await browser.close();await new Promise(r=>server.close(r));}
