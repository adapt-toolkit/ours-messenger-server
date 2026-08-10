// THIS MODULE MUST BE EVALUATED BEFORE ANYTHING THAT IMPORTS @ours.network/sdk,
// AND THE IMPORT ORDER IN src/cli.ts IS WHAT GUARANTEES IT. Do not reorder those
// two lines, and do not merge this file into another one that also imports the SDK.
//
// WHY, MEASURED RATHER THAN ASSUMED. Importing @ours.network/sdk — even for
// `OursClient` alone, a pure HTTP client — runs module-load code that touches the
// state directory it resolves at that moment:
//
//   $ node -e "await import('@ours.network/sdk')"
//   ours: reserved 6 persisted identity name(s) at module load: Developer-6, …
//   $ ls <that state dir>
//   daemon-token  startup-progress.json
//
// With OURS_STATE_DIR unset that directory is `~/.ours` — THE OPERATOR'S LIVE
// DAEMON STATE DIR. Confirmed against the running daemon on this host: importing
// the client rewrote `~/.ours/startup-progress.json` (mtime moved), i.e. a process
// that starts no daemon and owns no state was writing into the state directory of
// one that does.
//
// What it does NOT do, also measured, because the difference matters: it does not
// clobber an existing `daemon-token` (the live one's mtime stayed at 2026-08-05 and
// the daemon kept authenticating), and it loads no native addon —
// `process.report.getReport().sharedObjects` contains no adapt/ours entry. So this
// is a state-directory side effect, not a second engine.
//
// The fix at this level is to point the SDK's module-load state dir at OUR OWN
// directory. Which daemon we attach to is a SEPARATE, EXPLICIT selection made by
// `resolveDaemonConfig({ stateDir: … })`, and explicit beats environment in its
// precedence — verified: with OURS_STATE_DIR pointed at a temp dir, the selection
// still resolved `/home/fleet/.ours`, `assertDaemonStateDir` passed, and the
// authenticated call read that directory's token file.
//
// THE REAL FIX IS AN SDK ONE — an engine-free client entrypoint, e.g.
// `@ours.network/sdk/client`. The package exports only `.`, `./daemon` and
// `./connector`, and the root barrel re-exports the daemon-side operation
// implementations alongside the client, so there is currently no way to import
// `OursClient` without them. That is raised with the coordinator; this file is the
// consumer-side mitigation until it lands, not a substitute for it.

import { mkdirSync } from 'node:fs';
import { resolveOwnStateDir } from './config.js';

// Resolved here rather than passed in: a caller who had to remember to call this
// first is a caller who will one day forget.
//
// `resolveOwnStateDir` rather than `loadConfig` because this runs on EVERY
// invocation, including `--help`, and loadConfig throws on a missing identity.
const dir = resolveOwnStateDir();
mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.OURS_STATE_DIR = dir;

/** The directory the SDK's module-load side effects were redirected into. */
export const REDIRECTED_STATE_DIR = dir;
