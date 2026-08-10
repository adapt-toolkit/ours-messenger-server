# @ours.network/messenger-server

A self-hosted messenger **backend** for ours.network. It attaches to a running
ours daemon, exposes a REST API for a frontend, and sends WebPush from this host
the moment a message lands in the packet.

It exists to split the current `ours-control-plane` so that **the node stops being
a browser tab**. The packet keeps the full state, as before — now on a server. The
daemon is shared, and so is the main actor.

---

## Read this before the green checks

Three things about this build are **not proven**, and they are here rather than at
the bottom because a reader who stops halfway should still have met them.

### 1. The daemon is NOT proven to be shared. Status: UNKNOWN.

The acceptance criterion was: *a second client on a different lease token sees the
identity and reports it held by another live session.* **That test did not run, and
its result is neither green nor red.**

No published ours daemon serves the SDK's typed operation surface. Every
`OursClient` operation is `POST /api/v1/<op>`, and against the daemon running on
this host it returns 404:

```
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H "x-ours-api-token: $(cat ~/.ours/daemon-token)" \
    -H 'x-ours-lease-token: probe' -H 'x-ours-client-pid: 1' \
    -H 'content-type: application/json' -d '{}' \
    http://127.0.0.1:3050/api/v1/currentIdentity
404
```

Measured, not inferred:

| what | measurement |
| --- | --- |
| live daemon | `@ours.network/mcp/dist/cli.js serve`, up since 2026-08-07, predates the split |
| installed ours-mcp | 0.16.0; does **not** depend on `@ours.network/sdk` |
| `grep -r 'api/v1' ours-mcp/dist` | **0 hits** |
| `npm view @ours.network/mcp` latest | 0.16.0 — same as installed |
| nightly `0.16.0-nightly.1`, installed and grepped | **0 hits** |

So the shared daemon speaks the old surface and the SDK client speaks the new one.
The lease check 404s before it ever reaches lease logic, which is why the result is
UNKNOWN rather than a failure.

**What would prove it.** `ours-mcp` PR #50 puts ours-mcp on the SDK and makes the
daemon serve `/api/v1`. Once that merges and is deployed, run:

```js
const observer = new OursClient({ url, leaseToken: 'a-different-session' })
const rows = await observer.listIdentities()
rows.find(r => r.name === MY_IDENTITY).session === 'other-live'   // <- the proof
```

Not one line of `src/` changes when that lands. `OursClient` is the only seam.

### 2. The production path attaches; only the TEST HARNESS hosts a daemon.

`src/` contains no `startDaemon` and no `@ours.network/sdk/daemon` import, and
`tests/no-engine.test.mjs` asserts that against **both** `src/` and the built
bundle. `tests/harness.mjs` starts a short-lived daemon on an isolated temp state
directory — the same thing ours-mcp's and ours-tg-connector's own suites do — so
the suite never touches an operator's `~/.ours`. That is a test fixture, not the
architecture.

### 3. Not covered

Named, rather than left to be inferred from absence:

- **Real-token redaction on `/api/state`.** The harness daemon runs
  `apiVisibility: open` with no token, so the test reads the *shape* (provenance
  reported, no token value key) and cannot prove a real token is withheld.
- **Push unit tests.** There is one end-to-end push assertion (below) and no unit
  coverage of `PushStore` — VAPID persistence across restart, the 404/410 prune
  path, and the half-supplied-key-pair error are unexercised.
- **Multi-device push.** One subscription is exercised. Fan-out to several devices,
  and partial failure across them, are not.
- **`sendFile` / the file routes.** Wired and typechecked, not exercised end to end.
- **Reconnection.** The watcher's backoff-and-resume loop is not tested against a
  daemon that goes away mid-stream.
- **Load.** No concurrency or throughput testing of any kind.

---

## What IS proven

`npm test` — 93 checks. Every counterfactual below was **actually run**: the guard
was broken, watched to fail, and restored.

| suite | checks | what it reads |
| --- | ---: | --- |
| `receipts` | 18 | the read-receipt design, plus the hazard demonstrated live |
| `rest-e2e` | 38 | the REST surface and a real signed push, on the wire |
| `conversation-page` | 18 | paging, cursors, monotonic receipt merge |
| `bundle-smoke` | 7 | **runs** the shipped artefact |
| `no-engine` | 7 | no `startDaemon` in `src/` or the bundle |
| `state-dir-isolation` | 5 | we never write into the daemon's state dir |

### The read-receipt design

This is the part the owner asked us to get right, so that both UXes survive.

**DELIVERED and READ are two different receipts from two different mechanisms.**
The core emits *delivered* at the receive choke point the moment a message lands.
*Read* comes only from `markRead`. One tick versus two ticks in a UI **is** this
distinction, and it is measured as two separate mechanisms, not asserted in a
comment.

The frontend reads a conversation through the **non-consuming** path and calls
`markRead` **explicitly** when a human actually sees it. Receipts fire on that
transition, exact-once: a second `markRead` marks 0 and sends nothing, because the
transition is the event, not the call.

**`getMessages` is not on this REST surface.** It is the consuming agent path —
it hands messages over and emits a read receipt on the way past. A frontend polling
it would silently tell every peer that a human had read messages nobody looked at.
The hazard is removed at the surface rather than warned about in a docstring, and
`rest-e2e` proves four plausible paths for it all return 404. The agent path itself
is **unchanged** and still reached through ours-mcp; it is simply not ours.

The counterfactual is run, not described. `receipts.test.mjs` §5 reads a message
through `getMessages` and confirms the peer then sees a read receipt for a message
no human saw. If a future edit routes the REST read path through `getMessages`, §3
goes red **and** §5 stops being a counterfactual — they are wired to fail together.

