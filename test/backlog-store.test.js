'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { Worker } = require('node:worker_threads');
const { VERSION } = require('../src/delivery-contracts');
const { BacklogStore, stableDigest } = require('../src/backlog-store');
const { CandidateStore } = require('../src/candidate-store');
const { CandidateReviewStore } = require('../src/candidate-review');
const { DeliveryInbox } = require('../src/delivery-inbox');
const { DeliveryLifecycle } = require('../src/delivery-lifecycle');
const { LeadPlanner } = require('../src/lead-planner');
const { runFrozenCandidateChecks } = require('../src/delivery-acceptance');
const { validateAcceptanceContract } = require('../src/acceptance');

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

function recoveredBlockedReviewFixture() {
  const { db, store } = fixture();
  db.exec(`CREATE TABLE task_executor_attempts (attempt_id TEXT PRIMARY KEY, state TEXT, external_task_id TEXT, context_id TEXT,
    project_id TEXT, objective_id TEXT, task_id TEXT, fencing_token INTEGER);
    CREATE TABLE concurrent_candidates (candidate_id TEXT PRIMARY KEY, project_id TEXT, objective_id TEXT, status TEXT);`);
  const candidateId = 'known-review-candidate';
  db.prepare('INSERT INTO concurrent_candidates(candidate_id,project_id,objective_id,status) VALUES(?,?,?,?)')
    .run(candidateId, projectId, objectiveId, 'known');
  const reviewTask = task('frozen-verifier', { role: 'verifier', kind: 'review', productWritePaths: [],
    publicationAuthority: { state: 'denied', reason: 'review_task', authorityRevision: 1 },
    checkpointId: 'checkpoint-review', baseCandidateId: candidateId });
  apply(store, [{ task: reviewTask }]);
  const [claimed] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
  store.requestControl(projectId, objectiveId, 'pause', 1);
  store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  const evidenceRef = `concurrent-shutdown:undispatched-review:${claimed.attempt.attemptId}:${claimed.attempt.contractDigest}`;
  const proof = { projectId, objectiveId, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId,
    fencingToken: claimed.claim.fencingToken, claimOwnerGeneration: claimed.claim.ownerGeneration,
    recoveryGeneration: 0, providerContextId: claimed.attempt.providerContextId, intentState: null,
    noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: [evidenceRef] };
  const recovered = store.settleRecoveredNoEffect(projectId, objectiveId, claimed.attempt.attemptId,
    claimed.claim.fencingToken, proof, 2);
  assert.equal(recovered.state, 'no_effect_requeued');
  const row = db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, objectiveId);
  const blocked = JSON.parse(row.record_json);
  blocked.disposition = 'blocked_technical';
  db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?')
    .run(JSON.stringify(blocked), projectId, objectiveId);
  db.prepare(`UPDATE backlog_lifecycle_controls SET cause='blocked_technical' WHERE project_id=? AND objective_id=?`)
    .run(projectId, objectiveId);
  return { db, store, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId, candidateId };
}

