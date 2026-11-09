# Handoff: AUT-03 paired trial completion

Status: complete. AUT-03 cohort-3 evidence committed to `main` as `4b1d756670061e451b7add83358b01c54db77ada`; commit contains 220 files under `docs/evidence/aut-03/**` only. Working tree clean.

## Decision evidence drafted

- `docs/evidence/aut-03/cohort-3-final-decision.md`
- `docs/evidence/aut-03/cohort-3-runtime-resource-review.md`
- `docs/evidence/aut-03/cohort-3-blind-score-summary.json`
- `docs/evidence/aut-03/trial-entry.json`

Quality: skill-off and skill-on both average 92.85714285714286%; aggregate change is 0 percentage points; zero cases improve. Skill-on bounded-dependencies makes T1 depend on T0 although T0 must be independent, failing the frozen mandatory constraint hard gate. Both pilot-price outputs fail S08 analyzer/adapter qualification. Decision is benefit not established; AUT-03 stays default-off, with no opt-in or rollout authorization.

Resource review: all 116 frozen artifact hashes/sizes match; all usage rows and ratios reconcile. Median non-cached input ratio 1.000583, total token ratio 0.996765, elapsed ratio 0.941793; all resource thresholds pass. Monetary cost is unavailable. The reviewer verdict is INCONCLUSIVE only because skill-off bounded-dependencies has no preserved post-task quota snapshot. Its pre-task provider error is null and task completed. Do not claim all eight post-task provider errors were observed null.

S08: both arms are blocked by the existing analyzer/adapter; no semantics were repaired. S09: accepted 22-line AUT-01 negative control rehashes to `ee76389b8af152b2d68c8536104f85a383005ddef9432ead741b90afcdbfa85a`.

## Independent reviews

- Skill-off baseline freeze: APPROVE.
- Skill-on baseline freeze and collection corrections: APPROVE.
- Blind scorer: completed; criterion score review preserved at `docs/evidence/aut-03/cohort-3-blind-score-review.md`.
- Runtime/resource/S08/S09 reviewer: INCONCLUSIVE for one missing post-task quota snapshot; all other requested checks passed. Full review: `docs/evidence/aut-03/cohort-3-runtime-resource-review.md`.
- Final decision auditor: APPROVE. Durable report: `docs/evidence/aut-03/cohort-3-final-decision-audit.md`, SHA-256 `2dae4073afe239712eb1d384d7c773053f455566e51bd1a29ea951eec246c8e2`.

## Runtime and branch

Previously verified: `main` at `ebe51c8f3a6139afa4141f116707d9c94e8be952`; launcher PID 7855 and protected project PID 11495 were not touched; protected AUT-03 setting remains default-off; trial server stopped and port 3112 free. Recheck read-only state before commit if available. Do not restart services.

## Next actions

1. Receive final audit; fix only factual/documentary errors, not trial outputs.
2. Update `trial-entry.json` with audit pointer/verdict and final status.
3. Rehash all evidence references, verify the working tree contains only the intended AUT-03 evidence and ignored teamwork notes, then commit only `docs/evidence/aut-03/**` to `main`.
4. Complete. No standard test suite was run.
