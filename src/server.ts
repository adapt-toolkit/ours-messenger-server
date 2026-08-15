// The HTTP host. It owns one isolated SDK runtime and one public REST/SSE server.

import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { serveApi, type ApiDeps } from './api.js';
import { bindIdentity, startRuntime, type Runtime } from './daemon.js';
import { MessengerEventBus } from './events.js';
import { PushStore } from './push.js';
import { startWatcher, type WatcherHandle } from './watch.js';
import type { MessengerConfig } from './config.js';
import type { BuildInfo } from './build-info.js';
import { publicInternalError, reportFailure } from './security.js';
import { assertStateInitializedForServe } from './lifecycle.js';
import { MediaStore } from './media.js';

export interface ServerHandle {
  readonly port: number;
  readonly runtime: Runtime;
  close(): Promise<void>;
}

export interface StartDependencies {
  readonly startRuntime: typeof startRuntime;
}

const DEFAULT_START_DEPENDENCIES: StartDependencies = { startRuntime };

const log = {
  info: (message: string) => console.log(`[messenger] ${message}`),
  warn: (message: string) => console.warn(`[messenger] ${message}`),
};

const APP_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function appHeaders(type: string, cacheControl: string, length?: number): Record<string, string> {
  return {
    'content-type': type,
    ...(length === undefined ? {} : { 'content-length': String(length) }),
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'content-security-policy': APP_CSP,
  };
}

function appNotFound(res: ServerResponse): void {
  const body = Buffer.from('Not found');
  res.writeHead(404, appHeaders('text/plain; charset=utf-8', 'no-cache', body.length));
  res.end(body);
}

async function readContainedFile(root: string, path: string): Promise<Buffer> {
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (
    fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot) || !(await stat(canonicalPath)).isFile()
  ) {
    throw new Error('static asset is not a contained regular file');
  }
  return readFile(canonicalPath);
}

/** Serve only Vite output and the SPA entry. API/MCP namespaces always fail closed. */
export async function serveApp(req: IncomingMessage, res: ServerResponse, appDir: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    appNotFound(res);
    return;
  }
  if (
    decodedPathname === '/api' || decodedPathname.startsWith('/api/')
    || decodedPathname === '/mcp' || decodedPathname.startsWith('/mcp/')
  ) {
    appNotFound(res);
    return;
  }

  let asset = 'index.html';
  let assetRoot = appDir;
  let cacheControl = 'no-cache';
  if (pathname.startsWith('/assets/')) {
    assetRoot = resolve(appDir, 'assets');
    const candidate = resolve(appDir, `.${decodedPathname}`);
    if (candidate !== assetRoot && !candidate.startsWith(`${assetRoot}${sep}`)) {
      appNotFound(res);
      return;
    }
    asset = candidate;
    cacheControl = 'public, max-age=31536000, immutable';
  } else if (pathname.startsWith('/icons/')) {
    assetRoot = resolve(appDir, 'icons');
    const candidate = resolve(appDir, `.${decodedPathname}`);
    if (candidate === assetRoot || !candidate.startsWith(`${assetRoot}${sep}`)) {
      appNotFound(res);
      return;
    }
    asset = candidate;
  } else if (
    pathname === '/manifest.webmanifest' || pathname === '/version.json' || pathname === '/sw.js'
    || pathname === '/icon.svg' || pathname === '/maskable-icon.svg'
  ) {
    asset = resolve(appDir, pathname.slice(1));
  } else if (/\.[a-z0-9]+$/i.test(pathname)) {
    // Unknown file-like requests are not browser routes and must not receive HTML.
    appNotFound(res);
    return;
  } else {
    asset = resolve(appDir, 'index.html');
  }

  try {
    const body = await readContainedFile(assetRoot, asset);
    const type = MIME_TYPES[extname(asset).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, appHeaders(type, cacheControl, body.length));
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (asset !== resolve(appDir, 'index.html')) {
      appNotFound(res);
      return;
    }
    const body = Buffer.from('Messenger client is not built. Run npm run build.');
    res.writeHead(503, appHeaders('text/plain; charset=utf-8', 'no-cache', body.length));
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}

