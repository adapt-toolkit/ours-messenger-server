// Configuration for the messenger server.
//
// TWO SEPARATE SELECTIONS LIVE HERE AND THEY MUST NOT BE CONFLATED:
//
//   1. WHICH DAEMON WE ATTACH TO. Not ours to invent — it is handed verbatim to
//      the SDK's `resolveDaemonConfig`, whose precedence rules mirror the daemon's
//      own resolver so a shell cannot select one daemon for `ours` and a different
//      one for us. We add no defaults of our own on top of it; every field below is
//      `undefined` unless the operator set it, because a default we invent here is
//      exactly how a token gets sent to the wrong endpoint.
//
//   2. WHERE OUR OWN STATE LIVES (push subscriptions, VAPID keys). This is the
//      SERVER's directory, NOT the daemon's state dir. Writing our files into
//      `~/.ours` would make an operator's daemon state dir contain something the
//      daemon does not own.

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

  /** Our own state directory. Never the daemon's. */
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

  /** Verbatim daemon-selection inputs for the SDK's resolver. */
  readonly daemon: {
    readonly endpoint?: string;
    readonly port?: number;
    readonly stateDir?: string;
    readonly token?: string;
    readonly configPath?: string;
  };
}

export const DEFAULT_HTTP_PORT = 8420;

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
    stateDir: resolve(env.OURS_MESSENGER_STATE_DIR ?? join(homedir(), '.ours-messenger')),
    keepHistory: boolOrUndefined(env.OURS_MESSENGER_KEEP_HISTORY, 'OURS_MESSENGER_KEEP_HISTORY') ?? true,
    daemon: {
      endpoint: env.OURS_MESSENGER_DAEMON_URL || undefined,
      port: intOrUndefined(env.OURS_MESSENGER_DAEMON_PORT, 'OURS_MESSENGER_DAEMON_PORT'),
      stateDir: env.OURS_MESSENGER_DAEMON_STATE_DIR || undefined,
      token: env.OURS_MESSENGER_DAEMON_TOKEN || undefined,
      configPath: env.OURS_MESSENGER_DAEMON_CONFIG || undefined,
    },
  };
}
