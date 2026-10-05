# Orchestrator improvement backlog

Status: accepted backlog; M0 recorded (see "M0 record"); Phase A in progress.
Priorities express implementation order, not promised savings.

## Goal and constraints

`ROOT` (level 0, parent: none) outcome: the orchestrator completes accepted work
with measured resource use, explicit execution boundaries, and recoverable failures.
Acceptance: the milestone evidence below exists; correctness and permissions are
preserved; efficiency claims are supported by matched trials.
Dependencies: none.

Build on the current A2A/LangGraph runtime. Keep workspace writer admission,
unknown-outcome reconciliation, pinned acceptance checks, role escalation rules,
and approval boundaries. Runtime checks and deterministic filters must not add
LLM calls. Fresh context does not undo filesystem or external effects.

Do not add a service for each pattern. Prefer internal modules first; expose MCP
only when an actual consumer requires it. No universal shell safety classifier,
arbitrary rollback generator, full proof of agent correctness, or unbounded plan
search is included. A failed test does not automatically justify a restart or
rollback. An unavailable measurement or predicate is unknown, never zero/pass.

The baseline is the current working tree, including existing uncommitted work.
Implementation must pin a reviewed revision before benchmark trials. This backlog
does not authorize reverting, committing, or replacing existing changes.

## Current capabilities and recommendations

| Track | Existing foundation | Recommended increment | Priority |
| --- | --- | --- | --- |
| Actor Model | Separate specialist threads; shared App Server process; one active turn per thread | Define actor lifecycle and ownership first; separate process boundaries only where faults justify the cost; bounded mailboxes only where queued work is needed | P2 |
| Supervisor Trees | Child lifecycle, timeout handling, replacement on a later call, process-group reconciliation | Deterministic failure classification, restart intensity ceiling, and bounded recovery; preserve shared-process semantics until isolation exists | P1 |
| Design by Contract / Hoare logic | Assignment/report schemas, allowed-file instructions, deterministic acceptance, attested deltas | Versioned executable pre/postconditions at dispatch, settlement, and acceptance; use Hoare-style reasoning for bounded transitions, not a claim of formal proof | P0 |
| Write-ahead intent logging / Sagas | SQLite dispatch journal written before submission; unknown submission reconciliation | Audit durability and close crash windows first; add compensation only for supported reversible operations with checked ownership | P1/P2 |
| Unix pipes / IPC | CLI tools, structured worker reports, bounded output tails | Keep bulky evidence in artifacts; pass compact reports and references; deterministic pipelines before a separate broker | P0 |
| Cost-based execution routing | Usage ledger, models, elapsed time, outcomes, known token totals | Establish task-class baselines; evaluate a small set of permitted routes in shadow mode; activate only with measured benefit | P1/P2 |

Implementation references: `src/codex-app-server.js`, `src/a2a-role-service.js`,
`src/lead-graph.js`, `src/contracts.js`, `src/acceptance.js`,
`src/durable-store.js`, `src/writer-admission.js`, `src/usage-ledger.js`,
`src/usage-report.js`. See `hardening-spec.md`, `resilient-orchestration-spec.md`,
`skill-routing.md`, and `efficiency-comparison.md` for established behavior.

## Milestones and phases

| Gate | Exit criteria | Unblocks |
| --- | --- | --- |
| M0 | Current revision/profile/check configuration is recorded; implementation briefs are bounded; existing checks pass or failures are documented | Phase A |
| M1 | Baseline fixtures exist; compact evidence is retrievable; contract violations cannot become accepted results; existing resume and writer guarantees pass regression checks | Phase B |
| M2 | Shared-process recovery is bounded; journal durability and unknown-effect behavior are documented/tested; routing shadow reports exist with no behavior change | Phase C decisions |
| M3 | Every selected Phase C epic passes its safety and resource gates, or has an evidence-backed defer decision; no unqualified savings claim remains | Completion of the selected rollout |

`PH-A` (level 1, parent: ROOT): bounded evidence and runtime contracts are measurable.
Depends on M0; acceptance: M1. Current phase.

`PH-B` (level 1, parent: ROOT): recovery and route estimates use recorded facts.
Depends on M1; acceptance: M2. Next phase.

