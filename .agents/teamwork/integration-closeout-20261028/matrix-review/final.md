# Independent final offline V01-V43 acceptance

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Acceptance is for CN-14/CN-15 bounded offline source qualification only. All43
criteria PASS within the explicit layer/capability limits below. L6/live rollout,
provider speed/cost/quality and runtime activation remain unqualified.

## Frozen verification and integrity

Read the actual final JSON reports/TAP and independently recomputed every captured
input hash: affected923/923 and full1961 total/1960 pass/0 fail/0 cancel/1 prohibited
skip, both exit0/no timeout/no input drift. Affected/full input maps are identical.
All inputs matched actual files before documentation closeout. Subsequent changes
are only the seven durable closeout documents, recording these results. Independently
checked all348 verification-summary sourceFiles against current files and the full
manifest: zero mismatches. No new broad suite was run by this reviewer.

The exact prohibited-test exclusion appears in both final commands. The failed
full baseline remains verification-full-v14-race.json/tap (1959 pass/1 fail/1 skip),
and earlier timeout remains retained. Neither is reclassified as passing or an
environment issue. The failure led to the reproduced ordering repair: automatic
review creation must wait for the initial planner's durable wakeup consumption.

Independently ran V14 protocol/restart20/20, ordering/restart20/20 and correction7/7
at their reviewed inputs; reports in owner-decision-20261028/review/{delta,race-delta}.md.
Current engine SHA-2562127846c213efa5db796fb615656a6ffa3db8c70a5cd874eceefa72c3e238949
and restart test a6b83625173e10556ef8657f4efd903d3f8371570658f00854ba15c78243bb1d
match repaired broad manifests. Other current source/test hashes are in the frozen
reports and durable verification-summary. No removed verification, trivialized
assertions, hardcoded production answers or swallowed failures were found in the
reviewed corrections. Earlier bounded evidence is reused only with current frozen
affected/full requalification of its consumers.

Final report hashes (SHA-256):

    0b61be741966692b37500af676729914daf95c5a48d1def58137a5a5a96b48ce verification-affected.json
    91fba838ef79e5fafac48aa4683d23336363964f326a38f7a2793b6cf458bc5c verification-full.json
    9dea37539dbe4cd27c383b5a2998cbd5a86ef933ef3b47c97c34ab7738206e09 verification-full-v14-race.json

Durable implementation-status, qualification-matrix, verification-summary, backlog,
knowledge graph, activation and foundation API now consistently distinguish accepted
offline source from unqualified L6/runtime. Backlog has no active CN14 source package;
remaining CN15-L6 followup requires separate authority. Historical pending/failure
entries are explicitly superseded rather than deleted.

## Criteria

PASS applies to the stated bounded offline invariant/layer, including composed
module evidence where appropriate. It does not advertise unsupported capabilities.

