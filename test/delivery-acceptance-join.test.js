'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { CandidateStore } = require('../src/candidate-store');
const { CandidateReviewStore } = require('../src/candidate-review');
const { DeliveryInbox } = require('../src/delivery-inbox');
const { DeliveryLifecycle } = require('../src/delivery-lifecycle');
const { LeadPlanner } = require('../src/lead-planner');
const { validateAcceptanceContract } = require('../src/acceptance');
const { finalizeCandidate, runFrozenCandidateChecks } = require('../src/delivery-acceptance');

const PROJECT = 'join-project';
const OBJECTIVE = 'join-objective';
const REQUIREMENTS = `sha256:${'a'.repeat(64)}`;
const CHECKS = `sha256:${'b'.repeat(64)}`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function fixture({ checkpoints = [], remainderResolver, finalizationAuthorized = () => true,
  finalizationCheckProofAuthorized = () => true, verifyContent = 'process.exit(0);\n', extraFiles = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-acceptance-join-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Join Fixture');
  git('config', 'user.email', 'join-fixture@invalid');
  fs.writeFileSync(path.join(workspace, 'verify.js'), verifyContent);
  for (const [name, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(workspace, name), content);
  git('add', '.');
  git('commit', '-q', '-m', 'candidate base');
  const dbPath = path.join(root, 'state.sqlite');
  let db;
  let store;
  let candidateStore;
  let candidate;
  let reviewStore;
  let inbox;
  let planner;
  let lifecycle;
  let applyCalls = 0;
  let checkpointsRegistered = false;
  const open = () => {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 3000');
    store = new BacklogStore(db, { finalizationAuthorized, finalizationCheckProofAuthorized,
      finalizationRecoveryAuthorized: () => true,
      finalizationRemainderResolver: remainderResolver || (() => null),
      now: (() => { let value = 1000; return () => value++; })() });
    if (!store.getObjective(PROJECT, OBJECTIVE)) {
      store.createObjective({ projectId: PROJECT, objectiveId: OBJECTIVE, sessionId: 'join-session',
        engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: REQUIREMENTS, checksDigest: CHECKS,
        authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
    }
    candidateStore = new CandidateStore({ db, workspace, storageDir,
      controls: ({ projectId, objectiveId, attemptId }) => {
        const current = store.getObjective(projectId, objectiveId);
        return { allowed: ['planning', 'executing'].includes(current?.disposition), fenced: false,
          projectId, objectiveId, attemptId, controlRevision: current?.controlRevision ?? 0, fencingToken: 1 };
      }, admission: { async acquire() { throw new Error('unexpected publication admission'); }, async release() {}, markUnresolved() {} },
      quiescence: () => true, apply: async () => { applyCalls += 1; return { applied: true }; } });
    candidate = candidateStore.get('join-candidate') || candidateStore.createCandidate({ candidateId: 'join-candidate',
      projectId: PROJECT, objectiveId: OBJECTIVE, integrationGeneration: 1,
      sourceAttemptId: 'join-source-attempt', environmentDigest: 'c'.repeat(64), checkIdentity: 'join-checks-v1' });
    reviewStore = new CandidateReviewStore({ db, candidateStore,
      currentObjective: ({ projectId, objectiveId }) => store.getObjective(projectId, objectiveId),
      checkpointInventory: () => checkpoints, attestClosure: ({ checkpointId }) => checkpointId
        ? { known: true, readManifest: [], checkpointAncestors: [] } : { frozen: true }, authorizeCheckpoint: () => true });
    for (const checkpoint of checkpoints) {
      if (!checkpointsRegistered) reviewStore.registerCheckpoint({ projectId: PROJECT, objectiveId: OBJECTIVE,
        checkpointId: checkpoint.checkpointId, kind: 'misc', reason: 'Join checkpoint.',
        checkIdentity: candidate.checkIdentity, checkPins: [], toolPins: [], profilePins: [],
        environmentDigest: candidate.environmentDigest }, { source: 'owner' });
    }
    checkpointsRegistered = true;
    inbox = new DeliveryInbox(db, { projectId: PROJECT, sessionId: 'join-session', objectiveId: OBJECTIVE });
    planner = new LeadPlanner({ store, inbox, runTurn: async () => ({ state: 'idle' }) });
    lifecycle = new DeliveryLifecycle({ store, executor: { db }, projectId: PROJECT, objectiveId: OBJECTIVE,
      inbox, planner, effectsSettledForShutdown: () => true });
  };
  open();
  const contract = { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] };
  const validated = validateAcceptanceContract(contract);
  const request = (id = 'join-finalization', kind = 'accepted', partialLedger = null) => {
    const current = store.getObjective(PROJECT, OBJECTIVE);
    const manifest = candidateStore.readManifest(candidate.manifestDigest);
    return { finalizationId: id, kind, expectedOwnerGeneration: current.ownerGeneration,
      expectedControlRevision: current.controlRevision, expectedGoalRevision: current.goalRevision,
      expectedPlanRevision: current.planRevision, expectedAuthorityRevision: current.authorityRevision,
      requirementDigest: current.requirementDigest, checksDigest: current.checksDigest,
      candidateId: candidate.candidateId, integrationGeneration: candidate.integrationGeneration,
      manifestDigest: candidate.manifestDigest, sourceHead: manifest.head,
      environmentDigest: candidate.environmentDigest, checkIdentity: candidate.checkIdentity,
      checkContractDigest: `sha256:${hash(canonical(validated))}`, checkSource: 'owner',
      requiredCheckIds: validated.requiredChecks.map((check) => check.id), requiredRoles: ['verifier'],
      executionPermissions: 'strict', scratchEnabled: false, partialLedger };
  };
  const admission = { async acquire() { return { executionId: 'join-check-execution' }; }, recordTurnStart() {},
    async release() { return { state: 'released' }; } };
  const adapters = () => ({ candidateStore, reviewStore, lifecycle });
  const finalize = (req = request(), options = {}) => finalizeCandidate({ store, ...adapters(), projectId: PROJECT,
    objectiveId: OBJECTIVE, request: req, contract, admission, ...options });
  const close = ({ remove = true } = {}) => {
    lifecycle?.close();
    db?.close();
    if (remove) fs.rmSync(root, { recursive: true, force: true });
  };
  const reopen = () => { close({ remove: false }); open(); };
  return { root, workspace, dbPath, get db() { return db; }, get store() { return store; },
    get candidateStore() { return candidateStore; }, get candidate() { return candidate; },
    get reviewStore() { return reviewStore; }, get lifecycle() { return lifecycle; },
    contract, request, adapters, admission, finalize, close, reopen,
    get applyCalls() { return applyCalls; } };
}

test('finalizeCandidate runs real acceptance, commits atomically, and freshly authorizes zero-check replay', async (t) => {
  let authorizationCalls = 0;
  const fx = fixture({ finalizationAuthorized: () => { authorizationCalls += 1; return true; } });
  t.after(() => fx.close());
  const request = fx.request();
  let checksRun = 0;
  const first = await fx.finalize(request, { admission: { async acquire() {
    checksRun += 1;
    return { executionId: 'first-check-execution' };
  }, recordTurnStart() {}, async release() { return { state: 'released' }; } } });
  assert.equal(first.state, 'accepted');
  assert.equal(first.finalization.goalAchieved, true);
  assert.equal(first.finalization.checkResult.disposition, 'accepted');
  assert.deepEqual(first.finalization.checkResult.requiredCheckIds, ['verify']);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE candidate_id=? AND ref_type='finalization'")
    .get(fx.candidate.candidateId).n, 1);
  const eventCount = fx.db.prepare('SELECT COUNT(*) AS n FROM delivery_events WHERE project_id=?').get(PROJECT).n;
  const beforeReplayAuthorization = authorizationCalls;
  const replay = await fx.finalize(request, { admission: { async acquire() { throw new Error('replay ran checks'); } } });
  assert.equal(replay.state, 'accepted');
  assert.equal(replay.replay, true);
  assert.equal(replay.finalization.createdAt, first.finalization.createdAt);
  assert.equal(checksRun, 1);
  assert.equal(authorizationCalls, beforeReplayAuthorization + 2);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM delivery_events WHERE project_id=?').get(PROJECT).n, eventCount);
});

test('finalizeCandidate persists host execution evidence before recording the check result', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request('host-proof-finalization');
  let observed = null;
  const result = await fx.finalize(request, { onChecksExecuted(facts) {
    observed = facts;
    assert.equal(fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId).state, 'checking');
    assert.equal(facts.checkAttemptId, fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId).checkAttemptId);
    assert.equal(facts.pins.candidate.candidateId, fx.candidate.candidateId);
    assert.equal(facts.result.disposition, 'accepted');
    return true;
  } });
  assert.ok(observed);
  assert.equal(result.state, 'accepted');
});

