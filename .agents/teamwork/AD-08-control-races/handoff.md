# AD-08 control races handoff

## Completed

- Added `test/autonomous-delivery-control-races.test.js` with pause and explicit cancel subtests through the authenticated `startServer` control routes.
- Each subtest creates a typed terminal usage-limit failure on account A, waits for the durable budget wait, then holds the automatic account B eligibility read while posting owner control. Releasing the read preserves the owner disposition and control revision.
- Assertions verify the wait remains waiting, no provider switch or second worker call occurs, the attempt ledger has only the original settled usage-limit failure, the account remains A, and no `objective.budget_woken` event is published. Unauthenticated status access is rejected.
- No production files were changed. The fixture's switching app server requires a synchronous `processIdentity()` method; it returns null.

## Verification

- `node --test test/autonomous-delivery-control-races.test.js` - pass, 3 tests, 0 failures (pause and cancel subtests included).
- `node --check test/autonomous-delivery-control-races.test.js` - pass.
- `git diff --check` - pass; `git diff --no-index --check /dev/null` was also run for the new test and handoff files, with no whitespace diagnostics.

## Constraints and next action

- No live provider, credentials, runtime activation, staging, or commit was used.
- The shared checkout contains unrelated work in progress. Preserve it and `:memory:.lockdb`.
