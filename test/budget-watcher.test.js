'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createBudgetWatcher, extractBudgetBlockers, isBudgetAvailable, parseResetsAt } = require('../src/budget-watcher');

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

test('blocker extraction emits generic short and weekly windows with normalized reset hints', () => {
  const blockers = extractBudgetBlockers({
    rateLimits: {
      rateLimitReachedType: 'rate_limit_reached',
      primary: { resetsAt: 1_800_000_000 },
      secondary: { resetsAt: '2027-01-15T08:00:00.000Z' },
    },
  }, { accountIdHash: `sha256:${'a'.repeat(64)}`, provider: 'codex', models: ['gpt-6-luna'] });
  assert.deepEqual(blockers, [
    { accountIdHash: `sha256:${'a'.repeat(64)}`, provider: 'codex', model: 'gpt-6-luna',
      windowId: 'rate_limit_primary', reasonCode: 'rate_limit_reached', resetsAt: 1_800_000_000_000 },
    { accountIdHash: `sha256:${'a'.repeat(64)}`, provider: 'codex', model: 'gpt-6-luna',
      windowId: 'rate_limit_secondary', reasonCode: 'rate_limit_reached', resetsAt: Date.parse('2027-01-15T08:00:00.000Z') },
  ]);
});

test('blocker extraction scopes model-specific snapshots and excludes unrelated models', () => {
  const blockers = extractBudgetBlockers({ rateLimitsByLimitId: {
    luna: { normalModelSlug: 'gpt-6-luna', rateLimitReachedType: 'limited', primary: { resetsAt: 1800 } },
    other: { normalModelSlug: 'gpt-other', rateLimitReachedType: 'limited', primary: { resetsAt: 1900 } },
  } }, { accountIdHash: `sha256:${'b'.repeat(64)}`, provider: 'codex', models: MODELS });
  assert.deepEqual(blockers.map(({ model, windowId, resetsAt }) => ({ model, windowId, resetsAt })), [
    { model: 'gpt-6-luna', windowId: `limit_${createHash('sha256').update('luna').digest('hex').slice(0, 24)}_primary`, resetsAt: 1_800_000 },
  ]);
});

test('blocker extraction emits a source blocker for explicit no-window and ordinary blocks', () => {
  assert.deepEqual(extractBudgetBlockers({ rateLimits: { rateLimitReachedType: 'limited' } }, {
    accountIdHash: `sha256:${'c'.repeat(64)}`, provider: 'codex', models: ['gpt-6-luna'],
  }).map(({ windowId, reasonCode }) => ({ windowId, reasonCode })), [
    { windowId: 'rate_limit', reasonCode: 'rate_limit_reached' },
  ]);
  assert.deepEqual(extractBudgetBlockers({ ordinaryUsageAllowed: false }, {
    accountIdHash: `sha256:${'c'.repeat(64)}`, provider: 'codex', models: MODELS,
  }).map(({ model, windowId, reasonCode }) => ({ model, windowId, reasonCode })), [
    { model: MODELS[0], windowId: 'ordinary_usage', reasonCode: 'ordinary_usage_blocked' },
    { model: MODELS[1], windowId: 'ordinary_usage', reasonCode: 'ordinary_usage_blocked' },
  ]);
});

test('blocker extraction ignores reset-only, null, ambiguous, and unrelated responses', () => {
  const options = { accountIdHash: `sha256:${'d'.repeat(64)}`, provider: 'codex', models: MODELS };
  assert.deepEqual(extractBudgetBlockers({ rateLimits: { primary: { resetsAt: 1800, usedPercent: 100 } } }, options), []);
  assert.deepEqual(extractBudgetBlockers(null, options), []);
  assert.deepEqual(extractBudgetBlockers({ ordinaryUsageAllowed: null, rateLimits: { primary: { resetsAt: 1800 } } }, options), []);
  assert.deepEqual(extractBudgetBlockers({ rateLimitsByLimitId: {
    other: { normalModelSlug: 'gpt-other', rateLimitReachedType: 'limited' },
  } }, options), []);
});

