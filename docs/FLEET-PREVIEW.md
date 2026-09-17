# Fleet product preview

Run `npm run dev` and open **http://127.0.0.1:5173/fleet**. The existing live Messenger remains at `/chats`. The preview is also included in the normal production build and supports direct URL reloads through the existing SPA fallback.

This implements the 64-step `ours-fleet/fleet_wireframes.pen` interaction map, inspected through pen.dev MCP. It uses the existing final liquid-glass CSS cascade, system typography, `Conversation`, `ChatList`, and Radix `DialogShell`. A shared Navigation surface describes Sessions, Messenger and Task manager, with a current-section marker. Its 3×3 launcher is available in the outer desktop and mobile navigation. On phones, leave a conversation with Back before opening the launcher. Phones show global navigation on the list; opening a chat fills the screen, and Back restores the list. Agent and room actions share the existing conversation header. Light/dark themes and reduced motion/transparency are supported.

## Shareable first-run walkthrough

Start at `/fleet/account/signup`: mock registration → preview email confirmation → five visual introduction slides → Coordinator chat. The slides lead with practical benefits: you own your agents and rooms, any two agents in the ours network can communicate by invitation, each task has a visible team conversation, anyone in the network can be invited into your rooms without a shared organization, and closing the task room ends access through that room. Agent communication means exchanging messages. A website example connects the scenes. Example fields are prefilled; the test name personalizes the greeting. The greeting explains Sessions, Messenger, Task manager and Settings. Skip also opens Coordinator. Close conversation returns to the list without deleting the chat or draft.

Every full entry URL visit/reload starts a fresh, independent in-memory mock session. Separate tabs and people do not share account, messages or mutations. Only theme preference persists. Returning to a chat inside the same visit preserves messages and drafts and does not duplicate the greeting. No real registration, email or agent backend is involved.

For public testing, build then run `node scripts/fleet-preview-server.mjs` (loopback port 5180; override with `FLEET_PREVIEW_PORT`). Run `cloudflared tunnel --url http://127.0.0.1:5180 --no-autoupdate` and share its HTTPS URL with `/fleet/account/signup`. The static origin permits only `/fleet` routes and built assets; `/api`, `/chats`, service workers and non-read methods return 404. The temporary tunnel lasts while its process and this host stay running.

## Data and boundaries

The `Preview` badge identifies the local demonstration. Seed data includes Coordinator, Research assistant, Developer, Critic, Writer, tasks in all seven board columns, people, external agents and a shared room. No preview flow calls live REST APIs, creates Fleet identities, executes commands, or generates real invitations. Invite codes use `ours://preview-invite/`. Account confirmation and room admission have explicit preview continuation buttons.

Agent/task/list mutations, messages, permissions and definitions live in React state and reset on reload; theme preference persists. Existing seed identities/tasks support reloadable deep links. New session IDs intentionally last only for this preview session. Opened chats remain mounted to retain independent drafts, reply state and scroll during navigation. Mock Messenger and direct-agent conversations use different IDs/histories for the same agent.

## Screen and flow coverage

| Wireframe steps | Reachable path |
| --- | --- |
| 01–04 Account | Account profile → Account; `/fleet/account/login`, Create account → confirmation → welcome |
| 05 Empty Work | Account profile → Getting started |
| 06 Navigation | Navigate → Sessions / Messenger / Task manager / My profile / Settings |
| 07–11 Work and direct agents | Work → Persistent / Temporary → agent; Developer → tool output, Allow/Deny, Agent actions |
| 12 Add | Global + → invitation, new agent, new task, task-local agent |
| 13–20 Agent creation | New chat → editable name/role/brain → More options/folder → first Send creates and locks temporary agent; + → New persistent agent for durable agents |
| 21–22 Agent lifecycle | Agent actions → Delete temporary session / Stop persistent agent |
| 23 Task board | Tasks; search and list filter; all seven columns |
| 24–26 Task creation | + New task → single/pair/team/custom → provisioning or empty room → task / agent |
| 27–31 Task detail and actions | Task card → status menu → Move / Block / Finish; Back restores the source screen |
| 32–33 Nested Work | Temporary → task → Room, then direct agent rows; agent context retains room unread badge |
| 34–37 Membership and closure | Task or nested Work → + Agent; task detail → Remove; Task actions → Close / Delete with repeated task ID |
| 38–39 Lists | Tasks → Manage lists → New list / Delete, with destination list |
| 40 Messenger | Messenger → seeded contacts → unchanged Conversation; same-agent Messenger from Agent actions |
| 41–43 Accept | Global + → Accept as yourself → optional agent picker; pasted code survives actor selection |
| 44–47 Generate | Global or room member invitation → choose type → explicit Generate → Copy; opening or changing type does not generate |
| 48–50 Room | Room → Members → pending member/admission → information; external participants open external profiles |
| 51–54 Profiles | Account → Human → Workspace → own/external agent; back restores parent; avatar in chat opens identity |
| 55–58 Agent connections | Own-agent profile → Contacts & invitations → Generate / Accept with locked actor |
| 59–63 Configuration | Settings → template / role / brain / permission profile; host and task templates also navigable |
| 64 Feedback | Settings → Preview notification; common top notification clears after four seconds |

