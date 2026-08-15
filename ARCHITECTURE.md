# Messenger delivery/read receipts and focused web client

Status: implemented messenger architecture with explicit SDK release blockers
Scope: messenger-owned runtime plus receipt/SSE/read-gate design
Messenger baseline: `0a962e9`; development SDK: `d357bb7de76eeefc7178175bb5801cc521002bc4`

The runtime decision below supersedes older shared-daemon assumptions in the
original receipt design: messenger embeds `startDaemon()` from
`@ours.network/sdk/daemon`, injects no MCP integration, and talks to its own
token-authenticated dynamic loopback port.

## 1. Decision

Keep MUFL conversation history as the only durable source of message and receipt
state. Messenger owns the SDK runtime that stores it; no external daemon or MCP
deployment is involved. Complete the already-existing receipt path rather than
creating a second receipt database:

1. Preserve the authenticated sender CID and affected wire IDs in the local MUFL
   notifications.
2. Teach the SDK host adapter to retain `receipt_received` notifications.
3. Add one same-origin Server-Sent Events (SSE) endpoint to the messenger server.
   Its events are hints to refresh canonical REST state, not a durable event log.
4. Build a messenger-only React client, visually derived from the control-plane
   Chats surface. It uses REST for snapshots and mutations and SSE for immediate
   invalidation.
5. Call `markRead(contactCid)` only while that exact contact's dialog is visibly
   open. The existing MUFL operation then sends one batched read receipt for the
   inbound messages that actually transition from unread to read.

No core wire-protocol change is required. The core already authenticates receipt
senders, gates receipts by negotiated capabilities, emits delivery only after
accepted storage, and prevents recursive receipts.

```text
remote peer
    │ encrypted message / receipt packets
    ▼
ours core ──authenticated callback──► messenger.mu ──durable history/receipt map
                                         │
                                         │ local notification (metadata only)
                                         ▼
SDK host adapter ──watchNotifications──► messenger event bridge ──SSE──► browser
                                               │                         │
                                               └──existing Web Push       ├─ GET snapshot
                                                                          └─ POST /read
```

## 2. Product contract

### In scope

- A focused web messenger: identity header, contact list/search, invite/contact
  actions, one-to-one conversation, text composer/reply context, unread counts,
  and sent/delivered/read marks.
- Immediate inbound-message and outbound-receipt refresh while connected.
- Exact-dialog read semantics on desktop and mobile.
- Refresh/reconnect correctness without depending on event replay.
- Existing REST, CLI, SDK, Web Push, and older-peer behavior remain compatible.

### Out of scope

- Monitoring, cluster/service status, backup/restore, and notification settings UI.
- Browser push subscription, notification toasts, presence, typing indicators,
  rooms, message deletion/editing, and per-device read positions.
- Changing `/home/fleet/ours-control-plane`.
- A new receipt table, browser message cache, or protocol-level acknowledgement.
- Claiming viewport-level reading. In this product, an inbound message is read
  once its exact conversation is the visible dialog.

Existing `/api/push/*` routes and the push worker remain for API compatibility,
but the new frontend neither exposes nor invokes them. Removing them is a separate
compatibility decision.

## 3. Current behavior and evidence

The branch already implements most durable semantics:

| Concern | Current source of truth | Observed behavior |
| --- | --- | --- |
| Runtime and conversation policy | `src/boot-env.ts`, `src/daemon.ts` | Isolates SDK config/state before import, starts the daemon without MCP, binds the identity, sets `keep_history`, and re-advertises on upgrade. |
| Snapshot reads | `src/api.ts`, `src/conversation.ts` | `GET` conversation/page/receipts is non-consuming and sends no read receipt. |
| Human read action | SDK `markRead` → `messenger.mu` | Only the named contact is affected; only unread inbound rows transition; non-empty wire IDs are batched once. A second call marks zero. |
| Receipt merge | `src/conversation.ts`, `messenger.mu` | Monotonic `null < delivered < read`; duplicate and out-of-order updates do not regress state. |
| Delivery meaning | core `a2a_messaging.mm` | Emitted only after the receiver's storage hook accepts the message. |
| Sent meaning | `messenger.mu` | An outbound history record accepted locally. It is not proof of remote delivery. |
| Receipt authorization | core `a2a_messaging.mm` | Receipt packet is accepted on an authenticated encrypted channel and attributed to that sender CID. |
| Correlation | history and receipt map | `wire_id` correlates the two peers. `msg_id` is local inbox identity and must not be used across peers. |
| Live observation | `src/watch.ts` | One reconnecting daemon notification watcher currently drives only Web Push. There is no browser live-event surface. |

