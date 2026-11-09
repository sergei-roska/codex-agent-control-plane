# CN-11 independent re-review

Verdict: APPROVE

The previous shutdown race is resolved.

- [ran] Replayed the same disposable SQLite sequence: signal inbox, call `runOnce()`, then `shutdown()` with literal-true publication settlement. The initial projection now reports `safeToRelease:false` with `controller_cycle_in_flight`; the cycle returns `stale/controller_shutdown`, provider `runTurn` starts 0 times, and no planner ledger row exists. Once the cycle drains, projection reports `safeToRelease:true`.
- [read] `src/project-delivery-controller.js` now latches shutdown, increments the run generation, checks that generation after `#applyOwnerCorrections()` and before planner admission, blocks queued/direct planner and scheduler calls, and retains an entered cycle in the shutdown projection. An already active planner receives a durable inbox-version change so its output fails the existing planner commit CAS. `src/delivery-lifecycle.js` includes `controller_cycle_in_flight` in `safeToRelease` reasons.
- [read] The new controller tests cover pre-admission shutdown, a held planner output, and queued/direct admission after shutdown. Existing no-model-spin and recovery tests remain present. The store snapshot is outside this correction and CN-12 finalization remains a separate gate.
- [ran] `env -u NODE_TEST_CONTEXT node --test test/backlog-store.test.js test/delivery-lifecycle.test.js test/task-executor.test.js test/project-delivery-controller.test.js`: 98 passed, 0 failed.

Status: complete
Scope expansion: none
