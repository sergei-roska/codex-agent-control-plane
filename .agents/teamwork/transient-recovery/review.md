# A1 independent admission-delta review

Verdict: APPROVE

The automatic retry now requires the executor's auto-resume setting to be enabled and a durable dispatched record whose attempt number and checkpoint ID match the incoming message. The loopback sender includes both fields. A stale dispatched row after restart with auto-resume disabled is rejected before `markRunning` or orchestrator resume. Mismatched attempts and checkpoints are rejected by the scheduler. These changes address the challenger admission scenario without changing the previously approved recovery path.

Checks: `node --test --test-name-pattern='disabled automatic resume rejects a stale dispatched transient message|transient capacity failure retries the same real Lead checkpoint automatically|explicit rateLimitExceeded uses transient recovery' test/server.test.js test/e2e.test.js` passed its selected server regression; nested e2e cases required a separate run. `node --test test/e2e.test.js` passed 9/9. `git diff --check` passed. Earlier source was not re-reviewed.

Status: complete
Scope expansion: none
