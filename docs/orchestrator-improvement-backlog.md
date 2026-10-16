# Orchestrator improvement backlog

Status: M1 done; M2 owner scope done; the Phase C conditional-decision rollout
is complete and its independent audit is accepted. All nine Phase C epic
decisions have a go/defer outcome; no runtime implementation was selected for
activation. The full M2 exit criterion remains incomplete because OPT-01..03
routing shadow reports are absent and were outside the accepted M2 owner scope.
Accepted documentation is integrated directly on main under explicit user authorization.
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
Depends on M0; acceptance: M1. Complete.

`PH-B` (level 1, parent: ROOT): recovery and route estimates use recorded facts.
Depends on M1; acceptance: M2. The M2 owner scope recorded in the Phase B
progress table is complete; OPT-01..03 routing work remains incomplete and was
outside that owner scope.

`PH-C` (level 1, parent: ROOT): justified isolation, compensation, and active routing
are introduced selectively. Depends on M2; acceptance: M3. The conditional
decision rollout has evidence-backed go/defer outcomes for all nine epics, no
unqualified savings claims, and accepted independent audit. No runtime feature
was selected for activation; deferred work retains its reopen criteria. This
does not satisfy the still-incomplete full M2 routing-shadow criterion.

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

Owner scope for this pass: SUP, WAL-01,
WAL-02, OPS-02. OPT (OPT-01..03) was not started; OPT-04 in Phase C depends on it.

| Item | State | Evidence |
| --- | --- | --- |
| OPS-02 | done | `6112a3d`; contract persisted in lead task metadata, run gated on durable read |
| WAL-01 | done | `docs/intent-recovery-contract.md`; decision D1 `synchronous = FULL`; gaps G1-G6 |
| WAL-02 | done | `ef885cd`; FULL fsync (0.02 -> 0.57 ms per commit), guarded journal, G2-G6 |
| SUP-01 | done | `docs/supervisor-recovery-contract.md` (`supervisor-policy/v1`) |
| SUP-02 | done | `26f597d`; window, backoff, exhaustion with probe, per-run outcome rule |
| SUP-03 | done | `7d9e734`; test/supervisor-integration.test.js; recovery 0/1000/4000 ms |
| M2 (owner scope) | done | `docs/m2-audit-resolution.md`; F1-F5 fixed, 548 tests green, independent audit accepted; OPT-01..03 not started and outside owner scope |

## Phase C progress

The conditional decision rollout is complete: all nine epic decisions were
independently audited and accepted. Selected runtime implementation remains
deferred behind the evidence gates below. The nine decision records satisfy
M3's evidence-backed go/defer gate, with no unqualified savings claim. This
does not mark the separate full M2 routing-shadow criterion complete.

| Item | State | Decision and evidence |
| --- | --- | --- |
| ACT-01 | decision done | [Actor topology ADR](adr/phase-c-actor-topology.md): keep the shared process; startup/memory and matched topology measurements are unknown, so defer isolation. |
| ACT-02 | deferred | ACT-01 selected no new process boundary; reopen only with a named fault case and matched startup, memory, recovery, and acceptance evidence. |
| ACT-03 | deferred | ACT-02 has no selected boundary and no measured queue demand exists; reopen after bounded ownership and queue demand are evidenced. |
| DBC-05 | decision done | [Tool boundary ADR](adr/phase-c-tool-boundary.md): no supported mandatory interception point was demonstrated. |
| DBC-06 | deferred | DBC-05 did not establish a mandatory mutation boundary; do not implement a proxy with bypassable paths. |
| WAL-03 | decision done | [Compensation catalog ADR](adr/phase-c-compensation-catalog.md): no current operation has complete durable compensation semantics. |
| WAL-04 | deferred | WAL-03 found no supported compensatable operation; select only after durable before-images, ownership/version checks, and DBC-06 passes with an enforced mutation route. |
| PIP-05 | deferred | [Pipelines and routing ADR](adr/phase-c-pipelines-routing.md): no repeated real CLI workflow requiring multistage composition was demonstrated. A shared consumer is only needed to justify a broker. |
| OPT-04 | deferred | [Pipelines and routing ADR](adr/phase-c-pipelines-routing.md): OPT-01..03 are unstarted; this records a prerequisite-based defer, not an owner rejection of routing. |
| M3 independent audit | accepted | Auditor accepted all nine Phase C decision gates and evidence-backed deferrals; see the linked ACT, DBC, WAL, PIP, and OPT decision records above. |
| Verification | done | `env -u NODE_TEST_CONTEXT npm test`: 548 passed, 13 suites, 0 failed/cancelled/skipped, 35,867.805797 ms; full log `/tmp/phase-c-full-test.log`. This verifies the current runtime, not unselected Phase C implementations or resource savings. |
| Integration | direct main | Accepted decision records are included in this documentation change on main under explicit user authorization; no separate branch or runtime activation is required. |

