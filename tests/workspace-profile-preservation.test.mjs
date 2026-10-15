import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serveApi} from '../src/api.ts';
import {writeHumanProfile,readHumanProfile} from '../src/workspace-profile.ts';
const dir=mkdtempSync(join(tmpdir(),'messenger-preserve-'));
const root='a'.repeat(64),serverCid='b'.repeat(64),commands=[];
let isRoot=true,described={},invitationUses=0;
const client={currentIdentity:async()=>({cid:root,isRoot,temporary:false,...described}),addContact:async()=>{invitationUses++;return {cid:serverCid};},listContacts:async()=>({contacts:[{container_id:serverCid}]}),sendCommand:async value=>{commands.push(value);return {sent:true};},generateInvite:async()=>({blob:'fixture-public-invite'})};
const deps={runtime:{client},config:{stateDir:dir,publicOrigin:'http://localhost'},identityCid:root};
const http=createServer((req,res)=>void serveApi(req,res,deps));
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${http.address().port}/api/`;
const body={serverCid,invitation:'fixture',hostWorkspaceId:'h'.repeat(43),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000},name:'New',surname:'Account'};
const post=value=>fetch(base+'workspace/enroll',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-Ours-Messenger-CSRF':'1'},body:JSON.stringify(value)});
try {
 assert.equal((await (await fetch(base+'workspace/enrollment-identity')).json()).preserveProfile,true);
 writeHumanProfile(dir,root,{name:'Original',surname:'Human'});
 const file=join(dir,`human-${root}.json`),original=readFileSync(file);
 const preserved=await post({...body,preserveProfile:true,name:undefined,surname:undefined});assert.equal(preserved.status,200);
 assert.deepEqual(readFileSync(file),original,'existing profile bytes unchanged');
 assert.deepEqual(readHumanProfile(dir,root),{name:'Original',surname:'Human'});
 assert.equal(invitationUses,0,'retained pinned contact does not consume an invitation again');
 assert.equal(commands.length,1);assert.equal(commands[0].command,'bind-workspace');assert.equal(commands[0].arguments.nonce,body.challenge.nonce);
 rmSync(file);
 assert.equal((await post({...body,preserveProfile:true})).status,200);assert.deepEqual(readdirSync(dir),[],'absent profile stays absent');
 assert.equal((await post({...body,preserveProfile:'true'})).status,400);
 isRoot=false;assert.equal((await post({...body,preserveProfile:true})).status,400);assert.equal(commands.length,2,'delegated identity never submits proof');isRoot=true;
 assert.equal((await post(body)).status,200);assert.equal(invitationUses,1,'fresh enrollment still verifies invitation server CID');assert.deepEqual(readHumanProfile(dir,root),{name:'New',surname:'Account'},'fresh path still fills account name');
 // The person's own identity under the Human root: it names its root, takes Name and Surname, and never signs the proof.
 const parent='d'.repeat(64),identity=()=>fetch(base+'workspace/enrollment-identity'),profile=value=>fetch(base+'identity/profile',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-Ours-Messenger-CSRF':'1'},body:JSON.stringify(value)});
 rmSync(join(dir,`human-${root}.json`));isRoot=false;described={described:true,roleId:'role-1',rootCid:parent.toUpperCase()};
 assert.deepEqual(await (await identity()).json(),{cid:root,rootCid:parent.toUpperCase(),preserveProfile:true});
 assert.equal((await profile({name:'Alice',surname:'Tester'})).status,200);assert.deepEqual(readHumanProfile(dir,root),{name:'Alice',surname:'Tester'});
 assert.equal((await post({...body,preserveProfile:true})).status,400);assert.equal(commands.length,3,'an identity under the root never submits the proof');
 for(const other of [{described:false,roleId:'role-1',rootCid:parent},{described:true,roleId:'',rootCid:parent},{described:true,roleId:'role-1',rootCid:''},{described:true,roleId:'role-1',rootCid:root},{described:true,roleId:'role-1',rootCid:parent,temporary:true}]){
  described=other;assert.equal((await identity()).status,400,JSON.stringify(other));assert.equal((await profile({name:'Other',surname:'Person'})).status,400,JSON.stringify(other));
 }
 assert.deepEqual(readHumanProfile(dir,root),{name:'Alice',surname:'Tester'},'a refused identity leaves the profile unchanged');isRoot=true;described={};
 console.log('workspace profile preservation PASS — real HTTP handler/files; Ours client proof transport is a fixture');
}finally{await new Promise(resolve=>http.close(resolve));rmSync(dir,{recursive:true,force:true});}
