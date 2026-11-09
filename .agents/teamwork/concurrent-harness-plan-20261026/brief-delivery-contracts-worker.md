# CN-01: versioned delivery contracts

Read /home/sr/codex-home/agents/worker.toml developer_instructions first.
Cwd /home/sr/Projects/Workspace/codex-agent-control-plane, Node CommonJS/node:test.
Owner authorized implementation of concurrent Harness. Design critic APPROVE in
.agents/teamwork/concurrent-harness-plan-20261026/design-review.md.

You own NEW src/delivery-contracts.js, schemas/delivery-v1.schema.json and
NEW test/delivery-contracts.test.js only. Root owns Git and docs; active UI worker
owns role/API/AppServer/UI files; performance worker owns performance.js/tests.
Do not touch legacy schema/contracts or graph, package dependencies, DB/services,
Git state, existing dirty files or target projects. Keep own brief/handoff under
.agents/teamwork/delivery-contracts/. English/ASCII for all artifacts/messages.

Read docs/architecture/concurrent-harness/{target-design,role-policy}.md and CN-01
+ local gate from implementation-plan.md. Baseline current source is dirty;
new module is disabled/unwired until later integration and must preserve old engine.
Deliver actual code/tests, not only design. Scope is PURE validation/projection:
no SQL/filesystem/network/model calls and no authority inference from role name.

Goal and exact local gate:
Versioned objective/task/dependency/attempt/claim/event/candidate/receipt and plan
contracts, stable IDs independent of run/round/index, cycle/reference checks,
read/write/scratch/resource/publication distinction, immutable active task revisions
and stale expected revision/authority guard. Integration scenarios in validation.md
are future coverage and do not require successor scheduler/store implementation.

Suggested API (choose idiomatic precise names and document exports):
- typed DeliveryContractError with stable code and path;
- validate/normalize delivery records and plan delta without mutating input;
- validate dependency graph over explicit requires_output/requires_acceptance/
  integration_after edges, with explicit task vs checkpoint references;
- validatePlanDelta(currentProjection, delta): compare expected plan/authority/
  goal/control revisions; reject edits to claimed/running/settling task contracts,
  allow safe reprioritization/superseding only with explicit revision semantics;
- pure capacity defaults/policy may be imported later, but no role source edits.

Data semantics:
projectId/objectiveId/taskId/checkpointId/candidateId/attemptId are stable opaque,
bounded printable IDs, not indexes; attempts keep immutable task revision and
fencing token. All records must be plain bounded JSON, safe relative product/
scratch paths (no absolute, traversal, escape), finite integers for revisions/
counts/times, enum states/edge kinds with unambiguous error paths. Unknown read
scope remains explicit rather than pretending allowedFiles is complete dependency
proof. Control/requirements/check/profile/tool/skill digests are pinned references,
not secrets. Task output success is distinct from checkpoint acceptance.

Use the minimal fields/contracts from target-design, enough for CN-03 backlog CAS,
claims and future adapters. JSON schema must align with actual validator, not be
a broad misleading placeholder. Preserve nullable unknown fields, project identity
on cross-record references, and immutable evidence/history; do not support arbitrary
patch operations over attempt/receipt history. No new provider/account routing.

Tests must cover actual bad records, dependency self/cycle/missing/cross-project
references, stale plan vs owner correction/completed task, same-role distinct tasks,
unknown read scope vs write permissions, active contract immutability, finite
capacity/revisions and valid realistic fixtures. Do not overbuild a generic workflow
framework. Run node --test test/delivery-contracts.test.js and syntax/diff checks.
Return concise exports/schema choices, exact test counts, assumptions, changed
files and handoff. Independent critic and targeted challenger follow before CN-03.
Fresh native quota2026-10-26T17:02:38Z48%fivehour76%weeklyremaining.
