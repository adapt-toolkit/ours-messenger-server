import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {serveApi} from '../src/api.ts';
const root='a'.repeat(64),serverCid='b'.repeat(64),commands=[];
let isRoot=true,temporary=false,connected=true,identityCid=root,sent=true;
const client={currentIdentity:async()=>({cid:identityCid,isRoot,temporary}),listContacts:async()=>({contacts:connected?[{container_id:serverCid}]:[]}),sendCommand:async value=>{commands.push(value);return {sent};}};
const deps={runtime:{client},config:{publicOrigin:'http://localhost'},identityCid:root};
const server=createServer((req,res)=>void serveApi(req,res,deps));await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/api/workspace/unregister`;
const body={rootCid:root,serverCid,workspaceId:'w'.repeat(43),hostWorkspaceId:'h'.repeat(43),operationNonce:'o'.repeat(43),replacement:{workspaceId:'n'.repeat(43),accountId:'u'.repeat(43),nonce:'c'.repeat(43)}};
const post=async(value=body,csrf=true)=>{const res=await fetch(url,{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json',...(csrf?{'X-Ours-Messenger-CSRF':'1'}:{})},body:JSON.stringify(value)});return {status:res.status,value:await res.json()};};
try {
 assert.equal((await post(body,false)).status,403);assert.equal(commands.length,0);
 for(const change of [()=>isRoot=false,()=>temporary=true,()=>identityCid='d'.repeat(64),()=>connected=false]){change();assert.equal((await post()).status,400);assert.equal(commands.length,0);isRoot=true;temporary=false;identityCid=root;connected=true;}
 for(const value of [{...body,operationExpiresAt:0},{...body,operationExpiresAt:1.5},{...body,operationExpiresAt:Date.now()+86460000},{...body,operationNonce:'invalid'},{...body,serverCid:'bad'},{...body,replacement:{...body.replacement,extra:'bad'}},{...body,replacement:{...body.replacement,nonce:'bad'}}]){assert.equal((await post(value)).status,400);assert.equal(commands.length,0);}
 const result=await post();assert.equal(result.status,200);assert.deepEqual(result.value,{submitted:true,rootCid:root});
 assert.deepEqual(commands[0],{contact:serverCid.toUpperCase(),command:'unregister-workspace',arguments:{type:'ours.app.unregister-workspace.v1',workspaceId:body.workspaceId,hostWorkspaceId:body.hostWorkspaceId,operationNonce:body.operationNonce,replacement:body.replacement}});
 const deadline=Date.now()+86400000;assert.equal((await post({...body,operationExpiresAt:deadline})).status,200);assert.equal(commands[1].arguments.operationExpiresAt,deadline);
 // Expired signed operations must reach App so it can issue the private terminal refusal.
 assert.equal((await post({...body,operationExpiresAt:Date.now()-1000})).status,200);
 sent=false;assert.equal((await post({...body,replacement:undefined})).status,400);assert.equal(commands[3].arguments.replacement,undefined);
 console.log('Root-held Messenger retirement route: CSRF, immutable expected root, root-only delegation, ready server contact, strict challenge shape and send acknowledgement PASS');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