test('blocker extraction validates identity, preserves source windows, and deduplicates exact records', () => {
  const accountIdHash = `sha256:${'e'.repeat(64)}`;
  const options = { accountIdHash, provider: 'codex', models: ['gpt-6-luna'] };
  assert.throws(() => extractBudgetBlockers({ ordinaryUsageAllowed: false }, { ...options, accountIdHash: 'bad' }), /account_hash/);
  assert.throws(() => extractBudgetBlockers({}, { ...options, provider: 'bad provider' }), /provider/);
  assert.throws(() => extractBudgetBlockers({}, { ...options, models: ['gpt-6-luna', 'gpt-6-luna'] }), /models/);
  const response = { rateLimitsByLimitId: {
    first: { normalModelSlug: 'gpt-6-luna', rateLimitReachedType: 'limited', primary: { resetsAt: 1800 } },
    second: { normalModelSlug: 'gpt-6-luna', rateLimitReachedType: 'limited', primary: { resetsAt: 1900 } },
  } };
  const blockers = extractBudgetBlockers(response, options);
  assert.deepEqual(blockers, extractBudgetBlockers(response, options));
  assert.equal(blockers.length, 2);
  assert.equal(new Set(blockers.map((blocker) => blocker.windowId)).size, 2);
  assert.ok(blockers.every((blocker) => blocker.windowId.endsWith('_primary')));
  assert.equal(new Set(blockers.map((blocker) => JSON.stringify([
    blocker.accountIdHash, blocker.provider, blocker.model, blocker.windowId,
  ]))).size, blockers.length);
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

test('only automatic budget and authentication pauses are registered', async () => {
  const { clock, watcher } = setup();
  watcher.notePause('r1', { kind: 'restart' });
  watcher.notePause('r2', { kind: 'human_decision' });
  watcher.notePause('r3', { kind: 'writer_unresolved' });
  watcher.notePause('r4', { kind: 'waiting_for_auth' });
  assert.equal(clock.pending(), 1);
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
  const listeners = new Set();
  const state = { active, selectionRevision: 0, autoSwitch, profiles: names.map((name) => ({ name, home: `/h/${name}` })) };
  const accounts = {
    profiles: {
      read: () => state,
      setActive: (name) => { log.setActive.push(name); state.active = name; state.selectionRevision += 1; },
    },
    switchTo: async (name, expected = {}) => {
      log.switchTo.push(name);
      if (state.active !== expected.active || state.selectionRevision !== expected.selectionRevision) return 'busy';
      if (switchResult === 'switched') {
        state.active = name;
        state.selectionRevision += 1;
      }
      return switchResult;
    },
    readProfileLimits: async (home) => { log.read.push(home); return limits[home === null ? 'system' : home] ?? BLOCKED; },
    ...(canSwitch ? { canSwitch } : {}),
    watch: (onChange) => {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
  };
  return { accounts, log, state, listeners, notify: () => { for (const fn of [...listeners]) fn(); } };
}

test('waiting_for_auth requires explicit authenticated state and authoritative model availability', async () => {
  const { accounts, log, state } = accountsSetup({ active: 'a', limits: { '/h/b': OK } });
  const auth = new Map([['/h/a', true], ['/h/b', true]]);
  const limitState = new Map([['/h/a', null], ['/h/b', OK]]);
  const reads = [];
  accounts.readProfileState = async (home) => {
    const key = home || 'system';
    reads.push(key);
    return { requiresOpenaiAuth: auth.get(key), limits: limitState.get(key) ?? null };
  };
  const { clock, calls, watcher } = setup({ accounts, switchDelayMs: 0 });
  watcher.notePause('auth-run', { kind: 'waiting_for_auth' });
  await clock.advance(0);
  assert.deepEqual(calls.resumes, [], 'available limits do not qualify an account that still requires authentication');
  assert.equal(watcher.status('auth-run').state, 'waiting');

  auth.set('/h/b', false);
  limitState.set('/h/b', null);
  await clock.advance(1000);
  assert.deepEqual(calls.resumes, [], 'an authenticated account with null limits remains unavailable');

  limitState.set('/h/b', OK);
  await clock.advance(1000);
  await clock.advance(5000);
  assert.deepEqual(log.setActive, []);
  assert.deepEqual(log.switchTo, ['b']);
  assert.deepEqual(calls.resumes, ['auth-run']);
  assert.deepEqual(reads.slice(0, 6), ['/h/a', '/h/b', 'system', '/h/a', '/h/b', 'system']);
  watcher.stop();
});

test('waiting_for_auth resumes the active profile after local sign-in even when auto-switch is off', async () => {
  const { accounts } = accountsSetup({ autoSwitch: false, active: 'a' });
  let authenticated = false;
  accounts.readProfileState = async () => ({ requiresOpenaiAuth: authenticated ? false : true, limits: authenticated ? OK : null });
  const { clock, calls, watcher } = setup({ accounts, switchDelayMs: 0 });
  watcher.notePause('auth-run', { kind: 'waiting_for_auth' });
  await clock.advance(0);
  assert.deepEqual(calls.resumes, []);
  authenticated = true;
  await clock.advance(1000);
  assert.deepEqual(calls.resumes, ['auth-run']);
  watcher.stop();
});

test('waiting_for_auth rejects an active profile result after owner selection changes during the read', async () => {
  const { accounts, state, log } = accountsSetup({ autoSwitch: false, active: 'a', names: ['a', 'b', 'c'] });
  let authenticated = false;
  let enterRead;
  const readStarted = new Promise((resolve) => { enterRead = resolve; });
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  accounts.readProfileState = async (home) => {
    if (authenticated) {
      enterRead();
      await readGate;
      return { requiresOpenaiAuth: false, limits: OK };
    }
    return { requiresOpenaiAuth: true, limits: null };
  };
  const { clock, calls, watcher } = setup({ accounts, switchDelayMs: 0 });
  watcher.notePause('auth-run', { kind: 'waiting_for_auth' });
  await clock.advance(0);
  assert.deepEqual(calls.resumes, []);
  authenticated = true;
  const nextCheck = clock.advance(1000);
  await readStarted;
  state.active = 'c';
  state.selectionRevision += 1;
  releaseRead();
  await nextCheck;
  assert.deepEqual(calls.resumes, [], 'a positive read for A must not authorize a resume on newly selected C');
  assert.equal(state.active, 'c');
  assert.deepEqual(log.switchTo, ['a'], 'the active candidate must pass through the revision-pinned wrapper too');
  watcher.stop();
});

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
  assert.deepEqual(log.setActive, []);
  assert.deepEqual(log.switchTo, ['b']);
  assert.deepEqual(calls.resumes, ['r1']);
  watcher.stop();
});

test('forget during an account switch prevents the run from resuming', async () => {
  const { accounts, log } = accountsSetup({ limits: { '/h/a': OK } });
  let signalSwitchStarted;
  const switchStarted = new Promise((resolve) => { signalSwitchStarted = resolve; });
  let releaseSwitch;
  accounts.switchTo = async (name) => {
    log.switchTo.push(name);
    signalSwitchStarted();
    await new Promise((resolve) => { releaseSwitch = resolve; });
    return 'switched';
  };
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });

  const advancing = clock.advance(1000);
  await switchStarted;
  watcher.forget('r1', { dropHistory: true });
  releaseSwitch();
  await advancing;

  assert.deepEqual(log.switchTo, ['a']);
  assert.deepEqual(calls.resumes, []);
  assert.equal(watcher.status('r1'), null);
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

test('switchTo busy retains the pause and does not resume before the account swap', async () => {
  const { accounts, log, state } = accountsSetup({ limits: { '/h/a': OK }, switchResult: 'busy' });
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.deepEqual(log.switchTo, ['a']);
  assert.deepEqual(log.setActive, []);
  assert.equal(state.active, null, 'a busy switch must not change the active profile');
  assert.deepEqual(calls.resumes, []);
  assert.equal(watcher.status('r1').state, 'waiting');
  watcher.stop();
});

test('budget switch failure preserves the prior active profile', async () => {
  const { accounts, state } = accountsSetup({ active: 'a', limits: { '/h/b': OK } });
  accounts.switchTo = async () => { throw new Error('switch failed'); };
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  await clock.advance(1000);
  assert.equal(state.active, 'a');
  assert.deepEqual(calls.resumes, []);
  watcher.stop();
});

test('auth switch failure preserves the prior active profile', async () => {
  const { accounts, state } = accountsSetup({ active: 'a', limits: { '/h/b': OK } });
  accounts.readProfileState = async (home) => ({
    requiresOpenaiAuth: home === '/h/a',
    limits: home === '/h/b' ? OK : null,
  });
  accounts.switchTo = async () => { throw new Error('switch failed'); };
  const { clock, calls, watcher } = setup({ accounts, switchDelayMs: 0 });
  watcher.notePause('auth-run', { kind: 'waiting_for_auth' });
  await clock.advance(0);
  assert.equal(state.active, 'a');
  assert.deepEqual(calls.resumes, []);
  watcher.stop();
});

test('a delayed busy switch preserves a newer owner profile selection', async () => {
  const { accounts, state } = accountsSetup({ active: 'a', names: ['a', 'b', 'c'], limits: { '/h/b': OK } });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  accounts.switchTo = async (name, expected) => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    if (state.active !== expected.active || state.selectionRevision !== expected.selectionRevision) return 'busy';
    return 'busy';
  };
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  const advancing = clock.advance(1000);
  await started;
  state.active = 'c';
  state.selectionRevision += 1;
  release();
  await advancing;
  assert.equal(state.active, 'c');
  assert.deepEqual(calls.resumes, []);
  watcher.stop();
});

test('a delayed switch failure preserves a newer owner profile selection', async () => {
  const { accounts, state } = accountsSetup({ active: 'a', names: ['a', 'b', 'c'], limits: { '/h/b': OK } });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let fail;
  accounts.switchTo = async () => {
    entered();
    await new Promise((resolve) => { fail = resolve; });
    throw new Error('delayed switch failure');
  };
  const { clock, calls, watcher } = setup({ accounts });
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  const advancing = clock.advance(1000);
  await started;
  state.active = 'c';
  state.selectionRevision += 1;
  fail();
  await advancing;
  assert.equal(state.active, 'c');
  assert.deepEqual(calls.resumes, []);
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

test('auto-switch on: a pause with a distant reset still switches within switchDelayMs', async () => {
  const { accounts, log } = accountsSetup({ active: 'a', limits: { '/h/b': OK } });
  const { clock, calls, watcher } = setup({ accounts, intervalMs: 5000, switchDelayMs: 300 });
  watcher.notePause('r1', { kind: 'waiting_for_budget', resetsAt: (T0 + 4 * 86_400_000) / 1000 });
  assert.equal(watcher.status('r1').nextCheckAt, T0 + 300);
  await clock.advance(300);
  assert.deepEqual(log.switchTo, ['b']);
  assert.deepEqual(calls.resumes, ['r1']);
  watcher.stop();
});

test('auto-switch off: the first check still follows resetsAt and nothing switches', async () => {
  const { accounts, log } = accountsSetup({ autoSwitch: false, limits: { '/h/a': OK } });
  const { clock, calls, watcher } = setup({ accounts, intervalMs: 100_000, switchDelayMs: 300 });
  watcher.notePause('r1', { kind: 'waiting_for_budget', resetsAt: (T0 + 50_000) / 1000 });
  assert.equal(watcher.status('r1').nextCheckAt, T0 + 50_100);
  await clock.advance(50_100);
  assert.deepEqual(log.switchTo, []);
  assert.deepEqual(calls.resumes, []);
  watcher.stop();
});

test('with accounts no scheduled delay exceeds intervalMs', async () => {
  const { accounts } = accountsSetup({ autoSwitch: false });
  const { watcher } = setup({ accounts, intervalMs: 1000 });
  watcher.notePause('r1', { kind: 'waiting_for_budget', resetsAt: (T0 + 4 * 86_400_000) / 1000 });
  assert.equal(watcher.status('r1').nextCheckAt, T0 + 1000);
  watcher.stop();
});

test('a profile change checks at once and resumes when the newly active account has budget', async () => {
  const { accounts, notify } = accountsSetup({ autoSwitch: false });
  const { clock, calls, watcher, setResponse } = setup({ accounts, intervalMs: 100_000 });
  await watcher.start();
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  setResponse(OK);
  notify();
  await clock.advance(499);
  assert.deepEqual(calls.resumes, []);
  await clock.advance(1);
  assert.deepEqual(calls.resumes, ['r1']);
  watcher.stop();
});

test('turning auto-switch on triggers a switch at once', async () => {
  const { accounts, log, state, notify } = accountsSetup({ autoSwitch: false, active: 'a', limits: { '/h/b': OK } });
  const { clock, calls, watcher } = setup({ accounts, intervalMs: 100_000 });
  await watcher.start();
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  state.autoSwitch = true;
  notify();
  await clock.advance(500);
  assert.deepEqual(log.switchTo, ['b']);
  assert.deepEqual(calls.resumes, ['r1']);
  watcher.stop();
});

test('several change events within the debounce window cause one check', async () => {
  const { accounts, notify } = accountsSetup({ autoSwitch: false });
  const { clock, calls, watcher } = setup({ accounts, intervalMs: 100_000 });
  await watcher.start();
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  notify();
  await clock.advance(200);
  notify();
  await clock.advance(200);
  notify();
  await clock.advance(500);
  assert.equal(calls.reads, 1);
  watcher.stop();
});

test('stop() unsubscribes from profile changes', async () => {
  const { accounts, listeners, notify } = accountsSetup({ autoSwitch: false });
  const { clock, calls, watcher } = setup({ accounts });
  await watcher.start();
  assert.equal(listeners.size, 1);
  watcher.notePause('r1', { kind: 'waiting_for_budget' });
  notify();
  watcher.stop();
  assert.equal(listeners.size, 0);
  await clock.advance(1000);
  assert.equal(calls.reads, 0);
});