## Throughput and quality queue (2026-10-10)

Opened after a latency audit of a live run (5 of 15 worker turns cut by the 600 s
turn timeout, lead context growing every round, writers strictly serial). Items run
in the listed order unless marked independent.

| Item | State | Scope |
| --- | --- | --- |
| LAT-01 | done `fb7eac1` | Turn timeout 3600 s; fresh lead thread per round; `decision_rejected` event; live activity in the dashboard chat; team LEDs. |
| PW-1 | done `d4cf38e` | Worktree git mechanics ([design](parallel-writers-design.md)). |
| PW-2 | done `8551390` | Assignment `wave`, group dispatch behind `parallelWriters` (off until PW-3). |
| PW-3 | done `0580e1d`..`a0f9ebe` | Hardened git, confinement probe (live pass on codex 0.162), lane execution and integration under admission, lead-side handling, e2e test. |
| BUD-1 | done `ddd0f4b` | Automatic resume of budget-paused runs ([design](budget-auto-resume-design.md)). |
| BUD-2 | done `27f464e` | Continue a worker cut off by a usage limit in its own thread and lane instead of re-planning. |
| ACC-01 | done `fb0ad8b`, `eff0083`, `3438c10` | Several Codex accounts as profiles, login and switching from the web UI, automatic switch to an account with budget when a run pauses for a limit ([design](codex-accounts-design.md)). |
| CA-01 | queued after PW-3 | Competing approaches: the lead may give one assignment to N writers in separate lanes; the winner is chosen by executed checks, only the winner is integrated (PRD section 9.1 analogue). |
| LL-1..LL-5 | done `9d72147`..`281db09` | Lead loop fixes after the M3 runs: escalation instead of looping, normalized worker reports, previous-run digest, agent-proposed pinned acceptance checks in the sandbox, scope continuation ([design](lead-loop-fixes-design.md)). |
| LL-6 | done `9de69a1` | Investigate before asking the owner: closed owner-only list, investigation evidence required, auto-extending rounds on progress, auditor review of changed check scripts. |
| LL-7 | done `79544f7` | Escalation exit after the M3 loop on Codex 0.162.1 limits: owner-only reason `infeasible_requirement` (a dependency or the environment lacks a capability, proven by investigation); a persisting blocker located outside what the team may change is escalated instead of re-investigated; building a substitute for a missing platform capability is scope expansion. Decision card shows reason, recommended option, evidence, and independent work; choice by option only (`a7be218`). Open: browser check. |
| LL-8 | locally qualified 2026-10-13; activation pending | Owner request, 2026-10-12: unlimited default dispatch rounds for healthy long runs; bounded persistent repeated-work detection, a replan warning followed by a diagnostic pause, and transparent technical graph rollover ([design](lead-loop-fixes-design.md#ll-8-healthy-long-runs-and-repeated-work-recovery-2026-10-12)). |
| SES-01 | done `63080b4` | One continuous lead thread per dashboard session with delta prompts and context-based rollover ([design](session-continuity-design.md)). |
| CTX-01 | done `cdbd152` | Reading discipline after measuring start-up reading (42% of worker input) and outputs over 20 KB (72% of output bytes): `tool_output_token_limit` 3000 per thread, bounded reads, inlined team rules, lead briefs with exact line ranges. Open: verify the cap's effect in a live turn; shared explorer map artifacts; compact skill digests. |
| TOK-PROMPT-01 | queued 2026-10-14 | Measure coordinator and auditor prompt composition, then run a reversible one-role compression pilot against matched assignments. Preserve all review gates, model/effort settings, and active runtime; retain changes only with measured token reduction and unchanged acceptance/safety outcomes. See details below. |
| ROLE-01 | done `34f01ac`, `8196443`, `46d2098` | Per-project role overrides (owner request, 2026-10-11): clicking a role in the team card opens an in-page modal to set model, reasoning effort, and extra rules for that role in the current project only; stored in `.runtime/projects/<id>/role-overrides.json`, never global. Read once at project-server start; edits are locked (409) while the server runs; a changed lead profile rolls the session lead thread over. Open: browser check of the modal. |
| UI-01 | idea | Under the session status, list the skills given to the run's assignments and the MCP servers and tools enabled per turn ([ideas](dashboard-ideas-backlog.md)). |
| UI-02 | idea | Integrations sidebar: Confluence, Figma, GTM, Context7 and more, with auth state and per-role enablement ([ideas](dashboard-ideas-backlog.md)). |
| EP-01 | queued after CA-01 | Execution Paths (owner product decision, 2026-10-10): at intake the lead selects one path from a closed catalog (for example iterative, distributed, review) and records it with the run; decisions are validated against the path's role and cardinality rules; changing the path goes back through planning. Compare paths with [the benchmark plan](orchestration-benchmark-plan.md). |

### TOK-PROMPT-01 - Measure and reduce coordinator/auditor prompt overhead [P1]

State: queued 2026-10-14 for a safe runtime transition after the active
orchestrator run.
No profile or runtime changes are authorized by this backlog entry.

- Record a comparable baseline for coordinator and auditor assignments: input,
  cached input, output and reasoning tokens where available; elapsed time;
  outcome; retries or rework; permission denials; and review acceptance.
- Inspect static and dynamic prompt composition for duplicated general
  instructions. Pilot one role at a time and remove only text proven redundant;
  retain every policy, scope boundary, and acceptance requirement.
- Compare matched task classes before and after. Label API-price figures as
  counterfactuals; subscription cost remains unknown unless directly measured.
- Keep a profile change only if token use decreases and acceptance, safety,
  rework, and elapsed-time results remain within declared tolerances. Otherwise
  restore the baseline profile.
- Do not lower reasoning effort, remove reviewers, change rollover behavior,
  or modify/reload a runtime while it is serving the active run.

Starting evidence: `.agents/teamwork/root/token-optimization-review.md` records
the 2026-10-13 usage snapshot. Coordinator and auditor contributed about 91% of
the known-row short-context API-price counterfactual; 94% of worker input was
cached. These are prioritization signals, not proof that the prompts waste
tokens or that a change will save money.

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

#### OPS-03 - The lead write guard does not block read-only `sed -n` [P1]

Executor: worker. Proposed write scope: `~/.codex/hooks/guard.py` and its tests
(guard edits need owner approval). Found live 2026-10-12: the lead's read-only
`sed -n '9,18p' ... && rg -n -i ...` was blocked as `lead_write: in-place
editor`. `guard.py:170` checks every later token of the whole command
(`tokens[i + 1:]`), so `rg -i` (or any `-i...` flag in another chained command)
is attributed to `sed`. Limit the scan to the arguments of the same simple
command (stop at `&&`, `||`, `;`, `|`), and match only real in-place flags
(`-i`, `-i.bak`, `--in-place`, and for perl `-i`/`-pi`), not `-n`. Tests:
`sed -n ... && rg -i` allowed; `sed -i`, `sed -i.bak`, `sed --in-place`,
`perl -pi -e` blocked. Cost of the defect: wasted lead turns and a failed plan
write attempt per false block.

#### OPS-04 - A writable verifier that changes nothing still gets a receipt [P0]

Status: done in the working tree, 2026-10-12; independent review approved.
Empty lane collection now attests a known empty delta while preserving the
`not_integrated` / `no_changes` lifecycle. Only a verifier with this proof,
known unchanged review coverage, and no scope violations can receive the
service acceptance and lead receipt. Unsafe/canceled lanes and unknown,
nonempty, or inconsistent deltas remain rejected. Regression coverage spans
lane collection, review policy, role service, and critical lead receipts.
Verification: `env -u NODE_TEST_CONTEXT npm test` passed 1034 of 1035 tests,
0 failed, 1 skipped (optional live lane probe); no live LLM calls.

Executor: worker-sonnet (review gate is a risk area). Proposed write scope:
`src/review-policy.js`, `src/lead-graph.js`, their tests. Found live 2026-10-12
(codex_team_work M4, runtime a1efa03): a verifier on a writable sandbox that
makes no edits ends with its lane `not_integrated` / `no_changes`
(`src/writer-lanes.js:380`); `reviewResult` (`src/review-policy.js` ~:196)
accepts only `released`/`reconciled` and returns `review_writer_unsettled`, so
no passing receipt is ever recorded. The critical checkpoint then blocks the
commit and all writers, and verifier retries cannot help. Fix: treat a
`no_changes` lane with a known empty delta and an unchanged target identity as
settled for review (equivalent to read-only), still rejecting unknown deltas,
scope violations, and other unintegrated reasons. Tests: writable verifier
with no edits gets an accepted receipt; `lane_unsafe`, `canceled`, unknown
delta, and target change stay rejected.

## Future autonomy ideas: spec-driven planning and recovery (2026-10-15)

Status: ideas only. These items are not part of M0-M3 acceptance and do not
authorize runtime changes. Preserve the current PRD, plans, and task contracts
as the sources of truth; avoid creating a competing specification set.

Spec Kit is a candidate workflow reference, not a required dependency. Its
specify -> plan -> tasks -> implement -> converge flow and spec-of-specs
roadmap pattern may help the lead turn an epic into bounded, dependency-ordered
slices. Pilot the artifact model on one future feature before considering CLI or
skill installation: <https://github.com/github/spec-kit> and
<https://github.com/github/spec-kit/blob/main/docs/concepts/spec-of-specs.md>.
Spec Kit's analyze step is read-only and its core does not reconcile all
artifacts automatically, so the harness must own consistency checks and the
authority to accept changes:
<https://github.com/github/spec-kit/blob/main/docs/guides/evolving-specs.md>.

### AUT-01 - Requirement-to-task traceability [P1, offline pilot accepted]

Accepted offline Phase 1: [qualification and limits](aut-01-review.md). Runtime
enrollment and admission remain separate unqualified work.

Pilot a lead-produced map from stable requirement and acceptance IDs to bounded
tasks, dependencies, writable paths, checks, evidence, review gates, and stop
conditions. Each task must trace back to at least one requirement; every
mandatory requirement must be covered. Run a deterministic, read-only analyzer
before dispatch to report uncovered requirements, orphan tasks, dependency
cycles, missing acceptance evidence, and conflicts with source plans. The lead
resolves findings explicitly; the analyzer never silently rewrites source
documents. Use the existing PRD and plans as canonical inputs.

Exit evidence: representative plans yield a complete traceability map, every
derived task passes the dispatch contract, and analysis detects seeded coverage,
dependency, and scope-boundary defects without changing files.

### AUT-02 - Fresh-target review recovery [P1, accepted]

AUT-02 is accepted for deterministic offline fresh-target recovery. The focused
qualification passed 333 tests with 0 failures and 2 sandbox-specific skips;
the full project suite passed 1207 tests with 0 failures and 1 explicitly gated
live-probe skip. Q01 passed 2/2, Q11 passed 5/5, and independent verifier and
auditor reviews approved the mandatory Q01-Q14 evidence. See the
[acceptance decision](evidence/aut-02/acceptance.json),
[review](aut-02-review.md), [baseline/final comparison](evidence/aut-02/comparison.md),
and [qualification status](evidence/aut-02/qualification-status.json).

When an implementation changes a reviewed candidate, invalidate its old
receipts and require a verifier, followed by an auditor where the checkpoint
requires one, against the new target. A stale continuation must be rejected
before model execution and return the lead to a bounded fresh-review path; do
not reuse historical review origins or weaken the stored checkpoint context.
Use the 2026-10-15 r215 `review_origin_stale` event as a regression fixture.

Exit evidence: the stale continuation remains non-authorizing, the lead
automatically dispatches a correctly bound fresh review, and the current-target
verifier/auditor receipts pass without a repeated preflight rejection or gate
bypass.

### AUT-03 - Lead spec-decomposition skill [P2, offline delivery qualified; paired trial pending]

The [AUT-03 runbook](aut-03-lead-decomposition-runbook.md) is prepared and
independently approved in [its review record](evidence/aut-03/runbook-review.md).
Its AUT-02 acceptance entry condition is satisfied. AUT-03 implementation has
completed for offline lead-only delivery and deterministic plumbing; final
audit approved. The independent case set and delivery verification are recorded under
`docs/evidence/aut-03/`. No live baseline or paired planning trial was captured;
quality and economy remain unqualified pending a separately authorized cohort.

Trial one versioned, hash-pinned skill for converting a short user goal and
canonical project documents into a roadmap, requirement map, dependency-ordered
tasks, and a dispatch-readiness report. Keep user authority, scope boundaries,
and the existing assignment contract explicit. Prefer the skill over expanding
the global system prompt; enable it only for the lead during the pilot.

The offline exit covers a trusted lead-only pin, worker isolation, resume and
rollover behavior, and unchanged lead tool policy. Full AUT-03 exit still
requires the authorized paired trial: on the autonomy regression set, the lead
must preserve all explicit constraints, identify missing decisions rather
than inventing them, and produce dispatchable tasks with no coverage or
dependency defects. Retain the skill only if it improves these outcomes without
unacceptable prompt or token growth.

### AUT-04 - Read-only structured evidence tools [P2, idea]

Consider MCP only if evaluation shows that roles cannot reliably retrieve
canonical run-scoped data through existing interfaces. Candidate read-only
operations include current candidate identity, requirement dependencies,
checkpoint receipts, and required-check results. Scope every lookup to the
authorized run; return typed data and evidence references. MCP must not decide
review freshness or grant mutation authority; deterministic runtime contracts
remain responsible for those guarantees.

### AUT-05 - Autonomy regression corpus and measures [cross-cutting, baseline accepted]

Accepted offline v3 preparation baseline: [review and exact decision](aut-05-review.md).
The AUT-01 [comparison](evidence/aut-01/comparison.json) qualifies structural
capability only. Live workflow and economy measurements remain unavailable.

Before retaining prompt, skill, model, or orchestration changes, record a
baseline and compare representative tasks with the same acceptance rules. Seed
cases from known failures: incomplete canonical identity checks, contradictory
nested manifests, fixture/dispatcher producer mismatch, and stale review
continuation. Track first-pass accepted checkpoints, repair/review cycles,
owner escalations, elapsed time, and measured cost per accepted result. Never
trade acceptance or safety for fewer rounds; unknown measurements stay unknown.

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
