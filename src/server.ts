// The HTTP host. Attaches, binds, starts the watcher, serves the REST surface.

import { createServer, type Server } from 'node:http';
import { serveApi, type ApiDeps } from './api.js';
import { attach, bindIdentity, type Attachment } from './daemon.js';
import { PushStore } from './push.js';
import { startWatcher, type WatcherHandle } from './watch.js';
import type { MessengerConfig } from './config.js';

export interface ServerHandle {
  readonly port: number;
  readonly attachment: Attachment;
  close(): Promise<void>;
}

const log = {
  info: (m: string) => console.log(`[messenger] ${m}`),
  warn: (m: string) => console.warn(`[messenger] ${m}`),
};

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

  let watcher: WatcherHandle | undefined = startWatcher(attachment.client, cfg.identity, push, log);

  const deps: ApiDeps = {
    attachment,
    push,
    config: cfg,
    buildInfo,
    watcherStats: () => ({ ...(watcher?.stats ?? { pushes: 0, events: 0, reconnects: 0 }) }),
  };

  const http: Server = createServer((req, res) => {
    // An unhandled rejection in a request handler would take the process down and
    // leave the operator with a stack trace instead of a server. serveApi already
    // catches everything it can name; this is the backstop for what it cannot.
    void serveApi(req, res, deps).catch((e: Error) => {
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
