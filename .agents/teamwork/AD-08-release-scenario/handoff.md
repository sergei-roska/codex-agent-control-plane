# AD-08 deterministic release scenario test plan

Status: read-only design complete; no test executed.

## Runtime path and placement

Use `startServer` with `deliveryEngine: concurrent-v1` in `test/server-delivery-engine.test.js`. AD-08 requires a durable B-exhausted wait and real server close/reopen. The legacy AD-02 test proves A-to-B transfer and acceptance, but its `createBudgetWatcher`/`LeadOrchestrator` wait is not durable across `startServer`; the concurrent engine owns AD-03 durable waits and startup recovery. Concurrent startup remains an explicit engine selection (activation doc); this test qualifies the selected fixture path only, not activation.

Extend the existing real-server fixture pattern in `startServer close and reopen recovers a switched budget wait before dispatch` (lines 797-920), not the low-level simulated engine reopen helper. That test currently inserts a wait and journal transition directly, and its provider factory always returns successful coordinator-shaped turns. New test should drive exhaustion through the injected provider failure and let production engine/wait logic create the state.

## Existing fixtures/helpers and contracts

- `test/server-delivery-engine.test.js`: `tempDir(t)` (line 21), `createGitWorkspace` (376), `startServer`/`idleConcurrentServer` (648+), `waitFor` (search local file); server test writes disposable `profiles.json`, two `auth.json` files, settings with `deliveryEngine: concurrent-v1`, roles, and injects `readProfileState` plus `appServerFactory(home)`.
- `test/concurrent-delivery-engine.test.js`: `deferred`, `waitFor`, `createBudgetWaitHarness`, `reopenBudgetEngineHarness` (1036, 1096), and due-wait tests. These demonstrate deterministic in-memory account state, scripted selection, persisted wait assertions, but are lower-level rather than real `startServer` composition.
- `test/account-failover-context.test.js`: `usageLimitError()` uses `error.codexError.codexErrorInfo = 'usageLimitExceeded'`; scripted `createSwitchingAppServer` run calls record account/thread/input/cwd. Existing assertions prove A/A/B calls, fresh B thread, same run/context/checkpoint contract, one settled outcome, account hashes only, and accepted check (test begins line 69).
- Existing real server restart test sets `autoResume: false`, calls `runtime.concurrentEngine.run`, waits for controller, then manually creates a durable wait and transition, switches profile under transition gate, closes and reopens. Reuse its disposable `root/workspace/account-a/account-b/accounts`, settings, token/state paths and cleanup discipline, but remove its direct pause/wait/transition fabrication for the new behavior test.

## Smallest proposed executable scenario

Add one named test adjacent to the real-server restart test. Keep one objective/session/run ID and `requiredChecks` pinned from initial run through acceptance. Script provider behavior by `(home, role, call index)` and retain a call ledger:

1. Account A planner returns a deterministic valid task plan; A worker call receives a trusted fake usage-limit error (`usageLimitExceeded`). Assert the server settles/records the task attempt and durable budget wait, with blocker bound to A's hashed identity.
2. Controller/server automatic failover selects B, rebinds under the transition gate, and resumes the same run/objective/session. B worker call also throws the trusted usage-limit error. Assert wait remains durable and objective remains non-accepted; assert A and B blocker hashes and attempt lineage.
3. Close the first `startServer` while waiting. Change only fixture availability so one account is explicitly usable (retain auth-clear state), reopen using the same options/database/workspace, and wait for server startup due-wait processing/resume. Assert same run/objective/session and intake/check identity; no owner continuation/control message was injected.
4. Script resumed planner/worker completion and the required verifier/check to pass. Assert objective/finalization `accepted`, check identity/result against current candidate, complete status/event history, distinct traceable A/B attempts, no duplicate settled task/effect/publication, and no un-hashed raw account IDs in durable bindings.

Prefer assertions against `runtime.concurrentEngine.store.getObjective`, `listBudgetWaits`, `listAttempts`, `events.replay`, `listFinalizations`, and exposed run/status APIs already used in adjacent tests. Use explicit deferred gates for any race; do not use sleeps as synchronization. Capture account-specific prepared thread IDs/call inputs from the factory. Set stable IDs and use a passing disposable check script in the Git workspace as the legacy fixture does.

## Separate cases and verified gaps

- Owner pause/cancel races: separate parameterized follow-up tests, gate the automatic switch or `prepareThreadForTransition` with `deferred`, issue revision-pinned pause/cancel while blocked, release it, then assert no wake/resume after control wins. Existing concurrent `owner pause during budget thread preparation` (1273+) covers pause at engine seam; AD-05 legacy server test covers cancel during blocked switch. AD-05 handoff explicitly says composed concurrent pause/cancel against provider rebind is open.
- Non-accepted recovery: separate focused tests/cases for missing login then explicit re-login; stale reset hint; unknown dispatch effect; genuine owner decision; failed required check; repeated failure. Assert each remains non-accepted until its evidence/owner action resolves. Existing AD-02 auth tests cover explicit auth state; concurrent finalization tests cover failed/unauthorized acceptance and unknown-effect recovery seams, but no single integrated release matrix covers all listed cases.
- Verified: AD-02 legacy A-to-B transfer/acceptance; AD-03 durable wait, rebind, and real server close/reopen recovery; AD-05 cancellation/reconciliation primitives; AD-07 revision-pinned UI controls.
- Not yet verified: one `startServer` run that naturally produces A exhaustion -> B exhaustion -> durable wait -> close/reopen -> automatic continuation -> mandatory current-candidate check -> accepted. Existing restart test manually seeds the wait and transition; existing legacy failover only has A exhausted and B succeeding. Concurrent restart test starts from a synthetic owner pause and lacks provider-task exhaustion and final acceptance.