`PH-C` (level 1, parent: ROOT): justified isolation, compensation, and active routing
are introduced selectively. Depends on M2; acceptance: M3. Later phase; epics only,
to be decomposed after decision outputs exist.

Gate dependencies are the completed work listed in each phase. They do not imply
calendar dates or automatic rollout. Each feature is disabled until its acceptance
gate passes. Legacy calls and stored runs need explicit compatibility behavior.

## M0 record

Recorded 2026-10-05. M0 is met.

- Baseline revision: `c579e6c` on `main` (role rename and hash-pinned skill
  routing committed on top of `fd92eea`). Benchmark trials pin their own reviewed
  revision under MEA-01; this one is the implementation baseline.
- Runtime: Node v24.21.0, codex-cli 0.160.0.
- Product profiles (the system under change, not the implementation team):
  `coordinator` gpt-6.1-sol/high (read-only, `src/role-catalog.js`);
  `explorer`, `engineer`, `verifier` gpt-6-luna/high; `scout` gpt-6-luna/medium;
  `recovery-engineer` gpt-6-luna/xhigh; `auditor` gpt-6.1-sol/high;
  `senior-engineer` gpt-6.1-sol/medium; `architect` gpt-6.1-sol/xhigh
  (`profiles/agents/*.toml`).
- Checks: `npm test` on the baseline passes 394 of 394 tests (13 suites, about
  33 s); no known failures. Every implementation task must pass `npm test`, plus
  any focused checks its brief names.
- Execution path: the Claude Code lead session implements this backlog with
  Claude workers (worker-sonnet for code and tests, auditor-sonnet for read-only
  fact maps and reviews). The orchestrator is not used to build itself. Briefs
  state goal, established facts, the lead's decision, allowed files, and the
  definition of done.
- Git: workers never change git state. The lead reviews each accepted diff, runs
  the suite, and commits on the working branch; a feature branch is merged into
  `main` when its work is accepted.

## Phase A progress

Branch `feature/orchestrator-phase-a`, recorded 2026-10-05.

| Item | State | Evidence |
| --- | --- | --- |
| OPS-01 | done | `c722d95`; CLI polls instead of one blocking request |
| MEA-01 | done | `docs/orchestration-benchmark-plan.md`; fixtures F1-F3 under `bench/` (M1) |
| MEA-02 | done | `b0bfeb7`; pre-turn rows, startup, queue wait |
| PIP-01 | done | `docs/evidence-artifact-contract.md` (`evidence-ref/v1`) |
| PIP-02 | done | `1fb29a9`; `src/evidence-store.js`, `npm run evidence` |
| PIP-03 | done | `5dd5097`; bounded lead projection, check output evidence |
| PIP-04 | done | test/evidence-pipeline.test.js; 1069117-char report projects to 18602 chars |
| DBC-01 | done | `docs/execution-boundary-contract.md` (`boundary-contract/v1`) |
| DBC-02a | done | `2a61643`; rejected decisions return to the lead |
| DBC-02b | done | `9e01dce`; per-attempt pins, FAIL-over-UNKNOWN acceptance |
| DBC-03 | done | `f4b7172`; executor-side specialist contract |
| DBC-04 | done | `9bd2c23`; test/runtime-contracts.test.js |
| M1 | done | 502 tests green; independent safety audit found F1 (blocker: reported scope advisory) and F2-F7, all fixed before merge; OPS-02 recorded |

## Phase B progress

Branch `feature/orchestrator-phase-b`. Owner scope for this pass: SUP, WAL-01,
WAL-02, OPS-02. OPT (OPT-01..03) was not started; OPT-04 in Phase C depends on it.

| Item | State | Evidence |
| --- | --- | --- |
| OPS-02 | done | `6112a3d`; contract persisted in lead task metadata, run gated on durable read |
| WAL-01 | done | `docs/intent-recovery-contract.md`; decision D1 `synchronous = FULL`; gaps G1-G6 |
| WAL-02 | done | `ef885cd`; FULL fsync (0.02 -> 0.57 ms per commit), guarded journal, G2-G6 |
| SUP-01 | done | `docs/supervisor-recovery-contract.md` (`supervisor-policy/v1`) |
| SUP-02 | done | `26f597d`; window, backoff, exhaustion with probe, per-run outcome rule |
| SUP-03 | done | `7d9e734`; test/supervisor-integration.test.js; recovery 0/1000/4000 ms |
| M2 (owner scope) | in review | 535 tests green; independent safety audit pending |

