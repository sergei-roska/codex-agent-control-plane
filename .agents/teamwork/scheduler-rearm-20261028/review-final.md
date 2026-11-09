# Scheduler rearm delta re-review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

The blocking race from review.md is resolved. That report remains unchanged.

## Delta and invariant checks

Read: diff -u rejected-scheduler.js against src/task-scheduler.js, and
rejected-scheduler.test.js against test/task-scheduler.test.js. The only new
production changes preserve deadline metadata for inFlight claims and exclude
inFlight entries from timer selection. A native-Promise regression was added;
no existing assertions or verification were weakened.

Read: the result then callback can publish a future deadline before finally
removes inFlight. An intervening scan now preserves that deadline. Timer
selection excludes that attempt until finally wakes a fresh scan, so the same
change prevents both premature polling and timers repeatedly firing during a
pending poll. Claims missing from the current snapshot and parked attempts are
still pruned. Unknown results park rather than requesting another scan; settled
results delete deadlines. Admission, control checks, effect fences, and stop
handling have no additional delta.

## Independent verification

Ran:

```
env -u NODE_TEST_CONTEXT node --test test/task-scheduler.test.js test/task-executor.test.js
```

Result: exit 0, 44 tests passed, zero failures. Coverage includes early callback
rearm, due polling once, paused submitted settlement, concurrent admission,
stale/parked pruning, submitted-to-unknown, and the new Promise completion race.

Ran the exact previously preserved standalone reproducer:

```
node < .agents/teamwork/scheduler-rearm-20261028/review-race-repro.cjs
```

Result: exit 0, polls=1 at now=1000, retained deadline=1200. Previously rejected
source produced polls=2 with this same reproducer, recorded in review.md.

Independently ran the retained regression against the rejected candidate:

```
env -u NODE_TEST_CONTEXT node --require ./.agents/teamwork/scheduler-rearm-20261028/load-rejected.cjs --test --test-name-pattern='a wake during submitted poll completion preserves its future deadline' test/task-scheduler.test.js
```

Result: exit 1, one expected failure, actual polls=2 versus expected polls=1.
This validates the regression's sensitivity to the rejected implementation.

Read Git diff/status evidence from the initial review and refreshed Git diff.
Ran source-start.json SHA-256 comparison: only assigned source/test differ among
baseline inputs. Final reviewed SHA-256:

- src/task-scheduler.js: 423c7f7f42b476bb44160debf8b93c292ba028583e7ddf8a71e3c9d77c7bd113
- test/task-scheduler.test.js: 1b478cb5692cca24766062e35993cd8b6978b844962fe6c0db7975bb684c9be1

No full-suite or delivery-acceptance command was run; the prohibited hostile Git
filter test was not run. No source, tests, fixtures, Git state, live services,
or providers were modified by this review. Local coordination evidence is
ignored and may disappear.
