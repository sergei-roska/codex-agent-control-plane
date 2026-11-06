# Autonomous delivery backlog

Status: active development backlog. Baseline: `ab5c195` (2026-11-06).
Implementation has started, but end-to-end implementation and activation remain
pending. Existing source and test evidence below establish reusable components,
not an end-to-end shipped autonomy claim.
The source-backed constraint and gap inventory is
[autonomous-delivery-constraints.md](autonomous-delivery-constraints.md).
Migration from earlier development backlogs is recorded in
[autonomous-delivery-migration.md](autonomous-delivery-migration.md).

## Objective

Given an accepted objective and the owner's configured project scope, deliver
it to independently checked acceptance without requiring owner continuation.
The system transfers work safely across two configured Codex accounts, waits
durably when both are blocked by provider limits, resumes after reset or server
restart, investigates and repairs technical failures, and exposes status and
owner steering in chat. Ask the owner only for a decision that remains genuinely
theirs after relevant code, project documentation, and available internal
sources have been researched. Never turn a counter, timeout, retry threshold,
or technical failure into successful completion.

## Priority and dependency map

All items are pending for the end-to-end objective, even where a source
component is already implemented. Dependencies below are functional
prerequisites; shared-file ordering belongs in implementation briefs and is not
an extra product gate.

```text
AD-01 Objective and execution identity
  +--> AD-02 Account failover and context transfer
  |      +--> AD-03 Durable all-account wait and automatic resume
  +--> AD-04 Autonomous investigation and technical recovery
  +--> AD-05 Uncertain effects and owner-control races
  +--> AD-07 Chat status and steering
AD-01 --> AD-06 Honest final acceptance (acceptance work can start in parallel)
AD-01..AD-07 --> AD-08 Integrated release qualification
```

## Work items

| ID | Priority | Depends on | State |
| --- | --- | --- | --- |
| AD-01 | P0 | - | complete |
| AD-02 | P0 | AD-01 | in_progress |
| AD-03 | P0 | AD-02 | in_progress |
| AD-04 | P0 | AD-01 | in_progress |
| AD-05 | P0 | AD-01 | in_progress |
| AD-06 | P0 | AD-01 | complete |
| AD-07 | P1 | AD-01 | in_progress |
| AD-08 | P0 | AD-01..AD-07 | pending |

### AD-01 - Durable objective identity, scope, and execution lineage [P0]

**Outcome.** One durable objective survives planning turns, specialist turns,
technical recovery, provider-account changes, and process restarts. Its original
owner intent, project/workspace scope, acceptance obligations, current
checkpoint, attempt lineage, and effective provider identity are recoverable.

**Evidence and entry points.** The legacy path persists lead task/checkpoint
state in `src/durable-store.js` and forwards `contextId` through
`src/lead-orchestrator.js`. The concurrent path has project/objective/task
records and restart recovery in `src/backlog-store.js`,
`src/delivery-lifecycle.js`, and `src/concurrent-delivery-engine.js`, but is not
the default active runtime. Inspect `src/delivery-engine-router.js` and
`src/server.js` for composition and run pinning.

**Acceptance scenarios.** Start an objective with explicit scope and checks;
persist a checkpoint and a worker attempt; close/reopen the project server;
recover the same objective, scope, pending work, and check identities without
re-intaking or silently changing the goal. Account changes preserve objective
identity and scope while recording a new attempt and account binding. An
unrecoverable mandatory field remains invalid/unknown and cannot become
success.

**Implementation progress (2026-11-06).** The legacy path now pins project,
canonical workspace, task identity, and the effective acceptance contract before
dispatch; restart, empty-check, and changed-binding regressions pass. The
concurrent path now has composed router/engine SQLite reopen coverage for stable
objective/session identity, checks, checkpoint history, attempt lineage, and a
queued successor without re-intake; changed goal/check intake is rejected.
Focused e2e tests passed 13/13 and the router/concurrent-engine suites passed
67/67. A2A worker calls persist a one-way hash of the configured account ID at
the selected provider boundary, linked to their run, attempt, assignment, and
worker task. Lead planner calls now use separate durable coordinator attempts
with no fabricated worker task ID; raw adapters fail closed. The independent
lead-binding review approved the change; lead-graph passed 284/284, and the
app-switch/durable-store suites passed 32/32. This records configured identity
at the call boundary, not proof that a provider turn started, completed, or
caused an effect. Same-home auth replacement now fences the selected wrapper
generation and recreates the App Server before the next bound call; external
CLI credential reload behavior remains unqualified and belongs in AD-08
qualification. The concurrent busy-switch starvation regression was fixed and
independently approved. Legacy and concurrent restart/account-rebind tests
preserve the objective/check lineage; account-transfer integration also proves
a fresh thread on B with durable hash bindings. Relevant suites passed 50/50,
284/284, and 89/89. See `.agents/teamwork/AD-01-planning-20261106/`.
No runtime activation or live provider run occurred.