const FINAL_PROJECT = 'finalization-project';
const FINAL_OBJECTIVE = 'finalization-objective';
const FINAL_REQUIREMENTS = `sha256:${'d'.repeat(64)}`;
const FINAL_CHECKS = `sha256:${'e'.repeat(64)}`;
const digestText = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function finalizationFixture({ beforeEventInsert, finalizationRemainderResolver, reviewOverrides = {},
  finalizationAuthorized = () => true,
  finalizationCheckProofAuthorized = ({ result }) => ['accepted', 'rejected', 'unverifiable'].includes(result?.disposition),
  finalizationRecoveryAuthorized = () => true, ownerCorrectionAuthorized = () => true,
  executionPermissions = 'strict' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-finalization-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Finalization Test'); git('config', 'user.email', 'finalization@invalid');
  fs.writeFileSync(path.join(workspace, 'verify.js'), 'process.exit(0);\n');
  git('add', '.'); git('commit', '-q', '-m', 'candidate base');
  const dbPath = path.join(root, 'state.sqlite');
  const db = new Database(dbPath);
  let now = 1000;
  const store = new BacklogStore(db, { now: () => now++, roleCapacities: { engineer: 2, verifier: 2 },
    maxActiveTurns: 4, plannerReservedSlots: 1, beforeEventInsert,
    finalizationAuthorized,
    finalizationCheckProofAuthorized,
    finalizationRecoveryAuthorized,
    ownerCorrectionAuthorized,
    finalizationRemainderResolver: finalizationRemainderResolver || (() => null),
  });
  store.createObjective({ projectId: FINAL_PROJECT, objectiveId: FINAL_OBJECTIVE, sessionId: 'finalization-session',
    engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: FINAL_REQUIREMENTS, checksDigest: FINAL_CHECKS,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  let applyCalls = 0;
  const candidateStore = new CandidateStore({ db, workspace, storageDir,
    controls: ({ projectId, objectiveId, attemptId }) => {
      const current = store.getObjective(projectId, objectiveId);
      return { allowed: ['planning', 'executing'].includes(current?.disposition), fenced: false,
        projectId, objectiveId, attemptId, controlRevision: current?.controlRevision ?? 0, fencingToken: 1 };
    },
    admission: { async acquire() { throw new Error('publication must be denied before admission'); }, async release() {}, markUnresolved() {} },
    quiescence: () => true,
    apply: async () => { applyCalls += 1; return { applied: true }; },
  });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-finalization', projectId: FINAL_PROJECT,
    objectiveId: FINAL_OBJECTIVE, integrationGeneration: 1, sourceAttemptId: 'source-attempt',
    environmentDigest: 'f'.repeat(64), checkIdentity: 'check-set-final' });
  const reviewStore = new CandidateReviewStore({ db, candidateStore,
    currentObjective: ({ projectId, objectiveId }) => store.getObjective(projectId, objectiveId),
    checkpointInventory: () => [], attestClosure: () => ({ frozen: true }),
    authorizeCheckpoint: () => true,
    ...reviewOverrides,
  });
  const inbox = new DeliveryInbox(db, { projectId: FINAL_PROJECT, sessionId: 'finalization-session', objectiveId: FINAL_OBJECTIVE });
  const planner = new LeadPlanner({ store, inbox, runTurn: async () => ({ state: 'idle' }) });
  const lifecycle = new DeliveryLifecycle({ store, executor: { db }, projectId: FINAL_PROJECT,
    objectiveId: FINAL_OBJECTIVE, inbox, planner, effectsSettledForShutdown: () => true });
  const contract = { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] };
  const validated = validateAcceptanceContract(contract);
  const request = () => {
    const current = store.getObjective(FINAL_PROJECT, FINAL_OBJECTIVE);
    const manifest = candidateStore.readManifest(candidate.manifestDigest);
    return { finalizationId: 'finalization-1', kind: 'accepted', expectedOwnerGeneration: current.ownerGeneration,
      expectedControlRevision: current.controlRevision, expectedGoalRevision: current.goalRevision,
      expectedPlanRevision: current.planRevision, expectedAuthorityRevision: current.authorityRevision,
      requirementDigest: current.requirementDigest, checksDigest: current.checksDigest,
      candidateId: candidate.candidateId, integrationGeneration: candidate.integrationGeneration,
      manifestDigest: candidate.manifestDigest, sourceHead: manifest.head,
      environmentDigest: candidate.environmentDigest, checkIdentity: candidate.checkIdentity,
      checkContractDigest: `sha256:${digestText(canonical(validated))}`, checkSource: 'owner',
      requiredCheckIds: validated.requiredChecks.map((check) => check.id), requiredRoles: ['verifier'],
      executionPermissions, scratchEnabled: false, partialLedger: null };
  };
  const adapters = { candidateStore, reviewStore, lifecycle };
  const admission = { async acquire() { return { executionId: 'final-check-execution' }; }, recordTurnStart() {},
    async release() { return { state: 'released' }; } };
  const close = ({ remove = true } = {}) => { lifecycle.close(); db.close(); if (remove) fs.rmSync(root, { recursive: true, force: true }); };
  return { root, workspace, dbPath, db, store, candidateStore, candidate, reviewStore, inbox, planner, lifecycle,
    contract, request, adapters, admission, applyCalls: () => applyCalls, close };
}

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