The runtime and bundled SDK reveal the blocking gap:

- `messenger.mu` receives `(sender_id, kind, wire_ids)` in
  `on_receipt_received`, applies them durably, but its current local
  `receipt_received` notification contains only `event` and `kind`.
- The SDK host adapter has branches for `message_received`, `file_received`, and
  related events, but no `receipt_received` branch. The notification is therefore
  discarded before `watchNotifications` consumers can see it.
- The current `message_received` local notification exposes a display name and
  local `msg_id`, but not the canonical sender CID or cross-peer `wire_id`.
- The daemon notification generator primes to end-of-file when no cursor is
  supplied and does not expose its internal cursor to callers. A reconnect can
  consequently miss transient notifications. Durable MUFL state remains correct.

The existing test suite establishes the baseline and must remain green: receipt,
bundle, conversation paging, state isolation, REST and browser gates, plus the
new owned-runtime/lifecycle checks. The known bounded `AdaptPacketContext`
teardown allocation is already documented and is unrelated to this design.

## 4. Canonical state and identifiers

### Message projection

Use the SDK's existing `ConversationMessage` shape without a new persistence
model:

```ts
type ConversationMessage = {
  dir: "in" | "out";
  text: string;
  date: string;
  read: boolean; // human-read flag; not inbox processing state
  wire_id: string;
  receipt: "delivered" | "read" | null;
};
```

Rules:

- A contact CID is the canonical conversation key. Names are display-only and may
  change.
- `wire_id` is the canonical receipt/message correlation key. Empty wire IDs from
  older records cannot receive a receipt or serve as a stable paging cursor.
- `msg_id` remains a receiver-local inbox identifier.
- Receipt projection is monotonic. `read` implies delivered for display purposes;
  a later delivered update never downgrades it.
- One server process is bound to one identity. Every REST response and SSE stream
  belongs to that bound identity.

### Display state machine

```text
POST pending ──error/refused──► failed composer action (not message history)
      │
      └──authoritative outbound history row──► sent (single check)
                                                │ delivered receipt
                                                ▼
                                             delivered (double check)
                                                │ read receipt
                                                ▼
                                             read (colored double check)
```

Do not render an optimistic row as `sent`. After `POST /api/messages/send`
returns, refetch the conversation and render the authoritative history row. A
refused operation is an error; accepted/deferred transport outcomes still defer
visual truth to the history projection.

## 5. Required SDK/MUFL event contract

This is an additive local-host contract; network packets and durable history do
not change.

### `message_received`

```json
{
  "event": "message_received",
  "sender_id": "<authenticated CID>",
  "sender_name": "Alice",
  "msg_id": "<local inbox id>",
  "wire_id": "<cross-peer id>",
  "date": "2026-08-14T12:34:56.000Z"
}
```

### `receipt_received`

```json
{
  "event": "receipt_received",
  "sender_id": "<authenticated CID>",
  "kind": "delivered",
  "wire_ids": ["<wire id>", "<wire id>"],
  "date": "2026-08-14T12:34:57.000Z"
}
```

`sender_id`, `kind`, and `wire_ids` are required. `date` is required if the core
callback supplies a receipt timestamp; otherwise the adapter may stamp receipt at
observation time and document that it is not protocol time. `wire_ids` may be
empty only when decoding a legacy malformed notification; such an event triggers
a contact refresh but updates no row directly.

