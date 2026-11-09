# CN14 checkpoint supersession review handoff

Re-review verdict: APPROVE, 2026-10-27. Status: complete. Scope expansion: none.
Reviewed the narrow revised source/test delta; files remain untracked, so
`git diff` has no output for them. No reviewed source/test/fixture was changed.

The blocking issue below is resolved. `finalizationProjection()` now counts
unbound review tasks only when the checkpoint, candidate, and immutable review
context match the active projection. A bound historical attempt remains pending
until the trusted attempt resolver reports terminal state, released claim, and
remote/process/effect settlement. The existing BacklogStore readiness check
still fences actual live attempts and claims. Old review rows/receipts stay
queryable.

Verification: `env -u NODE_TEST_CONTEXT node --test test/candidate-review.test.js`
passed 19/19, zero failures. The new regression exercises a retired queued
review, an old live bound attempt, a failed settled old attempt, and a current
replacement review through receipt settlement. No broad suite or live action.

Prior finding and probe are retained below as historical review context.

Blocking finding (read and ran): `src/candidate-review.js:1050-1079` builds
`pendingReviewTasks` from every historical `review_tasks` row, while active
requirements use supersession-filtered `checkpointInventory()`. An owner
correction may retire an old checkpoint with a queued review proposal, but that
unsettled historical review remains pending and `complete` false forever.
`BacklogStore.#finalizationReadiness()` rejects any nonempty pending list at
`src/backlog-store.js:1506-1512`. Fix by limiting pending review tasks to active
checkpoint identities and current relevant candidate/context. Keep historical
review tasks and receipts queryable. Active old attempts/claims still need the
BacklogStore readiness fence and explicit reconciliation.

Decisive in-memory probe: compile only the fixture/helper prefix of
`test/candidate-review.test.js`, create old critical checkpoint and queued
verifier review, apply owner correction, register replacement, and authorize
complete typed supersession. The projection's requirements contain only the
replacement, but `pendingReviewTasks` still contains the old queued task with
`reason:'receipt_missing'`. Assertion of an empty pending list fails. The probe
did not write product or test files.

Verification: `env -u NODE_TEST_CONTEXT node --test test/candidate-review.test.js`
passed 18/18, zero failures. The single in-memory adversarial probe failed as
expected (0/1) with the concrete stale pending task above. No broad suite was
run. Remaining engine callback policy/owner provenance and finalization proof
hook are integration obligations, not findings on this seam.

Historical next action was completed by the worker and accepted in this
re-review. Remaining engine trust composition is outside this narrow seam.
