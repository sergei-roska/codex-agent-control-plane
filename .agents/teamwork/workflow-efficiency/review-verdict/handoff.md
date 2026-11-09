# Review verdict handoff

Status: complete. Baseline: 655bb47eca72f49995dd90b98a55c044358e9a7a.

Changed `src/review-policy.js` and `test/review-policy.test.js`. Verifier
reports now parse an explicit verdict on the first summary line. Explicit
`fail` and `inconclusive` return invalid/inconclusive evidence with
`verifier_verdict_<value>`; the parser accepts a verdict followed by ordinary
first-line suffix text, including ` - checkpoint ...`. Explicit `pass` and
reports without a verdict retain the prior accepted behavior and null verdict.
Auditor parsing remains the exact standalone first-line grammar.

Focused regression covers the audit's r304 pattern, both negative verdicts
with and without checkpoint suffixes, positive suffix compatibility, and
failed-check and unknown-target gate precedence.

Verified: `node --test test/review-policy.test.js` - 8 passed, 0 failed.
No service, model/API, database, Git, or target-project action occurred.

Next: lead integrates the policy semantics; run broader review-service tests
only if integration identifies a relevant concern.
