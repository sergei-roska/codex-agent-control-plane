# Correction qualification checkpoint

Status: partial, concrete source blockers reproduced. Tests frozen pending root
scope/design decision. Only test/concurrent-delivery-engine.test.js changed since
correction baseline; engine byte-identical. Three meaningful cases, 1 pass/2 fail.
No source fix, Git mutation, service updates or live provider actions.

Verified current behavior:
- Held old planner output is retained stale after pause/correction/shutdown.
- Authenticated correction inbox row remains received across SQLite reopen.
- Explicit paused controller.runOnce applies it atomically, increments goal/control,
  changes objective digest, and next planner receives corrected goal/digest/control.
- Unauthenticated input throws owner_authentication_required; authenticated but
  unauthorized input blocks owner_correction_unauthorized; stale correction blocks
  owner_correction_revision_stale. Valid replay is duplicate with one correction
  record/event; changed replay conflicts. Original goal/contract/intake digest stay.

Blocker 1: normal facade resume-first after reopen increments paused control2 to3
before processing received correction captured at2. Controller marks trusted queued
correction blocked owner_correction_revision_stale. Goal remains1. Reproduced via
real engine.resume, no manual loop. Relevant engine #runFacade:427 transition order.
Evidence resume-first-repro.log and final-qualification.log.

Blocker 2: separate explicit paused runOnce proves valid correction reaches planner
but cannot reach final acceptance. Objective goal2/digest c differs from active
intake checkpoint goal1/original digest. reviewStore.finalizationProjection returns
closure.known=false, complete=false, no review tasks/finalizations; engine #advance
refuses unavailable closure at740+. #ownerCheckpointInventory:1012 still returns
original checkpoint IDs; no correction registration/supersession wiring exists in
engine. candidate-review.js:908 identityCurrent correctly rejects old goal/digest.
Historical run digest itself is not the defect; do not rewrite immutable intake.
Evidence current-pins-repro.log includes full projection. Direct runOnce is isolated
diagnostic composition, not normal facade qualification.

Exact commands (env -u NODE_TEST_CONTEXT prefix):
- node --test --test-name-pattern='owner correction facade refuses' test/concurrent-delivery-engine.test.js
  negatives.log: 1 pass/0 fail.
- node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='owner correction facade' test/concurrent-delivery-engine.test.js
  final-qualification.log: 3 tests/1 pass/2 fail/0 skip/0 canceled; expected unresolved
  criteria retained as real failing regressions, not weakened into success.
- git diff --check -- test/concurrent-delivery-engine.test.js passed; ASCII passed.
No broad/full suite run. Prohibited named test never executed.

Exact hashes source-final.json, test baseline delta tests.diff. Scratch logs may
disappear. Eventual accepted current pins and admitted old worker correction safety
remain unqualified. Root must decide bounded source repair scope before edits.
