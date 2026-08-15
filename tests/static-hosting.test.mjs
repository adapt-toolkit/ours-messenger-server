import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApp } from '../src/server.ts';

const root = mkdtempSync(join(tmpdir(), 'messenger-static-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html><div id="app"></div>');
writeFileSync(join(root, 'assets', 'index-A1b2C3.js'), 'export const ready = true;');
writeFileSync(join(root, 'assets', 'index-A1b2C3.css'), ':root{color-scheme:dark}');
writeFileSync(join(root, 'version.json'), '{"sha":"abc"}\n');
writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"ours"}\n');
writeFileSync(join(root, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

async function request(url, method = 'GET') {
  let status = 0;
  let headers = {};
  let body = Buffer.alloc(0);
  const response = {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = Object.fromEntries(Object.entries(nextHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]));
      return this;
    },
    end(value) {
      if (value !== undefined) body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      return this;
    },
  };
  await serveApp({ method, url }, response, root);
  return { status, headers, text: body.toString('utf8') };
}

const index = await request('/chats/A');
assert.equal(index.status, 200);
assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
assert.equal(index.headers['cache-control'], 'no-cache');
assert.equal(index.headers['x-content-type-options'], 'nosniff');
assert.match(index.headers['content-security-policy'], /default-src 'self'/);

const script = await request('/assets/index-A1b2C3.js');
assert.equal(script.status, 200);
assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');

const css = await request('/assets/index-A1b2C3.css');
assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable');

const version = await request('/version.json');
assert.equal(version.headers['cache-control'], 'no-cache', 'mutable metadata is never cached');
assert.equal(version.headers['content-type'], 'application/json; charset=utf-8');

const manifest = await request('/manifest.webmanifest');
assert.equal(manifest.status, 200);
assert.equal(manifest.headers['content-type'], 'application/manifest+json; charset=utf-8');
assert.equal(manifest.headers['cache-control'], 'no-cache');
const worker = await request('/sw.js');
assert.equal(worker.status, 200);
assert.equal(worker.headers['content-type'], 'text/javascript; charset=utf-8');
assert.equal(worker.headers['cache-control'], 'no-cache', 'service worker lifecycle never sticks behind an immutable cache');
assert.match(worker.headers['content-security-policy'], /object-src 'none'/);

for (const path of [
  '/assets/missing.js', '/api/not-a-route', '/api%2Fnot-a-route',
  '/mcp', '/mcp/tools', '/mcp%2Ftools', '/robots.txt',
]) {
  const response = await request(path);
  assert.equal(response.status, 404, `${path} never falls through to SPA HTML`);
  assert.ok(!response.text.includes('id="app"'));
}

const head = await request('/assets/index-A1b2C3.js', 'HEAD');
assert.equal(head.status, 200);
assert.equal(head.text, '');

rmSync(root, { recursive: true, force: true });
console.log('static-hosting OK — SPA fallback boundaries, MIME, nosniff, and immutable hashed assets');
