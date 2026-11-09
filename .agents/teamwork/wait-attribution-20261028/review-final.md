# V42 independent delta re-review

Verdict: REJECT
Blocking: src/delivery-visibility.js:26 - invalid ISO calendar endpoint is normalized into a measured duration.
Status: complete
Scope expansion: none

Reviewed only the delta to previously reviewed timing source and retained timing
test assertions, plus the current challenger probe. No broad suite or source edits.
Senior V14 source changes are concurrent; this is not a whole-source freeze.

PASS - Original missing timing-row ambiguity (read/ran).
The query now LEFT JOINs from all candidate intents, including intents whose
best-effort timing insert failed. Duplicate attempt IDs remain null even if one
or more timing records are absent. Original challenger missing-row case passes.

PASS - Original negative endpoint (read/ran).
elapsed requires finite nonnegative ordered numeric endpoints. Negative creation
timestamp produces null. Original challenger negative endpoint case passes.

FAIL - Invalid ISO calendar date (read/ran).
The new regex validates spelling, but Date.parse accepts 2026-02-30T00:00:00Z by
normalizing it to March 2. Against 2026-03-03T00:00:00Z the projection returns
86400000 ms rather than null. Current challenger probe asserts null and fails.
Checked mechanism: elapsed is the common timestamp converter for backlog, writer,
provider and settlement intervals, with no further endpoint validation wrapper.
The probe writes invalid persisted event evidence directly; this is a projection
correctness defect, not a demonstrated external input/security path.
Fix: reject invalid calendar components before accepting an ISO endpoint; retain
valid supported UTC/offset timestamps and unknown/old/ambiguous behavior. Keep
this non-leap-year February overflow regression in the retained test suite.

Independent run:
node --test --test-reporter=tap test/delivery-visibility.test.js test/launcher-backlog-ui.test.js .agents/teamwork/wait-attribution-20261028/challenge/probe.cjs
Result: exit 1; 17 tests, 16 passed, 1 failed. Both production test files pass;
three original challenge cases pass; the newly added fourth calendar case fails.
Evidence: review-final.tap. Probe changed since the worker's reported 3/3 run;
its current hash is recorded below, so that historical result is not contradicted.

Delta integrity: reconstructing the previous source in memory by reverting only
the ISO/nonnegative converter and LEFT JOIN gives SHA-256
e4de17fa1be7a988902dbba26f4fe53e980b3c4397260ccca85bdb5e32c93d8e,
exactly the previously approved visibility input. No other visibility source
delta is hidden in this re-review. Other wait-attribution sources/tests retain
previous approval evidence; their hashes are included, not broad re-review claims.

V42 bounded PASS remains provisional until this invalid-endpoint assertion passes.
V16 approval is unchanged. Whole milestone acceptance remains outside this delta.

SHA-256:
7012f980af378e378562eb315a471dc1cf4347738df742d5886a0fa4c7b88aaf  src/delivery-visibility.js
6105c068dddc6252e26f74cc98c70984f3f3bd44bba6bc9a6bb168b3309b2060  test/delivery-visibility.test.js
ebc9b0704624665f8fba636b968019cd945a3638058115c6706dacd43b41fcd6  src/candidate-store.js
1c39360f79a212453bdbab4a805b4957f684c360a36089a52cc8a2600ccdca1b  src/delivery-role-service.js
1f241b4a502c5d111d9bea6027875955fc094c333a9587f736f21de5aa9dae7d  launcher-ui/backlog.js
541a878d7ab261dca83a13f415beb427bf47e191e76b8f8473aae78b845254bc  test/launcher-backlog-ui.test.js
af7ae70e0d70072f42761f2c50c1e422c1c9126d58c9786907ffda8b24c8205c  .agents/teamwork/wait-attribution-20261028/challenge/probe.cjs
0ae45840c70c15029d0829585ba3e1d877155f2c5168a58bfc135ae301f93305  .agents/teamwork/wait-attribution-20261028/review-final.tap