> **On what the gate reads.** "No read receipt" is deliberately *not* asserted as
> `receipts == {}`. An empty map is also what a wrong contact name, a broken link,
> or history-switched-off returns — that assertion would stay green forever while
> measuring nothing. It instead requires DELIVERED to be **present** for exactly
> the wire_ids in play and only READ to be absent.

### WebPush

Server-side, with no MUFL in it, and **`ours-notifications` is not used at all**.
The browser subscribes and POSTs its `{endpoint, keys}` to this server; this server
stores it, signs with VAPID, and POSTs to the endpoint. Standard WebPush
application-server role, nothing else. The whole `a2a_notifications` surface —
handout ledger, token issue/rotate/revoke, five hooks — is absent: it existed
because a browser node had to hand tokens to a third party, and a server does not.

**Push payloads carry sender and count, never message text.** The trigger is the
daemon's own `watchNotifications` stream, which is non-consuming *and* content-free
— so the push path structurally cannot emit a receipt or leak a message body. The
end-to-end test asserts the text appears nowhere in the request. Previews are a
product decision and were deliberately **not** built.

---

## Stated assumption — retention

**Messenger identities KEEP history; agent identities GC as today.** A conversation
is permanent to a human. It is implemented as a per-identity policy
(`setConversationPolicy`), so changing it is config, not a rewrite:
`OURS_MESSENGER_KEEP_HISTORY=false` runs this server against an identity that
should behave like an agent.

Enabling history also starts advertising `core.receipts.receive`, and existing
contacts do not learn that until the next outbound message. The server therefore
calls `readvertiseOnUpgrade` after enabling — a *send*, deliberately not folded
into the state write by the SDK. Without it, conversations with old contacts show
no ticks for no visible reason.

## There is no authentication

Auth is an explicitly later layer and none was invented. The server binds
`127.0.0.1` by default. A non-loopback bind logs a warning naming the consequence:
anyone who can reach the port can read every conversation and send as this
identity. Put a reverse proxy with auth in front of it.

---

## Running it

```bash
npm install && npm run build
OURS_MESSENGER_IDENTITY=Me \
OURS_MESSENGER_DAEMON_STATE_DIR=~/.ours \
  node dist/cli.js serve
```

`node dist/cli.js --help` lists every variable. The daemon-selection inputs are
handed **verbatim** to the SDK's `resolveDaemonConfig`, whose precedence mirrors the
daemon's own resolver, so a shell cannot select one daemon for `ours` and another
for this server. No defaults are invented on top of it.

### A note on `OURS_STATE_DIR`

Importing `@ours.network/sdk` — even for `OursClient` alone — runs module-load code
that reads the resolved state directory, enumerates persisted identity names, and
writes `daemon-token` and `startup-progress.json`. Unset, that directory is
`~/.ours`: **the live daemon's own**. Confirmed on this host — the import rewrote
`~/.ours/startup-progress.json`.

`src/boot-env.ts` points `OURS_STATE_DIR` at *our* state directory before the first
SDK import; which daemon we attach to stays a separate, explicit selection.
`tests/state-dir-isolation.test.mjs` runs the real entrypoint against a decoy
daemon directory and requires it to come back byte-for-byte untouched.

It does **not** clobber an existing `daemon-token`, and no native addon loads — so
this is a state-directory side effect, not a second engine in the process. The real
fix is an SDK one (an engine-free client entrypoint); this is the consumer-side
mitigation until it lands.

---

## Surface

~32 routes, all under `/api/`. The messaging half of what the browser calls today,
plus the push-subscription endpoint. Full list: `src/api.ts`.

The fleet/control-plane methods (`sendControl`, `manageRoot`, `listManagedRoots`,
`disableMonitoring`) are the surface being **dismantled** and are not ported.

### Mapping from the old browser surface

The next person reading the old surface will look for these four names. They are
naming mismatches, not gaps:

| old name | here |
| --- | --- |
| `listPendingInvites` | `GET /api/invites` → `listInvites` |
| `listContactRoots` | `GET /api/contacts/roots` → `listContacts().roots` |
| `getProfileName` | `GET /api/identity` → `currentIdentity()` |
| `introduce` | **responder side only.** `respondToIntroduction` exists; there is no initiator-side `introduce` anywhere in the SDK or the daemon. Noted, not built. |

### Two real SDK gaps

Neither is worked around here; both are solved at the SDK level, per standing rule.

1. **No engine-free client entrypoint.** The package exports only `.`, `./daemon`
   and `./connector`, and the root barrel re-exports the daemon-side operation
   implementations next to the client — so importing `OursClient` drags them in and
   runs their module-load code (see above). Every pure-client consumer writes into
   a directory it does not own. It also puts ~2.1 MB of engine code into a bundle
   that never runs it.
2. **`setMyName`.** No operation writes the bound identity's own display name.
   `renameContact` renames a *contact*; `setBio`/`setPersona` do not touch the name.

---

## Notes

- **Engine teardown prints `Total leaks: 1 — AdaptPacketContext`** when the harness
  daemon closes. Already characterised: allocated inside `@adapt-toolkit`'s own
  protocol init, unreachable from our code, **bounded at one per process** across
  100 observed occurrences. A teardown-accounting artefact, fixed-size, does not
  grow with work. This server's own process has no engine in it at all.
- **`npm run build` can exit 0 on an artefact Node cannot parse.** It did. An
  esbuild banner is raw text injected *after* bundling, so the renamer never sees
  its identifiers; a collision with a bundled dependency's `createRequire` import
  is invisible to every static check. `tests/bundle-smoke.test.mjs` runs the
  artefact, which is the only check that caught it.
