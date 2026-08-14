// The HTTP host. It owns one isolated SDK runtime and one public REST/SSE server.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveApi, type ApiDeps } from './api.js';
import { bindIdentity, startRuntime, type Runtime } from './daemon.js';
import { MessengerEventBus } from './events.js';
import { PushStore } from './push.js';
import { startWatcher, type WatcherHandle } from './watch.js';
import type { MessengerConfig } from './config.js';
import { assertStateInitializedForServe } from './lifecycle.js';

export interface ServerHandle {
  readonly port: number;
  readonly runtime: Runtime;
  close(): Promise<void>;
}

const log = {
  info: (message: string) => console.log(`[messenger] ${message}`),
  warn: (message: string) => console.warn(`[messenger] ${message}`),
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

async function closeHttp(http: Server | undefined): Promise<void> {
  if (!http?.listening) return;
  // SSE responses are intentionally long-lived; destroy them before awaiting
  // close or graceful shutdown can wait forever on an idle browser.
  http.closeAllConnections?.();
  await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
}

export async function start(
  cfg: MessengerConfig,
  buildInfo: { name: string; version: string },
): Promise<ServerHandle> {
  let runtime: Runtime | undefined;
  let watcher: WatcherHandle | undefined;
  let events: MessengerEventBus | undefined;
  let http: Server | undefined;
  let closed = false;

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    // Stop accepting public work first, while the runtime still exists to finish
    // any request already inside the handler.
    await closeHttp(http).catch((error) => log.warn(`HTTP close failed: ${(error as Error).message}`));
    await watcher?.stop().catch((error) => log.warn(`watcher stop failed: ${(error as Error).message}`));
    watcher = undefined;
    events?.close();

    if (runtime) {
      try {
        await runtime.client.releaseLease();
      } catch (error) {
        log.warn(`releaseLease failed on shutdown: ${(error as Error).message}`);
      }
      await runtime.close();
    }
  };

  try {
    // This read-only gate precedes owned-runtime configuration. An empty serve
    // therefore creates no directory, lock, token, registrar, or listener.
    assertStateInitializedForServe(cfg);
    runtime = await startRuntime(cfg, buildInfo);
    log.info(`owned runtime ${JSON.stringify(runtime.described)}`);

    const bound = await bindIdentity(runtime, cfg);
    log.info(`bound identity ${bound.name} (keep_history=${bound.keepHistory})`);

    const push = PushStore.open(cfg.stateDir);
    log.info(`push state ${cfg.stateDir} (${push.list().length} subscription(s))`);

    events = new MessengerEventBus();
    watcher = startWatcher(runtime.client, cfg.identity, push, log, events);

    const deps: ApiDeps = {
      runtime,
      push,
      config: cfg,
      buildInfo,
      watcherStats: () => ({ ...(watcher?.stats ?? { pushes: 0, events: 0, reconnects: 0 }) }),
      events,
      identityCid: bound.cid,
    };

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const appCandidates = [
      resolve(moduleDir, '../web'),
      resolve(moduleDir, 'web'),
      resolve(moduleDir, '../dist/web'),
    ];
    const appDir = process.env.OURS_MESSENGER_WEB_DIR
      ?? appCandidates.find((candidate) => existsSync(resolve(candidate, 'app.js')))
      ?? appCandidates[0];

    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      let serving: Promise<void>;
      if (pathname === '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      serving = pathname === '/api' || pathname.startsWith('/api/')
        ? serveApi(req, res, deps)
        : serveApp(req, res, appDir);
      void serving.catch((error: Error) => {
        log.warn(`unhandled request error: ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'INTERNAL', message: error.message } }));
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolveListen, reject) => {
      http!.once('error', reject);
      http!.listen(cfg.port, cfg.host, () => {
        http!.removeListener('error', reject);
        resolveListen();
      });
    });

    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : cfg.port;
    log.info(`listening on http://${cfg.host}:${port}`);
    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
      log.warn(
        `BOUND TO ${cfg.host}, WHICH IS NOT LOOPBACK. This server has NO AUTHENTICATION. ` +
          `Anyone who can reach this port can read every conversation and send as ${cfg.identity}. ` +
          'Put a reverse proxy with auth in front of it, or bind 127.0.0.1.',
      );
    }

    return { port, runtime, close: cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      log.warn(`startup rollback failed: ${(cleanupError as Error).message}`);
    }
    throw error;
  }
}
