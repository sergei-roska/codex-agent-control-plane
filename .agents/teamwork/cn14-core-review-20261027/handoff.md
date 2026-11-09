# CN14 core milestone 1 independent review

Verdict: REJECT for milestone 1 as of 2026-10-27. Whole CN14 was not reviewed.

Evidence (ran): `env -u NODE_TEST_CONTEXT node --test test/concurrent-delivery-engine.test.js` passed 1/1 using disposable Git/SQLite/authenticated private role service and frozen host checks.

Evidence (ran): `env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-core-review-20261027/pin-probe.test.js` passed 1/1. The owned scratch probe changes `lead.model` from `test-model` to `mutated-model` inside fake AppServer `prepareThread`, then asserts acceptance, the actual `run` role model is `mutated-model`, and the persisted planner turn pins still say `test-model`. The scratch probe is disposable and may disappear.

Blocking finding: `src/concurrent-delivery-engine.js:435-448,472-475` snapshots lead settings before preparation but retains and later passes the mutable `this.leadRole`. `CodexAppServer.run` builds the turn request from the supplied role. A role configuration change during preparation thus executes a different model from the recorded planner settings and can still reach accepted finalization. Freeze/copy and validate the actual role used for preparation and every turn against the durable pinned settings; add a mutation regression.

Evidence (read): `src/concurrent-delivery-engine.js:1015-1018` returns static constructor account ID; `src/app-server-switch.js:55-70` compares only home. Account identity across preparation and execution is unverified in this review. Avoid claiming this pin accepted without a source-backed current account check.

Other milestone 1 criteria: real verifier/receipt/final host check path PASS in the basic integration fixture. Runnable-work/unknown-work closure guards are present in `src/backlog-store.js:1465-1507` and lifecycle shutdown; failure/retry variants remain unverified. Pause/correction/reopen/shutdown facade coverage belongs to the later full-core milestone and remains pending.

Reviewed source/test files were not changed; only this ignored handoff and owned scratch probe were written. No blocked Git probe, live model, account or shared service was used.
