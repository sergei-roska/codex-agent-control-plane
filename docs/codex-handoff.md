# Current handoff: audit loop and session repairs (2026-10-13)

The current local work map is `.agents/teamwork/PROJECT.md`; read the lead's
handoff linked there before broad exploration. Root `AGENTS.md` defines the
succession protocol. Local teamwork is ignored by Git and may be absent in a
fresh checkout, so this section is the fallback. Historical sections below do
not authorize new M2/Phase C work.

## Current behavior

- Healthy runs have no default dispatch-round limit. Explicit `maxRounds`
  remains a caller allowance; only an owner decision extends that allowance.
- A bounded checkpointed detector warns after three unchanged results, then
  pauses a continued cycle with `loop_detected`. Same-work novelty clears its
  warnings; unrelated work does not. Mixed batch order does not affect novelty.
- Owner loop decisions can reset detection. Budget/restart recovery retains
  history. Writer reconciliation, review gates and acceptance remain required.
- LangGraph step-limit rollover requires advanced checkpoint identity and step;
  original inputs and resume commands are not replayed.
- Equivalent review work is identified by role, checkpoint and declared scope.
  Paraphrased instructions and incidental evidence IDs do not reset detection;
  scoped content and performed-check changes remain relevant evidence.
- Acceptance auditor reports use an exact standalone verdict line. Required
  executions or explicit prior-evidence validations go in checks; supplemental
  diagnostics, excluded tests and cited prior evidence go in risks. Required
  failed/unrun checks still block acceptance. Pinned checks retain preserve/weaken.
- Confirmed owner Pause/Stop enables New session after running workers finish.
  The old durable session remains selectable and resumable; in-flight controls
  and stale situation data cannot unlock the action.
- The earlier independently accepted OPS-04 no-change verifier receipt fix is
  retained in the same working tree. Baseline HEAD is `e5f5c6f`.

## Qualification and activation

Independent review approved these repairs. The full suite passed: 1,077 tests,
1,076 passed, 0 failed, 1 optional live confinement probe skipped. Focused
detector/graph/orchestrator checks passed (17/195/22), as did seven session
control cases and ten disposable-server pause cases. Read-only replay of actual
production rounds r33-r37 warned at r36 and paused at r37; the interleaved
explorer and paraphrased instructions did not erase the repeated audit history.
Run tests with `env -u NODE_TEST_CONTEXT`; inherited Node test context can report
only wrapper counts. Existing `/var/tmp` and HTTP fixtures may require normal
sandbox escalation. Do not weaken their expectations to avoid permission errors.

The running server and paused task have not been restarted or resumed. Loading
this code into a running service remains a separate activation step. No real
10-hour run has been performed; complete outcome/checkpoint history still grows
with run length. The detector is a bounded heuristic, not a semantic proof.

The user requested a local commit after qualification. No push or deployment
was performed.

---

# Historical handoff: finish M2, then Phase C

Written 2026-10-05 by the Claude lead session that implemented Phase A and
Phase B. You are the lead of this repository's team (`profiles/TEAM.md`); follow
its authority, dispatch, and escalation rules. Report to the owner in Russian;
write all code, docs, and commit messages in English, ASCII only.

## State

- `main` (`1b107f4`): Phase A merged (MEA, PIP, DBC, OPS-01, MEA-02).
- `feature/orchestrator-phase-b` (head `9c736ee`, not merged): OPS-02, WAL-01,
  WAL-02, SUP-01..03. `npm test`: 535 tests green at `f968e6c`.
- Live status: "Phase A progress" and "Phase B progress" tables in
  `docs/orchestrator-improvement-backlog.md`.
- Contracts (frozen; a change reopens the item): `docs/supervisor-recovery-contract.md`
  (read "Generation ownership invariants" I1-I5), `docs/intent-recovery-contract.md`,
  `docs/execution-boundary-contract.md`, `docs/evidence-artifact-contract.md`,
  `docs/orchestration-benchmark-plan.md`. Established guarantees:
  `docs/hardening-spec.md`, `docs/resilient-orchestration-spec.md`.

## Step 1: M2 fixes (merge blockers), on `feature/orchestrator-phase-b`

An independent pre-merge audit verified these by running reproductions. Each fix
needs a test that fails before the fix.

