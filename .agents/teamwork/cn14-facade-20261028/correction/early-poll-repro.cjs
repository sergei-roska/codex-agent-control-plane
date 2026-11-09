'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const filename = path.join(root, 'test/task-scheduler.test.js');
const prefix = fs.readFileSync(filename, 'utf8').split("test('fills four engineer slots")[0];
const helper = new Module(filename, module);
helper.filename = filename;
helper.paths = Module._nodeModulePaths(path.dirname(filename));
helper._compile(`${prefix}
module.exports = { fixture, plan, task, scheduler, fakeExecutor };`, filename);
const { fixture, plan, task, scheduler, fakeExecutor } = helper.exports;
const test = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('early poll callback must rearm a future pending poll', async (t) => {
  const { db, store } = fixture();
  let now = 1000;
  let polls = 0;
  const timers = [];
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', () => {});
  plan(store, [task('early-poll')]);
  const executor = fakeExecutor({ poll: async () => { polls += 1; return { state: 'submitted' }; } });
  const runner = scheduler(store, executor, { now: () => now, pollIntervalMs: 200 });
  t.after(() => { runner.stop(); db.close(); });
  runner.start();
  await tick();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 200);
  now = 1199;
  timers[0].callback();
  await tick();
  const rearmed = Boolean(runner.timer);
  t.diagnostic(JSON.stringify({ now, timers: timers.length, timerPresent: rearmed,
    nextPollAt: [...runner.nextPollAt.entries()], polls, projection: runner.projection() }));
  now = 1200;
  await tick();
  assert.equal(polls, 0, 'no automatic poll remains scheduled');
  await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  assert.equal(polls, 1, 'manual due wake can still poll the preserved intent');
  assert.equal(rearmed, true, 'early timer left a submitted intent without any future poll');
});
