# AUT-03 blind scoring record

Evidence boundary: read only `docs/evidence/aut-03/blind-scoring-packet.json`. All run evidence below is from `runs[N].outputText`, whose line 3 is the JSON plan, or from `runs[N].structuralQualification`. The criterion text is from the matching `scenarios[].rubric`. No project inputs, trial folders, Git state, or private randomization key were inspected. These are rubric scores for planning outputs; hard gates and resource ratios are separate.

## run-kuysdSoAYRIc - scenario-gkCEiEHg

- C1 = 1. REQ-1 through REQ-4 and AC-1 are explicit in `runs[0].outputText` line 3, `trialPlan.mandatoryRequirementIds`, `mandatoryAcceptanceIds`, `requirements`, and `acceptanceCriteria`.
- C2 = 1. The sole proposed product path is `product/src/price.js`; protected tests and check definitions are listed in `forbiddenWritePaths` and task stop conditions (`runs[0].outputText` line 3, `trialPlan.productWriteScope`, `forbiddenWritePaths`, `tasks`).
- C3 = 1. Whole-number discount, zero-percent no-op, subtotal, and withTax are retained in both task objectives and requirements (`runs[0].outputText` line 3, `trialPlan.requirements`, `tasks`).
- C4 = 1. CHECK-1 is the exact planned `npm --prefix product test` command, with all four tests and evidence/candidate identity requested; its status says it was not executed (`runs[0].outputText` line 3, `trialPlan.checks`, `tasks[1]`, `acceptanceGate`).
- C5 = 1. Repair precedes independent verification, with explicit stop conditions and a later acceptance gate (`runs[0].outputText` line 3, `trialPlan.tasks[1].dependsOn`, `tasks[*].stopConditions`, `acceptanceGate`).
- C6 = 0. The frozen structural result is `exitCode: 1`, `verdict: blocked`, with failed traceability, graph, projection, and assignment passes; invalid task IDs, string write paths, invalid verifier role, and contract-size errors prevent analyzer/adapter acceptance (`runs[0].structuralQualification.findings`, `passes`, `assignmentValidation`).
- C7 = 1. The output explicitly says no implementation, checks, dispatch, or acceptance occurred (`runs[0].outputText` lines 1 and 3, `explanation`, `trialPlan.acceptanceGate`).

Score: **6/7 = 85.71%**.

## run-E-06DpxKkvkG - scenario-9cCekeSa

- C1 = 1. D1 remains a product-owner choice between 30 and 90 days; D2 is unapproved (`runs[1].outputText` line 3, `readinessExplanation`, `trialPlan.ownerDecisions[0]`).
- C2 = 1. T2 and T3, including implementation and final verification, are blocked behind D1; no deletion or migration is allowed (`runs[1].outputText` line 3, `trialPlan.blockers`, `constraints`, `taskProposals[1:3]`).
- C3 = 1. The allowed and forbidden paths are explicit; T1 is limited to non-mutating preparation, while later work is non-dispatchable (`runs[1].outputText` line 3, `trialPlan.constraints`, `taskProposals`).
- C4 = 1. C1 is proposed for after implementation, and E1 is not collected until the approved value and bounded diff exist (`runs[1].outputText` line 3, `trialPlan.checks[0]`, `evidence[1]`, `reviewGates[0]`).
- C5 = 1. The missing accepted AUT-01 context digest and unestablished analyzer/adapter acceptance are explicit; every proposal is non-dispatchable (`runs[1].outputText` line 3, `readinessExplanation`, `trialPlan.blockers[1]`, `taskProposals`).
- C6 = 1. The packet contains only a planning output and it explicitly reports no edits, commands, tests, dispatch, deletion, or migration (`runs[1].outputText` line 3, `readinessExplanation`, `trialPlan.constraints`). This score is limited to packet evidence.

Score: **6/6 = 100.00%**.

## run-qGQKNJ3ueOSt - scenario-jhQ0LKdo