test('finalization barrier fences real publication, runs real acceptance, and retains historical evidence', async (t) => {
  const fx = finalizationFixture();
  t.after(() => fx.close());
  const request = fx.request();
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  assert.equal(barrier.state, 'barrier');
  assert.equal(fx.store.getObjective(FINAL_PROJECT, FINAL_OBJECTIVE).disposition, 'validating');
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='finalization_barrier'")
    .get(fx.candidate.candidateId).n, 1);
  assert.throws(() => fx.store.applyPlan(FINAL_PROJECT, FINAL_OBJECTIVE, { schemaVersion: VERSION,
    expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1,
    expectedControlRevision: 1, nextPlanRevision: 1, tasks: [], dependencies: [] }), { code: 'plan_finalization_in_progress' });

  const manifest = fx.candidateStore.readManifest(fx.candidate.manifestDigest);
  await assert.rejects(fx.candidateStore.publish({ baseCandidateId: fx.candidate.candidateId,
    candidateId: 'candidate-publish-during-barrier', sourceAttemptId: 'publish-attempt', integrationGeneration: 2,
    environmentDigest: fx.candidate.environmentDigest, checkIdentity: fx.candidate.checkIdentity,
    expectedManifest: manifest, deltaPaths: [] }), { code: 'publication_controls_denied_or_unknown' });
  assert.equal(fx.applyCalls(), 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM candidate_intents').get().n, 0);

  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'check-attempt-1' }, fx.adapters);
  const checkResult = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: fx.contract, runId: 'finalization-check-run', attempt: 1,
    executionPermissions: 'strict', admission: fx.admission });
  assert.equal(checkResult.disposition, 'accepted');
  assert.equal(checkResult.admissionReleaseState, 'released');
  const ready = fx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, checkAttemptId: 'check-attempt-1', result: checkResult }, fx.adapters);
  assert.equal(ready.state, 'ready');
  const terminal = fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters);
  assert.equal(terminal.disposition, 'accepted');
  assert.equal(terminal.goalAchieved, true);
  const replay = fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters);
  assert.equal(replay.replay, true);
  assert.equal(replay.createdAt, terminal.createdAt);
  assert.equal(fx.store.currentFinalizationQualification(FINAL_PROJECT, FINAL_OBJECTIVE,
    { candidateStore: fx.candidateStore, reviewStore: fx.reviewStore }).current, true);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='finalization'")
    .get(fx.candidate.candidateId).n, 1);
  fx.candidateStore.collectGarbage();
  assert.equal(fx.candidateStore.get(fx.candidate.candidateId).status, 'known');
  assert.throws(() => fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { ...request, checkContractDigest: `sha256:${'9'.repeat(64)}` }, fx.adapters), { code: 'finalization_identity_conflict' });

  const next = fx.candidateStore.createCandidate({ candidateId: 'candidate-after-finalization', projectId: FINAL_PROJECT,
    objectiveId: FINAL_OBJECTIVE, parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2,
    sourceAttemptId: 'source-attempt-next', environmentDigest: fx.candidate.environmentDigest,
    checkIdentity: fx.candidate.checkIdentity });
  assert.equal(next.status, 'known');
  const qualification = fx.store.currentFinalizationQualification(FINAL_PROJECT, FINAL_OBJECTIVE,
    { candidateStore: fx.candidateStore, reviewStore: fx.reviewStore });
  assert.equal(qualification.current, false);
  assert.equal(qualification.reason, 'candidate_stale');
  assert.equal(qualification.historical.finalizationId, request.finalizationId);
  assert.equal(fx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request.finalizationId).state, 'accepted');
});

test('finalization pins preserve the owner-selected full-access setting through check settlement', async (t) => {
  const fx = finalizationFixture({ executionPermissions: 'full-access' });
  t.after(() => fx.close());
  const request = fx.request();
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  assert.equal(barrier.state, 'barrier');
  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'full-access-check-attempt' }, fx.adapters);
  const checkResult = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: fx.contract, runId: 'full-access-finalization-check', attempt: 1,
    executionPermissions: 'full-access', admission: fx.admission });
  assert.equal(checkResult.disposition, 'accepted');
  assert.equal(checkResult.checkSettings.executionPermissions, 'full-access');
  assert.equal(fx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, checkAttemptId: 'full-access-check-attempt', result: checkResult }, fx.adapters).state, 'ready');
  const terminal = fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters);
  assert.equal(terminal.disposition, 'accepted');
  assert.equal(terminal.goalAchieved, true);
});

