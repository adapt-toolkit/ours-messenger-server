# Messenger architecture

## System boundary

One messenger process owns the browser application and its same-origin HTTP
surface. Identity and protocol state belong to one independently managed ours
daemon:

```text
browser ──same-origin REST/SSE──► messenger server
                                      │
                                      │ public SDK client + identity lease
                                      ▼
                                 shared ours daemon
                                      │
                                      ▼
                            encrypted ours peer transport
```

Messenger calls the public `attachOursClient` SDK boundary. Standard
`OURS_CONFIG`, `OURS_STATE_DIR`, `OURS_PORT`, endpoint, and API-token selection
resolve one coherent daemon; the SDK verifies the daemon's reported state root
before credentials are sent. Messenger then leases exactly
`OURS_MESSENGER_IDENTITY`. It never starts or stops a daemon, imports the daemon
runtime, provisions an identity, or guesses an identity.

The public REST surface is intentionally unauthenticated. Loopback is the secure
default; non-loopback use requires an authenticated reverse proxy and an exact
configured public origin. Every mutation requires JSON content type, exact
`Origin`, and the messenger CSRF header. There is no permissive CORS path.

## Ownership and lifecycle

The shared daemon owns identity keys, peer protocol state, durable message and
file history, file blobs, read state, and delivery receipts. Messenger owns its
public listener and application state under `OURS_MESSENGER_STATE_DIR`: WebPush
keys, subscriptions, and the durable delivery queue.

A lightweight worker owns the public port while daemon attachment and identity
binding complete. During that gate only build provenance is available; health
and other API requests return 503. After the lease, application stores, watcher,
and delivery queue are ready, the full server takes over the same port.

Startup is transactional. Failure closes the startup listener or public server,
watcher, delivery queue, SSE fan-out, and acquired SDK lease. Ordered shutdown
does the same and is idempotent. It does not stop the shared daemon, alter daemon
configuration, or delete daemon state.

## Canonical history and receipts

The daemon's external history database is canonical for text, files, ordering,
read state, and receipts. The messenger never treats packet-local MUFL history or
a private sidecar as application history.

The stable keys are peer CID, monotonically increasing history sequence, and
cross-peer `wire_id`. Names are display-only; local inbox `msg_id` values are not
cross-peer identifiers. Conversation pages call `listHistory` plus
`getHistorySummary`, projecting the daemon's newest-first pages into the
browser's oldest-first presentation. The daemon sequence is the pagination
cursor.

Conversation GETs are non-consuming. The explicit read route first lists unread
message metadata, filters by the selected peer CID, and calls selective
`getMessages({ wire_ids })` in bounded batches. It therefore never consumes a
message from another dialog. Receipt display is monotonic:

```text
sent → delivered → read
```

The browser calls the read route only while that exact dialog is visibly open:
the tab is visible, route and CID match, the mobile detail pane is open when
applicable, and no covering dialog is present.

## Events and convergence

One non-consuming daemon notification watch feeds a bounded in-process bus.
SSE is an invalidation channel, never a second message log:

- each client begins with `sync_required(connected)`;
- reconnect emits `sync_required(daemon_reconnected)`;
- queue overflow collapses missed details to `sync_required(overflow)`;
- message, file, and receipt events contain correlation metadata only;
- REST snapshots always rebuild canonical state.

Daemon notification emission can precede the following history read becoming
visible. Push projection therefore performs bounded convergence retries through
`getHistoryItem` or `getFileInfo`; it never copies message bodies from event
payloads.

## Replies and files

Reply correlation is stored in daemon history and projected from canonical
`reply_to` metadata. Browser file input is bounded to 20 MiB and must be inline
base64 with a safe filename and MIME; a browser cannot ask the server to read an
arbitrary filesystem path.

The daemon stores encrypted-transfer results and immutable bytes by wire ID.
Messenger lists file history through `listFiles`, retrieves metadata through
`getFileInfo`, consumes only explicitly selected unread files through
`getFiles({ wire_ids })`, and streams bytes through `fetchFile`. Active content
is forced to download with `nosniff`, a deny-by-default CSP, and no-store cache
headers.

Voice messages use the exact `x-ours-kind=voice-message` MIME discriminator.
Browser recording chooses OGG/Opus, WebM/Opus, then MP4/AAC. Transcription status
and text are projections of daemon file history.

## Safe rendering

Message Markdown becomes React nodes without `dangerouslySetInnerHTML`; only
HTTP(S) links are clickable. File previews use explicit Blob URLs and revoke
them on teardown. HTML previews run in a sandboxed iframe with no capabilities
and a deny-by-default content-security policy.

## Web Push privacy boundary

Push is browser opt-in. A full preview contains canonical sender and message
text or a file label; private preview contains generic content. Standard WebPush
content encryption protects the payload to the subscribed browser, and VAPID
authenticates this server to the push service. This is separate from the ours
peer-to-peer channel: the push provider still observes routing metadata, and the
device can reveal decrypted text on its lock screen.

`push.json` is versioned, atomic, owner-only, and scoped to the startup-bound
identity CID. Public routes expose only the VAPID public key, fingerprint,
configuration epoch, and opaque binding acknowledgements. Subscription
mutations have strict origin/CSRF checks, validation, size and rate limits.

The delivery queue stores only pending/retry correlation metadata plus a small,
short-lived dedupe tombstone set; payload content and multi-day result history
are absent. Delivery totals are separate counters. Each attempt re-reads
canonical history. Permanent endpoint failures prune a binding; transient
failures retry with bounded exponential backoff. Foreground browser presence can
suppress delivery for the matching binding without suppressing other devices.

A separate persisted byte cursor follows the daemon's durable, content-free
notification log. Cursor advancement happens only after durable queue admission,
so a crash replays into job/tombstone dedupe and saturation leaves the source
event recoverable. First use primes at the current tip; unread history is never
bulk-transformed into pushes.

Provider acceptance and the local atomic state file cannot form one
transaction. If the process dies after the provider accepts a request but
before the completion/tombstone rename, restart retries that in-flight job. The
queue deliberately chooses at-least-once recovery at this irreducible boundary
instead of silently losing a notification.

## PWA cache boundary

The service worker handles installation, update, notification, and offline shell
behavior. Every `/api/*` request, including SSE, bypasses service-worker caching.
Messages, identities, receipts, subscriptions, and media are never copied into
browser persistence.

## Verification model

The release gate combines typechecking, production build, offline unit and web
contracts, shared-daemon loopback tests launched through the published CLI,
real REST/WebPush/file coverage, Chromium PWA and layout checks, and packed
artifact inspection. Bundle checks reject daemon, native evaluator, WASM, and
MUFL runtime assets so messenger cannot silently regress into daemon ownership.
