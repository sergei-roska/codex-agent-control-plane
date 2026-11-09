# Objective extensions handoff

Status: implementation and owned test file complete; backend cross-file gate and independent review pending. Source is frozen for quota stop.

## Baseline and initial hypothesis before source edits

The current `BacklogStore` exposes no `applyOwnerCorrection` or injected
`checkpointInventory`. `applyPlan` obtains its pure validation projection from
`getObjective`, whose checkpoints currently come only from the initially stored
list. The scheduler `canClaim` hook and related race regressions are present in
current source and must remain intact.

Initial hypothesis: the extension can stay bounded to additive tables plus
narrow methods. Corrections will require trusted callback confirmation, CAS,
exact allowed fields, and durable source-message dedupe before mutating the
objective/task projection. Checkpoint registry references can be synchronously
validated and unioned into the projection inside the existing immediate plan
transaction without making registry presence equivalent to acceptance.

## Implemented API

`BacklogStore` constructor callbacks:
- `ownerCorrectionAuthorized({ projectId, objectiveId, sourceMessageId, correction })`; synchronous literal `true` is required, default is deny.
- `checkpointInventory({ projectId, objectiveId })`; synchronous array of at most 500 exact `{ projectId, objectiveId, checkpointId }` references.

`applyOwnerCorrection(projectId, objectiveId, correction)` accepts exactly
`sourceMessageId`, `expectedGoalRevision`, `expectedAuthorityRevision`,
`expectedControlRevision`, and `requirementDigest`. It applies durable
source-message idempotency, increments goal/control revisions, preserves
authority/checks and non-validating disposition, changes validating to planning,
and blocks unstarted tasks at the same revision with
`owner_correction_replan_required`. Event and task/objective state share the
immediate transaction. It returns the current objective projection. No raw
message is stored or emitted.

`getObjective` unions persisted initial references with the injected inventory.
`applyPlan` obtains this projection inside its immediate transaction, so pure
plan graph validation sees currently registered checkpoint references.
Consistent duplicate IDs deduplicate; malformed, async, oversized,
out-of-scope, or conflicting references reject. Inventory presence does not
grant acceptance; `checkpointAccepted` remains a separate literal-true hook.

Exact API details were sent to `/root` and `/root/delivery_controller`; the
CN-10 candidate-review owner received the minimal inventory contract. CN-09
expects `applyOwnerCorrection` to return the current objective projection,
including on exact source replay.

## Verification and pending work

- `node --check src/backlog-store.js`: passed.
- `node --test test/backlog-store.test.js`: 27 passed, 0 failed. This includes
  existing scheduler regressions and new authority/CAS/replay, task-state,
  rollback, objective-intent, terminal, inventory, and checkpoint readiness
  cases.
- `test/backlog-store.test.js` uses SQLite fixtures to prove correction event
  rollback and registry projection into plan validation without acceptance.
- `test/delivery-events.test.js` and `test/delivery-contracts.test.js` were not
  rerun after these scoped changes due to the lead's quota stop. No full suite or
  independent review was run for this delta.
- No services, project databases, models, network, target project, tracked docs,
  or Git metadata were touched.

Next concrete action: after quota availability, run
`node --test test/delivery-contracts.test.js test/backlog-store.test.js test/delivery-events.test.js`
and syntax/format checks, then request the authority/persistence critic review.
Preserve these source changes if work must be handed off earlier.