test('unknown finalization checks survive SQLite reopen and require trusted no-effect reconciliation', (t) => {
  const fx = finalizationFixture();
  t.after(() => { if (fs.existsSync(fx.root)) fs.rmSync(fx.root, { recursive: true, force: true }); });
  const request = fx.request();
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'check-attempt-crashed' }, fx.adapters);
  const unknown = fx.store.markFinalizationCheckUnknown(FINAL_PROJECT, FINAL_OBJECTIVE, {
    finalizationId: request.finalizationId, checkAttemptId: 'check-attempt-crashed', reasonCode: 'accept_check_effect_unknown',
    workspace: path.join(fx.root, 'retained-workspace'), gitControlRoot: path.join(fx.root, 'retained-git-control'),
  });
  assert.equal(unknown.state, 'unknown');
  const dbPath = fx.dbPath;
  const root = fx.root;
  fx.close({ remove: false });
  const db = new Database(dbPath);
  const reopened = new BacklogStore(db, { finalizationAuthorized: () => true, finalizationRecoveryAuthorized: () => true });
  const saved = reopened.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request.finalizationId);
  assert.equal(saved.state, 'unknown');
  const dummyAdapters = { candidateStore: { db, get() {}, readManifest() {}, addReference() {}, removeReference() {} },
    reviewStore: { db, finalizationProjection() {} },
    lifecycle: { db, store: reopened, projectId: FINAL_PROJECT, objectiveId: FINAL_OBJECTIVE, shutdownProjection() {} } };
  assert.throws(() => reopened.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, {
    finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'check-attempt-retry',
  }, dummyAdapters), { code: 'finalization_check_reconciliation_required' });
  const reconciled = reopened.reconcileFinalizationCheck(FINAL_PROJECT, FINAL_OBJECTIVE, {
    finalizationId: request.finalizationId, checkAttemptId: 'check-attempt-crashed',
    proof: { checkAttemptId: 'check-attempt-crashed', outcome: 'no_effect', remoteQuiescent: true,
      processQuiescent: true, effectsSettled: true, evidenceRefs: ['reconcile:check-attempt-crashed'] },
  });
  assert.equal(reconciled.state, 'barrier');
  assert.equal(reconciled.checkAttemptId, null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('terminal partial requires trusted provenance for every remainder and emits only trusted evidence', async (t) => {
  const fx = finalizationFixture({
    finalizationRemainderResolver: ({ checkpoint }) => checkpoint.checkpointId === 'deferred-checkpoint'
      ? { checkpointId: checkpoint.checkpointId, category: 'owner_deferred', reason: 'Owner deferred this item.', evidenceRefs: ['owner-message:defer-1'] }
      : { checkpointId: checkpoint.checkpointId, category: 'outside_authority', reason: 'The objective has no authority for this item.', evidenceRefs: ['authority:scope-1'] },
    reviewOverrides: { attestClosure: ({ checkpointId }) => checkpointId
      ? { known: true, readManifest: [], checkpointAncestors: [] } : { frozen: true } },
  });
  t.after(() => fx.close());
  for (const checkpointId of ['deferred-checkpoint', 'outside-checkpoint']) {
    fx.reviewStore.registerCheckpoint({ projectId: FINAL_PROJECT, objectiveId: FINAL_OBJECTIVE, checkpointId,
      kind: 'misc', reason: 'Review the declared checkpoint.', checkIdentity: fx.candidate.checkIdentity,
      checkPins: [], toolPins: [], profilePins: [], environmentDigest: fx.candidate.environmentDigest }, { source: 'owner' });
  }
  const request = { ...fx.request(), kind: 'partial', partialLedger: [
    { id: 'deferred-checkpoint', status: 'blocked', reason: 'Model supplied text.', evidence: ['model:fake'] },
    { id: 'outside-checkpoint', status: 'not_started', reason: 'Model supplied text.', evidence: [] },
  ] };
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  assert.equal(barrier.state, 'barrier');
  assert.deepEqual(barrier.remainderFacts.facts.map((fact) => fact.category), ['owner_deferred', 'outside_authority']);
  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'partial-check-attempt' }, fx.adapters);
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: fx.contract, runId: 'partial-check-run', attempt: 1,
    executionPermissions: 'strict', admission: fx.admission });
  fx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, checkAttemptId: 'partial-check-attempt', result }, fx.adapters);
  const terminal = fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters);
  assert.equal(terminal.disposition, 'partial');
  assert.equal(terminal.goalAchieved, false);
  assert.deepEqual(terminal.ledger.map((entry) => entry.evidence), [['owner-message:defer-1'], ['authority:scope-1']]);
  assert.equal(terminal.ledger.some((entry) => entry.evidence.includes('model:fake')), false);
});

test('owner control changes invalidate a ready finalization without restoring over the newer state', async (t) => {
  const fx = finalizationFixture();
  t.after(() => fx.close());
  const request = fx.request();
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'control-check-attempt' }, fx.adapters);
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: fx.contract, runId: 'control-check-run', attempt: 1,
    executionPermissions: 'strict', admission: fx.admission });
  fx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, checkAttemptId: 'control-check-attempt', result }, fx.adapters);
  const paused = fx.store.transitionLifecycleControl(FINAL_PROJECT, FINAL_OBJECTIVE,
    { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  assert.equal(paused.disposition, 'paused_owner');
  assert.throws(() => fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters), { code: 'finalization_objective_controlled' });
  const invalidated = fx.store.invalidateFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest, reasonCode: 'owner_pause' }, fx.adapters);
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(fx.store.getObjective(FINAL_PROJECT, FINAL_OBJECTIVE).disposition, 'paused_owner');
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='finalization_barrier'")
    .get(fx.candidate.candidateId).n, 0);
});

test('a candidate published after checks invalidates the pins before terminal commit', async (t) => {
  const fx = finalizationFixture();
  t.after(() => fx.close());
  const request = fx.request();
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'stale-candidate-check' }, fx.adapters);
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: fx.contract, runId: 'stale-candidate-check-run', attempt: 1,
    executionPermissions: 'strict', admission: fx.admission });
  fx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, checkAttemptId: 'stale-candidate-check', result }, fx.adapters);
  fx.candidateStore.createCandidate({ candidateId: 'candidate-during-ready', projectId: FINAL_PROJECT,
    objectiveId: FINAL_OBJECTIVE, parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2,
    sourceAttemptId: 'source-attempt-during-ready', environmentDigest: fx.candidate.environmentDigest,
    checkIdentity: fx.candidate.checkIdentity });
  assert.throws(() => fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters), { code: 'finalization_candidate_pins_stale' });
  const invalidated = fx.store.invalidateFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest, reasonCode: 'candidate_advanced' }, fx.adapters);
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(fx.store.getObjective(FINAL_PROJECT, FINAL_OBJECTIVE).disposition, 'executing');
});

