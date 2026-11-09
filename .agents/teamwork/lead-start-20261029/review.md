# Startup fix review

Verdict: APPROVE
Blocking: none.
Status: complete
Scope expansion: none

## Scope and mechanism (read)

Compared actual files against the saved flat evidence/baseline copies and inspected git diff for tracked wrapper changes. The scoped production delta is only src/app-server-switch.js. src/concurrent-delivery-engine.js and test/app-server-switch.test.js match their saved baselines. The integration regression changes test/concurrent-delivery-engine.test.js. Extensive pre-existing dirty files are excluded from this verdict.

The wrapper now separates profile selection (including null) from the effective, canonical provider home. Effective precedence matches its production CodexAppServer construction: selected profile, baseOptions.codexHome, CODEX_HOME, then ~/.codex. Existing paths resolve symlinks; absent paths retain an absolute spelling. Profile swap decisions still compare the selected profile; captured preparation and expected-home guards compare the canonical identity snapshot.

Checked the surrounding prevention mechanisms: concurrent lead preparation compares captured home and account identity with the pinned provider; lead execution rereads provider identity; delivery-role-service passes the pinned expected home. The wrapper still rejects a changed home before forwarding a provider run. Account replacement checks remain in the engine. Internal expected/capture options are stripped by the wrapper as before, so the regression's undefined forwarded expectedCodexHome assertion is intentional rather than weakened verification.

## Independent checks (ran)

- env -u NODE_TEST_CONTEXT node --test test/app-server-switch.test.js: 8 passed, 0 failed.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='pinned base candidate|preparation settings mutation|same-home provider' test/concurrent-delivery-engine.test.js: 6 passed, 0 failed. Includes all four shared fixture modes, default-profile planning and acceptance, planner recovery, rejected preparation settings mutation, and rejected same-home account replacement.
- Additional focused default-profile/account run: 2 passed, 0 failed.
- In-memory compilation of the saved baseline wrapper versus current wrapper with the same null profile and concrete base home: baseline raises provider_home_changed with zero stub runs; candidate completes one stub run.
- Independent inline matrix for default fallback, environment override, base options override, selected-profile precedence, and a symlink profile: all five capture the expected canonical home, execute against that pin, and reject a later different profile before a second provider call.
- git diff --check -- src/app-server-switch.js test/app-server-switch.test.js: passed.

The new regression uses the real switching wrapper and concurrent engine with a stub provider, disposable SQLite/workspace data, and local test HTTP. It checks accepted completion, planner start/terminal facts, verifier receipt, and pinned provider identity. No paid provider calls or live service/database/task operations were used. Full repository and full concurrent-engine suites were not required for this narrow delta and are not claimed.

Non-blocking: environment/default/symlink matrix coverage currently exists in this review's inline probe rather than committed tests; the committed default-profile integration covers the reported startup failure.

Pitfall: Keep the profile selector separate from canonical provider identity when null selects the default account.
