# @ours.network/messenger-server

A self-hosted web messenger for ours.network. It attaches to the same shared
ours daemon used by the CLI and peer services, leases one configured identity,
and exposes a same-origin REST/SSE web application. Messenger never starts,
stops, embeds, or owns the daemon, and `/mcp` always returns 404.

Message and file history is persisted by the shared daemon outside MUFL packets.
Messenger reads the daemon's external history API and selectively consumes only
the unread messages for the active conversation. SSE carries metadata-only
invalidations; the browser rebuilds durable truth from REST snapshots.

## Shared daemon and identity

`start()` calls the SDK's client-only `attachOursClient`, using the standard
`OURS_CONFIG`, `OURS_STATE_DIR`, `OURS_PORT`, endpoint, and API-token selection.
The SDK verifies that the endpoint belongs to the expected state directory
before sending credentials. Messenger then calls `chooseIdentity` for exactly
`OURS_MESSENGER_IDENTITY`; it never creates an identity or chooses one
implicitly.

The shared daemon owns identity keys, MUFL protocol state, message/file history,
and file blobs. Messenger owns only its public HTTP server and application state
under `OURS_MESSENGER_STATE_DIR`, including WebPush subscriptions, delivery
queue metadata, and VAPID keys. Shutting down messenger releases its SDK lease
but does not stop the daemon.

Startup is transactional: a daemon-attach, identity-bind, application-store,
watcher, or listener failure closes the public server if present, stops the
watcher, releases the lease, and preserves existing state. Normal `close()` is
idempotent and follows the same ordered path.

## Running

Install and start the shared daemon with `@ours.network/cli`, create the identity
there, then start messenger with the same daemon selection:

```bash
npm install
npm run build

# One-time host setup. These commands come from @ours.network/cli.
ours config setup --port 3070 --state-dir /srv/ours
ours daemon start
ours identity create-root --name 'Ada@server'

OURS_MESSENGER_STATE_DIR=/srv/ours-messenger \
  OURS_STATE_DIR=/srv/ours \
  OURS_PORT=3070 \
  OURS_MESSENGER_IDENTITY='Ada@server' \
  OURS_MESSENGER_PUBLIC_ORIGIN=http://127.0.0.1:8420 \
  node dist/cli.js serve
```

`serve` is the only messenger command. Daemon lifecycle, identity provisioning,
and daemon-state reset belong to the ours CLI. This storage epoch intentionally
has no migration: remove old daemon state before installing it, as documented by
the SDK/CLI release. Messenger-specific `push.json` remains separate and is not
daemon identity storage.

Open `http://127.0.0.1:8420/`. Useful configuration:

