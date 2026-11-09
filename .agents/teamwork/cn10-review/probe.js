'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-store');
const { CandidateReviewStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-review');
const { BacklogStore, stableDigest } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/backlog-store');
const { VERSION } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-contracts');
const { TaskScheduler } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/task-scheduler');

const ENV = 'a'.repeat(64);
const CHECKS = 'b'.repeat(64);
const REQUIREMENTS = 'c'.repeat(64);
const SHA = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex');

function fixture(reviewOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-review-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'review@example.invalid');
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'A base\n');
  fs.writeFileSync(path.join(workspace, 'b.txt'), 'B base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const dbPath = path.join(root, 'state.sqlite');
  const db = new Database(dbPath);
  const backlogStore = new BacklogStore(db, { now: () => 1000, roleCapacities: { auditor: 8, verifier: 8 }, maxActiveTurns: 20,
    plannerReservedSlots: 1, selectedSettingsResolver: () => ({ model: 'review-test-model' }) });
  backlogStore.createObjective({ schemaVersion: VERSION, projectId: 'project', objectiveId: 'objective', sessionId: 'session-review',
    engineVersion: 'delivery-v1', goalRevision: 3, requirementDigest: `sha256:${REQUIREMENTS}`, checksDigest: `sha256:${CHECKS}`,
    authorityRevision: 2, controlRevision: 4, disposition: 'executing' });
  const candidateStore = new CandidateStore({ db, workspace, storageDir });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-g', projectId: 'project', objectiveId: 'objective',
    integrationGeneration: 1, sourceAttemptId: 'source-attempt-g', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  const objective = { projectId: 'project', objectiveId: 'objective', goalRevision: 3, requirementDigest: REQUIREMENTS,
    checksDigest: CHECKS, authorityRevision: 2, controlRevision: 4 };
  const known = new Map();
  const attemptFacts = new Map();
  const reviewStore = new CandidateReviewStore({ db, candidateStore,
    currentObjective: () => objective,
    checkpointInventory: ({ projectId, objectiveId }) => [...known.values()].map((cp) => ({ projectId, objectiveId, checkpointId: cp.checkpointId })),
    authorizeCheckpoint: () => true, authorizeProposal: () => true,
    attestClosure: ({ checkpointId, candidate }) => {
      if (checkpointId === undefined) return { frozen: true };
      const entry = known.get(checkpointId);
      if (!entry) return null;
      return { known: true, readManifest: entry.readManifest, checkpointAncestors: entry.checkpointAncestors || [] };
    },
    authorizeBinding: ({ attempt, claim }) => fxAttemptMatches(backlogStore, attempt, claim),
    authorizeThread: ({ binding, threadId }) => threadId === `thread-${binding.attemptId}`,
    resolveAttempt: ({ attemptId }) => attemptFacts.get(attemptId) || null,
    authorizeSettlement: () => true, verifyReviewExecution: () => true,
    attestPromotion: () => true,
    ...reviewOverrides,
  });
  return { root, workspace, storageDir, dbPath, db, git, candidateStore, candidate, reviewStore, backlogStore, objective, known, attemptFacts };
}

function fxAttemptMatches(backlogStore, attempt, claim) {
  const storedAttempt = backlogStore.listAttempts('project', 'objective').find((entry) => entry.attemptId === attempt.attemptId);
  const storedClaim = backlogStore.listClaims('project', 'objective').find((entry) => entry.claimId === claim.claimId);
  const { contractSnapshot, ...attemptRecord } = storedAttempt || {};
  return storedAttempt && storedClaim && stableDigest(attemptRecord) === stableDigest(attempt)
    && stableDigest(contractSnapshot) === attempt.contractDigest
    && stableDigest(storedClaim) === stableDigest(claim);
}

function addCheckpoint(fx, checkpointId, file, ancestors = []) {
  const bytes = fs.readFileSync(path.join(fx.workspace, file));
  const readManifest = [{ path: file, digest: SHA(bytes) }];
  fx.known.set(checkpointId, { checkpointId, readManifest, checkpointAncestors: ancestors });
  return fx.reviewStore.registerCheckpoint({ projectId: 'project', objectiveId: 'objective', checkpointId,
    kind: 'risk_change', reason: `Inspect ${checkpointId}`, checkIdentity: 'check-set-v1', checkPins: ['check-v1'],
    toolPins: ['tool-v1'], profilePins: ['auditor-v1'], environmentDigest: ENV }, { source: 'owner' });
}

