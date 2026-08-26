import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import jsQR from 'jsqr';

const repo = resolve(new URL('..', import.meta.url).pathname);
const root = join(repo, 'dist/web');
const out = join(repo, 'docs/design/baselines/calm-workspace-slice-1');
const types = new Map([['.css', 'text/css'], ['.html', 'text/html'], ['.js', 'text/javascript']]);
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const candidate = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${root}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html');
  res.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream' }); res.end(readFileSync(path));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const contacts = [{ name: 'Design room', container_id: 'DESIGN' }, { name: 'Research agent', container_id: 'RESEARCH' }];
const messages = [
  { dir: 'in', text: 'The calmer token map is ready for review.', date: '2026-08-26T09:00:00Z', read: true, wire_id: 'CALM-IN' },
  { dir: 'out', text: 'Great. Let’s keep provenance visible and the workspace quiet.', date: '2026-08-26T09:02:00Z', read: true, wire_id: 'CALM-OUT' },
];
const browser = await chromium.launch({ headless: true });
const capture = async (name, viewport, dark, extra = '', action = '') => {
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, serviceWorkers: 'block' });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/identity') return json({ name: 'Maya Chen', cid: 'MAYA-' + 'A'.repeat(56) });
    if (url.pathname === '/api/build-info') return json({ name: 'messenger', version: 'test', sha: 'fixture' });
    if (url.pathname === '/api/contacts') return json({ contacts, pending: [{ name: 'Critic pending approval with a long identity name', container_id: 'CRITIC', queued: 1 }] });
    if (url.pathname.endsWith('/page')) return json({ contact: 'DESIGN', messages, total: 2, unread: 0, hasMore: false, nextBefore: null });
    if (url.pathname.endsWith('/files')) return json({ contact: 'DESIGN', files: [] });
    if (url.pathname.endsWith('/read')) return json({ contact: 'DESIGN', marked: 0 });
    if (url.pathname === '/api/invites' && route.request().method() === 'POST') return json({ blob: 'ours-invite-fixture-quiet-zone-round-trip' });
    if (url.pathname === '/api/invites') return json([]);
    return json({});
  });
  await context.addInitScript((value) => localStorage.setItem('ours-dark-v3', value), dark ? '1' : '0');
  const page = await context.newPage(); await page.goto(`${origin}/chats/DESIGN`); await page.locator('.composer textarea').waitFor();
  if (action === 'invite') { await page.getByRole('button', { name: 'Invite' }).click(); await page.locator('.modal').waitFor(); }
  if (action === 'media') { await page.getByRole('button', { name: /Media/ }).click(); await page.locator('.shared-media-modal').waitFor(); }
  if (action === 'settings') {
    if (viewport.width < 600) { await page.locator('.command-me').click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); }
    else await page.locator('.command-settings').click();
    await page.locator('.modal').waitFor();
  }
  if (action === 'qr') {
    await page.getByRole('button', { name: 'Invite' }).click({ force: true });
    await page.getByRole('button', { name: 'Generate invite' }).click();
    const canvas = page.locator('[data-testid="qr-canvas"]'); await canvas.waitFor();
    const rendered = await canvas.evaluate((node) => { const context = node.getContext('2d'); const pixels = context.getImageData(0, 0, node.width, node.height); return { width: node.width, height: node.height, data: Array.from(pixels.data), invite: node.dataset.invite }; });
    const decoded = jsQR(new Uint8ClampedArray(rendered.data), rendered.width, rendered.height);
    if (!decoded || decoded.data !== rendered.invite) throw new Error('rendered production QR canvas failed round-trip decode');
    const isWhite = (x, y) => rendered.data[(y * rendered.width + x) * 4] === 255 && rendered.data[(y * rendered.width + x) * 4 + 1] === 255 && rendered.data[(y * rendered.width + x) * 4 + 2] === 255;
    for (let i = 0; i < rendered.width; i += 1) if (!isWhite(i, 0) || !isWhite(i, rendered.height - 1) || !isWhite(0, i) || !isWhite(rendered.width - 1, i)) throw new Error('rendered production QR canvas lacks an untinted quiet boundary');
  }
  if (action === 'scanner') {
    await page.goto(`${origin}/chats`); await page.getByRole('button', { name: 'Invite' }).click();
    await page.getByRole('tab', { name: 'Accept invite' }).click(); await page.getByRole('button', { name: 'Scan QR code' }).click();
    await page.locator('[data-testid="qr-scanner"]').waitFor();
  }
  if (extra === 'grayscale') await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
  if (extra === 'zoom200') await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.waitForTimeout(200); await page.screenshot({ path: join(out, `after-${name}.png`), fullPage: true });
  if (action === 'invite') {
    const trigger = page.getByRole('button', { name: 'Invite' });
    const focused = async () => {
      try {
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Invite', undefined, { timeout: 1_000 });
        return trigger.evaluate((node) => document.activeElement === node);
      } catch { return false; }
    };
    await page.getByRole('button', { name: 'Close Invite a contact' }).click(); await page.locator('.modal').waitFor({ state: 'detached' }); if (!await focused()) throw new Error('dialog close button did not restore trigger focus');
    await trigger.click(); await page.locator('.modal').waitFor(); await page.keyboard.press('Escape'); await page.locator('.modal').waitFor({ state: 'detached' }); if (!await focused()) throw new Error('dialog Escape did not restore trigger focus');
    await trigger.click(); await page.locator('.modal').waitFor(); await page.locator('.modal-backdrop').click({ position: { x: 4, y: 4 } }); await page.locator('.modal').waitFor({ state: 'detached' }); if (!await focused()) throw new Error('dialog overlay did not restore trigger focus');
  }
  await context.close();
};
try {
  if (process.env.CALM_SLICE2_CAPTURE) {
    const phase = process.env.CALM_SLICE2_CAPTURE;
    await capture(`slice2-${phase}-invite-modal-light`, { width: 1440, height: 960 }, false, '', 'invite');
    await capture(`slice2-${phase}-invite-modal-dark`, { width: 1440, height: 960 }, true, '', 'invite');
    await capture(`slice2-${phase}-media-mobile-light`, { width: 390, height: 844 }, false, '', 'media');
    await capture(`slice2-${phase}-media-mobile-dark`, { width: 390, height: 844 }, true, '', 'media');
    await capture(`slice2-${phase}-qr-light`, { width: 900, height: 760 }, false, '', 'qr');
    await capture(`slice2-${phase}-qr-dark`, { width: 900, height: 760 }, true, '', 'qr');
    await capture(`slice2-${phase}-scanner-mobile-dark`, { width: 390, height: 844 }, true, '', 'scanner');
  } else if (process.env.CALM_SLICE3_CAPTURE) {
    const phase = process.env.CALM_SLICE3_CAPTURE;
    await capture(`slice3-${phase}-chatlist-banner-light`, { width: 1280, height: 900 }, false);
    await capture(`slice3-${phase}-chatlist-banner-dark`, { width: 1280, height: 900 }, true);
    await capture(`slice3-${phase}-settings-light`, { width: 1280, height: 900 }, false, '', 'settings');
    await capture(`slice3-${phase}-settings-mobile-dark`, { width: 390, height: 844 }, true, '', 'settings');
  } else {
  await capture('desktop-light', { width: 1440, height: 960 }, false);
  await capture('desktop-dark', { width: 1440, height: 960 }, true);
  await capture('mobile-light', { width: 390, height: 844 }, false);
  await capture('mobile-dark', { width: 390, height: 844 }, true);
  await capture('desktop-light-grayscale', { width: 1440, height: 960 }, false, 'grayscale');
  await capture('desktop-light-zoom200', { width: 1440, height: 960 }, false, 'zoom200');
  }
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
console.log('calm-workspace slice screenshots refreshed');
