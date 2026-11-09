# Startup diagnostics and verification preflight handoff

Diagnostics implementation is independently re-reviewable; the concurrent
startup compatibility issue remains unresolved. No permission/isolation adapter
was changed. The workspace-write fixture in `test/server-delivery-engine.test.js`
still reproduces `concurrent_lane_isolation_required` with reason
`native_permissions_use_shared_workspace`; root assigned that integration test
and the compatibility implementation to another worker.

Startup stderr is now buffered by complete line before entering logs or the
persistent diagnostic. The incomplete carry is bounded at 8000 characters and
never included in status or persistence. Overlong lines are omitted with a safe
marker. Readiness and process close flush a bounded, sanitized partial line.
The split-secret regression splits both the `OPENAI_API_` key prefix and its
credential value across stderr chunks, then closes without a newline. It checks
that no pending fragment appears in logs or startupDiagnostic, that the flushed
line is redacted, and that the persisted diagnostic stays redacted after manager
reinitialization. Separate cases cover multiline stderr and complete and
unterminated overlong lines. API and UI tests verify only the redacted form is
presented.

Verification preflight now returns `routeType: fingerprint` and
`routeCallable: false`. Lead guidance states that the fingerprint is not a
callable model tool, preflight does not say checks ran, read-only investigator
mounts do not establish writable verifier access, and dependency/cache errors
must first try an already-authorized disposable cache/scratch under unchanged
policy before an infeasibility escalation. No permissions or pinned checks were
changed.

Owned source/tests: `src/launcher-projects.js`, `src/launcher-app.js`,
`launcher-ui/app.js`, `src/verification-preflight.js`, `src/lead-graph.js`,
`test/launcher-projects.test.js`, `test/launcher-app.test.js`,
`test/launcher-startup.test.js`, `test/verification-preflight.test.js`, and
`test/lead-graph.test.js`. No edits in the other worker's server-delivery test.

Focused verification:
- `env -u NODE_TEST_CONTEXT node --test test/launcher-projects.test.js`:
  35/35 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='returns status with logs' test/launcher-app.test.js`:
  1/1 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='status polling shows persistent startup failures' test/launcher-startup.test.js`:
  1/1 pass.
- `env -u NODE_TEST_CONTEXT node --test test/verification-preflight.test.js`:
  7/7 pass.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='owner checks keep running through runCheck and agent proposals are ignored|configured local route survives candidate changes' test/lead-graph.test.js`:
  2/2 pass.
- `git diff --check` and `node --check` for owned JavaScript files: pass.

No live processes, settings, providers, dependencies, or permissions were
changed. Source compatibility and any claim that Concurrent delivery now starts
successfully remain unverified and unresolved.

Independent re-review: APPROVE in `review-final.md`. Critic also reran the
original two-chunk fake-child probe; logsLeak=false and diagnosticLeak=false.