test('finalizeCandidate refuses to record checks without host execution proof', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request('missing-host-proof-finalization');
  await assert.rejects(fx.finalize(request, { onChecksExecuted() { return false; } }),
    { code: 'finalization_check_execution_proof_missing' });
  assert.equal(fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId).state, 'checking');
});

test('contract pin mismatches fail before opening the finalization barrier', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request();
  request.requiredCheckIds = [];
  const before = fx.db.prepare('SELECT COUNT(*) AS n FROM delivery_events WHERE project_id=?').get(PROJECT).n;
  let checksRun = 0;
  await assert.rejects(fx.finalize(request, { admission: { async acquire() {
    checksRun += 1;
    return { executionId: 'should-not-run' };
  }, recordTurnStart() {}, async release() { return { state: 'released' }; } } }),
  { code: 'finalization_check_contract_pins_stale' });
  assert.equal(checksRun, 0);
  assert.equal(fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId), null);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM delivery_events WHERE project_id=?').get(PROJECT).n, before);
});

test('concurrent finalizeCandidate callers serialize checks through durable state', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request();
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let admissionCalls = 0;
  const admission = {
    async acquire() {
      admissionCalls += 1;
      enter();
      await gate;
      return { executionId: 'concurrent-check-execution' };
    }, recordTurnStart() {}, async release() { return { state: 'released' }; },
  };
  const firstPromise = fx.finalize(request, { admission });
  await entered;
  const second = await fx.finalize(request, { admission });
  assert.equal(second.state, 'checking');
  release();
  const first = await firstPromise;
  assert.equal(first.state, 'accepted');
  assert.equal(admissionCalls, 1);
});

