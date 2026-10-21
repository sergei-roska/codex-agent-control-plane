'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  classifyTransientFailure,
  createTransientRecoveryStore,
  createTransientRecovery,
  MAX_ATTEMPTS,
} = require('../src/transient-recovery');
const { classifyFailure } = require('../src/codex-app-server');
const { waitForShutdownWork, SHUTDOWN_TOTAL_MS } = require('../src/server');

function clock(start = 1_800_000_000_000) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return { id, unref() {} }; },
    clearTimeout(handle) { if (handle) timers.delete(handle.id); },
    async advance(delay) {
      const end = now + delay;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function database(file = ':memory:') {
  const db = new Database(file);
  return { db, store: createTransientRecoveryStore(db) };
}

test('transient classification separates capacity, service, rate limit, quota, auth, configuration, and unknown', () => {
  const info = (value) => Object.assign(new Error('provider failure'), { codexError: { codexErrorInfo: value } });
  assert.deepEqual(classifyTransientFailure(new Error('Selected model is at capacity. Please try a different model.')), { category: 'capacity', eligible: true });
  assert.deepEqual(classifyTransientFailure(info({ httpConnectionFailed: { httpStatusCode: 503 } })), { category: 'service', eligible: true });
  assert.deepEqual(classifyTransientFailure(info('rateLimitExceeded')), { category: 'rate_limit', eligible: true });
  const rateLimitError = info('rateLimitExceeded');
  rateLimitError.failureClass = classifyFailure(rateLimitError);
  assert.equal(rateLimitError.failureClass, 'usage_limit');
  assert.deepEqual(classifyTransientFailure(rateLimitError), { category: 'rate_limit', eligible: true });
  assert.deepEqual(classifyTransientFailure(info({ httpConnectionFailed: { httpStatusCode: 429 } })), { category: 'quota', eligible: false });
  assert.deepEqual(classifyTransientFailure(info('usageLimitExceeded')), { category: 'quota', eligible: false });
  assert.deepEqual(classifyTransientFailure(info('unauthorized')), { category: 'auth', eligible: false });
  assert.deepEqual(classifyTransientFailure(info('badRequest')), { category: 'configuration', eligible: false });
  assert.deepEqual(classifyTransientFailure(new Error('network problem')), { category: 'unknown', eligible: false });
});

test('shutdown work stays within its shared bound and a late gate rejection is harmless after SQLite closes', async (t) => {
  const { db, store } = database();
  t.after(() => { if (db.open) db.close(); });
  const c = clock();
  let release;
  let dispatches = 0;
  const recovery = createTransientRecovery({
    store, clock: c,
    canResume: () => new Promise((resolve) => { release = resolve; }),
    resumeRun: async () => { dispatches += 1; return true; },
  });
  recovery.failure('shutdown-gate', { category: 'capacity', cause: 'capacity', checkpointId: 'cp-shutdown' });
  const pending = recovery.attempt('shutdown-gate');
  while (!release) await Promise.resolve();
  recovery.stop();
  const closing = (async () => {
    const started = Date.now();
    await waitForShutdownWork({ settled: async () => {} }, recovery, 20);
    assert.ok(Date.now() - started < 100);
    await db.close();
    assert.equal(recovery.acceptAutomatic('shutdown-gate', { attempt: 1, checkpointId: 'cp-shutdown' }), false);
    assert.equal(recovery.status('shutdown-gate'), null);
  })();
  await assert.doesNotReject(closing);
  assert.equal(SHUTDOWN_TOTAL_MS, 10_000);
  release(new Error('late gate failure'));
  assert.equal(await pending, false);
  assert.equal(dispatches, 0);
});

test('transient retry succeeds once and retains the selected checkpoint identity', async () => {
  const { db, store } = database();
  const c = clock();
  const resumed = [];
  const recovery = createTransientRecovery({
    store, clock: c, random: () => 0, baseDelayMs: 100, canResume: async () => true,
    resumeRun: async (id, record) => { resumed.push([id, record.checkpoint_id]); return true; },
  });
  const record = recovery.failure('run-a', { category: 'capacity', cause: 'Selected model is at capacity.', checkpointId: 'cp-a' });
  assert.equal(record.state, 'waiting');
  await c.advance(record.next_attempt_at - c.now());
  assert.deepEqual(resumed, [['run-a', 'cp-a']]);
  assert.equal(store.get('run-a').state, 'dispatched');
  assert.equal(await recovery.attempt('run-a'), false);
  assert.equal(resumed.length, 1);
  recovery.stop(); db.close();
});

test('a scheduler restart discovers durable backoff and resumes at its persisted time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transient-recovery-'));
  const file = path.join(dir, 'state.sqlite');
  const firstDb = database(file);
  const c = clock();
  const prior = createTransientRecovery({ store: firstDb.store, clock: c, random: () => 0, baseDelayMs: 100, canResume: async () => true, resumeRun: async () => true });
  const record = prior.failure('run-restart', { category: 'service', cause: '503', checkpointId: 'cp-r' });
  prior.stop(); firstDb.db.close();

  const secondDb = database(file);
  const resumed = [];
  const restarted = createTransientRecovery({ store: secondDb.store, clock: c, random: () => 0, baseDelayMs: 100,
    canResume: async (id, saved) => saved.checkpoint_id === 'cp-r', resumeRun: async (id) => { resumed.push(id); return true; } });
  restarted.start();
  await c.advance(record.next_attempt_at - c.now() - 1);
  assert.deepEqual(resumed, []);
  await c.advance(1);
  assert.deepEqual(resumed, ['run-restart']);
  restarted.stop(); secondDb.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('retry exhaustion is durable and owner cancellation removes a pending retry', async () => {
  const { db, store } = database();
  const c = clock();
  const resumed = [];
  const recovery = createTransientRecovery({ store, clock: c, random: () => 0, baseDelayMs: 10, maxAttempts: 2,
    canResume: async () => true, resumeRun: async (id) => { resumed.push(id); return true; } });
  recovery.failure('exhausted', { category: 'service', cause: 'first', checkpointId: 'cp-e' });
  recovery.markRunning('exhausted');
  const exhausted = recovery.failure('exhausted', { category: 'service', cause: 'second', checkpointId: 'cp-e' });
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(exhausted.attempts, 2);
  recovery.failure('stopped', { category: 'capacity', cause: 'capacity', checkpointId: 'cp-s' });
  recovery.forget('stopped');
  await c.advance(10_000);
  assert.deepEqual(resumed, []);
  assert.equal(store.get('stopped'), null);
  assert.equal(store.get('exhausted').state, 'exhausted');
  recovery.stop(); db.close();
});

