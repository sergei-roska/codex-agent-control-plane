# CN-10 continuation handoff

Status: reference-atomicity corrections complete; frozen for same-critic and adapted-challenger rerun.

## Latest correction

- Candidate references for proposed contexts, settled receipts, and promotions are now inserted through `CandidateStore.addReference` inside the same shared-DB `BEGIN IMMEDIATE` transaction as their context/receipt/promotion rows and event. Removed unconditional `removeReference` cleanup catches; a rollback now undoes only the transaction that created the reference.
- Receipt and promotion commands recheck their semantic uniqueness inside the transaction before adding a reference. A stale preflight loser returns the original exact replay or a stable typed conflict without mutating references.
- Candidate existence is checked again by `addReference` while the transaction lock is held.
- Added public-call interleaving tests at the pre-BEGIN boundary for conflicting receipt/promotion winners, and a same-context proposal winner with event failure in the loser. Tests assert one record, event and reference, then run GC and reopen the DB to confirm protected candidates remain.
- Existing event-failure tests confirm receipt, promotion, proposal context rows, events, and references roll back together.

The old challenger addReference monkeypatch invokes a supposed winner after the loser has entered its outer immediate transaction on the same DB handle. That operation is a nested savepoint and cannot independently commit; the outer rollback correctly rolls it back. Root agreed this is not a valid independent-winner interleaving. Permanent tests trigger winners before the losing transaction begins, and the challenger is adapting its probe accordingly.

## Earlier corrections retained

Promotion uses the receipt's exact immutable context ID and verifies context/receipt/candidate/pin identity. Proposal validation uses the scoped registered checkpoint graph and requires complete declared ancestry in the attested closure. Shared read-only paths remain eligible when ancestry and execution resources are independent.

## Verification

- `node --test test/candidate-review.test.js test/delivery-review-policy.test.js`: 18 passed, 0 failed.
- `node --test test/delivery-contracts.test.js test/task-resource-policy.test.js test/task-scheduler.test.js test/backlog-store.test.js`: 60 passed, 0 failed.
- `node --check src/candidate-review.js` and `node --check src/delivery-review-policy.js`: passed.
- The challenge probe's first five replay/identity/rollback cases pass. Its two old addReference-monkeypatch cases fail because their same-handle nested winner is rolled back with the outer loser; the adapted permanent pre-BEGIN interleaving regressions pass.

Only owned CN-10 source/tests and local handoff were edited. No Git staging/commit, runtime activation, deployment, or target action.