| ID | Result | Acceptance criterion | Evidence and limit |
| --- | --- | --- | --- |
| V01 | PASS | Task IDs survive plan revisions; running revision/contract remains immutable | delivery-contracts.test.js:96,103 reject completed/active edits; backlog-store.test.js:288 pins original contract/context and gives retry a distinct attempt/context. |
| V02 | PASS | Dependency cycle, missing reference and self-edge are rejected without partial rows/events | delivery-contracts.test.js:69 rejects self/missing/cycle references; backlog-store.test.js:254 verifies unchanged revision/task/event counts after failed cycle/CAS. |
| V03 | PASS | Two simultaneous claimers obtain one attempt for a ready task; total/role capacity holds | backlog-store.test.js:146,214 use two connections/worker claimers and assert one task claim plus project/role limits. |
| V04 | PASS | Completion/state/event commit rolls back together on failure; duplicate event yields one dependent wakeup | backlog-store.test.js:382,396 assert event failure rolls back claim/terminal state and capacity; task-executor.test.js:168 duplicate terminal settlement and delivery-events.test.js:15 persisted dedupe/cursors. |
| V05 | PASS | Stale planner delta cannot overwrite owner revision, completed task or updated dependency | delivery-contracts.test.js:96,103 and backlog-store.test.js:505,627 stale CAS/owner corrections cannot overwrite active/completed contracts; atomic rollback asserted. |
| V06 | PASS | Configured four engineers start distinct task/context/thread instances within available capacity | task-scheduler.test.js:50 holds four distinct engineer execute calls and active claims with fifth refused; backlog-store.test.js:288 and task-executor.test.js:59,242 pin distinct attempt/context/thread contracts. Real two-writer provider overlap is additionally asserted by delivery-role-service.test.js:182. Four real model turns are not claimed. |
| V07 | PASS | Ready task D starts after quick A completes while unrelated slow B is still running | task-scheduler.test.js:71 asserts D claimed while B remains live; concurrent-delivery-engine.test.js:395 and matched comparison assert actual dependent publication before slow sibling release. |
| V08 | PASS | Two independent auditors overlap with distinct identities, even when writer isolation is shared | L1/L2 composition: task-resource-policy.test.js:44 permits two read-only auditors in shared mode, candidate-review.test.js:122 gives distinct reviewer identities and independent scopes; delivery-verifier-integration.test.js:493 actually holds two scoped reviews concurrently while writer admission stays held. The last fixture uses verifier roles, not two real auditor provider turns. |
| V09 | PASS | Auditor for checkpoint C waits for C's passing verifier; independent checkpoint D has no invented edge | candidate-review.test.js:207 scheduler calls only verifier before dependent auditor; :454 asserts independent checkpoint has no dependencies and can review together. |
| V10 | PASS | Lead adds successor tasks while workers run; no collection barrier is used | project-delivery-controller.test.js:94 commits successor while actual executor send remains held and capacity active; engine :395 adds dependent after predecessor publication while slow sibling lives. No all-worker collect barrier. |
| V11 | PASS | Busy worker slots cannot consume reserved lead capacity; useful planning can run | task-scheduler.test.js:50 leaves reserved lead capacity; controller :94 actually plans while worker held; :565 enforces project-wide planner reservation across objectives/sessions. |
| V12 | PASS | No independent ready work produces a clear reason, no fabricated tasks or model-poll loop | task-scheduler.test.js:107,122 asserts typed role/pause/unknown idle and no repeated executor calls; controller :182 and V43 assert idle cycles add no model calls. |
| V13 | PASS | Lead can choose different role subsets and pipeline graphs for a small fix and parallel feature | task-scheduler.test.js:107 applies role subsets; candidate-review.test.js:454 explicit verifier/auditor graph vs independent checkpoint; planner.test.js:31 and engine comparison create different bounded task DAGs. Scripted policy flexibility, not live model plan quality. |
| V14 | PASS (bounded L1/L2) | Routine reversible choice is resolved internally; named owner-required acceptance remains mandatory | Independent protocol delta20/20, store boundary challenge3/3, ordering delta20/20 + correction7/7. Strict investigated durable gate, exact authenticated current-pin reply/replacement, duplicates before stale checks, pause/stop/cancel precedence, no effect authority grant. Same-run real host/SQLite reopen preserves request/pins with no model resend, then requires owner reply/verifier/mandatory checks/durable acceptance. Contended initial planner regression proves planRevision0/empty tasks until wake consumption. Whole-objective gating, not selective obligation deferral. |
| V15 | PASS | Failed worker creates investigation/repair/replan while unrelated ready work progresses | controller.test.js:478 failed actual executor work prompts one bounded investigation turn; backlog-store.test.js:804 and task-executor.test.js:560 preserve claimability of unrelated sibling after scoped recovery exhaustion. V43 adds composed investigation/repair/acceptance. |
| V16 | PASS (bounded L2) | A failed reviewer retries only its valid scope/candidate; successful sibling receipt persists | test/candidate-review.test.js retries one failed review verdict with distinct task/attempt for the same candidate/check/manifest. Successful sibling and failed receipt histories remain byte-identical; newer candidate is not qualified. Independently reviewed, focused20/20. This is not provider/process crash recovery. |
| V17 | PASS | Same failed hypothesis twice triggers a different plan; exhausted internal recovery stays resumable technical blockage | backlog-store.test.js:776 explicitly exhausts hyp-1/fix-1, selects distinct hyp-2/fix-2 and then blocks bounded exhausted recovery; lifecycle.test.js:197 and controller :501 assert technical blockage/no repeated model calls. Live model strategy quality excluded. |
| V18 | PASS | Reviewer reads frozen candidate G even while independent writer publishes G+1; receipt names G | candidate-review.test.js:122 creates G+1 after preparing G and asserts frozen input still contains G bytes; settled receipt remains candidate-g. |
| V19 | PASS | Changed/unknown dependency/read manifest prevents promotion to G+1; allowedFiles alone cannot establish independence | delivery-review-policy.test.js:24 and candidate-review.test.js:255,454 reject changed/unknown attested closure, environment and checks. Read-manifest evidence, not allowedFiles alone, governs promotion. |
| V20 | PASS | Unchanged validated input closure permits receipt reuse; historical receipt identity is never rewritten | candidate-review.test.js:454 promotes after unrelated b.txt edit while original receipt remains G, and reopens to check qualification; :299 preserves original promotion record on replay. |
| V21 | PASS (safety invariant) | Verifier-created test/check change creates new candidate and cannot self-certify old target | delivery-role-capabilities.test.js:137 rejects product-path/candidate drift; candidate-review.test.js:122 rejects tampered frozen input; delivery-acceptance.test.js:116 rejects check-modified candidate. Engineer publication/new candidate gets new review in engine :395. New scoped verifier is deliberately source-read-only; these prove prevention of self-certification, not a product-writing verifier feature. Legacy lead-graph.test.js:2379 separately covers verifier test-write target handling. |
| V22 | PASS | Concurrent owner edits, escaping patch, scope violation and stale base are refused or reconciled accurately | candidate-store.test.js:91,174,235 reject escapes/stale bases and preserve unattributed owner edits; output-artifacts.test.js:247,269 reject undeclared output/base drift before publication. |
| V23 | PASS | Final stabilization freezes one exact candidate, drains relevant publication and runs required pinned checks | backlog-store.test.js:870 fences real publication at final barrier and runs real frozen acceptance; :1028 invalidates later candidate; delivery-acceptance-join.test.js:127,197,302 require exact pins/serialized checks/current control. |
| V24 | PASS | Soft pause before/after claim prevents new work at correct control revision; active work settles | controller.test.js:272,286,310 holds admission/turn/send at pause boundaries; scheduler :316 blocks claimed no-intent send while allowing admitted settlement; executor :320,339 preserve truthful terminal evidence. |
| V25 | PASS | Explicit cancel versus integration intent has a linearized outcome; late result cannot publish after cancellation | executor.test.js:188 and backlog-store.test.js:851 reject late successful cancellation settlement; output-artifacts :207 plus candidate store control checks fence publication after correction/takeover. |
| V26 | PASS | Budget wakeup never resumes owner pause/cancel/technical blockage and never grants new authority | lifecycle.test.js:40,70,89 require due time/literal eligibility/current pins and preserve later owner pause; backlog-store.test.js:753 preserves provider/model and refuses stale wake authority. |
| V27 | PASS (layered) | Crash at every dispatch/apply window reconciles remote task/process/content before replay or capacity release | executor.test.js:59,140,153,168 dispatch/context/terminal windows; candidate-store.test.js:188,258,270 before/after/partial apply and replay; acceptance-join.test.js:224,251,266 ready/checking/unknown reopen; atomic event/cursor tests cover durable consumption. Injected effects/identities in module tests are intentional L1-L3 seams, not live-provider evidence. |
| V28 | PASS | Shared App Server termination marks every affected attempt uncertain; live siblings are not silently retried | executor.test.js:413,425,441 fans shared transport failure to siblings, retains claims and prevents later sends; terminal source final review/challenge plus current affected run qualify bounded failure-only shutdown disposition. |
| V29 | PASS | Expired claim with a still-live process keeps fence/capacity; restart cannot produce a second writer | backlog-store.test.js:325 retains expired live/unknown capacity; controller.test.js:400 restart keeps uncertain live process fenced; role-service terminal probes demand original group death. No lease-expiry retry permission is inferred. |
| V30 | PASS | Counts4/2/2/2, role defaults, per-project overrides, inherited values and old JSON survive; invalid input changes nothing | role-overrides.test.js:43,50,83,109,134,149 asserts capacity values/default propagation, old JSON atomic round-trip and invalid rejection; role-catalog tests assert 4/2/2/2 defaults. |
| V31 | PASS | Effort UI and request agree for explicit/inherited/custom/model-changed values; unsupported value is explained | launcher-role-page.test.js:74,101 asserts inherited/explicit effort display and null serialization/profile propagation; role-overrides:89 and model-capabilities normalization retain selected model effort metadata. |
| V32 | PASS | Fast off uses default turn tier; Fast on uses explicit supported identity; negative descriptions cannot imply Fast | role-model-capabilities.test.js requires explicit advertised canonical fast tier, rejects misleading negative description/ambiguity/unknown; delivery-role-service.test.js:164 and codex-app-server request tests assert effective Fast provenance/request tier. |
| V33 | PASS (offline) | Failed catalog discovery preserves configured model/effort and truthful unknown Fast; no credential leakage | role model/override/UI tests retain configured/inherited selections while unknown Fast is disabled; launcher account refresh UI tests:43,62 reject stale responses/errors. Reused independently accepted role/settings/cache review. Credentials/entitlement and live throughput are not qualified. |
| V34 | PASS | Steering message is acknowledged while workers run; priority lead turn applies correction before new relevant claims | controller.test.js:94,125,144 requires durable acknowledgement/application before next claim; V43 actual authenticated HTTP status/steering runs while investigator held, including invalid token/stale revision rejection. |
| V35 | PASS (truthful known/unknown causes) | Backlog UI explains dependency, review, budget, ownership, capacity, pause and recovery idle causes accurately | visibility.test.js:24,49,91,116 asserts dependency/control/capacity/readiness projections, unknown trusted checkpoint acceptance and session-only planner attribution; backlog-ui.test.js:30,87,132 renders known/unknown reasons and discards stale scope responses. Runtime locks not exposed are explicitly unknown, not invented facts. |
| V36 | PASS (host/store composition) | Two independent project servers/state DBs progress concurrently; pause/review of A does not park B | migration-qualification.test.js:130 holds first host publisher and runs independent second DB/workspace publisher before release; backlog-store.test.js:451 independent project capacities and controller planner scope tests establish isolation. No global project mutex. |
| V37 | PASS | Aliased/common-Git-dir workspace startup exclusion stays explicit; no new global project mutex | migration-qualification.test.js:130 actual symlink alias second startup fails while separate workspace progresses; existing server/writer workspace-lock tests retain common-Git-dir exclusion. |
| V38 | PASS | Legacy run/checkpoint and old role settings remain readable/resumable with feature disabled | e2e.test.js preserved same-workspace interrupted snapshot/resume and one total writer call; router/server legacy-default tests retain durable mappings; old role override JSON round-trip remains covered. Qualification review independently checked repaired legacy fixtures. |
| V39 | PASS (bounded L3) | Additive migration and rollback preserve pending claims/evidence; disabling engine drains/reconciles safely | Read actual host fixture server-delivery-engine.test.js:706-824: unsafe timeout retains DB and lock; one invocation/provider close; original process group absence; failure-only not_published; released reopen preserves old rows/mapping and admits fresh legacy intake. Engine test:1399 retains old/new groups across preparation reopen and refuses release until both gone. Additive ALTER preservation reviewed separately. Rejected-close eventual recovery excluded. |
| V40 | PASS (preventative exclusion) | New and legacy scheduling cannot publish concurrently to one workspace; mixed-version failure is explicit | migration-qualification.test.js:130,180 real router refuses opposite-engine intake before mapping/provider invocation while publisher held; server persisted-state/unknown-selection fixtures prevent unsafe mixed restart. Forced fixture teardown is not safe-close evidence. |
| V41 | PASS (bounded comparison) | Matched deterministic workload shows critical-path scheduling gain with equal accepted output | Independent qualification-review.md plus comparison.test.js: actual legacy/concurrent matched DAG/check contract, held barriers, dependent publication before concurrent slow release vs legacy after release, exact accepted output/check stdout equality. Dependent is admitted later in both paths; pre-admitted base rebasing remains unsupported by this proof. No speed/cost ratio. |
| V42 | PASS (bounded L2/L4) | UI/metrics separate backlog, writer, provider and settlement waits; unknown token data remains null | test/delivery-visibility.test.js and test/launcher-backlog-ui.test.js assert backlog/writer/provider/settlement processing intervals and preserve null for missing, invalid or ambiguous endpoints/tokens. Independent focused review17/17 includes four challenger probes. Intervals can overlap and are not exclusive idle partitions or live latency measurements. |
| V43 | PASS (offline only) | Objective with one recoverable failure reaches honest acceptance without an owner reply, while status/steering remain available | cn15-recovery/review/decision.md independently ran real composed failure/investigation/distinct repair/current-candidate verifier/mandatory checks/durable acceptance with held authenticated status/steering and no owner decision reply. Frozen affected includes this unchanged test and current engine. L6 excluded. |


