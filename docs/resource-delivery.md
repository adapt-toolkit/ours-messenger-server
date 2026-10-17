# Messenger resource delivery v1

This protocol adds passive full resource delivery to the existing single-identity
Messenger service. It does not authenticate browsers. The external gateway and
private backend boundary retain their existing authentication/expiry ownership.
All admitted callers share the configured identity authority. Connection IDs are
transport handles, not credentials. SDK daemon authorization remains unchanged.

A compatible release of the SDK committed resource API and daemon is required.
Use the published dependencies pinned in package.json and package-lock.json,
and the matching published daemon runtime for integration checks. Early local
qualification used a no-save/no-lock SDK pack; that historical setup has been
superseded by the committed published dependency pins. A build against a
pre-resource SDK cannot supply the required declarations or runtime methods.

## Connection and controls

Open one fetch-SSE `GET /api/events?resources=1` per service/workspace/tab. Existing
unnegotiated `/api/events` keeps its metadata-only compatibility behavior.
The first record is:

```ts
// event: resource-connection
{
  protocolVersion: 1,
  connectionId: string,
  producerGeneration: string, // Messenger service lifetime
  identityCid: string,        // configured server-owned identity
  baselineRequired: true,
  continuity: 'reset'
}
```

Every new transport requires a canonical baseline. There is no resource replay
ledger; old/unknown cursors and upstream replacement cannot authorize resume.
Do not compare view revisions across epochs/connections. Fence callbacks by the
local transport attempt even if the service generation is unchanged.

`POST /api/resource-subscriptions` takes
`{connectionId, viewId, subscriptionEpoch, descriptor}` and returns
`{subscriptionEpoch, baselineId}` after installing the view under the existing
committed source observer. All controls preserve the existing exact Origin,
`Content-Type: application/json` and `X-Ours-Messenger-CSRF: 1` requirements.
Control abort retires an incomplete candidate. Buffer early SSE frames until the
response validates their epoch/baseline binding.

`DELETE /api/resource-subscriptions` takes
`{connectionId, viewId, subscriptionEpoch}`. It is idempotent for missing/older
epochs; a future unknown epoch rejects. Replacement requires a strictly newer
epoch, including after DELETE. Unrelated views retain their own epochs.

The exported `ResourceDescriptor` shape is:

```ts
interface ResourceDescriptor {
  viewId: string; // 1..128 ASCII letters/digits/_/-
  resource: 'contacts' | 'identity' | 'messages' | 'files' | 'commands';
  entityId?: string; // existing read's contact identifier/name, required for peer views
  window?: {
    limit: number; // messages only, existing read limit 1..200; default 50
    retainedPages: number; // positive safe integer; default 1
    oldestSequence?: number; // positive inclusive loaded-history lower bound
  };
}
```

No arbitrary paths, filter/sort queries or extra keys are accepted. The current
canonical reads expose no filter/sort parameters. Typed-command disabled mode
rejects catalog registration with the existing 404 behavior. Peer identifiers
remain data; they are resolved exactly as by existing HTTP reads.

After older-page HTTP loading, replace the descriptor with a new epoch and its
extended inclusive `oldestSequence`. The bound message baseline supplies its
oldest sequence. A non-exhausted older HTTP page's numeric `nextBefore` is its
oldest included sequence; an exhausted page can extend to sequence 1 (origin).
An explicit lower bound keeps older loaded IDs subscribed while new arrivals
grow the view. Without it, retainedPages describes a moving latest N-page window.
All capture/output work remains subject to byte budgets rather than a new page
count cap.

## Bound initial HTTP read

Complete registration before the initial read, then send all four headers:
`X-Resource-Connection`, `X-Resource-View`, `X-Resource-Epoch`,
`X-Resource-Baseline`. The route/entity/query must match the descriptor:

| Resource | Existing read |
| --- | --- |
| contacts | `/api/contacts` |
| identity | `/api/identity` |
| messages | `/api/conversations/:contact/page` (`limit` may match descriptor) |
| files | `/api/conversations/:contact/files` |
| commands | `/api/contacts/:contact/commands` |

The canonical JSON body and SSE baseline share one registered capture, never two
unrelated reads. Message bodies add `oldestSequence` to the canonical
ConversationPage. Response headers echo the four bindings and add
`X-Resource-Producer`, `X-Resource-Revision`, `X-Resource-Source-Generation`,
`X-Resource-Source-Position`. Missing/retired/mismatched bindings reject; an
unbound legacy GET remains provisional. Neither these headers nor connectionId
create authorization.

## Frames and atomic application

The exact exported `ResourceEnvelope` discriminated union in
`src/resource-views.ts` carries common fields:
`{protocolVersion:1, producerGeneration, subscriptionEpoch, viewId, sequence,
revision, baselineId?, kind, payload}`. `sequence` orders this view's frames;
`revision` increments only for canonical data changes. Ready/coverage/health can
retain a data revision; do not discard them merely because that revision equals
the last data revision. Repeated/stale **data** revisions cannot overwrite newer
state. The current server tags every view frame with baselineId.

