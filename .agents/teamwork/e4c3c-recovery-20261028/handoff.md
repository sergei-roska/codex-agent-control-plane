# Candidate-bound e4c3c acceptance recovery

Status: in progress. User authorized recovery after the legacy run stopped on recurrence.

Original task 5f4d2e30-5b7c-4bb7-a02f-d27b46dd2b09 is terminal, preserved unchanged. It mixed develop controller target with external candidate d784118. Prior reports: read-only cache lock, incorrect ancestry assertion, then successful candidate checks but incomplete mapping and wrong controller target. Recurrence key counted verifier rounds 2/5/7 despite different blockers.

Supported recovery route: register the existing candidate worktree itself as a separate launcher project. Project 2f5c3c70b4, port 3003, legacy engine, full-access owner default. Shared Git-common-dir lock prevents it running concurrently with original project 3d9c2e759c on 3002. Verified no active runs, writers (all released), fences or concurrent backlog before stopping 3002 through launcher. Original project must be restarted after recovery project is safely stopped. No manual SQLite writes, lock manipulation or receipt rewriting.

Current task 8f2f1e0e-1417-4678-8ef1-b5a13348ef02, context 702051c8-c6a2-4554-9e4e-beb86e811d43. brief.md contains its bounded acceptance objective and exclusions. Four pinned deterministic checks include full pytest with 1200000ms timeout. Candidate remains clean at d784118, tree 5380181b542342f7d2d7f069bddefa3c617b398a, parent 58f9ba2.

First verifier incorrectly requested a callable receipt tool. Its controller coverage was targetKnown/stable/currentTargetMatches true and lane content matched candidate. Lead corrected that interpretation and dispatched a fresh verifier after a stale continuation refusal. New verifier knows controller attaches receipts after the report and no worker-side API is required. No accepted receipt yet; complete mapping, required tool/runtime evidence and independent auditor remain pending.

Quota: fresh account/rateLimits/read at 2026-10-28T19:57:52Z for /home/sr/codex-work showed 83 percent five-hour, 67 percent weekly remaining. Launcher fresh system reading matched; inactive roskasergei showed only 8 percent five-hour and is not authorized for new development under quota policy. No model probe used.

No project source, config source, tracked docs, tests, Git branches/index/commits or native credentials were changed by root. Existing dirty Control Plane work remains owned by predecessors. Runtime project registration/start/stop used supported launcher APIs. No integration authorized in this acceptance task. After passing acceptance, review result and decide next independently scoped integration action under the user's authorization.


## Reassessment and final receipt task

The first recovery task was canceled safely after its owner pause, preserving all reports and no source edits. Native independent critic completed the full mapping and real external-wheel proof: independent-evidence.md, 187 passed/71.68s, 47 pins, byte-verified artifacts, 203/85 exact snapshots and complete prior-source accounting. Risk review passes; only controller final deterministic receipts remain pending. Native critic can close its report once those receipts exist.

Final receipt task f849b522-1268-4726-8138-68e97517902d, context fe2104bb-f188-412e-909a-28216429ba41, has receipt-brief.md and six owner-pinned checks including full pytest. Two Terra verifier reports again stopped with feasible reading/provenance work incomplete and no actual technical blocker. Reassessed instead of making an identical third assignment. Safely owner-paused the SAME task, stopped recovery project and used launcher role-override APIs for this temporary project only: verifier gpt-6.1-sol/medium and reviewer persistence/automatic-receipt guidance; auditor same persistence guidance with its existing model/effort. Restarted3003 and resumed SAME task with history and guard counters preserved. No model changes to original project or source profile defaults. These changes require complete work and honest evidence, never a forced pass or waived check.

Root's inherited Control Plane source map is control-plane-input-map.json (910 files); compare at completion. No source files have been edited. Restore3002 after final recovery project quiescence/stop. Local project overrides and registration are runtime configuration, not changes to native credentials or global profiles.

The updated verifier completed the full review. Controller review_result accepted/currentTargetMatches=true/serviceReviewAccepted=true, preserving the unchanged candidate and existing run history. review-receipts.json captures exact recorded review events. Independent auditor and six final controller checks remain pending; automatic recovery lacked an auditor template, so lead must dispatch the matching auditor explicitly.


## Controller fix applied

A real admission bug was proved in the legacy controller: two existing reason lists omitted validated_auditor_template_unavailable. A fresh accepted same-batch verifier was therefore hidden from auditor admission, and explicit replanning did not advance recovery. Junior implemented only those reason-list additions, preserved original positive coverage by parameterization, added missing-template/stale-profile positive case and kept historical/invalid-template denial. Native independent critic APPROVE; seven decisive regressions passed. Full current Control Plane tests in home-based owned worktree: 1983 total,1981 passed,0 failed,2 optional skips,47.37s. Initial /tmp full run failed due scratch-base overlap with /tmp and missing parent ajv module resolution; moving the verification snapshot to a home-based worktree resolved environment without source changes. Prohibited candidate-filter test was excluded by exact named skip pattern throughout.

Reviewed four-file delta applied to main working tree only after byte-equality to saved baselines. Paths: src/lead-graph.js, test/lead-graph.test.js, README.md, docs/production-transfer.md. No staging, commits or pushes. Patch saved recovery-fix.patch; review recovery-fix-review.md. Owned verified worktree /home/sr/Projects/Workspace/codex-agent-control-plane-recovery; initial owned snapshot /tmp/cp-recovery-auditor-vmvfj1ak/worktree retained. Original inherited changes preserved. Running3003 verified lead-graph hash d520260d8c2f1176739afce7311cdadbbd1492b02ca723188589e0f5b375f032 equals reviewed source.

