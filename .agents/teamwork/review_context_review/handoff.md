# Review context transfer review

Status: complete. Verdict: APPROVE for the scoped serializer and regression.

Scope reviewed: `src/lead-graph.js` reviewObligationsSection and `test/lead-graph.test.js` test `full and resumed delta prompts carry the complete stored review context`. The surrounding working tree contains older unrelated edits; no reviewed source, tests, fixtures, config, or Git state was changed by this review.

Read evidence:
- `reviewObligationsSection` emits `review` with `kind`, `checkpointId`, `reason`, `paths`, `evidenceIds`, and `prerequisiteFor`; missing legacy `prerequisiteFor` becomes `[]`. It also preserves checkpoint and gate fields. Both `deltaPrompt` and `fullPrompt` call this same function (`src/lead-graph.js:1564,1624,1649`).
- `checkReviewContext` validates the input arrays and canonicalizes optional `prerequisiteFor` to `[]` (`src/contracts.js:308-366`). The serializer copies stored arrays directly. Empty evidence IDs and nonempty prerequisite IDs therefore follow the same path; the new test does not exercise those values, but no separate branch exists.
- The new test pauses after the writer, removes the persisted optional field to emulate a legacy checkpoint, resumes, and asserts exact six-field review JSON in the rollover full and subsequent delta prompts (`test/lead-graph.test.js:2081-2134`). It retains nonempty evidence IDs and checks the legacy empty prerequisite default. No gate logic is changed in the scoped serializer hunk.

Ran evidence:
- `node --test --test-name-pattern='full and resumed delta prompts carry the complete stored review context|a rejected role-service audit result cannot become a graph receipt|precomputed full-report evidence uses the final rejected review state' test/lead-graph.test.js`: 1 pass, 2 fail. The new regression passed. Log: `/tmp/review-context-focused.log` (temporary).
- Created `/tmp/review-context-baseline-qvpzbql0` with scratch copies of current `src`, `test`, and `profiles`, linked `node_modules`, and replaced only `reviewObligationsSection` in the scratch copy with `HEAD`'s old function. Ran `node --test --test-name-pattern='a rejected role-service audit result cannot become a graph receipt|precomputed full-report evidence uses the final rejected review state' /tmp/review-context-baseline-qvpzbql0/test/lead-graph.test.js`: both tests failed with the same assertions as current (extra verifier dispatch; missing loop warning). Log: `/tmp/review-context-baseline.log` (temporary). Thus the scoped serializer change did not introduce those failures.

No blocking finding for scoped change. Nonblocking test coverage gap: explicit empty `evidenceIds` and nonempty `prerequisiteFor` are not asserted in the new prompt test; direct field serialization and existing contract tests make the gap immaterial to this review.

Next action: lead may integrate scoped change; separately address the two pre-existing lead-graph test failures if required for the larger working tree.
