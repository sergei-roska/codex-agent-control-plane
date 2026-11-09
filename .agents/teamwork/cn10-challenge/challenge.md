# CN-10 challenge final rerun

Verdict: HOLDS
Status: complete
Scope expansion: none

Probe: `.agents/teamwork/cn10-challenge/probe.js`. Exact command from repository root: `node .agents/teamwork/cn10-challenge/probe.js`. Result: seven PASS, exit 0. The probe uses actual CandidateStore, CandidateReviewStore, BacklogStore, DeliveryEvents, disposable SQLite, and disposable copied Git metadata with two input files. No project Git mutation occurs.

The original failures are resolved: identical receipt replay across clock advance and SQLite reopen returns the first record; identical promotion replay returns its first record. Wrong claim, generation, provider context, thread, and settings facts remain rejected. Promotion event failure rolls back context, promotion, event, and reference.

The adapted race probes intercept the losing call's preflight SELECT, let that SELECT return its stale empty result, then run a winning public API call to full commit before the loser starts its immediate transaction. For receipt, the winner settles `passed` and the loser attempts `failed`; for promotion, the winner uses `{controller:'winner'}` and the loser uses `{controller:'loser'}`. Both losers throw the expected duplicate conflict. The winning row, candidate reference, and event remain singular, and garbage collection retains each winning candidate.

Earlier `probe-prestructural.js` preserves the original addReference-hook reproduction that exposed the pre-transaction reference bug. It is no longer an acceptance probe: reference insertion now runs inside the outer transaction, so a winner nested in the same SQLite connection is a savepoint, not an independently committed transaction. Its rollback with the loser is expected. The adapted preflight injection tests an actually committed winner and the current ownership contract.

No further failure found in this bounded rerun.
