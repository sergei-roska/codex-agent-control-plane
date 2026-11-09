# CN-12 join handoff

Updated 2026-10-27. Status: implementation complete; root owns final qualification.

## Implemented

- Exported `finalizeCandidate` from `src/delivery-acceptance.js`.
- Validates acceptance contract digest/source/required IDs and request execution/scratch settings before opening the barrier.
- Calls the typed begin/barrier, start-check, record-result, commit transitions. Candidate pins come from the durable barrier. The existing runner is called directly; no runner implementation override is exposed through the production entrypoint.
- Terminal and ready records take the typed commit path, so commit replay gets fresh trusted authorization. Replays do not run checks. Concurrent callers are serialized by durable check state.
- Retained unknown runner context is recorded through `markFinalizationCheckUnknown`. An exception without retained proof propagates and leaves the record `checking`; a later invocation does not retry it. Trusted reconciliation remains the only reset path.
- Added real CandidateStore, CandidateReviewStore, BacklogStore, DeliveryLifecycle and acceptance join tests for accepted/replay, contract pins, concurrency, ready recovery, checking/unknown reopen, failed/tampered checks, stale control, and partial provenance.

## Verification

- `node --check src/delivery-acceptance.js && node --check test/delivery-acceptance-join.test.js` - passed.
- `env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/delivery-acceptance-join.test.js test/delivery-acceptance.test.js test/backlog-store.test.js` - 58 passed, 0 failed. The specifically prohibited hostile Git filter test was excluded.
- One earlier run had a new-test fixture failure in ready-state recovery because the helper included an unsupported `store` key in the adapter object. The fixture was corrected; its focused rerun and the final combined command passed.

## Limits / next action

No store API defect required scope expansion. Exceptions without retained workspace/control paths remain durably `checking` and require explicit trusted reconciliation. No hostile Git filter test, full suite, Git mutation, or live action was performed. Root retains final CN-12 acceptance decision and broader qualification.
