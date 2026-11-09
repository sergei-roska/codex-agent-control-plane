# Owner correction replay repair handoff

Status: implementation and scoped verification complete; source awaits same-critic recheck.

## Evidence before edit

The prior source selected the durable correction row and returned the objective
for an exact match at `src/backlog-store.js` before invoking
`ownerCorrectionAuthorized`. The existing regression expected one callback
across initial application and replay. A focused attempt to run a separate
probe failed before exercising the store because it required a nonexistent test
fixture module; source and test inspection independently confirmed the ordering.
The specified prior review path
`.agents/teamwork/objective-extension-review-continue/review.md` was absent.

Initial hypothesis: moving the synchronous literal-true authorization callback
to the beginning of the immediate transaction will close the replay bypass;
replay lookup must still precede stale CAS checks, after authorization.

## Changes

- `src/backlog-store.js`: authorization now runs before objective lookup and
  replay lookup inside the immediate transaction. Exact authorized replay still
  returns the current projection without writes; payload conflicts still reject.
- `test/backlog-store.test.js`: existing callback count updated to count replay
  and conflicting invocations. Added coverage for revoked replay denial,
  authorized exact replay after a later correction advanced goal/control
  revisions, and state/event stability on denied replay and payload conflict.
  Updated the stale-CAS test fixture to authorize its stale case explicitly.

## Verification

- `node --check src/backlog-store.js`: passed.
- `node --test test/delivery-contracts.test.js test/backlog-store.test.js test/delivery-events.test.js test/task-scheduler.test.js`: 55 passed, 0 failed.
- First run of that test command found the stale-CAS case expected stale rejection
  from a default-deny fixture. The fixture was corrected to authorize that
  specific source message, preserving separate default-deny coverage. Rerun
  passed all 55 tests.

No services, providers, model trials, live state, or Git metadata were used.
