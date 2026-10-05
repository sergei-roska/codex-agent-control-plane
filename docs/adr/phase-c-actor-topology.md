# ADR: Phase C actor topology (ACT-01)

Status: accepted decision to keep the shared process; defer ACT-02 and ACT-03.
Evidence baseline: `c6b7e69`.

## Decision

Keep the current shared `codex app-server` process and its single supervisor.
The evidence supports defining actor identity separately from role, but does
not establish that a role pool or attempt-scoped processes justify their
startup, memory, and operational costs. Do not claim resource savings or
measured real-world latency from this decision.

Use `runId` as the coordinator actor identity and `attemptId` as the work actor
identity in future contracts. Keep role as the actor's archetype, such as
`engineer` or `verifier`; a role name is not an identity. Current persisted
records distinguish run, assignment, attempt, task, context, and role in
several places, but do not contract or enforce a separate actor identity.
Treat `runId` and `attemptId` as actor identities only in a future contract;
keep assignment, task, context, process generation, and role as their own
identifiers and attributes. This recommendation does not migrate stored IDs or
change runtime behavior.

## Compared topologies

| Topology | Benefits | Costs and limits | Decision |
| --- | --- | --- | --- |
| Shared process (current) | One `CodexAppServer` owns one child and process generation; all turns share its initialized runtime. Existing restart charging, backoff, cooldown, and exhaustion behavior already bounds replacement. | A child failure affects every in-flight lead and worker turn. The process is a shared fault domain. | Keep pending evidence that fault isolation is worth measured overhead. |
| Role pool | Separate process generations can limit a process fault to workers assigned to one pool. | Requires pool ownership, capacity/admission, health/readiness, cancellation, shutdown, and resource accounting. Context compatibility and process memory/startup under representative load are unmeasured. Workspace writer admission remains global even if processes are pooled. | Defer ACT-02. Reopen only with evidence of a material fault-isolation need and matched resource measurements. |
| Attempt-scoped process | An attempt can have an isolated process and lifecycle; a failed attempt need not share a child with unrelated attempts. | Repeats initialization per attempt and adds process supervision and cleanup work. Real startup and memory costs, plus context-reuse behavior, are unknown. It does not remove global writer admission. | Defer ACT-02. No evidence currently justifies the most isolated boundary. |

## Ownership, generations, and dependencies

- The lead orchestrator owns each `runId` lifecycle and creates each
  `assignmentId` and `attemptId` when preparing work (`src/lead-graph.js:796,
  1043-1050, 1099`). It decides whether work is dispatched, resumed,
  reconciled, or accepted.
- The A2A role service owns the A2A task lifecycle and writer execution
  (`taskId`, `contextId`), but does not pass those IDs to
  `CodexAppServer.run`; it passes role, workspace, input, output schema, and
  cancellation signal (`src/a2a-role-service.js:444, 491-502`).
- One `CodexAppServer` instance owns the shared child process and monotonically
  tracked process generations (`src/codex-app-server.js:125, 362, 474,
  689, 745`). The supervisor settles affected in-flight runs by the existing
  per-run outcome rule; it does not replay assignments automatically
  (`docs/supervisor-recovery-contract.md:8`). Its configured default is three
  charged generation endings per 60,000 ms window, with 0, 1,000, and 4,000 ms
  initial backoffs (`docs/supervisor-recovery-contract.md:63-69`).
- Threads/contexts remain dependencies of a task or lead turn, not actor
  identities. A process topology change must preserve context ownership and
  must not assume a thread can move between process generations.
- Writable work continues to use the durable workspace-wide writer lease.
  A process pool must not create per-process write admission or allow concurrent
  writers (`src/writer-admission.js:40, 56`).
- Durable dispatch state retains `run_id`, `attempt_id`, assignment, role,
  context, and task references (`src/durable-store.js:95`). An identity change
  needs an explicit compatibility and migration contract.

## Current resource limits

- `CodexAppServer` permits one active turn per thread and refuses another turn
  on that thread until the current one settles (`src/codex-app-server.js:745`).
- Lead dispatch can submit every pending assignment in a read-only parallel
  batch; the code defines no explicit batch-size cap. Writable batches dispatch
  one target at a time, and the durable workspace writer lease remains the
  cross-run admission limit (`src/lead-graph.js:1035-1040, 1099-1102`,
  `src/writer-admission.js:40, 56`).
