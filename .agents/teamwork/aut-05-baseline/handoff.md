# AUT-05 baseline — handoff (final: baseline_ready)

Updated 2026-10-15. Status: AUT-05 baseline COMPLETE and recorded `baseline_ready`.

## Baseline reference

- **baselineId**: `aut-05-baseline-offline-v1`
- **baseline manifest digest**: `6a9f015f2707658fc516c3c63e5226ae8f95a9bbbe17b2cdf278f11761389cea`
- **accepted scope**: `offline_contract_and_artifact`
- **lifecycleStatus**: `baseline_ready` (recorded by the lead after verifier + auditor)

## Frozen artifact digests (sha256)

- corpus.json (7 cases, revision 2): `87b3f2bc9292e92d71607096a932f9090069dc45a27453943728d8d1ac0f8e7b`
- observations.json (7 observations): `a1ed7344cad8f4fece77436ac3022fd25194999ab1d4255ca9e93f7881431417`
- metric-definitions.md: `16a89e135253012d1f22e53ea99298863fca072f1992e12b73ba4e019d351792`
- canonical-input.md: `594578f4353bf7c49fcb362c88597cf5ea8cc86a262a8c671abd445186a6fe46`
- requirements.md: `e52c265402041d9076dd4cb3e435c7eac8758373277504c28e2d0ce05bb07bf1`
- current-workflow-output.md: `834990df2afaddc89450900bb73688a019e5311662ba2290d53e8dec788ec932`
- schemas: corpus `fe83db21…`, observation `186cb405…`, baseline `390e47e1…`
- evaluator src `68e7666d…`, CLI tools `d765fae2…`
- target source snapshot: git HEAD `63eb95918c3986f3ad5ac237c22a6bafc5ef5530` (working tree clean)

## Per-case observations and independent oracle references

| caseId | mode | actualResult | oracle (source contract) |
|---|---|---|---|
| canonical-identity-contradiction | historical | fail | src/runtime-identity.js + src/contracts.js |
| nested-manifest-contradiction | historical | fail | src/contracts.js + src/lead-graph.js (QA-227-1/r227-r229) |
| producer-mismatch | historical | fail | src/contracts.js proof derivation (QP-212-01) |
| stale-review-continuation | historical | pass | src/contracts.js review.continuation (r215) |
| valid-ordinary-result-control | historical | pass | src/review-policy.js + src/lead-graph.js (r216/r217) |
| failed-incomplete-usage | historical | fail | runbook §2 + src/usage-report.js (r212/r227, TOK-OPT-01) |
| aut-01-planning-baseline | artifact_assessment | pass | requirements.md scoring rule; score 0/5 |

Every observation's `corpusDigest` equals the corpus digest; no case is missing.
Historical provenance is textual (`.agents/teamwork/` handoffs), not fabricated digests.

## Metric summary (from the evaluator, exit 0, valid:true)

- `acceptedResults` 3 (real pass), `passedCount` 3, `failedCount` 4.
- `requirementPreservation` 0/5 = 0.0 (independent reviewer score).
- `firstPassAcceptedCheckpoints`, `measuredCostPerAcceptedResult`, `tokens`,
  `elapsed_time`, `repair_cycles`, `review_cycles`, `owner_escalations` are null
  (offline scope) with explicit reasons.

## Verification and audit evidence

- Verifier (critic): reviewed B1 (schemas/fixture) and B3 (evaluator/CLI) — both
  APPROVED after lead corrections. Integrated 7-case review found one stale
  `corpusDigest` (blocker); lead fixed; re-verified evaluator exit 0, `valid:true`,
  `assessed:true`, 32/32 focused tests pass.
- Auditor: integrity + semantics audit of the integrated candidate — PASS.
- Focused tests: `node --test test/autonomy-evaluation.test.js
  test/autonomy-evaluation-cli.test.js test/autonomy-schemas.test.js` -> 32 pass, 0 fail.
- Full suite: 1128 tests, 1125 pass, 2 pre-existing failures (test/lead-graph.test.js,
  unrelated to AUT-05), 1 skip.

## Generated evidence storage location

`artifacts/autonomy/aut-05-baseline-offline-v1/` (gitignored). Contains
`report.json` (`ae2632ba34ee25052f3341c6cb97d0a254921908765747a70bddc6530e702c8c`),
the reproducible evaluator report. Primary durable artifacts are the tracked files
under `test/fixtures/autonomy/`, `schemas/`, `src/`, `tools/`, and `docs/`.

## Known limitations (accepted for this scope)

- Offline only: no live model execution, measured spend, or token capture.
- `summary.acceptedResults` is a coarse proxy (real pass = case-oracle satisfied);
  the strict "accepted result with current-target review receipt" metric requires
  live comparison-phase data.
- §9(j) config/acceptance-rule/metric-version cross-version mismatch requires a
  baseline-schema extension; deferred to the AUT-01 comparison phase.

## Next work item (AUT-01, parent plan P1.0-P1.1)

Reuse the frozen feature inputs (f2-repair canonical inputs + requirements.md
mandatory inventory + current-workflow-output.md) as the AUT-01 planning checker's
pilot feature. Implement per docs/spec-kit-luna-integration-plan.md Phase 1
(`schemas/spec-*.schema.json`, `src/spec-context.js`, `src/spec-analyzer.js`,
`src/spec-assignment-adapter.js`, `tools/spec-kit/analyze.js`, fixtures under
`test/fixtures/spec-kit/pilot-auth/`). Do not overwrite the baseline artifacts.
