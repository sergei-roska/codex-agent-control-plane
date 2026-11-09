# CN-10 independent review and re-reviews

Verdict: APPROVE
Status: complete
Scope expansion: none

Original critic blockers remain resolved: promotion uses the receipt's immutable context ID and checks its identity (src/candidate-review.js:543-571); proposals validate scoped checkpoint ancestry and emit acceptance edges (src/candidate-review.js:183-220, 270-326). Challenger replay findings remain resolved by semantic receipt and promotion duplicate checks before writes and within their transactions.

Latest structural-reference correction [read/ran]: proposal context reference insertion is inside the same immediate transaction as context/tasks/event at src/candidate-review.js:337-352. Receipt reference insertion follows the in-transaction duplicate recheck and precedes receipt/task/event writes at :508-526. Promotion reference insertion follows its in-transaction duplicate recheck and precedes context/promotion/event writes at :595-619. CandidateStore.addReference uses INSERT OR IGNORE in a nested transaction on the same DB handle (src/candidate-store.js:474-480); rollback of the outer transaction includes that savepoint. No unconditional cleanup remains that could delete a previously committed winning reference.

The new stale-preflight tests are valid: receipt and promotion winners commit from public API calls during the losing call's now() callback, before the loser starts its immediate transaction (test/candidate-review.test.js:315-377). The proposal winner commits from authorizeProposal before the loser starts (test/candidate-review.test.js:390-420). An old challenger monkeypatch that starts a winner after the loser already holds the same connection's outer transaction creates a nested savepoint, so it cannot model an independently committed winner; its outer rollback is expected.

Ran `node --test test/candidate-review.test.js test/delivery-review-policy.test.js`: 18 passed, 0 failed. Ran `node --check src/candidate-review.js`: pass. Reused current worker adjacent 60/60 evidence because those modules were unaffected. Source/test files are untracked, so `git diff --` is empty; current bounded lines and prior observed code were compared directly. No source, tests, fixtures, or Git state changed by critic.
