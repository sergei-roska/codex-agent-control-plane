# Legacy provider invocation binding handoff

Status: implementation complete; focused lead review complete; integration acceptance pending.

## Implementation

- `src/app-server-switch.js` selects the active target after profile settling, increments the in-flight reservation, hashes `tokens.account_id`, then awaits the call-bound callback before `target.run()`. Correlation options are stripped before forwarding. Missing auth identity or callback errors prevent target invocation; reservation cleanup remains in `finally`.
- `src/a2a-role-service.js` passes run, attempt, assignment, and worker task IDs from the accepted A2A message into every correlated provider call. Raw App Server adapters without the binding boundary fail closed. A rejected thread continuation followed by a fresh call creates distinct invocation IDs.
- `src/durable-store.js` adds append-only `dispatch_call_bindings` records with run, attempt, assignment, task, invocation, hashed account ID, and bound time. The first binding atomically pins its worker task ID on the parent attempt; later calls require that task ID. Identical replay is idempotent; conflicting replay and unlinked attempts are rejected. Attempt records list call bindings in SQLite append order, including same-timestamp calls. Records survive reopen.
- `src/server.js` wires the switching wrapper callback to the durable DispatchJournal. Injected wrappers receive the same callback; raw injected App Servers cannot execute correlated provider calls.
- `test/app-server-switch.test.js`, `test/a2a-role-service.test.js`, `test/durable-store.test.js`, and `test/e2e.test.js` cover target selection across profile changes, switch while callback is held, absent identity, failed persistence, hash redaction, attempt linkage, continuation retry IDs, replay behavior, reopen, and the real server storage path. E2E test adapters use disposable auth metadata and the production wrapper boundary.
- `src/lead-graph.js` already sends runId, attemptId, and assignmentId before A2A submission; no change was needed there.

## Verification

- `node --test test/app-server-switch.test.js test/delivery-provider-identity.test.js test/durable-store.test.js test/a2a-role-service.test.js test/e2e.test.js` - 113 passed, 0 failed, 0 skipped before the final ordering/task-pin refinement.
- `node --test test/durable-store.test.js test/a2a-role-service.test.js test/e2e.test.js` - 98 passed, 0 failed, 0 skipped after the final refinement.
- Lead review confirmed that the recorded identity is the configured account ID hash read at the selected provider-call boundary and that the durable journal refuses missing or conflicting attempt/task linkage. This does not cover lead-planner calls or establish provider-turn/effect completion.
- `node -c` passed for all changed source and test files.
- `git diff --check` passed for the implementation files.
- `node --test test/server.test.js test/e2e.test.js` was stopped after 146 seconds per lead direction. E2E passed; 31 server tests passed before interruption, with no failures. The completed server-test prefix covered startup and lead-executor fakes, not correlated provider role dispatch. No full server-suite result is claimed.

## Limits and next action

- `accountId` is the one-way hash read from the selected configured Codex home after the wrapper chooses its target. It records the configured identity at the provider-call boundary; it is not evidence that a provider turn started, completed, or caused an effect.
- Lead planner `appServer.run()` calls in `src/lead-graph.js` have no dispatch attempt binding and are not captured by this worker-attempt callback. Lead-call identity remains an AD-01/AD-02 integration gap.
- Replacing credentials inside the same home while its App Server process is already running is not independently observed by this binding event; same-home process credential replacement remains an AD-01/AD-02 integration gap.
- No automatic account switching, failover, or context transfer was added. Next: implement and verify invocation binding for lead-planner provider calls, then reassess same-home credential replacement.
