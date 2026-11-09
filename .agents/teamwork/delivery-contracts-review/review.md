# Verdict: APPROVE after re-review

The planner authority blocker below is resolved. [read] `validatePlanDelta`
checks every proposed task before new/superseding/replacement branches: only
`draft`, `queued`, `blocked` states and `denied`/`unknown` publication authority
are accepted. Trusted `validateTask` remains broad for genuine settled records.
The plan-delta schema references a narrowed `plannerTask` with matching state
and publication enums. [ran] Direct probes reject succeeded and granted planner
proposals while accepting queued/unknown and a trusted succeeded/granted record;
focused tests pass 12/12, syntax and `git diff --check` pass.

## Historical blocker resolved

## Blocking

1. `src/delivery-contracts.js:332-345` [ran/read]: `validatePlanDelta` accepts a newly proposed planner task with `state: 'succeeded'` and `publicationAuthority: {state:'granted'}`. An empty current projection plus one such task returned `ACCEPTED succeeded granted` in a local Node probe. `validateTask` permits those record values for trusted store records, but the plan-delta caller does not restrict what the planner may propose. This lets a planner assert completed output and publication permission before an attempt or controller authorization exists. Restrict new/superseding planner tasks to pre-execution states and controller-safe publication authority; reject a queued replacement that escalates authority. Keep trusted record validation broad enough for genuine settled history.

## Checks and scope

- [ran] `node --test test/delivery-contracts.test.js`: 11/11 pass; this case is untested.
- [read] New `src/delivery-contracts.js`, schema and test plus CN-01 brief/local gate. The module is unwired and has no runtime effects yet.
- [read] Dependency-only changes to an existing successor require an explicit task revision at lines 359-364; this resolves the root's earlier bypass finding.
- [read] No reviewed source/test/config was edited. No live service, database, model call or Git state change.

The decisive probe used a valid versioned task with empty dependencies, safe path,
and one empty current objective projection. Only `state` and
`publicationAuthority.state` were set to terminal/granted. The validator returned
the plan rather than a `DeliveryContractError`.
