# Fleet mock → backend API gap inventory

Audit date: 2026-09-17. UI baseline: `339241d`, [PR #63](https://github.com/adapt-toolkit/ours-messenger-server/pull/63). This is an implementation inventory and proposed contract, not a claim that the proposed routes exist. No backend endpoints were implemented during this audit.

## Scope and evidence

The inventory covers the mock's Sessions, Messenger, tasks, rooms, invitations/admission, profiles, configuration, host folders, onboarding and notification flows. Navigation, theme switching, local drafts, copying a code, and QR scanning do not themselves need new backend endpoints.

Inspected repositories:

| Repository | HEAD at audit | Source status |
| --- | --- | --- |
| ours-messenger-server | `339241d` | Clean implementation baseline; documentation added afterward |
| ours-fleet | `cbbd8ea45032ff503dfebc68d75d68b681bb030b` | Worktree has existing changes, including task-room-service/config; findings about those files describe the local worktree, not necessarily committed HEAD |
| ours-cowork | `c9cb97dc27e70e48ba72a43c91fec0ff3acb9ca4` | Tracked source clean; unrelated debug directory excluded |

Primary evidence (line numbers refer to the inspected files):

- **F1**: ours-fleet `src/web/server.ts:111–600`: complete registered browser API; [committed source](https://github.com/adapt-toolkit/ours-fleet/blob/cbbd8ea45032ff503dfebc68d75d68b681bb030b/src/web/server.ts).
- **F2**: ours-fleet `src/web/fleet-config-service.ts:211–267`: editable-model projection, exact allowed keys, and preservation of preset files; [source](https://github.com/adapt-toolkit/ours-fleet/blob/cbbd8ea45032ff503dfebc68d75d68b681bb030b/src/web/fleet-config-service.ts).
- **F3**: ours-fleet `src/application/role-creation-service.ts:28–100,224–280`: creation request and capabilities; [source](https://github.com/adapt-toolkit/ours-fleet/blob/cbbd8ea45032ff503dfebc68d75d68b681bb030b/src/application/role-creation-service.ts).
- **F4**: ours-fleet **local worktree** `src/application/task-room-service.ts:185–365,463–535,587–680,752–790`: task transitions, templates and room queries/orchestration. This file is modified relative to the recorded HEAD; HTTP availability is determined by F1, not by the presence of these methods.
- **F5**: ours-fleet `src/web/events.ts:1–37`: in-memory event bus/replay and `resync.required`; [source](https://github.com/adapt-toolkit/ours-fleet/blob/cbbd8ea45032ff503dfebc68d75d68b681bb030b/src/web/events.ts).
- **M1**: messenger-server `src/api.ts:482–896`: registered REST/SSE routes and payload adapters; [source](https://github.com/adapt-toolkit/ours-messenger-server/blob/339241d/src/api.ts).
- **M2**: messenger-server `src/api.ts:1–20`: non-consuming history vs explicit human-read contract. Do not replace this with consuming agent inbox reads.
- **C1**: ours-cowork `src/transports.ts:161–260,421–481`: public/private RPC dispatch tables and loopback HTTP handler; [source](https://github.com/adapt-toolkit/ours-cowork/blob/c9cb97dc27e70e48ba72a43c91fec0ff3acb9ca4/src/transports.ts).
- **C2**: ours-cowork `src/openapi.ts:84–368`: per-method schemas; [source](https://github.com/adapt-toolkit/ours-cowork/blob/c9cb97dc27e70e48ba72a43c91fec0ff3acb9ca4/src/openapi.ts). The dispatcher is authoritative; the header's count of methods is stale.
- **U1**: UI flows in `web/src/fleet/FleetDialogs.tsx`, `FleetApp.tsx`, `Configuration.tsx`, `FolderPicker.tsx`, `Notifications.tsx`, `pages.tsx`.

## Ownership and the no-direct-SDK boundary

The browser must use server HTTP/event APIs, never direct `ours-sdk` or daemon identity switching. Existing backend internals may use their current SDK integration; that does not require the frontend to depend on it.

- **Messenger Server** owns the bound human identity's contact conversations, messages/files, receipts and invitations.
- **Fleet** owns managed-agent identity operations, agent runtime sessions, tasks, agent membership orchestration, configuration and host folders. **Generating an invite for an agent must call a Fleet endpoint.** Human-bound Messenger `POST /api/invites` is not an acceptable substitute.
- **Cowork** owns room metadata, participants, room invites, role briefings, room history and room-authored messages. Fleet should provide the authenticated browser-facing facade for managed rooms and orchestrate its agents through Cowork server-side.
- Use a same-origin authenticated gateway or reverse proxy to these services. Existing endpoints do not automatically provide a unified browser session. In particular, Cowork's loopback RPC/origin restrictions are not a multi-user browser authorization layer; its `auth: true` route marker is not evidence of a browser login check. Do not expose that port directly as a shortcut.

Fleet's current `/roles/:id` routes refer to **runtime agents/sessions**, while configuration `roles` are reusable behavior definitions. Keep these concepts distinct in API types even if compatibility requires retaining the existing URLs.

## Existing API that should be reused

| UI operation | Existing server surface | Integration notes |
| --- | --- | --- |
| Session list/detail and lifecycle | Fleet `GET /api/v1/roles`, `GET /api/v1/roles/:id`, `POST /api/v1/roles/:id/actions`, `GET /api/v1/actions/:actionId` | Actions currently allow start/stop/restart_resume/restart_fresh. Adapt runtime records to UI; do not invent another agent lifecycle engine. F1 |
| Create persistent/temporary agent | Fleet `GET /api/v1/creation-capabilities`, `POST /api/v1/roles/preview`, `POST /api/v1/roles`, `GET /api/v1/creation-actions/:actionId` | Preview/hash and idempotency already exist. Request takes role/brain selections, not a named agent-template reference. Template-preserving creation is an extension below. F1/F3 |
| Remove managed agent | Fleet `GET /api/v1/roles/:id/removal-preview`, `POST /api/v1/roles/:id/remove` | Reuse confirmation and removal semantics. Removing a task member is a separate coordinated operation. F1 |
| Runtime prompt/output and tool activity | Fleet `GET /api/v1/roles/:id/conversation`, `GET .../output`, `GET .../logs`, `POST .../input`, `POST .../interrupt`, WS `.../conversation-stream` | Runtime ledger is not automatically the same data model as encrypted Messenger history. Capability-gate streams and convert ledger/tool entries into shared UI view models. F1 |
| Runtime permission response | Fleet `POST /api/v1/roles/:id/permissions/:permissionId` | V2 requires commandId, sessionGeneration, optionId. Do not replace this with a generic boolean approval. F1 |
| Task lists and task collection | Fleet `GET/POST /api/v1/task-lists`, `PATCH/DELETE /api/v1/task-lists/:name`, `GET/POST /api/v1/tasks`, `PATCH /api/v1/tasks/:id/list`, `DELETE /api/v1/tasks/:id` | Task creation supports backlog/noRoom/template/list. Delete has asynchronous recovery semantics; retain them. F1 |
| Configuration foundation | Fleet `GET /api/v1/configuration`, `POST .../preview`, `POST .../save` | Existing optimistic revision, preview diff, redactions and write path. Currently model contains **only manifest, agents, agent_templates**. F1/F2 |
| Topology and changes | Fleet `GET /api/v1/topology`, draft GET/PUT and promote preview/commit; `GET /api/v1/events` WS with `POST /api/v1/ws-tickets` | Existing topology is useful evidence; not automatically a notification inbox or complete UI navigation graph. F1/F5 |
| Human Messenger chat | Messenger `GET /api/contacts`, `/api/contacts/roots`, `/api/conversations/:contact`, `/page`, `/receipts`; `POST /api/messages/send`, `/api/conversations/:contact/read` | Reuse reply references, durable history and explicit read behavior. M1/M2 |
| Human contact/invite actions | Messenger `POST /api/contacts/add`, `/remove`, `/rename`, `/introductions`; `GET/POST /api/invites`, `POST /api/invites/revoke` | Introduction response is approve/reject; no initiator-side introduction API is promised. Invite acts as the bound identity. M1 |
| Files/media/commands | Messenger send-file, conversation files, file fetch/stream, media/HTML preview and contact commands/send endpoints | Available for existing Messenger contact transport. Don't label attachments universally missing. M1 |
| Human profile and message events | Messenger `GET /api/identity`, `/api/identities`, `POST /api/identity/bio`, `/persona`, SSE `GET /api/events`, `GET /api/state`, push subscription endpoints | These are not account signup or a fleet-wide notification ledger. M1 |
| Room management backend | Cowork `POST /rpc`: room.create/settings/invite/revoke/list/show/participants/history/message/say/close/delete | Operations exist server-side; managed-room browser integration needs the Fleet facade below. C1/C2 |
| Room role/administrative operations | Cowork RPC room.briefing.role.set/delete, room.participant.remove, room.command.grants/grant/revoke, room.role.rest.add/remove, room.recover/recover.confirm/rebind | Reuse only where the product exposes them and caller authority allows them. C1/C2 |

## Gaps and proposed contracts

All routes in the **Proposed surface** column are proposals. Prefix Fleet paths with `/api/v1`. `Extend` means expand an existing contract; `Facade` means an underlying operation exists but the required browser/actor surface does not; `Missing` means no suitable public operation was found in the inspected dispatch tables. Priorities: P0 for replacing active mock flows, P1 for completing supporting product behavior.

| ID / priority | Flow and classification | Proposed surface | Required behavior / evidence |
| --- | --- | --- | --- |
| F-01 P0 | Agent invite generation/list/revoke — **Missing Fleet facade** | `POST/GET /roles/:id/invites`; `POST /roles/:id/invites/:inviteId/revoke` | Resolve agent→managed identity on server; one_time/public modes; return invite ID/code only after explicit generation; list metadata separately. Validate actor ownership and scope. Fleet has no invite route; Messenger's bound-human route cannot fulfill this. F1/M1 |
| F-02 P0 | Accept invite on behalf of agent — **Missing Fleet facade** | `POST /roles/:id/invite-acceptances/preview`; `POST /roles/:id/invite-acceptances`; `GET /invite-acceptances/:operationId` | Preview target/type, confirm exact actor, idempotent acceptance, distinguish accepted/verification pending/admitted/briefing delivered/failed. Agent choice cannot mutate shared daemon identity binding. Existing generic contact add is human-bound. F1/M1/C1 |
| F-03 P0 | Agent contacts and invitation management — **Missing Fleet facade** | `GET /roles/:id/contacts`; `POST /roles/:id/contacts/:contactId/introduction-response`; `DELETE /roles/:id/contacts/:contactId` | Expose agent-owned contact status, pending approvals and root identity linkage, with no secrets. Reuse backend operations under scoped identity context. F1/M1 |
| F-04 P0 | Role/Brain/RoomTemplate config lists and CRUD — **Extend** | Extend existing configuration GET/preview/save model with `roles`, `brains`, `room_templates` | F2 explicitly rejects these keys and copies their files unchanged. Preserve revision checks, secret redaction, atomic writes and reference validation. Individual per-entity routes are optional, not necessary to unblock UI. |
| F-05 P0 | Harness/model/session/effort choices — **Missing discovery contract** | `GET /configuration/capabilities` (or extend creation-capabilities) | Versioned registered harnesses, session backends, model/effort catalog, custom-model policy, supported option schemas/limits. Current creation-capabilities exposes lifetimes/monitor/bootstrap, not this catalog. Public preset JSON is evidence, not a browser endpoint. F1/F3 |
| F-06 P0 | Create from an Agent Template — **Extend creation** | Add `agentTemplateRef` plus revision/hash and bounded overrides to existing preview/create | Preserve selected template identity and server-resolved snapshot. UI shouldn't duplicate composition or silently convert a template to unrelated free-form selections. Existing role/brain creation remains usable. F3 |
| F-07 P0 | Task detail/start/review/block/unblock/finish/cancel/recover — **Facade over application operations** | `GET /tasks/:id`; `POST /tasks/:id/actions` with typed action and operation receipt | F4 already has getTask/startTask/reviewTask/blockTask/unblockTask/completeTask/cancelTask/recovery; F1 exposes only list/create/list move/delete. Return legal transitions and progress; finish/cancel must run settlement, not a status-only PATCH. |
| F-08 P0 | Add/remove a task agent — **Missing coordinated browser operation** | `POST /tasks/:id/members/preview`; `POST /tasks/:id/members`; `DELETE /tasks/:id/members/:slot` | Select existing Agent Template, resolve role/brain, provision/retire runtime and Cowork seat together, retain failure/recovery state. A global agent delete or Cowork participant remove alone is insufficient. F1/F4/C1 |
| F-09 P0 | Managed rooms list/detail/members/create/close — **Fleet facade** | `GET/POST /rooms`; `GET /rooms/:id`; `GET /rooms/:id/members`; `POST /rooms/:id/actions` | Reuse F4 listRooms/getRoomDetail/getRoomMembers/createRoom and Cowork operations. Managed-room close/delete must settle owned agents. Browser never independently closes Cowork and leaves Fleet state live. |
| F-10 P0 | Room invite/revoke and admission progress — **Fleet facade** | `POST/GET /rooms/:id/invites`; `POST /rooms/:id/invites/:inviteId/revoke`; `GET /rooms/:id/admissions` | Cowork room.invite/revoke/participants/show exist. Compose invite metadata, verification state and Fleet briefing delivery without leaking tokens to member lists. Explicitly distinguish a room invite from an agent identity invite. C1/F4 |
| F-11 P0 | Room conversation in shared Messenger UI — **Adapter/facade** | `GET /rooms/:id/history?cursor=...`; `POST /rooms/:id/messages`; room events | Cowork history/message/say exist. Choose normal owner/member authorship deliberately: room.message and room.say must not be interchangeable with a human-authored message. Map history, membership events and pagination to shared UI; route identity chat through Messenger where applicable. C1/C2/M1 |
| F-12 P0 | Folder picker/creation — **Missing** | `GET /hosts`; `GET /hosts/:id/folders?parent=...`; `POST /hosts/:id/folders` | Host online status, allowed roots, read/write capabilities, canonical path and safe child creation. Server enforces configured roots and symlink policy. Existing creation cwd validation is not a browse/create API. U1/F3 |
| F-13 P0 | Agent/owner/workspace profile chain — **Missing normalized projection** | `GET /roles/:id/profile`; workspace/owner summaries in profile response | Bind authoritative agent ID, identity CID, owner/workspace relationships, lifecycle, effective configuration and permissions. Existing Fleet detail/topology and Messenger contact root data are inputs; mock IDs/names must not become guessed ownership. External contact profile projection may belong in Messenger. F1/M1/U1 |
| F-14 P0 | Durable agent attention and non-permission requests — **Extend/define** | `GET /attention`; `POST /attention/:id/read`; `POST /attention/:id/decision` only for defined non-permission kinds | Expose typed requests, stable target IDs, actor/session generation, read vs unresolved state, allowed decisions and durable cursor. Runtime permission responses already exist and must delegate to that endpoint. “Approve outline” is not automatically a runtime permission: define its producer and decision contract. F1/F5/U1 |
| M-01 P0 | Combined Notifications inbox — **Missing aggregation** | Proposed Messenger/gateway `GET /api/notifications?cursor=...`, `POST /api/notifications/:id/read`, change events | Join human Messenger unread projections with Fleet attention; stable source+ID dedup, route target, read/resolved distinction, reconciliation after reconnect. Delegate read/decision to authoritative server; never consume the agent inbox. Can initially compose client-side from existing message state plus F-14, so a new aggregation endpoint is a recommendation, not the only solution. M1/M2/F5 |
| F-15 P1 | Agent chat semantics beyond runtime prompts — **Contract gap** | Extend Fleet conversation/input or add an identity-conversation facade | Shared UI supports replies, delivery/read receipts and attachments; runtime input accepts text/commandId and is not an encrypted peer-message API. Decide which chat type each screen represents; if runtime chat, explicitly expose supported capabilities. Do not promise reply/file equivalence without a server implementation. F1/M1 |
| F-16 P1 | Named permission profiles / host settings — **Product/schema gap** | Extend configuration only after defining reusable permission-profile and allowed-root schema | Existing Agent permissions are structured values, not the mock's named “Workspace edits” profile entities. Avoid inventing CRUD for an unsupported native concept. Host setting changes need effective policy/availability responses. F2/F3/U1 |
| M-02 P1 | Arbitrary contact profile/ownership views — **Extend projection** | Contact detail projection, e.g. `GET /api/contacts/:id/profile` | Reuse contacts/roots data; return only authenticated/known profile claims. No arbitrary remote directory is established by current identity/bio endpoints. M1/U1 |
| X-01 P1 | Email/password signup, verification, resend and workspace bootstrap — **Missing account service / decision** | Contract TBD for account provider; do not add a pretend auth endpoint to each daemon | Fleet has local auth exchange/login/anonymous/resume/logout/session. Those do not implement mock email signup or email confirmation. Identify account owner, provisioning, browser session and first Coordinator creation before implementation. F1/U1 |

## Cowork-specific backend deltas

Most room management functionality already exists as RPC; the main integration work is Fleet's facade. The following concerns remain distinct from route renaming:

| Gap | Existing capability | Needed change or explicit decision |
| --- | --- | --- |
| Browser-triggered invite acceptance | `room.accept` exists **only on the private Unix dispatcher**, deliberately omitted from REST | Fleet's acceptance operation must use the server-side private integration when accepting as a managed room. Agent identity acceptance uses Fleet's agent operation instead. Do not expose the secret-bearing method on public REST merely for frontend convenience. C1 |
| Live room history / membership updates | Pollable room.history/show/participants; no subscription method in the RPC dispatch table | Add a room event cursor/subscription contract or bounded server-side polling in Fleet, with resync and admission state. This is missing streaming support, not missing history. C1 |
| Per-viewer room read state | No room.read/notification read method in the inspected RPC table | For raw Cowork-history presentation, define viewer-scoped durable read cursor in Cowork or the facade. For Messenger-delivered room envelopes, use existing Messenger read semantics instead. Avoid maintaining conflicting read authorities. C1/M2 |
| File/reply parity for room history UI | room.message/room.say accept text; room.history can contain file/history records | Rendering existing file events is different from sending files/replies through room-management RPC. Reuse Messenger delivery where the owner is a connected participant, or design a Cowork transport extension with authenticated author/reference semantics. C1/C2 |
| Room invite listing/admission aggregation | room.show/participants/history and invite creation/revocation exist | First compose these existing responses. Add a dedicated Cowork query only if they cannot expose required safe pending/revoked/expired metadata; this is a response-contract check, not a proven missing storage primitive. C1/C2 |

## Concrete agent invitation contract (first implementation slice)

Proposed `POST /api/v1/roles/{agentId}/invites`, owned by Fleet:

```json
{
  "mode": "one_time",
  "label": "Launch reviewer"
}
```

Require an idempotency key. Derive the identity from the managed agent record; never accept a browser-supplied identity name/CID as authority. Return `{operationId, actor: {agentId, identityCid}, invite: {id, mode, code, createdAt}}` once completed, or a 202 receipt with an operation-status URL. Expiry fields are optional only if the underlying invite service supports them; don't fabricate expiration. List results omit the reusable secret code. Revocation is actor-scoped and idempotent.

Acceptance is a separate operation: preview the pasted code, bind the selected actor, submit, then poll/subscribe to structured progress. Protect against applying preview results to a different actor. Preserve the underlying room verification phase; “code accepted” does not imply “room joined.”

Required integration tests: managed-agent scope isolation; human-bound Messenger identity unchanged; single invite under retry; no implicit generation when opening a form; public/one-time mode fidelity; safe list responses; revoke propagation; acceptance retry and pending/failed admission; no frontend SDK import.

## Shared contract requirements

- Stable IDs for agent, identity CID, task, room, member slot, template revision and notification source. Display labels are not IDs.
- Use existing Fleet preview/action/idempotency conventions; return structured field errors, capability-unavailable and stale revision/session conflicts. Reconcile uncertain network outcomes through operation status.
- Keep role/brain selection by reference in this UI while preserving the backend's ability to accept inline YAML elsewhere. Cross-collection saves must validate references and reject dangling dependencies atomically.
- Configuration reads must redact credentials; metadata lists and notification payloads must not carry invitation codes. Authenticate the owner and authorize the selected managed actor at the server boundary.
- Represent progress and failures from server state. “Preview completed admission,” mock task status toggles and local notification decisions must disappear from the live adapter.
- Reuse existing SSE/WS transports where possible. Fleet's current event replay is in-memory; clients must handle resync/restart using durable snapshots. It is not a durable notification inbox.
- Count unread messages separately from unresolved requests; viewing a request is not accepting it. A unified inbox should carry canonical targets, but automatically rerouting UI badges still requires a frontend navigation graph; an endpoint alone does not supply it.

## Suggested delivery order

1. Actor-scoped Fleet invites/contacts and the gateway/auth boundary (F-01–03); configuration model extension and capabilities (F-04–06).
2. Task transition/member operations and managed-room facade (F-07–11), preserving existing orchestration/recovery.
3. Host folders/profile projections (F-12–13), durable attention and combined inbox (F-14/M-01).
4. Resolve chat transport parity, permission-profile and account-service decisions (F-15–16/M-02/X-01), then implement only the missing pieces for the chosen contracts.

The mock can be connected incrementally: already-existing routes should be integrated first; the gaps above should not be “filled” by direct browser SDK calls.
