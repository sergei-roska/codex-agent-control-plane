# Scheduler repair worker handoff

Changed src/task-scheduler.js and test/task-scheduler.test.js. Scheduler scans active claims and retains only future deadlines for eligible submitted intents, resets the timer to the earliest retained deadline, and wakes on timer callback. Settled or parked attempts and stale deadlines cannot rearm polling. A due attempt is launched once; its completion schedules the next scan. Stop clears the timer.

Original source matched preserved task-scheduler.js SHA-256 d540edbf4fe13a3c7a3aa8b7a3eca6b5588704c4bc48d3ea56c32b1e005d02a4. The new retained regression was run against the preserved original via load-original.cjs, without replacing shared source:

env -u NODE_TEST_CONTEXT node --require ./.agents/teamwork/scheduler-rearm-20261028/load-original.cjs --test --test-name-pattern='early poll timer rearms and polls once at the deadline' test/task-scheduler.test.js

Result: 1 test, 0 pass, 1 expected failure at the missing rearm assertion. Evidence: retained-original.tap. The predecessor real-store repro also failed against matching original: original-repro.tap.

env -u NODE_TEST_CONTEXT node --test test/task-scheduler.test.js test/task-executor.test.js

Result: 43 tests, 43 pass, 0 fail; worker.tap. New tests cover early callback, exact due poll, resumed polling, stop, stale/parked deadlines, submitted poll becoming unknown, and no resend. Independent review and challenge remain pending. Evidence files are ignored local coordination artifacts and may disappear.

## Independent review repair

Review rejected the first candidate because a wake between native Promise result publication and inFlight cleanup discarded the new deadline and triggered an immediate second poll. Rejected source/test are preserved as rejected-scheduler.js and rejected-scheduler.test.js, SHA-256 1c3a434795a1118028d6e95249806b563ddb29a7afc22d6e4f6b5c345cf2d3f4 and 7f9b81de5223c118634cf367cd497552b9f5c88c40fd5b7cfa8d72e9a618e59a respectively. The repair retains in-flight deadlines but excludes them from timer selection; the finalizer wakes a fresh scan.

env -u NODE_TEST_CONTEXT node --require ./.agents/teamwork/scheduler-rearm-20261028/load-rejected.cjs --test --test-name-pattern='a wake during submitted poll completion preserves its future deadline' test/task-scheduler.test.js
Result: 1 expected failure, polls 2 instead of 1; retained-rejected.tap.

env -u NODE_TEST_CONTEXT node < .agents/teamwork/scheduler-rearm-20261028/review-race-repro.cjs
Result: exit 0, polls 1, deadline 1200.

env -u NODE_TEST_CONTEXT node --test test/task-scheduler.test.js test/task-executor.test.js
Result: 44 tests, 44 pass, 0 fail; worker.tap. Earlier 43-test result is superseded. Independent re-review and challenge pending.
