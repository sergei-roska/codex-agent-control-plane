# CN-01 adversarial challenge

Current verdict after repair: HOLDS
Initial verdict before repair: BROKEN
Status: complete
Scope expansion: none

## Re-challenge after CN-01 repair

Current verdict: HOLDS for the targeted repair. The four findings below are historical before-repair evidence and no longer reproduce.

Exact command: `node .agents/teamwork/delivery-contracts-challenge/probe.cjs` from repository root. Results: active/missing/newly introduced supersession lineage rejects with `supersession_lineage_immutable`; malformed checkpoint containers reject with `checkpoints_array_required`; Ajv rejects `src//x` while JS returns `path_unsafe`; missing standalone successor rejects with `dependency_successor_missing`; duplicate edges to a real successor reject with `dependency_duplicate`. The duplicate missing-successor case rejects at the first missing reference. No unexpected acceptance was observed.

Additional targeted probes in the same file: preserved existing supersession lineage is accepted, lineage removal is rejected, and two distinct dependency tuples containing colon IDs are accepted. Inspection confirms tuple keys use `JSON.stringify` over the component array and successor existence is checked against all resulting task IDs before graph projection. Inline/standalone overlap remains an intentional replacement for a revisioned successor, as described in the repair handoff.

Focused suite: `node --test test/delivery-contracts.test.js`, 16 passed, 0 failed. Product files remained read-only during re-challenge. The probe is ignored teamwork evidence and may disappear during cleanup.

## Failure 1: existing-task replacement bypasses supersession checks

Probe: `.agents/teamwork/delivery-contracts-challenge/probe.cjs`, cases `replacement-supersedes-active` and `replacement-supersedes-missing`.

Input: current projection has task A in `running` (or lacks A entirely), and queued task B at revision 1. The delta replaces B at revision 2, with `expectedRevision: 1` and `supersedesTaskId: 'a'` (or `'missing'`).

Expected: typed rejection. New-task supersession already requires the referenced task to exist, have a matching expected revision, and be mutable. An existing-task replacement should not be able to introduce an unchecked supersession reference to an active or absent task.

Actual: `validatePlanDelta` accepts both deltas. The `supersedesTaskId` checks run only when `!previous`; the existing-task branch checks B only. An accepted delta therefore contains a dangling or active-target supersession reference. This matters before CN-03 storage chooses how to consume that field.

Exact repro: `node .agents/teamwork/delivery-contracts-challenge/probe.cjs` from repository root. Source branch: `src/delivery-contracts.js` around lines 348-376.

## Failure 2: malformed checkpoint projection leaks TypeError

Probe: same file, cases `malformed-checkpoints-object` and `malformed-checkpoints-string`.

Input: otherwise valid current projection with `checkpoints: {}` or `checkpoints: 'bad'`, empty delta.

Expected: `DeliveryContractError` with stable code/path, consistent with malformed references in the CN-01 gate.

Actual: `TypeError: checkpoints.entries is not a function or its return value is not iterable`. `validatePlanDelta` checks that the projection is plain JSON, then passes truthy `checkpoints` to `validateDependencyGraph`, which assumes an array. Exact repro command above.

## Failure 3: schema accepts a path rejected by the JS validator

Probe: same file, cases `task-double-slash-validator` and `task-double-slash-schema`.

Input: valid task with `productWritePaths: ['src//x']`.

Expected: structural schema and pure validator agree on safe relative path grammar.

Actual: `validateTask` rejects `path_unsafe`; draft-07 Ajv accepts the task. The schema path regex omits the validator's empty-segment rule. Exact repro command above.

## Failure 4: standalone dependency with missing successor disappears from validation

Probe: `.agents/teamwork/delivery-contracts-challenge/probe.cjs`, cases `standalone-edge-missing-successor`, `standalone-edge-duplicate-missing-successor`, and control case `standalone-edge-duplicate-valid-successor`.

Input: current projection has task A; delta has no task changes and one standalone dependency A -> missing. The duplicate case submits the same edge twice.

Expected: typed rejection for unknown successor, and duplicate rejection for repeated edges. The target design explicitly rejects unknown references and duplicate task identities/edges.

Actual: both the single and duplicate missing-successor deltas are accepted and returned with their dangling edges. `validatePlanDelta` adds standalone dependencies only while mapping over resulting tasks; a missing successor is never attached to a task, so `validateDependencyGraph` never sees it. The control case with two identical edges to a real new successor B fails with `dependency_duplicate`, confirming the probe reaches graph validation when the successor exists.

Exact repro: `node .agents/teamwork/delivery-contracts-challenge/probe.cjs` from repository root. Source branch: `src/delivery-contracts.js` around lines 386-394.

## Passed attack classes

Focused suite: `node --test test/delivery-contracts.test.js` passed 12/12. Existing focused cases exercised stale CAS, active and terminal direct mutation, graph missing/self/cyclic references, duplicate task IDs, and planner-forged success/publication. The standalone trusted `validateTask` intentionally permits settled states, while plan proposals do not.

## Limits

CN-01 source and schema are untracked in the current dirty baseline, so no committed pre-change counterpart exists for a historical regression comparison. The failures were validated against the stated contract and alternate branches in the current implementation. The probe is in an ignored teamwork directory and may disappear during workspace cleanup.

Pitfall: validate reference fields on every update route, and check projection container types before passing them to nested validators.