async function closeHttp(http: Server | undefined): Promise<void> {
  if (!http?.listening) return;
  // SSE responses are intentionally long-lived; destroy them before awaiting
  // close or graceful shutdown can wait forever on an idle browser.
  http.closeAllConnections?.();
  await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
}

interface StartupProbe {
  readonly port: number;
  close(): Promise<void>;
}

// The SDK's persisted-packet restore can occupy the main event loop for tens of
// seconds. A server created on that loop owns a socket but cannot answer HTTP,
// so the bounded startup contract lives in a worker until the full API is ready.
const STARTUP_PROBE_SOURCE = String.raw`
const { createServer } = require('node:http');
const { parentPort, workerData } = require('node:worker_threads');

const sendJson = (req, res, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
};

const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const method = req.method || 'GET';
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end('Not found');
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/build-info') {
    sendJson(req, res, 200, workerData.buildInfo);
    return;
  }
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/healthz') {
    sendJson(req, res, 503, {
      status: 'starting',
      message: 'Service unavailable',
      version: workerData.buildInfo.version,
      sha: workerData.buildInfo.sha,
    });
    return;
  }
  sendJson(req, res, 503, {
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' },
  });
});

server.listen(workerData.port, workerData.host, () => {
  const address = server.address();
  parentPort.postMessage({
    type: 'listening',
    port: address && typeof address === 'object' ? address.port : workerData.port,
  });
});

parentPort.on('message', (message) => {
  if (message !== 'close') return;
  server.close(() => {
    parentPort.postMessage({ type: 'closed' });
    parentPort.close();
  });
  server.closeAllConnections?.();
});
`;

async function startStartupProbe(
  cfg: MessengerConfig,
  buildInfo: BuildInfo,
): Promise<StartupProbe> {
  const worker = new Worker(STARTUP_PROBE_SOURCE, {
    eval: true,
    workerData: { host: cfg.host, port: cfg.port, buildInfo: { ...buildInfo } },
  });
  let alive = true;
  let closing = false;
  let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  worker.on('error', (error) => { failure = error; });
  worker.on('exit', (code) => {
    alive = false;
    if (!closing && !failure) failure = new Error(`startup readiness worker exited early (code ${code})`);
  });

  const port = await new Promise<number>((resolveReady, rejectReady) => {
    const onMessage = (message: { type?: string; port?: number }): void => {
      if (message?.type !== 'listening' || !Number.isInteger(message.port)) return;
      cleanup();
      resolveReady(message.port!);
    };
    const onError = (error: Error): void => { cleanup(); rejectReady(error); };
    const onExit = (code: number): void => {
      cleanup();
      rejectReady(failure ?? new Error(`startup readiness worker exited before listen (code ${code})`));
    };
    const cleanup = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });

  return {
    port,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        if (!alive) throw failure ?? new Error('startup readiness worker exited before handoff');
        await new Promise<void>((resolveClose, rejectClose) => {
          const onMessage = (message: { type?: string }): void => {
            if (message?.type !== 'closed') return;
            cleanup();
            resolveClose();
          };
          const onError = (error: Error): void => { cleanup(); rejectClose(error); };
          const onExit = (code: number): void => {
            cleanup();
            rejectClose(failure ?? new Error(`startup readiness worker exited during close (code ${code})`));
          };
          const cleanup = (): void => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
          };
          worker.on('message', onMessage);
          worker.once('error', onError);
          worker.once('exit', onExit);
          worker.postMessage('close');
        });
        await worker.terminate();
      })();
      return closePromise;
    },
  };
}

