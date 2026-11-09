# Handoff

## State

Implemented uniform immutable intake normalization for `goal`, `contract`,
`contextId`, and `newRequest`. Explicit `null` is retained and conflicts with a
previous non-null value; omitted or `undefined` values are not supplied. Replay
conflicts are checked before any update and before calling an engine. Replays
route the stored mapping request over the caller's partial input. Exact intake
replays avoid mapping updates and preserve `updatedAt`.

Resume placeholders now have a `resume_placeholder` SQLite flag, added
compatibly when opening an existing table. Their first run stores explicitly
provided intake and clears the flag without changing the pinned legacy engine.
The router still awaits delegated asynchronous `isResumable` results.

The source/test paths above are the only product paths edited. The router is
currently inactive: targeted search found no `DeliveryEngineRouter`
construction or router run/resume call sites under `src`.

## Verification

- `env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js`
  passed 8/8 after independent review remediation.
- `git diff --check -- src/delivery-engine-router.js test/delivery-engine-router.test.js`
  passed.
- Tests use better-sqlite3 in-memory and temporary file databases. Coverage
  includes async resumability, omitted intake fields, explicit null and changed
  immutable fields, no provider call or persisted mapping/timestamp change on
  conflict, authoritative replay routing, SQLite reopen, placeholder backfill,
  and engine pinning after default-engine change.
  Review remediation now treats absent fields as immutable on every normal
  first run and verifies attempts to add each of the four intake fields leave
  the mapping, timestamp, and engine call count unchanged. Placeholder
  backfill remains the only exception.

No live provider/model/account/service, dependency, target, or Git mutation was
performed. No engine activation is claimed. Ready for independent review.
