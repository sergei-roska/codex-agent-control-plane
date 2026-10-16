# Transfer log for the production orchestrator

This repository is the staging project. Record all discovered problems,
attempted resolutions, verification results, and architectural decisions for
the production orchestrator. Add an entry when a problem is found or a decision
is taken, including UI-related work. Each architectural decision has an ADR.
Preserve failed attempts and dated history; distinguish proposed, implemented,
and verified behavior. Unknown causes and measurements remain unknown.

Use stable problem IDs and link detailed evidence, runs, assignments, attempts,
and revisions where available. Each problem records its symptom, cause or
uncertainty, attempted fix, result, remaining limits, and production action.
See `docs/adr/staging-lessons-and-decision-log.md` for the owner requirement.
Durable runtime logging additions are implemented and independently accepted
after owner-authorized staging shutdown. They load on the next service start.
Implementation, isolated verification, and live qualification are separate.

## Architectural decisions

| Date | Decision | ADR |
|---|---|---|
| 2026-10-14 | Chuck Norris system repair agent added, then removed the same day after its first live use (superseded) | docs/adr/chuck-norris-system-repair.md |
| 2026-10-12 | Retain staging problems, attempted resolutions, and architectural decisions with evidence and statuses; durable runtime implementation qualified in isolation | docs/adr/staging-lessons-and-decision-log.md |
| 2026-10-11 | Session token usage is attributed through lead run ids and the dispatch journal, not context ids | docs/adr/launcher-session-usage-attribution.md |
| 2026-10-11 | The launcher projects live run state read-only from the lead's LangGraph checkpoint | docs/adr/launcher-situation-from-checkpoint.md |
| 2026-10-11 | Owner questions go to the read-only scout role directly, bypassing the lead | docs/adr/launcher-scout-ask.md |
| 2026-10-11 | Owner pause via an `owner_pause` interrupt at safe boundaries; Stop leaves the lead resumable | docs/adr/owner-pause-and-resumable-stop.md |
| 2026-10-12 | The auditor runs at phase end, on risk-area changes before dependents, and for unsettled blockers, not every round; routine checks go to the verifier | docs/adr/auditor-dispatch-points.md |
| 2026-10-12 | Sandboxed acceptance checks can get an owner-enabled per-run scratch directory outside the checkout, /tmp and $HOME | docs/adr/acceptance-per-run-scratch.md |
| 2026-10-12 | Selective auditor dispatch with verifier acceptance, declared review gates, scoped receipts, and durable correlated evidence; implemented and independently accepted, live trial pending | docs/adr/auditor-dispatch-points.md |
| 2026-10-16 | AUT-03 activation requires strict per-project owner opt-in; a non-empty startup UUID list optionally narrows runs; default off, offline implementation only | docs/adr/aut03-project-opt-in.md |
| unknown | Keep a shared App Server process; defer unqualified actor isolation and queue activation | docs/adr/phase-c-actor-topology.md |
| unknown | Defer a mutation proxy without a proven mandatory enforcement route | docs/adr/phase-c-tool-boundary.md |
| unknown | Defer compensation without durable operation-specific reversal semantics | docs/adr/phase-c-compensation-catalog.md |
| unknown | Defer pipeline/routing activation until real consumers and prerequisite evidence exist | docs/adr/phase-c-pipelines-routing.md |

All current `docs/adr/*.md` records are indexed above. Original dates missing
from the Phase C records remain unknown. Earlier problem/decision evidence is
also indexed in `docs/m2-audit-resolution.md`, `docs/lead-loop-fixes-design.md`,
`docs/codex-handoff.md`, and `docs/orchestrator-improvement-backlog.md`. Their
historical acceptance claims are retained; incomplete opportunistic follow-ups
are not promoted to verified fixes.

## Problems found

### P-36 AUT-03 trial activation had no per-project owner gate

- Symptom: the startup UUID cohort was the only activation gate, so a matching
  run ID could receive the lead skill in any server project sharing that
  process configuration.
