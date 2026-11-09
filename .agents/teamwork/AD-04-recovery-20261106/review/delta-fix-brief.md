# AD-04 router-migration fix delta review

Mode: re-review only the blocking router-composition finding from `delta-handoff.md` and its repair. Candidate changes are the current working-tree delta in `src/server.js`, `src/delivery-engine-router.js`, `test/server.test.js`, and `test/delivery-engine-router.test.js`.

Verify that the real production router exposes the correct legacy graph only for legacy mappings; the lead executor migrates before stale decision validation/publication; successful migration does not revive stale task pause metadata; and the composed regression proves the old question/interrupt is retired and stale metadata is not forwarded. Preserve the engine fence. Do not reopen the transient retry findings already accepted in your prior review. Do not edit source/tests/fixtures or Git state. Reuse the reported focused results where valid; run decisive checks if evidence is insufficient. Full `test/server.test.js` was incomplete after 105 seconds (19 passed, 0 failed, 1 cancelled, pending promise), so do not mistake this for a clean full-suite result.

Read the existing critic role instructions. Write full findings to `delta-fix-handoff.md`. Return under 200 words:
`Verdict: APPROVE | REJECT | INCONCLUSIVE`
`Blocking: ...`
`Status: complete | partial | blocked`
`Scope expansion: none`
