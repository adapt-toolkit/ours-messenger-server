# messenger-server 2.0.0 (major release)

This release promotes the validated `prerelease` line to `main` as a major
release of `@ours.network/messenger-server`. The version is produced by the
`main` version-bump job from the merge commit's Conventional Commits subject; it
is not written by hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/messenger-server` | 1.0.30 | 2.0.0 |

## Dependencies

- `@ours.network/sdk` 5.0.0 (exact pin; previously a 4.1.1 nightly)
- development: `@ours.network/cli` 4.0.0 and `@ours.network/daemon` 5.0.0

## Breaking changes

- The web client is extracted into a standalone repository; this package is an
  API-only server. Deployments that served the bundled web client must install
  the external frontend.
- The server runs on the thin SDK 5 client against a separately installed shared
  daemon reached through a gateway client profile.
- Notifications move to the dedicated `@ours.network/notifications` service with
  typed targets and unified workspace routing.

## Features and fixes promoted from prerelease

- Root-only workspace enrollment with a private Human profile; optional profile
  names are persisted and existing profiles preserved.
- Workspace retirement deadlines relayed from the held root; contact
  notifications retired and signed root workspace contacts reused.
- Incoming message and file notifications sent to the notifications service with
  linked anchors; typed outbox events only, with malformed entries no longer
  blocking typed work.
- Complete resource SSE updates; canonical conversation notification routes;
  less idle live delivery health traffic.
