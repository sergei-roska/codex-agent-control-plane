# Milestone 1: read-only quarantine eligibility predicate

## Decision

Split the quarantine implementation into two sequential milestones. First add
and test a pure synchronous SQLite inspection predicate. It must not open a
database, acquire locks, call a provider, mutate data, or alter ordinary startup.
Milestone 2 will wire the verified predicate into a minimal pre-provider boot.

## Scope

Worker may edit only `src/server.js` and `test/server-delivery-engine.test.js`
for this milestone. Preserve all current user-owned changes in those files.
Do not edit the live database or start any service/provider. No commit.

## Suggested interface

Add/export a pure helper, e.g. `inspectConcurrentStartupQuarantine(db,
workspace, projectId)`, returning a small deterministic classification:

- `{ state: 'none' }` if no shutdown-phase row exists;
- `{ state: 'released' }` for an exact released phase;
- `{ state: 'provider_closing' }` so milestone 2 can keep ordinary recovery;
- `{ state: 'quarantine', runId, objectiveId, sessionId }` only for the exact
  evidence predicate below;
- `{ state: 'unsafe' }` for malformed, unsupported, missing, live, or mismatched
  interrupted evidence.

The helper receives an already-open database; it must issue SELECT/PRAGMA only.
Do not make an RW connection appear read-only by convention in its tests.

## Exact quarantine predicate

1. Phase table has its expected project_id/phase_json columns. Phase row matches
   project; JSON is an object with exactly `phase`, `attempts`, `identities`.
   `draining` requires both arrays empty. `released` and `provider_closing`
   classifications require both properties to be arrays; every provider-closing
   identity must have valid pid/pgid/startTime and a gone process group.
   Malformed shapes are `unsafe` rather than passed into normal startup.
2. If the shutdown-phase table does not exist, classify `none`; otherwise
   planner turn/facts tables and required columns exist. Across the project,
   exactly one turn is active/unknown and it is `active`; all other planner rows
   must have one of the established terminal statuses `complete`, `stale`, or
   `reconciled_no_effect`. Its pins' ownerGeneration and fact identity match
   project/session/thread/scope/turn; the pins object does **not** contain
   project/session/turn fields. Active row has no result; matching fact has null
   terminal, start thread matches, process identity has exact pid/pgid/startTime
   types, and `isProcessGroupGone()` proves it absent.
3. Exactly one `delivery_run_engines` mapping binds the turn session to a
   `concurrent-v1` run, with consistent `concurrent_delivery_runs` project/run/
   objective/session and `backlog_objectives` project/objective/session. The
   objective is `canceled`; SQL `backlog_objectives.owner_generation`, planner
   pins, and planner fact identity generation must match exactly. The normal
   `record_json` schema omits `ownerGeneration`; if that optional JSON property
   is present, it must also match the SQL/planner generation.
   Do not compare the old provider identity to a current provider (none is
   started in quarantine).
4. Reuse or safely factor existing read-only checks in `concurrentRunSettled`
   (`src/server.js:78-145`) while allowing only the exact validated active
   planner row for this one call; keep all existing callers unchanged. Require
   the tables themselves to exist (not just optional-table absence):
    `backlog_attempts`, `backlog_claims`, `delivery_role_executions`,
    `candidate_intents`, `delivery_output_publications`,
    `delivery_output_bindings`, `concurrent_controller_fences`,
    `writer_executions`, `task_executor_attempts`, `task_executor_evidence`,
    and `task_executor_thread_reservations`. Every backlog attempt must parse to state succeeded,
   failed, or canceled and have a nonempty terminal digest; every claim parses
   as `released`; role executions parse and match project/objective/attempt/state
   with `effectsSettled===true`; candidate intents are only applied/refused/
   not_applied; publications are only applied/refused (not `not_applied`,
   matching `#effectsSettled` at engine lines 1847-1859); and referenced candidate
   intents bind the same project/objective and terminal state. Any unresolved
   writer execution for `fs.realpathSync(workspace)` blocks; unexpected writer
   states are unsafe too. An unsafe controller fence projection also blocks.
   These settlement checks are project-wide, not
   merely scoped to the active objective: any claim, attempt, execution, intent,
   publication, or fence row under another objective must also be settled/safe.
    Every other mapped concurrent run in the same database must satisfy the
    regular `concurrentRunSettled` predicate, except for the narrowly evidenced
    `paused_owner` and terminal-orphan cases in the live-copy refinement below;
    every legacy mapping must bind to a unique terminal orchestrator task. No
    mapped run may have a non-finished dispatch-journal row. The selected
    run/objective rows must be unique. The selected A2A run ID must have exactly
    one mapping across the entire mapping table, and the state DB must not
    contain foreign-project mappings or unknown engine values.
