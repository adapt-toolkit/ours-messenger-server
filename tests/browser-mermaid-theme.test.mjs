// Mermaid previews must render with the messenger theme, not a fixed palette.
// This drives the built app, opens a real Markdown attachment, and inspects the
// generated SVG as well as its surrounding canvas in both app themes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const webRoot = resolve(process.env.OURS_BROWSER_WEB_ROOT ?? new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the Mermaid theme gate');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-security-policy': readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8').match(/const APP_CSP = "([^"]+)"/)[1],
  });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await (process.env.MERMAID_BROWSER_ENGINE === 'webkit' ? webkit : chromium).launch({ headless: true });

const validMarkdown = [
  'Review this paragraph.',
  '',
  '```mermaid',
  'flowchart TD',
  '  Start[Start] --> Choice{Choose}',
  '  Choice -->|Yes| Done[Done]',
  '  Choice -->|No| Retry[Retry]',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  actor A as Agent or harness',
  '  participant P as agents.coworking',
  '  participant S as Plugin state',
  '  participant SDK as ours SDK',
  '  participant D as Shared ours daemon',
  '  participant R as Hosted cowork room',
  '  alt First join',
  '    A->>P: join_room(invite_or_link)',
  '    P->>SDK: attachOursClient()',
  '    SDK->>D: verify daemon and open client lease',
  '    D-->>SDK: attached',
  '    P->>S: load app selection',
  '    alt No reusable app context',
  '      P->>SDK: create or resolve app identity',
  '      SDK->>D: create or reuse and bind',
  '    else Existing app context',
  '      P->>SDK: select persisted app identity',
  '      SDK->>D: bind it to this client lease',
  '    end',
  '    P->>SDK: accept room invitation',
  '    SDK->>D: redeem invite and connect',
  '    D->>R: establish room peer channel',
  '    R-->>D: room ready',
  '  else Subsequent reconnect',
  '    A->>P: reopen saved room',
  '    P->>S: load app and room selection',
  '    P->>SDK: attach and select persisted app context',
  '    SDK->>D: re-establish client lease binding',
  '    D->>R: resume room peer channel',
  '    R-->>D: room ready or connection error',
  '  end',
  '  Note over A,R: room-oriented public API, identity stays internal',
  '```',
].join('\n');


