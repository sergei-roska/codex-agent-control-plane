# Frozen full-run correction timeout diagnosis

No product source/test changes. Frozen correction source hashes remain unchanged.

Full verification reports1906 tests/1893 pass/12 fail/1 skip. Own direct-resume case
not ok489 timed out after7160.9ms at7s acceptance wait. Its snapshot proves correction
applied and current checkpoint closure known, but verifier attempt still running,
active claim1, scheduler inFlight[]/parked[], no receipt/finalization. It does not
record scheduler timer, nextPollAt, role execution, executor intent or poll evidence,
so the exact cause in that historical run cannot be established from it alone.

Exact isolated command (env -u NODE_TEST_CONTEXT prefix):
node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='owner correction facade carries pending correction through SQLite reopen with direct resume' test/concurrent-delivery-engine.test.js
full-failure-isolated.log:1 test/1 pass/0 fail,1006.2ms case duration. No increased
wait or altered fixture. Passing isolation does not establish a load-only flake.

Targeted source inspection found a concrete existing polling liveness defect in
src/task-scheduler.js #schedulePoll at214-225: callback clears timer; only due
nextPollAt entries become0; wake skips an entry still in future. No branch rearms
that future entry unless another attempt launch completes. Node timer callbacks can
run before wall-clock deadline; no minimum due check/rearm handles that boundary.
This code was not modified by correction repair.

Deterministic disposable probe:
node --test .agents/teamwork/cn14-facade-20261028/correction/early-poll-repro.cjs
(with env -u NODE_TEST_CONTEXT prefix). early-poll-repro.log:1 test/0 pass/1 fail.
It uses real BacklogStore and TaskScheduler plus isolated submitted fake executor,
controlled scheduler now and captured timeout callback. Deadline1200, callback1199:
- timer null, nextPollAt1200, scheduler running, active claim1,inFlight[],parked[];
- advancing now1200 alone leaves polls0, no timer exists;
- explicit runner.runOnce at due time polls the preserved submitted intent once;
- required future-timer assertion fails. This matches historical snapshot shape.
No real provider, external service, broad rerun or weakened uncertainty checks.

Conclusion: scheduler has a genuine lost-poll boundary; it is the leading explanation
for the full fixture timeout, not proven historical causality. Simply increasing the
fixture timeout would not fix the demonstrated stall. Request narrow authorization
for src/task-scheduler.js and test/task-scheduler.test.js to rearm pending future
polls when a callback is early. Source freeze preserved pending root decision.
