# CN-12 staged acceptance adapter

Owner: /root/cn12_acceptance. Root owns Git and tracked docs.

## Objective

Prepare the new final acceptance adapter and disposable acceptance fixtures while
CN-11 owns backlog-store, task-executor, controller, and lifecycle files. Final
CN-12 qualification depends on CN-11 freeze and integration.

## Allowed files

- New `src/delivery-acceptance.js`
- New `test/delivery-acceptance.test.js`
- Narrow typed read-only `src/candidate-review.js` and
  `test/candidate-review.test.js` ownership granted by root 2026-10-27 for
  `finalizationProjection` only. Do not change settlement or promotion writes.
- Narrow `src/acceptance.js` and `src/workspace-snapshot.js` environment-injection
  ownership granted by root 2026-10-27 after the hostile Git environment probe
  showed inherited `GIT_CONFIG_COUNT` still executed a candidate filter during
  the downstream acceptance snapshot. Preserve legacy defaults.
- This local handoff directory

Do not edit CN-11 files or existing candidate/review/ledger modules without an
explicit ownership grant. BacklogStore ownership is currently returned to root
pending CN-11's scoped retry correction and refreeze. No Git mutation,
dependencies, services, model/account calls, or target edits.

## Early proposed typed store contract

- `beginFinalization(...)`: immediate CAS on project/objective, owner generation,
  control, goal, plan, authority, requirement/check digests; refuse if relevant
  claims, runnable tasks/reviews, retries/wakeups, or candidate intents remain;
  persist barrier and frozen known-candidate identity with disposition validating.
- `commitFinalization(...)`: exact barrier/pin CAS, atomically record immutable
  acceptance evidence, candidate retention, objective terminal disposition and
  event; exact replay preserves the first record/timestamp; payload conflict is
  typed and non-mutating.
- Typed abort/invalidate and historical/current qualification reads. No generic
  SQL updater. Candidate publication controls must refuse while validating.
- `CandidateReviewStore.finalizationProjection(...)` supplies exact current
  receipt/context/pin and pending-task facts through trusted objective and closure
  resolvers. It is read-only; review proposals and settlements remain unchanged.

Lead accepted this direction on 2026-10-27 and requires a real CandidateStore
publication attempt during the barrier test. Pending `checking`/unknown check
state is not safe to rerun after reopen without trusted lifecycle reconciliation.

Root granted sole `BacklogStore` source/test ownership after CN-11 freeze, then
requested ownership handback before this worker edited those files so CN-11 could
correct retry counters. Ownership was restored after that correction. Typed
finalization APIs are implemented; root later authorized narrow replay-authorization
and blocked-task-readiness fixes during independent store review. See `handoff.md`
for the current state, verification, and pending full qualification.

## Current findings

- `runAcceptance` is exported by `src/acceptance.js`; it requires Git snapshots
  for accepted disposition. Candidate materialization is a detached read-only
  tree, so the adapter needs a disposable Git mirror and independent content
  manifest verification before and after checks.
- `CandidateReviewStore.finalizationProjection` exposes current required
  receipts, closure pins and unsettled review tasks through its trusted callbacks.
- Barrier must not block queued mandatory review work: refuse finalization until
  all relevant review/scheduler work is drained, then atomically pin the current
  candidate.

## Acceptance criteria

Implement the adapter against the typed API frozen by CN-11/root, use real
`runAcceptance`, preserve owner-selected permissions/scratch/check contract,
verify candidate bytes and candidate-bound registry receipts, and never accept
model `goalAchieved` or `trusted` fields as authorization. Test exact replay,
stale pins, candidate publication fencing, check tampering/failure/unknown state,
partial provenance, blockers, rollback, and reopen. Final source qualification
requires root integration plus independent review and focused probes.