- F1 (major), `src/codex-app-server.js` ~:211, :389, :1108. When `start()` takes
  the terminate-and-wait branch (exitError set, leader alive: after invalid JSONL,
  stdout close, child `error` while idle, or a start in the SIGTERM-to-exit
  window), the old leader's later exit runs `_failAll`, which sets
  `startPromise = null` while the replacement start is still running. The next
  `start()` (often the same run's `listMcpServerNames`, ~:488) spawns another
  generation and orphans the one just started (observed children 1 -> 3, gen 2
  never signalled and unreachable by `close()`; `execution.generation` reports 2
  for a turn on 3). During backoff or a probe a concurrent caller starts a second
  start and overwrites `sleepCancel`. Fix per invariants I1-I3 and I5 (single start
  owner; events of generation g affect only g; fail a generation once; set the
  run's generation when `turn/start` is sent).
- F2 (major), ~:970-988 (turn_timeout), ~:1006-1011 (interrupt_unconfirmed),
  ~:814-826 (turn_start_unknown, siblings). These charge the budget and call
  `_terminateProcess` but neither fail the generation nor reject runs; only the
  child's `exit` settles them, and `start()` keeps returning the resolved start
  promise, so the bounded exit wait is never reached. With a leader that survives
  SIGTERM/SIGKILL (D state) and `turnTimeoutMs=100`, the writer run stayed pending,
  later runs went to the dead child as uncharged `rpc_timeout`, and
  `supervisorState().state` said `stopped`. Fix per I4: fail the generation at the
  decision, settle runs by the per-run outcome rule, start the exit-wait deadline
  on the injected clock, record `unreaped` on expiry. Depends on F1.
- F3 (minor, fix now), ~:708-719, :970-988, :440. A turn/start response and an
  invalid JSONL line in one chunk: `_failAll` runs before the run reaches
  `_waitForTerminal`, so the run is never rejected; after the exit-wait bypass,
  `_discardFailedChild` leaves it in `this.runs`, and its turn timeout later
  interrupts, charges, and terminates generation 2. Fix: timers capture their
  generation and no-op on mismatch; check failure after `await turnStartRequest`;
  reject leftover runs in `_discardFailedChild`.
- F4 (safety), `src/launcher-sessions.js` ~:125, :133: session deletion removes
  `writer_executions` rows in any state, which can free a held workspace without
  reconciliation. Refuse deletion while any execution row of the run's tasks is
  `active` or `unresolved`; delete only `released`/`reconciled` rows. Test it.
- F5, `src/lead-orchestrator.js` ~:17: the default cancel-confirmation deadline is
  20000 ms; the contract now says 30000 ms (worst case about 18.3 s). Test it.

Acceptance for Step 1: fake-clock tests (the module already accepts `clock`,
`spawnImpl`, `killImpl`, `listGroupMembersImpl`) reproduce F1-F3, including a
leader that never exits and two concurrent callers during backoff and during a
probe asserting exactly one spawn; `npm test` green; then an independent read-only
`auditor` pass on the Step 1 diff against invariants I1-I5. Then commit on the
branch, set M2 to done in the Phase B table, and merge the branch into `main`
with `--no-ff` (the owner authorized merging accepted branch work into `main`;
do not push).

## Step 2: Phase C

Read "Phase C: conditional epics" in the backlog. Phase C is decision-gated: no
epic is implementation-ready until its decision output exists. Work on a new
branch `feature/orchestrator-phase-c`.

1. Ask the owner first whether routing (OPT) is wanted. OPT-04 depends on
   OPT-01..03 (Phase B, not started); if routing is not wanted, record OPT-04 as
   deferred.
2. Decision spikes, each producing an ADR in `docs/adr/` with measured evidence
   and an explicit go/defer: ACT-01 (process topology: shared process vs role pool
   vs attempt-scoped process; use the MEA-02 startup and the SUP-03 recovery
   numbers), DBC-05 (can a scoped tool set be mandatorily mediated; if not, defer
   the proxy), WAL-03 (catalog of reversible operations and compensation
   semantics). PIP-05 only if repeated CLI workflows with real consumers exist.
3. Implement an epic (ACT-02, ACT-03, DBC-06, WAL-04, PIP-05, OPT-04) only when
   its ADR says go; decompose it into contract, implementation, acceptance, and
   integration tasks with disjoint write scopes before dispatch.
4. M3 gate: every selected epic passes its safety and resource gates or has an
   evidence-backed defer; no unqualified savings claim; independent auditor pass
   before merging into `main`.

Rules that stay in force: writer admission, unknown-outcome reconciliation,
pinned acceptance checks, role escalation, and approval boundaries are kept;
unknown is never zero or pass; runtime checks add no model calls; contracts
before code; one reviewable change per task; `npm test` green at every commit;
keep a "Phase C progress" table in the backlog.

## Small follow-ups (opportunistic)

- Lead-turn ledger rows lack `startupMs`/`coldStart` (`src/lead-graph.js`
  ~:723-757), hiding a cold start claimed by a lead turn.
- `threadTotals` resets on process start (`src/codex-app-server.js` ~:166), so
  the first resumed turn reports `tokens: null`.
- A pre-turn writer released after a crash gets `failureKind: "other"` and no
  `effects` key (`src/a2a-role-service.js` failure mapping); map it to its
  failure class with `effects: "none"`.
- `runCheck` should drop `NODE_TEST_CONTEXT` from the check environment; an
  inherited value makes a nested `node --test` report success on failure.
- `classifyFailure` falls back to `request_rejected` for unclassified errors;
  confirm no process-loss error can take that path.