test('owner pause suspends a waiting retry and canceling the pause makes the retry eligible again', async () => {
  const { db, store } = database();
  const c = clock();
  const resumed = [];
  const recovery = createTransientRecovery({ store, clock: c, random: () => 0, baseDelayMs: 100,
    canResume: async () => true, resumeRun: async (id) => { resumed.push(id); return true; } });
  recovery.failure('paused', { category: 'capacity', cause: 'capacity', checkpointId: 'cp-p' });
  assert.equal(recovery.pause('paused'), true);
  assert.equal(store.get('paused').state, 'owner_paused');
  await c.advance(10_000);
  assert.deepEqual(resumed, []);
  assert.equal(recovery.cancelPauseRequest('paused'), true);
  await c.advance(0);
  assert.deepEqual(resumed, ['paused']);
  recovery.stop(); db.close();
});

test('unknown writer effects fail the resume gate and never dispatch a second attempt', async () => {
  const { db, store } = database();
  const c = clock();
  let dispatches = 0;
  const recovery = createTransientRecovery({ store, clock: c, random: () => 0, baseDelayMs: 10,
    canResume: async () => false, resumeRun: async () => { dispatches += 1; return true; } });
  const record = recovery.failure('writer-unknown', { category: 'service', cause: '503', checkpointId: 'cp-w' });
  await c.advance(record.next_attempt_at - c.now());
  assert.equal(dispatches, 0);
  assert.equal(store.get('writer-unknown').state, 'manual');
  assert.equal(await recovery.attempt('writer-unknown'), false);
  assert.equal(dispatches, 0);
  recovery.stop(); db.close();
});

test('duplicate scheduling is serialized and failed message delivery consumes the retry bound', async () => {
  const { db, store } = database();
  const c = clock();
  let release;
  let calls = 0;
  const recovery = createTransientRecovery({ store, clock: c, random: () => 0, baseDelayMs: 10, maxAttempts: 2,
    canResume: async () => true,
    resumeRun: async () => { calls += 1; await new Promise((resolve) => { release = resolve; }); return false; },
  });
  const first = recovery.failure('delivery', { category: 'service', cause: '503', checkpointId: 'cp-d' });
  await c.advance(first.next_attempt_at - c.now());
  const duplicate = await recovery.attempt('delivery');
  assert.equal(duplicate, false);
  assert.equal(calls, 1);
  release();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(store.get('delivery').attempts, 2);
  assert.equal(store.get('delivery').state, 'exhausted');
  assert.equal(c.pending(), 0);
  recovery.stop(); db.close();
});

test('automatic recovery can remain disabled and unknown failures stay manual', () => {
  const { db, store } = database();
  const c = clock();
  const recovery = createTransientRecovery({ store, clock: c, canResume: async () => true, resumeRun: async () => assert.fail('must not resume') });
  const record = recovery.failure('manual-only', { category: 'capacity', cause: 'capacity', checkpointId: 'cp-m', enabled: false });
  assert.equal(record.state, 'manual');
  assert.equal(record.next_attempt_at, null);
  assert.equal(classifyTransientFailure(new Error('unrecognized failure')).eligible, false);
  recovery.start();
  assert.equal(c.pending(), 0);
  recovery.stop(); db.close();
  assert.equal(MAX_ATTEMPTS, 5);
});
