# AUT-02 direct origin binding challenge after repair

Verdict: HOLDS for the scoped direct origin/thread mismatch. This does not qualify graph recovery or all AUT-02 cases.
Status: complete
Scope expansion: none

Final source SHA-256: `95281c89bdab68f0aae8e0375b2f72930d9e4fa3868670f66600056144717234`.
Final test SHA-256: `ab5408a7be89c86bc42c6e70be2e7ef171e3c9255c6ff47da5eb349760076089`.
Both hashes matched before and after final validation.

The frozen pre-repair failure is in `thread-origin-baseline.cjs`, `thread-origin-baseline-output.txt`, and `report.md` at source SHA-256 `481dd650ad801b25fa968e157e8f408086b7592ab90ca65e41cac31d412d1f85`. Its original copy is under `.agents/teamwork/aut02_direct_challenge/`.

Post-repair command: `node docs/evidence/aut-02/challenge/thread-origin-regression.cjs`.
Result: exit 0. Both a valid B attempt paired with A's same-run thread and a valid B attempt in another run paired with A's first-run thread fail with `review_origin_stale`, `request_invalid`, `effects:none`, and `accepted:false`. App Server receives only the three fresh A/B/B calls; neither forged continuation reaches it. Output: `thread-origin-regression-output.txt`.

Control command: `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='direct review continuations bind thread lane and codex home to their origin attempt|direct review resumable context distinguishes unknown bindings from proven tuple mismatches|direct verifier continuation requires its originating target and preserves same-target control|auditor continuations require a known unchanged originating review target' test/a2a-role-service.test.js`.
Result: 4 passed, 0 failed or skipped. The new named control verifies missing, corrupt, and unknown-version binding evidence returns `review_origin_unknown` while a proven tuple mismatch returns `review_origin_stale`. Output: `direct-controls.tap`.

Tried: same-run stale-thread pairing, cross-run stale-thread pairing, normal same-target continuation controls, unknown versus proven tuple mismatch classification.
