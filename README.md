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

An atomic `.messenger-runtime.lock` refuses concurrent use of the same state
directory before SDK import. Programmatic close and rollback remove the matching
lock. After a crash, verify the recorded PID is dead before removing a stale lock;
the messenger never guesses and deletes another process's ownership record.

On a genuinely empty owned store, the configured messenger identity is created
on first start. Once any identities exist, a misspelled configured name fails
instead of silently creating a second identity.

Startup is transactional after `startDaemon()` returns: binding, push-store,
watcher or public-listen failure closes the public server if present, stops the
watcher, releases the lease, and closes the runtime. Normal `close()` is
idempotent and uses the same ordered path. Tests require both loopback ports,
listening server handles, and the ownership lock to be gone afterward; OS signal
listener ownership is the separate SDK blocker below.

## Running

The checked-in package and lockfile intentionally remain pinned to the published
`@ours.network/sdk@1.0.1`. That release does not yet contain the daemon/receipt
contract required by this branch. Development and tests currently require the
locally linked SDK at exactly:

```text
dd0fa11307f3576256135aba3820e94d48cf05b2
```

SDK receipt PR #16 is merged with green CI, but no containing SDK release exists.
The local link is not a release claim. Do not publish the messenger until a
released SDK contains the required API and the dependency/lockfile can be pinned
to that published version.

```bash
npm install
npm run build

OURS_MESSENGER_IDENTITY=Me \
  node dist/cli.js serve
```

Open `http://127.0.0.1:8420/`. Useful configuration:

```text
OURS_MESSENGER_HOST              default 127.0.0.1
OURS_MESSENGER_PORT              default 8420; 0 selects a dynamic public port
OURS_MESSENGER_STATE_DIR         default ~/.ours-messenger
OURS_MESSENGER_BROKER_URL        default wss://broker1.ours.network
OURS_MESSENGER_KEEP_HISTORY      default true
OURS_MESSENGER_FORCE             default false
```

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
and `/api/events`. Unknown `/api/*` routes remain JSON 404 responses. `/mcp` is a
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
npm test
```

The suite covers the owned-runtime source boundary, bundle execution, ambient
state isolation, real-token redaction, `/mcp` 404, programmatic shutdown and
partial-start rollback, receipt semantics, REST/WebPush, SSE backpressure and
reconnect, paging, focused-client contracts and the exact-dialog read gate.

## Explicit SDK lifecycle blocker

The linked SDK currently installs process handlers unconditionally in
`src/http/server.ts` inside `startHttpDaemon`:

```text
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
```

That `shutdown` calls `process.exit(0)`. Programmatic close and messenger rollback
do close their ports, handles, leases and state lock, but a real OS signal can run
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
