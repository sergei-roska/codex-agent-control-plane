# Current handoff

## Active session: h29 controller repair and A2A monitoring

Problem/decision ledger: root/blocker-decision-log.md. Update it as new issues
appear and their dispositions or gate evidence change.

Updated: 2026-10-13. Current HEAD: 436f66bcfc67dd2feeeb09825486dae8539a7d3f.
User requested monitoring and technical blocker resolution in this active session,
then explicitly selected session monitoring rather than a permanent background
agent. Root communicates with lead through existing A2A API, not MCP.

Project c8740b5b4f, workspace /home/sr/Projects/Workspace/codex_team_work,
server port 3001, launcher port 8080. Run a125b4c6-f640-45ae-a106-22f97837f8e9,
session 8d7f6bd4-2d43-48cd-933a-53736fba2e88.

Completed: bounded prerequisite admission using review.prerequisiteFor, immutable
scope/target binding, single new verifier and matching later auditor, rejection
of every co-dispatched writer, preserved original obligations and finish gates.
Authenticated /control/runtime returns immutable loaded identity. Independently
approved both changes, recorded critic/runtime reports in root/h29-review.md.
Managed project-server restart loaded PID 213246 at 2026-10-13T19:38:52.165Z.
All four returned source hashes match disk; no uncaptured source files. No-token
request returned 401. HEAD unchanged: loaded implementation is uncommitted.

Answered exact h29 decision implement_environment via A2A with implementation,
loaded hashes and supported contract, in root/h29-answer.json. Fresh task status
became WORKING. r98 verifier and r101 auditor exercised the admitted prerequisite
review path; r100 verification passed after the lead repaired the r98 ownership
split. The r101 audit found four further spec issues; r102/r103 repaired the
specification, r105 split oversized c.2b, r106 accepted that decomposition, and
fresh-origin auditor r108 passed the spec audit. r109 implemented bounded c.2a
quota-policy preparation support, r110 verified it, and r111 is auditing it.

Checks: contracts full 46/46; review policy full 6/6; server full 80/80 outside
network sandbox. Direct full graph 197/198 passed; the only failure was a stale
baseline prompt-field assertion. Worker corrected it to require review and repair;
focused affected test passed 1/1. Focused prerequisite/scoped-review cases pass.
git diff --check passed. No full project suite rerun, commit or target source edit.

Changed files: src/contracts.js, src/lead-graph.js, src/review-policy.js,
src/runtime-identity.js, src/server.js, their four test files, and
docs/adr/prerequisite-review-admission.md. Existing src/launcher-app.js and
src/session-situation.js changes preserved. All teamwork files remain ignored.

Monitoring helper: node /home/sr/Projects/Workspace/codex-agent-control-plane/.agents/teamwork/root/control-client.cjs watch <runId> [pollIntervalMs]
(read-only polling, 394000 ms by default, adapted to half the observed blocker
interval). Watch uses the launcher situation's live state and `openDecisions`,
not the stale numeric A2A task state, and reports newly failed/inconclusive
assignments. Status, runtime and answer modes also exist. Credentials load
internally. Answer mode checks the pending decision ID before sending.

Temporary evidence: /tmp/orchestrator-h29.json, /tmp/h29-loaded-runtime.json,
/tmp/h29-lead-graph-tests.log, /tmp/h29-review-contexts.json. May disappear.

Latest A2A read at 20:58:26 UTC: both r115 verifiers passed their scoped checks.
r116:a0 then failed its independent audit with H1: unknown ownership recovery
can be cleared by an unrelated stop, and older stopped evidence can authorize
a replacement. r116:a1 could not start because pinned-review admission reported
an active or unresolved workspace writer. The lead dispatched r117:a0 engineer
on a bounded repair in target `src/teamwork/state` and `tests/state`; it is
running. No owner decision is open. Runtime quota continuation and dispatcher
acceptance remain pending. Keep Phase C live authority and new allocation absent.
Do not bypass the review gate or authorize publication/merge/external messages.

