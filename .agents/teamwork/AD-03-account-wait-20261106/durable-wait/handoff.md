# AD-03 durable wait handoff

Status: implementation complete.

## Changes

- `src/backlog-store.js`: accepts an optional `blockers` array on the durable
  budget wait, validates exact records, identities, reset hints, array size,
  and duplicates; normalizes exact field order before comparing duplicates and
  rejects sparse or explicitly empty arrays before mutation. Persisted records
  and idempotency checks retain blockers.
- `src/delivery-lifecycle.js`: accepts and forwards optional blockers. Existing
  `projection().budgetWaits` projects stored blocker records without deriving
  them from scheduling timestamps.
- `test/backlog-store.test.js`: verifies invalid and duplicate blockers plus
  SQLite persistence/reopen.
- `test/delivery-lifecycle.test.js`: verifies timestamp-only wake ineligibility,
  projected explicit windows, and a second wait after a successful wake.

## Verification

- `node --test test/backlog-store.test.js test/delivery-lifecycle.test.js`:
  72 tests passed, 0 failed.
- `git diff --check -- src/backlog-store.js src/delivery-lifecycle.js
  test/backlog-store.test.js test/delivery-lifecycle.test.js`: passed.
- No staging or commit performed.

## Integration notes

- Optional blockers remain absent on legacy calls and stored records when not
  supplied. Wake still requires literal `true` from the existing authoritative
  eligibility callback and matching owner/control pins.
- No engine/server adapter or live provider path was changed.
