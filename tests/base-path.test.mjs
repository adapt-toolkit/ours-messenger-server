import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBasePath, prefixDocument } from '../src/base-path.ts';
test('runtime base path rewrites only application document URLs',()=>{
 const base=normalizeBasePath('/base/messenger');assert.equal(base,'/base/messenger/');
 const doc=prefixDocument('<head><script src="/assets/app.js"></script><link href="/manifest.webmanifest"></head>',base);
 assert.match(doc,/src="\/base\/messenger\/assets\/app.js"/);
 assert.match(doc,/name="ours-base-path" content="\/base\/messenger\/"/);
 for(const bad of ['//evil','/../x/','/a?x','/a"','http://evil'])assert.throws(()=>normalizeBasePath(bad));
});

test('prefixed service worker targets only its own application',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../web/public/sw.js',import.meta.url),'utf8').split("self.addEventListener('install'")[0];
 const scope={registration:{scope:'https://example.test/base/messenger/'}};
 const api=new Function('self',source+';return {safeNotificationUrl,selectClickTarget};')(scope);
 assert.equal(api.safeNotificationUrl('/chats/CID#message','https://example.test'),'/base/messenger/chats/CID#message');
 assert.equal(api.safeNotificationUrl('/cowork/','https://example.test'),'/base/messenger/chats');
 assert.equal(api.selectClickTarget([{url:'https://example.test/cowork/',focused:true},{url:'https://example.test/base/messenger/chats'}],'https://example.test').url,'https://example.test/base/messenger/chats');
});
