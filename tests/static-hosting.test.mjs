import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApp } from '../src/server.ts';

const root = mkdtempSync(join(tmpdir(), 'messenger-static-'));
mkdirSync(join(root, 'assets'));
mkdirSync(join(root, 'icons'));
mkdirSync(join(root, 'outside-icons'));
writeFileSync(join(root, 'index.html'), '<!doctype html><div id="app"></div>');
writeFileSync(join(root, 'assets', 'index-A1b2C3.js'), 'export const ready = true;');
writeFileSync(join(root, 'assets', 'index-A1b2C3.css'), ':root{color-scheme:dark}');
writeFileSync(join(root, 'version.json'), '{"sha":"abc"}\n');
const icons = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];
const iconBodies = new Map(icons.map(({ src }) => [src, Buffer.from(`fixture:${src}`)]));
for (const [src, body] of iconBodies) writeFileSync(join(root, src), body);
writeFileSync(join(root, 'manifest.webmanifest'), `${JSON.stringify({ name: 'ours', icons })}\n`);
writeFileSync(join(root, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync(join(root, 'outside-icons', 'secret.png'), 'not public');
writeFileSync(join(root, 'outside.js'), 'not public');
symlinkSync(join(root, 'outside-icons'), join(root, 'icons', 'escape-dir'));
symlinkSync(join(root, 'outside.js'), join(root, 'assets', 'escape.js'));

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
  return { status, headers, body, text: body.toString('utf8') };
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
for (const icon of JSON.parse(manifest.text).icons) {
  const get = await request(icon.src);
  assert.equal(get.status, 200, `GET ${icon.src} serves every manifest-declared icon`);
  assert.equal(get.headers['content-type'], icon.type);
  assert.equal(get.headers['cache-control'], 'no-cache', 'stable icon names revalidate across releases');
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  assert.equal(get.headers['content-length'], String(iconBodies.get(icon.src).length));
  assert.deepEqual(get.body, iconBodies.get(icon.src), 'image response is never the SPA shell');

  const headIcon = await request(icon.src, 'HEAD');
  assert.equal(headIcon.status, 200, `HEAD ${icon.src} is supported`);
  assert.equal(headIcon.headers['content-type'], icon.type);
  assert.equal(headIcon.headers['content-length'], get.headers['content-length']);
  assert.equal(headIcon.text, '');
}
const worker = await request('/sw.js');
assert.equal(worker.status, 200);
assert.equal(worker.headers['content-type'], 'text/javascript; charset=utf-8');
assert.equal(worker.headers['cache-control'], 'no-cache', 'service worker lifecycle never sticks behind an immutable cache');
assert.match(worker.headers['content-security-policy'], /object-src 'none'/);

for (const path of [
  '/assets/missing.js', '/api/not-a-route', '/api%2Fnot-a-route',
  '/mcp', '/mcp/tools', '/mcp%2Ftools', '/robots.txt', '/icons/missing.png',
  '/icons/', '/icons/%2E%2E%2Foutside.png', '/icons/escape-dir/secret.png',
  '/assets/escape.js',
]) {
  const response = await request(path);
  assert.equal(response.status, 404, `${path} never falls through to SPA HTML`);
  assert.ok(!response.text.includes('id="app"'));
}

const postIcon = await request('/icons/icon-192.png', 'POST');
assert.equal(postIcon.status, 405);
assert.equal(postIcon.headers.allow, 'GET, HEAD');

const head = await request('/assets/index-A1b2C3.js', 'HEAD');
assert.equal(head.status, 200);
assert.equal(head.text, '');

rmSync(root, { recursive: true, force: true });
console.log('static-hosting OK — SPA fallback boundaries, MIME, nosniff, and immutable hashed assets');
