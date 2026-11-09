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
const { VERSION } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-contracts');
const { BacklogStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/backlog-store');
const { CandidateStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-store');
const { CandidateReviewStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-review');
const { DeliveryInbox } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-inbox');
const { DeliveryLifecycle } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-lifecycle');
const { LeadPlanner } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/lead-planner');
const { runFrozenCandidateChecks } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-acceptance');
const { validateAcceptanceContract } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/acceptance');

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

const FINAL_PROJECT = 'finalization-project';
const FINAL_OBJECTIVE = 'finalization-objective';
const FINAL_REQUIREMENTS = `sha256:${'d'.repeat(64)}`;
const FINAL_CHECKS = `sha256:${'e'.repeat(64)}`;
const digestText = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function finalizationFixture({ beforeEventInsert, finalizationRemainderResolver, reviewOverrides = {} } = {}) {
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
    finalizationAuthorized: () => true,
    finalizationCheckProofAuthorized: ({ result }) => ['accepted', 'rejected', 'unverifiable'].includes(result?.disposition),
    finalizationRecoveryAuthorized: () => true,
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
      executionPermissions: 'strict', scratchEnabled: false, partialLedger: null };
  };
  const adapters = { candidateStore, reviewStore, lifecycle };
  const admission = { async acquire() { return { executionId: 'final-check-execution' }; }, recordTurnStart() {},
    async release() { return { state: 'released' }; } };
  const close = ({ remove = true } = {}) => { lifecycle.close(); db.close(); if (remove) fs.rmSync(root, { recursive: true, force: true }); };
  return { root, workspace, dbPath, db, store, candidateStore, candidate, reviewStore, inbox, planner, lifecycle,
    contract, request, adapters, admission, applyCalls: () => applyCalls, close };
}

(async () => {
  const fx = finalizationFixture();
  try {
    const request = fx.request();
    const barrier = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
    fx.store.finalizationAuthorized = () => false;
    const replay = fx.store.beginFinalization(FINAL_PROJECT, FINAL_OBJECTIVE, request, fx.adapters);
    console.log(JSON.stringify({ beginReplayState: replay.state, replay: replay.replay, finalizationAuthorizationRevoked: true }));
  } finally { fx.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
