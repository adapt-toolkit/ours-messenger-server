# @ours.network/messenger-server

A self-hosted web messenger for ours.network. One process owns an isolated SDK
daemon runtime, a token-authenticated loopback `OursClient`, and the public
same-origin REST/SSE application. It has no runtime or deployment dependency on
ours-mcp, and `/mcp` returns 404 on both HTTP servers.

MUFL conversation history remains the only durable source of message and receipt
state. SSE carries metadata-only invalidations; the browser always rebuilds truth
from REST snapshots.

## Runtime ownership and isolation

`start()` configures the SDK before its first import, then dynamically imports
`@ours.network/sdk/daemon` and calls `startDaemon()` without an MCP integration.
The runtime always uses:

- `127.0.0.1` with port `0` (an OS-selected private port);
- SDK `apiVisibility=owner` and its private `0600` token file;
- an `OursClient` carrying that token and a per-process lease;
- `<OURS_MESSENGER_STATE_DIR>/runtime` for identities and runtime state;
- `<OURS_MESSENGER_STATE_DIR>/push.json` for messenger WebPush state;
- `<OURS_MESSENGER_STATE_DIR>/runtime/config.json` as the only SDK config path.

Ambient `OURS_STATE_DIR`, `OURS_CONFIG`, `OURS_PORT`, broker selection and API
token are overwritten before SDK evaluation. The messenger never reads or writes
`~/.ours` implicitly. The only runtime selection exposed by messenger is
`OURS_MESSENGER_BROKER_URL`.

An OS-held advisory `flock` on `.messenger-runtime.lock` refuses concurrent use
of the same state directory before SDK import. The file contains diagnostic JSON
but its existence and PID text are never ownership evidence. Closing the held
descriptor, `SIGKILL`, process loss, and reboot release ownership in the kernel;
PID reuse cannot steal a live descriptor lock and no stale file is removed.

`serve` never creates an identity. A read-only preflight on an empty owned store
throws the typed `INITIALIZATION_REQUIRED` error before creating a directory,
lock, token, registrar, or listener. Once identities exist, a misspelled
configured name remains a hard non-mutating SDK error.

Startup is transactional after `startDaemon()` returns: binding, push-store,
watcher or public-listen failure closes the public server if present, stops the
watcher, releases the lease, and closes the runtime. Normal `close()` is
idempotent and uses the same ordered path. Tests require both loopback ports,
listening server handles, and advisory ownership to be released afterward; OS signal
listener ownership is the separate SDK blocker below.

## Running

The checked-in package and lockfile intentionally remain pinned to the published
`@ours.network/sdk@1.0.1`. That release does not yet contain the daemon/receipt
contract required by this branch. Development and tests currently require the
locally linked SDK at exactly:

```text
d357bb7de76eeefc7178175bb5801cc521002bc4
```

SDK receipt PR #16 is merged, and SDK signal-ownership PR #17 is awaiting CI and
release. No published SDK release contains both contracts. The local link is not
a release claim. Do not publish the messenger until a released SDK contains the
required APIs and the dependency/lockfile can be pinned to that published version.

```bash
npm install
npm run build

# First run: creates exactly one Human/root identity offline. Omit --yes to
# review the exact state/name/bio and confirm interactively.
OURS_MESSENGER_STATE_DIR=/srv/ours-messenger \
  node dist/cli.js init --name 'Ada@server' --bio 'Ada on the messenger host' --yes

OURS_MESSENGER_STATE_DIR=/srv/ours-messenger \
  OURS_MESSENGER_IDENTITY='Ada@server' \
  OURS_MESSENGER_PUBLIC_ORIGIN=http://127.0.0.1:8420 \
  node dist/cli.js serve
```

`init` requires non-empty `--name` and `--bio`, calls the SDK Human/root API
(never the flat identity API), verifies exactly one matching root, and writes an
owner-only `initialization.json` receipt containing its stable CID. Every later
`serve` verifies a matching name/CID when that receipt is present. A second init
refuses before starting or mutating the runtime.

To import an existing **stopped SDK state directory** (or a stopped messenger
state root containing `runtime/`) into an empty destination, stop every source
writer first and use an explicit new backup path:

```bash
OURS_MESSENGER_STATE_DIR=/srv/ours-messenger \
  node dist/cli.js migrate \
    --source /srv/old-ours-state \
    --backup /srv/backups/ours-messenger-20260814 \
    --yes
```

The command rejects identical/nested paths, symlinks, a live messenger advisory
lock, a corroborated live CLI-managed daemon, an empty/incomplete source, an
existing backup, or any non-empty destination before mutation. It first copies
source and empty-destination backups, then copies the complete runtime through a
private sibling staging root, verifies a deterministic path/size/SHA-256
manifest, and atomically installs the destination. For a messenger-root source,
outer `push.json` is included as well. `migration.json` records source, backup,
identities, file/byte totals, and matching source/destination manifests. Because
identity keys and the complete actor state blob are copied byte-for-byte, CID,
conversation history, receipts, `keep_history`, and push state are preserved
across the clean destination restart. Never point messenger at a concurrently
used `~/.ours` directory.

Open `http://127.0.0.1:8420/`. Useful configuration:

