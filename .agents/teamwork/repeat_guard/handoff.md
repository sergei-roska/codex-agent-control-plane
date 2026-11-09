# Repeated review guard handoff

Status: complete; lead owns integration and full-suite verification.

## Changes

- `src/loop-guard.js`: failed review work keys now use stable role, checkpoint,
  and declared scope. Paraphrased checks, reason text, and incidental evidence
  IDs do not split an equivalent review episode.
- `test/loop-guard.test.js`: production-like review paraphrases, rotating IDs,
  interleaved explorer work, changed executed command, and changed candidate
  identity are covered. Warning occurs on the third audit and pause on the
  fourth unchanged audit.
- `src/lead-graph.js`: gated non-pinned auditor dispatches receive exact audit
  verdict/check evidence instructions in the report contract.
- `test/lead-graph.test.js`: actual gated verifier/auditor flow covers four
  paraphrased auditor assignments and final rejected report state, and checks
  dispatched guidance.

## Verification

- `env -u NODE_TEST_CONTEXT node test/loop-guard.test.js`: 17 passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node test/lead-graph.test.js`: 195 passed, 0 failed.
  Escalated execution was needed for the existing `/var/tmp` scratch fixture.
- `env -u NODE_TEST_CONTEXT node test/lead-orchestrator.test.js`: 22 passed,
  0 failed.
- `node -c src/loop-guard.js && node -c src/lead-graph.js`: passed.
- `git diff --check`: passed. ASCII scan of owned source/tests: passed.

## Open

- Root owns full suite, independent review, and integration.
- No live 10-hour run was performed.
