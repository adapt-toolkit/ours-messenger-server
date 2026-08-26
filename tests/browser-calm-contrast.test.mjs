import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
const types = new Map([['.css', 'text/css'], ['.html', 'text/html'], ['.js', 'text/javascript'], ['.svg', 'image/svg+xml']]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(webRoot, 'index.html');
  response.writeHead(200, { 'content-type': types.get(extname(path)) ?? 'application/octet-stream' }).end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const report = {};
try {
  for (const dark of [false, true]) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript((enabled) => localStorage.setItem('ours-dark-v3', enabled ? '1' : '0'), dark);
    await context.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      route.request().url().endsWith('/identity') ? { name: 'Me', cid: 'ME' }
        : route.request().url().endsWith('/contacts') ? { contacts: [], pending: [] }
          : route.request().url().endsWith('/build-info') ? { name: 'fixture', version: '1', sha: 'fixture' } : {},
    ) }));
    const page = await context.newPage();
    await page.goto(`${origin}/chats`, { waitUntil: 'domcontentloaded' });
    report[dark ? 'dark' : 'light'] = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const value = (name) => style.getPropertyValue(name).trim();
      const rgb = (color) => {
        const probe = document.createElement('span'); probe.style.color = color; document.body.append(probe);
        const parts = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number); probe.remove(); return parts;
      };
      const luminance = (color) => rgb(color).map((part) => part / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4)
        .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
      const ratio = (foreground, background) => {
        const values = [luminance(value(foreground)), luminance(value(background))].sort((a, b) => b - a);
        return Number(((values[0] + 0.05) / (values[1] + 0.05)).toFixed(2));
      };
      return {
        'long-form/surface': ratio('--color-text-primary', '--color-surface'),
        'long-form/human': ratio('--color-text-primary', '--color-provenance-human'),
        'long-form/agent': ratio('--color-text-primary', '--color-provenance-agent'),
        'long-form/system': ratio('--color-text-primary', '--color-provenance-system'),
        'secondary/surface': ratio('--color-text-secondary', '--color-surface'),
        'disabled/surface': ratio('--color-text-disabled', '--color-surface'),
        'action-label/action': ratio('--color-on-action', '--color-action-primary'),
        'focus/surface': ratio('--color-focus', '--color-surface'),
        'focus/canvas': ratio('--color-focus', '--color-canvas'),
        'success-indicator/background': ratio('--color-success', '--color-success-background'),
        'warning/background': ratio('--color-warning', '--color-warning-background'),
        'error/background': ratio('--color-error', '--color-error-background'),
        'info/background': ratio('--color-info', '--color-info-background'),
      };
    });
    await context.close();
  }
} finally {
  await browser.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
for (const [theme, ratios] of Object.entries(report)) {
  for (const key of ['long-form/surface', 'long-form/human', 'long-form/agent', 'long-form/system']) assert.ok(ratios[key] >= 7, `${theme} ${key} meets the AAA target`);
  for (const key of ['secondary/surface', 'action-label/action', 'warning/background', 'error/background', 'info/background']) assert.ok(ratios[key] >= 4.5, `${theme} ${key} meets AA`);
  for (const key of ['disabled/surface', 'focus/surface', 'focus/canvas', 'success-indicator/background']) assert.ok(ratios[key] >= 3, `${theme} ${key} meets the relevant non-text/UI threshold`);
}
console.log(`browser-calm-contrast ${JSON.stringify(report)}`);
