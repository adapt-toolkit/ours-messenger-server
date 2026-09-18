import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { OursClient } from '@ours.network/sdk/client';
import { startRuntime } from '../src/daemon.ts';

const BUILD = {name:'messenger',version:'fixture',sha:'1'.repeat(40),dirty:false};
const ACK = {released:[],closed:[],attempted:0,notified:0,failed:0};
const keys=['OURS_DAEMON_URL','OURS_DAEMON_ID','OURS_DAEMON_CREDENTIAL_PATH'];
async function selected(t, run, endpoint='http://127.0.0.1:3210') {
  const stateDir=mkdtempSync(join(tmpdir(),'messenger-owner-'));
  const cfg={stateDir,identity:'Messenger',host:'127.0.0.1',port:0,publicOrigin:'http://localhost',force:false};
  const before=keys.map(key=>process.env[key]);
  [endpoint,'fixture-daemon','/private/current-token'].forEach((value,i)=>process.env[keys[i]]=value);
  try {await run(cfg,join(stateDir,'owner-session.json'));}
  finally {
    keys.forEach((key,i)=>before[i]===undefined?delete process.env[key]:process.env[key]=before[i]);
    rmSync(stateDir,{recursive:true,force:true});
  }
}
const client=(extra={})=>({version:async()=>({version:'fixture',compat:3,stateDir:'/daemon'}),
  releaseLease:async()=>ACK,close:async()=>{},...extra});
const record=path=>JSON.parse(readFileSync(path,'utf8'));

test('owner is privately persisted before admission and terminal intent precedes release', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    let original;
    const runtime=await startRuntime(cfg,BUILD,async options=>{
      assert(existsSync(path),'owner record must precede SDK admission');
      original=record(path);
      assert.equal(original.phase,'active');assert.equal(original.ownerInstanceId,options.leaseToken);
      assert.equal(statSync(path).mode&0o777,0o600);
      assert.equal(statSync(cfg.stateDir).mode&0o777,0o700);
      return client({releaseLease:async args=>{
        const terminal=record(path);
        assert.equal(terminal.phase,'terminal');
        assert.equal(terminal.ownerInstanceId,original.ownerInstanceId);
        assert.deepEqual(args,{observation:terminal.observation});
        assert.equal(args.observation.reason,'session-end');
        assert.equal(args.observation.process.pid,process.pid);
        return ACK;
      }});
    });
    await runtime.close();
    assert.equal(existsSync(path),false,'acknowledged terminal state is cleared');
    assert(existsSync(join(cfg.stateDir,'owner-session.lock')),'activation inode must survive cleanup');
  });
});

test('failed startup closes transport and permits the same nonterminal owner to resume', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    let firstOwner,closed=0;
    await assert.rejects(startRuntime(cfg,BUILD,async options=>{
      firstOwner=options.leaseToken;
      return client({version:async()=>{throw Error('startup unavailable');},close:async()=>{closed++;}});
    }),/startup unavailable/);
    assert.equal(closed,1);
    assert.equal(record(path).phase,'active');
    const runtime=await startRuntime(cfg,BUILD,async options=>{
      assert.equal(options.leaseToken,firstOwner);
      return client();
    });
    await runtime.close();
  });
});

test('second activation refuses before SDK admission and never replaces the lock inode', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    const first=await startRuntime(cfg,BUILD,async()=>client());
    let second;
    try {
      const inode=statSync(join(cfg.stateDir,'owner-session.lock')).ino;
      let admitted=false;
      await assert.rejects(async()=>{
        second=await startRuntime(cfg,BUILD,async()=>{admitted=true;return client();});
      },/active|lock/i);
      assert.equal(admitted,false);
      assert.equal(statSync(join(cfg.stateDir,'owner-session.lock')).ino,inode);
      const original=first.leaseToken;await first.close();
      const next=await startRuntime(cfg,BUILD,async()=>client());
      try {assert.notEqual(next.leaseToken,original);assert.equal(statSync(join(cfg.stateDir,'owner-session.lock')).ino,inode);}
      finally {await next.close();}
    } finally {await second?.close();await first.close();}
  });
});

test('terminal release failure is immutable across retry and acknowledged before a fresh owner', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    let firstEvent;
    const runtime=await startRuntime(cfg,BUILD,async()=>client({releaseLease:async args=>{
      firstEvent=args;
      throw Error('release unavailable');
    }}));
    await assert.rejects(runtime.close(),/unavailable/);
    await assert.rejects(runtime.close(),/unavailable/);
    const saved=readFileSync(path,'utf8');
    assert.equal(record(path).phase,'terminal');
    let replayAttempts=0;
    await assert.rejects(startRuntime(cfg,BUILD,async options=>{
      assert.equal(options.leaseToken,runtime.leaseToken);
      return client({releaseLease:async args=>{
        replayAttempts++;assert.deepEqual(args,firstEvent);throw Error('still unavailable');
      }});
    }),/still unavailable/);
    assert.equal(replayAttempts,1);
    assert.equal(readFileSync(path,'utf8'),saved);
    const calls=[];
    const next=await startRuntime(cfg,BUILD,async options=>{
      calls.push(options.leaseToken);
      return client({releaseLease:async args=>{
        if(options.leaseToken===runtime.leaseToken) {
          assert.deepEqual(args,firstEvent);assert.equal(readFileSync(path,'utf8'),saved);
        }
        return ACK;
      }});
    });
    try {
      assert.deepEqual(calls,[runtime.leaseToken,next.leaseToken]);
      assert.notEqual(next.leaseToken,runtime.leaseToken);
      assert.equal(record(path).phase,'active');
    } finally {await next.close();}
  });
});

