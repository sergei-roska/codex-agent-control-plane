'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DeliveryEngineRouter } = require('../src/delivery-engine-router');

const PROJECT = '0123456789';

function fixture(t, legacyEngine = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const calls = [];
  const legacy = { run: async (input) => { calls.push(['run', input]); return { status: 'ok' }; },
    resume: async (input) => { calls.push(['resume', input]); return { status: 'ok' }; }, ...legacyEngine };
  const router = new DeliveryEngineRouter({ db, projectId: PROJECT, legacyEngine: legacy });
  return { db, router, calls };
}

test('router awaits asynchronous legacy resumability and preserves its boolean result', async (t) => {
  const { router } = fixture(t, { isResumable: async (runId) => runId === 'resumable-run' });
  assert.equal(await router.isResumable('resumable-run'), true);
  assert.equal(await router.isResumable('closed-run'), false);
});

test('replaying a mapped run with a partial intake cannot erase persisted contract or context', async (t) => {
  const { router, calls } = fixture(t);
  const contract = { requiredChecks: [{ id: 'unit', argv: ['node', 'verify.js'] }] };
  await router.run({ runId: 'mapped-run', goal: 'Keep the owner goal.', contract, contextId: 'provider-context' });
  await router.run({ runId: 'mapped-run', contract });
  assert.deepEqual(router.mapping('mapped-run').request, { goal: 'Keep the owner goal.', contract, contextId: 'provider-context' });
  assert.equal(calls.length, 2);
});

test('a mapped run rejects provider context drift', async (t) => {
  const { router, calls } = fixture(t);
  const contract = { requiredChecks: [] };
  await router.run({ runId: 'mapped-run', goal: 'Keep the owner goal.', contract, contextId: 'original-context' });
  await assert.rejects(router.run({ runId: 'mapped-run', contextId: 'other-context' }),
    { code: 'run_intake_conflict' });
  assert.equal(calls.length, 1);
});

test('immutable intake preserves omitted newRequest and routes stored values', async (t) => {
  const { router, calls } = fixture(t);
  await router.run({ runId: 'mapped-run', goal: 'Goal', newRequest: 'original follow-up' });
  await router.run({ runId: 'mapped-run', goal: 'Goal' });
  assert.equal(router.mapping('mapped-run').request.newRequest, 'original follow-up');
  assert.equal(calls[1][1].newRequest, 'original follow-up');
});