- The supervisor bounds charged restarts, backoff, and cooldown, but there is
  no measured process-memory budget or numeric pool capacity to carry forward.
  Any proposed pool or batch cap must be set from representative measurements
  and reviewed with its failure and admission behavior; this ADR invents no
  numeric resource limit.

## Evidence and limits

The topology spike was read-only and used no live model calls. It inspected
the bounded runtime database set: `.runtime/state.sqlite` and
`.runtime/*/state.sqlite` (one child level, selecting `state.sqlite` and thus
excluding lock databases). Each was opened with `better-sqlite3` options
`{ readonly: true, fileMustExist: true }`; the query connection set
`PRAGMA query_only = ON`. The inventory found seven databases and 219 ledger
records: 110 `lead_turn`, 88 `worker_turn`, and 21 `intake_turn`.

| Database | `intake_turn` | `lead_turn` | `worker_turn` |
| --- | ---: | ---: | ---: |
| `.runtime/dev-m3/state.sqlite` | 3 | 10 | 8 |
| `.runtime/dev-m3b/state.sqlite` | 7 | 26 | 20 |
| `.runtime/dev-m45/state.sqlite` | 6 | 30 | 23 |
| `.runtime/dev-m45b/state.sqlite` | 2 | 10 | 8 |
| `.runtime/dev-m45c/state.sqlite` | 1 | 5 | 4 |
| `.runtime/dev/state.sqlite` | 0 | 13 | 6 |
| `.runtime/state.sqlite` | 2 | 16 | 19 |

The inspected records lacked startup, cold-start, and queue-wait measurements.
This small existing ledger is descriptive evidence only; it is not a matched
topology benchmark.

The schema/count procedure is reproducible without mutating a database:

```sql
PRAGMA query_only = ON;
SELECT name FROM sqlite_schema
 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
 ORDER BY name;
```

In each database, inspect the schema with `PRAGMA table_info('usage_ledger')`;
count ledger categories with:

```sql
SELECT kind, COUNT(*) AS n
  FROM usage_ledger
 GROUP BY kind
 ORDER BY kind;
```

All seven inspected databases lacked `startup_ms`, `cold_start`, and
`queue_wait_ms` columns. The current source schema defines these columns for
newly initialized databases, but old database rows can still lack their values
(`src/usage-ledger.js:10`). The observed legacy `intake_turn` kind is no longer
in the source `KINDS` set, so its historical count is descriptive rather than
a claim about current intake recording (`src/usage-ledger.js:6`).

`SUP-03` fake-clock recovery tests cover 0, 1,000, and 4,000 ms retry delays
(`test/supervisor-integration.test.js:15, 263`). Those are deterministic
recovery-policy checks, not measurements of process startup, memory, or
production recovery latency. No process RSS measurement or matched topology
trial is available. Real startup and memory remain unknown; no numeric cap is
recommended until representative resource measurements exist.

The full suite was recorded as passing in `/tmp/phase-c-full-test.log`:
`env -u NODE_TEST_CONTEXT npm test`, 548 passed, 13 suites, 0 failed,
cancelled, or skipped; duration 35,867.805797 ms. This verifies the current
implementation baseline, not the comparative topology hypotheses.

## Reopen criteria

Reopen ACT-02 only when all of the following evidence is available:

1. A named failure or contention case shows that the shared process materially
   harms accepted-work reliability or latency after existing bounded recovery.
2. Matched trials record real process startup, memory/RSS, recovery time,
   successful acceptance, and failed-attempt costs for the shared process and
   the proposed role-pool or attempt-scoped topology.
3. The design defines actor identity, process-generation ownership, context and
   thread affinity, readiness, cancellation, shutdown, descendant cleanup,
   capacity, and resource limits without weakening global writer admission.
4. Measured isolation benefit justifies its resource and operational overhead.

Reopen ACT-03 separately only after a measured queue demand exists and ACT-02
has a selected, implemented ownership boundary. Specify bounded capacity,
backpressure, versioned message framing, duplicate handling, expiry, poison
message quarantine, and dependency-aware recovery before enabling mailboxes.

## Risks

The shared process remains a common failure domain: a process loss can fail
several concurrent turns. The decision also leaves real startup and memory cost
unknown and may delay isolation if future workloads need it. A process split
could increase startup latency, memory use, and lifecycle failure modes, while
still sharing workspace writer serialization. These risks are accepted pending
the reopen evidence above; no savings are asserted.
