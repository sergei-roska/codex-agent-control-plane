# AD-08 budget controller rebind

Status: complete. Automatic budget transition and transition recovery now shut down and replace an existing controller after committing the new provider thread. A previously running controller is restarted with the committed binding; no owner resume or control revision is introduced. The replacement follows the existing quiescence checks and preserves identity validation.

Changed: src/concurrent-delivery-engine.js, test/concurrent-delivery-engine.test.js. Added deterministic active-controller planner-turn coverage for normal transition and recovery; both verify the new thread completes and control revision is unchanged.

Verification: `node --test --test-name-pattern='automatic budget (rebind|recovery)|due budget wait safely|owner (pause|cancel) during budget thread preparation|budget transition recovery handles' test/concurrent-delivery-engine.test.js` passed 7/7. An earlier test fixture attempt failed because its persisted lead identity was not set to account A; corrected fixture passed.

No live provider or runtime activation. Next: release-scenario owner reruns the integrated reproduction and reviews the shared diff.

Review correction: retire the quiescent old controller synchronously after commit, release the transition gate in `finally`, then create and start the replacement. A replacement failure leaves the committed binding intact and the gate released. Both active-controller regressions now assert that planner dispatch observes no active transition gate.

Verification after correction: `node --test --test-name-pattern='automatic budget (rebind|recovery)|due budget wait safely|owner (pause|cancel) during budget thread preparation|budget transition recovery handles' test/concurrent-delivery-engine.test.js` passed 7/7.
