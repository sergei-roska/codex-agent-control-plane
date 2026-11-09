# AD-03 usage-limit evidence handoff

Status: complete.

## Changes

- `src/delivery-role-service.js` imports `classifyCodexError` and persists
  `failureKind: 'usage_limit'` only when the trusted classifier returns that
  value for the caught provider error.
- The terminal result adapter carries the persisted usage-limit kind into the
  durable failure result. Other terminal failures continue using their existing
  failure code or fallback.
- `test/delivery-role-service.test.js` covers typed Codex usage-limit evidence
  and a bare status 429 with rate-limit message text. The latter retains
  `provider_error` and does not persist `failureKind`.

## Verification

- `node --test test/delivery-role-service.test.js` - passed, 52/52.
- `git diff --check` - passed.
- Terminal `effectsSettled` proof and existing settlement behavior were
  exercised by both new regressions.

No wait, retry, account-switch, or generic error inference behavior was added.
No controller, engine, watcher, server, or store source was changed. Existing
AD-03 and AD-04 edits were preserved. `:memory:.lockdb` remains untouched; no
staging or commit was performed.
