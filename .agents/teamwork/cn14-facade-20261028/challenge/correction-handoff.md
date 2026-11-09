# Correction challenge

Verdict: HOLDS

Two scratch probes passed, 2 tests, 0 failures, using disposable in-memory SQLite fixtures and current repository helper definitions. No product, existing test, configuration, Git, or live service changes.

- mixed-goal.cjs claims old goal1 work, applies correction and explicitly plans and claims fresh goal2 work, expires both in the same recovery batch, settles both with exact no-effect proofs, and resumes. Old task remains blocked for replan; fresh task requeues and is the sole next claim; objective is not globally blocked.
- ack-rollback.cjs performs an actual acknowledgement write and then injects a synchronous acknowledgement failure. The correction and hook's transaction write roll back; independent pre-existing inbox and table history survive, and the correction is blocked with the injected reason. This probes a post-write transaction boundary, not direct manipulation of trusted authority.

Exact command:

env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' .agents/teamwork/cn14-facade-20261028/challenge/mixed-goal.cjs .agents/teamwork/cn14-facade-20261028/challenge/ack-rollback.cjs

Output: correction-probes.log. Scratch evidence is ignored and may disappear.

Frozen SHA256:
- src/backlog-store.js 50bb84a87e98f1a786aded81946eefd72d63470dda20090f21e3de11cc9db90b
- src/concurrent-delivery-engine.js ff9da23fec72d5072ac552b4381cab7f597ea16647afb604c16dc294b420a094
- src/project-delivery-controller.js 97512f0dafc2f590718d07eef3a051396d11f33a816c91d03b392f2619719a4f
- test/backlog-store.test.js d0363ebe48f1ac18150d3ccd053d1db07e0b9a7fa4681d646ba09c1a0ee937db
- test/concurrent-delivery-engine.test.js a325352f25c9525fa9274349f58c5da7839acf2eefc0567d76dd47502596128a
- test/project-delivery-controller.test.js f2bf88c8749f68f578ab4a6a2e5108bd126da8f76bdefb634420bcfc1ea1a834

Status: complete. Scope expansion: none.
