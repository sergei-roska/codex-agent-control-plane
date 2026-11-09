# AD-03 wait reschedule handoff

Status: implementation complete.

## Changes

- `src/backlog-store.js`: added `rescheduleBudgetWait()` with exact input
  validation, normalized blocker validation, pending-state/objective/control
  checks, stored and objective pin checks, and an SQL compare-and-swap update.
  Wait identity, provider details, reason, and resume disposition are retained.
- `src/delivery-lifecycle.js`: added positive bounded delay validation, current
  lifecycle pin forwarding, disabled-wait clearing, and timer re-arming. The
  method updates scheduling data only and does not wake the objective.
- Store and lifecycle tests cover blocker/time persistence after SQLite reopen,
  stale control and owner pins, missing and woken waits, wrong objective state,
  malformed blockers, timer rescheduling, and no wake/disposition change.

## Verification

- `node --test test/backlog-store.test.js test/delivery-lifecycle.test.js`:
  74 passed, 0 failed.
- `git diff --check -- src/backlog-store.js src/delivery-lifecycle.js
  test/backlog-store.test.js test/delivery-lifecycle.test.js`: passed.
- `:memory:.lockdb` was not touched. No staging, commit, or other Git state
  changes were made.

## Integration notes

- This is a storage/lifecycle primitive. It does not add authoritative account
  reads, automatic wait orchestration, or provider rebind integration.