The resumed older task had already advanced to an explorer using pre-fix facts and chose partial finish. A requested cancellation returned not-cancelable and task is terminal FAILED with downstream-cancellation-unconfirmed message; acceptance writer is released and prior workers terminal. Do not describe this task as accepted or reuse it as final qualification.

Post-fix bounded final task: 8341e45b-e3fa-4a69-89a0-649d9635c93b. postfix-task.json and postfix-brief.md. It explicitly supplies the applied fix facts and requires a matching verifier wave1/auditor wave2 pair in the same decision, then six pinned final deterministic checks. Candidate remains exact and clean. Original3002 remains stopped until post-fix task settles and3003 is stopped; restart3002 afterward.


## QUOTA PAUSE - latest authoritative state

Fresh supported launcher /api/accounts?force=1 read-only account/rateLimits/read reported system primary used97% (3% remaining), weekly used45% (55% remaining). Owner also reported low quota. No new development batch or agent assignment may start until a fresh supported reading is above10% or explicit owner policy change. quota-pause.json records observation. Root requested owner pause on post-fix task8341e45b-e3fa-4a69-89a0-649d9635c93b so active verifier finishes first and no new auditor starts. This final task has NOT passed acceptance. Do not claim candidate milestone complete.

Source fix itself IS implemented, independently APPROVED and verified (1981pass0fail2optional skips); applied four-file delta and running module hash were proven. Root source-map comparison confirms only the four named task files changed from inherited baseline. No commits/staging/pushes. Existing unrelated dirty work is preserved. recovery-fix.patch and recovery-fix-review.md are concrete review evidence.

Pending after quota resumes: inspect post-fix task current checkpoint via A2A3003 (or restart recovery project through launcher if stopped), resume SAME task8341e45b-e3fa-4a69-89a0-649d9635c93b with its original context and six unchanged pinned checks. It planned verifier wave1 plus auditor wave2 in one decision on corrected controller. First finish current verifier, then accepted independent auditor, then final locked sync/Ruff/both mypy/full pytest. Reuse independent-evidence.md and actual immutable current reports; do not create another blind verification run or reset counters. No candidate source edits or branch integration are part of current bounded acceptance.


## Resumed 2026-10-28T23:17:14.245665+00:00

Owner explicitly resumed. Fresh supported account/rateLimits/read through force launcher observation reports100% five-hour/54% weekly remaining. Post-fix task was safely INPUT_REQUIRED/owner_pause; active verifier had failed on usage_limit with retained continuation thread/lane, no source edits. Resumed SAME task8341e45b-e3fa-4a69-89a0-649d9635c93b over A2A. No new run or receipt resets. Continue interrupted verifier then matching auditor and final deterministic checks.


Post-resume verifier and auditor both accepted on the SAME current candidate target. Postfix-review-receipts.json contains recorded events; old usage-limit outcomes remain historical. Auditor admission now ran successfully and no blocking product defect was found. Five controller checks are passed (sync, Ruff check/format, both mypy); final full pytest is running. Do not stop3003 or restore3002 until acceptance settles. Candidate remains unedited.


## COMPLETE - final authoritative result

Post-fix task8341e45b-e3fa-4a69-89a0-649d9635c93b COMPLETED with Acceptance: accepted. Current verifier r2:a0 and auditor r3:a0 both accepted/currentTargetMatches=true; auditor verdict pass. Six controller checks passed (locked sync, Ruff lint/format, standard and clean mypy, full pytest). Full pytest1656passed in450.96s; command451962ms/exit0. Candidate HEADd7841181b9ecab41e0838dd544a17ddaaccf58fa and before/after fingerprint10f15e861c8af6af423d17d474d135b401c35825823effd3ecebb82686587afb match. final-acceptance.json preserves exact checks/evidence refs; postfix-review-receipts.json preserves event history. Candidate worktree clean/exact at final check. Prior native independent report's CONTROLLER PENDING row is historical and is closed by these final receipts, without rewriting that report.

All recovery runs/workers and writers settled. Safely stopped recovery project2f5c3c70b4 on3003, restored original3d9c2e759c on3002, PID816104. /control/runtime loaded lead-graph SHA matches reviewed fixed source d520260d8c2f1176739afce7311cdadbbd1492b02ca723188589e0f5b375f032. restored-runtime.json records proof. Final root source-map comparison confirms exactly four named files changed; no unrelated inherited source drift or staging/commits/pushes. Owned isolated worktrees and patch remain available for review.

Scope complete: actual controller recovery defect fixed and reviewed; correct existing candidate independently accepted through A2A. No Agent Harness source changes, develop/main promotion, e4c4 implementation, product Role or live provider enabled. Candidate status documentation/integration remains separate; auditor noted nonblocking DOC-01 author-note wording (53 unchanged prior modules plus authorized owner change, rather than claiming all54 unchanged). Preserve original failed/partial runs as history; do not rewrite them as accepted.


## Owner requested process stop

After an other-engine busy error, owner explicitly requested stopping our process. Recovery3003 was already stopped and neither project had active writers or live runs. Stopped original project3d9c2e759c through launcher API as requested. Both3002 and3003 have no listener. No code or stored task state was altered; no automatic restart is authorized by this stop request.
