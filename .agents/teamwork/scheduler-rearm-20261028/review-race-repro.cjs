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
