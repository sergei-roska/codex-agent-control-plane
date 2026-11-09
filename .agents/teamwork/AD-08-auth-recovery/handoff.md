# AD-08 auth recovery handoff

Status: complete.

## Implementation

Added `test/autonomous-delivery-auth-recovery.test.js`. It starts a real `startServer` legacy composition with automatic resume enabled and an existing profile in a disposable accounts directory. The first fake coordinator turn returns a typed 401; the task remains `INPUT_REQUIRED` with `waiting_for_auth`, no worker outcomes, and a pinned check. A separate real `createLauncherApp` instance shares the profile directory and completes the existing-profile login using a fake App Server. The production watcher then resumes through its automatic auth route; the fixture does not call `resume()` or send an owner continuation. The resumed coordinator finishes, the real acceptance check runs, and the same task/check reaches accepted state.

The fake `auth.json` contains only a fixture account identifier needed by the switching wrapper's provider-call binding; it contains no token. Login state and provider responses stay in local closures. No source or existing test files were edited.

## Verification

- `node --test test/autonomous-delivery-auth-recovery.test.js` - passed, 1/1.
- Existing reference suites: `node --test --test-name-pattern='existing account re-login' test/launcher-accounts.test.js` - passed, 4/4; `node --test --test-name-pattern='waiting_for_auth' test/budget-watcher.test.js` - passed, 3/3.
- `:memory:.lockdb` was not read or modified.

## Scope boundary

Concurrent-v1 does not currently implement an auth-specific durable wait: its durable wait/recovery code is usage-limit specific. The requested supported regression therefore exercises the legacy `waiting_for_auth` path in the real server composition, as directed by the lead. The account login API remains owned by `createLauncherApp` and is exercised as a separate local app sharing the same account profile home.
