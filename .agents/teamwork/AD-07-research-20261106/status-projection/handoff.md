# AD-07 concurrent status projection

Status: implementation complete.

## Ownership and next action

Changed `src/concurrent-delivery-engine.js` and
`test/concurrent-delivery-engine.test.js`. The public `controlStatus` response
retains existing scope, revision, inbox, decision, and disposition fields, and
adds persisted phase, next action, safe provider-binding state, durable waits,
blockers, mandatory check outcomes, candidate, finalization, and controller
availability projections.

Raw account IDs and home paths are not returned. A lead-account attribution is
reported as `durably_bound` only when the run row has a complete stored lead
binding; otherwise it is `unknown`. Accepted result and fingerprint are
returned only when the durable accepted finalization still qualifies against
current objective, candidate, and review pins. Missing planner, candidate, or
publication ledgers remain explicitly unknown. The selected account at a
future provider invocation is not independently known from this status view;
the projection reports the durable run binding, not a live account claim.

Focused coverage exercises paused, active with queued work, budget waiting,
blocked technical, missing binding/controller, and accepted status after
SQLite reopen and result replay. No pause/cancel routes or UI were changed.

## Verification

- `node --test test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js` - 89 passed, 0 failed, 0 skipped.

No live provider, quota, runtime activation, or Git state changes were performed.
