import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessengerNotificationProducer } from '../src/notification-producer.ts';
import { serveApi } from '../src/api.ts';
mkdirSync('.test-artifacts', { recursive: true });
const dir=mkdtempSync(join('.test-artifacts','contact-retirement-'));
let contacts=[{container_id:'REMOVED',name:'Alice'},{container_id:'KEPT',name:'Bob'}], pending=[], unavailable=false, malformed=false, failDelete=true, failRemove=false;
const deliveries=[]; let holdSend, sent, releaseSend;
const service=createServer(async(req,res)=>{
 let body=''; for await(const chunk of req)body+=chunk;
 assert.equal(req.headers.authorization,'Bearer '+'p'.repeat(40));
 deliveries.push({path:req.url,value:JSON.parse(body)});
 if(holdSend && req.url==='/api/v1/send'){sent();await new Promise(r=>releaseSend=r);}
 if(req.url==='/api/v1/delete-target' && failDelete){res.writeHead(503);res.end();return;}
 res.end('{}');
});await new Promise(r=>service.listen(0,'127.0.0.1',r));
const config={origin:`http://127.0.0.1:${service.address().port}`,token:'p'.repeat(40)};
const client={listContacts:async()=>{if(unavailable)throw Error('temporarily unavailable');return malformed?{contacts:[]}:{contacts,pending};},
 getHistoryItem:async({wire_id})=>({wire_id,direction:'in',text:'Message',peer:{id:wire_id==='pending-contact'?'PENDING':wire_id==='kept'||wire_id==='retryable'?'KEPT':'REMOVED',name:'Alice'}}),
 removeContact:async({contact})=>{if(failRemove)throw Error('removal failed');contacts=contacts.filter(row=>row.container_id!==contact);return {removed:true};}};
let producer=new MessengerNotificationProducer(dir,config,'USER',client,()=>{});
const deps={runtime:{client},push:{},config:{identity:'Me',publicOrigin:'http://messenger.test'},buildInfo:{name:'test',version:'0',sha:'test',dirty:false},watcherStats:()=>({}),events:{subscribe:()=>({next:async()=>null,close(){}})},identityCid:'USER',retireContactNotifications:cid=>producer.retireContact(cid)};
const api=createServer((req,res)=>{void serveApi(req,res,deps);});await new Promise(r=>api.listen(0,'127.0.0.1',r));
const remove=async contact=>{const res=await fetch(`http://127.0.0.1:${api.address().port}/api/contacts/remove`,{method:'POST',headers:{'content-type':'application/json',origin:'http://messenger.test','x-ours-messenger-csrf':'1'},body:JSON.stringify({contact})});await res.text();return res.status;};
const entries=()=>JSON.parse(readFileSync(join(dir,'notification-outbox.json'),'utf8')).entries;
const admit=(cid,id)=>producer.admit({event:'message_received',sender_id:cid,wire_id:id});
try{
 failRemove=true;assert.equal(await remove('Alice'),500);assert.deepEqual(deliveries,[]);assert.equal(contacts.length,2);
 failRemove=false;holdSend=true;const started=new Promise(r=>sent=r);admit('REMOVED','inflight');const running=producer.outbox.drain();await started;
 admit('REMOVED','queued');admit('KEPT','kept');assert.equal(await remove('Alice'),200);
 assert.ok(entries().some(row=>row.operation==='delete-target'));
 assert.ok(!entries().some(row=>row.value.sender_id==='REMOVED'));
 releaseSend();await running;holdSend=false;await producer.outbox.drain();
 const cleanup=deliveries.findIndex(row=>row.path==='/api/v1/delete-target');
 assert.ok(cleanup>deliveries.findIndex(row=>row.value.eventId?.includes('inflight')));
 assert.equal(deliveries[cleanup].value.url,'/fleet/chats?source=messenger&chat=REMOVED');
 assert.ok(entries().some(row=>row.operation==='delete-target')); // outage persists through restart
 await producer.close();producer=new MessengerNotificationProducer(dir,config,'USER',client,()=>{});
 failDelete=false;await producer.outbox.drain();assert.equal(entries().length,0);
 assert.ok(deliveries.some(row=>row.value.eventId?.includes('kept')));assert.ok(!deliveries.some(row=>row.value.eventId?.includes('queued')));
 const before=deliveries.length;admit('REMOVED','late-watch-replay');await producer.outbox.drain();assert.equal(deliveries.length,before);assert.equal(entries().length,0);
 pending=[{container_id:'PENDING'}];admit('PENDING','pending-contact');await producer.outbox.drain();assert.ok(deliveries.at(-1).value.eventId.includes('pending-contact'));
 unavailable=true;admit('KEPT','retryable');await producer.outbox.drain();assert.equal(entries().length,1);
 unavailable=false;malformed=true;await producer.outbox.drain();assert.equal(entries().length,1);
 malformed=false;await producer.outbox.drain();assert.equal(entries().length,0);
 console.log('Contact removal canonical CID, failed removal preservation, inflight send cleanup order, durable outage/restart, unrelated contact and pending/contact-inventory failure preservation PASS');
}finally{await producer.close();for(const server of [api,service]){server.closeAllConnections();await new Promise(r=>server.close(r));}}
