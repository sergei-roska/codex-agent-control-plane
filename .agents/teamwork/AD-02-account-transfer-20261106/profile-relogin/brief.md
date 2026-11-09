# AD-02 existing-profile re-login UI slice

## Goal

Provide a supported local browser/device sign-in flow for an already configured
account profile. Preserve the existing profile and its home, expose only an
explicit auth-required signal, and never infer authentication from missing rate
limits.

## Ownership and files

Own only:

- `src/launcher-app.js`
- `launcher-ui/app.js`
- `test/launcher-accounts.test.js`
- this task handoff

Do not edit `src/lead-graph.js`, `src/server.js`, or `src/budget-watcher.js`;
AD-04 owns the graph, and root will integrate the recovered auth state with the
budget pause after that ownership is released.

## Acceptance

1. A named existing profile can start browser or device-code OAuth login in
   its existing home without adding, replacing, or deleting the profile.
2. Successful login verifies explicit `requiresOpenaiAuth === false` before
   acknowledging completion. A failed, timed out, or canceled login preserves
   the existing profile and its home.
3. `/api/accounts` exposes auth state only when `getAccount()` explicitly
   returns it. `readRateLimits() === null` remains unknown, not auth-required.
4. The account UI offers sign-in for an existing profile only when explicit
   auth state says it is required. It does not display account tokens or home
   paths.
5. Focused tests cover success, failure/cancel preservation, explicit auth
   signal, and legacy add-account behavior.

## Constraints

No live providers, credentials, quota use, runtime activation, external
messages, staging, or commits. Keep output in English with ASCII punctuation.
Do not claim AD-02 complete; this is one UI/API slice of the auth-wait flow.