test('terminal acceptance event failure rolls back final record and permanent reference together', async (t) => {
  const fx = finalizationFixture({ beforeEventInsert(event) {
    if (event.eventType === 'objective.accepted') throw Object.assign(new Error('injected terminal event failure'), { code: 'finalization_event_failed' });
  } });
  t.after(() => fx.close());
  const request = fx.request();
  const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
  fx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: request.finalizationId,
    expectedPinsDigest: barrier.pinsDigest, checkAttemptId: 'rollback-check-attempt' }, fx.adapters);
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: fx.contract, runId: 'rollback-check-run', attempt: 1,
    executionPermissions: 'strict', admission: fx.admission });
  fx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, checkAttemptId: 'rollback-check-attempt', result }, fx.adapters);
  assert.throws(() => fx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest }, fx.adapters), { code: 'finalization_event_failed' });
  assert.equal(fx.store.getObjective(FINAL_PROJECT, FINAL_OBJECTIVE).disposition, 'validating');
  assert.equal(fx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request.finalizationId).state, 'ready');
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='finalization'")
    .get(fx.candidate.candidateId).n, 0);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='finalization_barrier'")
    .get(fx.candidate.candidateId).n, 1);
});

function controlledFinalizationFixture() {
  let allowAuthorization = true;
  let allowCheckProof = true;
  const fx = finalizationFixture({
    finalizationAuthorized: () => allowAuthorization,
    finalizationCheckProofAuthorized: () => allowCheckProof,
  });
  return { fx, setAuthorization(value) { allowAuthorization = value; }, setCheckProof(value) { allowCheckProof = value; } };
}

