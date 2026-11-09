# Recovery goal source freeze

Changed src/backlog-store.js and test/backlog-store.test.js. Claims capture goal revision. Trusted no-effect recovery blocks stale goal or authority scope for explicit replanning, without technical retry exhaustion; missing legacy goal is accepted only at goal revision 1. Current control revision changes from pause/resume do not block same-goal retries. Cancellation remains final. Recovery proof checks and historical attempt contract and controls remain intact.

Before: node --test --test-name-pattern='no-effect recovery respects captured goal' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/backlog-store.test.js: 1 pass, 6 fail, including missing capture and stale recovery requeue. See before.log. After: node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/backlog-store.test.js test/task-executor.test.js test/delivery-lifecycle.test.js: 88 pass, 0 fail. See related.log. git diff --no-index --check against the source original: no whitespace errors.

Frozen SHA256: source 50bb84a87e98f1a786aded81946eefd72d63470dda20090f21e3de11cc9db90b; test d0363ebe48f1ac18150d3ccd053d1db07e0b9a7fa4681d646ba09c1a0ee937db. Original-relative source.diff cb8b51bd894227686d438c4b0862b26cc3f0ccc82dddd98103dad5862f911e1d; test.diff 7557cb109f3bbfac019844f9fc89dd75d07e176f871fff537ed09b067462358a. Originals and evidence are ignored local scratch and may disappear.

Next: independent critic review and real engine probe rerun. No self-acceptance.
