#!/usr/bin/env node
// ours-messenger-server — the entrypoint.
//
// `serve` is the long-running process. `init` and `migrate` are explicit,
// confirmed offline lifecycle operations and never open the public HTTP server.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, resolveOwnStateDir } from './config.js';
import { BUILD_INFO } from './build-info.js';
import { ConfigurationError, operatorError, reportFailure } from './security.js';
import { initializeMessengerState, migrateMessengerState } from './lifecycle.js';

const USAGE = `ours-messenger-server <command>

Commands:
  serve
      Start the isolated messenger runtime and public REST/SSE server. The state
      must already contain the configured identity; serve never creates one.

  init --name <Human@host> --bio <public-bio> [--yes]
      Offline one-shot initialization. Creates exactly one named Human/root
      identity after showing the exact state directory and obtaining confirmation.

  migrate --source <offline-sdk-state> --backup <new-backup-dir> [--yes]
      Offline byte-complete import into <messenger-state>/runtime. Source and
      destination must be stopped; destination and backup must be empty/absent.

serve starts one isolated SDK runtime owned by this process, binds one identity,
serves the messenger REST/SSE API, and sends WebPush when a message lands. MCP is absent.

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

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly yes: boolean;
}

function parseOptions(args: readonly string[], valueFlags: readonly string[]): ParsedOptions {
  const allowed = new Set(valueFlags);
  const values = new Map<string, string>();
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yes') {
      if (yes) throw new ConfigurationError('--yes may be specified only once');
      yes = true;
      continue;
    }
    if (!allowed.has(arg)) throw new ConfigurationError('unknown command-line option');
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new ConfigurationError(`${arg} requires a value`);
    if (values.has(arg)) throw new ConfigurationError(`${arg} may be specified only once`);
    values.set(arg, value);
  }
  return { values, yes };
}

function requiredOption(options: ParsedOptions, name: string): string {
  const value = options.values.get(name);
  if (value === undefined || value.trim() === '') throw new ConfigurationError(`${name} requires a non-empty value`);
  return value;
}

async function confirmed(summary: string, yes: boolean): Promise<boolean> {
  await new Promise<void>((resolveWrite) => stdout.write(`${summary}\n`, () => resolveWrite()));
  if (yes) return true;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ConfigurationError('confirmation requires an interactive terminal; review the paths and re-run with --yes');
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Type "yes" to continue: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    // A forced exit can truncate stdout when it is a pipe (the smoke test and
    // ordinary shell redirection). Wait for the write before letting Node exit.
    await new Promise<void>((resolve) => process.stdout.write(USAGE, () => resolve()));
    return;
  }

  if (cmd === 'init') {
    const options = parseOptions(process.argv.slice(3), ['--name', '--bio']);
    const name = requiredOption(options, '--name').trim();
    const bio = requiredOption(options, '--bio').trim();
    const stateDir = resolveOwnStateDir();
    const approved = await confirmed(
      `Offline Human/root initialization\n  state: ${stateDir}\n  name:  ${name}\n  bio:   ${bio}`,
      options.yes,
    );
    if (!approved) throw new ConfigurationError('initialization cancelled; no state was changed');
    const cfg = loadConfig({ ...process.env, OURS_MESSENGER_IDENTITY: name });
    const { startRuntime } = await import('./daemon.js');
    const receipt = await initializeMessengerState(
      cfg,
      { name, bio, confirmed: true },
      { startRuntime, buildInfo: BUILD_INFO },
    );
    await new Promise<void>((resolveWrite) => stdout.write(
      `Initialized Human/root ${receipt.identity.name} (${receipt.identity.cid}) in ${receipt.stateDir}.\n` +
      `Set OURS_MESSENGER_IDENTITY=${receipt.identity.name} when serving; startup verifies this CID from ${receipt.stateDir}/initialization.json.\n`,
      () => resolveWrite(),
    ));
    return;
  }

  if (cmd === 'migrate') {
    const options = parseOptions(process.argv.slice(3), ['--source', '--backup']);
    const source = requiredOption(options, '--source');
    const backupDir = requiredOption(options, '--backup');
    const destinationStateDir = resolveOwnStateDir();
    const approved = await confirmed(
      `Offline state migration (source must already be quiesced)\n  source:      ${source}\n  destination: ${destinationStateDir}\n  backup:      ${backupDir}`,
      options.yes,
    );
    if (!approved) throw new ConfigurationError('migration cancelled; no state was changed');
    const receipt = migrateMessengerState({ source, destinationStateDir, backupDir, confirmed: true });
    await new Promise<void>((resolveWrite) => stdout.write(
      `Migrated ${receipt.sourceManifest.files} files (${receipt.sourceManifest.bytes} bytes); ` +
      `verified manifest ${receipt.sourceManifest.digest}.\nReceipt: ${receipt.destinationStateDir}/migration.json\n`,
      () => resolveWrite(),
    ));
    return;
  }

  if (cmd !== 'serve') {
    await new Promise<void>((resolveWrite) => stdout.write(USAGE, () => resolveWrite()));
    process.exitCode = 2;
    return;
  }

  if (process.argv.length !== 3) throw new ConfigurationError('serve does not accept command-line options');

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