### AD-02 - Automatic two-account failover with safe context transfer [P0]

**Outcome.** When a required model/provider operation is blocked by a detected
usage limit on account A, automatically select available configured account B
and continue the same objective. Transfer only the minimum durable objective,
scope, checkpoint, and attempt context needed to continue; record the new
account/thread identity. Do not assume an account-A thread can be resumed under
account B. An authenticated account can be used only when its current provider
state permits the required model operation.

**Evidence and entry points.** `src/account-profiles.js`,
`src/budget-watcher.js`, `src/server.js`, and `docs/codex-accounts-design.md`
implement/profile existing legacy-path switching. In the concurrent path,
`src/concurrent-delivery-engine.js` has `#resumeWithCurrentProvider` for a
resume under the currently pinned provider, while provider identity remains
pinned to each engine instance and rejects an in-place identity change.
Automatic switch/rebind and end-to-end context transfer are not qualified.
Preserve provider-specific account homes and token isolation.

**Acceptance scenarios.** With two disposable authenticated account fixtures,
exhaust A for a needed operation and prove B is selected without an owner
message, the same objective/checkpoint resumes with a new traceable attempt,
and no prompt, acceptance check, workspace scope, or result is lost or duplicated.
When B is unavailable, AD-03's durable wait is entered. If neither profile is
logged in, show the actual authentication dependency in chat; after owner
re-login, resume the same objective without re-submission. A provider identity
change during a live attempt must fence that attempt and reconcile its outcome
before new-account writes begin.

**Implementation progress (2026-11-06).** A deterministic integration test
using the real legacy lead orchestrator, SQLite checkpoint store, account
switching wrapper, and budget watcher proves A's usage limit selects B, resumes
the same task/context/check contract, and gives B a fresh provider thread while
retaining the settled outcome exactly once. Durable call bindings contain A/B
hashes and no raw IDs. Existing-profile browser/device re-login runs in the same
Codex home and accepts completion only after `requiresOpenaiAuth === false`;
failed, canceled, and timed-out flows preserve profile/home. Auth classification
distinguishes typed 401/403 from unrelated failures. The watcher now preserves
owner selection pins through the production adapter, serializes profile writes
across processes, and routes even active-profile auth recovery through a
revision-pinned wrapper after availability reads. Independent-process and
real-server owner-selection race regressions pass. Focused account, switch,
watcher, failover, and launcher suites pass 101/101; watcher/failover suites
pass 43/43; named server race cases pass 4/4. Sol independently approved both
the profile lock and active auth/adapter race fixes. Automatic all-window wait
and safe provider rebind remain AD-03 integration work. No live provider
behavior was exercised. See `.agents/teamwork/AD-02-account-transfer-20261106/`.

### AD-03 - Durable wait across every blocking provider window [P0]

**Outcome.** If both accounts are blocked, persist a waiting objective and the
provider-reported blocking limit windows; keep checking the authoritative
availability signal and resume automatically when a suitable account/model is
available. The wait survives server restart. A reported reset timestamp may
schedule a check, but does not itself prove quota recovery.

**Evidence and entry points.** `src/budget-watcher.js` and `src/server.js`
rediscover and resume mapped `waiting_for_budget` runs through
`src/delivery-engine-router.js`; `docs/budget-auto-resume-design.md` records
the provider availability rule. The concurrent store/lifecycle represent
`waiting_budget`, but the concurrent engine is created without durable budget
wake eligibility/callbacks and default wake eligibility is false.
`src/concurrent-delivery-engine.js` also pins provider identity; on restart,
its current provider-resume eligibility excludes `waiting_budget`. Wire a
trusted, effect-settled budget wake and safe provider rebind before resuming.
Inspect `src/backlog-store.js`, `src/delivery-lifecycle.js`,
`src/concurrent-delivery-engine.js`, `src/delivery-engine-router.js`, and
startup recovery in `src/server.js`.