export async function start(
  cfg: MessengerConfig,
  buildInfo: BuildInfo,
  dependencies: StartDependencies = DEFAULT_START_DEPENDENCIES,
): Promise<ServerHandle> {
  let runtime: Runtime | undefined;
  let watcher: WatcherHandle | undefined;
  let events: MessengerEventBus | undefined;
  let http: Server | undefined;
  let startupProbe: StartupProbe | undefined;
  let closed = false;

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    // Stop accepting public work or startup probes first, while the runtime
    // still exists to finish any request already inside the full API handler.
    await closeHttp(http).catch((error) => reportFailure(log.warn, 'HTTP close', error));
    await startupProbe?.close().catch((error) => reportFailure(log.warn, 'startup probe close', error));
    startupProbe = undefined;
    await watcher?.stop().catch((error) => reportFailure(log.warn, 'watcher stop', error));
    watcher = undefined;
    events?.close();

    if (runtime) {
      try {
        await runtime.client.releaseLease();
      } catch (error) {
        reportFailure(log.warn, 'lease release', error);
      }
      await runtime.close();
    }
  };

  try {
    log.info(`build ${buildInfo.name}@${buildInfo.version} sha=${buildInfo.sha} dirty=${buildInfo.dirty}`);
    // This read-only gate precedes owned-runtime configuration. An empty serve
    // therefore creates no directory, lock, token, registrar, or listener.
    assertStateInitializedForServe(cfg);

    startupProbe = await startStartupProbe(cfg, buildInfo);
    const port = startupProbe.port;
    log.info('public HTTP startup probe ready');
    if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
      log.warn(
        'BOUND TO A NON-LOOPBACK INTERFACE. This server has NO AUTHENTICATION. ' +
          'Anyone who can reach this port can read every conversation and send as the configured identity. ' +
          'Put a reverse proxy with auth in front of it, or bind 127.0.0.1.',
      );
    }

    runtime = await dependencies.startRuntime(cfg, buildInfo);
    log.info('owned runtime ready');

    const bound = await bindIdentity(runtime, cfg);
    log.info(`bound identity ready (keep_history=${bound.keepHistory})`);

    const push = PushStore.open(cfg.stateDir);
    log.info(`push state ready (${push.list().length} subscription(s))`);

    const media = MediaStore.open(cfg.stateDir);
    log.info(`media index ready (${media.list().length} file(s))`);

    events = new MessengerEventBus();
    watcher = startWatcher(runtime.client, cfg.identity, push, log, events, { media });

    const readyDeps: ApiDeps = {
      runtime,
      push,
      config: cfg,
      buildInfo,
      watcherStats: () => ({ ...(watcher?.stats ?? { pushes: 0, events: 0, reconnects: 0 }) }),
      events,
      identityCid: bound.cid,
      media,
    };

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const appCandidates = [
      resolve(moduleDir, '../web'),
      resolve(moduleDir, '../dist/web'),
      resolve(moduleDir, 'web'),
    ];
    const appDir = process.env.OURS_MESSENGER_WEB_DIR
      ?? appCandidates.find((candidate) =>
        existsSync(resolve(candidate, 'index.html')) && existsSync(resolve(candidate, 'assets')))
      ?? resolve(moduleDir, '__messenger_web_not_built__');

    http = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      let serving: Promise<void>;
      if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      serving = pathname === '/api' || pathname.startsWith('/api/')
        ? serveApi(req, res, readyDeps)
        : serveApp(req, res, appDir);
      void serving.catch((error: Error) => {
        const publicError = publicInternalError(error, 'unhandled request', log.warn);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: publicError }));
        } else {
          res.end();
        }
      });
    });

    // The startup worker owns the port while main-thread packet restore is
    // running. Close it only after every full-API dependency exists, then bind
    // the production server to the same port before declaring readiness.
    await startupProbe.close();
    startupProbe = undefined;
    await new Promise<void>((resolveListen, reject) => {
      http!.once('error', reject);
      http!.listen(port, cfg.host, () => {
        http!.removeListener('error', reject);
        resolveListen();
      });
    });
    log.info('service ready');

    return { port, runtime, close: cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      reportFailure(log.warn, 'startup rollback', cleanupError);
    }
    throw error;
  }
}
