# AD-01 same-home auth rotation fencing

Status: AD-01 implementation complete; independent review APPROVE after fixing busy cross-home switch starvation.

## Implementation

- `src/app-server-switch.js` captures only the hashed configured account identity when creating each cached App Server generation. A bound call compares the current auth identity to that pin. When it differs and no call is active, the wrapper closes and recreates the same-home instance before binding. Close or creation errors stop the call.
- If another wrapper call is active after an identity change, the new bound call fails with `provider_identity_generation_busy`; it does not close the active generation. After the active call settles, a retry rotates the generation.
- The durable binding uses the generation-pinned hash. Identity is rechecked after the awaited callback and immediately before target invocation. A mid-callback identity change fails before `target.run()`.
- A pending cross-home profile switch with an active bound call now rejects a second bound call with `provider_home_switch_busy`. It does not spin or disturb the active generation. Once that call settles, a retry performs the profile switch before binding/invoking.
- Raw account IDs, tokens, and raw home paths are not retained by the generation pin or added to the binding record. Existing profile switching, expected-home preflight, worker binding, and lead binding stay in place.
- The guarantee is a repository-enforced App Server object-generation boundary. It does not prove that an external Codex CLI process reloads credentials from a changed file, or that the new process used those credentials. Do not claim `call_bound` proves provider turn start, completion, or effect.

## Verification

- `node --test test/app-server-switch.test.js` - 17 passed, 0 failed, 0 skipped. The review-fix regression runs the reported sequence in a child process with a 1500 ms timeout; before the fix it reproduced `ETIMEDOUT`, and after the fix it verifies prompt busy rejection, preservation of active A, and a retry bound/invoked on B with B's identity hash.
- `node --test test/durable-store.test.js` - 20 passed, 0 failed, 0 skipped.
- `node --test test/e2e.test.js` - 13 passed, 0 failed, 0 skipped.
- `node -c src/app-server-switch.js` and `node -c test/app-server-switch.test.js` - passed.
- `git diff --check -- src/app-server-switch.js test/app-server-switch.test.js` - passed.
- Tests use disposable temporary homes with synthetic account IDs; no live account/read or provider call ran. Temporary homes were removed by test cleanup.

## External runtime assumption

Official App Server documentation describes `account/read` as account information returned by the selected server, but does not specify whether a same-home `auth.json` replacement is reloaded by an already-running CLI. The documented examples also do not expose a stable account ID for comparison. The current repository sanitizes the account response and strips account IDs. AD-08 qualification must retain this as an unresolved runtime assumption unless separately verified with an authorized provider qualification; this task made no live account/read call.

## Next action

Next: lead re-review. The provider-call binding handoff cross-links this result. No scope expansion was needed; `src/codex-app-server.js` and its account/read schema were not changed.
