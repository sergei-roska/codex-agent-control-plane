'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { VERSION } = require('../src/delivery-contracts');
const { BacklogStore } = require('../src/backlog-store');
const { TaskScheduler, IDLE } = require('../src/task-scheduler');

const projectId = 'scheduler-project';
const objectiveId = 'scheduler-objective';
function objective(extra = {}) {
  return { projectId, objectiveId, sessionId: 'scheduler-session', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 1, controlRevision: 1, disposition: 'executing', ...extra };
}
function task(taskId, extra = {}) {
  return { schemaVersion: VERSION, projectId, objectiveId, taskId, revision: 1, role: 'engineer', kind: 'implementation', objective: `Implement ${taskId}`, priority: 0, dependencies: [], productWritePaths: [`src/${taskId}.js`], readScope: { kind: 'known', paths: [] }, scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued', ...extra };
}
function fixture({ roleCapacities = { engineer: 4, auditor: 2, explorer: 2 }, maxActiveTurns = 6, plannerReservedSlots = 1, storeOptions = {} } = {}) {
  const db = new Database(':memory:');
  const store = new BacklogStore(db, { roleCapacities, maxActiveTurns, plannerReservedSlots, ...storeOptions });
  store.createObjective(objective());
  return { db, store };
}
function plan(store, tasks) {
  const current = store.getObjective(projectId, objectiveId);
  return store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: current.planRevision, expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision, expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1, tasks: tasks.map((item) => ({ task: item })), dependencies: [] });
}
function scheduler(store, executor, extra = {}) {
  return new TaskScheduler({ store, executor, projectId, objectiveId, controllerIdentity: { ownerGeneration: 0, controlRevision: 1 }, roles: ['engineer', 'auditor', 'explorer'], writerMode: 'isolated', pollIntervalMs: 100000, ...extra });
}
function fakeExecutor({ execute, poll } = {}) {
  const intents = new Map();
  return {
    intents,
    getAttempt: (id) => intents.get(id) || null,
    execute: async (identity) => {
      const result = execute ? await execute(identity) : { state: 'submitted' };
      if (result.state === 'submitted') intents.set(identity.attemptId, { ...identity, state: 'submitted' });
      if (result.state === 'unknown') intents.set(identity.attemptId, { ...identity, state: 'uncertain' });
      return result;
    },
    reconcile: async (identity) => ({ state: 'unknown', reason: 'recovery_required', ...identity }),
    poll: async (identity) => poll ? poll(identity) : { state: 'submitted' },
  };
}

test('fills four engineer slots concurrently and preserves the reserved lead slot', async (t) => {
  const { db, store } = fixture({ maxActiveTurns: 5, plannerReservedSlots: 1 });
  t.after(() => db.close());
  plan(store, ['a', 'b', 'c', 'd', 'e'].map((id) => task(`task-${id}`)));
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const executor = fakeExecutor({ execute: async (identity) => { calls.push(identity.taskId); await barrier; return { state: 'submitted' }; } });
  const runner = scheduler(store, executor, { roles: ['engineer'], roleLimits: { engineer: 4 } });
  const result = await runner.runOnce();
  assert.equal(calls.length, 4);
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 4);
  assert.equal(result.idle.cause, null);
  release();
  await Promise.all([...runner.inFlight.values()]);
  const full = await runner.runOnce();
  assert.equal(full.idle.cause, IDLE.capacity);
  assert.equal(calls.length, 4);
  runner.stop();
});