- Remedy: add strict `aut03LeadSkillEnabled` to the trusted project settings
  file and require its literal `true` value. A non-empty startup UUID list can
  narrow this project opt-in to exact run IDs. The setting is default-off and
  read once at startup; invalid settings fall back to disabled defaults.
  Request, assignment, and model output remain unable to authorize activation.
- Status: implemented in source and covered by offline regressions; no live
  trial, active-project enablement, or service restart was performed.
- Production: preserve both independent gates, startup provenance, pin/hash
  validation, and checkpoint/profile rollover behavior.

### P-01 Stop outcome depended on a kill/drain race

- Symptom: after Stop a lead task was sometimes resumable, sometimes CANCELED.
- Cause: the launcher SIGKILLed after 2 s, the server needed 5 s to drain;
  killed runs were reconciled to a restart pause, drained runs were cancelled
  (terminal).
- Model: STOP-01 parks active leads as a resumable `stopped` pause and waits
  for the drain before SIGKILL.
- Production: process supervisor grace must exceed the orchestrator drain
  timeout, and shutdown must persist runs as resumable, never terminal.

### P-02 Stopping the server killed the team mid-work

- Symptom: the only way to stop was to cancel running worker turns.
- Cause: no owner pause; graceful shutdown cancelled active runs.
- Model: PAUSE-01 owner pause at decide start / after collect, workers finish.
- Production: provide a soft pause distinct from the emergency stop from day one.

### P-03 The owner had no live view of a running session

- Symptom: the owner had to wait for the turn to end, or open Codex in the
  project, to learn the phase, the plan, and what changed.
- Cause: run state lived only in the checkpoint; the UI showed chat and
  activity rows.
- Model: SIT-1..3 situation projection and panel.
- Production: expose a first-class run-state read model (phase, batch,
  decisions, acceptance, changed files) instead of reading checkpoint internals.

### P-04 The owner could not ask anything while the lead worked

- Symptom: composer locked; the server rejects a second message to a running
  task; notes to a running lead (`pendingNotes`) are in memory only.
- Model: SIT-5 questions go to the read-only scout, not the lead.
- Production: support side questions without touching the lead, and decide
  separately whether durable owner notes to a running lead are needed (SIT-4).

### P-05 Worker usage rows cannot be found by session

- Symptom: filtering `usage_ledger` by session context id misses all worker usage.
- Cause: worker rows carry a per-attempt context id; only `dispatch_journal`
  links them to the lead run.
- Production: stamp a session/run id on every usage row at write time.

### P-06 Role names drift in persisted data

- Symptom: old lead usage rows use `orch-lead`, new ones `coordinator`.
- Model: fold legacy names at read time.
- Production: store canonical role ids only; keep an alias map for imports.

### P-07 Checkpoint state is incomplete for observers

- `batch` is null after verify, so the last round has to be rebuilt from
  `outcomes`; outcomes carry no objective; `progress` entries have no
  timestamps.
- Production: persist objective, timestamps and per-round results as part of
  the run-state read model (see P-03).

### P-08 Changed files are self-reported by workers

- Symptom: `report.filesChanged` can differ from what was actually written.
- Model: prefer engine-measured `writer_executions.delta_json.changedPaths`
  when `known = true`.
- Production: treat measured deltas as the source of truth; self-reports only
  as hints.

### P-09 Roles share one app-server child and the accounts

- Symptom: no worker pool cap; a hung or crashing extra run (e.g. a scout ask)
  can exhaust the app-server restart budget (3) or the account limits the lead
  needs.
- Model: one ask per project, hard timeouts, cancel.
- Production: isolate side runs (separate child or quota) and add explicit
  concurrency limits.

### P-11 Pause and stop can only act at graph boundaries

- Symptom: a pause waits for the slowest running worker turn (up to
  turnTimeoutMs) and for an in-progress lead decide turn; a pause requested
  after the last boundary (e.g. during finish) is lost and the run ends
  normally; a Stop parks only when the run reaches finish or throws, and if
  the drain timeout is exceeded the task is left WORKING (later reconciled to a
  restart pause).
