'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBudgetWatcher, isBudgetAvailable, parseResetsAt } = require('../src/budget-watcher');

const MODELS = ['gpt-6-luna', 'gpt-6.1-sol'];
const T0 = 1_800_000_000_000;

function fakeClock() {
  let time = T0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: time + ms });
      return { id, unref() {} };
    },
    clearTimeout(handle) { if (handle) timers.delete(handle.id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      time = target;
    },
  };
}

const OK = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: null };
const BLOCKED = { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' }, rateLimitsByLimitId: null };

function setup(overrides = {}) {
  const clock = fakeClock();
  const calls = { reads: 0, resumes: [] };
  let response = BLOCKED;
  const options = {
    models: MODELS,
    clock,
    listPausedRuns: async () => [],
    readRateLimits: async () => { calls.reads += 1; return response; },
    resumeRun: async (runId) => { calls.resumes.push(runId); return true; },
    intervalMs: 1000,
    marginMs: 100,
    minRetryMs: 5000,
    maxBackoffMs: 8000,
    ...overrides,
  };
  const watcher = createBudgetWatcher(options);
  return { clock, calls, watcher, setResponse: (value) => { response = value; } };
}

test('availability: ordinaryUsageAllowed true needs no reached bucket', () => {
  assert.equal(isBudgetAvailable(OK, MODELS), true);
  assert.equal(isBudgetAvailable({ ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: 'x' } }, MODELS), false);
  assert.equal(isBudgetAvailable({ ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: null } }, MODELS), false);
  assert.equal(isBudgetAvailable(null, MODELS), false);
  assert.equal(isBudgetAvailable(undefined, MODELS), false);
});

test('availability: a null verdict is true only when no relevant bucket is reached, never from percentages', () => {
  const clean = { ordinaryUsageAllowed: null, rateLimits: { rateLimitReachedType: null, primary: { usedPercent: 100 } } };
  assert.equal(isBudgetAvailable(clean, MODELS), true);
  const reached = { ordinaryUsageAllowed: null, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: { a: { normalModelSlug: 'gpt-6-luna', rateLimitReachedType: 'rate_limit_reached' } } };
  assert.equal(isBudgetAvailable(reached, MODELS), false);
  assert.equal(isBudgetAvailable({ ordinaryUsageAllowed: null }, MODELS), false);
});

test('availability: only buckets of the run models (or without a model slug) count', () => {
  const other = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: { x: { normalModelSlug: 'gpt-other', rateLimitReachedType: 'rate_limit_reached' } } };
  assert.equal(isBudgetAvailable(other, MODELS), true);
  const mine = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: { x: { normalModelSlug: 'gpt-6.1-sol', rateLimitReachedType: 'rate_limit_reached' } } };
  assert.equal(isBudgetAvailable(mine, MODELS), false);
  const generic = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: { x: { normalModelSlug: null, rateLimitReachedType: 'rate_limit_reached' }, y: { rateLimitReachedType: 'rate_limit_reached' } } };
  assert.equal(isBudgetAvailable(generic, MODELS), false);
});