test('fast sibling settlement unlocks its dependent while a slow sibling stays submitted', async (t) => {
  const { db, store } = fixture({ maxActiveTurns: 5, plannerReservedSlots: 1, storeOptions: { selectedSettingsResolver: () => ({ model: 'test-model' }) } });
  t.after(() => db.close());
  const predecessor = task('task-a', { productWritePaths: ['src/a.js'] });
  const slow = task('task-b', { productWritePaths: ['src/b.js'] });
  const dependent = task('task-d', { productWritePaths: ['src/d.js'], dependencies: [{ projectId, objectiveId, predecessorType: 'task', predecessorId: 'task-a', successorTaskId: 'task-d', kind: 'requires_output' }] });
  plan(store, [predecessor, slow, dependent]);
  const completed = new Set();
  let slowStarted = false;
  const started = [];
  const executor = fakeExecutor({
    execute: async (identity) => { started.push(identity.taskId); if (identity.taskId === 'task-b') slowStarted = true; return { state: 'submitted' }; },
    poll: async (identity) => {
      if (identity.taskId === 'task-b') return { state: 'submitted' };
      if (identity.taskId === 'task-a' && !completed.has('task-a')) {
        completed.add('task-a');
        store.settleAttempt(projectId, objectiveId, identity.attemptId, identity.fencingToken, { state: 'succeeded', trusted: true }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true });
        return { state: 'succeeded' };
      }
      return { state: 'submitted' };
    },
  });
  let clock = 0;
  const runner = scheduler(store, executor, { roles: ['engineer'], roleLimits: { engineer: 4 }, pollIntervalMs: 1000, now: () => clock });
  await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  clock = 1000;
  assert.equal(slowStarted, true);
  await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  assert.deepEqual(store.getObjective(projectId, objectiveId).tasks.map((item) => [item.taskId, item.state]), [['task-a', 'succeeded'], ['task-b', 'claimed'], ['task-d', 'claimed']]);
  assert.equal(started.includes('task-d'), true);
  assert.equal(store.listClaims(projectId, objectiveId).filter((claim) => claim.state === 'active').length, 2);
  runner.stop();
});

test('role subsets, paused controls, and conservative unknown attempts yield typed idle states', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  plan(store, [task('task-a', { role: 'auditor', productWritePaths: [], kind: 'audit' })]);
  const executor = fakeExecutor();
  const roleRunner = scheduler(store, executor, { roles: ['engineer'] });
  assert.equal((await roleRunner.runOnce()).idle.cause, IDLE.role);
  roleRunner.stop();

  const paused = store.requestControl(projectId, objectiveId, 'pause', 1);
  const pausedRunner = scheduler(store, executor, { roles: ['auditor'], controllerIdentity: { ownerGeneration: 0, controlRevision: paused.controlRevision } });
  assert.equal((await pausedRunner.runOnce()).idle.cause, IDLE.pause);
  pausedRunner.stop();
});

test('unknown attempts park durable capacity and do not repeat executor calls', async (t) => {
  const { db, store } = fixture({ roleCapacities: { engineer: 2 }, maxActiveTurns: 3, plannerReservedSlots: 1 });
  t.after(() => db.close());
  plan(store, [task('task-a'), task('task-b', { productWritePaths: ['lib/b.js'] })]);
  let calls = 0;
  const executor = fakeExecutor({ execute: async () => { calls += 1; return { state: 'unknown', reason: 'send_uncertain' }; } });
  const runner = scheduler(store, executor, { roles: ['engineer'], writerMode: 'shared' });
  await runner.runOnce();
  await Promise.resolve();
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  assert.equal(calls, 1);
  const next = await runner.runOnce();
  assert.equal(calls, 1);
  assert.equal(next.parked.length, 1);
  assert.equal(next.idle.cause, IDLE.writeConflict);
  runner.stop();
});

test('restart polls an existing submission without creating another send', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  plan(store, [task('task-a')]);
  const [claimed] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
  const identity = { projectId, objectiveId, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId, fencingToken: claimed.claim.fencingToken };
  let sends = 0;
  let polls = 0;
  const executor = fakeExecutor({ execute: async () => { sends += 1; return { state: 'submitted' }; }, poll: async () => { polls += 1; return { state: 'submitted' }; } });
  executor.intents.set(identity.attemptId, { ...identity, state: 'submitted' });
  const runner = scheduler(store, executor, { roles: ['engineer'] });
  await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  assert.equal(sends, 0);
  assert.equal(polls, 1);
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  runner.stop();
});

test('reduced role limits constrain future claims only', async (t) => {
  const { db, store } = fixture({ maxActiveTurns: 5, plannerReservedSlots: 1 });
  t.after(() => db.close());
  plan(store, ['a', 'b', 'c'].map((id) => task(`task-${id}`)));
  const calls = [];
  const executor = fakeExecutor({ execute: async (identity) => { calls.push(identity.taskId); return { state: 'submitted' }; } });
  const runner = scheduler(store, executor, { roles: ['engineer'], roleLimits: { engineer: 1 } });
  await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  assert.equal(calls.length, 1);
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  runner.stop();
});

