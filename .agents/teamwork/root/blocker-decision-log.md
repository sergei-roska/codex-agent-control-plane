# Blocker and decision log

Current run: a125b4c6-f640-45ae-a106-22f97837f8e9
Session: 8d7f6bd4-2d43-48cd-933a-53736fba2e88
Last updated: 2026-10-13

This is the running operations record for the live task. Accepted product
decisions and review findings are also recorded in the controlling docs or the
target project's own review artifacts. Do not use this file as a substitute for
target-project evidence or acceptance receipts.

## Issues and resolutions

| ID | Problem | Resolution / state | Evidence |
|---|---|---|---|
| h29 | Lead could not admit a prerequisite verifier across incomplete critical review gates. | Resolved: implemented bounded `review.prerequisiteFor`, independent review, loaded-runtime identity endpoint, managed project-server restart; answered h29 through A2A with loaded hashes. | `root/h29-answer.json`, `root/h29-review.md`, `docs/adr/prerequisite-review-admission.md`, `/tmp/h29-loaded-runtime.json` (temporary) |
| Admission review 1 | A writer on an existing pending checkpoint could co-dispatch with a prerequisite verifier in another wave. | Resolved: prerequisite admission rejects every other writable assignment; regression covers original-checkpoint writer in wave 1 and linked verifier in wave 2; critic approved. | `src/lead-graph.js`, `test/lead-graph.test.js`, `root/h29-review.md` |
| r98 / AUD-R98 task split | c.2 required launch-failure evidence whose implementation/checks belonged to c.3. | Resolved by lead's r99 documentation-only repair; preserved the launch-failure requirement and moved its owner to c.3. r100 verifier passed. | Target run r98:a0, r99:a0, r100:a0; snapshot in `/tmp/h29-r101-task.json` (temporary) |
| r101 / AUD-R101-01 | Contract did not define stale-turn completion/recovery fencing with atomic lease, turn and dispatch identity checks. | Resolved at specification level: r104 confirmed atomic active-tuple comparison, rejection without mutation, and separate state/dispatch/recovery owners; r108 audit passed. Product implementation remains pending in the gated state leaves. | Target run r101:a0, r102:a0, r103:a0, r104:a0 and r108:a0 in controller state DB; `/tmp/h29-r101-task.json` is temporary |
| r101 / AUD-R101-02 | Distinct command IDs could reuse one quota proof before dispatch; no atomic proof consumption or one-outstanding-turn rule. | Resolved at specification level: r108 passed single-use proof consumption, one outstanding turn, historical nonauthorizing replay, durable no-launch reconciliation, and fail-closed ambiguous launch. Product implementation remains pending. | Same as above |
| r101 / AUD-R101-03 | No finite durable continuation allowance/exhaustion rule; unchanged attempt count permits endless continuation. | Resolved at specification level: r102 selected `explicit_quota_allowance`; r108 passed required explicit finite policy, no default, zero disables, nonrefundable debit, restart/reassignment persistence, and no positive quota grant. Product implementation remains pending. | r102:a0:t1 choice and r103/a0, r104/a0, r108/a0 results in controller state DB |
| r101 / AUD-R101-04 | Evidence index's historical dispatcher result count differs from the referenced artifact. | Resolved at specification level: r108 verified transcript digests and separate histories: dispatcher-final 53 passed/2 failed; dispatcher-rerun 39 passed/12 failed; r92's 55 passed/1 failed report remains attributed only to that report. | r102/a0 and r108/a0 results; target `artifacts/m4/T3.1.2e.1c/evidence.json` |
| r104 / M4-P-QUOTA-STATE-TASK-SIZE | Task c.2b combined too many state lifecycle changes for one bounded implementation session. | Resolved at specification level: r105 made c.2b nondispatchable with seven sequential gated state leaves, obligation coverage and c.3a/c.3b dependency gates; r106 independently accepted the split. Product implementation is not accepted. | r104/a0, r105/a0, r106/a0 and problem/verification events in controller state DB |
| r107 / M4-P-QUOTA-AUDIT-STALE-ORIGIN | Auditor continuation was rejected before execution because its originating review target was stale after specification changes. | Resolved: fresh-origin r108 audit passed. Preserve r107 as a failed, unexecuted historical attempt. | r107/a0 failure, problem/remedy events and r108/a0 result in controller state DB |
| M4-P-QUOTA-POLICY-SUPPORT | Bounded c.2a preparation support was needed to persist the explicit per-attempt quota policy before state authorization work. | r109 implemented optional finite-integer validation and persistence; r110 independently verified the implementation and r111 auditor accepted the authority/revision checkpoint. This does not grant quota continuation or dispatcher acceptance. | r109/a0, r110/a0, r111/a0 in controller state DB |
| Monitoring watch state | A2A task status remained numeric 2 while the launcher situation advanced. The old watch loop waited only on run state and owner questions, missing new failed reviews while the lead kept working. | Updated the local watcher to report newly failed/inconclusive assignments as well as owner questions and nonworking state. It baselines already-known failures to avoid repeat alerts. `node --check .agents/teamwork/root/control-client.cjs` passed. | `root/control-client.cjs`; r116 situation and dispatch records |
| Approval noise | Repeated command approvals interrupted unattended monitoring. | Resolved as configured preference: wrote `approval_policy=never` and `default_permissions=:danger-full-access` to global Codex profile; backed up prior config. Added a persistent allow rule for the exact A2A control helper. Actual managed runtime can still enforce its per-session sandbox, so no broader enforcement is claimed. | `/home/sr/codex-home/config.toml`, `/home/sr/codex-home/rules/default.rules`, `/home/sr/codex-home/config.toml.permissions-backup-20261013T194708Z` |
| Poll cadence | Fixed 5-second polling was excessive. | Poll at half the observed mean inter-arrival time of newly surfaced blocking failures (failed/inconclusive reviews or newly discovered unmet prerequisites), not routine planned leaf work. Original measured gaps: 519186, 798442 and 578448 ms. New blocker gap: r113:a1 at 20:37:28.727 to r116:a0 at 20:58:21.377 = 1252650 ms. Four-gap mean is 787182 ms; set the adaptive interval to 394000 ms (~6m34s). Recompute on each new blocker. | `root/control-client.cjs`; blocker failure timestamps in controller state DB |
| MON-A2A-01 | The current Codex sandbox denied localhost A2A polling with EPERM after restart. | Resolved for the authorized read-only monitor using the escalated command path; no orchestrator write or answer was sent. | `root/control-client.cjs`; r115 status read at 20:53:05 UTC |
| TOK-OPT-01 | Cumulative input is high, but the ledger cannot show per-request replay or worker context saturation. The largest worker totals are completed assignments with zero retries; 94% of worker input is cached. | API rates can price a counterfactual: $34.48 at Standard short-context rates for 356 known rows, with 14 unknown rows omitted; measured subscription cost remains null. Coordinator and auditor account for about 91% of this estimate. Keep gates and effort unchanged; inspect those instructions, then baseline and run a reversible one-role compression pilot. Record worker context size if saturation needs diagnosis. No runtime/profile change made yet. | `root/token-optimization-review.md`; `src/codex-app-server.js:894-925`; [OpenAI API pricing](https://developers.openai.com/api/docs/pricing); [OpenAI observability guide](https://developers.openai.com/api/docs/guides/agents-api/observability); usage snapshot at 2026-10-13 20:51 UTC |
| M4-P-QUOTA-INITIAL-DISPATCH-AUTH | First-turn creation and dispatch binding must not authorize work when the canonical run is not dispatchable. | r115:a0 verifier passed target pins, preserved obligations, rejection/nonmutation controls, rollback and concurrency. Awaiting lead checkpoint disposition; no M4 acceptance or quota continuation authority. | r114 integration and r115:a0 verifier receipt in controller state DB |
| M4-P-QUOTA-PAUSE-CANCEL-AUTH | r113 surfaced a pause/cancel authority finding; abandonment and suspension behavior must remain preserved. | r115:a1 verifier passed repaired first-turn authority and preserved lifecycle checks. Awaiting lead checkpoint disposition; no M4 acceptance. | r115:a1 verifier receipt in controller state DB |
| M4-P-RECOVERY-UNKNOWN-OWNERSHIP | Fresh r116 audit found that an unrelated stopped assignment can clear BLOCKED while an earlier assignment still has unknown ownership, and older `reconciled_stopped` evidence can authorize a replacement after resume. | High severity; no acceptance. Lead dispatched r117:a0 for a deterministic multi-assignment regression and a bounded recovery-fencing repair in `src/teamwork/state` and `tests/state`. Fresh review must follow. | r116:a0 auditor receipt and r117:a0 task in controller state DB; target source at HEAD 49d390c9b2b31077a18cecaf228c18604c3a8341 |
| M4-P-PINNED-AUDIT-WRITER-STATE | r116:a1 lifecycle auditor could not start because pinned review admission reported an active or unresolved workspace writer. | Unresolved; retry a fresh pinned audit only after r117 writer has completed and its candidate is integrated. Do not bypass the writer gate. | r116:a1 task failure in controller state DB; r117:a0 active assignment |
| M4-P-RECOVERY-STOP-CONSUMER | r118:a0 found that H1 producers record a genuinely stopped assignment with run state BLOCKED when another owner remains unknown, but canonical stop-evidence consumers reject BLOCKED. | r117 integrated; r118:a0 returned fail despite 284 passing checks and received no accepted review receipt. Lead dispatched r119:a0 recovery-engineer to reconcile producer/consumer semantics while preserving unresolved-owner and replacement protections. No gate bypass. | Read-only controller dispatch records for r117-r119; A2A situation at 2026-10-13 21:10 UTC |
| TOK-PROMPT-01 defer | User requested a future backlog instead of implementing the compression pilot now. | Queued with baseline, matched comparisons, preserved safety/acceptance requirements, and a reversible one-role pilot. No runtime/profile edits. | `docs/orchestrator-improvement-backlog.md`, TOK-PROMPT-01 |
| UI-PERF-01 | User requested a second launcher page with performance and token charts. | Implement a read-only page from recorded usage and dispatch data. Static page must work against the already-loaded legacy usage/session API; detailed ledger metrics can appear after a later safe launcher transition. Never restart the active launcher: its shutdown calls projects.stopAll(). Unknown data remains unknown. | `launcher.js`, `src/launcher-app.js`, `src/launcher-sessions.js`, `src/usage-report.js` |

Latest cadence update: r116:a0 at 20:58:21.377 to r118:a0 at
21:05:10.152 is 408775 ms. Five-gap mean is 711500 ms; next watcher interval
is 356000 ms (~5m56s). Live watcher 80244 retains its current 394000 ms cycle
until it yields; avoid restarting a live handle solely for a 38-second adjustment.

At 2026-10-13 21:17 UTC, r119 integrated and both r120 verifiers passed their
scoped persistence/lifecycle checks. Fresh independent audit remains required;
no project/M4 acceptance is inferred.

UI-PERF-01 scope correction: owner requested only task tokens/time on the visible
page. Rich optimization statistics go to an isolated local SQLite metrics table
for agent analysis, populated deterministically from read-only state queries.
Publish a compact static numerical snapshot so the already-loaded launcher can
show task metrics without a restart. Preserve all unknown and partial coverage.

Final UI refinement: retain the page style approved by the owner, add exactly
two compact task-token/time charts, collapse the paginated detail table, and
increase font sizes. Detailed model/quality analytics remain in SQLite.
Independent review found source-DB alias/companion path acceptance and incorrect
unknown-token coverage; collector activation is held until those real findings
are fixed and re-reviewed. No real-state collector has been invoked yet.

At 2026-10-13 21:24 UTC, r122:a0 audit admission was stale and r122:a1 found
AUD-LIFECYCLE-01: replacement SQL lacked committed controller provenance and
generation binding. Lead is repairing this in r123:a0, no owner question open.
Treat the two same-round failures as one blocker episode. r118 at 21:05:10.152
to r122:a1 at 21:22:19.537 is 1029385 ms; six-gap mean 764481 ms gives a
382000 ms (~6m22s) successor watch interval. Current watcher stays live at
394000 ms until it yields. Fresh independent acceptance remains required.

## Accepted decisions

- h29 choice: `implement_environment`; supported admission and loaded source hashes sent by A2A. The new prerequisite review creates real run-bound receipts and leaves every original checkpoint pending.
- Runtime activation: use the launcher-managed restart after checking no worker was active; do not infer loaded code from Git HEAD. PID 213246 returned all four expected source hashes, no uncaptured files, and the unauthenticated endpoint returned 401.
- Autonomous handling: resolve routine technical questions within the original task and logged constraints. Defer work that would exceed explicit live authority or budget; M4 and Phase C remain gated.
- Project-level blockers: inspect the finding, choose a bounded repair path, drive it through lead within the target task's authority, and require fresh independent evidence before calling it cleared. Continue unrelated safe work if it crosses an explicit gate. For r101, r108 audit accepted all four specification repairs after r106 verified the decomposition. Product implementation is now staged behind the declared leaves.
- r102 decision: `explicit_quota_allowance`. Use persisted per-attempt `retry_policy.max_quota_continuations` with atomic, nonrefundable admission debit. This chooses specification semantics only; it grants no positive quota, added budget or live-call authority.
- r105/r106 decomposition: make c.2b nondispatchable and split its state lifecycle obligations into seven sequential, independently gated leaves. c.3a cannot start before the state leaves and required audit; c.3b also requires reviewed c.3a linkage. r106 accepted this specification split only.
- r107 stale review origin: do not retry the stale continuation. Preserve its rejection as historical evidence and start a fresh audit against the accepted r106 review origin; r108 passed and the lead resolved this review-admission issue.
- r108 audit: accepted the quota lifecycle specification and closed r101's four findings and the stale-origin retry issue at specification level. Implementation and original dispatcher checkpoint acceptance remain pending.
- c.2a policy support: r109/r110 added and accepted preparation validation/persistence for the finite allowance; r111 must audit before state work proceeds. This does not authorize any positive allowance or runtime continuation.
- Monitoring: existing A2A API; adaptive read-only polling. No MCP server added.
- Permissions: persist the user's requested global preference and exact helper rule, while treating current managed runtime restrictions as authoritative.

## Next

Poll after 394000 ms using launcher situation as the live run source. Record
r111's audit outcome, subsequent findings, repair
decisions and resume conditions here and in the current handoff. Do not infer
acceptance from the stale A2A task status or a task state alone.

## Shutdown and successor record (2026-10-14 local)

- UI-PERF-01 complete in the working tree, independent review APPROVE. Full suite:
  1092 passed, 1 optional live probe skipped, 0 failed. Two charts, larger fonts,
  full viewport width and mobile layout verified on live static snapshots.
- Performance review found source DB/SQLite companion/inode alias acceptance and
  inaccurate token coverage. Same worker fixed both, added disposable controls,
  and independent re-review passed before real collection. UI aggregate-only
  total derivation and chart/mobile presentation issues were also corrected.
- Final separate metrics DB: .runtime/projects/c8740b5b4f/performance.sqlite,
  performance_attempts; 398 ledger entries, 195 grouped tasks. Final source DB
  SHA-256 unchanged by readonly collection. Sampler/browser/watch stopped.
- r123 repair integrated; r124 verifier checks passed. r125:a0 and r125:a1
  independently found AUD-RECOVERY-UNRESOLVED-01 / AUD-LIFECYCLE-02, the same
  nonauthoritative recovery supersession flaw at execution_control.py:3749-3766.
  a0 reproduced it in memory; a1 statically traced it. No accepted checkpoint,
  dispatcher or M4 gate. Next bounded repair after explicit owner resume must
  validate authoritative committed supersession with corruption controls;
  reassess repeated independent predicates and prefer shared canonical checks.
- Both auditors ended; task persisted owner_pause at collect, round 125.
  User requested shutdown until tomorrow. Preserve pause and do not resume.
- Managed POST project stop succeeded. tower-defense was already stopped.
  Launcher PID name matching found no candidate; socket inspection identified
  exact port-8080 PID 184772. Graceful SIGTERM succeeded. PID184772/PID213246
  both ESRCH, ports8080/3001 both ECONNREFUSED. No database/session deletion.
- Normal sandbox mounted teamwork notes readonly. Supported escalated command
  saved handoff/PROJECT and archived prior notes; no permissions workaround.
- r125 same-round failures count as one episode ending 21:37:37.863 UTC.
  New gap from r122 is 918326ms. Seven-gap mean786459ms, next interval393000ms.
  Previous in-flight cadence estimates are superseded; no monitor remains live.
- All source work is saved but uncommitted; no Git mutation. Read root/handoff.md
  first tomorrow. The previous handoff is preserved in its ignored archive.