test('explicit null and changed immutable values reject before mutation or engine calls', async (t) => {
  let tick = 100;
  const { db, router, calls } = fixture(t);
  const originalNow = router.now;
  router.now = () => ++tick;
  await router.run({ runId: 'mapped-run', goal: 'Goal', newRequest: 'follow-up', contextId: 'ctx-a' });
  const before = router.mapping('mapped-run');
  const eventCount = db.prepare('SELECT COUNT(*) AS count FROM delivery_run_engines').get().count;
  for (const value of [null, 'different']) {
    await assert.rejects(router.run({ runId: 'mapped-run', newRequest: value }), { code: 'run_intake_conflict' });
  }
  await assert.rejects(router.run({ runId: 'mapped-run', goal: null }), { code: 'run_intake_conflict' });
  const after = router.mapping('mapped-run');
  assert.deepEqual(after, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM delivery_run_engines').get().count, eventCount);
  assert.equal(calls.length, 1);
  router.now = originalNow;
});

test('a normal first run pins omission for every immutable intake field', async (t) => {
  let tick = 200;
  const { router, calls } = fixture(t);
  router.now = () => ++tick;
  for (const [key, value] of [
    ['goal', 'added goal'],
    ['contract', { requiredChecks: [] }],
    ['contextId', 'added-context'],
    ['newRequest', null],
  ]) {
    const runId = `omitted-${key}`;
    await router.run({ runId });
    const before = router.mapping(runId);
    await assert.rejects(router.run({ runId, [key]: value }), { code: 'run_intake_conflict' });
    assert.deepEqual(router.mapping(runId), before);
  }
  assert.equal(calls.length, 4);
});

test('omitted contract and context preserve the complete pinned intake across SQLite reopen', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-router-'));
  const filename = path.join(directory, 'router.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstDb = new Database(filename);
  const calls = [];
  const legacy = { run: async (input) => { calls.push(input); }, resume: async () => {} };
  const first = new DeliveryEngineRouter({ db: firstDb, projectId: PROJECT, legacyEngine: legacy, now: () => 7 });
  const contract = { requiredChecks: [{ id: 'unit', argv: ['node', 'verify.js'] }] };
  await first.run({ runId: 'persisted-run', goal: 'Goal', contract, contextId: 'ctx-a', newRequest: 'next' });
  const initial = first.mapping('persisted-run');
  firstDb.close();
  const secondDb = new Database(filename);
  t.after(() => secondDb.close());
  const second = new DeliveryEngineRouter({ db: secondDb, projectId: PROJECT, legacyEngine: legacy, now: () => 99 });
  await second.run({ runId: 'persisted-run', goal: 'Goal' });
  assert.deepEqual(second.mapping('persisted-run').request, initial.request);
  assert.equal(second.mapping('persisted-run').updatedAt, initial.updatedAt);
  assert.deepEqual(calls[1].contract, contract);
  assert.equal(calls[1].contextId, 'ctx-a');
  assert.equal(calls[1].newRequest, 'next');
});

test('concurrent objective identity and required-check intake survive router reopen', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-router-concurrent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'state.sqlite');
  const contract = { requiredChecks: [{ id: 'source-check', argv: [process.execPath, 'verify.js'] }] };
  const calls = [];
  const concurrent = {
    async run(input) { calls.push(['run', input]); return { status: 'paused' }; },
    async resume(input) { calls.push(['resume', input]); return { status: 'paused' }; },
  };
  const legacy = { async run() { throw new Error('Unexpected legacy run'); }, async resume() { throw new Error('Unexpected legacy resume'); } };
  const firstDb = new Database(filename);
  const first = new DeliveryEngineRouter({ db: firstDb, projectId: PROJECT, defaultEngine: 'concurrent-v1',
    legacyEngine: legacy, concurrentEngine: concurrent, now: () => 11 });
  await first.run({ runId: 'objective-task-1', goal: 'Keep the initial owner goal.', contract, contextId: 'provider-context-1' });
  const original = first.mapping('objective-task-1');
  assert.equal(original.objectiveId, first.objectiveIdFor('objective-task-1'));
  assert.equal(original.sessionId, first.sessionIdFor('objective-task-1', 'provider-context-1'));
  firstDb.close();

  const secondDb = new Database(filename);
  t.after(() => secondDb.close());
  const reopened = new DeliveryEngineRouter({ db: secondDb, projectId: PROJECT, defaultEngine: 'legacy',
    legacyEngine: legacy, concurrentEngine: concurrent, now: () => 22 });
  await reopened.resume({ runId: 'objective-task-1' });
  assert.deepEqual(reopened.mapping('objective-task-1'), original);
  assert.deepEqual(calls[1][1], { runId: 'objective-task-1', objectiveId: original.objectiveId,
    sessionId: original.sessionId, engineMapping: original });
  assert.deepEqual(original.request, { goal: 'Keep the initial owner goal.', contract, contextId: 'provider-context-1' });
});

test('resume placeholder backfills once and retains the legacy engine after default changes', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const calls = [];
  const legacy = { run: async (input) => { calls.push(['legacy', input]); }, resume: async () => {} };
  const concurrent = { run: async (input) => { calls.push(['concurrent', input]); }, resume: async () => {} };
  const router = new DeliveryEngineRouter({ db, projectId: PROJECT, legacyEngine: legacy, now: () => 1 });
  await router.resume({ runId: 'placeholder' });
  const placeholder = router.mapping('placeholder');
  assert.equal(placeholder.engine, 'legacy');
  const changedDefault = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: 'concurrent-v1', legacyEngine: legacy,
    concurrentEngine: concurrent, now: () => 2 });
  await changedDefault.run({ runId: 'placeholder', goal: 'First intake', newRequest: 'follow-up' });
  const backfilled = changedDefault.mapping('placeholder');
  assert.equal(backfilled.engine, 'legacy');
  assert.deepEqual(backfilled.request, { goal: 'First intake', newRequest: 'follow-up' });
  assert.equal(backfilled.updatedAt, 2);
  await changedDefault.run({ runId: 'placeholder', goal: 'First intake' });
  assert.equal(changedDefault.mapping('placeholder').updatedAt, 2);
  assert.equal(calls.filter(([engine, input]) => engine === 'legacy' && input.goal).length, 2);
  assert.equal(calls.filter(([engine]) => engine === 'concurrent').length, 0);
});