test('typed finalization command replays reauthorize without rewriting evidence after pin drift', async (t) => {
  const fixtures = [];
  const create = () => {
    const entry = controlledFinalizationFixture();
    fixtures.push(entry);
    return entry;
  };
  const eventCount = (fx) => fx.store.events.replay(FINAL_PROJECT).length;
  const publishNextCandidate = (fx, candidateId) => fx.candidateStore.createCandidate({ candidateId,
    projectId: FINAL_PROJECT, objectiveId: FINAL_OBJECTIVE, parentCandidateId: fx.candidate.candidateId,
    integrationGeneration: 2, sourceAttemptId: `source-${candidateId}`,
    environmentDigest: fx.candidate.environmentDigest, checkIdentity: fx.candidate.checkIdentity });
  t.after(() => fixtures.forEach(({ fx }) => fx.close()));

  const { fx: beginFx, setAuthorization: setBeginAuthorization } = create();
  const beginRequest = beginFx.request();
  beginFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, beginRequest, beginFx.adapters);
  const beginBefore = beginFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, beginRequest.finalizationId);
  beginFx.store.transitionLifecycleControl(FINAL_PROJECT, FINAL_OBJECTIVE,
    { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  const beginEvents = eventCount(beginFx);
  setBeginAuthorization(false);
  assert.throws(() => beginFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, beginRequest, beginFx.adapters),
    { code: 'finalization_unauthorized' });
  assert.deepEqual(beginFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, beginRequest.finalizationId), beginBefore);
  assert.equal(eventCount(beginFx), beginEvents);
  setBeginAuthorization(true);
  const beginReplay = beginFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, beginRequest, beginFx.adapters);
  const { replay: beginWasReplay, ...beginRecord } = beginReplay;
  assert.equal(beginWasReplay, true);
  assert.deepEqual(beginRecord, beginBefore);
  assert.equal(eventCount(beginFx), beginEvents);

  const { fx: unknownFx, setAuthorization: setUnknownAuthorization } = create();
  const unknownRequest = unknownFx.request();
  const unknownBarrier = unknownFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, unknownRequest, unknownFx.adapters);
  unknownFx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: unknownRequest.finalizationId,
    expectedPinsDigest: unknownBarrier.pinsDigest, checkAttemptId: 'replay-unknown-attempt' }, unknownFx.adapters);
  const unknownInput = { finalizationId: unknownRequest.finalizationId, checkAttemptId: 'replay-unknown-attempt',
    reasonCode: 'accept_check_effect_unknown', workspace: '/tmp/replay-check-workspace', gitControlRoot: '/tmp/replay-check-controls' };
  const unknown = unknownFx.store.markFinalizationCheckUnknown(FINAL_PROJECT, FINAL_OBJECTIVE, unknownInput);
  unknownFx.store.transitionLifecycleControl(FINAL_PROJECT, FINAL_OBJECTIVE,
    { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  const unknownEvents = eventCount(unknownFx);
  setUnknownAuthorization(false);
  assert.throws(() => unknownFx.store.markFinalizationCheckUnknown(FINAL_PROJECT, FINAL_OBJECTIVE, unknownInput),
    { code: 'finalization_unauthorized' });
  assert.deepEqual(unknownFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, unknownRequest.finalizationId), unknown);
  assert.equal(eventCount(unknownFx), unknownEvents);
  setUnknownAuthorization(true);
  assert.deepEqual(unknownFx.store.markFinalizationCheckUnknown(FINAL_PROJECT, FINAL_OBJECTIVE, unknownInput), unknown);
  assert.equal(eventCount(unknownFx), unknownEvents);

  const { fx: resultFx, setCheckProof } = create();
  const checkRequest = resultFx.request();
  const checkBarrier = resultFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, checkRequest, resultFx.adapters);
  resultFx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: checkRequest.finalizationId,
    expectedPinsDigest: checkBarrier.pinsDigest, checkAttemptId: 'replay-result-attempt' }, resultFx.adapters);
  const checkResult = await runFrozenCandidateChecks({ candidateStore: resultFx.candidateStore, candidate: resultFx.candidate,
    contract: resultFx.contract, runId: 'replay-result-run', attempt: 1,
    executionPermissions: 'strict', admission: resultFx.admission });
  const ready = resultFx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: checkRequest.finalizationId, checkAttemptId: 'replay-result-attempt', result: checkResult }, resultFx.adapters);
  publishNextCandidate(resultFx, 'candidate-after-result-replay');
  const resultEvents = eventCount(resultFx);
  setCheckProof(false);
  assert.throws(() => resultFx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: checkRequest.finalizationId, checkAttemptId: 'replay-result-attempt', result: checkResult }, resultFx.adapters),
  { code: 'finalization_check_proof_untrusted' });
  assert.deepEqual(resultFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, checkRequest.finalizationId), ready);
  assert.equal(eventCount(resultFx), resultEvents);
  setCheckProof(true);
  assert.deepEqual(resultFx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: checkRequest.finalizationId, checkAttemptId: 'replay-result-attempt', result: checkResult }, resultFx.adapters), ready);
  assert.equal(eventCount(resultFx), resultEvents);

  const { fx: commitFx, setAuthorization: setCommitAuthorization } = create();
  const commitRequest = commitFx.request();
  const commitBarrier = commitFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, commitRequest, commitFx.adapters);
  commitFx.store.startFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE, { finalizationId: commitRequest.finalizationId,
    expectedPinsDigest: commitBarrier.pinsDigest, checkAttemptId: 'replay-commit-attempt' }, commitFx.adapters);
  const commitResult = await runFrozenCandidateChecks({ candidateStore: commitFx.candidateStore, candidate: commitFx.candidate,
    contract: commitFx.contract, runId: 'replay-commit-run', attempt: 1,
    executionPermissions: 'strict', admission: commitFx.admission });
  commitFx.store.recordFinalizationChecks(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: commitRequest.finalizationId, checkAttemptId: 'replay-commit-attempt', result: commitResult }, commitFx.adapters);
  const terminal = commitFx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: commitRequest.finalizationId, expectedPinsDigest: commitBarrier.pinsDigest }, commitFx.adapters);
  const terminalRecord = commitFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, commitRequest.finalizationId);
  publishNextCandidate(commitFx, 'candidate-after-commit-replay');
  const commitEvents = eventCount(commitFx);
  setCommitAuthorization(false);
  assert.throws(() => commitFx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: commitRequest.finalizationId, expectedPinsDigest: commitBarrier.pinsDigest }, commitFx.adapters),
  { code: 'finalization_unauthorized' });
  assert.deepEqual(commitFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, commitRequest.finalizationId), terminalRecord);
  assert.equal(eventCount(commitFx), commitEvents);
  setCommitAuthorization(true);
  const committedReplay = commitFx.store.commitFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { finalizationId: commitRequest.finalizationId, expectedPinsDigest: commitBarrier.pinsDigest }, commitFx.adapters);
  const { replay: commitWasReplay, ...replayedTerminal } = committedReplay;
  assert.equal(commitWasReplay, true);
  assert.deepEqual(replayedTerminal, terminal);
  assert.equal(eventCount(commitFx), commitEvents);

  const { fx: invalidateFx, setAuthorization: setInvalidateAuthorization } = create();
  const invalidateRequest = invalidateFx.request();
  const invalidateBarrier = invalidateFx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, invalidateRequest, invalidateFx.adapters);
  const invalidation = { finalizationId: invalidateRequest.finalizationId,
    expectedPinsDigest: invalidateBarrier.pinsDigest, reasonCode: 'owner_abort' };
  const invalidated = invalidateFx.store.invalidateFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, invalidation, invalidateFx.adapters);
  publishNextCandidate(invalidateFx, 'candidate-after-invalidate-replay');
  const invalidateEvents = eventCount(invalidateFx);
  setInvalidateAuthorization(false);
  assert.throws(() => invalidateFx.store.invalidateFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, invalidation, invalidateFx.adapters),
    { code: 'finalization_unauthorized' });
  assert.deepEqual(invalidateFx.store.getFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, invalidateRequest.finalizationId), invalidated);
  assert.equal(eventCount(invalidateFx), invalidateEvents);
  setInvalidateAuthorization(true);
  assert.deepEqual(invalidateFx.store.invalidateFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, invalidation, invalidateFx.adapters), invalidated);
  assert.equal(eventCount(invalidateFx), invalidateEvents);
  assert.throws(() => invalidateFx.store.invalidateFinalization(FINAL_PROJECT, FINAL_OBJECTIVE,
    { ...invalidation, reasonCode: 'different_reason' }, invalidateFx.adapters), { code: 'finalization_invalidation_conflict' });
});