test('role admission scans beyond the first 500 backlog entries', async (t) => {
  const { db, store } = fixture({ roleCapacities: { auditor: 501, engineer: 1 }, maxActiveTurns: 503, plannerReservedSlots: 1 });
  t.after(() => db.close());
  const auditors = Array.from({ length: 500 }, (_, index) => task(`audit-${String(index).padStart(3, '0')}`, {
    role: 'auditor', kind: 'audit', productWritePaths: [], readScope: { kind: 'known', paths: [] },
  }));
  plan(store, auditors);
  plan(store, [task('zzz-engineer-501')]);
  const calls = [];
  const runner = scheduler(store, fakeExecutor({ execute: async (identity) => { calls.push(identity.taskId); return { state: 'submitted' }; } }), {
    roles: ['engineer'], roleLimits: { engineer: 1 },
  });
  const result = await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  assert.deepEqual(calls, ['zzz-engineer-501']);
  assert.deepEqual(result.idle.claimed, ['zzz-engineer-501']);
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  runner.stop();
});

test('pause prevents a claimed no-intent startup send but still settles existing intent', async (t) => {
  const { db, store } = fixture({ roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 1 });
  t.after(() => db.close());
  plan(store, [task('task-new'), task('task-submitted', { productWritePaths: ['src/submitted.js'] })]);
  const claims = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, limit: 2 });
  const submitted = claims.find((item) => item.task.taskId === 'task-submitted');
  store.pinSelectedSettings(projectId, objectiveId, submitted.attempt.attemptId, submitted.claim.fencingToken, { model: 'test-model' });
  store.recordSubmitted(projectId, objectiveId, submitted.attempt.attemptId, submitted.claim.fencingToken, 'remote-submitted');
  const paused = store.requestControl(projectId, objectiveId, 'pause', 1);
  let sends = 0;
  let polls = 0;
  const executor = fakeExecutor({
    execute: async () => { sends += 1; return { state: 'submitted' }; },
    poll: async (identity) => {
      polls += 1;
      store.settleAttempt(projectId, objectiveId, identity.attemptId, identity.fencingToken, { state: 'failed' }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true });
      return { state: 'failed' };
    },
  });
  executor.intents.set(submitted.attempt.attemptId, {
    projectId, objectiveId, taskId: submitted.task.taskId, attemptId: submitted.attempt.attemptId,
    fencingToken: submitted.claim.fencingToken, state: 'submitted', externalTaskId: 'remote-submitted',
  });
  const runner = scheduler(store, executor, { roles: ['engineer'], controllerIdentity: { ownerGeneration: 0, controlRevision: paused.controlRevision } });
  const result = await runner.runOnce();
  await Promise.all([...runner.inFlight.values()]);
  assert.equal(result.idle.cause, IDLE.pause);
  assert.equal(sends, 0);
  assert.equal(polls, 1);
  assert.equal(store.listAttempts(projectId, objectiveId).find((attempt) => attempt.taskId === 'task-submitted').state, 'failed');
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  runner.stop();
});

test('concurrent schedulers enforce a reduced project ceiling inside atomic admission', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-runtime-cap-'));
  const file = path.join(directory, 'state.sqlite');
  const db1 = new Database(file);
  const db2 = new Database(file);
  db1.pragma('busy_timeout = 3000');
  db2.pragma('busy_timeout = 3000');
  const options = { roleCapacities: { explorer: 10 }, maxActiveTurns: 8, plannerReservedSlots: 1 };
  const store1 = new BacklogStore(db1, options);
  const store2 = new BacklogStore(db2, options);
  t.after(() => { db1.close(); db2.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  store1.createObjective(objective());
  const readOnly = (taskId) => task(taskId, { role: 'explorer', kind: 'inspection', productWritePaths: [], readScope: { kind: 'known', paths: [] } });
  plan(store1, Array.from({ length: 6 }, (_, index) => readOnly(`task-${index}`)));
  const sends = [];
  const executor = fakeExecutor({ execute: async (identity) => { sends.push(identity.taskId); return { state: 'submitted' }; } });
  const createRunner = (store) => scheduler(store, executor, {
    roles: ['explorer'], roleLimits: { explorer: 10 }, writerMode: 'shared',
    maxActiveTurns: 4, plannerReservedSlots: 1,
  });
  const runner1 = createRunner(store1);
  const runner2 = createRunner(store2);
  const original = store1.projectCapacity.bind(store1);
  let nestedRun;
  store1.projectCapacity = (...args) => {
    const staleProjection = original(...args);
    if (!nestedRun) nestedRun = runner2.runOnce();
    return staleProjection;
  };
  await runner1.runOnce();
  await nestedRun;
  await Promise.all([...runner1.inFlight.values(), ...runner2.inFlight.values()]);
  assert.equal(store1.projectCapacity(projectId, objectiveId).active, 3);
  assert.equal(sends.length, 3);
  runner1.stop();
  runner2.stop();
});
