'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Worker } = require('node:worker_threads');
const { VERSION } = require('../src/delivery-contracts');
const { BacklogStore } = require('../src/backlog-store');

const projectId = 'project-alpha';
const objectiveId = 'objective-main';
const requirementDigest = `sha256:${'a'.repeat(64)}`;
const checksDigest = `sha256:${'b'.repeat(64)}`;
let tick = 1000;
function objective(extra = {}) {
  return { projectId, objectiveId, sessionId: 'session-main', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest, checksDigest, authorityRevision: 1, controlRevision: 1, disposition: 'executing', ...extra };
}
function task(taskId, extra = {}) {
  return { schemaVersion: VERSION, projectId, objectiveId, taskId, revision: 1, role: 'engineer', kind: 'implementation', objective: `Implement ${taskId}`, priority: 0, dependencies: [], productWritePaths: ['src/example.js'], readScope: { kind: 'unknown', paths: null, reason: 'Not established.' }, scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued', ...extra };
}
function delta(tasks = [], dependencies = [], revision = 0) {
  return { schemaVersion: VERSION, expectedPlanRevision: revision, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: revision + 1, tasks, dependencies: dependencies.map((item) => ({ schemaVersion: VERSION, ...item })) };
}
function fixture(file = ':memory:', options = {}) {
  const db = new Database(file);
  db.pragma('busy_timeout = 3000');
  const store = new BacklogStore(db, { now: () => tick++, roleCapacities: { engineer: 1, verifier: 1 }, maxActiveTurns: 3, plannerReservedSlots: 1, ...options });
  store.createObjective(objective(options.objectiveOverrides || {}), { checkpoints: options.checkpoints || [] });
  return { db, store };
}
function ownerCorrection(sourceMessageId, extra = {}) {
  return { sourceMessageId, expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: `sha256:${'c'.repeat(64)}`, ...extra };
}
function revisionedPlan(current, tasks) {
  return {
    schemaVersion: VERSION,
    expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision,
    expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision,
    nextPlanRevision: current.planRevision + 1,
    tasks,
    dependencies: [],
  };
}
function dep(predecessorId, successorTaskId, kind = 'requires_output', expectedOutput) {
  return { projectId, objectiveId, predecessorType: 'task', predecessorId, successorTaskId, kind, ...(expectedOutput ? { expectedOutput } : {}) };
}
function apply(store, tasks, dependencies = []) { return store.applyPlan(projectId, objectiveId, delta(tasks, dependencies, store.getObjective(projectId, objectiveId).planRevision)); }

test('two SQLite connections atomically claim one task and enforce role and project reservations', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-store-'));
  const file = path.join(directory, 'state.sqlite');
  const a = fixture(file, { now: () => 1000 });
  const { BacklogStore } = require('../src/backlog-store');
  const b = { db: new Database(file) };
  b.store = new BacklogStore(b.db, { now: () => 1000, roleCapacities: { engineer: 1, verifier: 1 }, maxActiveTurns: 3, plannerReservedSlots: 1 });
  t.after(() => { a.db.close(); b.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  apply(a.store, [{ task: task('task-a') }, { task: task('task-b') }, { task: task('task-c', { role: 'verifier' }) }]);
  // Calls are sequential at the JS boundary but contend on the same durable claim ledger.
  const first = a.store.claimReady(projectId, objectiveId, 0, { limit: 3, controlRevision: 1 });
  const second = b.store.claimReady(projectId, objectiveId, 0, { limit: 3, controlRevision: 1 });
  assert.equal(first.length + second.length, 2);
  assert.equal(a.store.projectCapacity(projectId, objectiveId).active, 2);
  assert.equal(a.store.projectCapacity(projectId, objectiveId).byRole.engineer.active, 1);
  assert.equal(new Set([...first, ...second].map((entry) => entry.task.taskId)).size, 2);
  assert.equal(new Set(a.store.events.replay(projectId).map((event) => event.eventId)).size, a.store.events.replay(projectId).length);
});

test('claim eligibility sees project resources added after an outside projection', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-eligibility-'));
  const file = path.join(directory, 'state.sqlite');
  const a = fixture(file, { roleCapacities: { engineer: 3, verifier: 1 }, maxActiveTurns: 5, plannerReservedSlots: 1 });
  const bDb = new Database(file);
  bDb.pragma('busy_timeout = 3000');
  const b = new BacklogStore(bDb, { roleCapacities: { engineer: 3, verifier: 1 }, maxActiveTurns: 5, plannerReservedSlots: 1 });
  t.after(() => { a.db.close(); bDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const resource = 'database:shared-schema';
  apply(a.store, [{ task: task('candidate', { resourceClaims: [resource] }) }]);
  const outsideProjection = a.store.listClaims(projectId, objectiveId);
  assert.equal(outsideProjection.length, 0);

  b.createObjective(objective({ objectiveId: 'objective-other' }));
  const other = task('other-owner', { objectiveId: 'objective-other', resourceClaims: [resource] });
  const otherDelta = { ...delta([{ task: other }]), expectedControlRevision: 1 };
  b.applyPlan(projectId, 'objective-other', otherDelta);
  assert.equal(b.claimReady(projectId, 'objective-other', 0, { controlRevision: 1 }).length, 1);

  let observedFrozenProjection = false;
  const claimed = a.store.claimReady(projectId, objectiveId, 0, {
    controlRevision: 1,
    canClaim(candidate, live) {
      assert.equal(Object.isFrozen(candidate), true);
      assert.equal(Object.isFrozen(candidate.resourceClaims), true);
      assert.equal(Object.isFrozen(live), true);
      assert.equal(Object.isFrozen(live[0].task), true);
      assert.deepEqual(live[0].task.resourceClaims, [resource]);
      observedFrozenProjection = true;
      return !live.some((entry) => entry.task.resourceClaims.includes(resource));
    },
  });
  assert.equal(observedFrozenProjection, true);
  assert.deepEqual(claimed, []);
  assert.equal(a.store.projectCapacity(projectId, objectiveId).active, 1);
});

test('claim eligibility rejects asynchronous and non-boolean results atomically', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('candidate') }]);
    assert.throws(() => store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, canClaim: () => Promise.resolve(true) }), { code: 'claim_eligibility_must_be_synchronous' });
    assert.equal(store.listClaims(projectId, objectiveId).length, 0);
    assert.throws(() => store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, canClaim: () => 1 }), { code: 'claim_eligibility_must_return_boolean' });
    assert.equal(store.listAttempts(projectId, objectiveId).length, 0);
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, canClaim: () => true }).length, 1);
  } finally { db.close(); }
});

