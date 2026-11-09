# CN-12 worker handoff

Updated 2026-10-27. Status: partial; root owns final integration and qualification.

## Completed

- src/delivery-acceptance.js adds a frozen-candidate mirror runner around real
  runAcceptance. It verifies candidate manifest bytes and modes before/after,
  retains source HEAD separately from synthetic mirror HEAD, preserves selected
  permissions/scratch/check pins, requires explicit admission release proof,
  and retains workspace plus external Git control context when effects are
  unknown.
- The mirror uses external empty Git config/hooks and strips inherited GIT_*
  variables. Optional per-call Git environment injection in src/acceptance.js
  and src/workspace-snapshot.js protects snapshots and owner checks while
  preserving legacy defaults. Candidate-local text/eol attributes remain active.
- CandidateReviewStore.finalizationProjection is a read-only projection of
  current receipt, closure, pin, and pending-review facts. Settlement/promotion
  behavior was not changed.
- src/backlog-store.js adds typed durable finalization APIs: begin/barrier,
  start/unknown/reconcile checks, record checks, commit, invalidate, history,
  and current qualification. It uses immediate SQLite transactions, candidate
  references, exact replay identity, default-deny trusted callbacks, pending
  task/review/lifecycle/publication blockers, trusted partial remainder facts,
  retained unknown-check context, and atomic objective/event/ref commits.
- Same-payload replays of begin, unknown-check, check-result, terminal commit,
  and invalidation now require fresh synchronous literal-true authorization.
  Denied replay leaves durable record and event count unchanged. Check result
  replay uses the separate check-proof authorization. Invalidation conflicts if
  the replay changes its reason.
- Finalization readiness now blocks any task still in blocked state. This
  prevents owner correction's owner_correction_replan_required tasks and other
  unresolved blocked work from qualifying as complete or partial.
- test/backlog-store.test.js contains real CandidateStore publication denial
  during the barrier, runAcceptance check/commit and retention/replay fixtures,
  reopen/unknown reconciliation, partial trusted provenance, stale control and
  candidate, rollback, replay authorization and owner-correction regressions.

## Verification

Latest focused command after the last source/test changes:

    node --check src/backlog-store.js && node --check test/backlog-store.test.js && env -u NODE_TEST_CONTEXT node --test --test-name-pattern='typed finalization command replays|owner correction replan blocks' test/backlog-store.test.js

Result: syntax checks passed; 2/2 selected tests passed.

Previously verified runner checks, before the later store-only changes:

    env -u NODE_TEST_CONTEXT node --test test/delivery-acceptance.test.js test/candidate-review.test.js test/workspace-snapshot.test.js

Result: 36/36 passed. The hostile inherited Git environment fixture confirmed
that the filter marker was not created. The later independent safe runner review
approved its defensive static review and 104 tests; it did not repeat the
adversarial probe. Per root instruction, do not rerun the hostile runner test or
original probe without a new instruction.

Earlier acceptance-related suites passed 68/68:

    env -u NODE_TEST_CONTEXT node --test test/acceptance.test.js test/acceptance-scratch.test.js

## Pending / qualification limits

- No finalizeCandidate orchestration adapter has been added. Durable store APIs
  and runFrozenCandidateChecks exist, but no single entry point currently
  validates the contract, advances the barrier/check/commit sequence, or records
  unknown failures into the store.
- The last store critic found an owner-correction replan bypass. The narrow
  readiness fix and exact regression passed locally, but no independent re-review
  of that final delta or root full affected-suite verification has completed.
- The current focused checks do not constitute full CN-12 qualification. Root
  still needs to run final affected/full verification, review the frozen source,
  and decide completion against the remaining acceptance criteria.
- No Git mutation, dependency changes, services, live models/accounts, target
  edits, or tracked documentation changes were made.

Status: partial
