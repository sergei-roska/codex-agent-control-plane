# AUT-02 direct origin repair final review

Verdict: APPROVE for the direct role-service repair only. This does not accept the graph recovery milestone.

Source hash: `src/a2a-role-service.js` `481dd650ad801b25fa968e157e8f408086b7592ab90ca65e41cac31d412d1f85`.
Test hash: `test/a2a-role-service.test.js` `daf8bb2ac5d865b77f441016699e0cc3e357cec80686eff751fa87583deedd7b`.

The prior blocking issue is resolved. [read] `src/a2a-role-service.js:477-505` rejects a non-array/saturated staging result, validates every matching attempt record before using its target, and requires matching started status, kind, checkpoint, role, and run. A malformed companion can no longer disappear during filtering. [read] `src/a2a-role-service.js:620-649` checks verifier origin before App Server execution, while same-target continuation remains permitted. [read] `src/a2a-role-service.js:680-715` now publishes structured rejection metadata for verifier preflight failures, including `review_origin_stale` as reason and boundary code with `request_invalid` and `effects:none`.

[ran] `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='direct verifier continuation|auditor continuations|pinned-check fallback continuation|every normalized review field' test/a2a-role-service.test.js test/review-policy.test.js`: 7 pass, 0 fail, 0 skip. The named tests include valid-plus-malformed origin, wrong role, full-window result, same-target continuation, and stale A->B rejection before App Server call. Earlier plain/investigation controls passed 3/3 on the prior source delta; this delta does not change their branch condition.

[ran] `node --check docs/evidence/aut-02/replay-baseline.cjs` and `git diff --check`: pass. [ran] Parsed `docs/evidence/aut-02/direct-baseline.tap` manifest and independently checked its 1 test/0 pass/1 fail counts, all four baseline source hashes against `git show` at `cc0958edd54a5c7ddaab02e4844fa69b823af365`, and all five overlay hashes against current files: match. [read] The archived TAP failure is the expected pre-change stale verifier third App Server call; the baseline replay script overlays current tests/fixture on the archived implementation and removes its temporary workspace.

Non-blocking: The 10,000-event saturation rule may reject a valid origin in a very long run. It fails closed; a targeted staging lookup can remove that availability limit later if needed.

Status: complete
Scope expansion: none