## Phase A: baseline, compact evidence, executable contracts

### MEA: resource comparisons are reproducible

`MEA` (level 2, parent: PH-A), depends on M0.
Acceptance: MEA-01 produces a reusable fixture and evaluation specification.

#### MEA-01 - Comparable trial definitions exist [P0]

Level 3; parent: MEA; depends on M0; executor: lead; estimate: one planning session.
Write scope: `docs/orchestration-benchmark-plan.md`.

- Define fixtures for read-only lookup, bounded code repair, large tool output,
  concurrent reads with a failed worker, and an interrupted writer.
- Pin models/effort, permissions, acceptance checks, revision, and trial isolation.
- Record acceptance rate, end-to-end wall time, known input/cached/output tokens,
  repeated work, retries, queue wait, process startup, and recovery time.
- Count planning, failed attempts, and compensation in total resource consumption.
  Compare matched task classes and both success rate and resources; report accepted
  trial latency separately without hiding failed-trial costs.
- Define provisional regression tolerances before seeing results. Use repeated
  alternating trials; describe uncertainty and incomplete token coverage.

Done: a reviewer can reproduce the trials from the document; no live model runs
are required to complete this task. Actual trials use disposable workspaces.

Status 2026-10-05: done, `docs/orchestration-benchmark-plan.md`.

#### MEA-02 - The ledger records every attempt and its waits [P1]

Level 3; parent: MEA; depends on MEA-01; executor: worker-sonnet.
Proposed write scope: `src/a2a-role-service.js`, `src/usage-ledger.js`,
`src/usage-report.js`, `src/codex-app-server.js`, and their tests.

- Write a ledger row (outcome `refused`, `input_error`, or `canceled`, tokens
  null, turns 0) for worker attempts that end before a turn
  (`src/a2a-role-service.js:294-302`, `:321-342`, `:352-360`).
- Record `startupMs` (process spawn to `initialize` done) separately from turn
  time, and a `coldStart` flag on the first turn of a process
  (`src/codex-app-server.js:368`, `:544`).
- Record admission queue wait per writer attempt
  (`src/a2a-role-service.js:306-319`).
- Report acceptance check `durationMs` (`src/acceptance.js:89`) in the usage
  report; fill `attemptId`/`runId` for `--task` reports (`src/usage-ledger.js:149`).

Done: the benchmark plan's "known gaps" can be removed; fixtures cover each new
field; old rows without the fields report null, not zero.

### PIP: bulky evidence stays outside routine model context

`PIP` (level 2, parent: PH-A), depends on M0.
Acceptance: PIP-01 through PIP-04 pass, with complete evidence accessible by reference.

#### PIP-01 - A versioned evidence reference contract exists [P0]

Level 3; parent: PIP; depends on M0; executor: lead; estimate: one planning session.
Write scope: `docs/evidence-artifact-contract.md`.

- Specify artifact ID, owning run/task, checksum, media type, size, retention,
  bounded summary, truncation/filter indicators, and retrieval limits.
- Specify permissions, sensitive-output handling, missing/expired artifact errors,
  and compatibility with worker-report/v1 and resumed runs.
- Specify internal producer/consumer interfaces and authentication for any exposed
  retrieval endpoint. Artifact IDs must not become arbitrary filesystem paths.

Done: examples cover a successful tool call, failed call, truncation, and retrieval
failure. Consumers can implement against the frozen contract.

#### PIP-02 - Evidence storage enforces bounded access [P0]

Level 3; parent: PIP; depends on PIP-01; executor: worker-sonnet; estimate: one session.
Write scope (frozen by PIP-01): `src/evidence-store.js`, `test/evidence-store.test.js`,
`src/launcher-sessions.js` (run deletion), `test/launcher-sessions.test.js`, `package.json` (`evidence` script).

- Store full evidence under run ownership; return compact reference metadata.
- Bound writes/reads, enforce retention and ownership, and reject traversal or
  unauthorized references. Preserve stdout/stderr distinction and exit status.

