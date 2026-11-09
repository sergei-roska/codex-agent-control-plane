'use strict';
const assert = require('node:assert/strict');
const { CodexAppServer } = require('../../../src/codex-app-server');
const { isProcessGroupGone } = require('../../../src/process-quiescence');
(async () => {
  const identity = { pid: 40001, pgid: 40001, startTime: '100' };
  const timers = [];
  const signals = [];
  const client = new CodexAppServer({
    readProcessIdentityImpl: () => ({ ...identity }),
    killImpl: (pid, signal) => signals.push({ pid, signal }),
    clock: {
      now: () => 1000,
      setTimeout: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
      clearTimeout: () => {},
    },
  });
  const child = { pid: identity.pid, exitCode: null, signalCode: null, kill() { throw new Error('unexpected fallback'); } };
  const state = { child, generation: 1, identity, exited: false };
  client.child = child;
  client.generation = 1;
  client.childExited = false;
  client.currentChildState = state;
  client.childStates.set(child, state);
  await client.close();
  assert.equal(client.closed, true);
  assert.equal(client.childExited, true);
  assert.equal(state.exited, false, 'no real child exit was observed');
  assert.deepEqual(signals, [{ pid: -identity.pgid, signal: 'SIGTERM' }]);
  assert.ok(timers.some(timer => timer.delay === 1000), 'force kill remains scheduled after close returns');
  const alive = isProcessGroupGone(identity, {
    killImpl: () => {},
    fsImpl: { readFileSync: () => { throw new Error('leader stat unavailable'); } },
  });
  assert.equal(alive, false, 'answering group without leader stat is unproven');
  for (const [code, expected] of [['ESRCH', true], ['EPERM', false], ['EIO', false]]) {
    assert.equal(isProcessGroupGone(identity, { killImpl: () => { throw Object.assign(new Error(code), { code }); } }), expected);
  }
  console.log('PASS: close resolution and synthetic childExited do not prove group absence; only ESRCH proves absence in these cases; permission and unknown errors deny');
})().catch(error => { console.error(error); process.exitCode = 1; });
