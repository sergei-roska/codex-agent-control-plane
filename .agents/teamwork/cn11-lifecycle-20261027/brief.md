# CN-11 lifecycle implementation

Own `src/delivery-lifecycle.js`, `test/delivery-lifecycle.test.js`, narrow
`src/project-delivery-controller.js` hooks and tests, and narrow typed
transitions in `src/backlog-store.js` and its tests. Preserve the predecessor
dirty work listed in `.agents/teamwork/lifecycle-continuation-20261027/source-start.json`.

Implement durable owner pause, emergency stop, explicit cancellation, exact
control/generation CAS, typed budget and transient retry records, bounded
recovery, and safe restart behavior. Use actual BacklogStore, TaskExecutor,
controller, fake transports, SQLite reopen, and deterministic barriers. Do not
edit planner or executor source without root ownership grant. Do not edit CN-13
launcher/UI/visibility files, tracked docs, Git state, services, accounts, or
target projects. No live model/provider calls.

Required initial checks: read worker instructions, development-access, this
brief source, project map, fallback project handoff, Git status, and existing
delivery APIs. Current-owner handoff was missing; `docs/codex-handoff.md` was
read as fallback. Tests run only after their exact command and results are
recorded here and in `handoff.md`.
