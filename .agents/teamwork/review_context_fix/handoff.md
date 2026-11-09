# Handoff

Status: implementation complete; scoped verification passed.

Changed files: `src/lead-graph.js`, `test/lead-graph.test.js`.

Implementation: `reviewObligationsSection` now emits the canonical nested six-field review object (`kind`, `checkpointId`, `reason`, `paths`, `evidenceIds`, `prerequisiteFor`) while retaining checkpoint and gate status fields. Missing legacy `prerequisiteFor` becomes `[]`, consistent with `normalizeReview` in `src/contracts.js`. Full and delta prompts share this section. Prompt text directs the lead to reuse each stored object and arrays exactly.

Regression pauses after a reviewed writer, removes the optional field from persisted test state to represent a legacy checkpoint, forces a full prompt on thread rollover, then checks both the full and resumed delta prompt JSON for exact review contents. The fixture uses non-empty paths/evidence ID arrays and the legacy empty prerequisite default.

Verified commands:
- `node --check src/lead-graph.js`: pass.
- `node --check test/lead-graph.test.js`: pass.
- `git diff --check`: pass.
- `node --test --test-name-pattern='full and resumed delta prompts carry the complete stored review context' test/lead-graph.test.js`: 1 pass, 0 fail.
- `node --test test/lead-graph.test.js`: 200 total, 198 pass, 2 fail. Failures: `a rejected role-service audit result cannot become a graph receipt` expected no verifier retry; `precomputed full-report evidence uses the final rejected review state` expected a loop-warning prompt. Independent critic reproduced both failures with the old serializer in an isolated scratch copy, confirming they predate this change. The new test does not separately cover empty `evidenceIds` or a non-empty `prerequisiteFor`; the critic considered that non-blocking because both use the same direct serialization path.

No immutable review objects or gate behavior were changed. No runtime, services, or Git state were changed. Independent critic returned APPROVE. Root was notified.
