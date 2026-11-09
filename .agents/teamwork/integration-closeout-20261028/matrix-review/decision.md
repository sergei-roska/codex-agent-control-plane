# Independent offline V01-V43 coverage assessment

Verdict: REJECT for complete offline milestone acceptance at this checkpoint.
Blocking: V14 and V42 implementation omissions; V16 missing required verification.
Status: partial - final full and terminal review/challenge evidence pending.
Scope expansion: none

## Evidence rules and scope

This is an independent source/criterion assessment, not a new broad test run.
Read actual assertions and relevant production mechanisms. Reused the historical
cn14-facade/cn15-coverage.md only as an index, not proof of a passing gate. Read
cn14-terminal/qualification-review.md, current implementation-status.md, validation.md,
implementation-plan.md and the independent cn15-recovery/review/decision.md.

Ran earlier in this agent: V43 1/1 and strict verifier-proof/bounded controller
recovery 2/2. Those inputs were stable for that review. Root has since supplied
verification-affected.json/tap: exit 0, 896 passed, zero failures/cancellations,
no timeout or input drift, exact prohibited-filter exclusion retained. This
assessment reads that manifest; it does not falsely claim to have rerun it.
The full result and repaired terminal source independent review/challenge are
still required. Prior terminal-close acceptance cannot cover the subsequently
proven retry bug automatically. Final approval remains withheld.

PASS below means the offline invariant has attributable concrete assertions
through the intended layers, supported by predecessor review/affected checkpoint
where applicable. It does not claim all scenarios execute in one server E2E.
UNVERIFIED means a required observation or current gate is missing. FAIL means
an inspected production mechanism contradicts or omits the required behavior.
All paths are repository-relative; line references describe inspected inputs.

## Criterion matrix

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
| V14 | FAIL | lead-planner.js:230-264 accepts and stores ownerDecision only as metadata. No concurrent engine/controller consumer establishes waiting_owner or prevents final acceptance from that required decision. Mandatory verifier/check checkpoint is not an authenticated human approval gate. See gap G1. |
| V15 | PASS | controller.test.js:478 failed actual executor work prompts one bounded investigation turn; backlog-store.test.js:804 and task-executor.test.js:560 preserve claimability of unrelated sibling after scoped recovery exhaustion. V43 adds composed investigation/repair/acceptance. |
| V16 | UNVERIFIED | Existing review receipt replay/promotion/supersession tests preserve historical evidence, but no inspected test fails one reviewer, retries only its valid scope/candidate, and keeps successful sibling receipt qualified. See G2. |
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
| V39 | UNVERIFIED (final source gate) | Migration qualification independently proves preservation before/after real committed ALTER and reopen; existing server downgrade fixtures reject unsafe durable states. Positive safe drain/reconcile/reopen now has terminal source tests, but final repaired close-retry review/challenge is pending. Committed DDL rollback is not claimed or required for additive row preservation. |
| V40 | PASS (preventative exclusion) | migration-qualification.test.js:130,180 real router refuses opposite-engine intake before mapping/provider invocation while publisher held; server persisted-state/unknown-selection fixtures prevent unsafe mixed restart. Forced fixture teardown is not safe-close evidence. |
| V41 | PASS (bounded comparison) | Independent qualification-review.md plus comparison.test.js: actual legacy/concurrent matched DAG/check contract, held barriers, dependent publication before concurrent slow release vs legacy after release, exact accepted output/check stdout equality. Dependent is admitted later in both paths; pre-admitted base rebasing remains unsupported by this proof. No speed/cost ratio. |
| V42 | FAIL | delivery-visibility.js:121-151 exposes control/dependency/capacity reasons and nullable tokens; performance UI tests:164,180,192 distinguish measured/lifecycle/unknown spans only. No four-way backlog/writer/provider/settlement wait projection or rendering exists. See G3. |
| V43 | PASS (offline only) | cn15-recovery/review/decision.md independently ran real composed failure/investigation/distinct repair/current-candidate verifier/mandatory checks/durable acceptance with held authenticated status/steering and no owner decision reply. Frozen affected includes this unchanged test and current engine. L6 excluded. |

## Actionable gaps and likely ownership

G1 - V14 required owner decisions are unenforced (FAIL, read).
Mechanism checked: LeadPlanner stores metadata, engine schema allows ownerDecision,
but actual drive/finalization only examines objective/tasks/checkpoints/checks;
waiting_owner occurs in blocked-state sets without a producer from ownerDecision.
A valid turn returning a mandatory owner decision can therefore leave the run
claimable/eligible for finalization without that answer. Routine internal choices
already progress under null ownerDecision, as V43 demonstrates.
Likely owner: planner/controller/engine lifecycle worker. Add an explicit bounded,
host-owned pending decision/approval contract and authenticated scoped response;
block relevant admission/acceptance until resolved. Test required decision held
through idle/reopen, spoofed/stale response rejection, valid resolution, and null
routine case still progressing. Do not equate verifier receipt with human approval.

G2 - V16 reviewer failure/retry preservation observation absent (UNVERIFIED, read).
Mechanisms checked: candidate-review receipt replay, promotions and owner checkpoint
supersession preserve original records; these do not fail/retry one sibling reviewer.
Likely owner: scoped reviewer test worker first. Exercise exact candidate/check/
manifest scope, one completed sibling, failed second review, fresh retry identity,
no obsolete candidate acceptance, and unchanged qualified sibling receipt. Only
edit production if this probe reveals a behavior defect; keep accepted sibling
history immutable. No all-in-one host scenario is necessary for this L2 criterion.

G3 - V42 wait attribution missing (FAIL, read).
Mechanisms checked: readonly delivery visibility, Backlog rendering, performance
measured/lifecycle durations, usage queue_wait_ms and nullable token coverage.
A generic queue wait or total elapsed span cannot distinguish four wait causes.
Likely owner: visibility/performance API + UI worker. Define and expose attributable
backlog/writer/provider/settlement wait categories (unknown where not measured),
render them distinctly and test cross-category attribution/unknown preservation.
Do not fabricate zero durations or infer provider latency from lifecycle spans.

G4 - Required final gates (UNVERIFIED).
Root owns frozen affected/full verification and terminal reviewer/challenger
handoffs. Reuse 896/896 affected only while its manifest inputs remain valid.
Full result and final terminal-close retry review/challenge must precede whole
CN14/CN15 offline milestone acceptance. After G1-G3 edits rerun affected checks
for their changed inputs before reusing the full result.

## Explicit limits

No live providers, production services, account/settings changes, source/test edits,
Git mutation, or prohibited candidate-filter probe were performed here. L6 and
rollout remain unqualified. Matrix PASS entries intentionally use module composition
when their specified layer allows it; lack of a monolithic E2E is not a defect.
V08 exact auditor-role provider overlap and V21 product-writing verifier are not
claimed; current composition proves the shared scheduling/review safety invariants.
The original scenario wording must not be used to advertise unsupported writable
verifier or pre-admitted dependent-rebase behavior.

Temporary coordination and TAP evidence may disappear. The root should retain a
durable accurate status/matrix after resolving the gaps, without replacing the
historical non-green full-suite baseline with this checkpoint's affected result.