test('owner correction replan blocks finalization until task disposition is resolved', (t) => {
  const fx = finalizationFixture();
  t.after(() => fx.close());
  const initialPlan = { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1,
    tasks: [{ task: task('owner-replan-task', { projectId: FINAL_PROJECT, objectiveId: FINAL_OBJECTIVE }) }], dependencies: [] };
  fx.store.applyPlan(FINAL_PROJECT, FINAL_OBJECTIVE, initialPlan);
  const correction = { sourceMessageId: 'owner-replan-message', expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: `sha256:${'c'.repeat(64)}` };
  const corrected = fx.store.applyOwnerCorrection(FINAL_PROJECT, FINAL_OBJECTIVE, correction);
  const blockedTask = corrected.tasks.find((entry) => entry.taskId === 'owner-replan-task');
  assert.equal(blockedTask.state, 'blocked');
  assert.equal(blockedTask.blockedReason, 'owner_correction_replan_required');
  assert.throws(() => fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, fx.request(), fx.adapters),
    { code: 'finalization_blocked' });
});

test('no-effect recovery respects captured goal and authority scope', async (t) => {
  for (const scenario of ['corrected', 'same-goal', 'legacy-first', 'legacy-corrected', 'authority-drift', 'canceled']) {
    await t.test(scenario, () => {
      const { db, store } = fixture(':memory:', { ownerCorrectionAuthorized: () => true });
      try {
        db.exec('CREATE TABLE task_executor_attempts (attempt_id TEXT, state TEXT, external_task_id TEXT, context_id TEXT, project_id TEXT, objective_id TEXT, task_id TEXT, fencing_token INTEGER)');
        apply(store, [{ task: task('old-task', { priority: 10 }) }]);
        const [claimed] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
        if (scenario.startsWith('legacy')) {
          const row = db.prepare('SELECT record_json FROM backlog_attempts WHERE attempt_id=?').get(claimed.attempt.attemptId);
          const record = JSON.parse(row.record_json);
          delete record.capturedControls.goalRevision;
          db.prepare('UPDATE backlog_attempts SET record_json=? WHERE attempt_id=?').run(JSON.stringify(record), claimed.attempt.attemptId);
        }
        const original = store.listAttempts(projectId, objectiveId)[0];
        if (scenario === 'corrected' || scenario === 'legacy-corrected') {
          store.applyOwnerCorrection(projectId, objectiveId, ownerCorrection('correction-recovery'));
          const current = store.getObjective(projectId, objectiveId);
          store.applyPlan(projectId, objectiveId, revisionedPlan(current, [{ task: task('new-task') }]));
        }
        if (scenario === 'authority-drift') {
          const row = db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, objectiveId);
          const record = JSON.parse(row.record_json);
          record.authorityRevision += 1;
          db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(JSON.stringify(record), projectId, objectiveId);
        }
        let current = store.getObjective(projectId, objectiveId);
        store.requestControl(projectId, objectiveId, scenario === 'canceled' ? 'cancel' : 'pause', current.controlRevision);
        store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
        const proof = { projectId, objectiveId, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId,
          fencingToken: claimed.claim.fencingToken, claimOwnerGeneration: 0, recoveryGeneration: 0,
          providerContextId: claimed.attempt.providerContextId, intentState: null, noEffect: true,
          remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['private:report'] };
        const result = store.settleRecoveredNoEffect(projectId, objectiveId, claimed.attempt.attemptId, claimed.claim.fencingToken, proof, scenario === 'corrected' ? 1 : 2);
        const blocked = ['corrected', 'legacy-corrected', 'authority-drift'].includes(scenario);
        assert.equal(result.state, scenario === 'canceled' ? 'canceled' : blocked ? 'task_blocked' : 'no_effect_requeued');
        assert.equal(result.task.state, scenario === 'canceled' ? 'canceled' : blocked ? 'blocked' : 'queued');
        if (blocked) {
          assert.equal(result.task.blockedReason, 'owner_correction_replan_required');
          assert.equal(store.getObjective(projectId, objectiveId).disposition, 'paused_owner');
          const event = store.events.replay(projectId).find((item) => item.eventType === 'attempt.recovery_task_blocked');
          assert.equal(event.payload.retry, false);
          assert.equal(event.payload.taskBlocked, true);
          assert.equal(event.payload.objectiveBlocked, false);
        }
        assert.equal(result.claim.state, 'released');
        assert.equal(result.attempt.state, 'canceled');
        assert.deepEqual(result.attempt.evidenceRefs, ['private:report']);
        const saved = store.listAttempts(projectId, objectiveId)[0];
        assert.deepEqual(saved.contractSnapshot, original.contractSnapshot);
        assert.deepEqual(saved.capturedControls, original.capturedControls);
        if (!scenario.startsWith('legacy')) assert.equal(saved.capturedControls.goalRevision, 1);
        if (scenario !== 'canceled') {
          current = store.getObjective(projectId, objectiveId);
          store.requestControl(projectId, objectiveId, 'resume', current.controlRevision);
          current = store.getObjective(projectId, objectiveId);
          const [next] = store.claimReady(projectId, objectiveId, 0, { controlRevision: current.controlRevision });
          if (scenario === 'corrected' || scenario === 'legacy-corrected') assert.equal(next.task.taskId, 'new-task');
          else if (blocked) assert.equal(next, undefined);
          else assert.equal(next.task.taskId, 'old-task');
        }
      } finally { db.close(); }
    });
  }
});

