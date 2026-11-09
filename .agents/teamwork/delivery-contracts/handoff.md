# CN-01 handoff

Status: implementation starting.

Owned files: `src/delivery-contracts.js`, `schemas/delivery-v1.schema.json`,
`test/delivery-contracts.test.js`.

Scope is pure validation/projection only. No legacy wiring, DB, services, model,
Git mutation, or target project actions. Plan API and schema are to be documented
in source exports and validated by focused tests.

Pending: inspect, implement, run focused tests and syntax/diff checks, update this
handoff with exact evidence.

## Implemented milestone

Added pure validators and the draft-07 schema for objective, task, dependency,
attempt, claim, event, candidate, receipt and plan delta. The record API returns
JSON clones, uses `DeliveryContractError` with stable `code` and `path`, bounds
plain JSON, validates safe relative paths and explicit product/scratch/resource/
publication dimensions, and keeps unknown read scope explicit. Dependency graph
checks task/checkpoint project and objective identities, self/missing/duplicate
edges and cycles. Plan CAS checks plan/goal/authority/control revisions and task
revisions; queued contract changes and explicit supersession carry revision
semantics, while claimed/running/settling and terminal tasks cannot be changed.

Root spot-check found that dependency-only deltas could mutate active task edges.
Fixed by requiring an existing successor task to have an explicit revisioned task
replacement in the same delta before its edges can change. Regression covers active
and succeeded tasks. Resulting projection also checks every task against the
current project/objective identity.

Verification after this fix: `node --test test/delivery-contracts.test.js` 11 pass,
0 fail. Full final syntax/schema/diff checks pending.

## Final verification

- `node --test test/delivery-contracts.test.js`: 11 passed, 0 failed.
- `node --check src/delivery-contracts.js`: passed.
- Draft-07 Ajv smoke: task and plan delta fixtures passed (2 passed, 0 failed).
- `git diff --check -- src/delivery-contracts.js schemas/delivery-v1.schema.json test/delivery-contracts.test.js`: passed for tracked diff; files are new/untracked.
- ASCII and trailing-whitespace scans on the three owned files: passed.

Exports: `DeliveryContractError`, record-specific validators, `validateRecord`,
`validateDependencyGraph`, and `validatePlanDelta`; constants expose version,
limits and state/edge enums. Schema includes all eight records plus plan delta.
The schema describes structural bounds; cross-reference, graph-cycle and CAS
rules remain in the pure validator. No legacy wiring or external side effects.

## Independent review correction

Critic rejected a direct planner-authority boundary: a newly proposed task could
claim `succeeded` and `publicationAuthority.state=granted`. Trusted record
validators intentionally accept durable settled/controller records, so the fix
belongs specifically in plan-delta validation. Before editing, hypothesis: apply
one proposal-only predicate to every `input.tasks` entry, regardless of whether
it is new, superseding, or a queued replacement; keep standalone record validation
broad. Mirror that narrower contract in the plan-delta schema and test each route.

Correction for independent critic rejection: `validatePlanDelta` now permits planner
proposals only in `draft`, `queued`, or `blocked` states and only with publication
authority `denied` or `unknown`. This applies uniformly to new tasks,
superseding tasks, and revisioned replacements; trusted `validateTask` remains
broad for settled/controller-owned records. The planDelta schema narrows the same
two fields through `plannerTask` and `plannerPublicationAuthority` definitions.

Verification after correction: focused node:test 12 passed, 0 failed; syntax
passed; Ajv draft-07 accepted one valid planner delta and rejected one
succeeded/granted delta; ASCII/trailing-whitespace scans passed. Existing
regression still rejects dependency-only edits to active and succeeded tasks.
