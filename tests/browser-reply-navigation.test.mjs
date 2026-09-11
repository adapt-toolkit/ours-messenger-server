// Exercise real reply controls and timeline against isolated REST fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the scroll stability gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const streams = new Set();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});
    response.write(': fixture connected\n\n');
    streams.add(response);
    response.on('close',()=>streams.delete(response));
    return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const roomFixture = JSON.parse(readFileSync(new URL('./fixtures/cowork-room-envelopes.json', import.meta.url), 'utf8'));
const row = (id, extra = {}) => ({dir: 'in', text: `Message ${id}`, date: new Date(Date.UTC(2026, 7, 15, 0, id)).toISOString(), read: true, wire_id: `WIRE-${id}`, receipt: null, ...extra});
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({serviceWorkers: 'block', viewport: mobile ? {width:390,height:844} : {width:1280,height:900}, isMobile: mobile, hasTouch: mobile});
    let requests = 0;
    let delay = 0;
    let mode = 'normal';
    const recent = Array.from({length:40}, (_,i) => row(i+20));
    recent.push(row(60, {reply_to:{wire_id:'WIRE-25'}}), row(61,{reply_to:{wire_id:'WIRE-5'}}), row(62,{reply_to:{wire_id:'MISSING'}}));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname === '/api/identity') return json({name:'Me',cid:'ME'});
      if(url.pathname === '/api/build-info') return json({version:'0.1.0',sha:'fixture'});
      if(url.pathname === '/api/contacts') return json({contacts:[{name:roomFixture.announced_contact,container_id:'ROOM'},{name:'Peer',container_id:'PEER'},{name:'Other',container_id:'OTHER'}],pending:[]});
      if(url.pathname === '/api/conversations/ROOM/page') {
        const original = roomFixture.cases[0].body;
        return json({contact:'ROOM',messages:[
          row(0,{wire_id:'LOCAL-ORIGINAL',text:JSON.stringify(original)}),
          row(1,{wire_id:original.message_id,text:'Unrelated decoy with the room message id'}),
          ...Array.from({length:30},(_,i)=>row(i+2)),
          row(40,{wire_id:'LOCAL-REPLY',text:JSON.stringify({...original,message_id:'ROOM-REPLY',text:'A room reply',reply_to:{message_id:original.message_id}}),reply_to:{wire_id:'LOCAL-ORIGINAL'}})
        ],total:33,unread:0,hasMore:false,nextBefore:null});
      }
      if(url.pathname.endsWith('/page')) {
        if(url.searchParams.has('before')) {
          requests++;
          await new Promise(r=>setTimeout(r,delay));
          if (mode === 'error') return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture unavailable'})});
          if (mode === 'bounded' || mode === 'cycle') return json({contact:'PEER',messages:[row(-requests)],total:10000,unread:0,hasMore:true,nextBefore:mode === 'cycle' ? 'older' : `cursor-${requests}`});
          return json({contact:'PEER',messages:Array.from({length:20},(_,i)=>row(i)),total:63,unread:0,hasMore:false,nextBefore:null});
        }
        return json({contact:'PEER',messages:recent,total:63,unread:0,hasMore:true,nextBefore:'older'});
      }
      if(url.pathname.endsWith('/files')) return json({files:[{wire_id:'FILE-REPLY',dir:'in',filename:'example.txt',mime:'text/plain',size:12,date:new Date(Date.UTC(2026,7,15,1,3)).toISOString(),reply_to:{wire_id:'WIRE-25'}}]});
      if(url.pathname.endsWith('/read')) return json({marked:0});
      if(url.pathname === '/api/events') return route.fallback();
      return json({});
    });
    const page = await context.newPage();
    await page.goto(`${origin}/chats/PEER`, {waitUntil:'domcontentloaded'});
    const activate = async id => {const q=page.locator(`#chat-message-WIRE-${id} .quote`); if (mobile) await q.tap(); else await q.click();};
    const highlighted = id => page.locator(`#chat-message-WIRE-${id}.reply-highlight`);
    await activate(60);
    await highlighted(25).waitFor({timeout:3000});
    assert.equal(requests,0,'mounted target needs no history fetch');
    const visible = await highlighted(25).evaluate(el=>{const a=el.getBoundingClientRect(), b=el.closest('.messages').getBoundingClientRect();return a.top>=b.top && a.bottom<=b.bottom;});
    assert.ok(visible,'original is visible inside timeline');
    await page.waitForTimeout(1700);
    assert.equal(await highlighted(25).count(),0,'highlight expires');
    assert.equal(await page.locator('#chat-message-WIRE-25').evaluate(el=>getComputedStyle(el).outlineStyle),'none','no persistent visual highlight after expiry');
    await activate(60);
    await highlighted(25).waitFor();
    // Re-activate while the old timer is live; its cleanup must not clear the new highlight.
    await page.waitForTimeout(800);
    await activate(60);
    await page.waitForTimeout(800);
    assert.equal(await highlighted(25).count(),1,'repeat activation restarts the highlight lifetime');
    await page.emulateMedia({reducedMotion:'reduce'});
    await activate(61);
    await highlighted(5).waitFor();
    assert.equal(requests,1,'older target fetched once');
    assert.equal(await highlighted(25).count(),0,'new target clears the previous highlight');
    assert.equal(await highlighted(5).evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.waitForTimeout(300);
    await page.screenshot({path:`/tmp/reply-navigation-${mobile?'mobile':'desktop'}.png`});
    await activate(62);
    await page.getByRole('status').filter({hasText:/original message.*unavailable/i}).waitFor();
    assert.equal(await page.locator('.reply-highlight').count(),0);
    const fileQuote = page.locator('#chat-message-FILE-REPLY .quote');
    await fileQuote.focus();
    await fileQuote.press('Enter');
    await highlighted(25).waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'chat-message-WIRE-25','keyboard focus follows the original');
    await page.locator('.messages').dispatchEvent('wheel');
    assert.equal(await highlighted(25).count(),0,'reader intent clears highlight');
    await fileQuote.focus();
    await fileQuote.press('Space');
    await highlighted(25).waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'chat-message-WIRE-25','Space still activates a native quote button');
    // Delayed responses must not navigate after user intent or a contact switch.
    await page.reload({waitUntil:'domcontentloaded'}); delay=500;
    await activate(61);
    await page.locator('.messages').dispatchEvent('wheel');
    await page.waitForTimeout(750);
    assert.equal(await highlighted(5).count(),0);
    assert.equal(await page.locator('#chat-message-WIRE-5').count(),0,'cancelled load is not committed');
    await activate(61);
    await page.locator('.messages').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(750);
    assert.equal(await page.locator('#chat-message-WIRE-5').count(),0,'keyboard scrolling cancels pending navigation');
    await activate(61);
    await page.evaluate(()=>{history.pushState({},'', '/chats/OTHER');dispatchEvent(new PopStateEvent('popstate'));});
    await page.waitForTimeout(750);
    assert.equal(await page.locator('.reply-highlight').count(),0);
    await page.goto(`${origin}/chats/PEER`, {waitUntil:'domcontentloaded'}); delay=0; mode='bounded'; requests=0;
    await activate(62);
    await page.getByRole('status').filter({hasText:/search limit/i}).waitFor();
    assert.equal(requests,10,'history search stops at ten pages');
    assert.equal(await page.locator('#chat-message-WIRE--1').count(),0,'failed bounded lookup leaves timeline unchanged');
    mode='cycle'; requests=0;
    await activate(62);
    await page.getByRole('status').filter({hasText:/search limit/i}).waitFor();
    assert.equal(requests,1,'opaque repeated cursor stops paging');
    mode='error';
    await activate(62);
    await page.getByRole('status').filter({hasText:/could not load/i}).waitFor();
    assert.equal(await page.locator('.reply-highlight').count(),0);
    await page.goto(`${origin}/chats/ROOM`, {waitUntil:'domcontentloaded'});
    const roomQuote = page.locator('#chat-message-LOCAL-REPLY .quote');
    if (mobile) await roomQuote.tap(); else await roomQuote.click();
    await page.locator('#chat-message-LOCAL-ORIGINAL.reply-highlight').waitFor();
    assert.equal(await page.locator(`[id="chat-message-${roomFixture.cases[0].body.message_id}"].reply-highlight`).count(),0,'room message id cannot override recipient-local wire reference');
    await context.close();
  }
  console.log('reply navigation OK — desktop/touch, exact room/file references, bounded paging, errors, keyboard, repeated activation, reduced motion and cancellation');
} finally {await browser.close(); for (const stream of streams) stream.end(); await new Promise(r=>server.close(r));}
