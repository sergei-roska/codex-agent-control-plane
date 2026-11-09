# Handoff

Status: blocking review finding fixed; affected checks pass. No commit or runtime restart.

The prerequisite admission helper now refuses to admit a new linked verifier if any other co-dispatched assignment has a writable role. This also blocks a same-checkpoint writer whose assignment would otherwise bypass gateFailure's checkpoint-ID exception. The regression proposes that writer in wave 1 and the linked verifier in wave 2; the proposal is rejected, while active scoped reviewer tests still pass.

The two contracts-test regexes that expected `/exactly role/` and `/optionally skills/` were stale: the current validator's shape check emits `Assignment must contain the ordinary fields and may include skills, wave, continueFrom, review, and repair`. Their expectations now match that message and retain the same rejection assertions.

Verification:
- `env -u NODE_TEST_CONTEXT node test/contracts.test.js` - 46 passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node --test-name-pattern='prerequisite admission|one linked prerequisite|scoped reviewers can complete' test/lead-graph.test.js` - 3 passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node --test-name-pattern='prerequisite links' test/review-policy.test.js` - 1 passed, 0 failed.
- `git diff --check` - passed.

Next: independent re-review. No open implementation doubt identified.
