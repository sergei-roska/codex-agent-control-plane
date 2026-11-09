# Multi-check finalization authorization diagnosis

Verdict: INCONCLUSIVE for native target acceptance; concrete order-only source defect confirmed.

Read readonly retained backup runner/55090d5b-c1a7-4e2e-9e41-d4635272eec7.state.sqlite and current source. Native static verifier passed and persisted a proof with all three required host checks passed. No backlog_finalizations row exists. The first authorization checkpoint predicate compares canonical(checkpoint.checkPins) against canonical(run.contract.requiredChecks.map(id)) order-sensitively.

Actual persisted checkpoint pins are [dccourts-182-composer-project-validate, dccourts-182-composer-relock, dccourts-182-upstream-kernel]. Intake contract order is [dccourts-182-upstream-kernel, dccourts-182-composer-relock, dccourts-182-composer-project-validate]. Independent readonly comparison: exact arrays unequal, sorted copies equal, each has three unique entries. Checkpoint registration normalizes pin order, while contract intentionally retains execution order. Thus finalization is refused before creating its first row despite exact required-check membership. One-check synthetic coverage cannot expose this discrepancy. No-change initial candidate authorization is not the cause established by this evidence.

Secondary comparator checked: BacklogStore finalization request normalization copies requiredCheckIds without sorting; validateAcceptanceContract preserves required check order. Therefore request.requiredCheckIds still follows contract order in this path. Do not unnecessarily change that predicate or stored request/contract digests.

Minimal repair: compare checkpoint check IDs with contract check IDs using nonmutating sorted-copy exact multiset equality. Preserve duplicate/cardinality enforcement and every remaining owner/control/profile/environment/candidate/current-tree/fence/receipt/check-proof gate. Preserve contract execution order and complete contract digest. Regression should use at least three deliberately nonlexical check IDs through real finalization and prove mismatched membership/duplicate/subset/extra pin declarations cannot authorize finalization. No database rewrite, finalization bypass, forced acceptance or task replay is warranted.

No provider call, source edit or state mutation performed. Root/worker independently converged on the same predicate defect; code review remains pending frozen repair.

Status: complete for diagnosis.
Scope expansion: none