Done: focused tests cover limits, checksum verification, cross-run access,
path/symlink escape attempts, missing evidence, and cleanup. No extra LLM calls.

#### PIP-03 - Lead outcomes carry bounded evidence [P0]

Level 3; parent: PIP; depends on PIP-01, PIP-02; executor: worker-sonnet;
estimate: one session. Write scope (frozen by PIP-01): `src/lead-graph.js`,
`src/acceptance.js`, `test/lead-graph.test.js`, `test/acceptance.test.js`.

- Persist oversized reports before summarizing them; preserve required structured
  report fields, failure classifications, and acceptance-relevant evidence.
- Supply the lead a bounded projection with retrievable details; do not silently
  discard scope violations or diagnostics needed for the next decision.

Done: a large fake output yields a bounded lead input and retrievable original;
small reports and old runs remain compatible; retrieval needs no planning turn.

#### PIP-04 - Compact evidence passes end-to-end acceptance [P0]

Level 3; parent: PIP; depends on PIP-02, PIP-03; executor: worker-sonnet;
estimate: one session. Proposed write scope: `test/evidence-pipeline.test.js`.

- Exercise producer -> storage -> lead projection -> bounded retrieval using
  fake runtime data. Include restart and expired evidence cases.

Done: evidence hashes match, summaries signal omissions, errors remain visible,
and the large-output fixture records before/after payload size. No model API calls.

### DBC: acceptance requires executable runtime predicates

`DBC` (level 2, parent: PH-A), depends on M0.
Acceptance: DBC-01 through DBC-04 pass; unknown predicates cannot certify success.

#### DBC-01 - Execution boundary contracts are fixed [P0]

Level 3; parent: DBC; depends on M0; executor: lead; estimate: one planning session.
Write scope: `docs/execution-boundary-contract.md`.

- Define preconditions for dispatch/admission, postconditions for settlement and
  acceptance, and invariants for single-writer ownership, permissions, pinned
  checks, and attested scope.
- Define PASS/FAIL/UNKNOWN/error semantics, stable violation codes, contract
  versions, and evidence references. Fail closed for safety-critical unknowns.
- Specify direct specialist requests separately from lead-managed assignments,
  including legacy plain-text calls. State which predicates need a structured
  contract; an unconstrained legacy call cannot receive contract certification.
- Use a fixed registry of deterministic predicates, not model-provided executable
  expressions. Pin the contract per attempt and define old-run behavior.
- Document Hoare-style transition obligations and limits of snapshots: ignored
  files, transient write/restore behavior, and external effects are not proven safe.

Done: every predicate has an authoritative data source and failure policy;
examples cover unknown writer effects and unavailable snapshots.

#### DBC-02 - Lead boundary checks prevent invalid acceptance [P0]

Level 3; parent: DBC; depends on DBC-01; executor: worker-sonnet. Split by
DBC-01 into two serial briefs, each one reviewable change:

- DBC-02a (dispatch rejection): `src/contracts.js`, `src/lead-graph.js`,
  `test/contracts.test.js`, `test/lead-graph.test.js`. Stable predicate ids and
  codes for lead-managed dispatch predicates, rejected decisions fed back to
  `decide`, read-only `.` normalization, glob rejection, preserved `threadId`.
- DBC-02b (pinning and acceptance): `src/lead-graph.js`, `src/acceptance.js`,
  `src/server.js`, `test/lead-graph.test.js`, `test/acceptance.test.js`,
  `test/server.test.js`. Per-attempt contract pin, settlement and acceptance
  violation records, FAIL-over-UNKNOWN disposition, `contract_invalid` on
  restart, advisory `writer_reported_failure`.

- Add only missing predicates; preserve existing validators and acceptance logic.
- Enforce preconditions before side effects and record postcondition failures after
  execution. Keep changed workspace state visible for reconciliation/repair.
- Reject invalid acceptance without deleting useful changes or altering approval
  behavior. Do not claim per-tool prevention from assignment-level checks.
