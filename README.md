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
- `<OURS_MESSENGER_STATE_DIR>/media` for owner-only immutable media blobs,
  reply correlations, provenance, hashes, and logical file versions;
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
listener ownership is enforced by the SDK lifecycle gate described below.

## Running

The package and lockfile pin the published `@ours.network/sdk@1.3.1`. This release
provides the embedded daemon, receipt/event metadata, file/voice operations, and
`handleSignals: false` contract required by the messenger. The server owns signal
handling and ordered shutdown; it never removes another component's listeners.

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
outer `push.json` and the complete `media/` tree are included as well.
`migration.json` records source, backup,
identities, file/byte totals, and matching source/destination manifests. Because
identity keys and the complete actor state blob are copied byte-for-byte, CID,
conversation history, receipts, `keep_history`, push subscriptions, file bytes,
reply correlations, provenance, and media version history are preserved
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

The production build is an installable React 18 + TypeScript PWA emitted by Vite under
`dist/web`: `index.html` is no-cache, while content-hashed `/assets/*` are served
immutable with explicit MIME types and `nosniff`. During frontend-only work,
`npm run dev` starts Vite on loopback and proxies `/api` and `/mcp` to the
messenger server; use `npm run dev:server` for the backend process.

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

The focused client does not persist messages, identities, receipts, or API
responses in browser storage. Its service worker caches only the application
shell and static assets for offline launch; all `/api/*` requests bypass it.

The web UI includes identity hierarchy and active-binding status; contact add,
approval, rename and removal; one-time/public invite creation and revocation;
message replies; drag/drop/paste and picker uploads with bounded progress/error
states; per-dialog file and version history; photo/audio/Markdown previews; and
voice recording. Conversations open on the newest 50 messages and load older
history with an exclusive cursor while preserving the visible scroll position.
Incoming files are fetched only after an explicit user action. HTML previews run
in a sandboxed frame with a deny-by-default CSP, and Markdown is rendered to
React nodes without raw HTML execution. Direct media responses allowlist only
raster image/audio/video MIME types for inline use; HTML, SVG, XML, PDF, scripts,
and unknown formats are opaque attachments with `nosniff` and a sandboxing CSP.

## WebPush

Web Push is an explicit per-browser opt-in in Settings. The server sends a full
notification label/body and dialog click-through URL, encrypted to the browser
with the standard Web Push content-encoding contract and signed with VAPID. The
upstream watcher and SSE stream remain non-consuming and metadata-only, so push
delivery cannot mark a message read. Web Push is separate from the ours
end-to-end channel: the push provider observes delivery metadata, and the device
may display decrypted notification text on its lock screen. The UI states this
before subscription.

An absent `push.json` is initialized on first run. An existing file that is
unreadable, malformed, or schema-invalid aborts startup without rewriting keys
or subscriptions; the error identifies the preserved path and requires the
operator to restore it or explicitly move it aside before a new state is made.

## REST surface

Routes live under `/api/`; `src/api.ts` is the executable route list. Principal
routes include identity/contact/invite operations, conversation snapshots,
explicit read, text/file mutations, per-dialog media inventory and explicit
incoming fetch, owner-only media download, WebPush routes, `/api/state`,
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
npm run test:browser
npm test
```

The suite covers mutation intent gates, safe inline-file bounds, health identity
and timeout behavior, response/log redaction, immutable build identity, the
owned-runtime source boundary, explicit root initialization,
empty-serve non-mutation, stable CID provenance, byte-complete migration and
invalid-input non-mutation, live lock collisions, graceful release, SIGKILL/PID
reuse recovery, bundle execution, ambient state isolation, real-token redaction,
`/mcp` 404, programmatic shutdown and partial-start rollback, receipt semantics,
REST/WebPush encryption and full payloads, reply correlation, immutable media and
version round-trips, hostile top-level media navigation, exact voice MIME/bytes,
sandboxed previews, corrupt push-state preservation/recovery, PWA cache
isolation/installability/offline launch in Chromium, SSE backpressure and
reconnect, cursor paging with stable scroll anchoring, invite-dialog reopen,
focused-client contracts and the exact-dialog read gate.

## SDK lifecycle ownership

The pinned SDK exposes `DaemonOptions.handleSignals?: boolean`; messenger calls
`startDaemon({ handleSignals: false })`. The SDK therefore installs no process
signal handlers and never exits the host process. The targeted source-contract
test plus owned-runtime shutdown tests enforce this boundary.

The known SDK teardown report of one bounded `AdaptPacketContext` allocation is
unchanged and remains upstream lifecycle accounting, not messenger state growth.
