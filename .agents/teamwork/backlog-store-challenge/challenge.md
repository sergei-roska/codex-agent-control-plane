# CN-03 challenge, final repair check

Verdict: HOLDS
Status: complete
Scope expansion: none

The two original defects are repaired. Source is still a local store gate, not CN-05/CN-08 integration.

## Exact probes

- `node /tmp/cn03-recovery-probe.js`: passed. With an expired submitted attempt, current recovery generation, and all three explicit quiescence facts but no result, `reconcileAttempt` returns `terminal_result_required`. The attempt stays `unknown`, task stays `settling`, and project capacity stays 1. Before repair it silently changed to failed and released capacity.
- `node /tmp/cn03-pagination-probe.js`: passed. Objective-scoped first page `t` returns cursor `t`; using that cursor as `afterCursor` returns `u`. The existing `afterTaskId` route also returns `u`. Before repair, `afterCursor` repeated `t`.
- `node --test test/backlog-store.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 37 passed, 0 failed.

I inspected only the new source branches and corresponding regressions. `reconcileAttempt` now requires an explicit object result with a terminal state before reading/mutating the attempt; `projectBacklog` uses `afterCursor` for objective-scoped pages when present and retains `afterTaskId` compatibility. No additional failure was observed in the limited repair check. The `/tmp` probes may disappear.
