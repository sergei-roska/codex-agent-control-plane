# Candidate review handoff

Status: partial; source frozen at quota stop for lead/independent review.

## Verified interfaces

- CandidateStore exports `CandidateStore`, `captureManifest`, `validateManifest`, and supports `createCandidate`, `projectDeliveryCandidate`, `readManifest`, `materialize`, `addReference`, `removeReference`, and `collectGarbage`.
- Candidate manifests cover tracked and nonignored untracked regular files, Git HEAD, bytes and executable mode. Materialized read-only mode is advisory; consumers must compare before/after manifests and refuse altered review inputs.
- BacklogStore checkpoint inventory contract is `checkpointInventory({projectId,objectiveId})`, synchronous minimal refs; this worker keeps inventory injected and avoids raw backlog SQL.
- TaskScheduler accepts synchronous `isFrozenReview` and review admission injection; its task policy permits no review proof based on `baseCandidateId` alone.
- Existing `src/review-policy.js` and acceptance helpers remain unchanged and authoritative for legacy flows.

## Files and current API

- `src/delivery-review-policy.js`: canonical digests, bounded identities/pins, attested closure normalization, conservative scope independence, promotion identity checks, evidence-bound dependency edges, frozen-review validation, and validated delivery/v1 receipt projection.
- `src/candidate-review.js`: `CandidateReviewStore` with injected current-objective, checkpoint/proposal authorization, closure, execution/attempt, promotion, and event adapters. Methods: `registerCheckpoint`, `checkpointInventory`, `proposeReviews`, `getReviewTask`, `isFrozenReview({task,live})`, `prepareReviewInput`, `verifyReviewInput`, `settleReceipt`, `getReceipt`, `qualification`, `promoteReceipt`, `canReviewTogether`, and `isFinalStabilized`.
- Review task proposals return `{task,attemptId,threadId,context}`; scheduler-facing task is kept as a delivery/v1-compatible record and internal identity joins are held in the review registry. Read-only materialization is rehashed before/after; chmod is not treated as enforcement. Receipt/event writes share a SQLite transaction; candidate refs protect contexts, receipts and promotions.
- New tests: `test/candidate-review.test.js` and `test/delivery-review-policy.test.js`.

## Verification and open issues

- Syntax checks passed for both source files and both tests.
- `node --test test/candidate-review.test.js test/delivery-review-policy.test.js`: 5 passed, 1 failed on final run. Remaining failure is `canReviewTogether` across two distinct checkpoints at `test/candidate-review.test.js:129`; investigate why the registered closure pair is rejected. The prior frozen-copy, candidate G+1, byte-tamper, scheduler-binding, trusted settlement, duplicate settlement, reference/GC/reopen path passes.
- The second test proceeds past the independent-review assertion only after that repair; promotion behavior is not yet verified on this last run.
- Review attempt IDs are currently reserved in proposals. Integration must confirm how BacklogStore-assigned actual attempt IDs are bound; do not rely on caller/model identity fields. Reconcile this with the real controller/scheduler adapters before acceptance.
- Still required: fix the remaining focused failure, settle attempt-ID ownership, add stale owner/check/pin/dependency-drift and unknown-closure promotion probes, verify full checkpoint dependency ancestry and immutable receipt behavior after reopen, send exact adapter contract to controller/backlog owners, then freeze for authority/concurrency critic and targeted dependency/snapshot challenge.
- Source qualification is incomplete. No engine integration, live execution or rollout was performed.

## Pending

Read delivery event/contract details and newer shared/controller interfaces; implement the owned modules and tests; run focused checks; send API compatibility notes to root/controller worker; freeze for review/challenge.