```text
OURS_MESSENGER_HOST              default 127.0.0.1
OURS_MESSENGER_PORT              default 8420; 0 selects a dynamic public port
OURS_MESSENGER_PUBLIC_ORIGIN     required exact external http(s) origin
OURS_MESSENGER_STATE_DIR         default ~/.ours-messenger
OURS_MESSENGER_BROKER_URL        default wss://broker1.ours.network
OURS_MESSENGER_KEEP_HISTORY      default true
OURS_MESSENGER_FORCE             default false
```

Every state-changing HTTP request must carry `Content-Type: application/json`,
an exact single `Origin` equal to `OURS_MESSENGER_PUBLIC_ORIGIN`, and
`X-Ours-Messenger-CSRF: 1`. The check runs before body parsing and route handlers;
the server supplies no permissive CORS or successful preflight path. Browser file
sends accept bounded inline base64 only and reject the `path` key.

The public messenger REST surface has no built-in user authentication. Keep the
default loopback bind or put an authenticated reverse proxy in front of a
non-loopback bind. The internal runtime token protects only the private SDK HTTP
surface and is never returned by `/api/state` or written to messenger logs.

## Receipts and live updates

Delivered and read are distinct. The core emits delivered after accepted
storage; read is emitted only by `markRead`. Browser snapshot reads are
non-consuming, and `getMessages` is intentionally absent from the REST surface.
The web read gate calls `POST /api/conversations/:contact/read` only when that
exact dialog is visible. Duplicate calls are harmless because only unread-to-read
transitions produce receipt wire IDs.

`GET /api/events` is a bounded SSE invalidation stream:

- every connection begins with `sync_required(reason=connected)`;
- message and receipt events carry authenticated IDs and wire IDs, never bodies;
- watcher reconnect emits `sync_required(reason=daemon_reconnected)`;
- backpressure overflow collapses details to one `sync_required(reason=overflow)`;
- there is no replay ID; REST snapshots recover all durable state.

The focused client does not persist messages in browser storage and exposes no
monitoring, cluster, backup or service-management UI.

## WebPush

The browser registers a standard WebPush subscription with this server. The
server stores it, signs notifications with VAPID and sends sender/count metadata.
The notification watcher is non-consuming and content-free, so push delivery
cannot mark a message read or include its text.

## REST surface

Routes live under `/api/`; `src/api.ts` is the executable route list. Principal
routes include identity/contact/invite operations, conversation snapshots,
explicit read, send/file mutations, WebPush compatibility routes, `/api/state`,
`/api/healthz`, `/api/build-info`, and `/api/events`. Health returns 200 only when
the owned runtime responds before its deadline with the startup-bound identity
CID; failures use one fixed 503 shape. State excludes runtime paths, broker,
internal port and token provenance. Build metadata is injected by `build.mjs` as
the full Git SHA plus clean/dirty provenance; `OURS_MESSENGER_RELEASE_BUILD=1`
refuses dirty tracked or untracked source. Unknown `/api/*` routes remain JSON
404 responses. `/mcp` is a
plain 404 and never falls through to the SPA.

Legacy browser naming maps as follows:

| old name | messenger route / SDK operation |
| --- | --- |
| `listPendingInvites` | `GET /api/invites` → `listInvites` |
| `listContactRoots` | `GET /api/contacts/roots` → `listContacts().roots` |
| `getProfileName` | `GET /api/identity` → `currentIdentity()` |
| `introduce` | responder-only `respondToIntroduction`; no initiator operation exists |

## Verification

```bash
npm run typecheck
npm run build
npm run test:offline
npm run test:loopback
npm test
```

The suite covers mutation intent gates, safe inline-file bounds, health identity
and timeout behavior, response/log redaction, immutable build identity, the
owned-runtime source boundary, explicit root initialization,
empty-serve non-mutation, stable CID provenance, byte-complete migration and
invalid-input non-mutation, live lock collisions, graceful release, SIGKILL/PID
reuse recovery, bundle execution, ambient state isolation, real-token redaction,
`/mcp` 404, programmatic shutdown and partial-start rollback, receipt semantics,
REST/WebPush, SSE backpressure and reconnect, paging, focused-client contracts
and the exact-dialog read gate.

## Explicit SDK lifecycle blocker

The linked SDK currently installs process handlers unconditionally in
`src/http/server.ts` inside `startHttpDaemon`:

```text
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

That `shutdown` calls `process.exit(0)`. Programmatic close and messenger rollback
do close their ports, handles, leases and advisory ownership, but a real OS signal can run
SDK teardown/exit before the messenger closes its public HTTP server and watcher
in host-owned order. Signal-listener installation/removal therefore remains out
of the default lifecycle assertions until the host can disable it entirely.

The minimal SDK API is:

```ts
interface DaemonOptions {
  handleSignals?: boolean // default true for existing CLI/MCP hosts
}
```

Messenger must call `startDaemon({ ..., handleSignals: false })`; in that mode
the SDK installs no signal handlers and never calls `process.exit`. The targeted
test reports a deterministic skip while the option is absent and asserts the
messenger call automatically once the SDK declaration exists:

```bash
node tests/sdk-signal-ownership.blocker.test.mjs
```

Do not work around this by removing process listeners from messenger. Until the
SDK option is released and the blocker test exercises the call, ordered signal
shutdown and publication remain blocked even though programmatic lifecycle is
complete.

The known SDK teardown report of one bounded `AdaptPacketContext` allocation is
unchanged and remains upstream lifecycle accounting, not messenger state growth.