Message text and file content must never be copied into notification logs or SSE
events. The event is an authenticated metadata hint; REST remains the data plane.

SDK changes must:

- add the two expanded discriminated union members to public event types;
- persist/emit `receipt_received` through the same notification-log adapter as
  other supported events;
- preserve unknown future event types without crashing the watcher;
- retain compatibility when old actors omit newly-added fields by mapping the
  event to a generic `sync_required`, never by guessing a CID from a name.

## 6. Messenger-server API

Existing REST routes and response shapes stay valid. The frontend primarily uses:

```text
GET  /api/identity
GET  /api/contacts
GET  /api/invites
POST /api/invites                         (create)
POST /api/invites/revoke
POST /api/contacts/add                    (accept an invite)
GET  /api/conversations/:contact/page?limit=50&before=<wire_id>
GET  /api/conversations/:contact/receipts
POST /api/conversations/:contact/read
POST /api/messages/send
GET  /api/events                         (new)
```

The contact path segment is an encoded CID. Fetching either conversation endpoint
must remain non-consuming. Do not add or call `/api/messages`; the current 404
guard protects against the SDK's consuming inbox API.

### Read response

Retain the existing SDK-derived response and guarantee at least:

```json
{
  "contact": "<CID>",
  "marked": 2
}
```

`marked: 0` is success and is the expected duplicate result. Wire IDs are kept
inside the actor operation so callers cannot accidentally forge or widen the
receipt batch. If a later SDK return object gains additional keys, retain them
additively rather than renaming the existing fields.

### SSE endpoint

`GET /api/events` responds with `text/event-stream` and these headers:

```text
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

It emits JSON schema version 1:

```text
event: sync_required
data: {"v":1,"reason":"connected","identity":"<bound CID>"}

event: message_received
data: {"v":1,"contact_id":"<CID>","wire_id":"<wire id>","date":"<ISO>"}

