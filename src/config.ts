// Configuration for the messenger server.
//
// Messenger owns both its public HTTP server and one embedded SDK runtime. The
// runtime state is always a child of OURS_MESSENGER_STATE_DIR; no global ours
// config or ~/.ours state is consulted.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface MessengerConfig {
  /** Where the REST API listens. Loopback by default — see README, "There is no auth". */
  readonly host: string;
  readonly port: number;

  /** The ours identity this server acts as. */
  readonly identity: string;

  /**
   * Take the identity even if another live session holds it. Default FALSE.
   * A messenger server that evicts whatever else was bound is a foot-gun, so the
   * operator has to ask for it.
   */
  readonly force: boolean;

  /** Our state root. Push state and the owned runtime use separate children. */
  readonly stateDir: string;

  /**
   * Whether this identity keeps conversation history.
   *
   * THE STATED ASSUMPTION (README + PR): a messenger identity KEEPS history,
   * because a conversation is permanent to a human; an agent identity GCs as
   * today. It is a per-identity policy so that changing it is config, not a
   * rewrite. Set `OURS_MESSENGER_KEEP_HISTORY=false` to run this server against
   * an identity that should behave like an agent.
   */
  readonly keepHistory: boolean;

  /** Configuration for the runtime this messenger process owns. */
  readonly runtime: {
    readonly brokerUrl: string;
  };
}

export const DEFAULT_HTTP_PORT = 8420;
export const DEFAULT_BROKER_URL = 'wss://broker1.ours.network';

export function validateBrokerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OURS_MESSENGER_BROKER_URL must be a valid ws/wss URL, got ${JSON.stringify(raw)}`);
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'OURS_MESSENGER_BROKER_URL must be a ws/wss URL without credentials, query, or fragment; ' +
      'the SDK logs its broker endpoint at startup.',
    );
  }
  return url.toString();
}

function intOrUndefined(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} must be an integer port, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * A boolean env var, strictly. `undefined` when unset so a caller can tell
 * "unset" from "set to false" — silently reading a typo as `false` is how a
 * retention policy flips without anyone choosing it.
 */
function boolOrUndefined(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true/false (or 1/0), got ${JSON.stringify(raw)}`);
}

/**
 * OUR state directory, resolved WITHOUT requiring the rest of the config.
 *
 * Split out because `src/boot-env.ts` needs it before anything else runs, and it
 * must not fail on a missing identity: `ours-messenger-server --help` has to print
 * usage on a box with no environment set at all. Folding this back into
 * `loadConfig` is how `--help` starts throwing "OURS_MESSENGER_IDENTITY is
 * required" at a user who is trying to find out what to set.
 */
export function resolveOwnStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OURS_MESSENGER_STATE_DIR ?? join(homedir(), '.ours-messenger'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MessengerConfig {
  const identity = env.OURS_MESSENGER_IDENTITY;
  if (!identity) {
    throw new Error(
      'OURS_MESSENGER_IDENTITY is required: this server acts AS one ours identity and will not guess which.',
    );
  }

  return {
    host: env.OURS_MESSENGER_HOST ?? '127.0.0.1',
    port: intOrUndefined(env.OURS_MESSENGER_PORT, 'OURS_MESSENGER_PORT') ?? DEFAULT_HTTP_PORT,
    identity,
    force: boolOrUndefined(env.OURS_MESSENGER_FORCE, 'OURS_MESSENGER_FORCE') ?? false,
    stateDir: resolveOwnStateDir(env),
    keepHistory: boolOrUndefined(env.OURS_MESSENGER_KEEP_HISTORY, 'OURS_MESSENGER_KEEP_HISTORY') ?? true,
    runtime: {
      brokerUrl: validateBrokerUrl(env.OURS_MESSENGER_BROKER_URL || DEFAULT_BROKER_URL),
    },
  };
}
