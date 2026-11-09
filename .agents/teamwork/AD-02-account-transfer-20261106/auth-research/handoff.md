# AD-02 authentication pause research

Status: research complete; no source edits or live provider calls.

## Findings

- Read: `src/transient-recovery.js:21-39` explicitly classifies `unauthorized`, `invalidApiKey`, `authenticationFailed`, and HTTP 401/403 as `auth`, distinct from quota. But `src/lead-graph.js:2999-3006` maps only `quota` to `usage_limit`; auth falls through to a thrown error. The graph's only budget pause at `:4273-4280` is `waiting_for_budget`.
- Read: `CodexAppServer.getAccount()` returns explicit `requiresOpenaiAuth` at `src/codex-app-server.js:604-610`. `readRateLimits()` catches errors and returns null at `:839-845`. `server.js:1694-1700` reads only rate limits for a profile, and `budget-watcher.js:121-128,175-185` converts null/errors to unavailable. Null cannot distinguish auth from quota or transport failure.
- Read: profile failover checks only rate-limit responses at `src/budget-watcher.js:135-165`; an authenticated availability response selects a profile. The watcher polls at intervals and watches only `profiles.json` at `server.js:1543-1550`. New profile login writes the profiles file after `account/login/completed`; existing-profile auth changes do not have a current launcher event path. Candidate profile reads are cached for 60 seconds (`budget-watcher.js:118-128`), so a future auth-change signal must invalidate that cache or the new state may remain hidden until expiry.
- Read: `createSwitchingAppServer` forwards `getAccount()` but not `onNotification()` (`src/app-server-switch.js:219-225`). Polling `getAccount()` is the current common interface for explicit auth state. Profile file notifications are only a faster trigger for profile changes, not proof of authentication.
- Read: Accounts UI offers Add account, sign-in via browser/device, Activate, and Remove (`launcher-ui/app.js:2190-2255`, `src/launcher-app.js:1080-1128,1140-1164`). Add account rejects an existing profile name and creates a new profile home. There is no in-place re-auth endpoint for an existing profile. `docs/codex-accounts-design.md:100` lists a re-login prompt for expired profile tokens as an open design item.

## Safest visible action and limits

The existing supported UI action is to add and authenticate another profile; it does not re-authenticate a named existing profile. To meet an existing-profile re-login requirement, the launcher needs an in-place re-auth flow for that profile, or the task message must direct the owner to a supported local Codex sign-in action without asking them to paste credentials. Do not claim the current Add flow re-authenticates an existing profile.

A deterministic login-state signal can be an injected `getAccount().requiresOpenaiAuth` value changing from true to false. Production can detect it on the watcher poll; profiles.json watch can wake profile additions/activation, but does not observe an existing profile's authentication state. The auth verdict must come from `requiresOpenaiAuth === true` or an explicitly classified auth failure, never from `readRateLimits() === null`.

## Minimal implementation and test sequence

1. After AD-04 releases `src/lead-graph.js`, add a distinct auth pause for explicit auth classification and preserve it in the run/checkpoint. Keep unknown rate-limit reads as unknown, not auth.
2. Extend the account adapter to return explicit auth state per profile via `getAccount()` and limits separately. Make the watcher keep auth-required profiles ineligible and expose a specific waiting state/action. Ensure a login-state change triggers a fresh read (or let a bounded poll do so) and does not reuse the 60-second cached auth result.
3. Define the supported sign-in action in the task status. Existing UI only adds a profile; same-profile re-auth needs an endpoint/UI surface.
4. Add fake-clock watcher tests: all profiles explicitly require auth => no switch/resume; change one account to authenticated and usable => exactly one automatic resume; null limit read alone never means auth or availability.
5. Extend `test/account-failover-context.test.js` or add a narrow server integration case using the real legacy orchestrator and fake providers. Assert same run/context, canonical workspace, pinned check and checkpoint continue after the auth state changes, with no new user submission and a fresh profile thread. Use existing fixture evidence at `:142-156,347-424`.
6. Run focused `node --test test/account-failover-context.test.js test/budget-watcher.test.js test/app-server-switch.test.js test/server.test.js`; do not exercise live credentials.
