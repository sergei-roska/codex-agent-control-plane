# V14 implementation handoff

## Current status

Implementation and scoped checks are complete. Root owns docs/Git and broad
frozen checks. No source outside the approved six files or paired coverage was
changed. No terminal methods were edited.

## New implementation evidence

- Resume baseline: `resume-baseline.tap`, 17 pass / 1 fail. Authenticated reply
  failed because `owner.decision:${digest}` exceeded DeliveryInbox's 64-character
  trigger limit. `src/concurrent-delivery-engine.js` now uses a bounded 24-hex
  digest prefix; the same host/SQLite restart reply succeeds.
- Composed host replacement test covers a real completed investigator, actual
  goal correction, refused ordinary stale reply, stale pins, unauthenticated
  replacement, non-original evidence, shared-tree drift, unavailable manifest,
  successful current-pinned replacement, immutable original investigator pins,
  retained history, refused old digest, and one valid new answer.
- The replacement test does not force acceptance after goal correction. Its
  resumed planner correctly needs a fresh plan for the changed goal. A separate
  fresh-run restart scenario proves accepted disposition and the actual required
  verifier check after an owner reply.
- Added an awaited planner-turn race test and a real `beginFinalization` pending
  gate assertion with no finalization row created.
- Closed the legacy `requestControl('resume')` bypass in shared `#requestControl`;
  direct public-path coverage proves a pending decision retains the pause cause
  and cannot be resumed.
- Reproduced the full-run acceptance miss under project-wide planner slot
  contention: the second run's initial trigger remained pending after a busy
  planner, while `#advance` inserted a verifier task and advanced planRevision
  from 0 to 1. `#advance` now returns while the durable inbox wake is pending,
  before it can create automatic review work. The restart test holds the first
  corrected planner turn and asserts the second run has no tasks, planRevision
  0, and its initial wake intact before releasing the slot.
- Existing concurrent-engine answer/reopen variants retain the acceptance checks
  for the unchanged-goal answer path. Replacement and reopen-only engine-swap
  variants now assert durable resolution without inventing acceptance evidence;
  genuine host resource reconstruction and mandatory acceptance are exercised by
  `owner-decision-restart.test.js`.

## Verification

- `env -u NODE_TEST_CONTEXT node --test test/owner-decision.test.js test/owner-decision-restart.test.js`
  PASS 19 / FAIL 0, before the race-repair test was added.
- `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-name-pattern='owner decision real engine (replace|reopen)' test/concurrent-delivery-engine.test.js`
  PASS 3 / FAIL 0.
- `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap test/backlog-store.test.js test/lead-planner.test.js test/project-delivery-controller.test.js test/delivery-lifecycle.test.js test/concurrent-delivery-engine.test.js test/delivery-host-controls.test.js test/owner-decision.test.js test/owner-decision-restart.test.js`
  PASS 161 / FAIL 0 / skipped 0, `focused-final3.tap`, pre-race-repair checkpoint.
- `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap test/owner-decision.test.js test/owner-decision-restart.test.js`
  PASS 20 / FAIL 0, `focused-race-repair.tap`.
- `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-name-pattern='owner correction facade' test/concurrent-delivery-engine.test.js`
  PASS 7 / FAIL 0, `focused-correction-repair.tap`.

## Changed files in this turn

- `src/concurrent-delivery-engine.js`
- `test/concurrent-delivery-engine.test.js`
- `src/backlog-store.js`
- `test/owner-decision.test.js`
- `test/owner-decision-restart.test.js`

No scope expansion. No Git writes, service restarts, live provider calls,
installs, or account/settings changes.