**Acceptance scenarios.** Exercise every provider-reported blocking window
relevant to the objective, including short-window and weekly exhaustion, on A
and B. Persist the wait, restart the server before reset, restore it without an
owner message, observe that a timestamp alone does not resume, then observe the
provider's positive availability signal and resume the same objective. If A
resets while B remains blocked, select A; if only a model-specific required
bucket remains blocked, do not dispatch that operation. Repeated resets and
re-exhaustion re-arm the durable wait rather than ending the objective.

**Implementation progress (2026-11-06).** `BacklogStore` and
`DeliveryLifecycle` now persist up to 64 explicit blocker windows per budget
wait, including hashed account identity, provider/model/window/reason and reset
hint. Reset timestamps remain hints; lifecycle wake still requires literal
`true` from the authoritative eligibility callback and matching owner/control
pins. SQLite reopen and re-exhaustion are covered; focused store/lifecycle
suites passed 72/72 and Sol independently approved the storage slice after a
sparse-array validation fix. Concurrent-engine account eligibility, provider
rebind, server restart recovery and wake wiring remain open. See
`.agents/teamwork/AD-03-account-wait-20261106/durable-wait/`.

### AD-04 - Autonomous diagnosis, repair, and substantiated owner questions [P0]

**Outcome.** Investigate actionable failures, use evidence to select a distinct
repair, then rerun the relevant checks and continue the objective. Owner
questions are reserved for genuinely missing owner decisions such as a changed
requirement or a required credential/authorization the owner must supply. A
technical blocker is never silently reclassified as owner choice or as
completion. A failed internal recovery attempt is a reason to investigate or
choose a new technical approach, not by itself permission to ask the owner to
continue.

**Evidence and entry points.** `src/lead-graph.js` requires read-only
investigation before an owner-only question or partial finish and contains
transient/repeated-work recovery. `src/transient-recovery.js` and
`src/delivery-lifecycle.js` persist technical retry state. Existing numeric
limits in recovery code must not become task success or owner-question
triggers; see the constraint inventory. Reuse
`docs/lead-loop-fixes-design.md` and `src/verification-preflight.js`.

**Acceptance scenarios.** Seed an implementation/check failure with enough
local evidence to diagnose; observe autonomous investigation, a distinct
repair, fresh checks, and continued work without an owner message. Seed a
missing external credential and prove the system first searches local project
configuration/docs, then asks only for that credential with evidence and
precise requested action. Supply it through the configured login/secret
mechanism, then confirm restored access in chat and verify work resumes. Never
ask the owner to paste credentials into chat. Seed
an unchanged/repeating failure: the run stays explicitly incomplete and keeps
working through a materially different diagnosis/recovery path or reports a
real external dependency; it never reports accepted or asks for generic
"continue" solely because a configured counter was reached. Unresolved
required work remains active, recovering, or waiting; a technical threshold
cannot end the original objective as a terminal partial result.

**Implementation progress (2026-11-06).** Retry limits preserve a durable
waiting state without terminal exhaustion; post-cap eligible retries now store
and schedule a bounded next action across process restart. Server status reports
the persisted retry time. Repeated no-progress, unmet-goal finishes, and
planning validation failures do not manufacture partial results or generic
owner questions. A legacy persisted threshold-only recovery question migrates
to nonterminal technical replanning before task publication/resume, while
evidence-backed owner-only decisions and existing receipt/checkpoint fences are
preserved. The historical threshold-only owner-grant ADR is marked superseded.
Default legacy runs have no implicit 80-round cap; explicit caller caps remain
honored. `node --test test/transient-recovery.test.js` passed 10/10; focused
server migration/status tests passed 4/4; focused owner recovery/restart tests
passed 8/8; full `test/lead-graph.test.js` passed 288/288. Sol delta review is
pending. The earlier test stalls were stale scripted fixtures after a
nonterminal review-gate rejection. Exact evidence is at
`.agents/teamwork/AD-04-recovery-20261106/handoff.md`.

### AD-05 - Reconcile uncertain effects and honor pause/cancel races [P0]

