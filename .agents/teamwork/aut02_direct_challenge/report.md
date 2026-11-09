# AUT-02 direct origin challenge

Verdict: BROKEN
Status: complete
Scope expansion: none

Probe: `.agents/teamwork/aut02_direct_challenge/thread-origin-probe.cjs`
Output: `.agents/teamwork/aut02_direct_challenge/thread-origin-output.txt`
Command: `node .agents/teamwork/aut02_direct_challenge/thread-origin-probe.cjs`
Expected command exit: 0; actual exit: 1 on the explicit rejection assertion.
Source hash: `481dd650ad801b25fa968e157e8f408086b7592ab90ca65e41cac31d412d1f85`.

A direct auditor performs a valid review of candidate A on thread-1 in run-1, then a fresh valid review of changed candidate B on thread-2 in the same run and checkpoint. The forged continuation uses `ofAttemptId: attempt-b` but `threadId: thread-1`. Both B's origin lookup and current B target are valid. The endpoint calls App Server a third time on thread-1 with only the usage-resume prompt. The fake App Server records that this resumed thread sees candidate A. The endpoint still returns completed, accepted=true, valid=true, verdict=pass with B's target identity. The probe expects pre-execution rejection; actual status is completed (3) instead of failed (4).

This is an origin/thread correlation gap in the direct repair, not a target lookup error. `originatingReviewTarget` checks attempt, role, checkpoint, run and target, but it only returns the target. `callRun` independently trusts `continuation.threadId`; no binding to the selected origin is checked. The acceptance of an A-context report as a B receipt is the concrete contract violation. The ability to supply arbitrary thread IDs predates this patch; this finding is an unmet AUT-02 stale-context guarantee, not a newly introduced API behavior. The normal lead graph copies thread metadata from its origin, but the direct service must validate its own request boundary, including late or independently submitted direct calls. A same-target continuation control is covered by the current named direct tests; this probe isolates mismatched thread identity after both A and B produced valid origins.

Actionable delta: validate continuation thread identity against trustworthy metadata of the exact originating attempt, or force a fresh thread when that binding cannot be established. Retain same-target usage continuation where the binding is proven. A matching lane or codexHome claim should receive equivalent correlation if it can resume old context.

Pitfall: A validated origin ID can be paired with independent continuation context fields unless their provenance is bound together.
