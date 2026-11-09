# AD-05 concurrent cancel and uncertain-effect reconciliation

Status: complete after legacy restart and concurrent host-route race qualification.

## Implementation

- `BacklogStore` owner cancel advances the control revision and enters durable `draining`; queued work is canceled and new claims are fenced. Trusted worker settlement or no-effect recovery remains recorded before objective terminalization.
- `completeCancellation` requires matching owner/control pins, no live claims or unsettled attempts, and terminal task states. The engine additionally waits for settled publication/workspace and planner records before calling it.
- Concurrent recovery starts draining runs after reopen. The engine retries planner reconciliation by lifecycle identity; the controller retries unknown worker reconciliation by attempt identity, polling submitted work and never resending an uncertain attempt.
- No-intent worker recovery always supplies the current recovery generation, including same-generation retries; stale owner generations remain rejected by executor/store checks.
- Cancel requests with unresolved effects return `input_required`; status remains nonterminal until the downstream ledgers are settled. Existing AD-07 status projection hunks were preserved.

## Changed paths

- `src/backlog-store.js`
- `src/project-delivery-controller.js`
- `src/concurrent-delivery-engine.js` (cancel/recovery hunks only; existing status projection retained)
- `test/backlog-store.test.js`
- `test/project-delivery-controller.test.js`
- `test/concurrent-delivery-engine.test.js`

## Verification

- `node --test test/project-delivery-controller.test.js` - 34 passed, 0 failed.
- `node --test test/backlog-store.test.js test/delivery-lifecycle.test.js test/project-delivery-controller.test.js test/concurrent-delivery-engine.test.js` - 160 passed, 0 failed.
- Deterministic worker regressions prove dependency recovery and no-intent proof recovery after cancel without resending; the latter keeps owner generation unchanged and initially withholds trusted proof.
- No live providers, credentials, quota, runtime activation, or external messages used.

## Integrated qualification

- Legacy cancellation against the budget watcher has real server close/reopen
  coverage: cancellation during a blocked account switch remains CANCELED after
  restart, with no extra dispatch or resume. The two named server race/restart
  cases passed 2/2 and `test/budget-watcher.test.js` passed 45/45.
- Concurrent pause and cancel now race through authenticated host routes with
  automatic account B eligibility held. Both preserve the owner control
  revision; the wait remains unwoken, account A remains active, and no later
  worker attempt is admitted. The composed control-race suite passed 3/3.
- Existing durable send-intent, unknown-effect reconciliation, and engine
  reopen coverage remain passing. No uncertain effect is reported as complete.
- The automatic controller/engine reconciliation timers are process-local wakeups; durable cancel and attempt identities survive restart and are rechecked when the engine recovers.

## Verification

- `node --test --test-name-pattern='an explicit cancel wins while the legacy budget watcher is blocked in an account switch|an explicit cancel during a legacy account switch stays canceled after server restart' test/server.test.js` - 2 passed.
- `node --test test/budget-watcher.test.js` - 45 passed.
- `node --test test/autonomous-delivery-control-races.test.js` - 3 passed, including suite and pause/cancel subtests.

No live provider, credential, quota consumption, runtime activation, staging, or commit was used.