**Outcome.** Recover crashes around dispatch, file integration, account
switching, cancellation, pause, and acceptance without blind duplicate effects
or stale execution. Keep unknown effects visibly unresolved until trusted
reconciliation establishes whether they occurred. Schedule automatic technical
reconciliation when its dependency becomes available and expose that next
action in status; an unresolved state is not a terminal result. An explicit owner pause
parks at a safe boundary; explicit cancel becomes terminal only after the
downstream cancellation/effect state is confirmed.

**Evidence and entry points.** `src/durable-store.js`,
`src/writer-admission.js`,
`src/delivery-lifecycle.js`, and `src/task-executor.js` provide durable intent,
fencing, and conservative unknown-outcome handling. `src/lead-orchestrator.js`
and `src/concurrent-delivery-engine.js` expose different pause/cancel paths;
composition still requires end-to-end qualification. Preserve the demonstrated
workspace ownership, authorization, and data-integrity invariants in
`docs/autonomous-delivery-constraints.md`.

**Acceptance scenarios.** Crash after durable send intent but before recording
the result; restart and reconcile by stable attempt identity without resending
or duplicating workspace effects. Race cancel and pause against an in-flight
write and against account failover: owner control wins at a defined safe
boundary, no later attempt is admitted after the terminal/pause fence, and
status reflects confirmed downstream state. When effect state cannot be
established, retain the held/unknown state, expose the next reconciliation
action, and automatically retry technical reconciliation when its dependency
becomes available; never call it completed.

**Implementation progress (2026-11-06).** The concurrent path now persists
cancel as `draining`, reconciles worker/planner/publication records, and only
terminalizes after trusted settlement. The no-intent retry path carries the
current recovery generation even when ownership is unchanged; Sol approved
the regression proving automatic settlement after proof availability with no
send. The authenticated host and launcher now expose a revision-pinned cancel
action, and UI/status distinguish a pending drain from confirmed cancellation.
The focused cancellation, control, and UI suites passed 177/177; real-browser
acceptance passed 1/1. The legacy budget watcher now rechecks entry identity
after awaited account switching, and its 33-test suite passes. Legacy cancel
integration and composed pause/cancel versus budget-resume/account-failover
races remain open for AD-08 qualification.

### AD-06 - Accepted means all required work and checks are accepted [P0]

**Outcome.** Declare success only after all required objective work is
integrated, the pinned mandatory checks pass on the accepted current candidate,
and no runnable, active, delayed, blocked, or unknown-effect work remains.
Keep partial, waiting, canceled, rejected, and accepted outcomes distinct.
Unresolved required work remains active/recovering/waiting. A terminal partial
result requires an owner scope, cancel, or acceptance decision; a configured
counter or time limit cannot substitute for that decision.

**Dependencies.** AD-01 pins the objective contract and checks. This isolated
acceptance component work can proceed while account recovery and other delivery
paths are implemented.

**Evidence and entry points.** `src/acceptance.js`,
`src/lead-graph.js`, `src/candidate-store.js`,
`src/delivery-acceptance.js`, and `src/concurrent-delivery-engine.js` already
contain deterministic acceptance and candidate-bound finalization components.
The concurrent implementation is not integrated into the default runtime;
passing module suites do not prove the release flow. Reuse the current pinned
check and candidate rules rather than inventing new completion shortcuts.

**Acceptance scenarios.** A claimed `goalAchieved: true` with one pending
successor, failed/missing pinned check, stale candidate receipt, or unknown
writer effect is rejected as incomplete. After the missing work is completed,
fresh checks pass against the current candidate, the final state is durably
accepted, and restart/status replay preserves that same accepted fingerprint.
An executable successor-rebasing case proves a dependent task reads the
accepted predecessor candidate and rejects a stale target. No round count, time
budget, worker outcome, or narrative claim can substitute for required
acceptance evidence.

**Implementation progress (2026-11-06).** The source map found missing
executable acceptance evidence for pending-successor refusal, uncertain-effect
rejection, accepted-fingerprint replay after reopen, and successor rebasing.
The concurrent engine/store tests now cover pending successor, stale target
output, unknown worker effect after SQLite reopen, stale/missing check receipt,
accepted fingerprint replay, and dependent candidate rebasing. Focused
acceptance/store suites passed 134/134. Independent acceptance review
approved. AD-08 still needs the broader release lifecycle proof.