```text
OURS_MESSENGER_HOST              default 127.0.0.1
OURS_MESSENGER_PORT              default 8420; 0 selects a dynamic public port
OURS_MESSENGER_PUBLIC_ORIGIN     required exact external http(s) origin
OURS_MESSENGER_STATE_DIR         default ~/.ours-messenger
OURS_MESSENGER_FORCE             default false
OURS_MESSENGER_VAPID_PUBLIC_KEY  optional; must be paired with the private key
OURS_MESSENGER_VAPID_PRIVATE_KEY optional secret; never expose to the browser
OURS_MESSENGER_VAPID_SUBJECT     default mailto:admin@localhost
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
non-loopback bind. The shared daemon token protects only its private SDK HTTP
surface and is never returned by `/api/state` or written to messenger logs.

## Receipts and live updates

Delivered and read are distinct. The daemon records delivered after accepted
storage; browser snapshot reads are non-consuming. The web read gate calls
`POST /api/conversations/:contact/read` only when that exact dialog is visible.
That route filters the non-consuming unread index by the selected peer CID and
selectively consumes only those wire IDs. The general consuming `getMessages`
operation is intentionally absent from the REST surface. Duplicate calls are
harmless because only unread-to-read transitions produce receipt wire IDs.

`GET /api/events` is a bounded SSE invalidation stream:

- every connection begins with `sync_required(reason=connected)`;
- message and receipt events carry authenticated IDs and wire IDs, never bodies;
- watcher reconnect emits `sync_required(reason=daemon_reconnected)`;
- backpressure overflow collapses details to one `sync_required(reason=overflow)`;
- there is no replay ID; REST snapshots recover all durable state.

The focused client does not persist messages, identities, receipts, or API
responses in browser storage. Its service worker caches only the application
shell and static assets for offline launch; all `/api/*` requests bypass it.

The web UI is the messenger-only port of the canonical ours-control-plane
interface at commit `bc0183c80e9ee0ea2dd5adecb58460b0564e90d5`; its exact source inventory and
transport exclusions are recorded in `web/src/CANONICAL_UI_PROVENANCE.md`. It
includes grouped identity-root contacts; contact add, approval, rename and
removal; one-time/public invite creation and revocation; public bio editing;
message and attachment replies; drag/drop/paste and picker uploads with bounded
progress/error states; per-dialog file and version history; photo/audio/Markdown
previews; voice recording and transcript display. Conversations open on the newest 50 messages and load older
history with an exclusive cursor while preserving the visible scroll position.
Incoming files are fetched only after an explicit user action. HTML previews run
in a sandboxed frame with a deny-by-default CSP, and Markdown is rendered to
React nodes without raw HTML execution. Direct media responses allowlist only
raster image/audio/video MIME types for inline use; HTML, SVG, XML, PDF, scripts,
and unknown formats are opaque attachments with `nosniff` and a sandboxing CSP.

## WebPush

Web Push is an explicit per-browser opt-in in Settings. The default `Full`
preview sends the canonical sender and message text or filename; `Private`
sends only a generic message/file/photo/voice label. The payload and safe
same-origin dialog path are encrypted to the browser with the standard Web Push
content-encoding contract and signed with VAPID. The upstream watcher and SSE
stream remain non-consuming and metadata-only, so push delivery cannot mark a
message read. Web Push is separate from the ours end-to-end channel: the push
provider observes endpoint, timing, and payload-size metadata, and the device
may display the decrypted preview on its lock screen. The UI states this before
permission is requested.

The browser state is server-acknowledged: `Off`, `Needs permission`,
`Repairing`, or `On`. A browser is not shown as On until its current
subscription and VAPID generation have been acknowledged by the server. VAPID
rotation makes old bindings repair-required; Repair performs one controlled
unsubscribe/resubscribe. Disable converges both the server binding and browser
subscription. On iOS, install the site to the Home Screen before enabling push.

Delivery jobs are durable, identity-scoped metadata keyed by authenticated
sender CID, wire ID, and event kind. They never persist message text or file
contents. Each attempt re-reads the canonical SDK projection; restart resumes
pending work, duplicate watcher events converge to one job, 404/410 responses
prune dead bindings, and transient network/429/5xx responses use bounded
backoff with jitter and expiry. Push failures do not stop the watcher.

An absent `push.json` is initialized on first run. An existing file that is
unreadable, malformed, or schema-invalid aborts startup without rewriting keys,
bindings, or jobs; the error identifies the preserved path and requires the
operator to restore it or explicitly move it aside before a new state is made.
The file is written atomically with mode `0600`. Back up the stable state root;
losing or rotating its VAPID private key requires every browser to repair its
subscription.

Production prerequisites are an accurate system clock, outbound HTTPS access to
browser push services, a stable writable owner-only state directory, an exact
`OURS_MESSENGER_PUBLIC_ORIGIN`, and HTTPS at the public browser origin (localhost
is the development exception). This application enforces same-origin, CSRF,
input bounds, identity isolation, and secret redaction. It does not authenticate
public users: any non-loopback deployment still requires an authenticated
reverse proxy. No nginx or other proxy-specific configuration is assumed.

## REST surface

Routes live under `/api/`; `src/api.ts` is the executable route list. Principal
routes include identity/contact/invite operations, conversation snapshots,
explicit read, text/file mutations, per-dialog media inventory and explicit
incoming fetch, owner-only media download, WebPush routes, `/api/state`,
`/api/healthz`, `/api/build-info`, and `/api/events`. During startup, build
metadata is available while health returns a fixed `status=starting` 503. After
the readiness transition, health returns 200 only when the shared daemon responds
before its deadline with the startup-bound identity CID; failures use one fixed
503 shape. State excludes the daemon endpoint, token, and broker configuration.
Build metadata is injected by `build.mjs` as
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
and timeout behavior, response/log redaction, immutable build identity, shared
daemon attachment, exact identity leasing, external history paging, selective
conversation reads, graceful lease release, bundle execution, token redaction,
`/mcp` 404, programmatic shutdown and partial-start rollback, receipt semantics,
REST/WebPush encryption and full payloads, reply correlation, immutable media and
version round-trips, hostile top-level media navigation, exact voice MIME/bytes,
sandboxed previews, corrupt push-state preservation/recovery, PWA cache
isolation/installability/offline launch in Chromium, SSE backpressure and
reconnect, cursor paging with stable scroll anchoring, invite-dialog reopen,
focused-client contracts and the exact-dialog read gate.

## SDK lifecycle boundary

Messenger imports only the public client surface of `@ours.network/sdk`.
Bundle-contract tests reject daemon/native/MUFL artifacts and embedded-runtime
imports. Process signals stop the messenger HTTP application and release its
identity lease; daemon lifecycle remains exclusively under the ours CLI.
