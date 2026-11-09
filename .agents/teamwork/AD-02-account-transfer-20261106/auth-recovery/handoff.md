# AD-02 explicit auth recovery integration

Status: implementation and race repair complete; pending independent delta review.

## Implemented

- `src/lead-graph.js` recognizes typed auth failures and explicit `getAccount().requiresOpenaiAuth === true`, then checkpoints a distinct `waiting_for_auth` pause with a local Accounts sign-in action. Unknown errors remain errors; null rate limits are not used as auth evidence.
- `src/budget-watcher.js` polls explicit account auth state and required-model availability. It resumes the active profile after local sign-in, or switches to another explicitly authenticated profile when auto-switch is enabled. Null limits remain unavailable. Switch selection is owned by the wrapper; watcher candidates carry their captured active profile and selection revision, and only a confirmed switch resumes.
- `src/account-profiles.js` persists a monotonically increasing active-selection revision and exposes compare-and-set selection for wrapper transitions. Direct owner activation and removal of the active profile advance the revision.
- `src/app-server-switch.js` validates the expected selection across pending swaps, leaves selection unchanged when it returns busy, conditionally restores a failed transition only if its revision is still current, and commits wrapper state only after the target instance is created.
- `src/server.js` persists/projects auth pauses, registers them with the watcher, and admits only the matching automatic auth resume against a still-live auth pause.
- `test/account-failover-context.test.js` verifies same run/context/checkpoint identity, one settled worker outcome, fresh provider thread on B, rejection of unauthenticated or null-limit candidates, and one automatic resume after explicit auth recovery.

## Verification

- `node --test --test-name-pattern='explicit auth failures|only explicit account auth state|unknown lead error' test/lead-graph.test.js` - 3 passed, 0 failed.
- `node --test test/budget-watcher.test.js` - 35 passed, 0 failed.
- `node --test test/account-failover-context.test.js` - 3 passed, 0 failed.
- `node --test test/app-server-switch.test.js` - 17 passed, 0 failed.
- `node --test test/launcher-accounts.test.js` - 27 passed, 0 failed.
- `node --test test/launcher-accounts.test.js` after typed-auth propagation - 29 passed, 0 failed.
- `node --test --test-name-pattern='describePause gives an auth pause|startup registers INPUT_REQUIRED lead tasks paused for budget or auth|an auth pause waits for explicit account recovery|budget auto-resume metadata cannot resume' test/server.test.js` - 8 passed, 0 failed.
- `node --test test/account-profiles.test.js test/app-server-switch.test.js test/budget-watcher.test.js test/account-failover-context.test.js test/launcher-accounts.test.js` after race repair - 97 passed, 0 failed.
- `git diff --check` - passed.
- `node --test test/server.test.js` - interrupted after no new output; Node reported 20 tests, 19 passed, 0 failed, 1 cancelled, outer test pending after 110.29 seconds. Do not rerun the full file without a focused stall diagnosis.

## Closed follow-up

The launcher now classifies typed auth errors from `getAccount()` and rate-limit RPC reads as auth-required. Unrelated RPC failures stay unknown; explicit false is preserved even when limits are null. The existing-profile Accounts UI can therefore expose its local sign-in action for the typed 401/403 case.

The full `test/server.test.js` run remains unqualified because it stalled without new output and was interrupted; the bounded auth/startup/pause selection passed 8/8. Lead should diagnose the full-suite stall separately before using it as AD-02 evidence. Delta review of the repaired switch-selection races is pending.

No live provider, credentials, quota, runtime activation, staging, or commit was used.

Changed paths across this worker's AD-02 slices: `src/account-profiles.js`,
`src/app-server-switch.js`, `src/budget-watcher.js`, `src/launcher-app.js`,
`src/lead-graph.js`, `src/server.js`, `launcher-ui/app.js`,
`test/account-profiles.test.js`, `test/account-failover-context.test.js`,
`test/app-server-switch.test.js`, `test/budget-watcher.test.js`,
`test/launcher-accounts.test.js`, `test/lead-graph.test.js`, and
`test/server.test.js`. Auth and review handoffs are under
`.agents/teamwork/AD-02-account-transfer-20261106/`.
