# Startup diagnostics and verification guidance re-review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Read: frozen launcher delta plus src/verification-preflight.js and
src/lead-graph.js guidance changes and paired regression assertions.
The previous credential suffix leak is resolved: startup stderr is buffered
until a complete line or close/readiness, bounded overlong records are omitted,
and the raw carry is never projected to logs or persistence. Retry resets carry
and diagnostic state. Existing old-child guards and lifecycle remain intact.

Ran independently:

- `env -u NODE_TEST_CONTEXT node --test test/launcher-projects.test.js test/verification-preflight.test.js`: 42/42 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='returns status with logs|status polling shows persistent startup failures' test/launcher-app.test.js test/launcher-startup.test.js`: 2/2 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='owner checks keep running through runCheck|persistent preflight' test/lead-graph.test.js`: 1/1 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='the configured local route survives candidate changes while acceptance reruns on each candidate' test/lead-graph.test.js`: 1/1 pass.
- Original disposable fake-child two-chunk probe rerun: logsLeak=false,
  diagnosticLeak=false.
- Scoped git diff --check: pass.

The added preflight fields identify route as a fingerprint and non-callable.
Normal and inspection-failure projections agree. Guidance distinguishes an
inspector's read-only mounts from verifier execution, allows only already
authorized disposable cache/scratch under unchanged policy, and preserves
pinned commands, acceptance and permissions. It makes no claim of completed
verification or automatic recovery of the paused legacy run.

This approval covers diagnostics/guidance only. Native lane compatibility is
reviewed separately in lane-review.md. No live provider/service/config changes,
prohibited test or broad suite were run.
