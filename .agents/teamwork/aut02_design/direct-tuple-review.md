# AUT-02 direct tuple-binding final review

Verdict: APPROVE for the frozen direct service/test pair only. Graph and milestone acceptance remain open.

Frozen hashes: `src/a2a-role-service.js` SHA-256 `e3ca7ce3a37e43f6950fe47b1915c2a52a2bfe5ea9b8f343b2ebf044160104cf`; `test/a2a-role-service.test.js` SHA-256 `bbfbc584054d938599840e6683e21e34d9dddeca4b3fc343f2c4ea1a2b607bfd`.

Prior blocker resolved. [read] `src/a2a-role-service.js:286-296` hashes the normalized tuple with a domain/version separator. `src/a2a-role-service.js:505-556` requires one complete same-run/attempt/role/checkpoint/target v1 event for any nonnull resumable field and rejects malformed, missing, ambiguous, or saturated evidence. `src/a2a-role-service.js:670-719` performs the comparison before lane adoption or App Server execution. An all-null tuple still follows the existing target check and fresh-thread path; a resumable legacy tuple without a v1 event stops. Raw thread/lane/home values are absent from the new staging payload.

[read] `src/a2a-role-service.js:429-461,1004-1040`: the actual tuple is finalized after lane completion and cached for both the event digest and terminal/artifact metadata. The event is written before `runError` is thrown or successful artifact publication. A staging write failure enters the existing catch path and cannot publish an accepted review. This covers usage-limit error publication as well as successful turns. The final tuple reflects a lane removed during completion.

[ran] `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='direct review continuations bind thread lane|direct review resumable context|direct verifier continuation requires' test/a2a-role-service.test.js`: 3 pass, 0 fail, 0 skip. [ran] The original challenger probe now records two App Server calls and a failed `review_origin_stale` forged continuation. Its process exits 1 because its old pre-fix assertion still expects a third call; the trace itself confirms rejection. [ran] `git diff --check`: pass.

Rollback/default: [read] the handoff states that older origins may use only all-null fresh fallback. No staging schema migration is needed because the event uses existing columns/payload. A rollback to the old service binary would restore the reproduced vulnerability; retain this guard before any future live downgrade. No live rollout occurs in this milestone.

Non-blocking: No dedicated restart-with-SQLite or usage-limit tuple test was added. The implementation writes through the shared append-only staging interface and follows a single pre-publication path for both outcomes; the final integration review should include the relevant existing persistence/error controls.

Status: complete
Scope expansion: none