test('changed selection refuses without retargeting a saved owner or starting a client', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    await assert.rejects(startRuntime(cfg,BUILD,async()=>client({version:async()=>{throw Error('offline');}})),/offline/);
    const saved=readFileSync(path,'utf8');
    process.env.OURS_DAEMON_ID='different-daemon';
    let admitted=false;
    await assert.rejects(startRuntime(cfg,BUILD,async()=>{admitted=true;return client();}),/selection/i);
    assert.equal(admitted,false);
    assert.equal(readFileSync(path,'utf8'),saved);
  });
});

test('actual public SDK incomplete ACK retains terminal state and the same event replays', {timeout:5000}, async t=>{
  let complete=false;const delivered=[];
  const server=createServer((req,res)=>{
    if(req.url==='/version') {res.end(JSON.stringify({version:'fixture',compat:3,stateDir:'/daemon'}));return;}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      delivered.push(JSON.parse(body));
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(complete?ACK:{...ACK,failed:1}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  try {await selected(t,async(cfg,path)=>{
    const attach=async options=>new OursClient({url:endpoint,sessionMode:'external',leaseToken:options.leaseToken});
    const runtime=await startRuntime(cfg,BUILD,attach);
    await assert.rejects(runtime.close(),/acknowledgement|incomplete/);
    const saved=readFileSync(path,'utf8');const old=runtime.leaseToken;
    complete=true;
    const next=await startRuntime(cfg,BUILD,attach);
    try {
      assert.deepEqual(delivered[1],delivered[0]);
      assert.notEqual(next.leaseToken,old);
      assert.equal(JSON.parse(saved).observation.ownerInstanceId,old);
    } finally {await next.close();}
  },endpoint);} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('activation remains held until asynchronous transport close settles', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    let finish,entered;
    const gate=new Promise(resolve=>finish=resolve);
    const began=new Promise(resolve=>entered=resolve);
    const runtime=await startRuntime(cfg,BUILD,async()=>client({close:async()=>{entered();await gate;}}));
    const closing=runtime.close();await began;
    let admitted=false, contender;
    try {
      await assert.rejects(async()=>{contender=await startRuntime(cfg,BUILD,async()=>{admitted=true;return client();});},/active|lock/i);
      assert.equal(admitted,false);
    } finally {finish();await closing;await contender?.close();}
    const next=await startRuntime(cfg,BUILD,async()=>client());
    await next.close();
  });
});

test('dangling owner record symlink is preserved and refused before admission', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    const {symlinkSync,lstatSync,readlinkSync}=await import('node:fs');
    symlinkSync('missing-owner-record',path);
    let admitted=false,runtime;
    try {
      await assert.rejects(async()=>{runtime=await startRuntime(cfg,BUILD,async()=>{admitted=true;return client();});},/private|regular|record/i);
      assert.equal(admitted,false);
      assert(lstatSync(path).isSymbolicLink());
      assert.equal(readlinkSync(path),'missing-owner-record');
    } finally {await runtime?.close();}
  });
});

test('unsafe ancestry refuses before creating child application state', {timeout:5000}, async t=>{
  await selected(t,async(cfg)=>{
    const {mkdirSync,chmodSync}=await import('node:fs');
    const unsafe=join(cfg.stateDir,'unsafe');mkdirSync(unsafe);chmodSync(unsafe,0o777);
    const target=join(unsafe,'child');
    let admitted=false;
    await assert.rejects(startRuntime({...cfg,stateDir:target},BUILD,async()=>{admitted=true;return client();}),/ancestry|private/i);
    assert.equal(admitted,false);
    assert.equal(existsSync(target),false,'unsafe parents must not acquire child state during refusal');
  });
});

test('unavailable flock without a saved owner preserves native V1 process behavior', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    const oldPath=process.env.PATH;process.env.PATH=join(cfg.stateDir,'no-tools');
    let options,released=false,runtime;
    try {
      runtime=await startRuntime(cfg,BUILD,async value=>{
        options=value;
        return client({releaseLease:async args=>{assert.equal(args,undefined);released=true;return ACK;}});
      });
      assert.equal(options.sessionMode,'external');
      assert.equal(options.endpoint,'http://127.0.0.1:3210');
      assert.equal(options.expectedInstanceId,'fixture-daemon');
      assert.equal(existsSync(path),false,'native fallback does not pretend durable continuity');
      await runtime.close();assert(released);
    } finally {process.env.PATH=oldPath;await runtime?.close();}
  });
});

test('unavailable flock with saved state never resumes an owner unlocked', {timeout:5000}, async t=>{
  await selected(t,async(cfg,path)=>{
    await assert.rejects(startRuntime(cfg,BUILD,async()=>client({version:async()=>{throw Error('offline');}})),/offline/);
    const saved=readFileSync(path,'utf8');
    const oldPath=process.env.PATH;process.env.PATH=join(cfg.stateDir,'no-tools');
    let admitted=false;
    try {
      await assert.rejects(startRuntime(cfg,BUILD,async()=>{admitted=true;return client();}),/locking|activation|qualified/i);
      assert.equal(admitted,false);assert.equal(readFileSync(path,'utf8'),saved);
    } finally {process.env.PATH=oldPath;}
  });
});
