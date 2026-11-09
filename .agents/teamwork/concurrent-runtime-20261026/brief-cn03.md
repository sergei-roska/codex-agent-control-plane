# CN-03: transactional backlog and events

Project: /home/sr/Projects/Workspace/codex-agent-control-plane.
Read worker TOML developer_instructions and development-access.md under
/home/sr/codex-work; read project AGENTS.md. ASCII English reports/files.
Read .codex/pitfalls.md if present. Root owns Git and tracked docs. Preserve
dirty baseline. Node v24.22.1, better-sqlite3 installed. No live databases,
services/restarts, network/model turns, commits or target-project mutations.

Allowed product ownership: new src/backlog-store.js, src/delivery-events.js,
test/backlog-store.test.js, test/delivery-events.test.js only. Own local notes
under .agents/teamwork/backlog-store/. Do not change durable-store, contracts,
candidate store or any legacy caller. Report necessary scope expansions first.

Read CN-03 in docs/architecture/concurrent-harness/implementation-plan.md and
its local gate, target-design.md identities/states/readiness/claims/capacity,
src/delivery-contracts.js, test/delivery-contracts.test.js, src/durable-store.js.
Pure CN-01 records are the existing boundary. No schema or legacy graph rewrites.

Implement a reusable BacklogStore over injected existing better-sqlite3 db (or
state.db); export class and optional factory. Table creation is additive here,
not startup wiring. Use synchronous immediate transactions and FULL durability
assumptions of the supplied connection. Fake clock and deterministic ID hooks
are injectable. No network await in transactions. Task contracts and execution
history remain separate; keep contract copies pinned on attempts.

Required API behavior (choose compatible argument details and document exports):
- Create/get objective and projection including plan/goal/authority/control
  revisions; applyPlan re-reads current rows under transaction and validates CAS,
  graph and proposal-only authority via validatePlanDelta before any write.
  Implement actual normalized delta projection including supersession and edges.
- Keyset-paginated project/objective backlog with stable IDs and bounded limit;
  readiness rechecks dependencies under claim transaction. Requires_output and
  integration_after wait for trusted settled output; checkpoint acceptance is
  explicit injected/controller evidence, never inferred from a planner state.
- claimReady reserves task, role/project capacity, claim/fence and attempt intent
  atomically with event. Finite configurable role and total ceilings, reserved
  planner capacity, captured control revisions. Count settling/unknown/fenced
  claims. Fence/generation checks apply to every mutation. Use deterministic
  provider context derived from stable attempt identity, distinct retry numbers.
  Respect non-executing objective states; no claims after pause/cancel/control CAS.
- recordSubmitted, heartbeat, terminal settlement/reconciliation primitives for
  CN-05. One terminal settlement; duplicate identical result idempotent,
  conflicting/stale result refused. Release only on explicit remote/process
  quiescence and settled effects; expired lease only marks recovery pending,
  preserving task/capacity/fence. Expose current claims/attempts/capacity.
- DeliveryEvents: project monotonic sequences, stable event IDs/dedupe keys,
  bounded validated payloads, payload-conflict rejection on duplicate key,
  durable monotonic consumer cursors and paginated replay. Append state/event
  in the caller's same transaction. Failed append must roll back state and
  capacity. Cursor cannot skip nonexistent future events or move backwards.

Successor interfaces (executor/checkpoints/planner) may be injected trusted fakes
for this local gate. Do not implement future packages or claim runtime wiring.
Avoid a broadly permissive arbitrary state setter or planner checkpoint bypass.

Acceptance: two real SQLite connections/disposable DBs prove one claim per task,
role/project reservation limits, stale plan rollback, dependency cycle rollback,
event atomicity/failure injection, event dedupe/cursor restart, immutable claimed
contracts, expired live/unknown attempts retain capacity and cannot be retried.
Use barriers/causal order, not timing sleeps. Run focused node:test, syntax/diff
checks. Write brief.md and handoff.md with actual exports, exact commands/results,
remaining limits. Independent critic and challenger are required after your work.
