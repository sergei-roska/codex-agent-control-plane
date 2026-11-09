# AD-05 legacy cancellation research

Status: research complete; no source changes.

## Evidence

- Read `src/durable-store.js:95-129,381-405`: SQLite journal rows use stable `attempt_id`, with `submitting`, `submitted`, and `finished` states. Database setup uses WAL and `synchronous = FULL` (`src/durable-store.js:160-170`). A `submitting` row is therefore a durable pre-send intent; journal state distinguishes task ID known from completion. No claim that this alone prevents duplicate external sends.
- Read `src/lead-orchestrator.js:571-612`: cancel retries downstream `cancelTask`, then `getTask`, and accepts only terminal task status. Timeout throws `UnconfirmedCancellationError`; unknown/active downstream status is not treated as stopped.
- Read `src/lead-graph.js` cancellation/recovery path and `test/lead-graph.test.js:7429-7464`: stop can leave a writer unresolved, and resume reconciles it before another lead turn. The regression asserts unresolved count is one while paused, then zero after reconciliation. `src/lead-graph.js:5290`-adjacent test (actual test location 5290 in the file) also checks stale continuation stays `writer_unresolved`.
- Read `src/server.js:1117-1138`: explicit cancel forgets budget/transient recovery and aborts an active run; a non-active task is immediately published canceled. Active cancellation is only published `CANCELED` when orchestrator returns `status: canceled`; otherwise it is `FAILED` with downstream cancellation unconfirmed (`src/server.js:1005-1058`). `test/server.test.js:274-294` and `:881-900` cover unconfirmed failure; `:1096-1115` covers shutdown parking after downstream stop settles. Explicit cancel and shutdown stop are distinct paths.
- Read `src/server.js:1684-1728`: automatic budget resume requires stored `INPUT_REQUIRED`, live `waiting_for_budget`, and inactive executor, then sends an A2A loopback message. Executor rechecks auto-resume eligibility; `test/server.test.js:199-270` verifies stale task metadata cannot override live owner pause or other live pause. Startup reconciliation rewrites stale WORKING lead tasks as `INPUT_REQUIRED` with `restart` (`src/durable-store.js:560-606`); existing test `test/server.test.js:635-675` verifies this.
- Read `src/server.js:1204-1230`: owner pause endpoint targets active orchestrator runs and transient-recovery records. Already parked budget-paused runs are not in either collection; there is no direct endpoint operation here that converts such a budget pause to `owner_pause`.
- Read `src/budget-watcher.js:112-143,180-204`: watcher checks map-entry identity after limit reads and after account switching. It does not recheck identity after a successful budget check immediately before invoking `resumeRun`. `forget()` removes the map entry (`:244-254`), but if called while the final `resumeRun` path is already in flight, the watcher can still call it. **Inference / concrete race:** explicit cancellation may forget a paused run while a budget check is between its eligibility check and loopback resume; the A2A message can still race in. Executor eligibility checks reduce stale resume effects, but the scheduling race itself is not fenced by the watcher. No test currently covers this interleaving.

## Tested behavior and gaps

- Tested: durable writer reconciliation on resume; downstream cancel confirmation; unknown cancellation fails visibly; restart converts interrupted lead work to restart pause; stale automatic-resume metadata is rejected when the live pause is owner pause.
- Gap: budget watcher cancellation fence at the `resumeRun` boundary is not tested and appears absent. Replacing/deleting an entry should be checked immediately before send, while noting that an already-started loopback send cannot be recalled by `forget()`.
- Gap: no legacy integration test composes a durable writer intent, owner cancel, and restart, asserting stable attempt reconciliation and no new attempt until the prior effect is terminal/known. Existing graph test covers cancel/reconcile within a run, not a complete server restart plus control race.
- Gap: owner pause does not currently target an idle budget-paused lead task through `/control/pause`; if product semantics require an owner fence there, that control path is not represented by the endpoint's active/transient target set.

## Minimal deterministic acceptance sequence

1. In `test/budget-watcher.test.js`, use a deferred successful `readRateLimits()` (or `accounts.canSwitch`) to pause `runCheck` after it has validated the current entry. Call `watcher.forget(runId, { dropHistory: true })`, release the deferred promise, and assert `resumeRun` was not called. Also cover the account-switch branch with deferred `switchTo` if the fix inserts a final identity fence after switching.
2. In `test/server.test.js`, create a persisted budget-paused lead task and fake loopback. Hold the watcher's eligibility read, issue explicit cancel, release the read, then assert stored state remains `CANCELED` and no auto-resume send occurs. Use only fakes; no live provider.
3. Extend restart coverage using a durable journal/checkpoint with a `submitting` or submitted writer attempt and stable attempt ID. Restart server/orchestrator, issue cancellation, settle/confirm downstream effect, and assert reconciliation addresses that same attempt before any next dispatch; assert no duplicate attempt ID/send.
4. If idle budget pause must be owner-pausable, add endpoint-level test that pauses it, makes budget available, and asserts no resume until explicit owner unpause. Current endpoint has no targeting path, so this test first requires a defined route/state transition.

## Next implementation task

Add an entry-identity/cancellation fence immediately before `resumeRun` in `src/budget-watcher.js`, with a deferred-read regression test. Then add server-level composition coverage for persisted budget pause plus explicit cancel. Keep the owner-pause-on-idle-budget decision separate because current `/control/pause` does not target that state.
