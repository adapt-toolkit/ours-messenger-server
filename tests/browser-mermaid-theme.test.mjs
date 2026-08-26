// Mermaid previews must render with the messenger theme, not a fixed palette.
// This drives the built app, opens a real Markdown attachment, and inspects the
// generated SVG as well as its surrounding canvas in both app themes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

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
  });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const measurements = [];

const markdown = [
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

try {
  for (const dark of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 800 } });
    await context.addInitScript((enabled) => localStorage.setItem('ours-dark-v3', enabled ? '1' : '0'), dark);
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
      if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
      if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
      if (url.pathname === '/api/conversations/PEER/page') {
        return json({
          contact: 'PEER',
          messages: [{ dir: 'in', text: '', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'MARKDOWN', receipt: null }],
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
    await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
    await page.getByTitle('Preview markdown').click();
    await page.waitForFunction(() => (
      document.querySelectorAll('.markdown-mermaid-diagram svg, .markdown-mermaid-error').length === 2
    ));
    const renderErrors = await page.locator('.markdown-mermaid-error').allTextContents();
    assert.deepEqual(renderErrors, [], `Mermaid fixture must render without errors: ${renderErrors.join(' | ')}`);

    const facts = await page.evaluate(() => {
      const rgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = rgb(value).map((part) => {
          const normalized = part / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const diagrams = [...document.querySelectorAll('.markdown-mermaid')];
      const note = diagrams[1]?.querySelector('rect.note');
      const noteText = diagrams[1]?.querySelector('.noteText');
      const sequenceTextLuminances = [...(diagrams[1]?.querySelectorAll(
        'svg .messageText, svg .labelText, svg .loopText, svg .noteText',
      ) ?? [])]
        .filter((node) => !node.closest('defs') && node.textContent?.trim())
        .map((node) => ({ text: node.textContent.trim(), color: getComputedStyle(node).fill }))
        .map((entry) => ({ ...entry, luminance: luminance(entry.color) }));
      const canvasColor = getComputedStyle(diagrams[0]).backgroundColor;
      const noteColor = note ? getComputedStyle(note).fill : '';
      const noteTextColor = noteText ? getComputedStyle(noteText).fill : '';
      return {
        themes: diagrams.map((node) => node.getAttribute('data-mermaid-theme')),
        canvasColor,
        canvasLuminance: luminance(canvasColor),
        noteColor,
        noteLuminance: luminance(noteColor),
        noteTextColor,
        sequenceTextLuminances,
      };
    });

    await page.locator('.markdown-mermaid-expand').first().click();
    const fullscreenLuminance = await page.locator('.mermaid-fullscreen').evaluate((node) => {
      const channels = (getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
    });
    measurements.push({ mode: dark ? 'dark' : 'light', ...facts, fullscreenLuminance });

    await context.close();
  }

  console.log(`browser-mermaid-theme measurements ${JSON.stringify(measurements)}`);
  for (const facts of measurements) {
    const dark = facts.mode === 'dark';
    assert.deepEqual(facts.themes, [dark ? 'dark' : 'default', dark ? 'dark' : 'default']);
    if (dark) {
      assert.ok(facts.canvasLuminance < 0.08,
        `dark Mermaid canvas must be dark (saw ${facts.canvasColor}, luminance ${facts.canvasLuminance})`);
      assert.ok(facts.sequenceTextLuminances.length > 15, 'complex sequence fixture exposes its body labels');
      assert.ok(facts.sequenceTextLuminances.every((entry) => entry.luminance > 0.25),
        `dark sequence labels must remain readable: ${JSON.stringify(facts.sequenceTextLuminances)}`);
    } else {
      assert.ok(facts.canvasLuminance > 0.85,
        `light Mermaid canvas must be light (saw ${facts.canvasColor}, luminance ${facts.canvasLuminance})`);
      assert.ok(facts.noteLuminance > 0.45,
        `light sequence notes must not render as dark blobs (saw ${facts.noteColor}, luminance ${facts.noteLuminance})`);
    }
    assert.notEqual(facts.noteColor, facts.noteTextColor, 'sequence-note text remains distinct from its fill');
    assert.ok(dark ? facts.fullscreenLuminance < 0.25 : facts.fullscreenLuminance > 0.75,
      `fullscreen Mermaid viewer follows the ${dark ? 'dark' : 'light'} app theme`);
  }

  // A preview can remain open while the app theme changes. The SVG must be
  // regenerated, otherwise a default-theme sequence diagram becomes black
  // text on the newly-dark canvas.
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1600, height: 1200 } });
  await context.addInitScript(() => localStorage.setItem('ours-dark-v3', '0'));
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Me', cid: 'ME-CID' });
    if (url.pathname === '/api/build-info') return json({ name: 'fixture', version: '1', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts: [{ name: 'Peer', container_id: 'PEER' }], pending: [] });
    if (url.pathname === '/api/conversations/PEER/page') {
      return json({
        contact: 'PEER',
        messages: [{ dir: 'in', text: '', date: '2026-08-15T00:00:00.000Z', read: true, wire_id: 'MARKDOWN', receipt: null }],
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
  await page.goto(`${origin}/chats/PEER`, { waitUntil: 'domcontentloaded' });
  await page.getByTitle('Preview markdown').click();
  await page.waitForFunction(() => (
    document.querySelectorAll('.markdown-mermaid').length === 2
      && [...document.querySelectorAll('.markdown-mermaid')]
        .every((node) => node.getAttribute('data-mermaid-theme') === 'default')
  ));
  await page.evaluate(() => document.documentElement.classList.add('theme-dark'));
  await page.waitForFunction(() => (
    document.querySelectorAll('.markdown-mermaid').length === 2
      && [...document.querySelectorAll('.markdown-mermaid')]
        .every((node) => node.getAttribute('data-mermaid-theme') === 'dark')
  ));
  await page.locator('.markdown-mermaid-expand').nth(1).click();
  const transitionedText = await page.locator('.mermaid-fullscreen-canvas svg').evaluate((svg) => {
    const luminance = (value) => {
      const channels = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((part) => {
        const normalized = part / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    return [...svg.querySelectorAll('.messageText, .labelText, .loopText, .noteText')]
      .filter((node) => !node.closest('defs') && node.textContent?.trim())
      .map((node) => ({ text: node.textContent.trim(), color: getComputedStyle(node).fill }))
      .map((entry) => ({ ...entry, luminance: luminance(entry.color) }));
  });
  assert.ok(transitionedText.length > 15, 'fullscreen transition fixture exposes its body labels');
  assert.ok(transitionedText.every((entry) => entry.luminance > 0.25),
    `theme-switched sequence labels must remain readable: ${JSON.stringify(transitionedText)}`);
  await context.close();

  console.log('browser-mermaid-theme OK — generated SVG and canvases follow light/dark messenger themes');
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
