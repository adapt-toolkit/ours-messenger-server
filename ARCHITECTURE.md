# Messenger architecture

Status: implemented on `@ours.network/sdk@1.3.1`

## System boundary

One messenger process owns three surfaces:

```text
browser ──same-origin REST/SSE──► messenger server
                                      │
                                      │ token-authenticated loopback only
                                      ▼
                              embedded ours SDK daemon
                                      │
                                      ▼
                            encrypted ours peer transport
```

The embedded daemon binds `127.0.0.1` on an OS-selected port with owner-only API
visibility. Its token never leaves the server process. Messenger injects no MCP
integration, and `/mcp` is a plain 404 on both HTTP surfaces. Ambient ours state,
config, broker, port, and token selection are replaced before the SDK's first
dynamic import.

The public REST surface is intentionally unauthenticated. Loopback is the secure
default; non-loopback use requires an authenticated reverse proxy and an exact
configured public origin. Every mutation also requires JSON content type, exact
`Origin`, and the messenger CSRF header. There is no permissive CORS/preflight
path.

## Ownership and lifecycle

Messenger holds an advisory file lock on its runtime state for the process
lifetime. Startup is transactional: a bind, push-store, watcher, or listener
failure closes every completed stage. Ordered shutdown closes the public server,
watcher/SSE fan-out, identity lease, and embedded daemon. The SDK is started with
`handleSignals: false`, so the host exclusively owns signal handling and process
exit.

`serve` never creates identities. Offline `init` creates and verifies exactly one
Human/root identity and records its stable CID in `initialization.json`. Offline
`migrate` accepts only a stopped, complete source and an empty destination. It
creates a private backup, stages a byte-for-byte copy, compares deterministic
path/size/SHA-256 manifests, and atomically installs the result.

Messenger-root migration includes all three durable trees:

- `runtime/`: identity keys, actor state, conversation history, receipts;
- `push.json`: VAPID material and subscriptions;
- `media/`: immutable blobs, provenance, hashes, replies, and file versions.

## Canonical message and receipt state

MUFL conversation history remains canonical for text, ordering, read flags, and
receipts. The browser never constructs optimistic message rows; after a send it
refetches the authoritative conversation projection.

The stable keys are contact CID and cross-peer `wire_id`. Names are display-only,
and local inbox `msg_id` values are not cross-peer identifiers. Receipt display
is monotonic:

```text
sent → delivered → read
```

Conversation GETs are non-consuming. `markRead(contactCid)` is called only while
that exact dialog is visibly open: the tab is visible, the chats route and CID
match, the mobile detail pane is open when applicable, and no covering dialog is
present. Concurrent attempts are coalesced per CID. Repeated calls are harmless
because only unread-to-read transitions emit receipt wire IDs.

## Events and convergence

The SDK watcher is single-owner and non-consuming. It normalizes authenticated
message, receipt, and file notifications into metadata-only events. One bounded
in-process bus feeds SSE and the push decision.

SSE is an invalidation channel, never a second message log:

- each client begins with `sync_required(connected)`;
- reconnect emits `sync_required(daemon_reconnected)`;
- queue overflow collapses to `sync_required(overflow)`;
- message/file/receipt events contain CIDs, wire IDs, kinds, and dates only;
- there is no replay cursor; REST snapshots always rebuild truth.

SDK notification emission can precede the following durable save. Both the
browser and push watcher therefore use bounded convergence retries before giving
up until the next sync or user action. They never patch canonical state from an
event payload.

## Replies and media

The SDK conversation projection does not expose outbound reply correlation.
Messenger therefore keeps a narrow sidecar keyed by the returned outbound wire
ID. Inbound reply metadata is joined from the SDK's non-consuming inbox view.
The sidecar supplements projection only; MUFL still owns message bodies and
receipt state.

File transport uses the SDK's existing encrypted file operation. Browser input
is limited to 20 MiB and must be inline bytes plus a safe filename/MIME; a browser
cannot ask the server to read a filesystem path. Each available file is stored
once under its wire ID with SHA-256 integrity metadata and owner-only permissions.
The per-contact inventory records direction, authenticated peer, observed date
and its source, logical filename, MIME, byte size, availability, reply target,
and sequential version number. A conflicting overwrite of one wire ID fails
closed.

Incoming file notifications expose metadata but do not download bytes. A user
must explicitly fetch selected wire IDs. The server then asks the SDK for those
files, persists exact bytes, and makes them available through a private
`no-store`, `nosniff` media route.

Voice messages use the SDK's exact media discriminator:
`x-ours-kind=voice-message`. Browser recording chooses the first supported format
in deterministic order:

1. OGG/Opus;
2. WebM/Opus;
3. MP4/AAC as the Safari fallback.

The advertised filename also retains the SDK's `voice-message-` fallback prefix.
If none of those MediaRecorder contracts is available, recording fails closed
with a user-facing error.

## Safe rendering

Message Markdown is parsed into React nodes without `dangerouslySetInnerHTML`.
Only HTTP(S) links are clickable. File previews are rendered from explicitly
fetched Blob object URLs and revoke those URLs on teardown.

- images use an image element;
- voice/audio uses native controls;
- Markdown uses the same safe node renderer;
- HTML uses a sandboxed iframe with no sandbox capabilities and an injected
  deny-by-default CSP (`default-src 'none'; script-src 'none'`).

Download remains available for every fetched media record. Original content is
never injected into the main application DOM.

## Web Push privacy boundary

Push is an explicit browser opt-in. A notification contains the canonical full
message text or file/photo/voice label plus a dialog click-through path. Standard
Web Push content encryption protects the payload to the subscribed browser, and
VAPID authenticates this server to the push service.

This is not the ours end-to-end peer channel. The push provider observes routing
and delivery metadata, while the browser/device can reveal decrypted text on its
lock screen. Settings states this before subscription. Push failure never stops
the upstream watcher, and generating a notification never consumes or marks a
message read.

## PWA cache boundary

The manifest starts at `/chats`, is scoped to `/`, and uses standalone display.
The service worker caches only navigation shell and static assets. Every
`/api/*` request—including SSE—bypasses service-worker caching. Consequently the
app can launch offline and show its connection state, but messages, identities,
receipts, subscriptions, and media are not copied into browser persistence.

Worker updates are surfaced in Settings and activate only after an explicit user
action. Push click handling focuses or opens the app at the supplied dialog path.

## Verification model

The release gate combines:

- typecheck and production build;
- unit contracts for media integrity, replies, Markdown/HTML safety, voice MIME
  selection, SSE redaction/backpressure, and PWA cache rules;
- loopback tests for initialization, migration, advisory ownership, packaging,
  and runtime teardown;
- a real two-identity REST/runtime test covering receipts, reply correlation,
  two logical file versions with exact byte/hash checks, explicit incoming voice
  fetch, and encrypted full-text Web Push;
- real Chromium checks for manifest installability, service-worker activation,
  API cache isolation, and offline shell navigation;
- production dependency audit and packed-artifact smoke tests.

The known SDK shutdown diagnostic for one bounded `AdaptPacketContext` allocation
is upstream lifecycle accounting and is tested separately from messenger-owned
state growth.