- Return a failed dispatch precondition to the lead as a structured rejected
  dispatch with a violation code, so the lead can correct its brief in the next
  turn. Observed 2026-10-05: a read-only explorer assignment with
  `allowedFiles: ["."]` failed `safeRelativePath` (`src/contracts.js:297`) and
  stopped the whole run with an error that needed a human retry.

Done: focused tests cover rejected dispatch, failed/unknown postconditions,
contract drift, and preserved writer barriers. No model call evaluates predicates.

#### DBC-03 - Specialist entry points enforce their runtime contract [P0]

Level 3; parent: DBC; depends on DBC-02; executor: worker-sonnet;
estimate: one session. Proposed write scope: `src/a2a-role-service.js`,
`test/a2a-role-service.test.js`.

- Enforce the DBC-01 specialist contract at the executor chokepoint for direct
  requests and lead-dispatched requests, before invoking the model where applicable.
- Record settlement predicates using authoritative execution metadata. Keep worker
  task completion distinct from lead acceptance or contract certification.
- Preserve documented legacy compatibility without advertising unavailable
  guarantees; reject requests that demand guarantees they cannot establish.

Done: direct endpoint tests cover malformed contracts, denied preconditions,
unknown writer effects, pinned contracts, and legacy plain-text requests. Direct
requests cannot bypass the guarantees claimed by their selected contract.

#### DBC-04 - Boundary violations survive restart [P0]

Level 3; parent: DBC; depends on DBC-02, DBC-03; executor: worker-sonnet;
estimate: one session. Proposed write scope: `test/runtime-contracts.test.js`.

- Exercise fake end-to-end flows with invalid reports, out-of-scope deltas,
  interrupted writers, and unavailable evidence, including resume.

Done: no violation becomes accepted; persisted diagnostics explain the predicate
and source evidence; legacy checkpoint fixtures follow the documented policy.

## Phase B: bounded recovery, durable intent, routing evidence

### SUP: failures have bounded lifecycle recovery

`SUP` (level 2, parent: PH-B), depends on M1.
Acceptance: SUP-01 through SUP-03 pass without unsafe writer replay.

#### SUP-01 - Recovery policy identifies the real failure boundary [P1]

Level 3; parent: SUP; depends on M1; executor: lead; estimate: one planning session.
Write scope: `docs/supervisor-recovery-contract.md`.

- Classify process crashes, transport ambiguity, timeouts, permission denials,
  usage limits, invalid requests, and domain failures.
- Define bounded restart intensity/window, backoff/deadline, aggregate retry budget,
  cancellation, process-generation identity, and terminal exhaustion behavior.
- State that the current shared App Server restart affects every hosted active
  turn; distinguish restarting a process from replaying an assignment.
- Permit writer replay only after authoritative settlement and a separate replay
  safety decision. Budget/permission failures are not crash-restart loops.

Done: each failure class has a deterministic policy and tests can use an injected
clock. No unsupported claim of per-worker process isolation or one-for-one exists.

#### SUP-02 - App Server recovery obeys a bounded policy [P1]

Level 3; parent: SUP; depends on SUP-01; executor: worker-sonnet;
estimate: one session. Proposed write scope: `src/codex-app-server.js`,
`test/codex-app-server.test.js`.

- Enforce the approved restart window/budget on process replacement and expose
  exhaustion diagnostics. Reap the old execution boundary before replacement.
- Keep concurrent failure provenance separate; startup synchronization must not
  spawn duplicate children. Preserve confirmed cancellation semantics.

Done: fake-clock tests cover repeated crashes, recovery, concurrent callers,
deadline exhaustion, and surviving descendants. No automatic writer replay.

#### SUP-03 - Recovery cannot bypass writer reconciliation [P1]

Level 3; parent: SUP; depends on SUP-02; executor: worker-sonnet;
estimate: one session. Proposed write scope: `test/supervisor-integration.test.js`.

- Inject shared-process failure with concurrent read turns and an active writer;
  exercise replacement and resumed lead flow.

Done: all affected turns are accounted for; unresolved writers retain admission;
replacement does not duplicate work; measured recovery events include exhaustion.

### WAL: durable intent separates known results from ambiguous effects

`WAL` (level 2, parent: PH-B), depends on M1.
Acceptance: WAL-01 and WAL-02 pass; durability guarantees match documented failure modes.

