// The HTTP host. Attaches, binds, starts the watcher, serves the REST surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveApi, type ApiDeps } from './api.js';
import { attach, bindIdentity, type Attachment } from './daemon.js';
import { PushStore } from './push.js';
import { startWatcher, type WatcherHandle } from './watch.js';
import type { MessengerConfig } from './config.js';
import { MessengerEventBus } from './events.js';

export interface ServerHandle {
  readonly port: number;
  readonly attachment: Attachment;
  close(): Promise<void>;
}

const log = {
  info: (m: string) => console.log(`[messenger] ${m}`),
  warn: (m: string) => console.warn(`[messenger] ${m}`),
};

async function serveApp(req: IncomingMessage, res: ServerResponse, appDir: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const asset = pathname === '/app.js' ? 'app.js' : pathname === '/styles.css' ? 'styles.css' : 'index.html';
  try {
    const body = await readFile(resolve(appDir, asset));
    const type = asset.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : asset.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'text/html; charset=utf-8';
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(body.length),
      'cache-control': asset === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Messenger client is not built. Run npm run build.');
  }
}

export async function start(
  cfg: MessengerConfig,
  buildInfo: { name: string; version: string },
): Promise<ServerHandle> {
  const attachment = await attach(cfg);
  log.info(`attached to daemon ${JSON.stringify(attachment.described)}`);

  const bound = await bindIdentity(attachment, cfg);
  log.info(`bound identity ${bound.name} (keep_history=${bound.keepHistory})`);

  const push = PushStore.open(cfg.stateDir);
  log.info(`push state ${cfg.stateDir} (${push.list().length} subscription(s))`);

  const events = new MessengerEventBus();
  let watcher: WatcherHandle | undefined = startWatcher(attachment.client, cfg.identity, push, log, events);

  const deps: ApiDeps = {
    attachment,
    push,
    config: cfg,
    buildInfo,
    watcherStats: () => ({ ...(watcher?.stats ?? { pushes: 0, events: 0, reconnects: 0 }) }),
    events,
    identityCid: bound.cid,
  };

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const appCandidates = [
    // Split production bundle: dist/chunks/server-*.js -> dist/web.
    resolve(moduleDir, '../web'),
    // Unsplit production bundle: dist/cli.js -> dist/web.
    resolve(moduleDir, 'web'),
    // Source execution after npm run build: src/server.ts -> dist/web.
    resolve(moduleDir, '../dist/web'),
  ];
  const appDir = process.env.OURS_MESSENGER_WEB_DIR
    ?? appCandidates.find((candidate) => existsSync(resolve(candidate, 'app.js')))
    ?? appCandidates[0];

  const http: Server = createServer((req, res) => {
    // An unhandled rejection in a request handler would take the process down and
    // leave the operator with a stack trace instead of a server. serveApi already
    // catches everything it can name; this is the backstop for what it cannot.
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const serving = pathname === '/api' || pathname.startsWith('/api/')
      ? serveApi(req, res, deps)
      : serveApp(req, res, appDir);
    void serving.catch((e: Error) => {
      log.warn(`unhandled request error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: e.message } }));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(cfg.port, cfg.host, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  log.info(`listening on http://${cfg.host}:${port}`);
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
    // Said once, loudly, at the moment it becomes true. There is no auth layer in
    // this server by design (it is an explicitly later layer), so a non-loopback
    // bind puts every one of these routes — send as this identity, read every
    // conversation — on the network for anyone who can reach the port.
    log.warn(
      `BOUND TO ${cfg.host}, WHICH IS NOT LOOPBACK. This server has NO AUTHENTICATION. ` +
        `Anyone who can reach this port can read every conversation and send as ${cfg.identity}. ` +
        `Put a reverse proxy with auth in front of it, or bind 127.0.0.1.`,
    );
  }

  return {
    port,
    attachment,
    async close() {
      await watcher?.stop();
      watcher = undefined;
      events.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      // Hand the lease back rather than letting it lapse: a lease that outlives
      // the process keeps the identity looking bound to a session that is gone.
      try {
        await attachment.client.releaseLease();
      } catch (e) {
        log.warn(`releaseLease failed on shutdown: ${(e as Error).message}`);
      }
    },
  };
}