Latest monitoring: r101/a0 completed at 19:53:19.650Z with diagnostic findings
and no valid accepted audit receipt. It identified (1) missing atomic turn-bound
completion/recovery fencing, (2) reusable quota proof across distinct command
IDs and missing one-outstanding-turn semantics, (3) no finite continuation
allowance or exhaustion, and (4) evidence-index counts inconsistent with raw
historical artifacts. Lead recorded M4-P-QUOTA-LIFECYCLE-SPEC and
M4-R-QUOTA-LIFECYCLE-SPEC. At r102:a0:t1 the lead selected
`explicit_quota_allowance`: a persisted per-attempt allowance debited atomically
and nonrefundably on admission. This grants no positive value, budget increase
or live-call authority. r103/a0 recorded `retry_policy.max_quota_continuations`,
updated dependencies and corrected evidence provenance. r104 independently
confirmed the four r101 semantics and historical transcript attribution but
failed overall because c.2b bundled too many state changes for one session.
Lead logged M4-P-QUOTA-STATE-TASK-SIZE. r105 made c.2b a nondispatchable parent
with seven sequential, independently gated leaves and updated c.3a/c.3b
dependencies. r106 accepted that decomposition. r107's auditor continuation was
rejected before execution because its originating target was stale. Fresh-origin
auditor r108 passed and resolved the four specification findings. r109
implemented c.2a preparation policy support (strict optional nonnegative integer
validation, persistence and revision protection); its focused suite passed
33/33. r110 independently accepted the source/test/contract/split pins and
preparation behavior. r111 audit of c.2a authority and revision integrity
started at 20:24:08.729Z and is running. No open owner decision. Runtime
continuation and the original dispatcher checkpoint remain gated; no positive
allowance, Phase C authority or M4 acceptance is granted. Measured blocker gaps
are 519186, 798442, 578448 and 1252650 ms (r113:a1 to r116:a0), mean 787182 ms;
half-mean poll is 394000 ms (~6m34s).

Token efficiency review: latest read-only snapshot at 20:51 UTC had 370 rows,
210,320,223 input tokens (193,344,128 cached), 2,054,399 output, 356 known-token
rows, and 14 unknown rows. Workers contributed about 81% of input, with 94%
cached. Standard short-context API-rate counterfactual: $34.48, excluding
unknown rows; $169.52 if the same known input were all uncached. Coordinator
and auditor account for about 91% of the estimate. This is not a measured
subscription cost. Individual long prompts above 272K have higher rates; the
ledger lacks request-level sizes. Latest lead context is persisted separately:
76,409 of 475,000 tokens with 11 rollovers at 20:54 UTC; this does not show
immediate context pressure. The ledger lacks per-turn history and worker
context sizes. Existing delta prompts and bounded reports are in place.
Preserve reviewer gates, effort settings, and rollover policy.
Token optimization is deferred at the user's request to TOK-PROMPT-01 in
`docs/orchestrator-improvement-backlog.md`; no prompt/runtime edits were made.
Baseline and matched one-role compression criteria are recorded there.
Details: `root/token-optimization-review.md`.

Current at 2026-10-13 21:10 UTC: r117 repair integrated; r118:a0 found a new
producer/consumer mismatch for valid stop evidence while a different owner keeps
the run BLOCKED. It returned fail despite 284 passing tests and received no
accepted review receipt. r118:a1 lifecycle verifier passed its scoped checks.
Lead dispatched r119:a0 recovery-engineer (task ed30b7a9-c86c-4f88-a05b-ad59bb7324ac),
currently running, to repair the mismatch. No owner question is open. All prior
receipts need appropriate fresh matching review after this writer integrates.
Watcher 80244 is confirmed live at 21:10 UTC, using 394000 ms. Five-gap mean
711500 ms yields 356000 ms for its successor; do not restart a live observation
handle solely to adjust the cadence.

New user-authorized work: UI-PERF-01, a second read-only launcher page with
charts. Preserve ReAct and all execution/review/budget gates. Use static assets
under launcher-ui so the page works on the active launcher without a restart;
add optional detailed ledger telemetry to usage API for a later safe transition.
Legacy data fallback must distinguish dispatch lifecycle spans from model time,
and execution completion from review acceptance. Launcher shutdown stops all
projects, so do not restart it during this run.

Latest scope refinement: visible UI is only task tokens and working time. Rich
performance/quality statistics belong in an isolated local SQLite table for root
analysis, never the active orchestrator state DB. performance_data now owns a
deterministic collector/store and compact static task-metrics/v1 snapshot;
performance_ui is simplifying to summary, selectors and a paginated task table.
No extra LLM calls or live service restart. At 21:17 UTC r119 is integrated and
both r120 verifiers passed; fresh audit remains required.

Monitoring at 20:58 UTC: r114 repair remains integrated; r115 verification
passed. r116:a0 exposed M4-P-RECOVERY-UNKNOWN-OWNERSHIP. r117:a0 is repairing it.
After integration, require fresh verifier and auditor receipts for both the
recovery repair and lifecycle-authority candidate before accepting checkpoints.
M4 remains pending.

