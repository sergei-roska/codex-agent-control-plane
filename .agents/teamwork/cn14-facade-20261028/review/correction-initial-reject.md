Verdict: REJECT
Blocking: src/backlog-store.js:1193, reached through src/concurrent-delivery-engine.js:409-414 and :439-446 - after an authenticated correction changes requirements, completed old-worker shutdown recovery requeues its old contract; ordinary resume sends it again with current controls without explicit replanning (ran/read). Release the proved old attempt but block its task for correction replanning when captured goal differs; preserve pause/resume retry behavior separately.
Status: complete
Scope expansion: none

Frozen reviewed hashes

- src/concurrent-delivery-engine.js: ff9da23fec72d5072ac552b4381cab7f597ea16647afb604c16dc294b420a094
- src/project-delivery-controller.js: 97512f0dafc2f590718d07eef3a051396d11f33a816c91d03b392f2619719a4f
- test/concurrent-delivery-engine.test.js: a325352f25c9525fa9274349f58c5da7839acf2eefc0567d76dd47502596128a
- test/project-delivery-controller.test.js: f2bf88c8749f68f578ab4a6a2e5108bd126da8f76bdefb634420bcfc1ea1a834

Read: correction/repair-brief.md, current handoff, four actual candidate deltas against preserved originals, current engine/controller, and surrounding backlog/review/lifecycle/scheduler/executor/role callers. Unrelated AppServer prerequisite was excluded. No source or test was edited. Existing failing regression intent remains real; no assertion weakening or verification concealment was found.

Per-criterion evidence

PASS - Resume-first ordering and correction-only processing. Engine constructs/reuses the controller, calls synchronous applyPendingOwnerCorrections before incrementing paused control revision, rereads the objective, then uses pinned lifecycle resume. The public drain performs no planner/provider turn. Existing owner-pause overlap regressions still pass. Reopened direct resume and recovered-controller resume apply pending correction at its original expected revision.

PASS - Atomic correction, registry, inventory, supersession and acknowledgement. Controller transaction at project-delivery-controller.js:273-299 encloses applyOwnerCorrection, the synchronous hook, post-hook identity revalidation and inbox acknowledgement. Engine replacements at concurrent-delivery-engine.js:1010-1034 register deterministic replacement IDs, retain old/new inventory during existing supersession validation, and finally select new current IDs. Failure at registration, supersession, hook or applied acknowledgement rolls back objective, checkpoint rows, inventory, relations, correction row and events. A blocked inbox record is recorded after rollback.

PASS - Current checkpoint pins, history and acceptance. The engine copies mandatory kind/reason/criticality/check/tool/profile/environment pins and remaps dependencies. CandidateReviewStore's unchanged authorization, exact prior coverage, current identity, criticality and graph checks remain in force. Tests reach actual corrected-pin acceptance using frozen candidate verification and preserve original checkpoint rows, intake goal/contract/digests and sequential correction history byte-for-byte. Old receipts do not become current receipts; finalization compares current objective/candidate/receipt pins.

PASS - Auth/stale/replay and generic hook behavior. Production defaults remain deny and no new route exists. Negative tests reject unauthenticated/unauthorized/stale messages without intake mutation; duplicate exact replay creates one correction/event, changed body conflicts. A no-op hook preserves standalone behavior; Promise hooks reject and roll back. Pre-existing owner takeover refuses before consuming a correction. Additional independent callback probes change owner generation inside authorization and inside the trusted hook; both roll back goal/generation/correction row with lifecycle_identity_changed.

PASS, limited - A corrected old worker retained in the live controller keeps its contract/control/fence/claim and private bytes; its normal result settles publication_authorization_changed/not_published. Paused live work remains unsafe to release.

FAIL - Old task cannot regain execution authority through shutdown recovery. A second independent full engine/HTTP probe uses the same admitted worker/correction fixture but invokes shutdown and releases the terminal worker while shutdown is draining. Shutdown completes safely, then ordinary resume sends the obsolete task again. No new plan approves it: subsequent planner output has delta:null. This is an existing recovery implementation defect exposed by the now-composed correction path, not a new line in the recovery module. It nevertheless violates the correction composition fence and prevents acceptance of the complete safety claim.

Blocking mechanism and decisive reproduction

Ran in-memory compilation of the actual test harness plus the held-worker scratch scenario, without source edits or live providers:
1. Admit old-contract-worker at goal1/control1, with an old task objective.
2. Authenticate/apply owner correction to goal2; pause and obtain owner_pause from facade.
3. Start engine.shutdown(), release the completed private worker, await successful shutdown.
4. Observe old-contract-worker is queued at objective goal2.
5. Call ordinary engine.resume. Observe workerCalls=2 and the second attempt uses the identical old task objective, now with captured controlRevision4. No explicit replacement/reapproval plan is supplied.

Evidence: review/correction-requeue-probe.log. The probe's passing assertions establish the defect; they are not a passing acceptance result. It finished in approximately 0.66s.

Read defenses checked: RoleService no-publication snapshot validates original execution/claim/binding identity but does not require original goal to match current goal. Engine shutdown calls requestLifecycleRecovery then executor.recover. TaskExecutor.recover deliberately allows control drift and calls settleRecoveredNoEffect. BacklogStore at :1184 reads the original attempt contract and :1193 requeues it unless canceled or retry-exhausted. Scheduler at task-scheduler.js:124-160 checks current controller pins, resources and admission policy; controller policy at :79-82 checks pending/blocking inbox corrections. The correction is already applied, so this barrier is gone. LeadPlanner with delta:null simply completes the inbox turn at :250-258; it does not block or reapprove the old queued contract. The observed second send confirms these defenses do not prevent the scenario.

Bounded fix direction

Capture goalRevision at claim as an additive capturedControls fact. A proved no-effect recovery may close the original attempt and release its claim, but should leave the old task blocked with owner_correction_replan_required when captured goal differs from current objective goal. Legacy attempts lacking that fact must not automatically requeue at a corrected goal; use a narrowly proved compatibility case or fail closed for replanning. A control-revision mismatch alone is insufficient because ordinary pause/resume also changes controls. Do not simply call shutdown recovery from resume. This is a proposed repair contract, not authorization or an implemented fix.

Independent commands and results

Ran, exit 0, 21 pass / 0 fail / 0 canceled:
env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='owner correction|correction-only|authenticated correction|authorized correction|owner pause facade' test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js
Evidence: review/correction-independent.log.

Ran, exit 0, 3 pass / 0 fail:
env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='owner checkpoint supersession' test/candidate-review.test.js
Evidence: review/correction-supersession.log.

Ran two additional in-memory controller-fixture assertions: takeover inside authorization and takeover inside correction hook both roll back. Both passed. No broad/full suite was run; root owns integrated verification. Prohibited named test was never run. Ignored local evidence may disappear.

Adjacent retained limitation

Read, not independently rerun: correction/shutdown-worker-repro.log and its readable case retain an unknown submitted attempt after unsafe shutdown, terminal drain and fresh resume, with delivery_role_terminal_identity_unavailable. The mechanism predates this delta: unchanged controller.start calls lifecycle.recover, which converts active attempts to unknown/settling but defers submitted intents; unchanged RoleService terminal identity requires active running task/attempt. Claims/private bytes remain retained. This refusal is distinct from the blocking successful-shutdown stale-task resend above. Neither broader recovery nor cooperative retry-close is qualified by this review.