- Cause: LangGraph routing functions cannot interrupt (a dedicated gate node
  was needed after collect); the pause flag is in memory.
- Production: make pause/stop requests durable and checked by the run loop at
  every step boundary, and show the owner the expected wait.

### P-12 Lead notes live only in memory

- Symptom: notes queued for the next decide (e.g. "your acceptanceChecks
  proposal was ignored") are lost whenever the run parks (owner, budget or
  human-decision pause) or the server restarts.
- Cause: `pendingNotes` is held in the orchestrator runtime, not the checkpoint.
- Production: persist lead notes with the run state.

### P-13 Shutdown budget spans several stages

- Symptom: drain (5 s) plus app-server and HTTP close (up to 5 s) exceeded the
  supervisor grace, so a clean lock release could be cut off; a run that
  completed during shutdown could still end FAILED ("cancellation could not be
  confirmed").
- Production: derive the supervisor grace from the orchestrator's total
  shutdown budget, and let a completed result win over a late abort.

### P-14 The auditor ran in every round

- Symptom: the lead dispatched the auditor (Sol, high) in almost every round
  (run `a125b4c6`: rounds 2-11), adding cost and a serial wait.
- Cause: no rule said when to audit; the role description and the
  investigate-first rule made it the default reviewer.
- Model: explicit dispatch points in `profiles/TEAM.md`
  (`docs/adr/auditor-dispatch-points.md`); verified in the dispatch journal
  (round 13 was the first without an auditor).
- Production: define when each costly review role runs as part of the role
  contract, and measure per-round role usage so the frequency is visible.
- Remaining limit: the dispatch-point rule is prompt guidance. Lead prompts
  still suggest an auditor for ordinary blocker investigations, while changed
  pinned acceptance scripts automatically select a read-only reviewer with the
  auditor first. The current process's loaded policy was not rechecked.
- Implemented follow-up: `docs/auditor-routing-plan.md` after staging shutdown.
  Routine verification uses Quality Engineer; critical audits, scoped receipts,
  and durable reasons/findings are preserved. Isolated checks and independent
  review passed; frequency and resource use need a later bounded live trial.

### P-16 Equal-time staging events could reverse a problem's history

- Found: 2026-10-12 during implementation source review; not activated in a live run.
- Symptom: writing event `z` as open and then `a` as resolved in the same
  millisecond returned them in lexical ID order, reporting open as latest.
- Cause: the initial log used time plus event ID rather than insertion order.
- Remedy: SQLite row order and stable in-memory insertion order break time ties.
- Evidence: deterministic equal-timestamp case in `test/staging-log.test.js`.
- Status: isolated verification passed; independent sanitizer review is separate.
- Production: preserve causal append order even when timestamps coincide.

### P-17 Missing or truncated history could look complete

- Found: 2026-10-12 during source review; not activated in a live run.
- Symptom: a read-only log reader returned an empty array for a missing table;
  a limited report could expose an old status without indicating missing updates.
- Remedy: missing history raises `STAGING_LOG_UNAVAILABLE`; report includes
  total/partial coverage and uses a bounded latest window with explicit status scope.
- Evidence: missing-table and limited-history tests in `test/staging-log.test.js`.
- Status: isolated verification passed; live history continuity remains unqualified.
- Production: unavailable and incomplete evidence must not look empty or complete.

### P-18 Initial staging sanitizer allowed forbidden payloads

- Found: 2026-10-12 by independent review; not activated in a live run.
- First failed review, SAN-1: nested environment and prompt fields were accepted,
  including credential-bearing connection strings. Passing initial tests had no
  coverage for these payloads.
- First remedy: reject environment/prompt fields at every nesting level and
  redact URL credentials. Focused tests passed, but review found another gap.
- Second failed review, SAN-2: the URL rule covered HTTP/FTP only; a database
  connection URL could still retain user-info credentials in a summary.
- Reassessment/remedy: handle user-info for any valid URI scheme, redact secret
  query values, reject secret-bearing identities, and add database/cache/custom
  URI and percent-encoding cases.
- Evidence: `test/staging-log.test.js`, 11 focused tests passed after the second
  remedy; independent re-review APPROVE confirmed the original reproductions.
- Production: never store raw prompts/environments; redaction is a practical
  defense for bounded summaries, not proof that arbitrary text contains no secrets.

### P-19 The default verification sandbox cannot run all existing checks

- Found: 2026-10-12 during initial verification.
- Symptom: the scratch regression could not create its required `/var/tmp`
  directory (`EROFS`); integration suites also need local test services.
- Remedy: use the approved test execution outside the restricted sandbox,
  preserving the real regression rather than changing its expected behavior.
- Evidence: direct scratch-test failure and the subsequent 980-test run. That
  run overlapped a schema edit and had one schema-fixture mismatch, so it is
  explicitly not a final acceptance result.
- Production: declare test environment capabilities and verify a stable candidate.

### P-20 Review identity could follow an escaped ancestor symlink

- Found: 2026-10-12 during implementation source review; not activated in a live run.
- Symptom: a regular file below a symlinked parent could be hashed even when
  its real path escaped the assigned workspace.
- Cause: the initial scope walker resolved only a final symlink, then checked
  lexical containment for ordinary leaf paths.
- Remedy implemented: validate real paths including existing ancestors before reads;
  fail unknown for unsupported special nodes and unsafe/missing scope identity.
- Status: regression passed and independent integrated review APPROVE.
- Production: leaf path validation alone does not enforce filesystem containment.

### P-21 A repair could bypass or weaken a pending audit gate

- Found: 2026-10-12 during implementation source review; not activated in a live run.
- Symptom: checking whether any assignment repaired a checkpoint could authorize
  an unrelated writer in the same batch. Reusing a critical checkpoint ID with
  routine metadata or narrower paths could replace the original obligation.
- Cause: batch-wide permission and mutable checkpoint context in the initial helper.
- Remedy selected: check each writer independently and keep checkpoint context
  immutable; same-checkpoint reviewer/repair metadata must match the declaration.
- Status: regressions passed and independent integrated review APPROVE.
- Production: a repair is scoped authority, and a later plan cannot silently
  remove the original audit requirement.

### P-22 Alternate finalization paths could omit required review checks

- Found: 2026-10-12 during source review of the initial implementation.
- Symptom: validating only a lead `finish` decision would leave owner
  `accept_as_is`, resumed acceptance/finalization, and abnormal endings outside
  the new receipt gate.
- Remedy: check required current-target receipts in deterministic acceptance
  and finalization too. Canceled paths remain canceled and do not run checks.
- Status: focused regression passed and independent integrated review APPROVE.
- Production: enforce acceptance predicates at the authoritative result boundary,
  including every route that can reach it.

### P-23 Matching endpoint hashes could hide writer interference during audit

- Found: 2026-10-12 by independent direct-role review after 48 focused tests passed.
- Symptom: a managed writer could alter a scoped file during an auditor turn,
  restore it, and finish before the final holder/hash check. The auditor could
  then accept matching hashes after reading an inconsistent candidate.
- Cause: before/after checks did not reserve the review interval against writers.
- Remedy selected: an exclusive existing-admission reservation for auditor and
  read-only pinned-check integrity reviews, separate from writable execution or
  lane authority, with cleanup on success/error/cancel/limit/log failure.
- Status: concurrent writer regression passed; independent service and
  integrated review APPROVE. Cleanup/cancellation and fallback reviewers verified.
- Production: protect the actual review interval, not just its endpoint snapshots.

### P-24 Audit continuation could discard its original target binding

- Found: 2026-10-12 during integration review of usage-limit continuation.
- Symptom: restamping a resumed audit after a scope change could combine partial
  reads from the old candidate with the new one and still produce a fresh receipt.
- Cause: initial continuation metadata did not retain the first review target.
- Remedy selected: preserve original binding and refuse stale continuation before
  submission; direct protected reviews require trusted origin evidence too.
- Status: unchanged/stale/unknown-origin regressions passed; independent
  integrated review APPROVE.
- Production: continuing a thread does not make its earlier observations current.

### P-25 Review checkpoints were conflated with problems

- Found: 2026-10-12 during producer/correlation review.
- Symptom: successful reviews appeared in the problem list because their
  checkpoint ID was stored as problemId. A later run could not link a remedy
  to an earlier problem because validation searched only the current run.
- Remedy: retain checkpoint IDs in payloads, reserve problemId for actual
  problems, and resolve related problem IDs across project history.
- Evidence: SQLite-backed successful-audit report regression and cross-run
  problem/remedy/verification regression; focused checks passed.
- Production: keep checkpoint/problem identities distinct and preserve cross-run links.

### P-26 Invalid semantic records could crash before validation

- Found: 2026-10-12 by independent integrated review.
- Symptom: a lead decision with records as an object could raise TypeError
  before the normal schema boundary returned useful rejection feedback.
- Cause: history lookup called array methods on unvalidated model data.
- Remedy: validate bounded entry/array/reference shape before any history query,
  then check referenced problems. Invalid records re-prompt rather than crash.
- First remedy passed shape regressions but failed re-review: a bounded
  credential-like related ID still threw the log reader's TypeError before
  feedback. Reassessment aligned parser/storage constraints through the shared
  identity validator, including semantic entry IDs before event writes.
- Status: malformed shape/ref/size and unsafe-ID regressions passed with zero
  premature queries; final full suite and independent integrated review APPROVE.
- Production: validate untrusted shapes and bounds before persistence lookups.

### P-27 A legacy integration fixture omitted mandatory verifier context

- Found: 2026-10-12 in the first stable full-suite run: 1014 tests, 1010 pass,
  three reported failures from the parallel-writers suite, one existing live skip.
- Symptom: the scripted decision was rejected before its engineers/verifier
  dispatched, so concurrency and integration assertions could not run.
- Remedy: declare a shared routine checkpoint in the fixture and supply actual
  inspected paths and passing check evidence; retain the original assertions.
- Evidence: failed full log retained at
  `/tmp/codex-auditor-implementation.WuqU6C/full-suite-attempt-1.log`.
- Production: migrate scripted clients when extending a strict decision schema.

### P-28 A read-only workspace snapshot could refresh the Git index

- Found: 2026-10-12 while rerunning the parallel-writers fixture after P-27.
- Symptom: combined execution changed physical `.git/index` bytes even though
  the integration contract requires preserving the owner's index.
- Cause proven: `takeSnapshot()` invoked ordinary Git status with optional
  locks enabled. A stale tracked-file stat entry caused an index refresh;
  a disposable unchanged-content/stale-mtime reproduction confirmed the write.
- Remedy: suppress optional Git locks in the snapshot subprocess environment
  and retain the existing index-equality integration assertion.
- Status: snapshot/integration regression passed, original assertions retained;
  final full suite and independent integrated review APPROVE.
- Production: observation commands must preserve authoritative Git state;
  a passing isolated retry does not disprove a reproducible side effect.

## Qualification of P-16..P-28

Final isolated run on 2026-10-12: `env -u NODE_TEST_CONTEXT npm test`, 1027 total,
1026 passed, 0 failed, 0 cancelled, one optional live confinement probe skipped.
Independent integrated review APPROVE; `git diff --check` passed. Final log:
`/tmp/codex-auditor-implementation.WuqU6C/full-suite-attempt-3.log`.
Earlier failed/intermediate attempts remain in that directory. The owner
services stayed stopped. Actual audit frequency, profile activation, and
resource savings remain unqualified until a bounded live staging trial.

### P-29 The live lead dispatched a verifier without write scope

- Found: owner-reported live run on 2026-10-12, after the isolated qualification.
- Symptom: the lead paused after three invalid decisions with
  `decision_envelope_invalid` and `writer_scope_missing`; verifier had empty
  allowedFiles despite its workspace-write profile. No valid dispatch occurred.
- Cause confirmed in source: the rewritten assignment prompt omitted the
  earlier explicit writable-scope guidance, and retry/delta guidance did not
  explain that a verifier still needs test/check permissions for read/run work.
- Remedy selected: restore role ID, path, scope and cardinality guidance in
  full/delta/rejection prompts and clarify the existing verifier contract.
  Preserve empty-scope rejection; no guessed paths or additional write grants.
- Related investigation: P-30 confirms a separate resume/profile-rollover bug.
  It has not been attributed as the cause of this owner's live run.
- Status: implemented; focused regressions passed and independent review APPROVE.
  Full working-tree qualification: 1031 passed, 0 failed, one optional live skip.
- Production: routine acceptance instructions must specify capabilities and
  permissions together; technical schema failures are not owner product decisions.

### P-30 A resumed rejection could reuse outdated lead instructions

- Found: 2026-10-12 while investigating P-29; confirmed by the checkpoint path.
- Symptom: after a rejected decision the checkpoint retains retryDecide=true.
  Resume clears the flag in the pending update, but thread selection reads the
  old state and bypasses the changed-profile hash check.
- Remedy selected: select the thread using the effective retry flag. Ordinary
  automatic retries retain their thread; resumed runs honor profile hash checks
  and reconstruct bounded context when a new thread is needed.
- Status: implemented; unchanged/changed-profile resume regressions passed and
  independent review APPROVE. Full working-tree qualification passed.
- Production: transition decisions must read effective updates, not stale
  checkpoint fields, when resuming a paused step.

### P-31 Recovery fixtures omitted verifier evidence and overstated acceptance

- Found: 2026-10-12 while recovering the interrupted P-29/P-30 implementation.
- Symptom: the new recovery and resume scenarios exhausted their scripted lead
  decisions because the generic worker report had no inspected files or checks.
  After supplying valid verifier evidence, an `accepted` assertion still failed.
- Cause: the fixtures used a generic worker response for a mandatory verifier
  receipt and confused that receipt with deterministic run acceptance. No
  required acceptance checks were pinned for these writable-role runs.
- Remedy: use the existing independent review fixture, assert an accepted
  verifier receipt, and retain the truthful `unverified` run disposition.
  Keep scope rejection, exact dispatch counts, and profile rollover assertions.
- Status: fixed; focused regressions passed, independent review APPROVE, and
  full working-tree qualification passed without relaxing production gates.
- Production: model review evidence and deterministic acceptance are distinct;
  test fixtures must satisfy both contracts without relaxing runtime gates.

## Qualification of P-29..P-31

Recovery on 2026-10-12: `env -u NODE_TEST_CONTEXT npm test`, 1032 total,
1031 passed, 0 failed, 0 cancelled, one optional live confinement probe skipped.
Independent review of the scope guidance, resumed retry/profile rollover, and
corrected verifier fixtures: APPROVE; six focused checks passed. Full log:
`/tmp/codex-home-recovery-jii6bb_e/full-suite.log`.
The standalone staged commit candidate, excluding unrelated scratch/settings/UI
work, also passed: 998 total, 997 passed, 0 failed, 0 cancelled, one optional
live skip. Candidate log:
`/tmp/codex-home-recovery-jii6bb_e/commit-candidate-suite.log`.
The sandbox attempt was stopped after environment failures; the qualified run
used approved host access for /var/tmp fixtures and disposable local HTTP
services. No owner service or live model turn was started. Source-level and
isolated verification do not establish a successful live task continuation or
measured audit savings.

### P-15 Acceptance checks had no writable scratch outside /tmp

- Symptom: a mandatory pinned regression check (AC20/AC21 in
  `codex_team_work`) could not pass; the lead escalated it as
  `infeasible_requirement`.
- Cause: the agent-check sandbox allowed writes only to /tmp, while the tests
  require scratch outside the checkout, /tmp, TMPDIR and $HOME.
- Model: owner opt-in per-run scratch directory
  (`docs/adr/acceptance-per-run-scratch.md`).
- Production: provide per-run, owner-controlled scratch storage for
  sandboxed checks from the start, with real-path and ownership checks and
  guaranteed cleanup.

### P-10 The worker report schema has no free-form details field

- Symptom: a Q&A answer must fit `summary` (3000 chars) plus checks /
  filesInspected / risks.
- Production: give non-assignment role modes (questions, inventories) their own
  output schema.

### P-32 Dispatch-round exhaustion interrupted healthy long work

- Symptom: a short single-explorer assignment consumed the same dispatch budget
  as a substantial implementation round. Runs needed repeated owner extensions,
  including the live M4 request h6, despite authorization to pursue the goal.
- Cause: default `maxRounds = 6`, automatic extensions capped at 18, and progress
  accounting that omitted research. The separate LangGraph invocation limit
  could also terminate a sufficiently long execution.
- Decision: LL-8 in `docs/lead-loop-fixes-design.md`. No default dispatch cap;
  bounded persistent detection of unchanged repeated work, a replan warning,
  then a diagnostic resumable pause. Explicit caller caps remain available.
  Technical graph segmentation resumes only from a proven advanced checkpoint.
- Status: locally qualified on 2026-10-13: independent review and adversarial
  probes passed; full suite 1,076 passed, 0 failed, 1 optional live probe skipped.
  The running server and paused M4 task have not been restarted or resumed.
- Production: distinguish owner-specified resource limits from loop detection;
  count research evidence, preserve history through recovery, and retain all
  acceptance and writer-reconciliation gates. A repetition heuristic is not a
  proof of semantic non-progress. Full outcome/checkpoint storage still grows
  with run length and needs separate capacity measurement.

### P-33 Paraphrased review requests escaped repetition detection

- Found: owner-reported production loop on 2026-10-13, after verifier r31.
- Cause: request check text was part of work identity; every paraphrased audit
  created a new episode despite unchanged checkpoint and failed evidence.
- Remedy: review role, checkpoint and declared scope identify the work; scoped
  content and performed checks identify evidence. Interleaved diagnostics do
  not erase history. Read-only replay of r33-r37 warns at r36 and pauses r37.
- Status: independently reviewed and probed; full suite passed.

### P-34 Read-only audit reports mixed exclusions with required checks

- Found: production r40 rejected an embellished verdict; r42 rejected a
  forbidden disk test recorded as not_run despite passing assigned checks.
- Remedy: schema, profile and runtime instructions require an exact standalone
  verdict. Required executions and explicit evidence validation go in checks;
  supplemental diagnostics, exclusions and cited prior evidence go in risks
  with honest results and limitations. Assigned failures still block approval.
  Pinned-check preserve/weaken and diagnostic investigation remain distinct.
- Limit: natural-language assignment/report coverage remains a semantic duty,
  not a mechanically verified correspondence.
- Status: independently reviewed and probed; existing report shape preserved.

### P-35 New session stayed disabled after owner Pause or Stop

- Cause: the launcher required a terminal task, but settled Pause/Stop remains
  INPUT_REQUIRED.
- Remedy: permit a fresh context after matching confirmed owner pause/stop
  with no running worker or in-flight control. Clear old decision UI state;
  retain the old session without resuming or deleting it.
- Status: seven focused session-control cases and independent probes passed.
  Reload the UI after integration; backend repairs require project restart.

### SYS-REPAIR-01 Project roles cannot repair the hosting control plane

- Status: removed on 2026-10-14 after its first live use; see P-36. The text
  below is kept as dated history.

- Symptom: a systemic controller defect needs outside repair, while project
  specialists only have the target workspace and the owner receives debugging
  questions.
- Decision: Chuck Norris is a separate launcher-hosted A2A system repair agent;
  lead decisions have a dedicated system escalation and separate evidence.
- Design corrections: direct repository execution would expose mutable runtime
  state before scope validation, and the ordinary project bearer would grant
  system repair authority. Require verified isolated lanes, allowlisted
  integration and a separate system credential. Source reload proof must name
  the actual requester or launcher process that loaded the affected code.
- Implementation: separate profile/service, journaled A2A client, graph route,
  technical wait/recheck, loaded-source proof and UI projection are in the
  working tree. Final full suite: 1129 pass, 0 fail, 1 optional live skip;
  independent APPROVE and five adversarial probes HOLDS. No live run is claimed.
- Production: carry separate system capability, persistence and lifecycle;
  never accept a model report as authority to clear project writers, review
  gates, owner pauses or budgets. Retain uncertain submissions for identity
  reconciliation instead of blind writable retries.
- ADR: [Chuck Norris system repair](adr/chuck-norris-system-repair.md).

- SYS-REPAIR-01 follow-up: a challenger reproduced source integration on a
  completed model turn with a failed repair report/checks. The system executor
  now validates the candidate before integration; failed candidates remain
  isolated. Actual loaded entry/helper capture and SDK interface sanitization
  also passed independent review. Automatic maintenance restarts remain deferred.

### P-36 A new service passed mocked tests but failed on first live use

- Found: 2026-10-14, first live use of the Chuck Norris system repair agent.
- Symptom: four defects that mocked tests had not shown: oversized request
  inputs, a lane isolation probe that failed because the lanes and the app-server
  working directory sat inside the repaired repository, a retry path that could
  not resubmit after an isolation refusal, and a stale phase display.
- Cause: the service was accepted on mocked integration tests only. The agent
  edits the tree its own control plane runs from, which makes isolation hard to
  establish and impossible to prove with stubs.
- Decision: the agent and the lead route to it were removed (see the superseded
  ADR). Control-plane incidents are fixed by the owner or a dev session.
- Production: a new service must have a live smoke run in the real environment
  before its first real use. Mocked acceptance does not establish isolation,
  sizing or recovery behavior.

### P-37 A live dispatch decision populated the final field

- Found: 2026-10-15 during a monitored run after the current-candidate verifier
  passed an integrated repair.
- Symptom: the lead's dispatch decisions were rejected three times with
  `records_invalid` and `decision_envelope_invalid`; validation reported that
  dispatch decisions must leave `final` empty. The lead paused with
  `loop_detected` before dispatching new work.
- Recovery: the controller selected the recommended `continue`, preserving the
  existing goal and configured round allowance, and reminded the lead to leave
  `final` empty. The lead resumed at the decision step.
- Status: after the follow-up audit failed without a summary, the lead integrated
  a workspace-consistency repair at round 191 and dispatched a verifier at round
  192. The run continued without another owner pause, and the invalid dispatch
  decision has not recurred. A durable prompt-level correction is not verified.
- Production: keep `final` empty on dispatch actions and treat repeated schema
  rejection as an orchestration defect, not a reason to accept incomplete work.

### P-38 Historical evidence pins cannot qualify a changed candidate

- Found: 2026-10-15 when the r194 lifecycle verifier compared current source and
  test files against the immutable T3.1.2d.2 evidence record.
- Symptom: verification was inconclusive because the recorded source/test pins
  describe an earlier candidate; the lead had to decide which checkpoint
  revision should bind before lifecycle acceptance could proceed.
- Cause: later repairs changed the same paths while the d.2 evidence correctly
  retained its original hashes and qualification history.
- Remedy selected: preserve d.2 and its original pins as historical evidence;
  create a separate current-candidate qualification from the executed r194
  evidence and independently measured hashes. Keep the checkpoint unaccepted
  until fresh current-target verification and audit receipts exist.
- Status: evidence-only assignment started in round 195; the new record and
  subsequent review gates are pending.
- Production: never rewrite old evidence pins to match changed files. Bind a new
  candidate revision and renew every affected gate before acceptance.
