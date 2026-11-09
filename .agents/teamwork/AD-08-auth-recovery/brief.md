# AD-08 auth recovery regression

## Scope

Add one deterministic regression in `test/autonomous-delivery-auth-recovery.test.js` for the supported legacy auth-wait path composed through real `startServer`, a fake existing-profile login through `createLauncherApp`, and the production automatic budget watcher. Do not change source or existing tests. Keep provider and login behavior local to the fixture; use no live providers or credentials. Preserve the inherited `:memory:.lockdb`.

## Acceptance

- A typed auth failure leaves the real task in `waiting_for_auth` and creates no worker outcomes.
- Existing-profile login uses the same profile home, completes only after explicit fake authenticated state, and preserves profile metadata.
- The real watcher automatically resumes the same run once without owner continuation.
- The required check identity stays pinned and passes; the run reaches accepted state.
- Record the focused command and result in the handoff.