test('blocked technical resume requires an exact released no-effect review receipt', async (t) => {
  await t.test('accepts the exact frozen verifier attempt and advances the control revision once', () => {
    const fx = recoveredBlockedReviewFixture();
    try {
      const current = fx.store.getObjective(projectId, objectiveId);
      const row = fx.db.prepare(`SELECT terminal_digest,release_facts_json FROM backlog_attempts
        WHERE project_id=? AND objective_id=? AND attempt_id=?`).get(projectId, objectiveId, fx.attemptId);
      assert.equal(row.terminal_digest, stableDigest({ recoveryProof: JSON.parse(row.release_facts_json) }));
      const resumed = fx.store.resumeBlockedTechnical(projectId, objectiveId, { expectedOwnerGeneration: current.ownerGeneration,
        expectedControlRevision: current.controlRevision, taskId: fx.taskId, attemptId: fx.attemptId, candidateId: fx.candidateId });
      assert.equal(resumed.disposition, 'executing');
      assert.equal(resumed.controlRevision, current.controlRevision + 1);
      assert.equal(fx.store.getLifecycleControl(projectId, objectiveId).cause, 'active');
      assert.equal(fx.store.events.replay(projectId).at(-1).eventType, 'objective.resumed');
    } finally { fx.db.close(); }
  });

  for (const scenario of ['tampered-receipt', 'failed-task', 'retry-pending', 'unknown-attempt', 'stale-control']) {
    await t.test(`refuses ${scenario} without changing objective or event history`, () => {
      const fx = recoveredBlockedReviewFixture();
      try {
        const before = fx.store.getObjective(projectId, objectiveId);
        const eventCount = fx.store.events.replay(projectId).length;
        if (scenario === 'tampered-receipt') {
          const row = fx.db.prepare(`SELECT release_facts_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND attempt_id=?`)
            .get(projectId, objectiveId, fx.attemptId);
          const receipt = JSON.parse(row.release_facts_json);
          receipt.noEffect = false;
          fx.db.prepare(`UPDATE backlog_attempts SET release_facts_json=? WHERE project_id=? AND objective_id=? AND attempt_id=?`)
            .run(JSON.stringify(receipt), projectId, objectiveId, fx.attemptId);
        } else if (scenario === 'failed-task') {
          const current = fx.store.getObjective(projectId, objectiveId).tasks[0];
          const failed = { ...current, state: 'failed' };
          fx.db.prepare(`UPDATE backlog_tasks SET state='failed',contract_json=? WHERE project_id=? AND objective_id=? AND task_id=?`)
            .run(JSON.stringify(failed), projectId, objectiveId, fx.taskId);
        } else if (scenario === 'retry-pending') {
          fx.db.prepare(`INSERT INTO backlog_lifecycle_retries(project_id,objective_id,retry_id,state,attempt,next_wake_at,record_json,created_at,updated_at)
            VALUES(?,?,?,'exhausted',1,0,'{}',0,0)`).run(projectId, objectiveId, 'blocked-review-retry');
        } else if (scenario === 'unknown-attempt') {
          const row = fx.db.prepare(`SELECT record_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND attempt_id=?`)
            .get(projectId, objectiveId, fx.attemptId);
          const attempt = JSON.parse(row.record_json);
          attempt.state = 'unknown';
          fx.db.prepare(`UPDATE backlog_attempts SET record_json=? WHERE project_id=? AND objective_id=? AND attempt_id=?`)
            .run(JSON.stringify(attempt), projectId, objectiveId, fx.attemptId);
        }
        const current = fx.store.getObjective(projectId, objectiveId);
        const expectedRevision = scenario === 'stale-control' ? current.controlRevision - 1 : current.controlRevision;
        const expectedCode = { 'tampered-receipt': 'blocked_technical_resume_receipt_invalid',
          'failed-task': 'blocked_technical_resume_task_failed', 'retry-pending': 'blocked_technical_resume_retry_pending',
          'unknown-attempt': 'blocked_technical_resume_attempt_pending', 'stale-control': 'control_revision_stale' }[scenario];
        assert.throws(() => fx.store.resumeBlockedTechnical(projectId, objectiveId, { expectedOwnerGeneration: current.ownerGeneration,
          expectedControlRevision: expectedRevision, taskId: fx.taskId, attemptId: fx.attemptId, candidateId: fx.candidateId }), { code: expectedCode });
        const after = fx.store.getObjective(projectId, objectiveId);
        assert.equal(after.disposition, before.disposition);
        assert.equal(after.controlRevision, before.controlRevision);
        assert.equal(fx.store.events.replay(projectId).length, eventCount);
      } finally { fx.db.close(); }
    });
  }
});
