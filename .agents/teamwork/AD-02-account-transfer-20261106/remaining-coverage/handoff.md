# AD-02 remaining account-transfer coverage

Status: unsettled-attempt integration coverage complete; authentication wait remains out of scope.

## Changed paths and decisions

- `test/account-failover-context.test.js`: added a deterministic legacy integration fixture for an uncertain writable A2A submission. The durable attempt ID remains stable through reconciliation. An unknown outcome holds failover and creates no B provider call or duplicate writer submission. Once the admission fixture proves settlement, one reconciliation outcome retains its changed path, the same run and pinned check resume, and B continues after A's usage limit without a new writer dispatch.
- No production source change was made. The fixture uses disposable profiles, SQLite, an in-memory admission proof, and fake providers; it does not contact a live provider or alter the workspace.

## Verification

Command: `node --test test/account-failover-context.test.js test/budget-watcher.test.js test/app-server-switch.test.js`

Result: 51 passed, 0 failed, 0 skipped.

## Remaining scope

The brief's authentication acceptance requires a typed, recoverable authentication pause visible in chat and eligible for automatic resume after login state changes. `src/budget-watcher.js` currently catches profile-limit errors as `null`, but that alone cannot represent a specific pause. The missing durable pause type and chat/resume behavior are in `src/lead-graph.js` and `src/server.js`; both are excluded from this task's allowed paths and `src/lead-graph.js` has active AD-04 ownership. Do not infer authentication from a null response. Sequence this source slice after that ownership is released.

No raw account IDs, credentials, or profile-home paths were added to durable provider-call evidence. Live provider behavior remains unqualified.
