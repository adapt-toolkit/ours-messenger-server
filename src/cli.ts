#!/usr/bin/env node
// ours-messenger-server — the entrypoint.
//
// One command, `serve`. Everything else is environment, because this is a thing an
// operator puts in a unit file and forgets, not a thing they drive interactively.

import { loadConfig } from './config.js';
import { BUILD_INFO } from './build-info.js';
import { operatorError, reportFailure } from './security.js';

const USAGE = `ours-messenger-server serve

Starts one isolated SDK runtime owned by this process, binds one identity, serves
the messenger REST/SSE API, and sends WebPush when a message lands. MCP is absent.

Required:
  OURS_MESSENGER_IDENTITY          the ours identity this server acts as

HTTP:
  OURS_MESSENGER_HOST              default 127.0.0.1  (see README: there is no auth)
  OURS_MESSENGER_PORT              default 8420
  OURS_MESSENGER_PUBLIC_ORIGIN     required exact browser origin, e.g.
                                   https://messenger.example.com
  OURS_MESSENGER_STATE_DIR         default ~/.ours-messenger
                                   runtime state lives under <state>/runtime

Retention:
  OURS_MESSENGER_KEEP_HISTORY      default true  (a messenger conversation is permanent)

Owned SDK runtime:
  OURS_MESSENGER_BROKER_URL        default wss://broker1.ours.network
                                   runtime HTTP uses loopback port 0 + owner token

WebPush (optional; a key pair is generated and persisted on first run):
  OURS_MESSENGER_VAPID_PUBLIC_KEY  } must be set together
  OURS_MESSENGER_VAPID_PRIVATE_KEY }
  OURS_MESSENGER_VAPID_SUBJECT     default mailto:admin@localhost

Other:
  OURS_MESSENGER_FORCE=true        take the identity even if another session holds it
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== 'serve') {
    // A forced exit can truncate stdout when it is a pipe (the smoke test and
    // ordinary shell redirection). Wait for the write before letting Node exit.
    await new Promise<void>((resolve) => process.stdout.write(USAGE, () => resolve()));
    process.exitCode = cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
    return;
  }

  const cfg = loadConfig();
  // Keep the SDK-bearing server graph out of `--help`; start() configures the
  // owned runtime environment before dynamically importing the SDK.
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