User clarified that ordinary lead questions should be resolved autonomously,
without requiring attendance. Work exceeding explicit initial constraints is
deferred while authorized work continues. User then requested global permissions
to stop repeated tool approvals. Updated /home/sr/codex-home/config.toml:
approval_policy=never, default_permissions=:danger-full-access. Config backup:
/home/sr/codex-home/config.toml.permissions-backup-20261013T194708Z. Persistent
allow rule added for the exact absolute controller helper in default.rules.
Next helper execution passed without a new approval. New global defaults apply
to new sessions; current managed sandbox is not assumed dynamically changed.
Use the absolute helper path for subsequent monitoring calls.

Post-restart monitoring confirmed r99 repair integrated and r100 verifier passed.
Do not resend h29 or restart the project server. Resolve technical questions
autonomously.

User clarified the primary outcome: resolve blockers to orchestrator work,
including project-level findings. For a project blocker, inspect the finding,
select a bounded authorized repair, and drive it through the lead and independent
review. Keep working on safe independent scope if the finding is gated; record
the precise resume condition. This operating decision is in
root/blocker-decision-log.md. r108 accepted the quota lifecycle specification;
r110 verified and r111 audited c.2a preparation support. r115 verification
passed its authority/persistence and lifecycle scopes; r116 then found the new
recovery ownership blocker, now under r117 repair.

## Historical handoff (superseded current status)

Status: scoped-review gate correction is committed as cdefa56 and focused tests
pass. The resumed run crossed the gate: verifier r52:a0 for
m4-r20-integrated-authority-persistence was accepted. Auditor r52:a1 for
m4-t312d2-lifecycle-authority executed and returned VERDICT: fail on a separate
target-project lifecycle defect. No target-project files were changed during
this diagnosis.

Baseline: 684fff22bad11f22d93e815ea0286e84acc1826b.

Changes: `hasActiveReviewerScope` admits verifier/auditor assignments only when
their full review scope matches an active obligation. The dispatch decision gate
and execution-time writer gate both exempt those reviewers across other pending
critical checkpoints. Unrelated writable assignments remain blocked; separate
verifier-before-auditor validation is unchanged. Added a two-checkpoint
regression that makes one prior receipt stale, reviews both checkpoints, and
finishes only after both auditors pass.

Files: `src/lead-graph.js`, `test/lead-graph.test.js`.

Verification: `env -u NODE_TEST_CONTEXT node --test-name-pattern='scoped reviewers|same-checkpoint repair|pending critical checkpoint|critical writable verifier' test/lead-graph.test.js` - 4 passed, 0 failed. `git diff --check` passed.

Diagnosis: `resolve_task_ownership` accepts any earlier committed
ASSIGNMENT_COMPLETED event as sufficient stop evidence, even if a later
RECOVERY_FENCED event for the same assignment/generation records
ownership=`unknown`. `recovery_fence` sets the run BLOCKED but leaves the
completed assignment non-live; the ownership resolver only checks non-live and
then scans for any completion/reconciled-stop event without letting a later
unknown event revoke it. Relevant target-project paths are
`src/teamwork/state/execution_control.py:2306-2330` and `:3138-3163`. The
existing test at `tests/state/test_execution_control.py:1909-1928` tests unknown
recovery only while the assignment remains live, so the post-completion ordering
is uncovered. Auditor classified this as high severity AUD-T312D2-01; it traced
the scenario statically and explicitly did not execute it.

Review-context access: the agent environment could not connect to the supplied
127.0.0.1 launcher URL. Read the configured project state DB in read-only mode;
context `8d7f6bd4-2d43-48cd-933a-53736fba2e88` contains only lead run
`a125b4c6-f640-45ae-a106-22f97837f8e9`. Exported the three required checkpoint
objects, including their original evidenceIds, to
`root/review-context-export.json`. Exact structural equality with the stored
checkpoint objects and run binding were verified. The export is admission
context only; it does not provide verification evidence or accept any M4
checkpoint. The database was not modified.

Pending: repair the target-project lifecycle ordering and add a regression for
complete -> later unknown recovery -> ownership resolution. Preserve both
checkpoint obligations; verifier and auditor acceptance must follow the repair.

Previous completed control-plane repairs are in baseline commit
684fff22bad11f22d93e815ea0286e84acc1826b. Their detailed review evidence is in
the earlier ignored handoff snapshot under `/tmp/cp-loop-audit-session-Y5u75p/`;
that temporary evidence may disappear.