test('resetsAt accepts epoch seconds, epoch ms and ISO strings', () => {
  assert.equal(parseResetsAt(1_800_000_000), 1_800_000_000_000);
  assert.equal(parseResetsAt(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(parseResetsAt('1800000000'), 1_800_000_000_000);
  assert.equal(parseResetsAt('2027-01-15T08:00:00.000Z'), Date.parse('2027-01-15T08:00:00.000Z'));
  assert.equal(parseResetsAt('nonsense'), null);
  assert.equal(parseResetsAt(null), null);
});

for (const [label, make] of [
  ['seconds', (at) => Math.floor(at / 1000)],
  ['milliseconds', (at) => at],
  ['ISO string', (at) => new Date(at).toISOString()],
]) {
  test(`first check is at resetsAt plus margin (${label})`, async () => {
    const { clock, calls, watcher, setResponse } = setup({ intervalMs: 100_000 });
    setResponse(OK);
    const resetAt = T0 + 20_000;
    watcher.notePause('r1', { kind: 'waiting_for_budget', resetsAt: make(resetAt) });
    await clock.advance(20_000 + 99);
    assert.equal(calls.reads, 0);
    await clock.advance(2);
    assert.equal(calls.reads, 1);
    assert.deepEqual(calls.resumes, ['r1']);
  });
}

test('a past or missing resetsAt falls back to the interval', async () => {
  const { clock, calls, watcher } = setup();
  watcher.notePause('r1', { kind: 'waiting_for_budget', resetsAt: new Date(T0 - 60_000).toISOString() });
  watcher.notePause('r2', { kind: 'waiting_for_budget' });
  await clock.advance(999);
  assert.equal(calls.reads, 0);
  await clock.advance(2);
  assert.equal(calls.reads, 2);
});

test('an unavailable budget is rechecked every interval and resumes exactly once when available', async () => {
  const { clock, calls, watcher, setResponse } = setup();
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  await clock.advance(1000);
  await clock.advance(1000);
  assert.equal(calls.reads, 3);
  assert.equal(calls.resumes.length, 0);
  assert.equal(watcher.status('r1').state, 'waiting');
  setResponse(OK);
  await clock.advance(1000);
  assert.deepEqual(calls.resumes, ['r1']);
  await clock.advance(10_000);
  assert.equal(calls.resumes.length, 1);
  assert.equal(calls.reads, 4);
  assert.equal(watcher.status('r1'), null);
  assert.equal(clock.pending(), 0);
});

test('a quick re-pause after an automatic resume doubles the delay up to the cap, and a stable resume resets it', async () => {
  const { clock, calls, watcher, setResponse } = setup();
  setResponse(OK);
  const pause = { kind: 'waiting_for_budget' };
  watcher.notePause('r1', pause);
  await clock.advance(1000);
  assert.equal(calls.resumes.length, 1);
  // Re-pauses within minRetryMs (the executor forgets the run on resume first).
  watcher.forget('r1');
  watcher.notePause('r1', pause);
  assert.equal(watcher.status('r1').backoffMs, 2000);
  await clock.advance(1999);
  assert.equal(calls.resumes.length, 1);
  await clock.advance(2);
  assert.equal(calls.resumes.length, 2);
  watcher.forget('r1');
  watcher.notePause('r1', pause);
  assert.equal(watcher.status('r1').backoffMs, 4000);
  await clock.advance(4001);
  watcher.notePause('r1', pause);
  assert.equal(watcher.status('r1').backoffMs, 8000);
  await clock.advance(8001);
  watcher.notePause('r1', pause);
  assert.equal(watcher.status('r1').backoffMs, 8000);
  // A resume that holds for longer than minRetryMs resets the backoff.
  await clock.advance(8001);
  await clock.advance(6000);
  watcher.notePause('r1', pause);
  assert.equal(watcher.status('r1').backoffMs, 0);
  assert.equal(watcher.status('r1').nextCheckAt, clock.now() + 1000);
});

test('stop() clears timers and ignores later pauses', async () => {
  const { clock, calls, watcher } = setup();
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  watcher.notePause('r2', { kind: 'waiting_for_budget' });
  assert.equal(clock.pending(), 2);
  watcher.stop();
  assert.equal(clock.pending(), 0);
  watcher.notePause('r3', { kind: 'waiting_for_budget' });
  assert.equal(clock.pending(), 0);
  await clock.advance(10_000);
  assert.equal(calls.reads, 0);
});

test('forget() cancels the pending check', async () => {
  const { clock, calls, watcher, setResponse } = setup();
  setResponse(OK);
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  watcher.forget('r1');
  await clock.advance(5000);
  assert.equal(calls.reads, 0);
  assert.equal(watcher.status('r1'), null);
});

test('no resume when the resume callback reports the task left INPUT_REQUIRED', async () => {
  const { clock, calls, watcher, setResponse } = setup({ resumeRun: async () => false });
  setResponse(OK);
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.equal(watcher.status('r1'), null);
  await clock.advance(10_000);
  assert.equal(calls.reads, 1);
});

test('a failed resume keeps waiting and retries on the next interval', async () => {
  let attempts = 0;
  const { clock, watcher, setResponse } = setup({ resumeRun: async () => { attempts += 1; if (attempts === 1) throw new Error('boom'); return true; } });
  setResponse(OK);
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.equal(watcher.status('r1').state, 'waiting');
  await clock.advance(1000);
  assert.equal(attempts, 2);
  assert.equal(watcher.status('r1'), null);
});

test('only waiting_for_budget pauses are registered', async () => {
  const { clock, watcher } = setup();
  watcher.notePause('r1', { kind: 'restart' });
  watcher.notePause('r2', { kind: 'human_decision' });
  watcher.notePause('r3', { kind: 'writer_unresolved' });
  assert.equal(clock.pending(), 0);
});

test('start() registers the budget-paused runs listed by listPausedRuns', async () => {
  const { clock, calls, watcher, setResponse } = setup({
    listPausedRuns: async () => [{ runId: 'a', pause: { kind: 'waiting_for_budget' } }, { runId: 'b', pause: { kind: 'waiting_for_budget' } }],
  });
  setResponse(OK);
  await watcher.start();
  assert.equal(clock.pending(), 2);
  await clock.advance(1000);
  assert.deepEqual(calls.resumes.sort(), ['a', 'b']);
});

// ------------------------------------------------ automatic account switching

function accountsSetup({ autoSwitch = true, active = null, names = ['a', 'b'], limits = {}, switchResult = 'switched', canSwitch } = {}) {
  const log = { read: [], setActive: [], switchTo: [] };
  const state = { active, autoSwitch, profiles: names.map((name) => ({ name, home: `/h/${name}` })) };
  const accounts = {
    profiles: {
      read: () => state,
      setActive: (name) => { log.setActive.push(name); state.active = name; },
    },
    switchTo: async (name) => { log.switchTo.push(name); return switchResult; },
    readProfileLimits: async (home) => { log.read.push(home); return limits[home === null ? 'system' : home] ?? BLOCKED; },
    ...(canSwitch ? { canSwitch } : {}),
  };
  return { accounts, log, state };
}

test('auto-switch off: no other account is read and the run keeps waiting', async () => {
  const { accounts, log } = accountsSetup({ autoSwitch: false, limits: { '/h/a': OK } });
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.deepEqual(log.read, []);
  assert.deepEqual(calls.resumes, []);
  assert.equal(watcher.status('r1').autoSwitch, false);
  watcher.stop();
});

test('auto-switch on: the first available profile is chosen, set active, switched to and resumed at once', async () => {
  const { accounts, log } = accountsSetup({ active: 'a', names: ['a', 'b', 'c'], limits: { '/h/b': OK, '/h/c': OK } });
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.deepEqual(log.read, ['/h/b']);
  assert.deepEqual(log.setActive, ['b']);
  assert.deepEqual(log.switchTo, ['b']);
  assert.deepEqual(calls.resumes, ['r1']);
  watcher.stop();
});

test('status reports autoSwitch and the last switch', async () => {
  const { accounts } = accountsSetup({ limits: { '/h/a': OK } });
  const { clock, watcher } = setup({ accounts, resumeRun: async () => false });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  assert.equal(watcher.status('r1').autoSwitch, true);
  assert.equal(watcher.status('r1').lastSwitch, null);
  await clock.advance(1000);
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  const status = watcher.status('r1');
  assert.deepEqual({ from: status.lastSwitch.from, to: status.lastSwitch.to }, { from: null, to: 'a' });
  assert.equal(status.lastSwitch.at, T0 + 1000);
  watcher.stop();
});

test('the system account is the fallback after all profiles, and only when it is not active', async () => {
  const first = accountsSetup({ active: 'a', limits: { system: OK } });
  const one = setup({ accounts: first.accounts });
  one.watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await one.clock.advance(1000);
  assert.deepEqual(first.log.read, ['/h/b', null]);
  assert.deepEqual(first.log.switchTo, [null]);
  assert.deepEqual(one.calls.resumes, ['r1']);
  one.watcher.stop();

  const second = accountsSetup({ active: null, limits: {} });
  const two = setup({ accounts: second.accounts });
  two.watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await two.clock.advance(1000);
  assert.deepEqual(second.log.read, ['/h/a', '/h/b']);
  assert.deepEqual(two.calls.resumes, []);
  two.watcher.stop();
});

test('no account available: the next check lands at the earliest reset across accounts', async () => {
  const limits = {
    '/h/a': { ...BLOCKED, rateLimits: { rateLimitReachedType: 'x', primary: { resetsAt: (T0 + 1000 + 3_000_000) / 1000 } } },
    '/h/b': { ...BLOCKED, rateLimits: { rateLimitReachedType: 'x', primary: { resetsAt: (T0 + 1000 + 450) / 1000 } } },
  };
  const { accounts } = accountsSetup({ limits });
  const { clock, watcher } = setup({ accounts, intervalMs: 1000, marginMs: 100 });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  // Reset at +450 ms after the check, plus the 100 ms margin, beats the 1000 ms interval.
  assert.equal(watcher.status('r1').nextCheckAt, T0 + 1000 + 550);
  watcher.stop();
});

test('no known reset falls back to the regular interval', async () => {
  const { accounts } = accountsSetup({});
  const { clock, watcher } = setup({ accounts, intervalMs: 1000 });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.equal(watcher.status('r1').nextCheckAt, T0 + 2000);
  watcher.stop();
});

test('profile limits are cached for 60 s across runs and checks', async () => {
  const { accounts, log } = accountsSetup({ names: ['a'] });
  const { clock, watcher } = setup({ accounts, intervalMs: 1000 });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  watcher.notePause('r2', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  await clock.advance(1000);
  assert.deepEqual(log.read, ['/h/a']);
  await clock.advance(60_000);
  assert.equal(log.read.length >= 2, true);
  watcher.stop();
});

test('switchTo busy still resumes the run', async () => {
  const { accounts, log } = accountsSetup({ limits: { '/h/a': OK }, switchResult: 'busy' });
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.deepEqual(log.switchTo, ['a']);
  assert.deepEqual(calls.resumes, ['r1']);
  watcher.stop();
});

test('no switch happens while the run reports as active', async () => {
  const { accounts, log } = accountsSetup({ limits: { '/h/a': OK }, canSwitch: async () => false });
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.deepEqual(log.read, []);
  assert.deepEqual(log.switchTo, []);
  assert.deepEqual(calls.resumes, []);
  watcher.stop();
});
