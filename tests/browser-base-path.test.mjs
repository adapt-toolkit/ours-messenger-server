import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serveApp } from '../src/server.ts';
const prefix='/base/messenger/';
const requests=[];
const server=createServer((req,res)=>{
 requests.push(req.url);
 if(!req.url.startsWith(prefix)){res.writeHead(404).end();return;}
 req.url='/'+req.url.slice(prefix.length);
 if(req.url.startsWith('/api/')){res.writeHead(503,{'content-type':'application/json'}).end('{"error":{"message":"fixture"}}');return;}
 void serveApp(req,res,resolve('dist/web'),prefix);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 const failures=[];page.on('pageerror',e=>failures.push(e.message));
 await page.goto(origin+prefix+'chats',{waitUntil:'networkidle'});
 assert.equal(await page.locator('meta[name="ours-base-path"]').getAttribute('content'),prefix);
 assert.ok(requests.some(path=>path.startsWith(prefix+'assets/')));
 assert.ok(requests.some(path=>path.startsWith(prefix+'api/')));
 assert.equal(requests.some(path=>path.startsWith('/api/')||path.startsWith('/assets/')),false);
 const manifest=await page.evaluate(async()=>fetch(document.querySelector('link[rel="manifest"]').href).then(r=>r.json()));
 assert.equal(manifest.scope,prefix);assert.equal(manifest.start_url,prefix+'chats');
 assert.ok(manifest.icons.every(icon=>icon.src.startsWith(prefix)));
 const scope=await page.evaluate(async prefix=>(await navigator.serviceWorker.register(prefix+'sw.js',{scope:prefix})).scope,prefix);
 assert.equal(scope,origin+prefix);
 assert.deepEqual(failures,[]);
 console.log('browser prefix: nested assets, API, manifest and worker scope passed');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
