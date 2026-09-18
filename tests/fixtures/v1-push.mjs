// Existing push callback + actual V1 notification/history projection. No push provider call.
import assert from 'node:assert/strict';
import {createECDH, randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attachOursClient} from '@ours.network/sdk';
import {PushStore} from '../../src/push.ts';
import {PushDeliveryQueue} from '../../src/push-delivery.ts';
import {PresenceRegistry} from '../../src/presence.ts';
const [identityCid, peerCid, wireId] = process.argv.slice(2);
assert(identityCid && peerCid && wireId);
const state = mkdtempSync(join(tmpdir(),'messenger-v1-push-'));
const client = await attachOursClient({endpoint: process.env.OURS_DAEMON_URL, expectedInstanceId: process.env.OURS_DAEMON_ID,
 credentialPath: process.env.OURS_DAEMON_CREDENTIAL_PATH, sessionMode:'external', leaseToken:randomUUID(),env:{}});
let queue;
try {
 assert.equal((await client.chooseIdentity({name:process.env.OURS_MESSENGER_IDENTITY,force:false})).cid,identityCid);
 const page = await client.readNotificationPage(process.env.OURS_MESSENGER_IDENTITY,{since:0,signal:AbortSignal.timeout(5000)});
 const record = page.events.find(row=>row.event==='message_received' && row.wire_id===wireId);
 assert(record, 'Callback fixture must admit an actual authenticated daemon notification');
 assert.equal(record.sender_id,peerCid);
 const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
 const keys = {p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};
 const delivered=[];
 const store=PushStore.open(state,identityCid,process.env,{sendNotification:async(target,payload)=>{delivered.push({endpoint:target.endpoint,event:JSON.parse(payload)});}});
 const front=store.ensure({endpoint:'https://push.invalid/foreground',keys,preview:'full'});
 store.ensure({endpoint:'https://push.invalid/background',keys,preview:'full'});
 const presence=new PresenceRegistry(); const socket={};
 presence.add(identityCid,front.bindingId,socket);
 queue=new PushDeliveryQueue({store,client,identityCid,log:{info(){},warn(){}},foregroundBindingIds:()=>presence.onlineBindings(identityCid),autoStart:false});
 assert.equal(queue.enqueue(record),true);
 await queue.drainDue();
 assert.equal(delivered.length,1); assert.equal(delivered[0].endpoint,'https://push.invalid/background');
 assert.equal(delivered[0].event.wire_id,wireId); assert.equal(delivered[0].event.contact_id,peerCid);
 assert.equal(delivered[0].event.body,'message before daemon restart');
 assert.equal(queue.stats.suppressed,1); assert.equal(store.queueStats().pending,0);
 assert.equal(presence.remove(identityCid,front.bindingId,socket),true);
 await queue.stop(); queue=undefined;
 const reopened=PushStore.open(state,identityCid,process.env,{sendNotification:async()=>{throw new Error('Delivered callback job must not repeat');}});
 assert.deepEqual(reopened.publicConfig,store.publicConfig,'Generated VAPID public generation remains stable after reopen');
 queue=new PushDeliveryQueue({store:reopened,client,identityCid,log:{info(){},warn(){}},autoStart:false});
 assert.equal(queue.enqueue(record),false,'Actual notification remains deduplicated after reopening private state');
 console.log('PASS local push callback: actual notification/history projection, foreground binding suppression, background callback, durable dedupe/VAPID reuse (no live provider/browser claim)');
} finally {await queue?.stop(); await client.releaseLease(); await client.close(); rmSync(state,{recursive:true,force:true});}
