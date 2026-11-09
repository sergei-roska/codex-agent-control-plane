# AD-07 owner pause and resume controls

## Goal

Add scoped concurrent pause/resume endpoints through the host and launcher,
then expose them in the backlog UI. The UI must distinguish a durable applied
control from an unknown request outcome and refresh status after ambiguous
responses. Owner control uses the current control revision so stale quota or
resume events cannot override a newer pause.

## Verified context

- Durable concurrent status projection and LL-7 browser acceptance are complete;
  see sibling handoffs under this directory.
- `src/delivery-host-controls.js` exposes authenticated status and steer routes,
  but no owner pause/resume route.
- `src/launcher-app.js` proxies status and steering under the exact persisted
  run mapping. `DeliveryEngineRouter.requestPause` and
  `cancelPauseRequest` already route to the concurrent engine.
- AD-05 owns store/lifecycle/engine cancellation semantics. Do not add cancel
  behavior in this task; integrate it after AD-05 establishes the API contract.
- Shared checkout HEAD is `ab5c195` plus existing uncommitted changes. Preserve
  all changes. Root owns Git/index; do not stage or commit.

## Ownership

Own this directory and only these product paths: `src/delivery-host-controls.js`,
`src/launcher-app.js`, `launcher-ui/backlog.html`, `launcher-ui/backlog.js`,
`launcher-ui/backlog.css`, `test/delivery-host-controls.test.js`,
`test/launcher-owner-delivery.test.js`, and `test/launcher-backlog-ui.test.js`.

No live provider, quota use, runtime activation, credentials, external messages,
Git staging, or commits.

## Acceptance

1. Authenticated host and launcher endpoints accept exact run/project/session/
   objective scope plus expected control revision, fail closed for legacy or
   mismatched mappings, and return a scope-checked acknowledgement/status.
2. Stale control revision returns conflict without changing state. Pause fences
   stale budget wake/resume; resume is offered only for a durably paused
   objective.
3. UI renders pause/resume only when current durable disposition permits it,
   disables controls while a request is pending, and reports applied, stale, or
   unknown outcomes accurately. It does not blindly retry an ambiguous action.
4. Focused tests cover endpoint scope/revision and UI action behavior; report
   exact commands/results. Do not claim cancel integration or complete AD-07.
