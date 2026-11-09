# Pre-turn review rejection recurrence repair

## Result

The lead recurrence guard no longer counts only a trusted, validated stale-origin A2A rejection as technical work. The recovery planner and recurrence accounting share `trustedEndpointRejection`, which requires `request_invalid`, `effects: none`, a `review_origin_stale` service boundary result, and a matching service review result with the expected policy, kind, checkpoint, rejected status, accepted=false, valid=false, and reason. Untrusted/malformed claims and failures with other effects remain counted. Recovery generation limits and freshness checks are unchanged.

A new current-target accepted receipt clears recurrence only for its own role/checkpoint/target when the exact current receipt is trusted and accepted. This qualification bypasses only the `verifier_pending` recovery-phase gate; latest receipt, repair guards, trusted outcome checks, and rejected-verifier checks remain enforced. The graph allows one planning turn for a batch containing new accepted progress, while preserving recurrence history for other checkpoints. A first accepted receipt still counts as an observation when there is no history to clear. When a genuine no-progress stop fires, recovery planning is skipped so it cannot emit queued events for assignments that are discarded.

## Verification

`node --test --test-name-pattern='fresh accepted verifier receipt|trusted pre-turn stale rejection|malformed stale endpoint claim|mixed batch one planning turn|current failed audit prevents earlier receipts|no-progress detection completes partial' test/lead-graph.test.js test/loop-guard.test.js` => 7 passed, 0 failed.

`node --test test/lead-graph.test.js test/loop-guard.test.js` => 309 passed, 0 failed.

## Changed task files

- `src/lead-graph.js`
- `src/loop-guard.js`
- `test/lead-graph.test.js`
- `test/loop-guard.test.js`

The shared checkout contains other concurrent dirty changes; they were preserved. No target source, service, model, or Git state was changed. Documentation remains with root per coordination.