#### WAL-01 - Intent durability and crash windows are specified [P1, spike]

Level 3; parent: WAL; depends on M1; executor: lead; timebox: one review session.
Write scope: `docs/intent-recovery-contract.md`.

- Audit actual SQLite journal/synchronous settings and distinguish process crash
  recovery from power-loss durability. Record evidence and an explicit decision.
- Define stable operation IDs, intent/result/reconciliation states, duplicate
  delivery behavior, and recovery after an effect occurs before its result is logged.
- Identify which existing dispatch guarantees suffice and the narrow missing
  guarantees. Define a compatible migration and error/evidence interfaces.
- Keep write-ahead intent distinct from SQLite's own WAL implementation.

Done: a crash-window matrix states the recovery action for each window and the
guarantees that remain unavailable. Unknown outcomes never mean no effects.

#### WAL-02 - Dispatch recovery meets the recorded durability contract [P1]

Level 3; parent: WAL; depends on WAL-01; executor: worker-sonnet;
estimate: one session. Proposed write scope: `src/durable-store.js`,
`src/lead-graph.js`, `test/durable-store.test.js`, `test/lead-graph.test.js`.

- Implement only gaps identified by WAL-01, including migration if needed.
- Inject crashes before send, after remote acceptance, before result persistence,
  and during reconciliation; use existing context IDs/fences where sufficient.

Done: a committed intent precedes dispatch; restart resolves known effects or
preserves uncertainty; repeated recovery neither silently resends writers nor
loses evidence. Power-loss claims require matching durability evidence.

### OPT: routing estimates can be evaluated without changing execution

`OPT` (level 2, parent: PH-B), depends on M1.
Acceptance: OPT-01 through OPT-03 produce reproducible shadow reports.

#### OPT-01 - A bounded routing cost contract exists [P1]

Level 3; parent: OPT; depends on M1; executor: lead; estimate: one planning session.
Write scope: `docs/routing-cost-contract.md`.

- Define a small candidate catalog by task class and permission/role constraints.
  Do not reorder side-effecting actions or skip acceptance to reduce cost.
- Separate cached/uncached tokens, wall-time critical path, queue/startup time,
  retry/recovery cost, uncertainty, and required quality/success constraints.
- Specify historical grouping, minimum sample policy, safe fallback, shadow-only
  output, bounded planning work, and contract versions.
- Respect role escalation order; route comparisons may select only already
  permitted alternatives. Subscription usage is not measured monetary spend.

Done: fixtures specify candidate scores and exclusions; unknown samples cannot
win by receiving zero cost; model estimates are labeled separately from history.

#### OPT-02 - Historical estimates produce shadow rankings [P1]

Level 3; parent: OPT; depends on OPT-01; executor: worker-sonnet;
estimate: one session. Proposed write scope: `src/routing-cost.js`,
`src/usage-ledger.js`, `test/routing-cost.test.js`, `test/usage-ledger.test.js`.

- Implement bounded statistics/ranking with stable task-class labels and migration
  compatibility. Include failed-attempt resource use and confidence information.

Done: deterministic fixtures cover sparse/unknown data, cache accounting,
outliers, constraint exclusions, and bounded candidate enumeration. Existing
execution decisions are unchanged and no extra model calls occur.

#### OPT-03 - Shadow predictions are comparable to actual outcomes [P1]

Level 3; parent: OPT; depends on OPT-02; executor: worker-sonnet;
estimate: one session. Proposed write scope: `src/lead-graph.js`,
`src/usage-report.js`, `test/lead-graph.test.js`, `test/usage-report.test.js`.

- Record permitted candidate predictions alongside the actual lead choice;
  expose prediction error and data coverage in reports.

Done: fake runs have unchanged dispatch decisions and acceptance results; shadow
entries survive resume without double counting. Reports distinguish observations
from unexecuted counterfactual estimates; no savings claim follows from ranking alone.

## Phase C: conditional epics, not implementation-ready tasks

Later write scopes are provisional. Decompose each selected epic into bounded
contract, implementation, acceptance, and integration tasks before dispatch.

