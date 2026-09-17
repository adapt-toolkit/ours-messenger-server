# Fleet product preview

Run `npm run dev` and open **http://127.0.0.1:5173/fleet**. The existing live Messenger remains at `/chats`. The preview is also included in the normal production build and supports direct URL reloads through the existing SPA fallback.

This implements the 64-step `ours-fleet/fleet_wireframes.pen` interaction map, inspected through pen.dev MCP. It uses the existing final liquid-glass CSS cascade, system typography, `Conversation`, `ChatList`, and Radix `DialogShell`. Work, Messenger and Tasks have desktop navigation; phones use the navigation button and list → detail navigation. Light/dark themes and reduced motion/transparency are supported.

## Data and boundaries

The `Preview` badge identifies the local demonstration. Seed data includes Coordinator, Research assistant, Developer, Critic, Writer, tasks in all seven board columns, people, external agents and a shared room. No preview flow calls live REST APIs, creates Fleet identities, executes commands, or generates real invitations. Invite codes use `ours://preview-invite/`. Account confirmation and room admission have explicit preview continuation buttons.

Agent/task/list mutations, messages, permissions and definitions live in React state and reset on reload; theme preference persists. Existing seed identities/tasks support reloadable deep links. New session IDs intentionally last only for this preview session. Opened chats remain mounted to retain independent drafts, reply state and scroll during navigation. Mock Messenger and direct-agent conversations use different IDs/histories for the same agent.

## Screen and flow coverage

| Wireframe steps | Reachable path |
| --- | --- |
| 01–04 Account | Account profile → Account; `/fleet/account/login`, Create account → confirmation → welcome |
| 05 Empty Work | Account profile → Getting started, or welcome → Continue to app |
| 06 Navigation | Phone ☰ → Work / Messenger / Tasks / My profile / Settings |
| 07–11 Work and direct agents | Work → Persistent / Temporary → agent; Developer → tool output, Allow/Deny, Agent actions |
| 12 Add | Global + → invitation, new agent, new task, task-local agent |
| 13–20 Agent creation | + → New agent → Temporary/Persistent → template or direct role/brain/permissions → folder picker → New folder → create → agent chat |
| 21–22 Agent lifecycle | Agent actions → Delete temporary session / Stop persistent agent |
| 23 Task board | Tasks; search and list filter; all seven columns |
| 24–26 Task creation | + New task → single/pair/team/custom → provisioning or empty room → task / agent |
| 27–31 Task detail and actions | Task card → status menu → Move / Block / Finish; Back returns to board |
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
- `FleetDialogs.tsx`: one persistent shared modal shell whose content changes; nested folder dialog retains the host picker beneath it.
- `fleet.css`: selectors scoped to `.fleet-*`, with a small scoped layout seam around reused chat components. Loaded only with the preview chunk.

No production chat, reply, message, voice, command, or modal implementation was modified. Mock-only controls surround the existing chat; the live application remains unchanged.

## Verification

Run `npm run build && npm run test:fleet`. The browser gate verifies independent drafts, section navigation, explicit invite generation, locked actors, invite text retention, modal focus return, task moves, deletion confirmation, agent/task/folder creation, account/configuration, room and identity deep links, mobile composer bounds and zero live API requests. Screenshots are written to `/tmp/ours-fleet-evidence`.

Additional production preservation gates: `npm run test:mobile`, `npm run test:swipe`, `node tests/browser-composer-focus.test.mjs`, `node tests/browser-pointer-touch.test.mjs`, `node tests/browser-accessibility-controls.test.mjs`, and `node tests/browser-room-envelope-matrix.test.mjs`.
