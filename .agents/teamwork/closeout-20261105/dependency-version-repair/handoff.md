# Dependency version repair handoff

Status: source candidate frozen for root full suite and critic review.

Changed only `src/concurrent-delivery-engine.js` and
`test/server-delivery-engine.test.js`. Planner output now uses a versioned
standalone dependency record schema for `delta.dependencies` and retains the
versionless reference schema for embedded `task.dependencies`. The regression
checks generated shapes, rejects a versionless standalone record with the
actual `validatePlanDelta` validator, accepts the corrected record, and confirms
the embedded reference stays versionless. Test IDs are synthetic.

Verification passed:

- `node --test --test-name-pattern='planner sends a strict usable schema' test/server-delivery-engine.test.js` - 1 pass.
- `node --test test/delivery-contracts.test.js` - 16 passes.
- `node --test test/concurrent-recovery-acceptance.test.js` - 1 pass.
- `node --check src/concurrent-delivery-engine.js && node --check test/server-delivery-engine.test.js` - pass.

Before the source fix, the focused test failed because the standalone schema
had no `schemaVersion` property. No live calls, runtime restart, replay, or DB
mutation was performed. Existing untracked `:memory:.lockdb` was left untouched.

Frozen file SHA-256:

- `src/concurrent-delivery-engine.js`: `7c9a3787f105c18c708819edab6dfe5aedb9c9e50849ef9d1dcc44cf9db99baa`
- `test/server-delivery-engine.test.js`: `7edbc07c2a76f78b2ce8cf44e5e3422f47d105336bd5ccb4a5406ab941c4de5a`

Root owns the full suite and final acceptance. Do not edit source or tests
without an explicit review finding.