5. Exact task binding: `delivery_run_engines.run_id` is the printable A2A task ID
    (`src/delivery-engine-router.js:65-66,113-129`); require exactly one
    `tasks(tenant='', owner='orchestrator', id=run_id)` row across all tenants
    (there must be exactly one row for owner/id and its tenant is empty). Parse
    its `status` JSON and require state equals `status_state`; allow only
   `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, or
    `TASK_STATE_CANCELED`. Any A2A task in SUBMITTED/WORKING state, regardless
    of owner, blocks. Any non-finished dispatch-journal row for any
    mapped run blocks; use `dispatch_journal.run_id`, and accept only the
    established `finished` state. In strict quarantine checks, a referenced
    candidate intent must also have the same terminal state as its publication.
6. Any missing expected table/row, malformed JSON, duplicate/mismatch, unresolved
    writer/task/publication effect, or unprovable process returns `unsafe`, never
    `quarantine`.

## Live-copy refinement applied and verified

The live copy did not satisfy the original M1 rule verbatim: it has four
intentional `paused_owner` mappings and one orphan concurrent mapping. The
selected active turn and all other effects are settled. The predicate now
handles the additional rows through a narrowly scoped quarantine-only branch;
it does not change ordinary recovery or the default behavior of
`concurrentRunSettled()`.

- An existing `paused_owner` mapping may count as quiescent **only for
  quarantine** when its concurrent run is exactly `paused`, the objective and
  run project/objective/session bindings match, its A2A task row is unique and
  has status `INPUT_REQUIRED` or a terminal state whose JSON matches the status
  column, every planner turn in that session is terminal, and all attempt,
  claim, role, intent/publication, writer, and dispatch checks pass. It remains
    paused and no task route is served. Every project task-executor attempt must
    be `settled` with matching stored identity; evidence must bind an attempt;
    no thread reservation may remain.
- An orphan mapping (both concurrent run and objective rows absent) may count as
  quiescent **only for quarantine** when the mapping IDs recompute exactly from
  project/run/request context, the unique local orchestrator task is terminal,
  the session binds to exactly one `reconciled_no_effect` planner row, its
  identity/pins/start/terminal fact and stored `codex_app_server.thread_read`
  proof match exactly, the original process group is gone, the proof is a
  failed terminal turn, no dispatch rows exist for that run, and no effect row
  (including task-executor attempt/evidence) can be bound to its missing
  objective. Any partial/malformed/mismatched pair
  or absent proof stays unsafe.
- Reject any `SUBMITTED`/`WORKING` A2A task across owners, not only the
  orchestrator namespace. These exceptions authorize read-only diagnostics
  only; they do not authorize normal recovery, new task admission, or changing
  planner/task/objective rows.

## Evidence references

- Planner schema/active status index: `src/lead-planner.js:109-128`.
- Run mapping pins printable A2A task ID: `src/delivery-engine-router.js:32-45,65-101,113-129`.
- Concurrent run schema: `src/concurrent-delivery-engine.js:144-156`.
- Existing settled effect query: `src/server.js:78-145` and
  `src/concurrent-delivery-engine.js:1847-1859`.
- Role-execution schema: `src/delivery-role-service.js:130-138`.
- Task scope: `src/durable-store.js:247-252` and `src/server.js:400-404`.
- Process identity check: `src/process-quiescence.js`.

## Tests

Use a disposable initialized fixture and synthetic rows only. For the positive
case, prefer the existing `idleConcurrentServer` test helper to create the
actual application schema, with its fake App Server and no provider work; use
the real `LeadPlanner` constructor to create planner tables before seeding the
synthetic active turn. Then populate valid settled effect rows. Do not treat
hand-written partial table definitions as production-schema verification.
Cover `none`,
`released`, ordinary `provider_closing`, one positive exactly-bound planner-only
`draining` candidate using a definitely nonexistent PID/PGID and populated
settled attempts/claim/execution/candidate/publication/fence rows, and refusals
for corrupt/missing/mismatched planner facts, multiple active/unknown turns,
live process identity, active claim/attempt/execution/publication/task, bad task
identity/status, planner pins/fact/SQL/JSON owner-generation drift, duplicate
mappings including same run ID bound to another
session, unresolved effects under a second objective, mismatched publication
intent state, foreign project or unknown-engine mapping, and missing required
table/column. Assert the helper makes no DB changes
(row/table snapshot) and does not require normal startup to run.

Report exact tests and any unsatisfied invariant; do not declare overall task
complete. Do not integrate or serve quarantine in this milestone.
