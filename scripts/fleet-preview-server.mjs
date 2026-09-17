import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
/** A static mock-only origin; deliberately has no API, live Messenger, or proxy. */
export function createFleetPreviewServer(root = resolve('dist/web')) {
  return createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not available in this preview.'); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject();
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return reject(); }
    if (path === '/') { res.writeHead(302, { Location: '/fleet/account/signup' }); return res.end(); }
    const app = path === '/fleet' || path.startsWith('/fleet/');
    if (!app && !path.startsWith('/assets/')) return reject();
    const file = resolve(root, app ? 'index.html' : '.' + path);
    if (!file.startsWith(root + sep) || !mime[extname(file)]) return reject();
    try {
      if (!statSync(file).isFile()) return reject();
      const bytes = readFileSync(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { reject(); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createFleetPreviewServer();
  server.listen(Number(process.env.FLEET_PREVIEW_PORT ?? 5180), '127.0.0.1', () => console.log(`Fleet mock preview: http://127.0.0.1:${server.address().port}/fleet/account/signup`));
}
