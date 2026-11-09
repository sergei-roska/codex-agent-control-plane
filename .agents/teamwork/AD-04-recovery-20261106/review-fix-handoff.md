# AD-04 router recovery migration fix

Implemented the review fix. `DeliveryEngineRouter.getLegacyRecoveryGraph(runId)` exposes the legacy graph only when the run is not mapped to `concurrent-v1`. The migration helper uses this API when available and retains direct `orchestrator.graph` support. After a successful migration, the executor no longer falls back to stale stored pause metadata, so a stale decision ID is not forwarded on resume.

Added a composed server regression using the real router and lead executor. It checks stale decision metadata, retired human request and interrupt, no obsolete question publication, and resume input without the stale decision ID. Added router coverage for the legacy/concurrent engine fence.

Verification:
- `node --test --test-name-pattern='production router migrates a legacy recovery question|legacy threshold-only recovery question is migrated before a resumed task is published' test/server.test.js` - 2 passed, 0 failed.
- `node --test test/delivery-engine-router.test.js` - 13 passed, 0 failed.
- `git diff --check` - passed.
- `node --test test/server.test.js` - interrupted after 105 seconds; 19 passed, 0 failed, 1 cancelled. Runner reported a pending promise after making no further progress. Full-suite result is incomplete.

No Git state changed. The separate AD-02 hunk was not present in the inspected diff and remains untouched. Inherited `:memory:.lockdb` remains untouched.

Status: complete
Scope expansion: none
