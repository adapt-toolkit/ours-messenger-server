// Exercise source changes directly, including canceled render work, under the
// same CSP as production. The attachment gate separately drives the built app.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = await mkdtemp(join(tmpdir(), 'messenger-mermaid-'));
const csp = (await readFile(join(root, 'src/server.ts'), 'utf8')).match(/const APP_CSP = "([^"]+)"/)[1];
await build({
  stdin: { contents: `import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {MermaidDiagram} from './web/src/ui/MermaidDiagram';
    window.created = []; window.revoked = []; window.blobs = new Map();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.created.push(url); window.blobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { window.revoked.push(url); revoke(url); };
    const root = createRoot(document.getElementById('root'));
    window.update = sources => flushSync(() => root.render(React.createElement(React.StrictMode, null,
      sources.map((source, i) => React.createElement(MermaidDiagram, {key:i, source})))));
  `, resolveDir: root, loader: 'tsx' },
  bundle: true, splitting: true, format: 'esm', outdir: output, entryNames: 'fixture',
  jsx: 'automatic', write: true, logLevel: 'silent',
});
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = pathname === '/' ? null : join(output, pathname.slice(1));
    if (file && !file.startsWith(`${output}/`)) throw new Error('outside fixture');
    const body = file ? await readFile(file) : '<div id="root"></div><script type="module" src="/fixture.js"></script>';
    res.writeHead(200, {'content-type': file ? 'text/javascript' : 'text/html', 'content-security-policy': csp});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await (process.env.MERMAID_BROWSER_ENGINE === 'webkit' ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => !!window.update);
  const first = 'flowchart TD\n A[Original] --> B[History]';
  const final = 'flowchart LR\n A[Final source] --> B[Updated message]';
  await page.evaluate(source => { for (let i=0; i<12; i++) window.update([source + '\n%% update ' + i]); }, first);
  await page.evaluate(source => window.update([source, source]), final);
  await page.waitForFunction(() => document.querySelectorAll('.markdown-mermaid-diagram img').length === 2);
  const sources = await page.locator('.markdown-mermaid-diagram img').evaluateAll(imgs => Promise.all(imgs.map(img => window.blobs.get(img.src).text())));
  assert.ok(sources.every(svg => svg.includes('Final') && svg.includes('Updated') && !svg.includes('Original')), 'only latest source is displayed');
  assert.equal(await page.locator('body > div[id^="dmermaid-"]').count(), 0, 'scratch SVGs are removed');
  assert.equal(await page.locator('svg[id^="mermaid-"]').count(), 0, 'no inline diagram IDs remain in host DOM');
  const urls = await page.locator('.markdown-mermaid-diagram img').evaluateAll(imgs => imgs.map(img => img.src));
  assert.notEqual(urls[0], urls[1], 'repeated diagrams own separate image lifetimes');

  // An inert HTML-looking label must not introduce HTML in the host page.
  const label = 'flowchart TD\n A["<b>Label</b>"] --> B[Text]';
  await page.evaluate(source => window.update([source]), label);
  await page.waitForFunction(() => document.querySelector('.markdown-mermaid-diagram img'));
  assert.equal(await page.locator('#root b, #root foreignObject, #root iframe').count(), 0);
  await page.locator('.markdown-mermaid-diagram img').dispatchEvent('error');
  assert.equal(await page.locator('.mermaid-source[open] code').textContent(), label, 'image decode failure preserves original source');

  for (const source of ['flowchart TD\n A[broken', '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n A --> B', '---\nconfig:\n  theme: dark\n---\nflowchart TD\n A --> B', 'x'.repeat(50_001)]) {
    await page.evaluate(source => window.update([source]), source);
    await page.waitForFunction(() => !!document.querySelector('.markdown-mermaid-error'));
    assert.equal(await page.locator('.mermaid-source[open] code').textContent(), source, 'failure fallback is complete and literal');
  }
  await page.evaluate(() => window.update([]));
  await page.waitForFunction(() => window.created.every(url => window.revoked.includes(url)));
  assert.equal(await page.locator('svg[id^="mermaid-"]').count(), 0);
  console.log('browser-mermaid-lifecycle OK — StrictMode, queued source updates, repeated diagrams, inert labels, decode/parse/config/size fallback and cleanup');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  await rm(output, {recursive: true, force: true});
}
