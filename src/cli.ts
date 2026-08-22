#!/usr/bin/env node
// ours-messenger-server — the entrypoint.
//
// `serve` is the long-running process. Identity provisioning and daemon
// lifecycle belong to the shared ours CLI, never to this application.

import { loadConfig } from './config.js';
import { BUILD_INFO } from './build-info.js';
import { ConfigurationError, operatorError, reportFailure } from './security.js';

const USAGE = `ours-messenger-server <command>

Commands:
  serve
      Attach to the selected shared ours daemon, lease one existing identity,
      serve the messenger REST/SSE API, and send WebPush when a message lands.
      Messenger never starts a daemon or creates an identity. MCP is absent.

Required:
  OURS_MESSENGER_IDENTITY          the ours identity this server acts as

HTTP:
  OURS_MESSENGER_HOST              default 127.0.0.1  (see README: there is no auth)
  OURS_MESSENGER_PORT              default 8420
  OURS_MESSENGER_PUBLIC_ORIGIN     required exact browser origin, e.g.
                                   https://messenger.example.com
  OURS_MESSENGER_STATE_DIR         default ~/.ours-messenger
                                   WebPush/application state only

Shared daemon selection:
  Standard OURS_STATE_DIR / OURS_PORT / OURS_CONFIG / OURS_API_TOKEN variables
  select the same daemon used by other SDK applications. Start it separately
  with the ours CLI before starting messenger.

WebPush (optional; a key pair is generated and persisted on first run):
  OURS_MESSENGER_VAPID_PUBLIC_KEY  } must be set together
  OURS_MESSENGER_VAPID_PRIVATE_KEY }
  OURS_MESSENGER_VAPID_SUBJECT     default public origin (or https://ours.network)

Other:
  OURS_MESSENGER_FORCE=true        take the identity even if another session holds it
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    // A forced exit can truncate stdout when it is a pipe (the smoke test and
    // ordinary shell redirection). Wait for the write before letting Node exit.
    await new Promise<void>((resolve) => process.stdout.write(USAGE, () => resolve()));
    return;
  }

  if (cmd !== 'serve') {
    await new Promise<void>((resolveWrite) => process.stdout.write(USAGE, () => resolveWrite()));
    process.exitCode = 2;
    return;
  }

  if (process.argv.length !== 3) throw new ConfigurationError('serve does not accept command-line options');

  const cfg = loadConfig();
  // Keep the server graph out of `--help`, including shared-daemon discovery.
  const { start } = await import('./server.js');
  const handle = await start(cfg, BUILD_INFO);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[messenger] ${signal} — shutting down`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        reportFailure((message) => console.error(`[messenger] ${message}`), 'shutdown', error);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  operatorError(error, 'startup', (message) => {
    process.stderr.write(`[messenger] ${message}\n`, () => process.exit(1));
  });
});