## Implementation

- `model.ts`: typed seed agents, tasks, contacts, chat histories and navigation states.
- `FleetApp.tsx`: preview state, section routing and Work/Tasks composition. Production entry is a lazy `/fleet` gate in `main.tsx`.
- `components.tsx`: reusable identity rows, fields, search, buttons and page headings.
- `pages.tsx`: profile hierarchy, configuration and account journeys.
- `ChatSetup.tsx`, `FolderPicker.tsx`, `Navigation.tsx`: reusable draft setup, folder selection and descriptive navigation.
- `Onboarding.tsx`: five capability slides with accessible focus, Back/Skip, and Coordinator handoff.
- `scripts/fleet-preview-server.mjs`: isolated static origin for public mock testing.
- `FleetDialogs.tsx`: one persistent shared modal shell whose content changes; folder selection and creation stay inside the same shell.
- `fleet.css`: selectors scoped to `.fleet-*`, with a small scoped layout seam around reused chat components. Loaded only with the preview chunk.

`Conversation` adds optional `headerActions` and `timelineFooter` slots for its peer header and scrollable timeline. Fleet supplies compact contextual controls and agent activity; live Messenger omits the slot. Reply, message, voice, command, composer, and modal behavior remain unchanged. Profile browsing and its invitation steps share one dismissible shell; outside click, Escape, and Close return to the original screen and preserve its chat draft.

The approved pen.dev refinements are implemented: compact invitation menus, a hierarchical folder picker, separate Temporary tasks/chats, and draft-first New chat. ChatSetup keeps editable configuration local until first Send creates exactly one mock agent and locks its settings; closing/reopening retains the draft. Phone chat setup is a compact, subdued form beside the composer; desktop setup retains its full layout. Agent profiles show a linked owner → workspace → agent hierarchy, including the correct external owner. Contacts have one Back returning to the source profile. Folder selection commits only on Select folder. Navigation dismissals, task Back and Settings Back preserve the source conversation.

## Verification

Run `npm run build && npm run test:fleet`. The browser gate verifies independent drafts, section navigation, explicit invite generation, locked actors, invite text retention, modal focus return, task moves, deletion confirmation, agent/task/folder creation, account/configuration, room and identity deep links, mobile composer bounds, first-run onboarding, personalized single greeting, close/reopen retention, fresh entry visits, tab isolation, static-origin rejection checks and zero live API requests. Screenshots are written to `/tmp/ours-fleet-evidence`.

Additional production preservation gates: `npm run test:mobile`, `npm run test:swipe`, `node tests/browser-composer-focus.test.mjs`, `node tests/browser-pointer-touch.test.mjs`, `node tests/browser-accessibility-controls.test.mjs`, and `node tests/browser-room-envelope-matrix.test.mjs`.


Fleet lists share Messenger’s `ContactRow`, `SearchInput` and list/tab material styles. The shared `Button` / `IconButton` primitives preserve Messenger’s existing class cascade; Fleet menus, navigation and task-template choices use those controls, and `Field` applies the existing `.field` style. Fleet-specific control colors, shadows and radii were removed. `DialogShell` remains the shared modal shell. The compact inline chat setup remains intentionally distinct from full forms.

Only the outer header provides list creation: New chat, persistent agent, task, invitations, and context-sensitive “Add to this task” all live under +. Fleet hides the embedded Messenger titlebar and invite shortcut with scoped CSS; the standalone Messenger retains them. Current section + chevron and the nine-square launcher open the same navigation dialog. Phone conversations show neither control until Back returns to the list.

Validation: `node tests/browser-fleet-consistency.test.mjs` checks shared computed styles, section controls, search retention and task-context creation at 320/390/1280px in both themes (uses `FLEET_PREVIEW_ORIGIN`, otherwise starts an isolated local preview server).

Control geometry is shared across themes: `--r-control` is 14px for standard buttons and fields; `--r-icon-control` is 13px for icon buttons, matching the requested dark-theme roundness. Dialog sizing/position comes entirely from Messenger’s responsive `DialogShell` styles (full-width phone sheet, centered desktop dialog; Profile uses the standard `wide` variant).
