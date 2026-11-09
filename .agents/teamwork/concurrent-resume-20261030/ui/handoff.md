# UI worker handoff

Status: revised implementation and deterministic verification complete; root owns
critic re-review and browser/live acceptance.

Changed files:
- `launcher-ui/app.js`: decision submit retains drafts on failures, surfaces
  returned error-paused tasks, guards duplicate sends, and clears unchanged draft
  values only after an acknowledged continuation. Request ownership and an epoch
  invalidate stale work on project/session changes; cleanup rechecks scope after
  polling before touching pending-turn or session state. Decision identity stays
  intact through transient working polls, while a genuinely changed decision is
  rendered after the request settles.
- `test/launcher-decision-ui.test.js`: behavioral VM coverage for failures,
  semantic error pauses, duplicate clicks, success, pending edits, changed
  sessions/decisions, older project requests, and scope changes during deferred
  poll cleanup.

Verification facts:
- `node --check launcher-ui/app.js` passed.
- `node --test test/launcher-*-ui.test.js test/launcher-session-controls.test.js test/launcher-ask.test.js` passed, 73 tests, 0 failures.
- Targeted `node --test test/launcher-decision-ui.test.js test/launcher-session-controls.test.js` passed, 25 tests, 0 failures.
- `node .agents/teamwork/concurrent-resume-20261030/review-ui/probe-races.cjs` passed. The old request left the newer send busy (`before=true`, `after=true`); an intermediate working poll retained the selection and draft after the same error pause returned.
- `git diff --check -- launcher-ui/app.js` passed.
- Frozen `git hash-object` values: `launcher-ui/app.js` = `888b12f681f0097dc398be8889abac4567203a44`; `test/launcher-decision-ui.test.js` = `aa90ecd85e4fa517ee13a977a2d6161230dd231d`.

No live task submission or browser acceptance was performed by this worker. Root
should rerun the critic against these hashes. Inherited workspace changes remain
preserved; the pre-worker baseline app hash was
`882336a18e5672fdc874f3c55ccbdfc82a4c0180`.
