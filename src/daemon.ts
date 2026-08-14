// ATTACHING TO A DAEMON WE DID NOT START.
//
// This file is the entire coupling between this server and ours. It holds an
// `OursClient` and nothing else — no engine, no packet, no `startDaemon`. That is
// the point of the exercise rather than a detail of it: sharing one daemon with
// ours-mcp is why this repo exists, and a server that boots its own engine is the
// second daemon the work was commissioned to remove.
//
// The only place in this repo that may import `@ours.network/sdk/daemon` is the
// TEST HARNESS, which spawns a short-lived daemon on an isolated temp state dir so
// the suite does not need the operator's live one. tests/no-engine.test.mjs asserts
// that src/ never does.

import {
  OursClient,
  assertDaemonStateDir,
  describeDaemonConfig,
  resolveDaemonConfig,
  type ResolvedDaemonConfig,
} from '@ours.network/sdk';
import { randomBytes } from 'node:crypto';
import type { MessengerConfig } from './config.js';

export interface Attachment {
  readonly client: OursClient;
  readonly selection: ResolvedDaemonConfig;
  /**
   * OUR lease token. It IS our session: every session-scoped operation the daemon
   * runs for us is keyed on this, and a second client with a different token is a
   * different session to the same daemon. Fresh per process, because a token that
   * outlived the process it belongs to would let a dead session's binding linger.
   */
  readonly leaseToken: string;
  /** The redacted selection, safe to log and to serve on /api/state. Never the token. */
  readonly described: Record<string, unknown>;
}

/**
 * Resolve which daemon to talk to, prove it is the one intended, and return a
 * client bound to it.
 *
 * `assertDaemonStateDir` is not ceremony. The resolver can hand back a coherent
 * selection that nonetheless points at a DIFFERENT daemon than the operator meant
 * — a stale port, a second instance, a forwarded socket — and the first thing we
 * would otherwise do with that selection is send it an API token. The assertion
 * makes the daemon state its own state dir before any credential crosses the wire.
 */
export async function attach(cfg: MessengerConfig): Promise<Attachment> {
  const selection = resolveDaemonConfig({
    endpoint: cfg.daemon.endpoint,
    port: cfg.daemon.port,
    stateDir: cfg.daemon.stateDir,
    token: cfg.daemon.token,
    configPath: cfg.daemon.configPath,
  });

  await assertDaemonStateDir(selection);

  const leaseToken = `messenger-${randomBytes(12).toString('hex')}`;
  const client = new OursClient({
    url: selection.baseUrl.value,
    leaseToken,
    apiToken: selection.token?.value,
  });

  return { client, selection, leaseToken, described: describeDaemonConfig(selection) };
}

/**
 * Bind the identity this server acts as, and apply its retention policy.
 *
 * ORDER MATTERS. `setConversationPolicy` turning history ON also starts
 * advertising `core.receipts.receive`, but contacts we ALREADY have do not learn
 * that until our next outbound message carries the capability piggyback. So
 * `readvertiseOnUpgrade` follows it — a SEND, deliberately not folded into the
 * state write by the SDK, and therefore ours to make. Without it a
 * previously-agent identity keeps history from the moment we flip the flag while
 * its existing peers go on believing it discards receipts, and every conversation
 * with an old contact shows no ticks for no visible reason.
 */
export async function bindIdentity(
  a: Attachment,
  cfg: MessengerConfig,
): Promise<{ readonly name: string; readonly cid: string; readonly keepHistory: boolean; readonly readvertised: unknown }> {
  const binding = await a.client.chooseIdentity({ name: cfg.identity, force: cfg.force });

  const policy = await a.client.setConversationPolicy({ keep_history: cfg.keepHistory });

  // Only when history is ON is there a new capability for peers to learn. Turning
  // it off needs no push: peers discovering late that we stopped keeping history
  // costs nothing, because the receipts they send in the meantime are simply
  // discarded, which is what they would have been anyway.
  const readvertised = cfg.keepHistory ? await a.client.readvertiseOnUpgrade() : null;

  return { name: cfg.identity, cid: binding.cid, keepHistory: policy.keepHistory, readvertised };
}