| ID / parent | Outcome and recommendation | Dependencies | Acceptance / decision gate |
| --- | --- | --- | --- |
| ACT-01 / PH-C | The actor/process topology has an evidence-backed decision. Compare shared process, role pool, and attempt-scoped process using measured startup, fault impact, and context behavior. Define actor IDs separately from roles. Timebox the spike to one review/prototype session; output a topology ADR | M2, SUP | ADR specifies supervision boundary, ownership, dependencies, and resource limits; choose isolation only if its benefit justifies overhead |
| ACT-02 / PH-C | Selected workers have isolated lifecycle boundaries. Implement the ACT-01 decision with health/readiness, process generation, cancellation, and shutdown contracts | ACT-01 | A failed worker cannot terminate an unrelated worker; descendants are stopped; writer admission and shared workspace restrictions still hold; benchmark startup/memory/recovery |
| ACT-03 / PH-C | Queued actor work has bounded, versioned delivery. Add mailboxes only when queue demand exists; specify capacity, backpressure, message framing, duplicates, expiry, poison-message quarantine, and dependency-aware recovery | ACT-02 | Concurrent/crash tests cover delivery policy and queue bounds; no exactly-once claim without external-effect support; no serialization of all work merely because it shares a role |
| DBC-05 / PH-C | Tool mutations have a proven mandatory enforcement route. Timebox a spike to one review session; output a tool-boundary ADR showing supported interception/enforcement and remaining direct-tool access | M2, DBC | ADR either proves supported mandatory mediation for a scoped tool set or defers the proxy; do not bypass approval/sandbox rules or advertise an optional MCP tool as a security boundary |
| DBC-06 / PH-C | Supported tool operations enforce pinned contracts. Introduce a Contract Proxy only for the scoped operations approved by DBC-05 | DBC-05 | Direct alternatives cannot bypass the claimed boundary; predicates are trusted code; version/path races and symlink escapes are tested; failed postconditions preserve evidence and trigger a defined containment policy |
| WAL-03 / PH-C | Reversible operations have registered compensation semantics. Timebox a spike to one review session; output a catalog ADR covering file replacement/deletion, supported DB operations, and APIs with idempotency/status support | M2, WAL, DBC | Catalog identifies before-images, ownership/version checks, partial-step effects, irreversible steps, compensation order, expiry, and unsupported actions; use native DB transactions for local atomic work |
| WAL-04 / PH-C | Selected multi-step workflows recover through durable compensation. Implement Saga only for WAL-03's supported operations, under the enforced mutation boundary | WAL-03, DBC-06 | Forward and compensation states survive crashes; repeated compensation is safe; ambiguous or partially failed steps are reconciled; reverse dependency order is respected; foreign edits are preserved; compensation failure is explicit and bounded |
| PIP-05 / PH-C | Repeated CLI workflows run as deterministic pipelines. Prefer internal process pipes with typed JSONL records over a new service; add Pipe Broker only for demonstrated shared consumers | M2, PIP | Every stage exit is checked; stdout/stderr and truncation remain distinct; timeout/cancel stops descendants; slow consumers and byte limits are handled; large evidence stays retrievable; restart uses artifacts/journal rather than assuming FIFO durability |
| OPT-04 / PH-C | Selected task classes use measured route choices. Activate a small allowlisted set of routes behind a flag after shadow evaluation and matched trials | M2, OPT | End-to-end trials meet declared success/quality constraints and resource tolerances, including planning/retries; sparse data falls back safely; enforcement/escalation order is unchanged; disabling routing restores baseline behavior |

Every row is level 2; its ID, parent, dependencies, outcome, and acceptance criteria
are given above. Phase C is deliberately not sized as implementation tasks before
the decision gates establish the allowed scope.

## Execution ownership and sequencing

- Lead owns document contracts, prioritization, integration decisions, and review.
- Product code, tests, scripts, and build configuration go to scoped
  worker-sonnet briefs. Workers do not change git state. Each brief freezes
  allowed files and requires a focused verification report plus scope-expansion
  reporting.
- Use auditor-sonnet for bounded factual audits and reviews. An independent
  read-only safety audit at M1/M2 and before activating Phase C mutation features
  may use auditor-opus. Escalate implementation only after inspecting a concrete
  worker limitation: after two failed worker-sonnet attempts the lead takes the
  decision back and hands the repair to worker-opus with that decision in the brief.
