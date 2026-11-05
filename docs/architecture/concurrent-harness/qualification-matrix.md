# Offline qualification matrix

Status: V01-V43 remain accepted for bounded offline source qualification (L1-L5).
The latest frozen full suite on2026-11-05 passed2106 tests, failed0 and skipped1
optional live confinement probe (2107 total); all341 source pins were unchanged.
The native planner supersession repair passed110 affected checks and independent
schema/domain/history review. The subsequent role-sensitive writer-scope schema
repair passed the same full suite and 110 affected checks; independent review
validated 18 actual schema variants against writer/read-only capabilities. The
subsequent standalone dependency version repair passed the same full suite with
all 341 pins unchanged; independent replay and three generated schema checks
confirm standalone records require delivery/v1 while embedded references omit it. Earlier affected1218/1218 and full1967-pass results
below are historical checkpoints. Current evidence is recorded in
[verification-summary.json](verification-summary.json) under latestQualification.

PASS describes the bounded offline invariant at the stated layer, not live model
performance. Historical line numbers identify the inspected checkpoint; test names
and assertions are durable evidence. Tests use disposable state and fake providers.
The separate accepted native smoke/staged code-only trial and isolated UI readiness
are recorded in [implementation-status.md](implementation-status.md); neither
establishes comparative L6 qualification.

The whole-objective V14 gate is conservative bounded coverage. Pre-admitted
successor rebasing, product-writing scoped verifiers, real auditor-role provider
overlap, rejected-provider-close eventual recovery and live cost/quality/throughput
are not established by this matrix. Additive committed DDL is preserved, not
transactionally rolled back.

