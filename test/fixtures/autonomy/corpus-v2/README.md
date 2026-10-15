# AUT-05 corrected cohort v2

This captured cohort preserves the original historical and manual-planning
inputs while correcting source identity and evidence boundaries. It is not a
`baseline_ready` decision; the lead records any accepted decision separately
after final independent review.

## Evidence scope

- The six target-orchestrator cases preserve two historical failure findings,
  three bounded post-repair or control passes, and one inconclusive usage case.
  Pre-repair source revisions are unknown. The evidence does not establish that
  identity or nested-manifest findings proceeded to authorization, or claim
  runtime receipts, writes, or accepted task results.
- The AUT-01 planning artifact is a manual current-lead capture with recorded
  source digests. It is not a harness run, model output, or workflow-quality
  measurement.
- The independently reviewed semantic mapping is in
  `../planning-baseline/reviewer-assessment.json`: four requirements plus AC1
  are preserved (5/5). Missing literal IDs are a separate structural
  traceability gap. This is a manual artifact assessment, not model performance.
- Accepted results, live-workflow metrics, tokens, time, and cost remain null.

## Verification

The CLI accepts only relative paths under `--root` (repository root by default),
checks every claimed local artifact digest, checks corpus and observation input
pins against the baseline, and rejects source drift. `ready` is always false;
the evaluator never records a lead acceptance decision.