- All implementation estimates are provisional one-session briefs. Split a task
  before dispatch if it requires more than one reviewable change; update dependencies.
- Test files belong to the feature task. Integration tasks own distinct new tests
  or explicitly listed existing tests; never overwrite another worker's edits.

Parallel execution is allowed only with disjoint write scopes. In particular,
DBC-02a, DBC-02b, and PIP-03 all touch `src/lead-graph.js` and run serially in
that order; DBC-02b and PIP-03 also share `src/acceptance.js`. PIP-02 and DBC-03
have disjoint scopes and may run beside them. In Phase B,
WAL-02 and OPT-03 also touch that file and must run serially. Their order is a
resource constraint, not an invented functional dependency. Freeze any additional
shared scope in the worker brief before starting concurrent work.

Candidate phase paths:

- M0 -> PIP-01 -> PIP-02 -> PIP-03 -> PIP-04 -> M1.
- M0 -> DBC-01 -> DBC-02 -> DBC-03 -> DBC-04 -> M1.
- M0 -> MEA-01 -> M1.
- M1 -> SUP-01 -> SUP-02 -> SUP-03 -> M2.
- M1 -> WAL-01 -> WAL-02 -> M2.
- M1 -> OPT-01 -> OPT-02 -> OPT-03 -> M2.

The likely longest dependency path is the evidence path through M1 followed by
the routing path through M2. Exact critical-path duration remains provisional
until tasks are sized; serialize shared scopes when computing the actual schedule.

## Defects found during execution

Bounded fix items outside the tracks above. Each needs its own brief.

#### OPS-01 - The CLI survives tasks longer than five minutes [P0]

Executor: worker-sonnet. Proposed write scope: `src/cli.js`, `test/cli.test.js`.
Observed 2026-10-05: `npm run ask` sends one blocking `sendMessage`
(`returnImmediately: false`); a lead task that ran longer than the HTTP client's
default timeout ended the CLI with `fetch failed` and exit 1 while the task kept
working on the server. Submit with immediate return and poll `getTask` (or
stream) until a terminal or `INPUT_REQUIRED` state; keep the exit codes; on a
transport error print the task id so the caller can resume or inspect it.
Done: a fake slow server test shows the CLI waiting past the timeout and printing
the final result; existing CLI tests pass.

#### OPS-02 - Pinned acceptance checks survive a pre-checkpoint restart [P1]

Executor: worker-sonnet. Proposed write scope: `src/server.js`,
`test/server.test.js`. Found by the M1 audit (pre-existing, outside Phase A):
request-level `metadata.acceptance` (`src/server.js` ~:263) is not recoverable
when the server restarts before the first checkpoint (~:344); the run then
continues with no checks, ends `unverified`, and the CLI exits 0. Recover the
contract from the stored first user message, or mark it invalid
(`contract_invalid`, UNKNOWN) when it cannot be recovered. Belongs with WAL-01's
crash-window matrix; fix it there at the latest.

## Verification and rollout policy

1. Run focused tests in implementation tasks, then the existing project checks at
   milestone integration. Fake App Server/process fixtures cover crash behavior;
   no live LLM calls are needed for deterministic feature tests.
2. Test direct specialist endpoints as well as lead dispatch; a lead-only gate
   cannot enforce a runtime-wide guarantee.
3. Use isolated pinned fixtures for optional live benchmark trials. Keep raw
   usage, output artifacts, configuration, and acceptance records with results.
4. Roll out by task class and feature flag. Accept safety improvements on explicit
   safety evidence; claim economy only on measured end-to-end comparisons.
5. Contract changes reopen the contract item and mark every consumer stale. A failed
   gate keeps the next phase closed; add bounded fix items rather than weakening it.
6. If a spike cannot establish safe authority, recovery, or mandatory interception,
   record the blocker/defer decision. Do not implement an approximation and call it
   a guarantee. No automatic rollback of arbitrary workspace changes is authorized.

Recommended first release: MEA + PIP + DBC. Next: SUP + WAL durability + OPT shadow.
Process isolation, mandatory tool mediation, Sagas, and active route selection are
conditional later increments, not prerequisites for obtaining the early benefit.