const invalidSource = 'flowchart TD\n A[Unclosed';
const configuredSource = '%%{init: {"theme":"dark"}}%%\nflowchart TD\n A --> B';
const longSource = 'flowchart LR\n A[Human browser with a long descriptive label] --> B[Backend HTTP API and domain modules] --> C[Private provider storage and worker]';
const markdown = validMarkdown + '\n```mermaid\n' + longSource + '\n```\n```mermaid\n' + invalidSource + '\n```\n```mermaid\n' + configuredSource + '\n```';
try {
  for (const [dark, width] of [[true, 390], [false, 390], [true, 1200], [false, 1200]]) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 844 } });
    await context.addInitScript((enabled) => {
      localStorage.setItem('ours-dark-v3', enabled ? '1' : '0');
      window.__created = []; window.__revoked = []; window.__blobs = new Map();
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = create(blob); window.__created.push(url); window.__blobs.set(url, blob); return url; };
      URL.revokeObjectURL = (url) => { window.__revoked.push(url); return revoke(url); };
    }, dark);
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
      if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
      if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
      if (url.pathname === '/api/conversations/PEER/page') {
        return json({
          contact: 'PEER',
          messages: [{dir: 'in', text: markdown, date: '2026-08-15T00:00:01.000Z', read: true, wire_id: 'TEXT'}, { dir: 'in', text: '', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'MARKDOWN', receipt: null }],
          total: 1, unread: 0, hasMore: false, nextBefore: null,
        });
      }
      if (url.pathname === '/api/conversations/PEER/read') return json({ contact: 'PEER', marked: 0 });
      if (url.pathname === '/api/conversations/PEER/files') {
        return json({
          contact: 'PEER',
          files: [{
            wire_id: 'MARKDOWN', contact_id: 'PEER', dir: 'in', filename: 'diagram.md',
            mime: 'text/markdown', size: markdown.length, date: '2026-08-15T00:00:00.000Z', available: true,
          }],
        });
      }
      if (url.pathname === '/api/media/MARKDOWN') {
        return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: markdown });
      }
      if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      return json({}, 404);
    });


    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.message-markdown .markdown-mermaid-diagram img').length === 3 && document.querySelectorAll('.message-markdown .markdown-mermaid-error').length === 2);
    assert.equal(await page.locator('.message-markdown .markdown-mermaid-error').count(), 2);
    await page.getByTitle('Preview markdown').click();
    await page.waitForFunction(() => document.querySelectorAll('.markdown-body .markdown-mermaid-diagram img').length === 3 && document.querySelectorAll('.markdown-body .markdown-mermaid-error').length === 2);
    assert.equal(await page.locator('.markdown-body .markdown-mermaid-error').count(), 2);
    assert.equal(await page.locator('.markdown-body .mermaid-source[open] code').first().textContent(), invalidSource);
    assert.equal(await page.locator('.markdown-body pre .mermaid-block').count(), 0, 'diagrams are not nested inside code pre elements');
    await page.waitForFunction(() => [...document.querySelectorAll('.markdown-mermaid-diagram img')].every(img => img.complete && img.naturalWidth > 0));
    const facts = await page.locator('.markdown-body .markdown-mermaid-diagram img').evaluateAll(async (images) => {
      return Promise.all(images.map(async (img) => {
        const source = await window.__blobs.get(img.src).text();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0, black = 0, colored = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i+3] < 240) continue;
          opaque++;
          if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) < 8) black++;
          if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) - Math.min(pixels[i], pixels[i+1], pixels[i+2]) > 8) colored++;
        }
        return { width: img.naturalWidth, height: img.naturalHeight, opaque, black, colored, source };
      }));
    });
    console.log('image facts', dark, facts.map(({source, ...rest}) => rest));
    for (const fact of facts) {
      assert.ok(!fact.source.includes('<foreignObject'), 'text-only SVG labels avoid HTML style/measurement dependence');
      assert.ok(!fact.source.includes('var(--sans)'), 'SVG fonts are standalone');
      assert.ok(fact.opaque > 500, 'image actually paints themed diagram shapes');
      assert.ok(fact.black / fact.opaque < 0.1, 'diagram is not dominated by default black SVG fills');
    }
    // Inspect the serialized SVG in a separate test document where SVG style
    // rules can be measured. Production uses image mode (validated by pixels
    // above), which isolates these styles automatically; APP_CSP stays intact.
    for (const [index, fact] of facts.entries()) {
      const inspection = await context.newPage();
      await inspection.route('**/diagram-inspection.svg', route => route.fulfill({
        contentType: 'image/svg+xml', body: fact.source,
        headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
      }));
      await inspection.goto(`${origin}/diagram-inspection.svg`);
      const metrics = await inspection.evaluate(() => {
        const luminance = color => {
          const c = (color.match(/[\d.]+/g) ?? []).slice(0,3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return .2126*c[0]+.7152*c[1]+.0722*c[2];
        };
        const labels = [...document.querySelectorAll('.messageText, .labelText, .loopText, .noteText')]
          .filter(el => el.textContent.trim()).map(el => ({text: el.textContent, luminance: luminance(getComputedStyle(el).fill)}));
        const nodes = [...document.querySelectorAll('g.node')].map(node => {
          const shape = node.querySelector('rect.label-container, polygon.label-container, path.label-container');
          const label = node.querySelector('g.label');
          if (!shape || !label) return null;
          const box = shape.getBoundingClientRect(), text = label.getBoundingClientRect();
          return {text: label.textContent, fits: text.left >= box.left - 1 && text.right <= box.right + 1 && text.top >= box.top - 1 && text.bottom <= box.bottom + 1};
        }).filter(Boolean);
        return { labels, nodes };
      });
      if (index === 1 && dark) {
        assert.ok(metrics.labels.length > 15, 'complex sequence exposes body labels');
        assert.ok(metrics.labels.every(label => label.luminance > .25), `dark sequence labels remain readable: ${JSON.stringify(metrics.labels)}`);
      }
      if (index === 2) {
        assert.equal(metrics.nodes.length, 3, 'long-label fixture exposes all node bounds');
        assert.ok(metrics.nodes.every(node => node.fits), `long labels fit their nodes: ${JSON.stringify(metrics.nodes)}`);
      }
      await inspection.close();
    }
    const layout = await page.locator('.markdown-body .markdown-mermaid-diagram').nth(2).evaluate(el => ({width: el.clientWidth, scroll: el.scrollWidth, doc: document.documentElement.scrollWidth, viewport: innerWidth}));
    assert.ok(layout.scroll > layout.width, 'wide diagrams retain readable dimensions inside horizontal scroll');
    assert.ok(layout.doc <= layout.viewport, 'wide diagrams never widen the mobile document');
    if (process.env.MERMAID_EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.MERMAID_EVIDENCE_DIR}/after-${dark ? 'dark' : 'light'}-${width}.png` });
    }
    await page.getByRole('button', {name: 'Start review', exact: true}).click();
    await page.locator('.markdown-body > p').first().evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.getByRole('button', {name: /Add review comment/}).click();
    await page.getByPlaceholder('What should change?').fill('Keep this draft across fullscreen.');
    await page.getByRole('button', {name: 'Add to review', exact: true}).click();
    const originalImages = await page.locator('.markdown-body .markdown-mermaid-diagram img').evaluateAll(imgs => imgs.map(img => img.src));
    await page.getByRole('button', {name: 'View reader fullscreen', exact: true}).click();
    const readerBounds = await page.locator('.markdown-reader-fullscreen').evaluate(el => {
      const rect = el.getBoundingClientRect(); return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight};
    });
    assert.ok(Math.abs(readerBounds.x) < 1 && Math.abs(readerBounds.y) < 1 && Math.abs(readerBounds.width - readerBounds.viewportWidth) < 1 && Math.abs(readerBounds.height - readerBounds.viewportHeight) < 1, 'complete reader fills the viewport');
    if (process.env.MERMAID_EVIDENCE_DIR) await page.screenshot({path: `${process.env.MERMAID_EVIDENCE_DIR}/reader-fullscreen-${dark ? 'dark' : 'light'}-${width}.png`});
    assert.ok(await page.getByRole('button', {name: 'Submit review', exact: true}).isVisible());
    assert.ok(await page.getByRole('link', {name: 'Download', exact: true}).isVisible());
    assert.ok(await page.locator('.markdown-review-comment').getByText('Keep this draft across fullscreen.').isVisible());
    await page.locator('.markdown-body .markdown-mermaid-expand').first().click();
    await page.locator('.mermaid-fullscreen-canvas img').waitFor();
    assert.equal(await page.locator('.mermaid-fullscreen-canvas svg').count(), 0, 'fullscreen image cannot duplicate SVG IDs in document');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.equal(await page.locator('.mermaid-zoom-value').textContent(), '125%');
    await page.locator('.mermaid-fullscreen-viewport').focus();
    await page.keyboard.press('ArrowRight');
    assert.ok((await page.locator('.mermaid-fullscreen-canvas').getAttribute('style')).includes('-40px'), 'keyboard pan reaches offscreen content');
    await page.keyboard.press('0');
    assert.equal(await page.locator('.mermaid-zoom-value').textContent(), '100%');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.mermaid-fullscreen'));
    assert.ok(await page.locator('.markdown-reader-fullscreen').isVisible(), 'nested diagram close keeps reader fullscreen');
    await page.getByRole('button', {name: 'Exit reader fullscreen', exact: true}).click();
    assert.equal(await page.locator('.markdown-reader-fullscreen').count(), 0);
    assert.ok(await page.locator('.markdown-review-comment').getByText('Keep this draft across fullscreen.').isVisible());
    assert.deepEqual(await page.locator('.markdown-body .markdown-mermaid-diagram img').evaluateAll(imgs => imgs.map(img => img.src)), originalImages, 'reader resize does not rerender diagrams');
    await page.evaluate(() => document.documentElement.classList.toggle('theme-dark'));
    await page.waitForFunction((theme) => [...document.querySelectorAll('.markdown-mermaid')].length === 6 && [...document.querySelectorAll('.markdown-mermaid')].every(el => el.dataset.mermaidTheme === theme), dark ? 'default' : 'dark');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.markdown-body'));
    await page.getByTitle('Preview markdown').click();
    await page.waitForFunction(() => document.querySelectorAll('.markdown-body .markdown-mermaid-diagram img').length === 3 && document.querySelectorAll('.markdown-body .markdown-mermaid-error').length === 2);
    await page.keyboard.press('Escape');
    await page.goto(`${origin}/settings`);
    await page.waitForFunction(() => window.__created.every(url => window.__revoked.includes(url)));
    assert.deepEqual(pageErrors, [], 'browser runtime must not throw');
    await context.close();
  }
  console.log('browser-mermaid-theme OK — production CSP, mobile/desktop images, label bounds/contrast, review fullscreen, source fallback, rerenders and URL cleanup');
} finally {
  await browser.close();
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
}
