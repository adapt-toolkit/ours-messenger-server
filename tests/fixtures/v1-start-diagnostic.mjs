// Disposable diagnostic of the exact built server export; no production diagnostics seam.
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../..');
let handle;
try {
 const chunks=join(root,process.env.MESSENGER_V1_DIST??'dist','chunks');
 const name=readdirSync(chunks).find(name=>/^server-.*\.js$/.test(name));
 if(!name) throw new Error('No built server chunk');
 const {start}=await import(pathToFileURL(join(chunks,name)));
 handle=await start({host:'127.0.0.1',port:Number(process.env.OURS_MESSENGER_PORT),publicOrigin:process.env.OURS_MESSENGER_PUBLIC_ORIGIN,
 identity:process.env.OURS_MESSENGER_IDENTITY,force:false,stateDir:process.env.OURS_MESSENGER_STATE_DIR},
 {name:'@ours.network/messenger-server',version:'1.0.27',sha:'afc1c680416b52d2c6a87a3f8f512943e0288d32',dirty:true});
 console.log('DIAGNOSTIC exact built server start succeeded');
} catch(error) {
 let message=String(error?.message??'unknown error');
 const path=process.env.OURS_DAEMON_CREDENTIAL_PATH;
 if(path&&existsSync(path)) message=message.replaceAll(readFileSync(path,'utf8').trim(),'[redacted credential]');
 for(const value of [process.env.HOME,process.env.OURS_MESSENGER_STATE_DIR,process.env.OURS_DAEMON_URL].filter(Boolean)) message=message.replaceAll(value,'[fixture location]');
 console.log('DIAGNOSTIC built server failure '+JSON.stringify({name:error?.name,code:error?.code,message:message.slice(0,1000)}));
 process.exitCode=1;
} finally {await handle?.close();}