test('ready finalization replay completes the atomic commit without rerunning acceptance', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request();
  const barrier = fx.store.beginFinalization(PROJECT, OBJECTIVE, request, fx.adapters());
  const checkAttemptId = 'ready-recovery-check';
  const checking = fx.store.startFinalizationChecks(PROJECT, OBJECTIVE, {
    finalizationId: request.finalizationId, expectedPinsDigest: barrier.pinsDigest, checkAttemptId,
  }, fx.adapters());
  const candidatePins = checking.pins.candidate;
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore,
    candidate: { projectId: PROJECT, objectiveId: OBJECTIVE, ...candidatePins },
    contract: fx.contract, runId: checkAttemptId, attempt: 1,
    executionPermissions: checking.pins.executionPermissions, admission: fx.admission });
  fx.store.recordFinalizationChecks(PROJECT, OBJECTIVE, {
    finalizationId: request.finalizationId, checkAttemptId, result,
  }, fx.adapters());
  let checksRun = 0;
  const recovered = await fx.finalize(request, { admission: { async acquire() {
    checksRun += 1;
    throw new Error('ready recovery reran checks');
  }, recordTurnStart() {}, async release() { return { state: 'released' }; } } });
  assert.equal(recovered.state, 'accepted');
  assert.equal(recovered.finalization.goalAchieved, true);
  assert.equal(checksRun, 0);
});

