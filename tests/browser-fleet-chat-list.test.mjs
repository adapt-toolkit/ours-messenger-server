import {chromium,webkit} from '@playwright/test';
import assert from 'node:assert/strict';
import {createFleetPreviewServer} from '../scripts/fleet-preview-server.mjs';
const server=createFleetPreviewServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await (process.env.FLEET_LIST_WEBKIT?webkit:chromium).launch(process.env.FLEET_LIST_WEBKIT?{}:{executablePath:process.env.FLEET_CHROMIUM_EXECUTABLE});
try {
 const p=await browser.newPage({viewport:{width:360,height:800}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 let phase=0;let fail=false;let reads=0;let writes=0;
 const role={role:{id:'list-agent',lifetime:'permanent',config:{name:'TestFleetCoordinator'}},status:{overall:'ready',session:{reachability:'online',sessionId:'list-session'}},capabilities:{}};
 const stamp='2026-09-28T20:00:00Z';
 await p.route('**/fleet/api/v1/**',async r=>{const path=new URL(r.request().url()).pathname;let data;
  if(r.request().method()!=='GET' && (/\/input$|\/roles$|\/permissions\//.test(path) || path.includes('/messages/')))writes++;
  if(path.includes('/auth/'))data={csrfToken:'fixture'};
  else if(path.endsWith('/configuration'))data={revision:'fixture',model:{roles:{},brains:{},agent_templates:{},room_templates:{}}};
  else if(path.endsWith('/roles'))data={roles:[role]};
  else if(path.endsWith('/roles/list-agent'))data=role;
  else if(path.endsWith('/conversation')){if(fail)return r.fulfill({status:503,json:{error:{message:'Fixture unavailable'}}});data={events:[{eventId:'prompt',promptId:'prompt',seq:1,source:'owner_admin_console',kind:'prompt.admitted',at:stamp,payload:{text:{text:'My first message'}}},...(phase?[{eventId:'answer',messageId:'answer',seq:2,kind:'message.replace',at:'2026-09-28T20:01:00Z',payload:{role:'assistant',content:{type:'text',text:'Updated incoming response '+ 'long-text-'.repeat(60)}}}]:[])],snapshot:{sessionGeneration:'g',pendingPermissionIds:[]},nextCursor:String(phase+1),hasMore:false};}
  else if(path.endsWith('/tasks'))data={tasks:[{task_id:'task1',title:'Project room',state:'active',list_name:'default',member_roles:[],room_identity_cid:'ROOM'}]};
  else if(path.endsWith('/task-lists'))data={lists:[{name:'default'}]};else return r.continue();
  await r.fulfill({json:data});
 });
 await p.route('**/messenger/api/**',async r=>{const path=new URL(r.request().url()).pathname;let data;
  if(path.endsWith('/read')){reads++;return r.fulfill({json:{marked:1}});}
  if(r.request().method()!=='GET' && (/\/input$|\/roles$|\/permissions\//.test(path) || path.includes('/messages/')))writes++;
  if(path.endsWith('/contacts'))data={contacts:[{container_id:'PEER',name:'External friend'},{container_id:'EMPTY',name:'Empty chat'},{container_id:'ROOM',name:'ours-cowork:Project room'}],pending:[]};
  else if(path.endsWith('/page'))data={messages:path.includes('/EMPTY/')?[]:[{dir:path.includes('/ROOM/')?'in':phase?'out':'in',text:path.includes('/ROOM/')?'Room reply':phase?'':'Incoming hello',date:stamp,wire_id:'msg',message_kind:phase&&!path.includes('/ROOM/')?'file':'text',read:false}],...(path.includes('/ROOM/')?{preview:'Alice · Room reply'}:{})};
  else if(path.endsWith('/events'))return r.fulfill({contentType:'text/event-stream',body:''});else return r.continue();
  await r.fulfill({json:data});
 });
 await p.goto(base+'/fleet');
 const row=name=>p.locator('.listcol-scroll:visible .contact-row').filter({has:p.locator('.contact-name',{hasText:name})});
 await row('TestFleetCoordinator').getByText('You: My first message',{exact:true}).waitFor();
 await row('External friend').getByText('Incoming hello',{exact:true}).waitFor();
 await row('Empty chat').getByText('No messages yet',{exact:true}).waitFor();
 await row('Project room').getByText('Alice · Room reply',{exact:true}).waitFor();
 assert.equal(await p.locator('.contact-avatar').count(),0);
 for(const name of ['TestFleetCoordinator','External friend','Empty chat']){const box=await row(name).boundingBox();assert.ok(box.height>=44&&box.height<=64,`${name} height ${box.height}`);}
 assert.equal(reads,0);assert.equal(writes,0);
 phase=1;
 await row('TestFleetCoordinator').getByText(/^Updated incoming response/).waitFor({timeout:12000});
 await row('External friend').getByText('You: File attachment',{exact:true}).waitFor();
 await row('TestFleetCoordinator').locator('.contact-unread').waitFor();
 const metrics=await row('TestFleetCoordinator').locator('.contact-last').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth,ellipsis:getComputedStyle(e).textOverflow}));assert.ok(metrics.scroll>metrics.width);assert.equal(metrics.ellipsis,'ellipsis');
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await p.screenshot({path:process.env.FLEET_LIST_SCREENSHOT??'../runtime/chat-list-mobile.png'});
 await p.getByRole('tab',{name:/^External/}).click();await row('External friend').getByText('You: File attachment',{exact:true}).waitFor();assert.equal(await p.locator('.contact-avatar').count(),0);
 await p.getByRole('tab',{name:/^All/}).click();fail=true;
 await row('TestFleetCoordinator').getByText(/Unable to refresh/).waitFor({timeout:12000});assert.ok((await row('TestFleetCoordinator').locator('.contact-last').innerText()).startsWith('Updated incoming response'));
 fail=false;await p.waitForFunction(()=>![...document.querySelectorAll('.contact-last')].some(e=>e.textContent.includes('Unable to refresh')),{},{timeout:12000});
 await p.getByRole('button',{name:'Use light theme',exact:true}).click();
 assert.ok((await row('External friend').boundingBox()).height<=64);
 assert.equal(reads,0);assert.equal(writes,0);assert.deepEqual(errors,[]);
 console.log('Fleet compact list: ACP/external/task/empty/file previews, refresh/direction/stale recovery, no avatars/read/write, mobile truncation/height/light/dark PASS');
} finally {await browser.close();await new Promise(r=>server.close(r));}
