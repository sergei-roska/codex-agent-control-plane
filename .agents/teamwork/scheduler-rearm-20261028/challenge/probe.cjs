'use strict';
const assert = require('node:assert/strict');
const { TaskScheduler } = require('../../../../src/task-scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let now = 1000, serial = 0;
  const timers = new Map();
  const originalSet = global.setTimeout, originalClear = global.clearTimeout;
  global.setTimeout = (fn, delay) => { const timer = { id: ++serial, fn, delay, unref() {} }; timers.set(timer.id, timer); return timer; };
  global.clearTimeout = timer => timers.delete(timer.id);
  let ids = ['a', 'b'];
  const pending = {}, calls = { a: 0, b: 0 }, states = { a: 'submitted', b: 'submitted' };
  const store = {
    getObjective: () => ({ ownerGeneration: 0, controlRevision: 1, disposition: 'executing' }),
    listAttempts: () => ids.map(id => ({ attemptId: id, taskId: id, state: 'submitted' })),
    listClaims: () => ids.map(id => ({ attemptId: id, state: 'active', fencingToken: 1 })),
    projectCapacity: () => ({ workerLimit: 2, maxActiveTurns: 3, plannerReservedSlots: 1, active: 2 }),
  };
  const executor = { getAttempt: id => ({ state: states[id] }), poll: ({ attemptId: id }) => { calls[id]++; return new Promise(resolve => { pending[id] = resolve; }); } };
  const scheduler = new TaskScheduler({ store, executor, projectId: 'p', objectiveId: 'o', roles: ['engineer'], writerMode: 'isolated', now: () => now, pollIntervalMs: 200 });
  const fire = () => { assert.equal(timers.size, 1); const timer = [...timers.values()][0]; timers.delete(timer.id); timer.fn(); return timer.delay; };
  try {
    scheduler.start(); await tick(); assert.deepEqual(calls, { a: 1, b: 1 });
    pending.a({ state: 'submitted' }); scheduler.wake(); await tick();
    assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 200);
    now = 1100; pending.b({ state: 'submitted' }); scheduler.wake(); await tick();
    assert.equal([...timers.values()][0].delay, 100);
    now = 1199; fire(); await tick(); assert.equal([...timers.values()][0].delay, 1);
    scheduler.stop(); assert.equal(timers.size, 0); scheduler.start(); await tick(); assert.equal([...timers.values()][0].delay, 1);
    now = 1200; fire(); await tick(); assert.deepEqual(calls, { a: 2, b: 1 }); assert.equal([...timers.values()][0].delay, 100);
    now = 1300; fire(); await tick(); assert.deepEqual(calls, { a: 2, b: 2 }); assert.equal(timers.size, 0);
    pending.a({ state: 'submitted' }); scheduler.wake(); await tick(); assert.equal([...timers.values()][0].delay, 200);
    ids = ['b']; scheduler.wake(); await tick(); assert.equal(timers.size, 0); assert.equal(scheduler.nextPollAt.size, 0);
    pending.b({ state: 'unknown', reason: 'uncertain' }); await tick(); assert.equal(timers.size, 0); assert.equal(scheduler.parked.get('b'), 'uncertain');
    scheduler.wake(); await tick(); assert.deepEqual(calls, { a: 2, b: 2 }); assert.equal(timers.size, 0);
    console.log('PASS: multiple deadlines, in-flight exclusion, early callback, stop/restart, removal and unknown parking');
  } finally { scheduler.stop(); global.setTimeout = originalSet; global.clearTimeout = originalClear; }
})().catch(error => { console.error(error); process.exitCode = 1; });
