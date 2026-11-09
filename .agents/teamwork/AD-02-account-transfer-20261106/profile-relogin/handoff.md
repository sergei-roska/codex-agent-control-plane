# AD-02 existing-profile re-login UI/API slice

Status: implementation complete and integrated; auth recovery switch race repair is pending independent delta review.

## Implemented

- `src/launcher-app.js` exposes explicit `requiresOpenaiAuth`, classifying typed auth RPC failures (auth error and HTTP 401/403) as auth-required for `/api/accounts`. Unrelated RPC failures remain unknown, successful explicit false stays false, and null rate limits alone never imply auth.
- `src/launcher-app.js` adds browser/device sign-in for system or an existing profile. It verifies `requiresOpenaiAuth === false` before completion and preserves existing profiles/homes on failure, timeout, and cancel.
- `launcher-ui/app.js` shows sign-in controls only for explicit auth-required accounts and provides in-place login polling/cancel.
- `test/launcher-accounts.test.js` covers typed 401/403 auth, unrelated RPC failure, explicit false with null limits, login success/failure/cancel/timeout, and legacy add-account behavior.

## Verification

- `node --test test/launcher-accounts.test.js` - 29 passed, 0 failed.
- Integrated recovery suites passed: auth-focused lead graph 3/3, budget watcher 35/35, account failover context 3/3, app-server switch 17/17, and named server auth/startup/pause cases 8/8. Exact commands and the full server-suite stall are recorded in [auth recovery handoff](../auth-recovery/handoff.md).
- After switch-selection repair, `node --test test/account-profiles.test.js test/app-server-switch.test.js test/budget-watcher.test.js test/account-failover-context.test.js test/launcher-accounts.test.js` passed 97/97; targeted lead-graph auth passed 3/3 and named server auth/startup/pause cases passed 8/8.

The wrapper now checks the watcher's captured active profile and selection revision, performs selection compare-and-set, and conditionally restores only its own still-current transition after a creation failure. Busy and thrown watcher outcomes preserve a newer owner activation. Review details are in [auth recovery review](../auth-recovery/review/handoff.md).

No live provider, credential, quota, runtime activation, external message, staging, or commit was used.
