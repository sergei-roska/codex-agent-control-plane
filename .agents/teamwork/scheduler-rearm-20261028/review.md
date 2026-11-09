# Scheduler rearm review

Verdict: REJECT
Status: complete
Scope expansion: none

## Blocking finding

src/task-scheduler.js:127 (also line 114): Rebuilding nextPollAt discards a
newly published future deadline when the attempt is still inFlight. A submitted
poll result stores its next deadline in a Promise.then callback, while inFlight
is only cleared by the subsequent finally callback. An unrelated queued wake can
scan between these callbacks. It skips the inFlight attempt, replaces the map
with futurePolls, and loses the deadline. The finalizer then wakes the scheduler,
which polls immediately again at the same clock time.

Evidence: ran the native-Promise probe below against current source: polls=2 at
now=1000, although the first poll's submitted result requested deadline 1200.
The assertion failed. Ran the identical probe with the preserved original loaded
by load-original.cjs: polls=1, assertion passed. This is a new regression.

Fix: preserve eligible future deadlines through in-flight completion, or publish
the next deadline only after removing the matching inFlight entry. Add a retained
regression with a submitted resolution and an unrelated wake in the same turn.
Keep the existing stale/parked pruning and early-callback regression.

Mechanisms checked (read): wake queues a microtask, #launchAttempt publishes the
deadline in then and clears inFlight in finally, and no executor or controller
wrapper makes these two mutations atomic. Production controller methods call
scheduler.wake on pause, stop, resume, cancel, and planner/recovery events.
TaskExecutor.poll returns submitted for a nonterminal remote task; scheduler's
inFlight guard prevents overlap while pending but does not preserve its deadline.
The probe uses the public executor contract and native Promises without timer
mocking or changes to reviewed files.

## Independent checks

- Read git status, git diff --stat, and git diff for both assigned files. Both
  files are inherited untracked files, so their actual review deltas were read
  using diff -u against the preserved originals in this teamwork directory.
- Ran SHA-256 comparisons against source-start.json: only src/task-scheduler.js
  and test/task-scheduler.test.js differ among baseline inputs.
- Ran: env -u NODE_TEST_CONTEXT node --test test/task-scheduler.test.js test/task-executor.test.js
  Result: 43 tests passed, zero failures. This covers early rearm, due callback,
  resumed polling, stopped timer, stale and parked work, submitted-to-unknown,
  concurrent admission, sibling progress, and pause settlement.
- Read the complete source delta and added tests: no removed assertions,
  weakened checks, hardcoded production answers, or swallowed errors introduced.
- No full-suite or delivery-acceptance command was run. The prohibited hostile
  Git filter test was not run. No live service or provider was used.

## Reproducer

Run from repository root with node, then repeat with
node --require ./.agents/teamwork/scheduler-rearm-20261028/load-original.cjs.
Feed the following script on stdin in both runs:

```js
const { TaskScheduler } = require('./src/task-scheduler');
const assert = require('node:assert/strict');
const tick = () => new Promise(r => setImmediate(r));
(async () => {
  let resolvePoll;
  let polls = 0;
  const store = {
    getObjective: () => ({ ownerGeneration: 0, controlRevision: 1, disposition: 'executing' }),
    listAttempts: () => [{ attemptId: 'a', taskId: 't', state: 'submitted' }],
    listClaims: () => [{ attemptId: 'a', state: 'active', fencingToken: 1 }],
    projectCapacity: () => ({ workerLimit: 1, maxActiveTurns: 2, plannerReservedSlots: 1, active: 1 }),
  };
  const executor = {
    getAttempt: () => ({ state: 'submitted' }),
    poll: () => {
      polls++;
      return polls === 1
        ? new Promise(r => { resolvePoll = r; })
        : Promise.resolve({ state: 'submitted' });
    },
  };
  const runner = new TaskScheduler({
    store, executor, projectId: 'p', objectiveId: 'o', roles: ['engineer'],
    writerMode: 'isolated', now: () => 1000, pollIntervalMs: 200,
  });
  runner.start();
  await tick();
  resolvePoll({ state: 'submitted' });
  runner.wake();
  await tick();
  console.log(JSON.stringify({ polls, now: 1000, nextPollAt: [...runner.nextPollAt] }));
  runner.stop();
  assert.equal(polls, 1);
})().catch(e => { console.error(e); process.exitCode = 1; });
```

Pitfall: Promise result publication and finally cleanup are separate microtasks;
do not prune metadata merely because an attempt is still inFlight.

Evidence is in this ignored local coordination report and may disappear.

Preserved reproducer: review-race-repro.cjs (feed to node on stdin from repository
root so its relative require resolves correctly). Independent rerun logs:
review-race-current.log (exit 1, polls=2) and review-race-original.log (exit 0,
polls=1). Commands:

```
node < .agents/teamwork/scheduler-rearm-20261028/review-race-repro.cjs
node --require ./.agents/teamwork/scheduler-rearm-20261028/load-original.cjs < .agents/teamwork/scheduler-rearm-20261028/review-race-repro.cjs
```
