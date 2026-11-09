Verdict: APPROVE
Blocking: none. The independently reproduced stale-task resend is resolved by the frozen goal-fence repair.
Non-blocking: Broader unsafe-shutdown/fresh-controller terminal reconciliation and ordinary cooperative retry-close remain unqualified.
Status: complete
Scope expansion: none

Combined correction acceptance and bounded store re-review

The original review is preserved as correction-initial-reject.md, including per-criterion findings and the successful defect reproduction. This report supersedes its blocking verdict for the combined frozen correction and goal-fence candidate. No production source/tests/config/Git state were changed during review.

Read: recovery-goal/handoff.md, actual git diff --no-index against its preserved source original, paired test delta, and claim/recovery/store/executor/scheduler callers. Only the new goal-fence delta and the prior blocker were re-reviewed; unchanged correction authorization, rollback, history, supersession and current-pin evidence was reused and its affected combined tests rerun. The announced recovery-goal/source-final.json was absent; independently computed hashes match both hashes explicitly frozen in the handoff, so the missing redundant manifest does not block verification.

Frozen hashes independently confirmed

- src/backlog-store.js: 50bb84a87e98f1a786aded81946eefd72d63470dda20090f21e3de11cc9db90b
- test/backlog-store.test.js: d0363ebe48f1ac18150d3ccd053d1db07e0b9a7fa4681d646ba09c1a0ee937db
- src/concurrent-delivery-engine.js: ff9da23fec72d5072ac552b4381cab7f597ea16647afb604c16dc294b420a094
- src/project-delivery-controller.js: 97512f0dafc2f590718d07eef3a051396d11f33a816c91d03b392f2619719a4f
- test/concurrent-delivery-engine.test.js: a325352f25c9525fa9274349f58c5da7839acf2eefc0567d76dd47502596128a
- test/project-delivery-controller.test.js: f2bf88c8749f68f578ab4a6a2e5108bd126da8f76bdefb634420bcfc1ea1a834

Per-criterion result

PASS - Correction-only processing precedes ordinary facade resume, without rebasing stale owner expectations. Direct and recovered SQLite resume apply pending corrections before changing pause controls. Reused-controller pause/drain overlap evidence from the original review remains valid.

PASS - Correction, deterministic replacement checkpoint registration, current inventory, supersession and applied acknowledgement remain one synchronous transaction. Hook, registration, supersession and acknowledgement failures roll back objective, registry/inventory, relation, correction and event writes. Default hook compatibility and async-hook refusal remain intact.

PASS - New current checkpoints preserve mandatory checks, environment/profile/criticality and dependency remapping through existing authorization and complete-coverage validators. Sequential corrections preserve historical rows and original intake. Actual corrected-pin finalization uses independent current candidate-bound verifier evidence. Production authentication and correction authorization default to deny; no route was added.

PASS - Auth/stale/replay and owner-generation fences. Negative tests and exact replay retain prior evidence. Independent probes from the original review showed takeover inside authorization and inside hook rolls back; no relevant controller/store correction boundary changed in this repair.

PASS - Old admitted workers retain contract, controls, claims and bytes while active. Live-controller completion remains lawfully not_published after correction. The formerly failing successful-shutdown composition now retires the proved old attempt without granting its old task fresh execution authority.

PASS - New claim captures goalRevision additively at backlog-store.js:1024. Trusted no-effect recovery at :1185-1199 compares captured goal and authority with the current objective. Corrected or authority-stale tasks become blocked/owner_correction_replan_required; the proved attempt closes and claim releases. Control revision alone does not block same-goal retry. Legacy missing goal only retries at objective goal1; corrected legacy tasks block. Cancellation takes precedence. Replan blocking is distinct from technical retry exhaustion and preserves original captured controls/contract/evidence. Existing exact proof validation remains unchanged.

PASS - Explicit fresh work remains possible. The independent actual engine/HTTP/Git/SQLite probe verifies: corrected goal2, successful old-worker shutdown recovery, old task blocked, claim released and old attempt canceled with unchanged contract/controls/private bytes; ordinary resume with planner delta:null does not resend it. A later explicit current-pin plan creates a distinct fresh-corrected-worker task, which executes with captured goal2. The probe never requeues or mutates the old task directly and does not fake reapproval of the old contract.

Independent execution

1. Store/executor invariants, exit 0, 9 pass / 0 fail:
env -u NODE_TEST_CONTEXT node --test --test-name-pattern='no-effect recovery respects captured goal|recovery proof|recovery.*reject|recovery.*requeue|recovery.*cancel' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/backlog-store.test.js test/task-executor.test.js
Log: recovery-goal-independent.log. Includes corrected goal, same-goal control drift, both legacy cases, authority drift, canceled finality, exact synchronous proof, and refusal of missing/async/mismatched proof.

2. Real-engine no-resend plus explicit fresh work, exit 0, 1 pass / 0 fail:
env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' .agents/teamwork/cn14-facade-20261028/review/correction-recovery-probe.cjs
Log: correction-recovery-fixed.log. Readable scenario: correction-recovery-case.cjs. Bootstrap reuses the actual repository's disposable fake HTTP/Git/SQLite harness definitions without running its test cases. Output confirms oldTaskState=blocked, oldTaskReason=owner_correction_replan_required, workerCalls=2 total (one old admitted call, one distinct fresh task), freshTaskId=fresh-corrected-worker and freshGoal=2.

3. Combined correction/current acceptance/rollback checks, exit 0, 11 pass / 0 fail:
env -u NODE_TEST_CONTEXT node --test --test-name-pattern='owner correction facade|correction trusted hook|correction-only drain' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js
Log: correction-combined.log. This reruns direct/recovered/repeated correction acceptance, auth/stale/replay, atomic checkpoint/register/supersede/ack rollback, old-worker contract/private bytes, generic hook rollback and stale-owner correction-only refusal with the repaired store.

Historical reproducer preserved

Readable original defect scenario: correction-requeue-original-case.cjs; bootstrap: correction-requeue-original-probe.cjs. Exact historical command:
env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' .agents/teamwork/cn14-facade-20261028/review/correction-requeue-original-probe.cjs
This intentionally asserts the old defect and is expected to fail after the repair. Historical output remains correction-requeue-probe.log. Use correction-recovery-probe.cjs for the positive qualification. No source revision switch is needed or authorized by these commands.

Limits and integrity

No assertion or prior proof guard was weakened. No broad/full suite, live provider or service change was run. Root owns integrated verification. The separate retained correction/shutdown-worker-repro.log unknown/submitted terminal-identity refusal remains the adjacent pre-existing lifecycle/normal-adapter mismatch described in correction-initial-reject.md. This approval does not qualify general recovery-from-resume or cooperative release/process coverage. Local ignored probe helpers/logs may disappear; preserve them if future reruns are needed.