## Review sources and limits

Reviewed reports: owner-decision-20261028/review/delta.md, review/race-delta.md and challenge/handoff.md;
reviewer-retry-20261028/review.md; wait-attribution-20261028/review-final2.md and
challenge/handoff-final.md; cn14-terminal-20261028/terminal-review-final.md,
challenge/handoff.md and qualification-review.md; integration-closeout-20261028/
terminal-cleanup-review.md; cn15-recovery-20261028/review/decision.md and
challenge/handoff.md. All paths relative to .agents/teamwork unless stated.

V14 is conservatively whole-objective gated, not obligation-selective scheduling.
V16 covers a failed review verdict after trusted execution, not process failure.
V42 intervals include processing and may overlap; absent/ambiguous/invalid values
and missing token data remain null, not fabricated zero or pure latency buckets.
V43 proves one known terminal no-write failure/investigation/distinct repair and
current-candidate checks/acceptance, not arbitrary uncertain-effect retry.
V08 uses layered distinct-reviewer/shared-policy evidence, not real auditor-role
provider overlap. V21 qualifies prevention of verifier self-certification through
source-read-only capability, not a product-writing scoped verifier feature.
V41 uses later dependent admission and deterministic barriers/equal accepted
output; pre-admitted successor rebasing and model speed/cost/quality are excluded.
V39 preserves committed additive DDL rather than rolling back an already committed
ALTER. Rejected provider-close eventual recovery remains unqualified; safe
retention on rejection is independently tested. No live provider/service/settings,
Git mutations, installs, reviewed source/tests/docs edits or prohibited test here.
Local evidence paths are ignored scratch and may disappear; durable tests and
qualification docs retain the bounded behavior.