test('checking state survives reopen and blocks a second runner after an unproven exception', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request();
  let calls = 0;
  await assert.rejects(fx.finalize(request, { temporaryRoot: path.join(fx.root, 'missing-temp-root') }),
    { code: 'ENOENT' });
  assert.equal(fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId).state, 'checking');
  fx.reopen();
  const replay = await fx.finalize(request, { admission: { async acquire() { calls += 1; return { executionId: 'should-not-run' }; },
    recordTurnStart() {}, async release() { return { state: 'released' }; } } });
  assert.equal(replay.state, 'checking');
  assert.equal(calls, 0);
});

test('unknown runner effects retain context and remain non-retriable after reopen', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const request = fx.request();
  let calls = 0;
  const admission = { async acquire() { calls += 1; throw new Error('admission acknowledgement lost'); },
    recordTurnStart() {}, async release() { return { state: 'released' }; } };
  const outcome = await fx.finalize(request, { admission });
  assert.equal(outcome.state, 'unknown');
  assert.equal(fs.existsSync(outcome.finalization.unknown.workspace), true);
  assert.equal(fs.existsSync(outcome.finalization.unknown.gitControlRoot), true);
  fx.reopen();
  const replay = await fx.finalize(request);
  assert.equal(replay.state, 'unknown');
  assert.equal(calls, 1);
});

test('failed checks and candidate mutation become rejected', async (t) => {
  const failedFx = fixture({ verifyContent: 'process.exit(2);\n' });
  t.after(() => failedFx.close());
  const failed = await failedFx.finalize(failedFx.request('failed-finalization'));
  assert.equal(failed.state, 'rejected');
  assert.notEqual(failed.finalization.checkResult.disposition, 'accepted');

  const fx = fixture({ verifyContent: "require('fs').chmodSync('answer.txt', 0o644);\nrequire('fs').writeFileSync('answer.txt', 'tampered\\n');\nprocess.exit(0);\n",
    extraFiles: { 'answer.txt': 'candidate answer\n' } });
  t.after(() => fx.close());
  const tamperedRequest = fx.request('tampered-finalization');
  const tampered = await fx.finalize(tamperedRequest);
  assert.equal(tampered.state, 'rejected');
  assert.equal(tampered.finalization.checkResult.disposition, 'rejected');
  assert.equal(tampered.finalization.checkResult.checkResults[0].result, 'passed',
    JSON.stringify(tampered.finalization.checkResult.checkResults[0]));
  assert.ok(tampered.finalization.checkResult.issues.some((issue) => issue.code === 'candidate_changed'));
});

test('a control change during checks prevents completion and partial provenance remains store-authored', async (t) => {
  const fx = fixture();
  t.after(() => fx.close());
  const staleRequest = fx.request('paused-finalization');
  const paused = await fx.finalize(staleRequest, { admission: { async acquire() {
    fx.store.transitionLifecycleControl(PROJECT, OBJECTIVE,
      { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
    return { executionId: 'pause-during-check' };
  }, recordTurnStart() {}, async release() { return { state: 'released' }; } } });
  assert.equal(paused.state, 'invalidated');
  assert.equal(fx.store.getObjective(PROJECT, OBJECTIVE).disposition, 'paused_owner');

  const partialFx = fixture({ checkpoints: [{ projectId: PROJECT, objectiveId: OBJECTIVE, checkpointId: 'deferred' }],
    remainderResolver: ({ checkpoint }) => ({ checkpointId: checkpoint.checkpointId, category: 'owner_deferred',
      reason: 'Owner deferred this checkpoint.', evidenceRefs: ['owner:defer-1'] }) });
  t.after(() => partialFx.close());
  const partial = partialFx.request('partial-finalization', 'partial', [
    { id: 'deferred', status: 'blocked', reason: 'model supplied', evidence: ['model:fake'] },
  ]);
  const outcome = await partialFx.finalize(partial);
  assert.equal(outcome.state, 'partial');
  assert.deepEqual(outcome.finalization.ledger[0].evidence, ['owner:defer-1']);
  assert.equal(outcome.finalization.ledger[0].evidence.includes('model:fake'), false);
});
