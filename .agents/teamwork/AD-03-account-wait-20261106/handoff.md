# AD-03 account wait and rebind handoff

Status: complete. Implementation, full server close/reopen qualification, and
independent read-only delta review passed. No live provider calls were made.

## Implemented

- Trustworthy worker failures carry `failureKind: usage_limit` only after the
  Codex classifier confirms the usage limit. Bare 429/text remains generic.
- Budget waits retain bounded blocker windows with hashed account identities.
  Reset hints alone never establish availability; unknown limits or unknown
  auth state never wake or switch an objective.
- Concurrent delivery records durable waits only after settled failures, polls
  and reschedules them, and requires explicit auth clearance and model
  availability before wake or account selection.
- Provider rebind checks project quiescence, closes wrapper admission, drains
  calls, writes a pinned transition journal before switching, prepares a fresh
  lead thread through the transition token, then commits lineage and wake.
- Startup calls transition recovery before stored run recovery and due-wait
  processing. Server composition passes profile state and fresh identity readers
  when the switching App Server is active.
- An engine/SQLite close-reopen test reconstructs a new engine with a persisted
  `profile_switched` transition and verifies `recoverStoredRuns()` completes the
  rebind and wakes the same objective before normal run recovery.
- The wrapper only admits transition-token thread preparation while gated and
  refuses to release the gate while that preparation remains in flight.

## Verification

- `node --test test/app-server-switch.test.js` - 23 passed.
- `node --test --test-name-pattern='budget|due budget|reset hints|unknown budget|available active|sibling run|transition recovery|owner pause during budget' test/concurrent-delivery-engine.test.js` - 10 passed after explicit-auth hardening.
- `node --test test/concurrent-delivery-engine.test.js` - 68 passed after explicit-auth hardening and engine/SQLite reopen coverage.
- `node --test test/provider-transition-store.test.js test/budget-watcher.test.js test/delivery-role-service.test.js test/backlog-store.test.js test/delivery-lifecycle.test.js` - 176 passed.
- `node --test --test-name-pattern='switching server composition supplies' test/server-delivery-engine.test.js` - 1 passed.
- `node --test --test-name-pattern='switching server composition supplies|startServer close and reopen' test/server-delivery-engine.test.js` - 2 passed. The restart case closes a real `startServer` instance with a durable `profile_switched` wait, starts it again, and verifies recovery clears the journal and wakes the same objective before server readiness.
- `node --check` for changed server/engine/wrapper files and `git diff --check` passed.

## Remaining

- Independent review found no actionable defects in the transition barrier,
  profile and owner/control pins, eligibility, journal recovery, or startup
  ordering.
- Continue AD-05 composed reconciliation qualification.

The inherited untracked `:memory:.lockdb` remains untouched. No files were
staged or committed.
