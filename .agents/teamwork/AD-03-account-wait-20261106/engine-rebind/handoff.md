# AD-03 engine/controller handoff

Status: engine/controller implementation complete; host composition remains open.

## Changes

- `ConcurrentDeliveryEngine` accepts optional `budgetAccounts`, records a durable
  wait only for a settled failed worker attempt carrying the exact trusted
  `failureKind: usage_limit`, and hashes account identities in blocker records.
- Added `processDueBudgetWaits()` and `recoverBudgetWaitTransitions()` for timer
  and startup callers. Eligibility requires authoritative account reads, explicit
  auth clearance when provided, and explicit budget availability. Reset-only or
  ambiguous snapshots do not qualify. Unavailable waits refresh blockers and
  reschedule with bounded polling/backoff while retaining prior valid blockers
  when current reads produce none.
- Added project-wide quiescence checks, gated account switching, durable intent
  phases, fresh lead-thread preparation, exact wait/control/selection pin checks,
  and an atomic lineage/wake/journal-clear commit. A failure after profile switch
  keeps the gate closed so same-process or startup recovery can continue. The
  confirmed provider identity pin changes only after commit.
- `ProjectDeliveryController` awaits the settled usage-limit hook before signaling
  or waking planner work and polls due waits while running.
- Added fake-profile/SQLite coverage for successful A-to-B rebind, active account
  wake while the alternate is blocked, reset-hint-only non-wake, active sibling
  deferral, both persisted recovery phases, and owner pause during thread prep.

## Verification

- `node --test test/concurrent-delivery-engine.test.js` - 65 passed, 0 failed
  before the final selection recheck and empty-read backoff hardening.
- `node --test --test-name-pattern='budget wait safely|reset hints without explicit|unknown budget reads|available active account|active sibling run|budget transition recovery|owner pause during budget thread' test/concurrent-delivery-engine.test.js` - 8 passed, 0 failed after those final changes.
- `node --test test/project-delivery-controller.test.js` - 34 passed, 0 failed.
- `node --check src/concurrent-delivery-engine.js` - passed.
- `node --check src/project-delivery-controller.js` - passed.
- `git diff --check -- src/concurrent-delivery-engine.js src/project-delivery-controller.js test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js` - passed.

## Remaining integration

The real switching wrapper currently has no token-authorized transition prepare
API. The engine now requires
`appServer.prepareThreadForTransition(token, options)`; fake tests expose this
contract, but real-wrapper transition success and crash recovery remain pending
the lead-owned wrapper method and composition regression. The lead also owns
`server.js` profile adapter and startup wiring. Startup must call
`recoverBudgetWaitTransitions()` before dispatch and provide `budgetAccounts`.
The typed settled-attempt callback is wired but does not yet have a direct
end-to-end worker settlement regression in this slice. AD-03 remains open. No
live providers were used. `:memory:.lockdb` and Git state were left untouched.

Scope expansion: none
