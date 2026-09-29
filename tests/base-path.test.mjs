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
