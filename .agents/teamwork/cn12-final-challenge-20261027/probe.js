'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../../../src/backlog-store');
const { CandidateStore } = require('../../../src/candidate-store');
const { CandidateReviewStore } = require('../../../src/candidate-review');
const { DeliveryInbox } = require('../../../src/delivery-inbox');
const { DeliveryLifecycle } = require('../../../src/delivery-lifecycle');
const { LeadPlanner } = require('../../../src/lead-planner');
const { validateAcceptanceContract } = require('../../../src/acceptance');
const { finalizeCandidate, runFrozenCandidateChecks } = require('../../../src/delivery-acceptance');

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

async function main() {
  {
    const fx = fixture();
    let db2, lifecycle2;
    try {
      db2 = new Database(fx.dbPath);
      db2.pragma('busy_timeout = 3000');
      const store2 = new BacklogStore(db2, { finalizationAuthorized: () => true,
        finalizationCheckProofAuthorized: () => true, finalizationRecoveryAuthorized: () => true });
      const candidateStore2 = new CandidateStore({ db: db2, workspace: fx.workspace,
        storageDir: path.join(fx.root, 'state', 'candidates'),
        controls: () => ({ allowed: true, fenced: false }),
        admission: { async acquire() { throw new Error('unexpected publication'); }, async release() {}, markUnresolved() {} },
        quiescence: () => true, apply: async () => ({ applied: true }) });
      const reviewStore2 = new CandidateReviewStore({ db: db2, candidateStore: candidateStore2,
        currentObjective: ({ projectId, objectiveId }) => store2.getObjective(projectId, objectiveId),
        checkpointInventory: () => [], attestClosure: () => ({ frozen: true }), authorizeCheckpoint: () => true });
      const inbox2 = new DeliveryInbox(db2, { projectId: PROJECT, sessionId: 'join-session', objectiveId: OBJECTIVE });
      const planner2 = new LeadPlanner({ store: store2, inbox: inbox2, runTurn: async () => ({ state: 'idle' }) });
      lifecycle2 = new DeliveryLifecycle({ store: store2, executor: { db: db2 }, projectId: PROJECT,
        objectiveId: OBJECTIVE, inbox: inbox2, planner: planner2, effectsSettledForShutdown: () => true });
      const request = fx.request('two-handle');
      let entered, release;
      const enteredPromise = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let acquisitions = 0;
      const admission = { async acquire() { acquisitions++; entered(); await gate; return { executionId: 'handle-one' }; },
        recordTurnStart() {}, async release() { return { state: 'released' }; } };
      const firstPromise = fx.finalize(request, { admission });
      try {
        await enteredPromise;
        const second = await finalizeCandidate({ store: store2, candidateStore: candidateStore2,
          reviewStore: reviewStore2, lifecycle: lifecycle2, projectId: PROJECT, objectiveId: OBJECTIVE,
          request, contract: fx.contract, admission: { async acquire() { acquisitions++; throw new Error('duplicate runner'); },
            recordTurnStart() {}, async release() { return { state: 'released' }; } } });
        assert.equal(second.state, 'checking');
      } finally { release(); }
      const first = await firstPromise;
      assert.equal(first.state, 'accepted');
      assert.equal(acquisitions, 1);
      console.log('PASS two SQLite handles: one check, second checking, first accepted');
    } finally { lifecycle2?.close(); db2?.close(); fx.close(); }
  }
  {
    let allowed = true;
    const fx = fixture({ finalizationAuthorized: () => allowed });
    try {
      const request = fx.request('revoked-mid-check');
      await assert.rejects(fx.finalize(request, { admission: { async acquire() { allowed = false;
        return { executionId: 'revoked' }; }, recordTurnStart() {}, async release() { return { state: 'released' }; } } }),
      { code: 'finalization_unauthorized' });
      assert.equal(fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId).state, 'ready');
      assert.equal(fx.store.getObjective(PROJECT, OBJECTIVE).disposition, 'validating');
      assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE ref_type='finalization'").get().n, 0);
      await assert.rejects(fx.finalize(request), { code: 'finalization_unauthorized' });
      console.log('PASS authorization revocation: ready retained, terminal success denied');
    } finally { fx.close(); }
  }
  {
    const fx = fixture();
    try {
      const request = fx.request('terminal-rollback');
      fx.db.exec("CREATE TRIGGER fail_accept_event BEFORE INSERT ON delivery_events WHEN json_extract(NEW.event_json, '$.eventType') = 'objective.accepted' BEGIN SELECT RAISE(ABORT, 'forced terminal event failure'); END");
      await assert.rejects(fx.finalize(request), /forced terminal event failure/);
      const record = fx.store.getFinalization(PROJECT, OBJECTIVE, request.finalizationId);
      assert.equal(record.state, 'ready');
      assert.equal(fx.store.getObjective(PROJECT, OBJECTIVE).disposition, 'validating');
      assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE ref_type='finalization'").get().n, 0);
      assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM candidate_refs WHERE ref_type='finalization_barrier'").get().n, 1);
      fx.db.exec('DROP TRIGGER fail_accept_event');
      const recovery = await fx.finalize(request, { admission: { async acquire() { throw new Error('checks reran'); },
        recordTurnStart() {}, async release() { return { state: 'released' }; } } });
      assert.equal(recovery.state, 'accepted');
      console.log('PASS terminal event rollback: ready/ref/objective atomic, replay commits with no check');
    } finally { fx.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