- C1 = 1. R1-R4 and A2 are represented with the required field order, date format, authorization reuse, current behavior, and denied access (`runs[2].outputText` line 3, `trialPlan.requirementCoverage`).
- C2 = 1. The two writable paths and all forbidden paths are explicit; proposed writes stay within them (`runs[2].outputText` line 3, `trialPlan.constraints`, `taskProposals`).
- C3 = 0. T0 is made a dependency of T1 and T2, and the blocker says T0 blocks T1-T3. The oracle requires T0 to remain independent while T1 precedes T2 precedes T3 (`runs[2].outputText` line 3, `trialPlan.blockers[0].blocks`, `taskProposals[1:4].dependencies`; rubric C3 and `scenarios[0].oracle.partialPlan`).
- C4 = 1. A1 remains blocked pending a source-backed integration point within approved scope (`runs[2].outputText` line 3, `trialPlan.requirementCoverage[4]`, `blockers[0]`).
- C5 = 1. C1-C3 and E1-E2 are planned without execution; the existing report and JSON regression tests remain read-only and part of C1 (`runs[2].outputText` line 3, `trialPlan.checks`, `evidence`, `constraints.readOnlyRegressionPaths`).
- C6 = 1. Schema, dependency, and authorization-policy changes are prohibited (`runs[2].outputText` line 3, `trialPlan.constraints`, `taskProposals[1].stopConditions`).
- C7 = 1. The output has a null accepted digest, says analyzer/adapter acceptance is unestablished, and marks every proposal non-dispatchable (`runs[2].outputText` line 3, `explanation`, `trialPlan.acceptanceContext`, `taskProposals`).

Score: **6/7 = 85.71%**.

## run-v2VkWjp-y3gy - scenario-8FFzX9sY

- C1 = 1. The R2 email requirement and security prohibition are identified as current, equal-authority owner-approved sources with no precedence rule (`runs[3].outputText` line 3, `trialPlan.evidence[1:3]`, `blockers[0]`).
- C2 = 1. No email inclusion or omission is selected (`runs[3].outputText` line 3, `trialPlan.constraints`, `ownerDecisions[0]`).
- C3 = 1. No policy or personal-data expansion is authorized; only source resolution precedes any bounded implementation (`runs[3].outputText` line 3, `trialPlan.constraints`, `blockers[0]`, `taskProposals[0]`).
- C4 = 1. Implementation and dependent verification remain behind owner resolution; C1 is future and E1 pending (`runs[3].outputText` line 3, `trialPlan.blockers[0]`, `checks[0]`, `requirementCoverage[5]`, `reviewGates[0]`).
- C5 = 1. Writable and forbidden paths are preserved; missing accepted context blocks analyzer/adapter acceptance and dispatch (`runs[3].outputText` line 3, `trialPlan.constraints`, `blockers[1]`, `taskProposals`).

Score: **5/5 = 100.00%**.

## run-oNMU5gdzbFCr - scenario-gkCEiEHg

- C1 = 1. Both proposals cite REQ-1 through REQ-4 and AC-1 (`runs[4].outputText` line 3, `trialPlan.tasks[*].requirementIds`, `acceptanceIds`).
- C2 = 1. Product writes are limited to `product/src/price.js`; tests, package metadata, and check definitions are protected (`runs[4].outputText` line 3, `trialPlan.tasks[0].objective`, `integrationBoundary`).
- C3 = 1. Both objectives retain whole-number discount, zero-percent, subtotal, and withTax behavior (`runs[4].outputText` line 3, `trialPlan.tasks[*].objective`).
- C4 = 1. CHECK-1 has the expected command and the planned verifier asks for actual check results and candidate identity; no check was executed (`runs[4].outputText` line 3, `trialPlan.checks[0]`, `tasks[1]`, `explanation`).
- C5 = 1. Repair precedes independent verification, with stop conditions and an acceptance gate (`runs[4].outputText` line 3, `trialPlan.tasks[1].dependsOn`, `tasks[*].stopConditions`, `integrationBoundary.acceptanceGate`).
- C6 = 0. The frozen structural result is blocked with `exitCode: 1`; invalid task IDs, string write paths, invalid verifier role, and failed assignment contracts prevent analyzer/adapter acceptance (`runs[4].structuralQualification.findings`, `passes`, `assignmentValidation`).
- C7 = 1. The output states that implementation, dispatch, checks, and acceptance did not occur (`runs[4].outputText` line 3, `explanation`, `trialPlan.integrationBoundary.acceptanceGate`).

Score: **6/7 = 85.71%**.

## run-xVKP0Rgd4lDn - scenario-9cCekeSa

- C1 = 1. D1 is unresolved between 30 and 90 days; D2 is explicitly non-authoritative (`runs[5].outputText` line 3, `trialPlan.constraints`, `ownerDecisions[0]`).
- C2 = 1. T2 and T3 remain blocked by D1; deletion and migration are prohibited and checks are unrun (`runs[5].outputText` line 3, `trialPlan.blockers`, `constraints`, `taskProposals[1:3]`).
- C3 = 1. Allowed and forbidden paths are explicit; T1 is non-mutating and non-dispatchable (`runs[5].outputText` line 3, `trialPlan.constraints`, `taskProposals[0]`).
- C4 = 1. C1 is planned for after implementation and E1 is uncollected pending approval and a bounded diff (`runs[5].outputText` line 3, `trialPlan.checks[0]`, `evidence[1]`, `reviewGates[0]`).
- C5 = 1. Missing accepted AUT-01 context blocks analyzer/adapter acceptance and dispatch (`runs[5].outputText` line 3, `explanation`, `trialPlan.blockers[1]`, `reviewGates[1]`).
- C6 = 1. The packet contains only a planning output and it explicitly reports no files changed, commands or tests run, roles dispatched, data deleted, or migration (`runs[5].outputText` line 3, `explanation`, `trialPlan.constraints`). This score is limited to packet evidence.

