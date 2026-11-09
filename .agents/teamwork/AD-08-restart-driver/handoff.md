# AD-08 recovered-run driver handoff

Status: scoped implementation complete; integrated release acceptance passed.

## Design and evidence

Startup `recoverStoredRuns()` started controllers for active objectives, but only interactive facades entered `#waitForTerminal()`, which calls `#advance()` and finalizes. The design uses one process-local driver promise per run so recovered runs and interactive `run`/`resume` facades share terminal progress. Owner decisions, explicit pause, cancellation, unknown/error states, and engine shutdown keep their durable semantics.

## Implementation and evidence

`src/concurrent-delivery-engine.js` keeps one driver promise per run. Startup recovery starts it for `planning`, `executing`, and `waiting_budget`; interactive facades join an existing driver. Resolved owner decisions and budget wakeups start or join the driver. The initial caller signal is registered before the loop begins. Shutdown drains background drivers before closing the database.

`test/concurrent-delivery-engine.test.js` adds a gated regression proving recovery and interactive facades share one driver and finalize only once. The owner-decision answer path continues automatically without calling `resume`. Replace/reopen fixtures remain nonaccepted when planner output has no further work; reopen preserves its held verifier effect and asserts `concurrent_shutdown_unsafe` on shutdown.

The integrated release diagnostic exposed a separate authorization mismatch. The persisted budget `planner.provider_rebound` event used the current `controlRevision` for `objectRevision`, while `#providerRebindLineage` requires the event revision to be one greater than the payload control revision. The budget rebind event now uses `current.controlRevision + 1`, with a focused invariant assertion in the due-budget-switch test. Before this correction, the release diagnostic showed a complete finalization projection and idle controller, followed by `failureCode: finalization_unauthorized`; repeated `delta: null` planner turns were a symptom of the stuck run, not the cause.

## Verification

- `node --test --test-name-pattern='stored-run recovery and interactive facades share one terminal driver|owner decision real engine (answer|replace|replace-drift|reopen) preserves scoped control and authenticated response' test/concurrent-delivery-engine.test.js` - 5 passed, 0 failed before the lineage correction.
- `node --test test/concurrent-delivery-engine.test.js` - 72 passed, 0 failed before and after the lineage correction (59.5 s after the correction).
- `node --test --test-name-pattern='due budget wait safely switches to an available account and preserves the run identity|provider rebound finalization rejects verifier settings drift|provider drift resumes a blocked objective through its exact frozen verifier and keeps unknown siblings fenced|stored-run recovery and interactive facades share one terminal driver|owner decision real engine reopen preserves scoped control and authenticated response' test/concurrent-delivery-engine.test.js` - 5 passed, 0 failed after the lineage correction.
- `node --check src/concurrent-delivery-engine.js && node --check test/concurrent-delivery-engine.test.js && git diff --check -- src/concurrent-delivery-engine.js test/concurrent-delivery-engine.test.js` - passed after the lineage correction.
- `node --test test/autonomous-delivery-release.test.js` - 0 passed, 1 failed before the lineage correction, with `finalization_unauthorized`; root reran the full acceptance after the correction and reported 1 passed, 0 failed.

The post-correction release acceptance confirms the budget rebind lineage and recovered background driver complete the same objective through finalization. No further source change is pending.
