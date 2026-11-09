# Review verdict worker brief

Baseline: 655bb47eca72f49995dd90b98a55c044358e9a7a.

Own only `src/review-policy.js`, `test/review-policy.test.js`, and this
handoff directory. Fix the confirmed verifier acceptance defect: completed
reports with passed checks but explicit `VERDICT: fail` or
`VERDICT: inconclusive` must not produce accepted evidence. Recognize current
first-line verdict variants with checkpoint suffixes. Preserve positive and
no-verdict compatibility, review boundaries, scope/coverage, unknown-target,
failed/unrun-check gates, and the auditor's strict standalone-first-line
grammar. Add focused regressions for the r304 pattern, negative verdicts,
suffixes, positive compatibility, and guard interactions. No live model/API
calls, services/restarts, shared DB access, target codex_team_work edits, Git
mutation, or edits to lead graph/role prompts.
