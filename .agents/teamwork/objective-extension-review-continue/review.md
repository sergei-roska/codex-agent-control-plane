# Objective extension re-review

Verdict: APPROVE
Status: complete
Scope expansion: none

Original finding: src/backlog-store.js previously returned an exact source replay before calling ownerCorrectionAuthorized, so a callback that denied a later call was bypassed. A prior real SQLite probe observed one callback invocation and a returned projection after denial.

Resolved: read src/backlog-store.js:122-141. Synchronous literal-true authorization now runs inside the immediate transaction before objective and replay lookup. Exact authorized replay still precedes stale CAS, and the replay branch only returns the current projection. Read test/backlog-store.test.js:489-532: revoked replay is denied, a later authorized exact replay succeeds after another correction advances goal/control revisions, conflicting content rejects, and state/events remain unchanged. Existing task, rollback, checkpoint, and CN08 claim tests remain intact.

Ran: node --check src/backlog-store.js (pass). Ran: node --test test/delivery-contracts.test.js test/backlog-store.test.js test/delivery-events.test.js test/task-scheduler.test.js (55 passed, 0 failed). Ran: git diff -- src/backlog-store.js test/backlog-store.test.js (empty because both files are currently untracked); inspected current source and test lines directly. No source edits.
