# AUT-03 cohort 3 final decision

Decision: benefit not established. Keep AUT-03 disabled by default. Project-owner opt-in and rollout are not authorized by this trial.

## Scope and evidence

This is a bounded descriptive comparison with one run per case per condition. Cohorts 1 and 2 and earlier invalid attempts remain excluded. Both cohort-3 arms have approved freezes and completed collection corrections. The blind packet was frozen and scored before unblinding. The independent scorer read only the packet; the unblinding key is recorded separately.

- Blind packet: `blind-scoring-packet.json`, SHA-256 `ac60b78dcb31c8738aed804f2b3e8d465de9d6a4a2cf072a0ea987e069b4d028`.
- Independent blind scoring: `cohort-3-blind-score-review.md`, SHA-256 `1e8287a676c687e95e1d0e40bd823afe4082f90af5fcc8c9a06313ea08e18e76`.
- Unblinding key: `blind-scoring-key.json`, SHA-256 `f34748748deb75d4e5ac9d4f647c7097a6be6010a6d9a7eb4419609c6d239837`.
- Score mapping and calculations: `cohort-3-blind-score-summary.json`, SHA-256 `a4032f026a2e8de95dd8bbd11ef92c9d9349b180eb86cb28ab6182238171db1b`.
- Runtime, resource, S08 and S09 evidence review: `cohort-3-runtime-resource-review.md`.
- S08 qualification: `s08/manifest.json` and `s08/qualification.json`.
- S09 reuses the accepted 22-line AUT-01 negative-control artifact, SHA-256 `ee76389b8af152b2d68c8536104f85a383005ddef9432ead741b90afcdbfa85a`.

## Quality result

Both conditions scored 92.85714285714286 percent as the unweighted mean of four case scores. The paired aggregate change is 0 percentage points. No case improved, no case regressed, and the 10-point non-regression limit passed. The required improvement of at least 10 percentage points and the requirement that at least two cases improve both failed.

The skill-on bounded-dependencies proposal also failed a mandatory oracle condition: T1 depends on T0, although T0 must remain independent. This violates the frozen dependency ordering and fails the retention hard gate requiring all skill-on cases to preserve mandatory constraints. The same dependency error appears in the skill-off output.

For pilot-price-f2, both outputs scored 6/7. S08 ran the existing analyzer and real assignment adapter without repairing proposal semantics; both outputs were blocked with invalid task IDs, a verifier-role mismatch, invalid write-path structure, and assignment contract-size findings. The S08 quality criterion therefore failed in both conditions. No output was dispatched or accepted.

The owner-decision-required and contradictory-source-blocker cases scored 100 percent in both conditions. Their required decisions and blockers remained explicit.

## Runtime and resource result

All four tasks in each condition completed in one lead turn. The independent review rehashed all 116 frozen artifacts and sizes with zero mismatches, matched all eight run and usage records, and confirmed zero worker dispatches, writer executions, permission events, commands, and file changes. Resource ratios use skill-on divided by skill-off:

| Metric | Median | Maximum | Result |
| --- | ---: | ---: | --- |
| Non-cached input tokens | 1.000583 | 1.000588 | Pass |
| Total tokens | 0.996765 | 1.003539 | Pass |
| Elapsed time | 0.941793 | 1.078974 | Pass |

Monetary cost remains null because subscription telemetry does not provide task-level cost. No dollar savings claim is made.

One historical control is unverified: `skill-off/bounded-dependencies/run.json` has `quotaAfter: null`, and no authenticated post-task snapshot exists in the preserved evidence. Its pre-task snapshot reports provider error null, the task completed, and the cohort continued. The audit does not claim that all eight post-task provider errors were observed null. This gap does not change the decision because quality and a skill-on hard gate independently fail.

## Decision

AUT-03 does not meet the frozen retention criteria. Keep the setting default-off and do not enable project opt-in on the basis of this cohort. No feature rollout is authorized. The trial outputs remain evidence only; this report does not propose repairing them or rerunning the cohort.

No project test suite or task check was run as part of this evaluation. S08 is the declared analyzer qualification, not a test-suite run.
