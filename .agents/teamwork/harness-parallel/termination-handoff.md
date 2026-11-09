# HAR-02 no-progress termination handoff

Status: implementation complete; focused verification passed.

## Confirmed cause

`src/lead-graph.js:3742-3743` turns a settled no-progress loop detector pause into `escalate(..., 'loop_detected', ...)`, which records `humanRequest`. `afterVerify` at `src/lead-graph.js:4269-4275` routes that request to `human_input`; the run then waits for the owner to continue or change the goal even though the detector has already established repeated work without progress. This is the verified owner-continuation path to replace for settled no-progress detection. The separate invalid-decision correction loop at `src/lead-graph.js:2977` remains owner escalation.

## Existing safe foundation

Partial finishes already set `status:'completed'` with `goalAchieved:false` and checkpoint ledger in `src/lead-graph.js:3015-3016`; `accept` runs deterministic acceptance and `finish` reports `disposition:'partial'` after `finalizeLedger`. `src/partial-ledger.js` bounds ledgers at 40 entries, requires evidence for accepted entries, and downgrades accepted entries when acceptance is rejected or unverifiable. Current review gates require current valid receipts before a checkpoint can remain accepted.

## Scope and constraints

## Implementation and evidence

`verify` now converts a loop detector pause to a forced partial result only when the batch is settled, no writers remain unresolved, the run is not canceled or budget-limited, and no owner pause/request is active. Its ledger is computed from a snapshot containing the just-integrated outcomes and review obligations, so a latest failed audit cannot inherit an earlier acceptance. `afterVerify` reconciles unresolved writers before terminal acceptance. `accept` runs deterministic acceptance once for this stop reason and skips retry and pinned-check review dispatch. `finish` retains the normal acceptance result and partial disposition; it does not alter pins or accept unreviewed work.

The final text retains the detector checkpoint, attempt count, last bounded rounds and attempt references, and states that the goal was not achieved. Loop episode state retains only the last three references, so the text labels the round list as recent rather than implying it is exhaustive.

Focused command:

`node --test --test-name-pattern='current failed audit prevents|no-progress detection completes partial|unrelated implementation does not reset' test/lead-graph.test.js`

Result: 3 passed, 0 failed. This covers latest failed audit blocking an accepted checkpoint, deterministic partial stop without owner continuation, and the repaired regression where an unrelated implementation does not reset unchanged audit recurrence. The legacy test expected that unrelated write to clear recurrence; the scoped target is unchanged, so the accepted behavior is now partial at 4 sends with recurrence count 3 and no owner request. The test retains existing changed-target coverage separately.

Final graph-suite fixture corrections (test-only):

`node --test --test-name-pattern='parallelWriters submits a group together and the next group only after all of it finished|verifier test writes can settle a review, while product and unknown mutations cannot' test/lead-graph.test.js`

Result: 2 passed, 0 failed. Restored the parallel writer fixture's expected 4 submissions. The verifier broad-scope case now mutates the attested `src/review.test.js` path, so the target change is real and the positive final verification assertion remains intact; the negative product and unknown mutation assertions are unchanged.

No live service, session, or model actions were performed. Root owns the full suite and final review.
