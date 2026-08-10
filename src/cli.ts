#!/usr/bin/env node
// ours-messenger-server — the entrypoint.
//
// One command, `serve`. Everything else is environment, because this is a thing an
// operator puts in a unit file and forgets, not a thing they drive interactively.

import { loadConfig } from './config.js';
import { start } from './server.js';

const BUILD = { name: '@ours.network/messenger-server', version: '0.1.0' };

const USAGE = `ours-messenger-server serve

Attaches to a RUNNING ours daemon (it never starts one), binds one identity, serves
the messenger REST API, and sends WebPush from this host when a message lands.

Required:
  OURS_MESSENGER_IDENTITY          the ours identity this server acts as

HTTP:
  OURS_MESSENGER_HOST              default 127.0.0.1  (see README: there is no auth)
  OURS_MESSENGER_PORT              default 8420
  OURS_MESSENGER_STATE_DIR         default ~/.ours-messenger  (OUR state, not the daemon's)

Retention:
  OURS_MESSENGER_KEEP_HISTORY      default true  (a messenger conversation is permanent)

Which daemon to attach to (all optional; handed verbatim to the SDK's resolver):
  OURS_MESSENGER_DAEMON_URL        e.g. http://127.0.0.1:3050
  OURS_MESSENGER_DAEMON_PORT
  OURS_MESSENGER_DAEMON_STATE_DIR  e.g. ~/.ours
  OURS_MESSENGER_DAEMON_TOKEN
  OURS_MESSENGER_DAEMON_CONFIG

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
    process.stdout.write(USAGE);
    process.exit(cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2);
  }

  const cfg = loadConfig();
  const handle = await start(cfg, BUILD);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[messenger] ${signal} — shutting down`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch((e: Error) => {
        console.error(`[messenger] shutdown error: ${e.message}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: Error) => {
  // The startup failures an operator actually hits — an unreachable daemon, a
  // state dir that does not match, an identity held elsewhere — arrive here. Print
  // the message alone: the stack is noise for all three, and OursError.message is
  // already the engine's own words.
  console.error(`[messenger] ${e.message}`);
  process.exit(1);
});
