# AD-06 concurrent acceptance implementation

Status: implementation complete; no source changes needed.

## Ownership and next action

Luna junior worker owns the source/test paths listed in `brief.md`. Implement
the missing integrated acceptance and successor-rebasing evidence, fixing only
demonstrated source gaps.

## Completed evidence

- Added store-level proof that a queued successor blocks accepted finalization,
  that stale dependent target output identity cannot unlock a task, and that
  stale check receipts or missing mandatory checks cannot be recorded as
  accepted.
- Added accepted terminal fingerprint/current qualification and result replay
  assertions across SQLite reopen to the existing successful concurrent engine
  acceptance test. Existing overlapping-lanes coverage confirms the dependent
  worker reads the predecessor's published candidate; its base candidate pin
  matches the candidate current at dispatch.
- Added worker claim/submission recovery to an explicitly unknown attempt,
  reopened SQLite with its candidate/review/lifecycle stores, and proved the
  attempt and expired claim remain unknown and block accepted finalization.
  Existing finalization-check tests also prove unknown checks cannot commit and
  require reconciliation.
- Inspected the current source gates; these scenarios passed without source
  changes, so no acceptance policy was changed.

## Verification

- `node --test --test-name-pattern='stale check receipts and missing mandatory checks cannot become accepted evidence|a queued successor blocks accepted finalization' test/backlog-store.test.js` - 2 passed, 0 failed.
- `node --test --test-name-pattern='unknown worker effects survive SQLite reopen and block accepted finalization' test/backlog-store.test.js` - 1 passed, 0 failed.
- `node --test --test-name-pattern='concurrent engine accepts its pinned base candidate with required owner checks' test/concurrent-delivery-engine.test.js` - 1 passed, 0 failed, including SQLite replay.
- `node --test test/concurrent-delivery-engine.test.js test/delivery-acceptance.test.js test/backlog-store.test.js` - 134 passed, 0 failed, 0 skipped.

No full repository suite, live provider, quota, runtime activation, or Git state change was performed. An existing expected A2A rejection emitted `delivery_role_objective_inactive` to test output; all 134 tests passed.