event: receipt_received
data: {"v":1,"contact_id":"<CID>","kind":"read","wire_ids":["w1"],"date":"<ISO>"}
```

Contract details:

- Immediately send `sync_required(reason=connected)` on every browser connection.
- Send `sync_required(reason=daemon_reconnected)` to all clients after the
  upstream notification watcher reconnects.
- Send a comment heartbeat (for example `: keepalive`) every 20 seconds.
- Remove clients on socket close; enforce a bounded per-client queue and replace
  overflow with one `sync_required(reason=overflow)` hint.
- Set no SSE `id:` and promise no replay. `Last-Event-ID` is ignored in v1.
- Do not include message bodies, invite secrets, file paths, or push subscription
  data.
- Unknown upstream events may produce `sync_required(reason=unknown_event)` but
  must not terminate the stream.

SSE is deliberately an invalidation channel. This avoids inventing a second
cursor/log while closing the notification watcher gap: after any missed, duplicate,
or reordered event, a REST snapshot reconstructs the correct state.

## 7. Server event bridge

Refactor `src/watch.ts` into one daemon watcher per server, not one watcher per SSE
client. The watcher publishes normalized metadata to an in-process fan-out bus;
the existing Web Push decision is another subscriber to that bus.

On upstream failure:

1. Keep browser SSE connections open and send `sync_required` if the failure is
   observable.
2. Recreate the SDK notification generator with exponential backoff, retaining
   the current 500 ms to 30 s bounds and supporting abort on shutdown.
3. Once attached, broadcast `daemon_reconnected`.
4. Clients refetch contacts and their active conversation. No event replay is
   necessary because MUFL receipt/history state is durable.

The bridge must never apply receipt state itself. It cannot safely infer missing
events or overwrite the persisted receipt map.

## 8. Exact-dialog read gate

Define one pure predicate and use it at every read call site:

```ts
function canMarkRead(contactCid: string): boolean {
  return document.visibilityState === "visible"
    && appRoute === "chats"
    && selectedContactCid === contactCid
    && (desktopLayout || mobileDetailOpen)
    && !conversationCoveringDialogOpen;
}
```

`conversationCoveringDialogOpen` includes invite/contact/settings sheets that
cover the thread. A composer attachment menu that does not cover the dialog need
not block reads. If the first frontend slice has no covering dialogs, retain the
predicate input so later overlays cannot accidentally weaken the rule.

Call sequence:

1. **User opens a contact:** select the CID, open the mobile detail pane if
   applicable, fetch the page, render it, then call `markRead` only if
   `canMarkRead(cid)` remains true.
2. **Message event:** refresh contacts. If and only if the event CID equals the
   visible selected CID, refresh its page and then call `markRead(cid)`. Otherwise
   update the unread badge only.
3. **Visibility returns / mobile detail opens / covering dialog closes:** refresh
   the selected page, re-evaluate the predicate, then mark it read.
4. **Receipt event:** if it belongs to the selected CID, fetch its receipt/page
   projection immediately; otherwise refresh only list metadata.

Coalesce concurrent read attempts per CID with one in-flight promise plus a
single rerun flag. Do not globally debounce different CIDs. Recheck the predicate
immediately before the POST. POST success triggers a contacts/page refresh.

The contact-wide MUFL operation intentionally includes an inbound message that
arrives after the GET but before the POST: at POST time the exact dialog is open,
so that message satisfies the product's read definition. A future viewport-read
definition would require a bounded wire-ID API and is not part of this design.

## 9. Frontend structure and visual direction

Use the control-plane Chats surface as a read-only reference, not as a runtime
dependency. Preserve its useful language:

- dark-first near-black canvas, green accent, warm neutral tokens;
- 320–382 px contact rail plus flexible detail pane on desktop;
- full-width sliding conversation detail below 860 px;
- verified identity treatment, compact unread badge, message bubbles, floating
  composer;
- one check for sent, two neutral checks for delivered, two accent checks for
  read. Missing receipt means sent/unknown peer support, never failure.

Remove the Chats/Clusters mode switch and all monitoring, backup, push,
notification, and service-status affordances. The product header identifies the
bound messenger identity; the main surface is always Chats.

Recommended client state is small and derived:

```ts
type UiState = {
  identity: IdentityView | null;
  contacts: ContactView[];
  selectedContactCid: string | null;
  pagesByCid: Map<string, ConversationPage>;
  draftsByCid: Map<string, string>; // memory only
  mobileDetailOpen: boolean;
  coveringDialog: null | "invite" | "contact" | "settings";
  connection: "connecting" | "live" | "retrying";
};
```

Do not persist messages or receipts in local storage. At most persist theme and
contact-list presentation. On initial load and every `sync_required`, fetch
identity, contacts, and the selected conversation in parallel.

## 10. Races, duplicates, and failure behavior

- **Duplicate receipt event:** refetch; monotonic durable projection is unchanged.
- **Read before delivered observation:** durable `read` wins and displays as read.
- **Event before REST commit is visible:** the inspected actor emits its local
  notification immediately before the following state save in the same action
  list. A browser can therefore race the REST projection. For a message event,
  refetch until its wire ID appears; for a receipt event, refetch until every
  named row reaches at least that kind. Use bounded backoff (0, 100, 400, and
  1,000 ms), cancel when the selected CID changes, then leave convergence to the
  next sync/user action. Never patch canonical state directly from the event.
- **Browser reconnect:** first event is `sync_required`; rebuild from REST.
- **Daemon watcher gap:** upstream reconnect produces `sync_required`; rebuild
  from durable MUFL state.
- **Multiple browser tabs:** duplicate read POSTs are harmless; only the first
  MUFL transition sends wire IDs. Each tab independently enforces visibility.
- **Contact rename:** CID correlation survives; refresh the display name.
- **Send succeeds but response is lost:** reload/refetch reveals the history row.
  Do not automatically retry a send without an idempotency key, because that can
  create a duplicate message.
- **SSE unavailable:** the UI shows a reconnecting indicator and remains usable
  through explicit refresh/open/send operations; it does not claim live status.
- **Malformed/unknown event:** log metadata safely, issue a generic sync hint, and
  continue. Never log message content or credentials.

## 11. Compatibility and rollout gates

- A peer without receipt capabilities continues to exchange messages. Its
  outbound rows remain `sent`; the UI does not show an error or fabricate a
  delivery state.
- An old history row with empty `wire_id` remains readable but cannot gain a
  receipt and is not a stable page cursor.
- Existing stored packet history and its receipt map remain part of the actor's
  state. Moving an identity into messenger uses the explicit offline `migrate`
  command, which backs up and byte-verifies the complete SDK state rather than
  translating or partially recreating actor fields.
- Keep `keep_history` and `readvertiseOnUpgrade`; the receipt receive capability
  must be advertised after deployment.
- Pin the messenger server to the first published SDK/actor release that provides
  the event contract in section 5. The checked-in manifest/lock remain at
  `@ours.network/sdk@1.0.1`; local SDK head `d357bb7…` is development evidence,
  not a release pin. Receipt PR #16 is merged and signal-ownership PR #17 is
  awaiting CI/release, but no published release contains both contracts.
- SDK daemon embedding needs `DaemonOptions.handleSignals?: boolean` (default
  true, messenger passes false). The current SDK unconditionally registers
  SIGINT/SIGTERM handlers whose shutdown calls `process.exit(0)`, preventing the
  host from owning signal shutdown order. Programmatic `DaemonHandle.close()` is
  usable; publication remains blocked until the option exists.
- REST additions and event fields are additive. Existing clients, CLI usage, and
  push subscriptions continue to operate.

Lifecycle adds two owner-only provenance records at the messenger state root:
`initialization.json` pins the explicitly created Human/root name and CID, while
`migration.json` records explicit source/backup paths and matching content
manifests. Neither record contains actor secrets or conversation content.

## 12. File-level implementation map

### SDK/actor prerequisite (separate package/repository)

| File | Change |
| --- | --- |
| `src/boot-env.ts` | Fix owned config/state/broker/port/auth before the first dynamic SDK import; ignore ambient ours selection. |
| `src/daemon.ts` | Start/close the SDK daemon without MCP, retain the internal owner token only in `OursClient`, and bind (never bootstrap) the configured identity. |
| `src/lifecycle.ts` | Gate empty serve read-only; perform confirmed offline Human/root initialization and byte-complete, backed-up migration with provenance receipts. |
| `mufl_code/actor.mu` or the package's messenger actor source | Add authenticated `sender_id` and `wire_id` to `message_received`; add `sender_id`, `wire_ids`, and available timestamp to `receipt_received`. Preserve body-free notifications. |
| `src/mufl/handlers.ts` | Recognize and persist normalized `receipt_received`; preserve new message metadata; safely pass unknown events. |
| `src/events.ts` | Export the expanded discriminated union and receipt kind. |
| SDK actor/notification tests | Prove authentication, metadata, redaction, duplicates, and old-field tolerance. |

Exact SDK paths should be confirmed in its source checkout; the inspected package
exposes the corresponding compiled declarations under `dist/mufl/handlers.d.ts`
and `dist/events.d.ts`.

### This repository

| File | Change |
| --- | --- |
| `package.json`, lockfile, `vite.config.ts` | Pin the fixed SDK and React 18/Vite client toolchain. Keep server/test entry points compatible. |
| `src/watch.ts` | Generalize the single reconnecting watcher into a normalized event bridge with abort, backoff, overflow sync, and the existing push subscriber. |
| `src/events.ts` (new) | Define internal event union and bounded SSE subscriber fan-out. No durable state. |
| `src/api.ts` | Add `GET /api/events`, SSE lifecycle/heartbeat, and static-app fallback after all `/api/*` routes. Preserve existing route guards. |
| `src/server.ts` | Construct one event bridge, inject it into API/push, and close it during shutdown. Serve the built client in production. |
| `src/conversation.ts` | No receipt persistence change. Export projection helpers only if needed by API tests. |
| `tests/events.test.mjs` (new) | Unit-test normalization, fan-out, overflow, disconnect, reconnect sync, and redaction. |
| `tests/sse-e2e.test.mjs` (new) | Exercise live message/receipt events against two real identities plus snapshot recovery. |
| `tests/receipts.test.mjs` | Extend only for any new event assertions; retain exact-once and monotonic cases. |
| `web/index.html` (new) | Client entry document. |
| `web/src/main.tsx`, `web/src/App.tsx` (new) | Bootstrap, snapshot coordination, selected-contact routing, connection indicator. |
| `web/src/api.ts`, `web/src/events.ts`, `web/src/types.ts` (new) | Typed REST client, EventSource invalidation handling, shared view types. |
| `web/src/readGate.ts` (new) | Pure exact-dialog predicate and per-CID read coalescer. |
| `web/src/components/ContactList.tsx` (new) | Search/list/unread badges and mobile selection. |
| `web/src/components/Conversation.tsx`, `MessageReceipt.tsx`, `Composer.tsx` (new) | Thread, receipt marks, send/reply flow. |
| `web/src/components/IdentityHeader.tsx`, `InviteDialog.tsx` (new) | Bound identity and minimal contact/invite actions. |
| `web/src/styles.css` (new) | Messenger-only responsive visual system derived from the control-plane reference. |
| `web/tests/api.test.ts`, `router-store.test.ts`, `components.test.tsx`, `read-gate.test.ts` (new) | Typed client intent headers/no-store behavior, route and identity scoping, safe React rendering, and exact-visible read/coalescing tests. |
| `web/e2e/receipts.spec.ts` (new) | Browser exact-dialog, visibility, mobile, and reconnect acceptance. |

The phase-1 client uses React 18 with Vite. It keeps one read gate and one
authoritative REST state path; EventSource events remain invalidation hints only.

## 13. Implementation sequence

1. Isolate and start the messenger-owned SDK runtime, with lifecycle rollback,
   dynamic loopback port, owner token auth, and `/mcp` 404.
2. Patch actor notification payloads and SDK host handling; release and pin the
   SDK. Run SDK actor tests before production acceptance.
3. Add the in-process normalized event bridge and server SSE endpoint. Retain the
   current push subscriber and reconnect bounds.
4. Add server SSE unit/end-to-end tests, including forced watcher interruption and
   snapshot recovery.
5. Build the messenger-only shell and REST snapshot layer.
6. Implement the pure read gate and receipt rendering, then connect SSE only as an
   invalidation source.
7. Add browser acceptance tests at desktop and mobile widths.
8. Validate against the owned runtime on the released SDK. Only then describe
   receipt updates as production-ready in deployment documentation.

This order prevents UI polling or event-local state from becoming a workaround for
the missing SDK event path.

## 14. Executable acceptance tests

### Existing regression suite

```bash
npm ci --ignore-scripts
npm test
```

Expected baseline: all 93 current checks pass, including receipt exact-once,
monotonic merge, non-consuming GET, paging, route guards, bundle, and E2E cases.

### SDK local-event contract

Against two identities A and B:

1. Start `watchNotifications(A)` and `watchNotifications(B)` before sending.
2. A sends one message to B; capture its authoritative `wire_id`.
3. Assert B observes one `message_received` with A's CID and that `wire_id`, and
   the record contains no body.
4. Assert A observes `receipt_received(kind=delivered)` from B with that wire ID.
5. B calls `markRead(A)`; assert A observes `kind=read` with that wire ID.
6. B calls `markRead(A)` again; assert marked count is zero and no second wire
   read action/event is produced.
7. Inject duplicate and delivered-after-read callbacks; assert projection remains
   read.

### Server SSE E2E

Add an SSE parser helper to the existing harness, then:

1. Connect `/api/events`; assert the first event is `sync_required` for the bound
   identity.
2. Send peer → server identity; assert `message_received` contains peer CID and
   wire ID, then GET the page and observe the unread inbound row.
3. Send server identity → peer; assert the outbound row first renders sent and an
   authenticated delivered event causes the REST projection to become delivered.
4. Mark on the peer; assert a read event arrives and REST projects read without
   polling.
5. Assert all SSE payloads omit text, invite secrets, and file data.
6. Force the upstream watcher to fail and reconnect; assert
   `daemon_reconnected`, refetch, and recover messages/receipts created in the
   gap.
7. Overflow a deliberately tiny test queue; assert one `overflow` sync event and
   correct REST recovery.

### Browser exact-dialog matrix

Use contacts A and B and instrument read POSTs:

| Situation | Required result |
| --- | --- |
| Contact list visible, no dialog | Incoming A remains unread; A sees delivered, not read. |
| B dialog visible | Incoming A remains unread; no `POST /A/read`. |
| User opens A | Page is fetched, then exactly A is marked; A sees read. |
| A dialog visible | New A message is refreshed and marked read. |
| Tab hidden with A selected | New A message remains unread until visibility returns. |
| Mobile list open with A selected in state | A remains unread until detail opens. |
| Covering dialog over A | A remains unread until the dialog closes and A is visible. |
| Duplicate SSE events/two tabs | State does not regress; duplicate read calls mark zero. |
| SSE disconnect during receipt | Reconnect sync + REST snapshot shows correct receipt. |
| Legacy peer/no receipt capability | Message remains sent with no failure treatment. |

Also assert receipt accessibility labels (`Sent`, `Delivered`, `Read`), keyboard
navigation, focus restoration when mobile detail closes, and a reduced-motion
variant for the sliding pane.

## 15. Completion criteria

The implementation is complete only when:

- remote senders receive read only after the local exact contact dialog is
  visible;
- local outbound rows move to delivered/read as authenticated receipt events
  arrive, without interval polling;
- reconnects and event loss converge from durable REST state;
- old/no-capability peers remain usable and visually stay at sent;
- event/log payloads contain identifiers but no message bodies;
- the frontend contains no monitoring, notification, backup, cluster, or service
  control surface;
- all current tests and the new SDK, lifecycle/isolation, SSE, and browser
  matrices pass against the messenger-owned runtime on a published SDK.

## 16. Owned runtime lifecycle contract

`src/boot-env.ts` runs before the dynamic SDK imports and forces a dedicated
`<messenger-state>/runtime` state dir, isolated config path, explicit broker,
port `0`, owner visibility, and no ambient API token. `src/daemon.ts` then calls
`startDaemon({ version })` without `mcp`, reads the freshly minted private token,
and creates `OursClient` against `127.0.0.1:<handle.port>`.

An OS-held advisory `flock` is acquired on `.messenger-runtime.lock` before SDK
import, so concurrent processes cannot reuse one state directory. The persistent
inode and its PID JSON are diagnostic only. Ownership is the open descriptor:
close/rollback, `SIGKILL`, and reboot release it automatically, while PID reuse
or edited/stale record text cannot steal a live lock.

`src/server.ts` rolls back every completed stage on failure. Shutdown stops the
public HTTP surface first, then the notification watcher/event fan-out, releases
the identity lease while the runtime is alive, and finally closes the SDK daemon.
The same close path is idempotent. `tests/state-dir-isolation.test.mjs` exercises
normal close and a bind failure after runtime startup; both lifecycle paths must
leave no listening server handles or held advisory lock. Signal-listener ownership is
covered by the separate SDK blocker.

The remaining signal-order acceptance is
`tests/sdk-signal-ownership.blocker.test.mjs`. It fails deterministically while
the pinned SDK declaration lacks `handleSignals?: boolean`; once present it requires
messenger to pass `handleSignals: false`. Messenger must not remove SDK listeners
as a workaround.
