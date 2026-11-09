# Terminal shutdown challenge

Verdict: HOLDS for the bounded probes below. No source, existing tests, fixtures,
configuration, Git state, live provider, or existing service was changed.
Ignored scratch evidence may disappear.

Independent probe `overlap.cjs`: two simultaneous callers share one held
provider close, both time out with concurrent_shutdown_unsafe, a second pair
shares the still-pending operation, and release permits both to complete without
a second provider close. A fresh host reopened on the same state transitions its
released phase to draining when newly fenced. Exit 0, PASS:

    env -u NODE_TEST_CONTEXT node .agents/teamwork/cn14-terminal-20261028/challenge/overlap.cjs

Independent probe `rejected-close.cjs`: provider close rejects, two close attempts
reject, the provider is called only once, and the durable phase stays
provider_closing even after another fence. Exit 0, PASS:

    env -u NODE_TEST_CONTEXT node .agents/teamwork/cn14-terminal-20261028/challenge/rejected-close.cjs

The rejected provider promise is retained permanently within that host; this
probe establishes safe retention, not eventual recovery after rejection. It does
not assert process absence or exercise a real child process. Existing independent
critic evidence covers process identity and final lifecycle guards; those were
not rerun by this challenge. No broad suite or prohibited candidate filter test
ran.

SHA-256 of frozen source:

    f2182cfef9df24484fe19020ac9ebbd27716ce090db8c75f8647ecc002d48346  src/delivery-role-service.js
    96e8c7fd09e693a22b8b81a143a7217621b34d847848e61beaaffdea7c5d9b91  src/task-executor.js
    1509274e3fd57b0330a0caf7183624269464f71ff012f32e8f9a56ba575c2d1d  src/concurrent-delivery-engine.js
    931777ea1ee27fc1286cc2db1798f80328dca4c42096d0e97aba25cc59ad3062  src/server.js
    04c7b14355e0d62b8306592aedbdffbf220e804cf10c158fb3f8c4d7499c4274  src/delivery-engine-router.js
    8bfb13e18d8b8ffd99e24cea8c1439a546226de744d794807ed84251d2277e7a  challenge/overlap.cjs
    7667ce6af5618802804d39723b5948cd7353d4ab1bc978b97ab1e1b97f2203f9  challenge/rejected-close.cjs

Status: complete
Scope expansion: none
