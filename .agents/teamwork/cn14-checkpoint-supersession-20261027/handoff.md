# CN14 checkpoint supersession handoff

Status: active. Owner: `/root/cn14_checkpoint_supersession`.

The implementation is limited to `src/candidate-review.js`,
`test/candidate-review.test.js`, and this owned notes directory. Shared checkout
has pre-existing dirty and untracked work; preserve it. No Git writes or
live/account/shared-service/target actions are authorized.

Verified source facts: CandidateReviewStore currently unions its inventory
adapter with every registered checkpoint. `finalizationProjection()` and
`isFinalStabilized()` consume that inventory; `#checkpointGraph()` also adds all
historical registered rows. Registered checkpoint records are immutable and
contain goal/requirement/check identities, criticality, pins, and dependencies.
`BacklogStore.applyOwnerCorrection()` advances goal and control revisions and
persists the correction source, while keeping owner generation stable.

Proposed typed API was sent to the core engine worker before source edits:
`supersedeCheckpoints(input, authorization)` with one-to-one
`{ checkpointId, replacementCheckpointId }` entries and read-only
`checkpointHistory()` / `checkpointSupersessions()` methods. Added
`isCheckpointActive()` as the direct guard for the injected BacklogStore
intermediate-acceptance callback. The trusted callback gets a frozen context
with normalized owner correction pins, validated owner inventory, old/new
checkpoint snapshots and digests, and the exact mapping. It must independently
attest the source message and semantic owner inventory map. Persisted relations
and the event are written in one immediate SQLite transaction; replay checks
current pins and requires fresh literal-true authorization.

Implemented and verified: active inventory excludes only durably superseded
rows; graph validation, `finalizationProjection()`, and `isFinalStabilized()` use
that same projection. Checkpoint history and receipt rows remain queryable.
Targeted tests cover blocked correction, complete mapping, exact/revoked replay,
source conflict, stale pins, default deny, incomplete coverage, criticality
downgrade, replacement outside owner inventory, cycle rejection, transaction
rollback, receipt/history retention, reopen, and sequential corrections.

Independent review found that pending review rows still included every
historical task. Fixed `finalizationProjection()` to count unbound pending work
only when checkpoint, candidate, and context all match the current active
projection. Bound rows remain pending unless trusted `resolveAttempt` facts
prove a terminal attempt, released claim, and remote/process/effect settlement;
missing facts fail closed. The regression covers a retired queued task, a live
old bound attempt retained until settlement, terminal no-receipt history, and a
current replacement review that blocks until its receipt. Historical task rows
remain stored. Existing BacklogStore/lifecycle guards remain responsible for
actual runnable tasks and live claims.

Verification: `node --check src/candidate-review.js` passed;
`node --check test/candidate-review.test.js` passed;
`env -u NODE_TEST_CONTEXT node --test test/candidate-review.test.js` passed 19/19
tests, 0 failures. Source is frozen for re-review; no startup or
finalization acceptance claim is made. BacklogStore was not edited, so the core
engine integration must use `isCheckpointActive()` before qualifying a
checkpoint dependency. No Git writes, live/account/shared-service/target actions.