function propose(fx, checkpointId, reviewers) {
  return fx.reviewStore.proposeReviews({ projectId: 'project', objectiveId: 'objective', checkpointId,
    candidateId: fx.candidate.candidateId, reviewers }, { source: 'planner' });
}

function successfulAttempt(fx, proposal) {
  const current = fx.backlogStore.getObjective('project', 'objective');
  fx.backlogStore.applyPlan('project', 'objective', { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1, tasks: [{ task: proposal.task }], dependencies: [] });
  const [{ task, attempt, claim }] = fx.backlogStore.claimReady('project', 'objective', 0, { controlRevision: 4, limit: 1 });
  fx.reviewStore.bindClaimedAttempt({ task, attempt, claim });
  const threadId = `thread-${attempt.attemptId}`;
  fx.reviewStore.pinObservedThread({ taskId: task.taskId, attemptId: attempt.attemptId, fencingToken: claim.fencingToken,
    providerContextId: attempt.providerContextId, threadId });
  const fact = { ...attempt, projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
    claimId: claim.claimId, ownerGeneration: claim.ownerGeneration, role: task.role, threadId,
    candidateId: task.baseCandidateId, state: 'succeeded', inputManifestDigest: fx.candidate.manifestDigest,
    checksPassed: true, productWrites: [], outcome: { state: 'succeeded', trusted: true },
    effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } };
  fx.attemptFacts.set(attempt.attemptId, fact);
  return fact;
}

const fx = fixture();
try {
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [first] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, first);
  const receipt = fx.reviewStore.settleReceipt({ taskId: first.task.taskId, outcome: 'passed' });
  const original = fx.db.prepare('SELECT context_json FROM review_contexts WHERE context_id=(SELECT context_id FROM review_receipts WHERE receipt_id=?)').get(receipt.receiptId);
  fx.known.get('checkpoint-a').readManifest = [{ path: 'b.txt', digest: SHA(fs.readFileSync(path.join(fx.workspace, 'b.txt'))) }];
  const [second] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  const newer = fx.db.prepare('SELECT context_json FROM review_contexts WHERE context_id=(SELECT context_id FROM review_tasks WHERE task_id=?)').get(second.task.taskId);
  fs.writeFileSync(path.join(fx.workspace, 'a.txt'), 'changed after old review\n');
  const target = fx.candidateStore.createCandidate({ candidateId: 'candidate-target', projectId: 'project', objectiveId: 'objective', parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'source-target', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  const promoted = fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: target.candidateId }, { trusted: true });
  console.log(JSON.stringify({ originalContext: JSON.parse(original.context_json).contextId, newerContext: JSON.parse(newer.context_json).contextId, originalClosure: JSON.parse(original.context_json).closure.readManifest, newerClosure: JSON.parse(newer.context_json).closure.readManifest, promoted: promoted.targetCandidateId }));
} finally { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }
const fy = fixture();
try {
  addCheckpoint(fy, 'checkpoint-a', 'a.txt');
  fy.known.set('checkpoint-b', { checkpointId: 'checkpoint-b', readManifest: [{ path: 'b.txt', digest: SHA(fs.readFileSync(path.join(fy.workspace, 'b.txt'))) }], checkpointAncestors: ['checkpoint-a'] });
  fy.reviewStore.registerCheckpoint({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-b', kind: 'risk_change', reason: 'Inspect dependent checkpoint', checkIdentity: 'check-set-v1', checkPins: ['check-v1'], toolPins: ['tool-v1'], profilePins: ['auditor-v1'], environmentDigest: ENV, dependsOn: ['checkpoint-a'] }, { source: 'owner' });
  try { propose(fy, 'checkpoint-b', [{ role: 'auditor' }]); console.log('dependent proposal succeeded'); }
  catch (error) { console.log(JSON.stringify({ dependentProposalError: error.code })); }
} finally { fy.db.close(); fs.rmSync(fy.root, { recursive: true, force: true }); }
