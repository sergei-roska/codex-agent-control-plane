# Prerequisite admission

Goal: complete bounded `review.prerequisiteFor` admission for a new critical verifier while other critical checkpoints are pending.

Constraints: preserve verifier-before-auditor ordering, immutable review scopes, actual run-bound acceptance receipts, the unrelated-writer gate, and finish gating. Own only `src/contracts.js`, `src/lead-graph.js`, `src/review-policy.js`, and related tests. Do not commit or restart services.
