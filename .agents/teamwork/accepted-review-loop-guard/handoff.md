# Handoff: accepted review recurrence repair

Implemented a graph-derived recurrence resolution signal. `newlyAcceptedReviewReceipt` requires the same declared review scope, known current target, an integrated accepted receipt matching exact assignment and attempt IDs, no currently qualifying prior receipt for that target, and a trusted valid accepted review outcome. Only this signal resets the matching recurrence entry. Service acceptance claims alone do not reset it.

Changed `src/lead-graph.js`, `src/loop-guard.js`, `test/lead-graph.test.js`, and `test/loop-guard.test.js`. Added an end-to-end failed -> stale -> accepted verifier sequence that continues to next work; added guard checks that genuine repeated attempts still stop and service-only acceptance claims do not resolve recurrence. Existing receipt validation and review recovery caps remain in place. Repeated accepted receipt dispatch is normally deduplicated by graph reuse, so no fabricated multi-receipt test was retained; the existing recurrence test covers ordinary repeated observations.

Verification: `node --test test/loop-guard.test.js test/lead-graph.test.js` passed 304/304. `git diff --check` passed. The checkout contains unrelated existing dirty IPC, handshake, and launcher changes; these were preserved. A concurrent IPC test expectation in `test/lead-graph.test.js` is also present and was not introduced by this task.

No target project changes, Git mutation, service restart, or model call. Candidate is ready for independent review. The lead separately identified a follow-up case for trusted pre-turn stale-origin rejections; it is outside this frozen change and should only begin after review of this candidate.