### AD-07 - Chat status, steering, pause, and cancel [P1]

**Outcome.** Chat gives a current, durable view of objective, phase, next
automatic action, account/wait state, blockers, checks, and final disposition.
Owner messages can steer an active objective, pause it, or cancel it within the
same project/objective scope. A message is acknowledged as received and
separately as applied; replay is idempotent.

**Evidence and entry points.** `src/delivery-host-controls.js`,
`src/delivery-events.js`, `src/project-delivery-controller.js`,
`src/concurrent-delivery-engine.js`, `launcher-ui/backlog.js`, and
`src/launcher-app.js` provide
scoped control and message receipts for the concurrent path. Legacy chat and
task pause surfaces remain separate. Inspect the two interfaces before
integration; do not imply that an unacknowledged message changed execution.

**Acceptance scenarios.** During work, send a correction and verify the same
objective records receipt, applies it at a safe planning boundary, and reports
the applied result. Replay the same message ID and verify no duplicate effect;
reuse the ID with changed text and verify rejection. Show account A/B and
provider wait state, restart recovery, and next automatic action in status.
Race a chat pause/cancel with quota resume and confirm owner control is not
overridden by a stale automatic-resume event. Run the LL-7 browser acceptance
check for the decision/status card, including evidence, recommended option,
independent work, and option selection, against the integrated UI.

**Implementation progress (2026-11-06).** LL-7 rendered-function checks passed
17/17, and real-browser acceptance passed 1/1 using the checked-in launcher HTML,
CSS, and JavaScript. The concurrent control status now projects durable phase,
next action, account-binding state, waits, blockers, mandatory checks,
candidate/finalization, planner/publication, and controller availability.
Focused engine/controller tests passed 89/89. Raw account IDs and home paths
are omitted; future invocation identity remains unknown until bound. The host
and launcher expose revision-pinned pause, resume, and cancel controls, and the
backlog UI distinguishes applied, draining, stale, and unknown outcomes without
blindly retrying. Focused route/UI tests passed 16/16, the real engine cancel
drain test passed, the combined control/reconciliation suites passed 177/177,
and the changed launcher passed browser acceptance 1/1. Composed automatic-
resume and account-failover races remain open. See
`.agents/teamwork/AD-07-research-20261106/`.

### AD-08 - Integrated fire-and-forget release qualification [P0]

**Outcome.** Wire the accepted components into the selected runtime and prove
the full objective lifecycle. Deterministic provider-limit fixtures establish
the control flow, followed by scoped real App Server/account/authentication and
context-transfer smoke checks where needed to validate provider integration.
Use existing authorization and configured accounts; do not deliberately
consume real quotas to simulate exhaustion. Do not infer deployment from
qualification.

**Evidence and entry points.** The legacy path currently has account switching
and budget auto-resume; the concurrent engine has offline source qualification
but remains inactive. See `docs/architecture/concurrent-harness/implementation-status.md`,
`docs/architecture/concurrent-harness/activation.md`, and the AD-01..AD-07
entry points. Keep comparative/economy studies separate from functional
completion; neither is a prerequisite to proving correctness on deterministic
fixtures.

**Required executable release scenario.** In an isolated project with two
account fixtures and pinned required checks: start one objective; simulate A's
provider-reported exhaustion in the deterministic fixture; automatically
transfer to B and continue; simulate B exhaustion; persist the provider wait;
restart the server while waiting; reset/restore one suitable account; detect
provider availability and resume the same objective without owner continuation;
finish the work, reconcile all attempts/effects, run mandatory checks against
the current candidate, and persist `accepted`. Assert the objective/checkpoint
identity is unchanged, account/thread attempts are traceable, no effect is
duplicated, no owner message was needed, and status history is complete.

Run the same fixture with an owner pause and with an owner cancel racing each
automatic transition; the explicit control must win safely. Run recovery cases
for missing login (owner re-login then automatic resume), stale reset hints,
unknown dispatch effect, a genuine missing owner decision, failed checks, and
repeat failure. Each must retain an honest non-accepted state until resolved.

No efficiency, cost, broad model-quality, live-provider, or production claim
follows from this functional scenario. Use matched trials for those separate
questions and preserve unknown measurements as unknown.
