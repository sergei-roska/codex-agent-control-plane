# Auditor report contract handoff

Status: complete for assigned scope. Preserve predecessor changes in this
worktree, including adjacent edits in src/a2a-role-service.js and tests.

## Changes

- Added report schema descriptions for standalone audit verdicts, required
  checks, and risks used for supplemental diagnostics and reused evidence.
- Added matching auditor profile and direct runtime prompt instructions.
- Documented the existing semantic limit: runtime requires a nonempty all-pass
  checks list but cannot map natural-language assignment checks mechanically.
- Added schema, policy, and A2A regressions for strict verdicts, failed/unrun
  required checks, excluded diagnostic reporting, reused verifier evidence, and
  report projection into staging findings.
- No report fields or contract version changed; stored report shape is intact.

## Verification

- `env -u NODE_TEST_CONTEXT node test/contracts.test.js`: 44 pass, 0 fail.
- `env -u NODE_TEST_CONTEXT node test/review-policy.test.js`: 5 pass, 0 fail.
- `env -u NODE_TEST_CONTEXT node test/a2a-role-service.test.js`: 57 pass,
  0 fail, 1 optional HTTP test skipped by sandbox limitation.
- `git diff --check`: pass.
- The brief-prescribed `node --test` invocations produced opaque file-level
  failures for a2a-role-service.test.js in this sandbox. Direct execution of
  the same test file passed; do not treat the wrapper failure as a code failure.
- Follow-up critic repair: generic acceptance guidance is now excluded for
  pinned_check and investigation. Pinned checks receive the preserve/weaken
  contract at runtime. `env -u NODE_TEST_CONTEXT node
  test/a2a-role-service.test.js`: 57 pass, 0 fail, 1 optional HTTP skip.

## Review notes

- Verify the repeat_guard / lead-graph prompt owner incorporated the exact
  auditor reporting guidance. This worker did not edit src/lead-graph.js.
- Confirm predecessor's neighboring verifier changes remain intact.
