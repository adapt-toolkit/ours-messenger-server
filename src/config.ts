// Configuration for the messenger server.
//
// Messenger owns its public HTTP server and application state only. Identity,
// message and file state belong to the one shared ours daemon selected through
// the standard OURS_* SDK configuration.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigurationError } from './security.js';

export interface MessengerConfig {
  /** Where the REST API listens. Loopback by default — see README, "There is no auth". */
  readonly host: string;
  readonly port: number;

  /** Exact externally visible origin accepted for every browser mutation. */
  readonly publicOrigin: string;

  /** The ours identity this server acts as. */
  readonly identity: string;

  /**
   * Take the identity even if another live session holds it. Default FALSE.
   * A messenger server that evicts whatever else was bound is a foot-gun, so the
   * operator has to ask for it.
   */
  readonly force: boolean;

  /** Messenger-only state root (WebPush subscriptions and delivery queue). */
  readonly stateDir: string;

  /** Emergency rollback switch for the typed-command surface. */
  readonly typedCommands?: boolean;
}

export const DEFAULT_HTTP_PORT = 8420;

export function validatePublicOrigin(raw: string | undefined): string {
  if (!raw) throw new ConfigurationError('OURS_MESSENGER_PUBLIC_ORIGIN is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError('OURS_MESSENGER_PUBLIC_ORIGIN must be an exact http(s) origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    raw !== url.origin
  ) {
    throw new ConfigurationError('OURS_MESSENGER_PUBLIC_ORIGIN must be an exact http(s) origin without path, credentials, query, or fragment');
  }
  return raw;
}

function intOrUndefined(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigurationError(`${name} must be an integer port`);
  }
  return n;
}

function boolOrUndefined(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigurationError(`${name} must be true/false (or 1/0)`);
}

/** Resolve messenger-only application state without requiring full config. */
export function resolveOwnStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OURS_MESSENGER_STATE_DIR ?? join(homedir(), '.ours-messenger'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MessengerConfig {
  const identity = env.OURS_MESSENGER_IDENTITY;
  if (!identity) {
    throw new ConfigurationError(
      'OURS_MESSENGER_IDENTITY is required: this server acts AS one ours identity and will not guess which.',
    );
  }

  return {
    host: env.OURS_MESSENGER_HOST ?? '127.0.0.1',
    port: intOrUndefined(env.OURS_MESSENGER_PORT, 'OURS_MESSENGER_PORT') ?? DEFAULT_HTTP_PORT,
    publicOrigin: validatePublicOrigin(env.OURS_MESSENGER_PUBLIC_ORIGIN),
    identity,
    force: boolOrUndefined(env.OURS_MESSENGER_FORCE, 'OURS_MESSENGER_FORCE') ?? false,
    stateDir: resolveOwnStateDir(env),
    typedCommands: boolOrUndefined(env.OURS_MESSENGER_TYPED_COMMANDS, 'OURS_MESSENGER_TYPED_COMMANDS') ?? true,
  };
}