- `snapshot`: complete canonical response. Initial message snapshot is
  `MessageResourceSnapshot` (ConversationPage plus `oldestSequence`). Other
  resources use their existing HTTP serializers, redaction and ordering.
- `upsert`: exported `MessageResourceDelta`, one atomic logical change:
  `{type:'message-delta', upserts:[{id,item}], deletes:[id], window}`. Each item is
  the full canonical ConversationMessage. `window` contains canonical page
  metadata plus `oldestSequence` and `orderedIds`, excluding `messages`.
  Commit upserts, actual tombstones and ordering together. IDs absent from
  orderedIds leave this view; that alone is **not deletion**. `deletes` are actual
  source absences, checked within the producer-position capture fence. Initial
  baselines with missing/duplicate stable IDs explicitly degrade.
- `delete`: reserved typed single tombstone `{id, revision}`. Current message
  delivery groups explicit tombstones in the atomic `upsert` delta above.
- `ready`: `{baselineId, source}`. Only a completed snapshot/assembly and matching
  ready establish the authoritative baseline. Apply buffered later frames in
  order. The initial GET may render provisionally; it does not establish health.
- `coverage`: `{source}`. Certifies this view's completed projection at the SDK
  source generation/position, not notification acknowledgement or ACP revisions.
- `resync`: `{reason:'capacity'|'projection_unavailable'}` retires that view's
  healthy delivery; replace its epoch for bounded scoped recovery/fallback.
- `health`: `{healthy:false, reason:'auth_required'|'unsupported'|'upstream_unavailable'}`
  retires health and closes the connection. Before a view exists, the same
  semantic failure is `event: resource-service-health` with protocolVersion,
  connectionId, producerGeneration, healthy:false and reason.

`source` is SDK `IdentityResourcePosition`:
`{protocolVersion:1, producerGeneration, position}`. It belongs to the daemon's
committed source lifetime; never compare it with Messenger view revisions,
notification revision or ACP ledger positions. Source observation is installed
before capture; R0/projection/R1 must match, including local profile revision,
within three attempts. Captures are serialized per connection. Later committed
wakes refresh canonical projections; idle coverage performs no content or source
position reads. Unchanged projections coalesce before assigning a data revision.

## Chunking, bounds and ownership

Ordinary records fitting 512 KiB encoded SSE stay `event: resource`. Larger
records up to 16 MiB logical encoded JSON use `event: resource-chunk`:

```ts
// Every chunk frame repeats protocolVersion, id, producerGeneration, viewId,
// subscriptionEpoch, revision, sequence.
{ type: 'start', totalBytes: number, parts: number }
{ type: 'chunk', index: number, data: string /* base64 bytes; ordered from 0 */ }
{ type: 'commit', totalBytes: number }
```

Decode base64 bytes, validate binding/order/total/part count, decode UTF-8 and parse
one complete ResourceEnvelope only after commit. Chunk IDs are local to the
fenced connection. Do not publish partial assemblies. One active assembly owns
the 16 MiB budget; waiting live output owns an independent 8 MiB budget. The
writer waits for drain between chunks, so a valid >8 MiB record is never queued
whole against the smaller pending budget. Overflow closes explicitly; it never
silently drops data. Serialized capture prevents concurrent large assemblies.
Metadata/history pagination also bounds its canonical accumulation.

SDK coverage arrives every two seconds. The SDK's six-second upstream silence
policy and elapsed-before-accept checks govern source health; browser bytes do
not renew it. The browser must enforce its independent fixed ten-second
opening-to-complete-ready and established byte-silence budgets, resume checks,
epoch fences, bounded recovery and capacity fallback. Complete ready stops its
fallback content reader. Hidden/disposed views DELETE their owned epochs; stream
abort disposes every view, profile observer, SDK iterator and writer drain wait.
No presence, controller, read receipt or push is acquired by this protocol.

Initial/older history/file bytes/recovery HTTP and explicit commands remain.
Healthy payload events require no follow-up GET.

## Source-to-browser qualification

The matching App fixture uses separate real SDK RPC and remote writers, this service's public routes and Chromium against the built App. `RESOURCE_QUALIFY_IDLE_MS=60000` extends its measured healthy window; it checks zero periodic browser content reads and zero mandatory event follow-up reads, while recording backend canonical read traffic separately. File bytes remain on demand and user commands/read marking remain HTTP. This proves the explicitly exercised contact/message/file/catalog paths, not all room, hosted-gateway or installed-release combinations. Reuse an existing qualified native daemon artifact; this qualification does not require native compilation.

## Daemon integration check

Run `npm run test:resource-daemon` with `OURS_RESOURCE_TEST_DAEMON_RUNTIME` set
to the absolute `dist/runtime` directory of the installed published daemon.
This opt-in check starts an isolated local daemon and HTTP server; it is separate
from offline tests. Use the dependency versions pinned by this repository.
