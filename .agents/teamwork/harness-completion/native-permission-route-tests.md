# Native permission acceptance and A2A route tests

Added focused regressions to `test/acceptance.test.js` and
`test/a2a-role-service.test.js` only.

Acceptance coverage confirms that agent-origin checks use native `execCommand`
arguments without a host fallback only when permission resolution returns
`mode: inherit`. A failed resolver decision retains the exact strict
read-only, no-network policy. Explicit strict mode skips native resolution and
retains the exact scratch-only policy: the per-run scratch directory is the
only writable root, network is disabled, and temp directories stay excluded.
The inherited path still enforces acceptance source, script pins, and immutable
before/after candidate identity.

A2A coverage verifies `executionTarget: shared` skips lane preparation, uses
the shared workspace as `cwd`, and holds writer admission. The default target
continues to prepare an available lane, uses its workspace as `cwd`, and passes
the original shared workspace as `permissionWorkspace` in both cases.

No source, service, or live session changes were made.

Integration correction: updated the existing modified-pin detail assertion to
expect an independent integrity review before the check can run. This matches
the current acceptance and graph behavior; no-run, pin, and UNKNOWN assertions
remain intact.

Verification:

- `node --test --test-name-pattern='agent checks use native execution only after inherit is resolved|agent checks retain strict sandbox policy when native inheritance is not resolved|explicit strict acceptance keeps the exact scratch-only no-network policy' test/acceptance.test.js` - 3 passed, 0 failed.
- `node --test --test-name-pattern='shared execution target uses admitted workspace while the default target uses an available lane' test/a2a-role-service.test.js` - 1 passed, 0 failed.
- `node --test --test-name-pattern='a modified or deleted pinned script gives check_changed and the check is not run' test/acceptance.test.js` - 1 passed, 0 failed.
