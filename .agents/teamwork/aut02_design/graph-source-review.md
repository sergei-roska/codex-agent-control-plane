# AUT-02 graph source review, current candidate

Verdict: REJECT at source SHA-256 `3fc0699bc550c5ddd673f1c865fcdd81870e929db9622dcb40e6fb0520f6308b`. This is a source review while Q08/Q09/Q11/Q14 qualification is still being expanded, not final milestone acceptance.

Blocking:

1. `src/lead-graph.js:1011-1052` [read]: An accepted verifier's authorized test-only write can produce an accepted current-target receipt and `verifier_target_changed_during_review`. The new branch treats every such review as requiring an auditor. For `routine`, its verifier receipt already completes the gate; an auditor is prohibited by the routing policy. The generation and round-cap checks run before this branch, so they can also mark a complete routine review as requiring replanning. Fix: after integration, detect the accepted current verifier receipt first; mark routine complete without a generation or round, and queue an auditor only for a gated kind when admission still permits a round. Add a routine post-write probe.
2. `src/lead-graph.js:727-751,822-840` [read]: Persisted `allowedFiles` validation checks only string length, and `isTestCheckPath` normalizes `../tests/x` into a path classified as a test path. Deterministic assignments bypass `validateDecision`; a corrupt v1 checkpoint can therefore emit an unsafe write scope. The direct role service currently rejects unsafe paths, but the graph's persisted-state admission must fail closed independently. Fix: require `safeRelativePath` for each stored path before recovery dispatch and reject duplicate checkpoint IDs in v1 state so selection is unambiguous.

Positive evidence:

- [read] `reviewRecovery` has a v1 default, 40-checkpoint bound, two-generation cap, stored six-field scope hash, role/profile/skill pin checks, and no old thread or continuation in a fresh assignment. `targetForReview` binds run, goal, checks, and scope; receipt integration remains current-target gated.
- [read] Trusted trigger classification checks graph stale skip/receipt and structured endpoint `request_invalid` plus policy/kind/checkpoint/reason. Generic failed reviews do not enter the recovery branch. Normal dispatch creates fresh assignment/attempt/context IDs, and `continueLimited` retains a separate usage-resume path.
- [read] `planAutomaticReviewRecovery` checks budget, cancellation, unresolved writers, and round limit; graph routing checks owner pause before dispatch. A fresh verifier precedes auditor in separate rounds. No source change was made by this reviewer.
- [ran] `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='a stale usage-limited auditor recovers before another lead decision|a stale verifier selected alone retains skill pins|a usage-limited recovery verifier keeps its generation|a direct-service origin that goes stale' test/lead-graph.test.js`: 4 pass, 0 fail, 0 skip.

Non-blocking: Q08/Q09/Q11/Q14 and full integration evidence remain pending. The older direct service binary cannot enforce the new tuple binding during a live rollback; the current milestone has no live rollout.

Pitfall: A path that looks like a test path after normalization may still escape the workspace before normalization.

Status: partial
Scope expansion: none