test('runLegacy pins an old task to legacy but never overrides an existing mapping', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const legacyCalls = [];
  const concurrentCalls = [];
  const legacy = { run: async (input) => { legacyCalls.push(input); return { status: 'completed' }; }, resume: async () => ({ status: 'completed' }) };
  const concurrent = { run: async (input) => { concurrentCalls.push(input); return { status: 'completed' }; }, resume: async () => ({ status: 'completed' }) };
  const router = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: 'concurrent-v1', legacyEngine: legacy, concurrentEngine: concurrent });
  await router.runLegacy({ runId: 'preexisting-task', goal: 'Keep this legacy task on its original engine.' });
  assert.equal(router.mapping('preexisting-task').engine, 'legacy');
  await router.run({ runId: 'preexisting-task', goal: 'Keep this legacy task on its original engine.' });
  await router.run({ runId: 'new-concurrent-task', goal: 'New intake selects concurrent.' });
  await router.runLegacy({ runId: 'new-concurrent-task', goal: 'New intake selects concurrent.' });
  assert.equal(router.mapping('new-concurrent-task').engine, 'concurrent-v1');
  assert.equal(legacyCalls.length, 2);
  assert.equal(concurrentCalls.length, 2);
});

test('legacy recovery graph lookup follows the pinned engine', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const legacyGraph = { legacy: true };
  const legacy = { graph: legacyGraph, run: async () => ({}), resume: async () => ({}) };
  const concurrent = { run: async () => ({}), resume: async () => ({}) };
  const router = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: 'concurrent-v1', legacyEngine: legacy, concurrentEngine: concurrent });
  await router.runLegacy({ runId: 'legacy-recovery' });
  await router.run({ runId: 'concurrent-recovery' });
  assert.equal(router.getLegacyRecoveryGraph('legacy-recovery'), legacyGraph);
  assert.equal(router.getLegacyRecoveryGraph('concurrent-recovery'), null);
});

test('new concurrent intake is refused while the host publication fence is closed', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let calls = 0;
  const engine = { run: async () => { calls += 1; }, resume: async () => {} };
  const legacy = { run: async () => {}, resume: async () => {} };
  const router = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: 'concurrent-v1',
    legacyEngine: legacy, concurrentEngine: engine, canRunEngine: () => 'busy' });
  await assert.rejects(router.run({ runId: 'fenced-new-run', goal: 'Cannot overlap unknown legacy effects.' }),
    { code: 'delivery_engine_busy' });
  assert.equal(router.mapping('fenced-new-run'), null);
  assert.equal(calls, 0);
});

test('engine fence rejects a legacy downgrade before pinning and preserves an existing run mapping', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const legacyCalls = [];
  const concurrentCalls = [];
  const legacy = { run: async (input) => { legacyCalls.push(input); return {}; }, resume: async () => ({}) };
  const concurrent = { run: async (input) => { concurrentCalls.push(input); return {}; }, resume: async () => ({}) };
  const seed = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: 'concurrent-v1', legacyEngine: legacy, concurrentEngine: concurrent });
  await seed.run({ runId: 'stored-concurrent', goal: 'Pinned concurrent intake.' });
  const denied = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: 'legacy', legacyEngine: legacy,
    concurrentEngine: concurrent, canRunEngine: () => 'unsafe' });
  await assert.rejects(denied.run({ runId: 'new-legacy', goal: 'Must not overlap.' }), { code: 'delivery_engine_unsafe' });
  assert.equal(denied.mapping('new-legacy'), null);
  const before = denied.mapping('stored-concurrent');
  await assert.rejects(denied.runLegacy({ runId: 'stored-concurrent', goal: 'Changed intake.' }), { code: 'delivery_engine_unsafe' });
  assert.deepEqual(denied.mapping('stored-concurrent'), before);
  assert.equal(legacyCalls.length, 0);
  assert.equal(concurrentCalls.length, 1);
});
