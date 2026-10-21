# Transient Lead recovery

Lead model failures are classified separately from account quota pauses. Automatic
recovery is limited to an exact selected-model capacity message, explicit rate
limit responses, and known service or transport failures. Quota exhaustion,
authentication failures, invalid requests/configuration, and unknown errors stay
manual in this recovery path. Explicit quota exhaustion continues through the
existing `waiting_for_budget` watcher and its account-availability checks. An
explicit provider `rateLimitExceeded` classification is treated as transient;
an untyped nested HTTP 429 remains on the legacy budget path to avoid changing
existing Codex RPC behavior without a more specific classification.

Recovery state is stored in `transient_recovery` in the durable state database.
Each record retains the attempt count, next attempt time, category, bounded cause,
checkpoint identity, and scheduling state. The scheduler reloads these records
after restart. It uses exponential backoff starting at five seconds, capped at
five minutes before jitter, with 0.5x-1.5x jitter. The maximum actual delay is
7.5 minutes. Five total failed turns exhaust recovery. Failed loopback delivery
also consumes the bounded retry budget.

Automatic replay requires the same current checkpoint identity, exactly the
`decide` graph node pending, no unresolved writers, an INPUT_REQUIRED task, and
an inactive executor. This is the read-only Lead decision boundary; worker
dispatch and uncertain writer effects are not replayed automatically. A manual
resume uses the existing checkpoint resume path and retains the selected model.

The existing task Cancel operation clears a pending retry before canceling the
paused task. The authenticated `/control/pause` route can also suspend a pending
transient retry; `/control/pause/cancel` makes it eligible again. A pause requested
while a model turn is failing is remembered and prevents automatic scheduling.
When automatic resume is disabled, classified
failure details remain visible in the task pause but no timer is started.
Exhausted recovery displays the attempt count and leaves the task available for
manual continuation.

Validation covers the recovery scheduler, task status projection, graph routing,
and real `startServer` plus `LeadOrchestrator` SQLite integration:
`node --test test/transient-recovery.test.js test/server.test.js
test/lead-orchestrator.test.js test/lead-graph.test.js test/contracts.test.js
test/e2e.test.js` passed 456 tests before the final automatic-admission guard.
After that guard, `node --test test/transient-recovery.test.js test/server.test.js
test/e2e.test.js` passed 113 tests, and the challenger probe confirmed a stale
dispatched row cannot continue when auto-resume is disabled. The accepted full
suite passed 1,395 of 1,404 tests; 8 failures match the baseline and 1 test is
skipped. No live provider outage, production restart, or real model turn was
exercised. Recovery is deliberately limited to an enabled automatic resume
whose dispatched attempt and checkpoint identities match, on a read-only Lead
checkpoint with exactly `decide` pending. It does not replay worker dispatches
or uncertain writer effects.