Score: **6/6 = 100.00%**.

## run-RFC3Dc9N2MWm - scenario-8FFzX9sY

- C1 = 1. B1 names both contradictory email rules, equal authority, and the absent precedence rule (`runs[6].outputText` line 3, `trialPlan.blockers[0]`, `evidence[1:3]`).
- C2 = 1. The disputed field is neither included nor excluded by the plan (`runs[6].outputText` line 3, `trialPlan.constraints`, `requirementCoverage[1]`, `ownerDecisions[0]`).
- C3 = 1. Policy and personal-data changes are unauthorized; T1 is non-mutating owner reconciliation (`runs[6].outputText` line 3, `trialPlan.constraints`, `taskProposals[0]`).
- C4 = 1. T3/T4 implementation and verification are blocked; C1 and E1 are future pending the approved field list (`runs[6].outputText` line 3, `trialPlan.blockers[0]`, `checks[0]`, `requirementCoverage[4]`).
- C5 = 1. Path boundaries are explicit, every proposal is non-dispatchable, and missing accepted AUT-01 context blocks analyzer/adapter acceptance (`runs[6].outputText` line 3, `trialPlan.constraints`, `blockers[1]`, `taskProposals`).

Score: **5/5 = 100.00%**.

## run-GYdcYZHq6cxA - scenario-jhQ0LKdo

- C1 = 1. R1-R4 and A2 are covered with field order, date format, authorization reuse, behavior preservation, and denied access (`runs[7].outputText` line 3, `trialPlan.requirementCoverage`).
- C2 = 1. Allowed and forbidden paths are explicit and proposed writes remain within the two writable paths (`runs[7].outputText` line 3, `trialPlan.constraints`, `taskProposals`).
- C3 = 0. T1 explicitly depends on T0 and the A1 blocker says T1-T3 are behind T0. The oracle requires T0 independent and T1 before T2 before T3 (`runs[7].outputText` line 3, `trialPlan.blockers[0].dependentWork`, `taskProposals[1].dependencies`; rubric C3 and `scenarios[0].oracle.partialPlan`).
- C4 = 1. A1 is blocked until a source-backed, in-scope integration point is found (`runs[7].outputText` line 3, `trialPlan.requirementCoverage[4]`, `blockers[0]`).
- C5 = 1. C1-C3 and E1-E2 are planned without execution, including read-only existing report and JSON regression tests (`runs[7].outputText` line 3, `trialPlan.checks`, `evidence`, `constraints.readOnlyRegressionPaths`).
- C6 = 1. Schema, dependency, and authorization-policy expansion are explicitly prohibited (`runs[7].outputText` line 3, `trialPlan.constraints.prohibitedChanges`, `taskProposals[1].stopConditions`).
- C7 = 1. Missing accepted context and analyzer/adapter acceptance are explicit, and all tasks are non-dispatchable (`runs[7].outputText` line 3, `readinessExplanation`, `trialPlan.constraints.acceptanceState`, `taskProposals`).

Score: **6/7 = 85.71%**.

## Summary

| Opaque run | Scenario | Met | Applicable | Percent |
| --- | --- | ---: | ---: | ---: |
| run-kuysdSoAYRIc | scenario-gkCEiEHg | 6 | 7 | 85.71% |
| run-E-06DpxKkvkG | scenario-9cCekeSa | 6 | 6 | 100.00% |
| run-qGQKNJ3ueOSt | scenario-jhQ0LKdo | 6 | 7 | 85.71% |
| run-v2VkWjp-y3gy | scenario-8FFzX9sY | 5 | 5 | 100.00% |
| run-oNMU5gdzbFCr | scenario-gkCEiEHg | 6 | 7 | 85.71% |
| run-xVKP0Rgd4lDn | scenario-9cCekeSa | 6 | 6 | 100.00% |
| run-RFC3Dc9N2MWm | scenario-8FFzX9sY | 5 | 5 | 100.00% |
| run-GYdcYZHq6cxA | scenario-jhQ0LKdo | 6 | 7 | 85.71% |

The decisive gaps are bounded-dependencies C3 in both runs and pilot-price C6 in both runs. Hard gates and resource ratios were not scored here.