test('two simultaneous SQLite claimers cannot reserve the same ready task', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-claim-race-'));
  const file = path.join(directory, 'state.sqlite');
  const { db, store } = fixture(file);
  apply(store, [{ task: task('task-race') }]);
  db.close();
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModule);
    const { BacklogStore } = require(workerData.backlogPath);
    const db = new Database(workerData.file);
    db.pragma('busy_timeout = 3000');
    const store = new BacklogStore(db, { roleCapacities: { engineer: 1, verifier: 1 }, maxActiveTurns: 3, plannerReservedSlots: 1 });
    parentPort.postMessage({ ready: true });
    parentPort.once('message', () => {
      try { parentPort.postMessage({ claimed: store.claimReady(workerData.projectId, workerData.objectiveId, workerData.generation, { controlRevision: 1 }).length }); }
      catch (error) { parentPort.postMessage({ error: error.message }); }
      db.close();
    });
  `;
  const workerOptions = { eval: true, workerData: { databaseModule: require.resolve('better-sqlite3'), backlogPath: path.resolve(__dirname, '../src/backlog-store.js'), file, projectId, objectiveId } };
  const workers = [new Worker(workerSource, { ...workerOptions, workerData: { ...workerOptions.workerData, generation: 0 } }), new Worker(workerSource, { ...workerOptions, workerData: { ...workerOptions.workerData, generation: 0 } })];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate().catch(() => {}))); fs.rmSync(directory, { recursive: true, force: true }); });
  await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message) => message.ready ? resolve() : reject(new Error(message.error || 'Worker was not ready')));
  })));
  workers.forEach((worker) => worker.postMessage('claim'));
  const results = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message) => message.error ? reject(new Error(message.error)) : resolve(message.claimed));
  })));
  assert.equal(results.reduce((sum, count) => sum + count, 0), 1);
  const verify = new Database(file);
  try {
    const claims = verify.prepare('SELECT COUNT(*) AS n FROM backlog_claims').get().n;
    assert.equal(claims, 1);
  } finally { verify.close(); }
});

test('plan CAS and dependency-cycle failures roll back tasks, revision, and events', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }, { task: task('task-b') }]);
    const beforeEvents = store.events.replay(projectId).length;
    const stale = delta([{ task: task('task-c') }], [], 0);
    assert.throws(() => store.applyPlan(projectId, objectiveId, stale), { code: 'plan_revision_stale' });
    const cycle = delta([
      { expectedRevision: 1, task: task('task-a', { revision: 2, dependencies: [dep('task-b', 'task-a')] }) },
      { expectedRevision: 1, task: task('task-b', { revision: 2, dependencies: [dep('task-a', 'task-b')] }) },
    ], [dep('task-b', 'task-a'), dep('task-a', 'task-b')], 1);
    assert.throws(() => store.applyPlan(projectId, objectiveId, cycle), { code: 'dependency_cycle' });
    assert.equal(store.getObjective(projectId, objectiveId).planRevision, 1);
    assert.equal(store.projectBacklog(projectId, { objectiveId, limit: 20 }).items.length, 2);
    assert.equal(store.events.replay(projectId).length, beforeEvents);
  } finally { db.close(); }
});

test('dependency readiness requires trusted settled output and explicit checkpoint evidence', () => {
  const { db, store } = fixture(':memory:', { checkpoints: [{ projectId, objectiveId, checkpointId: 'checkpoint-accepted' }], checkpointAccepted: (evidence) => evidence.checkpointId === 'checkpoint-accepted' });
  try {
    const successor = task('task-b', { dependencies: [dep('task-a', 'task-b', 'requires_output', 'output:v1'), { projectId, objectiveId, predecessorType: 'checkpoint', predecessorId: 'checkpoint-accepted', successorTaskId: 'task-b', kind: 'requires_acceptance' }] });
    apply(store, [{ task: task('task-a') }, { task: successor }]);
    assert.deepEqual(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).map((item) => item.task.taskId), ['task-a']);
    const claim = store.listClaims(projectId, objectiveId)[0];
    store.pinSelectedSettings(projectId, objectiveId, claim.attemptId, claim.fencingToken, { model: 'model-pinned', effort: 'high', fast: true });
    assert.equal(store.recordSubmitted(projectId, objectiveId, claim.attemptId, claim.fencingToken, 'remote-a').attempt.state, 'running');
    assert.equal(store.recordSubmitted(projectId, objectiveId, claim.attemptId, claim.fencingToken, 'remote-a').duplicate, true);
    assert.throws(() => store.recordSubmitted(projectId, objectiveId, claim.attemptId, claim.fencingToken, 'remote-b'), { code: 'external_task_conflict' });
    store.settleAttempt(projectId, objectiveId, claim.attemptId, claim.fencingToken, { state: 'succeeded', trusted: true, outputContract: 'output:v1' }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true });
    assert.deepEqual(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).map((item) => item.task.taskId), ['task-b']);
  } finally { db.close(); }
});

test('claimed contracts remain pinned, retries get distinct deterministic identities, and stale fences fail', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }]);
    const first = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 })[0];
    assert.equal(store.listAttempts(projectId, objectiveId)[0].contractSnapshot.objective, 'Implement task-a');
    assert.equal(first.attempt.capturedControls.selectedSettingsKnown, false);
    assert.throws(() => apply(store, [{ expectedRevision: 1, task: task('task-a', { revision: 2, objective: 'mutated' }) }]), { code: 'active_task_contract_immutable' });
    store.pinSelectedSettings(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, { model: 'pinned-model', effort: 'high', fast: false });
    const context = first.attempt.providerContextId;
    const failure = { state: 'failed', trusted: false };
    const quiescent = { remoteQuiescent: true, processQuiescent: true, effectsSettled: true };
    store.settleAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, failure, quiescent);
    assert.equal(store.settleAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, failure, quiescent).duplicate, true);
    assert.throws(() => store.settleAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, { state: 'canceled', trusted: false }, quiescent), { code: 'terminal_result_conflict' });
    // Retry policy is controller-owned; this explicit accepted plan requeues by a new revision.
    apply(store, [{ expectedRevision: 1, task: task('task-a', { revision: 2, state: 'queued' }) }]);
    const second = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 })[0];
    assert.notEqual(second.attempt.attemptId, first.attempt.attemptId);
    assert.notEqual(second.attempt.providerContextId, context);
    assert.throws(() => store.heartbeat(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken), { code: 'claim_inactive' });
    assert.throws(() => store.settleAttempt(projectId, objectiveId, second.attempt.attemptId, second.claim.fencingToken + 1, failure, quiescent), { code: 'fence_stale' });
  } finally { db.close(); }
});

test('plan projection materializes supersession state and merged dependency edges', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }, { task: task('task-b') }]);
    const replacement = task('task-c', { supersedesTaskId: 'task-a', dependencies: [dep('task-b', 'task-c')] });
    const result = apply(store, [{ expectedRevision: 1, task: replacement }], [dep('task-b', 'task-c')]);
    assert.equal(result.tasks.find((entry) => entry.taskId === 'task-a').state, 'superseded');
    assert.deepEqual(result.tasks.find((entry) => entry.taskId === 'task-c').dependencies.map((entry) => entry.predecessorId), ['task-b']);
    assert.equal(store.projectBacklog(projectId, { objectiveId, limit: 10 }).items.find((entry) => entry.taskId === 'task-a').state, 'superseded');
  } finally { db.close(); }
});

test('expired live or unknown attempts retain capacity until explicit quiescence', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }, { task: task('task-b') }]);
    const [first] = store.claimReady(projectId, objectiveId, 0, { leaseMs: 1, controlRevision: 1 });
    tick += 10;
    assert.equal(store.markExpired(projectId, objectiveId), 1);
    assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).length, 0);
    assert.throws(() => store.recordSubmitted(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, 'remote-late'), { code: 'claim_inactive' });
    assert.equal(store.listAttempts(projectId, objectiveId)[0].state, 'unknown');
    assert.throws(() => store.reconcileAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, { remoteQuiescent: false, processQuiescent: false, effectsSettled: false }), { code: 'quiescence_evidence_required' });
    assert.throws(() => store.reconcileAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true }), { code: 'terminal_result_required' });
    assert.equal(store.listAttempts(projectId, objectiveId)[0].state, 'unknown');
    assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
    store.reconcileAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, result: { state: 'failed', trusted: false } });
    assert.equal(store.projectCapacity(projectId, objectiveId).active, 0);
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).length, 1);
  } finally { db.close(); }
});

test('submission requires a bounded nonempty external identity before mutating the attempt', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }]);
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    store.pinSelectedSettings(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, { model: 'model-pinned' });
    for (const externalTaskId of [null, undefined, '', '   ', 'x'.repeat(257)]) {
      assert.throws(() => store.recordSubmitted(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, externalTaskId), { code: 'external_task_id_invalid' });
    }
    assert.equal(store.listAttempts(projectId, objectiveId)[0].state, 'claimed');
    assert.equal(store.listClaims(projectId, objectiveId)[0].state, 'active');
  } finally { db.close(); }
});

test('control CAS pauses future claims and rejects stale planner control revisions', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }]);
    store.requestControl(projectId, objectiveId, 'pause', 1);
    assert.throws(() => store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }), { code: 'control_revision_stale' });
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 2 }).length, 0);
    store.requestControl(projectId, objectiveId, 'resume', 2);
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 3 }).length, 1);
  } finally { db.close(); }
});

test('planning objectives may run ready tasks while owner control states remain barriers', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db);
    store.createObjective(objective({ disposition: 'planning' }));
    apply(store, [{ task: task('task-during-planning') }]);
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).length, 1);
  } finally { db.close(); }
});

test('failed claim event append rolls back task, attempt, claim, and capacity writes', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { now: () => tick++, roleCapacities: { engineer: 1 }, beforeEventInsert(event) { if (event.eventType === 'attempt.claimed') throw new Error('injected claim event failure'); } });
    store.createObjective(objective());
    apply(store, [{ task: task('task-a') }]);
    assert.throws(() => store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }), /injected claim event failure/);
    assert.equal(store.getObjective(projectId, objectiveId).tasks[0].state, 'queued');
    assert.equal(store.listClaims(projectId, objectiveId).length, 0);
    assert.equal(store.listAttempts(projectId, objectiveId).length, 0);
    assert.equal(store.projectCapacity(projectId, objectiveId).active, 0);
  } finally { db.close(); }
});

test('failed settlement event append rolls back terminal state and capacity release', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { now: () => tick++, roleCapacities: { engineer: 1 }, beforeEventInsert(event) { if (event.eventType === 'attempt.failed') throw new Error('injected settlement event failure'); } });
    store.createObjective(objective());
    apply(store, [{ task: task('task-a') }]);
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    assert.throws(() => store.settleAttempt(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, { state: 'failed', trusted: false }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true }), /injected settlement event failure/);
    assert.equal(store.listAttempts(projectId, objectiveId)[0].state, 'claimed');
    assert.equal(store.listClaims(projectId, objectiveId)[0].state, 'active');
    assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  } finally { db.close(); }
});

test('readiness and settlement reject truthy non-boolean controller facts', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { checkpointAccepted: () => 'accepted' });
    store.createObjective(objective(), { checkpoints: [{ projectId, objectiveId, checkpointId: 'checkpoint-a' }] });
    const checkpointTask = task('task-checkpoint', { dependencies: [{ projectId, objectiveId, predecessorType: 'checkpoint', predecessorId: 'checkpoint-a', successorTaskId: 'task-checkpoint', kind: 'requires_acceptance' }] });
    apply(store, [{ task: checkpointTask }]);
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).length, 0);
    const readyStore = new BacklogStore(db, { checkpointAccepted: () => true, roleCapacities: { engineer: 1 } });
    const [claim] = readyStore.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    assert.throws(() => readyStore.settleAttempt(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, { state: 'failed', trusted: false }, { remoteQuiescent: 'yes', processQuiescent: true, effectsSettled: true }), { code: 'quiescence_evidence_required' });
  } finally { db.close(); }
});

test('project backlog keyset cursor remains stable across objective identity collisions', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }, { task: task('task-b') }]);
    store.createObjective({ ...objective(), objectiveId: 'objective-next', sessionId: 'session-next' });
    store.applyPlan(projectId, 'objective-next', { ...delta([{ task: task('task-a', { objectiveId: 'objective-next' }) }]), expectedPlanRevision: 0, nextPlanRevision: 1 });
    const page1 = store.projectBacklog(projectId, { limit: 2 });
    const page2 = store.projectBacklog(projectId, { afterCursor: page1.nextCursor, limit: 2 });
    assert.equal(page1.items[0].taskId, 'task-a');
    assert.equal(page2.items[0].objectiveId, 'objective-next');
    assert.notEqual(page1.nextCursor, page2.nextCursor);
  } finally { db.close(); }
});

test('objective backlog nextCursor round-trips through afterCursor and afterTaskId remains supported', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }, { task: task('task-b') }, { task: task('task-c') }]);
    const first = store.projectBacklog(projectId, { objectiveId, limit: 1 });
    const second = store.projectBacklog(projectId, { objectiveId, afterCursor: first.nextCursor, limit: 1 });
    const legacy = store.projectBacklog(projectId, { objectiveId, afterTaskId: first.nextCursor, limit: 1 });
    assert.deepEqual(first.items.map((item) => item.taskId), ['task-a']);
    assert.deepEqual(second.items.map((item) => item.taskId), ['task-b']);
    assert.deepEqual(legacy.items.map((item) => item.taskId), ['task-b']);
  } finally { db.close(); }
});

test('project-wide worker capacity spans objectives but independent projects remain separate', () => {
  const { db, store } = fixture(':memory:', { maxActiveTurns: 2, plannerReservedSlots: 1 });
  try {
    apply(store, [{ task: task('task-a') }]);
    store.createObjective({ ...objective(), objectiveId: 'objective-next', sessionId: 'session-next' });
    store.applyPlan(projectId, 'objective-next', delta([{ task: task('task-b', { objectiveId: 'objective-next', role: 'verifier' }) }]));
    const { task: otherProjectTask, ...otherProject } = objective({ projectId: 'project-independent', objectiveId: 'objective-other', sessionId: 'session-other' });
    void otherProjectTask;
    store.createObjective(otherProject, { roleCapacities: { engineer: 1, verifier: 1 }, maxActiveTurns: 2, plannerReservedSlots: 1 });
    store.applyPlan('project-independent', 'objective-other', { ...delta([{ task: task('task-independent', { projectId: 'project-independent', objectiveId: 'objective-other' }) }]), expectedPlanRevision: 0, nextPlanRevision: 1 });
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).length, 1);
    assert.equal(store.claimReady(projectId, 'objective-next', 0, { controlRevision: 1 }).length, 0);
    assert.equal(store.claimReady('project-independent', 'objective-other', 0, { controlRevision: 1 }).length, 1);
  } finally { db.close(); }
});

test('owner generation fences old scheduler writes while recovery can settle with current generation evidence', () => {
  const { db, store } = fixture();
  try {
    apply(store, [{ task: task('task-a') }]);
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    tick += 40000;
    store.markExpired(projectId, objectiveId);
    store.advanceOwnerGeneration(projectId, objectiveId, 0);
    assert.throws(() => store.recordSubmitted(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, 'remote-stale'), { code: 'owner_generation_stale' });
    const settled = store.reconcileAttempt(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, recoveryGeneration: 1, result: { state: 'failed', trusted: false } });
    assert.equal(settled.attempt.state, 'failed');
  } finally { db.close(); }
});

test('derived attempt IDs are unambiguous when opaque identifiers contain colons', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { roleCapacities: { engineer: 2 }, maxActiveTurns: 4, plannerReservedSlots: 1 });
    store.createObjective(objective({ objectiveId: 'objective:a' }));
    store.createObjective(objective({ objectiveId: 'objective' }));
    store.applyPlan(projectId, 'objective:a', { ...delta([{ task: task('task', { objectiveId: 'objective:a' }) }]), expectedPlanRevision: 0, nextPlanRevision: 1 });
    store.applyPlan(projectId, 'objective', { ...delta([{ task: task('a:task', { objectiveId: 'objective' }) }]), expectedPlanRevision: 0, nextPlanRevision: 1 });
    const first = store.claimReady(projectId, 'objective:a', 0, { controlRevision: 1 })[0];
    const second = store.claimReady(projectId, 'objective', 0, { controlRevision: 1 })[0];
    assert.notEqual(first.attempt.attemptId, second.attempt.attemptId);
  } finally { db.close(); }
});

test('claim captures a digest from synchronous selected settings evidence', () => {
  const { db, store } = fixture(':memory:', { selectedSettingsResolver: ({ task: selectedTask }) => ({ model: 'model-pinned', effort: 'high', fast: true, role: selectedTask.role }) });
  try {
    apply(store, [{ task: task('task-settings') }]);
    const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    assert.equal(claim.attempt.capturedControls.selectedSettingsKnown, true);
    assert.notEqual(claim.attempt.selectedSettingsDigest, `sha256:${'0'.repeat(64)}`);
  } finally { db.close(); }
});

test('owner correction is authorized, CAS-bound, atomic, and blocks only unstarted work', () => {
  let authorizationCalls = 0;
  const { db, store } = fixture(':memory:', {
    ownerCorrectionAuthorized(input) {
      authorizationCalls += 1;
      assert.equal(Object.isFrozen(input), true);
      assert.deepEqual(Object.keys(input).sort(), ['correction', 'objectiveId', 'projectId', 'sourceMessageId']);
      assert.equal(input.sourceMessageId, 'owner-message-1');
      return true;
    },
  });
  try {
    apply(store, [{ task: task('terminal-task') }]);
    const [terminal] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
    store.pinSelectedSettings(projectId, objectiveId, terminal.attempt.attemptId, terminal.claim.fencingToken, { model: 'model-pinned' });
    store.settleAttempt(projectId, objectiveId, terminal.attempt.attemptId, terminal.claim.fencingToken, { state: 'failed', trusted: false }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true });

    const current = store.getObjective(projectId, objectiveId);
    store.applyPlan(projectId, objectiveId, revisionedPlan(current, [
      { task: task('draft-task', { state: 'draft' }) },
      { task: task('queued-task') },
      { task: task('ready-task') },
      { task: task('claimed-task', { priority: 100 }) },
      { task: task('running-task', { role: 'verifier', priority: 100 }) },
    ]));
    const ready = store.getObjective(projectId, objectiveId).tasks.find((item) => item.taskId === 'ready-task');
    const readyContract = { ...ready, state: 'ready' };
    db.prepare("UPDATE backlog_tasks SET state='ready',contract_json=? WHERE project_id=? AND objective_id=? AND task_id=?")
      .run(JSON.stringify(readyContract), projectId, objectiveId, 'ready-task');
    const claims = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, limit: 2 });
    const claimed = claims.find((item) => item.task.taskId === 'claimed-task');
    const running = claims.find((item) => item.task.taskId === 'running-task');
    assert.ok(claimed && running);
    store.pinSelectedSettings(projectId, objectiveId, running.attempt.attemptId, running.claim.fencingToken, { model: 'model-pinned' });
    store.recordSubmitted(projectId, objectiveId, running.attempt.attemptId, running.claim.fencingToken, 'remote-running');

    const beforeEvents = store.events.replay(projectId).length;
    const correction = ownerCorrection('owner-message-1');
    assert.equal(typeof correction, 'object');
    const corrected = store.applyOwnerCorrection(projectId, objectiveId, correction);
    assert.equal(corrected.goalRevision, 2);
    assert.equal(corrected.controlRevision, 2);
    assert.equal(corrected.authorityRevision, 1);
    assert.equal(corrected.requirementDigest, correction.requirementDigest);
    assert.equal(corrected.checksDigest, checksDigest);
    assert.equal(corrected.disposition, 'executing');
    assert.equal(corrected.planRevision, current.planRevision + 1);
    const byId = new Map(corrected.tasks.map((item) => [item.taskId, item]));
    for (const taskId of ['draft-task', 'queued-task', 'ready-task']) {
      assert.equal(byId.get(taskId).state, 'blocked');
      assert.equal(byId.get(taskId).revision, 1);
      assert.equal(byId.get(taskId).blockedReason, 'owner_correction_replan_required');
    }
    assert.equal(byId.get('claimed-task').state, 'claimed');
    assert.equal(byId.get('running-task').state, 'running');
    assert.equal(byId.get('terminal-task').state, 'failed');
    assert.equal(byId.get('queued-task').revision, 1);
    const correctionEvents = store.events.replay(projectId).filter((event) => event.eventType === 'objective.owner_correction');
    assert.equal(correctionEvents.length, 1);
    assert.equal(store.events.replay(projectId).length, beforeEvents + 1);

    const replay = store.applyOwnerCorrection(projectId, objectiveId, correction);
    assert.equal(replay.goalRevision, 2);
    assert.equal(store.events.replay(projectId).filter((event) => event.eventType === 'objective.owner_correction').length, 1);
    assert.throws(() => store.applyOwnerCorrection(projectId, objectiveId, { ...correction, requirementDigest: `sha256:${'d'.repeat(64)}` }), { code: 'owner_correction_source_conflict' });
    assert.equal(authorizationCalls, 3);

    const staleTask = { expectedRevision: 2, task: task('queued-task', { revision: 2, state: 'queued' }) };
    assert.throws(() => store.applyPlan(projectId, objectiveId, revisionedPlan(replay, [staleTask])), { code: 'task_revision_stale' });
    const explicitReplan = { expectedRevision: 1, task: task('queued-task', { revision: 2, state: 'queued', blockedReason: null }) };
    const replanned = store.applyPlan(projectId, objectiveId, revisionedPlan(replay, [explicitReplan]));
    assert.equal(replanned.tasks.find((item) => item.taskId === 'queued-task').state, 'queued');
    assert.equal(replanned.tasks.find((item) => item.taskId === 'queued-task').revision, 2);
  } finally { db.close(); }
});

test('owner correction replay requires current authorization but skips stale CAS and duplicate writes', () => {
  let allowed = true;
  let authorizationCalls = 0;
  const { db, store } = fixture(':memory:', {
    ownerCorrectionAuthorized() {
      authorizationCalls += 1;
      return allowed;
    },
  });
  try {
    const first = ownerCorrection('owner-message-replay');
    const applied = store.applyOwnerCorrection(projectId, objectiveId, first);
    const appliedEvents = store.events.replay(projectId);
    const appliedObjective = store.getObjective(projectId, objectiveId);

    allowed = false;
    assert.throws(() => store.applyOwnerCorrection(projectId, objectiveId, first), { code: 'owner_correction_unauthorized' });
    assert.deepEqual(store.getObjective(projectId, objectiveId), appliedObjective);
    assert.deepEqual(store.events.replay(projectId), appliedEvents);

    allowed = true;
    const second = ownerCorrection('owner-message-next', {
      expectedGoalRevision: applied.goalRevision,
      expectedControlRevision: applied.controlRevision,
    });
    store.applyOwnerCorrection(projectId, objectiveId, second);
    const beforeReplay = store.getObjective(projectId, objectiveId);
    const beforeReplayEvents = store.events.replay(projectId);

    const replay = store.applyOwnerCorrection(projectId, objectiveId, first);
    assert.equal(replay.goalRevision, beforeReplay.goalRevision);
    assert.equal(replay.controlRevision, beforeReplay.controlRevision);
    assert.deepEqual(store.getObjective(projectId, objectiveId), beforeReplay);
    assert.deepEqual(store.events.replay(projectId), beforeReplayEvents);
    assert.equal(authorizationCalls, 4);

    assert.throws(() => store.applyOwnerCorrection(projectId, objectiveId, {
      ...first,
      requirementDigest: `sha256:${'d'.repeat(64)}`,
    }), { code: 'owner_correction_source_conflict' });
    assert.deepEqual(store.getObjective(projectId, objectiveId), beforeReplay);
    assert.deepEqual(store.events.replay(projectId), beforeReplayEvents);
    assert.equal(authorizationCalls, 5);
  } finally { db.close(); }
});

test('owner corrections default-deny, require CAS and exact fields, and roll back with event failure', () => {
  const { db, store } = fixture(':memory:', { ownerCorrectionAuthorized: ({ sourceMessageId }) => sourceMessageId !== 'owner-message-denied' });
  try {
    apply(store, [{ task: task('queued-task') }]);
    const before = store.getObjective(projectId, objectiveId);
    const eventCount = store.events.replay(projectId).length;
    assert.throws(() => store.applyOwnerCorrection(projectId, objectiveId, ownerCorrection('owner-message-denied')), { code: 'owner_correction_unauthorized' });
    assert.throws(() => store.applyOwnerCorrection(projectId, objectiveId, { ...ownerCorrection('owner-message-extra'), origin: 'owner' }), { code: 'owner_correction_fields_invalid' });
    assert.throws(() => store.applyOwnerCorrection(projectId, objectiveId, ownerCorrection('owner-message-stale', { expectedAuthorityRevision: 0 })), { code: 'owner_correction_revision_stale' });
    assert.equal(store.getObjective(projectId, objectiveId).goalRevision, before.goalRevision);
    assert.equal(store.getObjective(projectId, objectiveId).tasks[0].state, 'queued');
    assert.equal(store.events.replay(projectId).length, eventCount);
  } finally { db.close(); }

  const failedDb = new Database(':memory:');
  try {
    const failing = new BacklogStore(failedDb, { ownerCorrectionAuthorized: () => true, beforeEventInsert(event) { if (event.eventType === 'objective.owner_correction') throw new Error('injected owner event failure'); } });
    failing.createObjective(objective());
    const next = revisionedPlan(failing.getObjective(projectId, objectiveId), [{ task: task('queued-task') }]);
    failing.applyPlan(projectId, objectiveId, next);
    assert.throws(() => failing.applyOwnerCorrection(projectId, objectiveId, ownerCorrection('owner-message-rollback')), /injected owner event failure/);
    assert.equal(failing.getObjective(projectId, objectiveId).goalRevision, 1);
    assert.equal(failing.getObjective(projectId, objectiveId).tasks[0].state, 'queued');
    assert.equal(failedDb.prepare('SELECT COUNT(*) AS n FROM backlog_owner_corrections').get().n, 0);
  } finally { failedDb.close(); }
});

test('owner correction preserves pause, budget and technical intent and moves validating to planning', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { ownerCorrectionAuthorized: () => true });
    const dispositions = ['paused_owner', 'waiting_budget', 'blocked_technical', 'waiting_owner'];
    for (const disposition of dispositions) {
      const id = `objective-${disposition}`;
      store.createObjective(objective({ objectiveId: id, sessionId: `session-${disposition}`, disposition }));
      store.applyOwnerCorrection(projectId, id, ownerCorrection(`source-${disposition}`));
      assert.equal(store.getObjective(projectId, id).disposition, disposition);
    }
    const validatingId = 'objective-validating';
    store.createObjective(objective({ objectiveId: validatingId, sessionId: 'session-validating', disposition: 'validating' }));
    store.applyOwnerCorrection(projectId, validatingId, ownerCorrection('source-validating'));
    assert.equal(store.getObjective(projectId, validatingId).disposition, 'planning');
  } finally { db.close(); }
});

test('terminal objectives cannot accept owner corrections', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { ownerCorrectionAuthorized: () => true });
    for (const disposition of ['accepted', 'partial', 'canceled']) {
      const id = `objective-${disposition}`;
      store.createObjective(objective({ objectiveId: id, sessionId: `session-${disposition}`, disposition }));
      assert.throws(() => store.applyOwnerCorrection(projectId, id, ownerCorrection(`source-${disposition}`)), { code: 'owner_correction_terminal_objective' });
      assert.equal(store.getObjective(projectId, id).goalRevision, 1);
    }
  } finally { db.close(); }
});

test('checkpoint inventory extends plan validation without granting checkpoint acceptance', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE trusted_checkpoint_refs(project_id TEXT, objective_id TEXT, checkpoint_id TEXT)');
    const store = new BacklogStore(db, {
      checkpointInventory: ({ projectId: currentProject, objectiveId: currentObjective }) => db.prepare('SELECT project_id AS projectId, objective_id AS objectiveId, checkpoint_id AS checkpointId FROM trusted_checkpoint_refs WHERE project_id=? AND objective_id=? ORDER BY checkpoint_id').all(currentProject, currentObjective),
    });
    store.createObjective(objective(), { checkpoints: [{ projectId, objectiveId, checkpointId: 'checkpoint-initial' }] });
    db.prepare('INSERT INTO trusted_checkpoint_refs VALUES(?,?,?)').run(projectId, objectiveId, 'checkpoint-registered');
    const current = store.getObjective(projectId, objectiveId);
    assert.deepEqual(current.checkpoints.map((item) => item.checkpointId), ['checkpoint-initial', 'checkpoint-registered']);
    const checkpointTask = task('task-checkpoint', { dependencies: [{ projectId, objectiveId, predecessorType: 'checkpoint', predecessorId: 'checkpoint-registered', successorTaskId: 'task-checkpoint', kind: 'requires_acceptance' }] });
    store.applyPlan(projectId, objectiveId, revisionedPlan(current, [{ task: checkpointTask }]));
    assert.equal(store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 }).length, 0);
  } finally { db.close(); }
});

test('checkpoint inventory deduplicates consistent refs and rejects malformed, async, conflicting, and oversized data', () => {
  const ref = { projectId, objectiveId, checkpointId: 'checkpoint-a' };
  const db = new Database(':memory:');
  try {
    const consistent = new BacklogStore(db, { checkpointInventory: () => [ref, { ...ref }] });
    consistent.createObjective(objective());
    assert.equal(consistent.getObjective(projectId, objectiveId).checkpoints.length, 1);
  } finally { db.close(); }

  const cases = [
    ['malformed', () => ({ checkpointId: 'checkpoint-a' }), { code: 'checkpoint_inventory_invalid' }],
    ['wrong scope', () => [{ ...ref, projectId: 'project-other' }], { code: 'checkpoint_inventory_scope_mismatch' }],
    ['invalid ID', () => [{ ...ref, checkpointId: 'bad id' }], { code: 'id_invalid' }],
    ['unexpected field', () => [{ ...ref, status: 'accepted' }], { code: 'checkpoint_inventory_invalid' }],
    ['async', () => Promise.resolve([ref]), { code: 'checkpoint_inventory_async' }],
    ['oversized', () => Array.from({ length: 501 }, (_, index) => ({ ...ref, checkpointId: `checkpoint-${index}` })), { code: 'checkpoint_inventory_invalid' }],
  ];
  for (const [name, inventory, expected] of cases) {
    const testDb = new Database(':memory:');
    try {
      const store = new BacklogStore(testDb, { checkpointInventory: inventory });
      assert.throws(() => store.createObjective(objective()), expected, name);
      assert.equal(testDb.prepare('SELECT COUNT(*) AS n FROM backlog_objectives').get().n, 0, name);
    } finally { testDb.close(); }
  }
});

test('typed lifecycle controls distinguish owner stop and require exact generation and control CAS', (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  const stopped = store.transitionLifecycleControl(projectId, objectiveId, {
    action: 'stop', expectedControlRevision: 1, expectedOwnerGeneration: 0,
  });
  assert.equal(stopped.disposition, 'paused_owner');
  assert.equal(stopped.controlRevision, 2);
  assert.equal(store.getLifecycleControl(projectId, objectiveId).cause, 'owner_stop');
  assert.throws(() => store.transitionLifecycleControl(projectId, objectiveId, {
    action: 'resume', expectedControlRevision: 1, expectedOwnerGeneration: 0,
  }), { code: 'control_revision_stale' });
  store.advanceOwnerGeneration(projectId, objectiveId, 0);
  assert.throws(() => store.transitionLifecycleControl(projectId, objectiveId, {
    action: 'resume', expectedControlRevision: 2, expectedOwnerGeneration: 0,
  }), { code: 'owner_generation_stale' });
  const resumed = store.transitionLifecycleControl(projectId, objectiveId, {
    action: 'resume', expectedControlRevision: 2, expectedOwnerGeneration: 1,
  });
  assert.equal(resumed.disposition, 'executing');
  assert.equal(resumed.controlRevision, 3);
  assert.equal(store.getLifecycleControl(projectId, objectiveId).cause, 'active');
});

test('budget waits preserve provider/model identity and stale control or generation cannot wake them', (t) => {
  let clock = 100;
  const { db, store } = fixture(':memory:', { now: () => clock });
  t.after(() => db.close());
  const wait = store.recordBudgetWait(projectId, objectiveId, {
    waitId: 'budget-1', source: 'planner', provider: 'provider-a', model: 'model-a', reasonCode: 'rate_limit',
    nextWakeAt: 150, expectedControlRevision: 1, expectedOwnerGeneration: 0,
  });
  assert.equal(wait.state, 'waiting');
  assert.equal(store.getObjective(projectId, objectiveId).disposition, 'waiting_budget');
  assert.throws(() => store.wakeBudgetWait(projectId, objectiveId, 'budget-1', {
    expectedControlRevision: 1, expectedOwnerGeneration: 0,
  }), { code: 'budget_wait_not_due' });
  clock = 200;
  store.transitionLifecycleControl(projectId, objectiveId, {
    action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0,
  });
  assert.throws(() => store.wakeBudgetWait(projectId, objectiveId, 'budget-1', {
    expectedControlRevision: 1, expectedOwnerGeneration: 0,
  }), { code: 'control_revision_stale' });
  assert.equal(store.getObjective(projectId, objectiveId).disposition, 'paused_owner');
});

test('typed retry records require current pins and block after bounded strategy exhaustion', (t) => {
  let clock = 100;
  const { db, store } = fixture(':memory:', { now: () => clock, maxLifecycleStrategies: 2 });
  t.after(() => db.close());
  const retry = (retryId, hypothesisId, strategyId, attempt) => ({ retryId, kind: 'planner_invalid', scopeType: 'objective', scopeId: objectiveId, source: 'planner',
    provider: 'provider-a', model: 'model-a', hypothesisId, strategyId, failureCode: 'planner_output_invalid', attempt,
    maxAttempts: 2, nextWakeAt: 0, expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  const first = retry('retry-1', 'hyp-1', 'fix-1', 1);
  first.nextWakeAt = 150;
  assert.equal(store.recordLifecycleRetry(projectId, objectiveId, first).state, 'waiting');
  assert.throws(() => store.recordLifecycleRetry(projectId, objectiveId, { ...retry('retry-1', 'hyp-1', 'fix-1', 2), expectedControlRevision: 2 }), { code: 'control_revision_stale' });
  clock = 200;
  assert.equal(store.wakeLifecycleRetry(projectId, objectiveId, 'retry-1', {
    expectedControlRevision: 1, expectedOwnerGeneration: 0,
  }).state, 'due');
  assert.equal(store.recordLifecycleRetry(projectId, objectiveId, retry('retry-1', 'hyp-1', 'fix-1', 2)).state, 'exhausted');
  assert.equal(store.wakeLifecycleRetry(projectId, objectiveId, 'retry-1', {
    expectedControlRevision: 1, expectedOwnerGeneration: 0,
  }).state, 'strategy_due');
  assert.equal(store.recordLifecycleRetry(projectId, objectiveId, retry('retry-2', 'hyp-2', 'fix-2', 1)).state, 'waiting');
  assert.equal(store.wakeLifecycleRetry(projectId, objectiveId, 'retry-2', {
    expectedControlRevision: 1, expectedOwnerGeneration: 0,
  }).state, 'due');
  assert.equal(store.recordLifecycleRetry(projectId, objectiveId, retry('retry-2', 'hyp-2', 'fix-2', 2)).state, 'blocked');
  assert.equal(store.getObjective(projectId, objectiveId).disposition, 'blocked_technical');
  assert.throws(() => store.recordLifecycleRetry(projectId, objectiveId, retry('retry-3', 'hyp-3', 'fix-3', 1)), { code: 'lifecycle_retry_controlled' });
});

test('independent task retry budgets preserve ready siblings and block only after no work remains', (t) => {
  const { db, store } = fixture(':memory:', { maxLifecycleStrategies: 1 });
  t.after(() => db.close());
  apply(store, [{ task: task('task-a') }, { task: task('task-b') }]);
  const [first] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, limit: 1 });
  store.settleAttempt(projectId, objectiveId, first.attempt.attemptId, first.claim.fencingToken,
    { state: 'failed', failureKind: 'test_failure' }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true });

  const recordTaskRetry = (taskId, retryId) => {
    const input = (attempt) => ({ retryId, kind: 'executor_error', scopeType: 'task', scopeId: taskId,
      source: 'executor', provider: 'provider-a', model: 'model-a', hypothesisId: `hyp-${taskId}`,
      strategyId: 'retry-once', failureCode: 'send_failed', attempt, maxAttempts: 2, nextWakeAt: 0,
      expectedControlRevision: 1, expectedOwnerGeneration: 0 });
    store.recordLifecycleRetry(projectId, objectiveId, input(1));
    store.wakeLifecycleRetry(projectId, objectiveId, retryId, { expectedControlRevision: 1, expectedOwnerGeneration: 0 });
    return store.recordLifecycleRetry(projectId, objectiveId, input(2));
  };

  assert.equal(recordTaskRetry('task-a', 'retry-task-a').state, 'blocked');
  assert.equal(store.getObjective(projectId, objectiveId).disposition, 'executing');
  const [sibling] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, limit: 1 });
  assert.equal(sibling.task.taskId, 'task-b');

  store.settleAttempt(projectId, objectiveId, sibling.attempt.attemptId, sibling.claim.fencingToken,
    { state: 'failed', failureKind: 'test_failure' }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true });
  assert.equal(recordTaskRetry('task-b', 'retry-task-b').state, 'blocked');
  assert.deepEqual(store.listLifecycleRetries(projectId, objectiveId).map((retry) => [retry.scopeType, retry.scopeId, retry.state]), [
    ['task', 'task-a', 'blocked'], ['task', 'task-b', 'blocked'],
  ]);
  assert.equal(store.getObjective(projectId, objectiveId).disposition, 'blocked_technical');
});

test('retry scope kind and task/checkpoint references are validated', (t) => {
  const { db, store } = fixture(':memory:', { checkpoints: [{ projectId, objectiveId, checkpointId: 'checkpoint-a' }] });
  t.after(() => db.close());
  apply(store, [{ task: task('task-a') }]);
  const retry = (scopeType, scopeId, kind = 'transient') => ({ retryId: 'scoped-retry', kind, scopeType, scopeId,
    source: 'executor', provider: 'provider-a', model: 'model-a', hypothesisId: 'hypothesis-a', strategyId: 'strategy-a',
    failureCode: 'send_failed', attempt: 1, maxAttempts: 2, nextWakeAt: 100,
    expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  assert.throws(() => store.recordLifecycleRetry(projectId, objectiveId, retry('task', 'missing-task', 'executor_error')), { code: 'lifecycle_retry_scope_missing' });
  assert.throws(() => store.recordLifecycleRetry(projectId, objectiveId, retry('checkpoint', 'missing-checkpoint')), { code: 'lifecycle_retry_scope_missing' });
  assert.throws(() => store.recordLifecycleRetry(projectId, objectiveId, retry('task', 'task-a', 'planner_invalid')), { code: 'lifecycle_retry_scope_kind_invalid' });
  assert.throws(() => store.recordLifecycleRetry(projectId, objectiveId, retry('objective', 'wrong-objective', 'planner_invalid')), { code: 'lifecycle_retry_scope_mismatch' });
  assert.equal(store.recordLifecycleRetry(projectId, objectiveId, retry('checkpoint', 'checkpoint-a')).state, 'waiting');
});

test('objective cancellation terminalizes unstarted work and rejects late successful settlement', (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  apply(store, [{ task: task('a-running') }, { task: task('b-queued') }]);
  const [claimed] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1, limit: 1 });
  store.pinSelectedSettings(projectId, objectiveId, claimed.attempt.attemptId, claimed.claim.fencingToken, { model: 'pinned' });
  store.recordSubmitted(projectId, objectiveId, claimed.attempt.attemptId, claimed.claim.fencingToken, 'remote-running');
  const canceled = store.requestControl(projectId, objectiveId, 'cancel', 1);
  assert.equal(canceled.disposition, 'canceled');
  assert.equal(canceled.tasks.find((item) => item.taskId === 'b-queued').state, 'canceled');
  const settled = store.settleAttempt(projectId, objectiveId, claimed.attempt.attemptId, claimed.claim.fencingToken,
    { state: 'succeeded', trusted: true, output: 'late output' },
    { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true, evidenceRefs: ['test:late'] });
  assert.equal(settled.attempt.state, 'canceled');
  assert.deepEqual(settled.attempt.outcome, { state: 'canceled', failureKind: 'objective_canceled' });
  assert.equal(store.getObjective(projectId, objectiveId).tasks.find((item) => item.taskId === 'a-running').state, 'canceled');
  assert.throws(() => store.applyPlan(projectId, objectiveId, revisionedPlan(store.getObjective(projectId, objectiveId), [])), { code: 'plan_objective_terminal' });
});

