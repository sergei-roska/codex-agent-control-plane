# CN-03 handoff

Status: implementation complete; independent critic and challenger remain
required by the lead.

## Review repair audit before edits

The critic reproduced `markExpired` changing a claim to `expired` and its
attempt to `unknown`, followed by `recordSubmitted` restoring `active`/`running`
with a new remote ID. It also found `null` can be treated as an unset external
identity by optional contract validation. Initial hypothesis: the shared
mutation helper intentionally permits expired claims for recovery, while
`recordSubmitted` lacks method-specific transition and identity checks. Add a
strict active-claim/claimed-attempt precondition, allow only identical replay
after submission, and validate a non-empty bounded ID before any mutation.

## Review repair delta

`recordSubmitted` now accepts only an active claim. First submission requires
attempt state `claimed`; repeat submission is idempotent only for state
`running` and the same external ID. A different identity conflicts. Null,
undefined, empty, whitespace-only, over-256-character, and control-character
identities reject before database mutation. Expired claim submission returns
`claim_inactive` and leaves the attempt `unknown`; the recovery route remains
`reconcileAttempt` with explicit facts.

Repair verification:
- `node --check src/backlog-store.js`: passed.
- `node --test test/backlog-store.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 36 passed, 0 failed.
- Regressions cover expired submission, identity bounds, same-ID replay, and
  conflicting-ID refusal.

## Challenger repair delta

`reconcileAttempt` now requires an explicit object with a terminal `state` of
`succeeded`, `failed`, or `canceled`. Missing or invalid result data rejects
before settlement and preserves the unknown attempt, settling task, fencing
claim, and capacity reservation. Explicit quiescence/effects facts remain
strict booleans. Objective-scoped backlog paging now honors the returned
`nextCursor` through `afterCursor`; legacy `afterTaskId` remains supported.

Repair verification:
- `node /tmp/cn03-recovery-probe.js`: rejects with `terminal_result_required`;
  attempt remains unknown, task settling, capacity 1.
- `node /tmp/cn03-pagination-probe.js`: second page returns `u`; `afterTaskId`
  compatibility also returns `u`.
- `node --check src/backlog-store.js`: passed.
- `node --test test/backlog-store.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 37 passed, 0 failed.

## Files and exports

Product files are `src/backlog-store.js`, `src/delivery-events.js`,
`test/backlog-store.test.js`, and `test/delivery-events.test.js`.
Backlog exports `BacklogStore`, `createBacklogStore`, and `stableDigest`.
Event exports `DeliveryEvents`.

`BacklogStore` API: `createObjective`, `getObjective`, `applyPlan`,
`requestControl`, `advanceOwnerGeneration`, `claimReady`, `recordSubmitted`,
`pinSelectedSettings`, `heartbeat`, `settleAttempt`, `markExpired`,
`reconcileAttempt`, `projectBacklog`, `projectCapacity`, `listClaims`, and
`listAttempts`. `claimReady` requires the current persisted `ownerGeneration`
and `controlRevision`. Project capacity settings are fixed by first objective
creation and shared across objectives in that project. Independent projects
have independent counters. `applyPlan` persists the fully projected task
records including superseded predecessors and merged dependency edges.

Attempt rows retain a separate immutable task contract snapshot. When no
`selectedSettingsResolver` is injected, attempts explicitly say
`selectedSettingsKnown: false`; callers must pin settings with
`pinSelectedSettings` before submission. The resolver is synchronous and its
output is hashed, not stored. Reconciliation after generation takeover needs
current `recoveryGeneration` and explicit remote quiescence, process quiescence,
and settled-effects facts. Checkpoint acceptance is false unless the injected
controller callback confirms it.

`DeliveryEvents` exposes `append`, `appendInTransaction`, `replay`, `cursor`,
and `advanceCursor`. Event IDs derive from the serialized project/sequence
identity; payload conflicts under an existing dedupe key reject.

## Verification

- `node --check src/backlog-store.js`: passed.
- `node --check src/delivery-events.js`: passed.
- `node --test test/delivery-contracts.test.js test/backlog-store.test.js test/delivery-events.test.js`: 35 passed, 0 failed.
- Focused tests use temporary/disposable SQLite databases, including two
  separate worker-thread connections synchronized before claim, database reopen
  for cursor replay, injected event failure rollback, stale plan/cycle rollback,
  project-wide capacity, generation fencing, settings pinning, lease recovery,
  explicit controller fact types, and execution during the planning projection.
- No live services, project databases, models, network, commits, or Git metadata
  were touched.

## Limits and next step

There is no startup wiring or CN-05 remote execution adapter. The actual
provider settings resolver and trusted checkpoint/settlement evidence must be
provided by successors. The lead owns Git and durable docs. Independent critic
and targeted challenger should review this frozen scope next.