| ID | Result | Concrete assertion evidence and limit |
| --- | --- | --- |
| V01 | PASS | delivery-contracts.test.js:96,103 reject completed/active edits; backlog-store.test.js:288 pins original contract/context and gives retry a distinct attempt/context. |
| V02 | PASS | delivery-contracts.test.js:69 rejects self/missing/cycle references; backlog-store.test.js:254 verifies unchanged revision/task/event counts after failed cycle/CAS. |
| V03 | PASS | backlog-store.test.js:146,214 use two connections/worker claimers and assert one task claim plus project/role limits. |
| V04 | PASS | backlog-store.test.js:382,396 assert event failure rolls back claim/terminal state and capacity; task-executor.test.js:168 duplicate terminal settlement and delivery-events.test.js:15 persisted dedupe/cursors. |
| V05 | PASS | delivery-contracts.test.js:96,103 and backlog-store.test.js:505,627 stale CAS/owner corrections cannot overwrite active/completed contracts; atomic rollback asserted. |
| V06 | PASS | task-scheduler.test.js:50 holds four distinct engineer execute calls and active claims with fifth refused; backlog-store.test.js:288 and task-executor.test.js:59,242 pin distinct attempt/context/thread contracts. Real two-writer provider overlap is additionally asserted by delivery-role-service.test.js:182. Four real model turns are not claimed. |
| V07 | PASS | task-scheduler.test.js:71 asserts D claimed while B remains live; concurrent-delivery-engine.test.js:395 and matched comparison assert actual dependent publication before slow sibling release. |
| V08 | PASS | L1/L2 composition: task-resource-policy.test.js:44 permits two read-only auditors in shared mode, candidate-review.test.js:122 gives distinct reviewer identities and independent scopes; delivery-verifier-integration.test.js:493 actually holds two scoped reviews concurrently while writer admission stays held. The last fixture uses verifier roles, not two real auditor provider turns. |
| V09 | PASS | candidate-review.test.js:207 scheduler calls only verifier before dependent auditor; :454 asserts independent checkpoint has no dependencies and can review together. |
| V10 | PASS | project-delivery-controller.test.js:94 commits successor while actual executor send remains held and capacity active; engine :395 adds dependent after predecessor publication while slow sibling lives. No all-worker collect barrier. |
| V11 | PASS | task-scheduler.test.js:50 leaves reserved lead capacity; controller :94 actually plans while worker held; :565 enforces project-wide planner reservation across objectives/sessions. |
| V12 | PASS | task-scheduler.test.js:107,122 asserts typed role/pause/unknown idle and no repeated executor calls; controller :182 and V43 assert idle cycles add no model calls. |
| V13 | PASS | task-scheduler.test.js:107 applies role subsets; candidate-review.test.js:454 explicit verifier/auditor graph vs independent checkpoint; planner.test.js:31 and engine comparison create different bounded task DAGs. Scripted policy flexibility, not live model plan quality. |
| V14 | PASS (bounded L1/L2) | test/owner-decision.test.js enforces named investigated requests, direct public admission/resume/finalization gates, exact pins, duplicates and control precedence. test/owner-decision-restart.test.js closes/reopens actual host/SQLite while the same run waits, then requires authenticated reply, verifier, mandatory checks and durable acceptance; also tests explicit replacement with immutable original evidence and drift/unavailable refusal. Protocol delta review20/20 and boundary challenge3/3 passed, but the full run returned completed before the fresh run reached its expected owner question. Real capacity contention reproduced premature review insertion before initial planning. The engine now waits for durable planner wake consumption; independent ordering review20/20 plus correction7/7 and repaired frozen full qualification pass. Whole-objective gating is bounded, not selective obligation deferral. |
| V15 | PASS | controller.test.js:478 failed actual executor work prompts one bounded investigation turn; backlog-store.test.js:804 and task-executor.test.js:560 preserve claimability of unrelated sibling after scoped recovery exhaustion. V43 adds composed investigation/repair/acceptance. |
| V16 | PASS (bounded L2) | test/candidate-review.test.js retries one failed review verdict with distinct task/attempt for the same candidate/check/manifest. Successful sibling and failed receipt histories remain byte-identical; newer candidate is not qualified. Independently reviewed, focused20/20. This is not provider/process crash recovery. |
| V17 | PASS | backlog-store.test.js:776 explicitly exhausts hyp-1/fix-1, selects distinct hyp-2/fix-2 and then blocks bounded exhausted recovery; lifecycle.test.js:197 and controller :501 assert technical blockage/no repeated model calls. Live model strategy quality excluded. |
| V18 | PASS | candidate-review.test.js:122 creates G+1 after preparing G and asserts frozen input still contains G bytes; settled receipt remains candidate-g. |
| V19 | PASS | delivery-review-policy.test.js:24 and candidate-review.test.js:255,454 reject changed/unknown attested closure, environment and checks. Read-manifest evidence, not allowedFiles alone, governs promotion. |
| V20 | PASS | candidate-review.test.js:454 promotes after unrelated b.txt edit while original receipt remains G, and reopens to check qualification; :299 preserves original promotion record on replay. |
| V21 | PASS (safety invariant) | delivery-role-capabilities.test.js:137 rejects product-path/candidate drift; candidate-review.test.js:122 rejects tampered frozen input; delivery-acceptance.test.js:116 rejects check-modified candidate. Engineer publication/new candidate gets new review in engine :395. New scoped verifier is deliberately source-read-only; these prove prevention of self-certification, not a product-writing verifier feature. Legacy lead-graph.test.js:2379 separately covers verifier test-write target handling. |
| V22 | PASS | candidate-store.test.js:91,174,235 reject escapes/stale bases and preserve unattributed owner edits; output-artifacts.test.js:247,269 reject undeclared output/base drift before publication. |
| V23 | PASS | backlog-store.test.js:870 fences real publication at final barrier and runs real frozen acceptance; :1028 invalidates later candidate; delivery-acceptance-join.test.js:127,197,302 require exact pins/serialized checks/current control. |
| V24 | PASS | controller.test.js:272,286,310 holds admission/turn/send at pause boundaries; scheduler :316 blocks claimed no-intent send while allowing admitted settlement; executor :320,339 preserve truthful terminal evidence. |
| V25 | PASS | executor.test.js:188 and backlog-store.test.js:851 reject late successful cancellation settlement; output-artifacts :207 plus candidate store control checks fence publication after correction/takeover. |
| V26 | PASS | lifecycle.test.js:40,70,89 require due time/literal eligibility/current pins and preserve later owner pause; backlog-store.test.js:753 preserves provider/model and refuses stale wake authority. |
| V27 | PASS (layered) | executor.test.js:59,140,153,168 dispatch/context/terminal windows; candidate-store.test.js:188,258,270 before/after/partial apply and replay; acceptance-join.test.js:224,251,266 ready/checking/unknown reopen; atomic event/cursor tests cover durable consumption. Injected effects/identities in module tests are intentional L1-L3 seams, not live-provider evidence. |
| V28 | PASS | executor.test.js:413,425,441 fans shared transport failure to siblings, retains claims and prevents later sends; explicit terminal source shutdown disposition remains subject to final independent gate. |
| V29 | PASS | backlog-store.test.js:325 retains expired live/unknown capacity; controller.test.js:400 restart keeps uncertain live process fenced; role-service terminal probes demand original group death. No lease-expiry retry permission is inferred. |
| V30 | PASS | role-overrides.test.js:43,50,83,109,134,149 asserts capacity values/default propagation, old JSON atomic round-trip and invalid rejection; role-catalog tests assert 4/2/2/2 defaults. |
| V31 | PASS | launcher-role-page.test.js:74,101 asserts inherited/explicit effort display and null serialization/profile propagation; role-overrides:89 and model-capabilities normalization retain selected model effort metadata. |
| V32 | PASS | role-model-capabilities.test.js requires explicit advertised canonical fast tier, rejects misleading negative description/ambiguity/unknown; delivery-role-service.test.js:164 and codex-app-server request tests assert effective Fast provenance/request tier. |
| V33 | PASS (offline) | role model/override/UI tests retain configured/inherited selections while unknown Fast is disabled; launcher account refresh UI tests:43,62 reject stale responses/errors. Reused independently accepted role/settings/cache review. Credentials/entitlement and live throughput are not qualified. |
| V34 | PASS | controller.test.js:94,125,144 requires durable acknowledgement/application before next claim; V43 actual authenticated HTTP status/steering runs while investigator held, including invalid token/stale revision rejection. |
| V35 | PASS (truthful known/unknown causes) | visibility.test.js:24,49,91,116 asserts dependency/control/capacity/readiness projections, unknown trusted checkpoint acceptance and session-only planner attribution; backlog-ui.test.js:30,87,132 renders known/unknown reasons and discards stale scope responses. Runtime locks not exposed are explicitly unknown, not invented facts. |
| V36 | PASS (host/store composition) | migration-qualification.test.js:130 holds first host publisher and runs independent second DB/workspace publisher before release; backlog-store.test.js:451 independent project capacities and controller planner scope tests establish isolation. No global project mutex. |
| V37 | PASS | migration-qualification.test.js:130 actual symlink alias second startup fails while separate workspace progresses; existing server/writer workspace-lock tests retain common-Git-dir exclusion. |
| V38 | PASS | e2e.test.js preserved same-workspace interrupted snapshot/resume and one total writer call; router/server legacy-default tests retain durable mappings; old role override JSON round-trip remains covered. Qualification review independently checked repaired legacy fixtures. |
| V39 | PASS (bounded L3) | test/delivery-migration-qualification.test.js preserves pending claims/evidence before/after committed additive ALTER and SQLite reopen. Terminal safe drain/reconciliation and same-host late-close retry have independent approval/challenge. Independent final inspection confirms retained DB/workspace ownership through timeout, exact original-group death before release, failure-only no publication, released reopen preserving old mappings and fresh legacy intake. Final frozen full verification passed1967 tests with1 prohibited skip and no failures; transactional DDL rollback is not claimed. |
| V40 | PASS (preventative exclusion) | migration-qualification.test.js:130,180 real router refuses opposite-engine intake before mapping/provider invocation while publisher held; server persisted-state/unknown-selection fixtures prevent unsafe mixed restart. Forced fixture teardown is not safe-close evidence. |
| V41 | PASS (bounded comparison) | Independent qualification-review.md plus comparison.test.js: actual legacy/concurrent matched DAG/check contract, held barriers, dependent publication before concurrent slow release vs legacy after release, exact accepted output/check stdout equality. Dependent is admitted later in both paths; pre-admitted base rebasing remains unsupported by this proof. No speed/cost ratio. |
| V42 | PASS (bounded L2/L4) | test/delivery-visibility.test.js and test/launcher-backlog-ui.test.js assert backlog/writer/provider/settlement processing intervals and preserve null for missing, invalid or ambiguous endpoints/tokens. Independent focused review17/17 includes four challenger probes. Intervals can overlap and are not exclusive idle partitions or live latency measurements. |
| V43 | PASS (offline only) | cn15-recovery/review/decision.md independently ran real composed failure/investigation/distinct repair/current-candidate verifier/mandatory checks/durable acceptance with held authenticated status/steering and no owner decision reply. Frozen affected includes this unchanged test and current engine. L6 excluded. |


## Reviewed startup followup

The inherited legacy workspace-write startup and diagnostics followup has scoped
independent approval. A host-owned capability maps the admitted private lane while
preserving native policy and existing verifier IPC behavior; unsupported modern
profiles remain denied. Preflight route metadata is explicitly non-callable.
The current frozen affected1218/1218 and full1967 passed /0 failed /1 prohibited
skip have identical manifests and no drift. Earlier matrix evidence remains
reused for unchanged bounded invariants; this is not a new live-model trial or
proof that the old paused legacy task repaired itself. Current source hashes and
scoped review references are in verification-summary.json.
