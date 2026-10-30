'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore } = require('../src/candidate-store');
const { CandidateReviewStore } = require('../src/candidate-review');
const { BacklogStore, stableDigest } = require('../src/backlog-store');
const { VERSION } = require('../src/delivery-contracts');
const { TaskScheduler } = require('../src/task-scheduler');

const ENV = 'a'.repeat(64);
const CHECKS = 'b'.repeat(64);
const REQUIREMENTS = 'c'.repeat(64);
const SHA = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex');

function fixture(reviewOverrides = {}, backlogOverrides = {}) {
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
    plannerReservedSlots: 1, selectedSettingsResolver: () => ({ model: 'review-test-model' }), ...backlogOverrides });
  backlogStore.createObjective({ schemaVersion: VERSION, projectId: 'project', objectiveId: 'objective', sessionId: 'session-review',
    engineVersion: 'delivery-v1', goalRevision: 3, requirementDigest: `sha256:${REQUIREMENTS}`, checksDigest: `sha256:${CHECKS}`,
    authorityRevision: 2, controlRevision: 4, disposition: 'executing' });
  const candidateStore = new CandidateStore({ db, workspace, storageDir });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-g', projectId: 'project', objectiveId: 'objective',
    integrationGeneration: 1, sourceAttemptId: 'source-attempt-g', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  const objective = { projectId: 'project', objectiveId: 'objective', goalRevision: 3, requirementDigest: REQUIREMENTS,
    checksDigest: CHECKS, authorityRevision: 2, controlRevision: 4, ownerGeneration: 0 };
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

function correctOwner(fx, sourceMessageId, requirementDigest) {
  const current = fx.backlogStore.getObjective('project', 'objective');
  const updated = fx.backlogStore.applyOwnerCorrection('project', 'objective', {
    sourceMessageId, expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, requirementDigest,
  });
  Object.assign(fx.objective, updated);
  return updated;
}

function supersessionInput(sourceMessageId, priorGoalRevision, currentGoalRevision, expectedControlRevision, replacements) {
  return { projectId: 'project', objectiveId: 'objective', sourceMessageId, expectedOwnerGeneration: 0,
    expectedControlRevision, priorGoalRevision, currentGoalRevision, replacements };
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
  const [{ task, attempt, claim }] = fx.backlogStore.claimReady('project', 'objective', 0, { controlRevision: current.controlRevision, limit: 1 });
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

function applyReviewPlan(fx, proposals) {
  const current = fx.backlogStore.getObjective('project', 'objective');
  return fx.backlogStore.applyPlan('project', 'objective', { schemaVersion: VERSION,
    expectedPlanRevision: current.planRevision, expectedGoalRevision: current.goalRevision,
    expectedAuthorityRevision: current.authorityRevision, expectedControlRevision: current.controlRevision,
    nextPlanRevision: current.planRevision + 1, tasks: proposals.map(({ task }) => ({ task })), dependencies: [] });
}

function settledReviewAttempt(fx, proposal, claimed) {
  const { task, attempt, claim } = claimed;
  fx.reviewStore.bindClaimedAttempt({ task, attempt, claim });
  const threadId = `thread-${attempt.attemptId}`;
  fx.reviewStore.pinObservedThread({ taskId: task.taskId, attemptId: attempt.attemptId, fencingToken: claim.fencingToken,
    providerContextId: attempt.providerContextId, threadId });
  fx.backlogStore.pinSelectedSettings('project', 'objective', attempt.attemptId, claim.fencingToken,
    { model: 'review-test-model' });
  fx.backlogStore.settleAttempt('project', 'objective', attempt.attemptId, claim.fencingToken,
    { state: 'succeeded', trusted: true }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true });
  const stored = fx.backlogStore.listAttempts('project', 'objective').find((entry) => entry.attemptId === attempt.attemptId);
  const { contractSnapshot, ...attemptRecord } = stored;
  const fact = { ...attemptRecord, projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
    claimId: claim.claimId, ownerGeneration: claim.ownerGeneration, role: task.role, threadId,
    candidateId: task.baseCandidateId, state: 'succeeded', inputManifestDigest: fx.candidate.manifestDigest,
    checksPassed: true, productWrites: [], outcome: { state: 'succeeded', trusted: true },
    effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } };
  fx.attemptFacts.set(attempt.attemptId, fact);
  return fact;
}

test('candidate review freezes source bytes, proves exact scheduler binding, settles trusted receipts and retains snapshots', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [reviewerA, reviewerB] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }, { role: 'auditor' }]);
  assert.equal(fx.reviewStore.isFrozenReview({ task: reviewerA.task, live: {} }), true);
  assert.equal(fx.reviewStore.isFrozenReview({ task: { ...reviewerA.task, baseCandidateId: 'candidate-other' }, live: {} }), false);
  assert.notEqual(reviewerA.task.taskId, reviewerB.task.taskId);
  assert.equal(Object.hasOwn(reviewerA, 'attemptId'), false);
  assert.equal(Object.hasOwn(reviewerA, 'threadId'), false);
  assert.equal(fx.reviewStore.canReviewTogether(reviewerA.task.taskId, reviewerB.task.taskId), true);

  const copyPath = path.join(fx.root, 'frozen-copy');
  const prepared = fx.reviewStore.prepareReviewInput(reviewerA.task.taskId, copyPath);
  assert.equal(fx.reviewStore.verifyReviewInput(prepared), true);
  fs.writeFileSync(path.join(fx.workspace, 'a.txt'), 'A changed in G+1\n');
  const candidateNext = fx.candidateStore.createCandidate({ candidateId: 'candidate-g-plus-1', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'source-attempt-g-plus-1', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  assert.equal(candidateNext.status, 'known');
  assert.equal(fs.readFileSync(path.join(copyPath, 'a.txt'), 'utf8'), 'A base\n');
  assert.equal(fx.reviewStore.verifyReviewInput(prepared), true);
  fs.chmodSync(path.join(copyPath, 'a.txt'), 0o644);
  fs.writeFileSync(path.join(copyPath, 'a.txt'), 'tampered by reviewer\n');
  assert.equal(fx.reviewStore.verifyReviewInput(prepared), false);
  fs.rmSync(copyPath, { recursive: true, force: true });

  const success = successfulAttempt(fx, reviewerA);
  for (const malformed of [{ ...success, attemptId: 'attempt-impostor' }, { ...success, candidateId: 'candidate-impostor' },
    { ...success, fencingToken: success.fencingToken + 1 }, { ...success, selectedSettingsDigest: `sha256:${'e'.repeat(64)}` }]) {
    fx.attemptFacts.set(success.attemptId, malformed);
    assert.throws(() => fx.reviewStore.settleReceipt({ taskId: reviewerA.task.taskId, outcome: 'passed' }), { code: 'review_attempt_identity_invalid' });
  }
  const bad = { ...success, threadId: 'wrong-thread' };
  fx.attemptFacts.set(success.attemptId, bad);
  assert.throws(() => fx.reviewStore.settleReceipt({ taskId: reviewerA.task.taskId, outcome: 'passed', evidenceRefs: ['report:a'] }), { code: 'review_attempt_identity_invalid' });
  fx.attemptFacts.set(success.attemptId, success);
  const receipt = fx.reviewStore.settleReceipt({ taskId: reviewerA.task.taskId, outcome: 'passed', evidenceRefs: ['report:a'] });
  assert.equal(receipt.candidateId, 'candidate-g');
  assert.equal(receipt.role, 'auditor');
  assert.equal(fx.reviewStore.getReceipt(receipt.receiptId).receiptId, receipt.receiptId);
  assert.equal(fx.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: 'candidate-g', role: 'auditor' }).length, 1);
  assert.throws(() => fx.reviewStore.settleReceipt({ taskId: reviewerA.task.taskId, outcome: 'failed' }), { code: 'review_receipt_duplicate_conflict' });
  const removed = fx.candidateStore.collectGarbage();
  assert.equal(removed.includes(fx.candidate.manifestDigest), false);
  const reopened = new CandidateStore({ db: new Database(fx.dbPath), workspace: fx.workspace, storageDir: fx.storageDir });
  assert.equal(reopened.readManifest(fx.candidate.manifestDigest).digest, fx.candidate.manifestDigest);
  reopened.db.close();
});

test('failed scoped reviewer retry preserves a qualified sibling and cannot qualify a newer candidate', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [reviewerA, reviewerB] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }, { role: 'auditor' }]);
  assert.equal(fx.reviewStore.canReviewTogether(reviewerA.task.taskId, reviewerB.task.taskId), true);
  applyReviewPlan(fx, [reviewerA, reviewerB]);
  const firstClaims = fx.backlogStore.claimReady('project', 'objective', 0, { controlRevision: 4, limit: 2 });
  assert.equal(firstClaims.length, 2);
  const claimByTask = new Map(firstClaims.map((entry) => [entry.task.taskId, entry]));

  const siblingAttempt = settledReviewAttempt(fx, reviewerA, claimByTask.get(reviewerA.task.taskId));
  const siblingReceipt = fx.reviewStore.settleReceipt({ taskId: reviewerA.task.taskId, outcome: 'passed', evidenceRefs: ['report:sibling'] });
  const siblingJson = fx.db.prepare('SELECT receipt_json FROM review_receipts WHERE receipt_id=?').get(siblingReceipt.receiptId).receipt_json;
  const siblingQualification = fx.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: 'candidate-g', role: 'auditor' });

  const failedAttempt = settledReviewAttempt(fx, reviewerB, claimByTask.get(reviewerB.task.taskId));
  const failedReceipt = fx.reviewStore.settleReceipt({ taskId: reviewerB.task.taskId, outcome: 'failed', evidenceRefs: ['report:failed-review'] });
  const failedJson = fx.db.prepare('SELECT receipt_json FROM review_receipts WHERE receipt_id=?').get(failedReceipt.receiptId).receipt_json;
  assert.equal(failedReceipt.outcome, 'failed');
  assert.equal(fx.backlogStore.getObjective('project', 'objective').tasks.find((task) => task.taskId === reviewerB.task.taskId).state, 'succeeded');
  assert.equal(fx.backlogStore.listAttempts('project', 'objective').some((entry) => entry.attemptId === failedAttempt.attemptId && entry.state === 'succeeded'), true);

  const [retry] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  assert.notEqual(retry.task.taskId, reviewerB.task.taskId);
  // The review context pins candidate/check scope; each retry gets a new provider context.
  assert.equal(retry.contextId, reviewerB.contextId);
  assert.equal(retry.inputManifestDigest, reviewerB.inputManifestDigest);
  applyReviewPlan(fx, [retry]);
  const [retryClaim] = fx.backlogStore.claimReady('project', 'objective', 0, { controlRevision: 4, limit: 1 });
  assert.equal(retryClaim.task.taskId, retry.task.taskId);
  const retryAttempt = settledReviewAttempt(fx, retry, retryClaim);
  const retryReceipt = fx.reviewStore.settleReceipt({ taskId: retry.task.taskId, outcome: 'passed', evidenceRefs: ['report:retry'] });

  assert.notEqual(retryAttempt.attemptId, failedAttempt.attemptId);
  assert.notEqual(retryAttempt.providerContextId, failedAttempt.providerContextId);
  assert.equal(fx.reviewStore.getReceipt(failedReceipt.receiptId).receiptId, failedReceipt.receiptId);
  assert.equal(fx.db.prepare('SELECT receipt_json FROM review_receipts WHERE receipt_id=?').get(failedReceipt.receiptId).receipt_json, failedJson);
  assert.equal(fx.reviewStore.getReceipt(retryReceipt.receiptId).candidateId, 'candidate-g');
  assert.equal(retryReceipt.inputManifestDigest, fx.candidate.manifestDigest);
  assert.deepEqual(retryReceipt.checkPins, retry.task.checks.checkPins);
  assert.deepEqual(fx.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: 'candidate-g', role: 'auditor' }),
    [...siblingQualification, retryReceipt]);
  assert.equal(fx.db.prepare('SELECT receipt_json FROM review_receipts WHERE receipt_id=?').get(siblingReceipt.receiptId).receipt_json, siblingJson);
  assert.deepEqual(fx.reviewStore.getReceipt(siblingReceipt.receiptId), siblingReceipt);

  const newer = fx.candidateStore.createCandidate({ candidateId: 'candidate-g-plus-1', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: 'candidate-g', integrationGeneration: 2, sourceAttemptId: 'source-attempt-g-plus-1', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  assert.equal(newer.status, 'known');
  assert.equal(fx.reviewStore.isFinalStabilized({ projectId: 'project', objectiveId: 'objective', candidateId: newer.candidateId, requiredRoles: ['auditor'] }), false);
  assert.equal(fx.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: newer.candidateId, role: 'auditor' }).length, 0);
});

test('claim binding rejects truthy and asynchronous authorization results', (t) => {
  for (const [name, authorizeBinding, code] of [
    ['truthy', () => ({ allowed: true }), 'review_claim_binding_unauthorized'],
    ['async', async () => true, 'claim_binding_authorization_async'],
  ]) {
    const fx = fixture({ authorizeBinding });
    addCheckpoint(fx, 'checkpoint-a', 'a.txt');
    const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
    assert.throws(() => successfulAttempt(fx, proposal), { code }, name);
    fx.db.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('TaskScheduler admits only the registered frozen review task through its live review callback', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  const current = fx.backlogStore.getObjective('project', 'objective');
  fx.backlogStore.applyPlan('project', 'objective', { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1,
    tasks: [{ task: proposal.task }], dependencies: [] });
  const calls = [];
  const scheduler = new TaskScheduler({ store: fx.backlogStore, executor: {
    getAttempt: () => null,
    execute: async (identity) => { calls.push(identity.taskId); return { state: 'submitted' }; },
  }, projectId: 'project', objectiveId: 'objective', roles: ['auditor'], roleLimits: { auditor: 1 },
  writerMode: 'isolated', isFrozenReview: (task) => fx.reviewStore.isFrozenReview(task) });
  const result = await scheduler.runOnce();
  await Promise.all([...scheduler.inFlight.values()]);
  assert.deepEqual(calls, [proposal.task.taskId]);
  assert.deepEqual(result.idle.claimed, [proposal.task.taskId]);
  assert.equal(fx.reviewStore.isFrozenReview({ ...proposal.task, baseCandidateId: 'candidate-forged' }), false);
  scheduler.stop();
});

test('TaskScheduler keeps same-checkpoint verifier evidence ahead of its dependent auditor', async (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [verifier, auditor] = propose(fx, 'checkpoint-a', [{ role: 'verifier' }, { role: 'auditor', dependsOnVerifierEvidence: true }]);
  assert.equal(auditor.task.dependencies[0].predecessorId, verifier.task.taskId);
  const current = fx.backlogStore.getObjective('project', 'objective');
  fx.backlogStore.applyPlan('project', 'objective', { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
    expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
    expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1,
    tasks: [{ task: verifier.task }, { task: auditor.task }], dependencies: [] });
  const calls = [];
  const scheduler = new TaskScheduler({ store: fx.backlogStore, executor: {
    getAttempt: () => null,
    execute: async (identity) => { calls.push(identity.taskId); return { state: 'submitted' }; },
  }, projectId: 'project', objectiveId: 'objective', roles: ['auditor', 'verifier'], roleLimits: { auditor: 1, verifier: 1 },
  writerMode: 'isolated', isFrozenReview: (task) => fx.reviewStore.isFrozenReview(task) });
  const result = await scheduler.runOnce();
  await Promise.all([...scheduler.inFlight.values()]);
  assert.deepEqual(calls, [verifier.task.taskId]);
  assert.deepEqual(result.idle.claimed, [verifier.task.taskId]);
  scheduler.stop();
});

test('settlement rejects stale owner/check identity and rolls back receipt plus event writes', (t) => {
  for (const field of ['goalRevision', 'checksDigest']) {
    const stale = fixture();
    addCheckpoint(stale, 'checkpoint-a', 'a.txt');
    const [proposal] = propose(stale, 'checkpoint-a', [{ role: 'auditor' }]);
    successfulAttempt(stale, proposal);
    stale.objective[field] = field === 'goalRevision' ? stale.objective.goalRevision + 1 : 'd'.repeat(64);
    assert.throws(() => stale.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed' }), { code: 'review_context_stale' }, field);
    assert.equal(stale.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: 'candidate-g' }).length, 0);
    stale.db.close();
    fs.rmSync(stale.root, { recursive: true, force: true });
  }

  const failedWrite = fixture({ eventHook: ({ type }) => { if (type === 'review.receipt_settled') throw new Error('event sink rejected'); } });
  t.after(() => { failedWrite.db.close(); fs.rmSync(failedWrite.root, { recursive: true, force: true }); });
  addCheckpoint(failedWrite, 'checkpoint-a', 'a.txt');
  const [nextProposal] = propose(failedWrite, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(failedWrite, nextProposal);
  assert.throws(() => failedWrite.reviewStore.settleReceipt({ taskId: nextProposal.task.taskId, outcome: 'passed' }), /event sink rejected/);
  assert.equal(failedWrite.db.prepare("SELECT COUNT(*) AS count FROM review_receipts").get().count, 0);
  assert.equal(failedWrite.db.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE candidate_id='candidate-g' AND ref_type='review_receipt'").get().count, 0);
  assert.equal(failedWrite.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: 'candidate-g' }).length, 0);
  assert.equal(failedWrite.reviewStore.events.replay('project').some((event) => event.eventType === 'review.receipt_settled'), false);
});

test('promotion uses the exact immutable source context stored with its receipt', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [first] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, first);
  const receipt = fx.reviewStore.settleReceipt({ taskId: first.task.taskId, outcome: 'passed' });
  const receiptContext = fx.db.prepare('SELECT context_id FROM review_receipts WHERE receipt_id=?').get(receipt.receiptId).context_id;
  fx.known.get('checkpoint-a').readManifest = [{ path: 'b.txt', digest: SHA(fs.readFileSync(path.join(fx.workspace, 'b.txt'))) }];
  const [later] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  const laterContext = fx.db.prepare('SELECT context_id FROM review_tasks WHERE task_id=?').get(later.task.taskId).context_id;
  assert.notEqual(receiptContext, laterContext);
  fs.writeFileSync(path.join(fx.workspace, 'a.txt'), 'changed after original review\n');
  const target = fx.candidateStore.createCandidate({ candidateId: 'candidate-target-context', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'attempt-target-context', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  assert.throws(() => fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: target.candidateId }, { controller: 'attested' }), { code: 'promotion_identity_changed' });
  assert.equal(fx.reviewStore.getReceipt(receipt.receiptId).contextDigest, receipt.contextDigest);
  assert.equal(fx.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: target.candidateId }).length, 0);
});

test('receipt replay preserves the first record across clock advance and reopen without extra writes', (t) => {
  let tick = 1000;
  const fx = fixture({ now: () => tick }); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, proposal);
  const command = { taskId: proposal.task.taskId, outcome: 'passed', evidenceRefs: ['report:a'] };
  const receipt = fx.reviewStore.settleReceipt(command);
  tick = 2000;
  assert.deepEqual(fx.reviewStore.settleReceipt(command), receipt);
  assert.throws(() => fx.reviewStore.settleReceipt({ ...command, evidenceRefs: ['report:changed'] }), { code: 'review_receipt_duplicate_conflict' });
  const reopenedDb = new Database(fx.dbPath);
  const reopenedCandidates = new CandidateStore({ db: reopenedDb, workspace: fx.workspace, storageDir: fx.storageDir });
  const reopenedReviews = new CandidateReviewStore({ db: reopenedDb, candidateStore: reopenedCandidates, now: () => 3000,
    currentObjective: () => fx.objective,
    checkpointInventory: ({ projectId, objectiveId }) => [...fx.known.values()].map((cp) => ({ projectId, objectiveId, checkpointId: cp.checkpointId })),
    attestClosure: ({ checkpointId }) => checkpointId ? { known: true, readManifest: fx.known.get(checkpointId).readManifest, checkpointAncestors: [] } : { frozen: true },
    resolveAttempt: ({ attemptId }) => fx.attemptFacts.get(attemptId), authorizeSettlement: () => true, verifyReviewExecution: () => true });
  assert.deepEqual(reopenedReviews.settleReceipt(command), receipt);
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS count FROM review_receipts').get().count, 1);
  assert.equal(reopenedDb.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE candidate_id='candidate-g' AND ref_type='review_receipt'").get().count, 1);
  assert.equal(reopenedReviews.events.replay('project').filter((event) => event.eventType === 'review.receipt_settled').length, 1);
  reopenedDb.close();
});

test('promotion replay preserves the first record across clock advance and reopen without extra writes', (t) => {
  let tick = 1000;
  const fx = fixture({ now: () => tick }); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, proposal);
  const receipt = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed' });
  fs.writeFileSync(path.join(fx.workspace, 'b.txt'), 'B changed\n');
  const target = fx.candidateStore.createCandidate({ candidateId: 'candidate-promotion-replay', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'attempt-promotion-replay', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  const command = { receiptId: receipt.receiptId, targetCandidateId: target.candidateId };
  const attestation = { controller: 'attested' };
  const promotion = fx.reviewStore.promoteReceipt(command, attestation);
  tick = 2000;
  assert.deepEqual(fx.reviewStore.promoteReceipt(command, attestation), promotion);
  assert.throws(() => fx.reviewStore.promoteReceipt(command, { controller: 'different' }), { code: 'review_promotion_duplicate_conflict' });
  const reopenedDb = new Database(fx.dbPath);
  const reopenedCandidates = new CandidateStore({ db: reopenedDb, workspace: fx.workspace, storageDir: fx.storageDir });
  const reopenedReviews = new CandidateReviewStore({ db: reopenedDb, candidateStore: reopenedCandidates, now: () => 3000,
    currentObjective: () => fx.objective,
    checkpointInventory: ({ projectId, objectiveId }) => [...fx.known.values()].map((cp) => ({ projectId, objectiveId, checkpointId: cp.checkpointId })),
    attestClosure: ({ checkpointId }) => checkpointId ? { known: true, readManifest: fx.known.get(checkpointId).readManifest, checkpointAncestors: [] } : { frozen: true },
    attestPromotion: () => true });
  assert.deepEqual(reopenedReviews.promoteReceipt(command, attestation), promotion);
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS count FROM review_promotions').get().count, 1);
  assert.equal(reopenedDb.prepare('SELECT COUNT(*) AS count FROM review_contexts WHERE candidate_id=?').get(target.candidateId).count, 1);
  assert.equal(reopenedDb.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE candidate_id=? AND ref_type='review_promotion'").get(target.candidateId).count, 1);
  assert.equal(reopenedReviews.events.replay('project').filter((event) => event.eventType === 'review.receipt_promoted').length, 1);
  reopenedDb.close();
});

test('conflicting settlement after stale preflight preserves the committed winner through GC and reopen', (t) => {
  let armed = false;
  let fx;
  let winner;
  fx = fixture({ now: () => {
    if (armed) {
      armed = false;
      winner = fx.reviewStore.settleReceipt({ taskId: fx.racedTaskId, outcome: 'passed' });
    }
    return 1000;
  } });
  t.after(() => { if (fx.db.open) fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, proposal);
  fx.racedTaskId = proposal.task.taskId;
  armed = true;
  assert.throws(() => fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'failed' }), { code: 'review_receipt_duplicate_conflict' });
  assert.equal(fx.reviewStore.getReceipt(winner.receiptId).outcome, 'passed');
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM review_receipts').get().count, 1);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE ref_id=? AND ref_type='review_receipt'").get(winner.receiptId).count, 1);
  assert.equal(fx.reviewStore.events.replay('project').filter((event) => event.eventType === 'review.receipt_settled').length, 1);
  assert.equal(fx.candidateStore.collectGarbage().includes(fx.candidate.candidateId), false);
  const reopenedDb = new Database(fx.dbPath);
  const reopenedCandidates = new CandidateStore({ db: reopenedDb, workspace: fx.workspace, storageDir: fx.storageDir });
  assert.equal(reopenedCandidates.get(fx.candidate.candidateId).status, 'known');
  assert.equal(reopenedCandidates.collectGarbage().includes(fx.candidate.candidateId), false);
  reopenedDb.close();
});

test('conflicting promotion after stale preflight preserves the committed winner through GC and reopen', (t) => {
  let armed = false;
  let fx;
  let winner;
  let command;
  fx = fixture({ now: () => {
    if (armed) {
      armed = false;
      winner = fx.reviewStore.promoteReceipt(command, { controller: 'winner' });
    }
    return 1000;
  } });
  t.after(() => { if (fx.db.open) fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const [proposal] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, proposal);
  const receipt = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed' });
  fs.writeFileSync(path.join(fx.workspace, 'b.txt'), 'B changed\n');
  const target = fx.candidateStore.createCandidate({ candidateId: 'candidate-raced-promotion', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'attempt-raced-promotion', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  command = { receiptId: receipt.receiptId, targetCandidateId: target.candidateId };
  armed = true;
  assert.throws(() => fx.reviewStore.promoteReceipt(command, { controller: 'loser' }), { code: 'review_promotion_duplicate_conflict' });
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM review_promotions').get().count, 1);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE ref_id=? AND ref_type='review_promotion'").get(winner.promotionId).count, 1);
  assert.equal(fx.reviewStore.events.replay('project').filter((event) => event.eventType === 'review.receipt_promoted').length, 1);
  assert.equal(fx.candidateStore.collectGarbage().includes(target.candidateId), false);
  const reopenedDb = new Database(fx.dbPath);
  const reopenedCandidates = new CandidateStore({ db: reopenedDb, workspace: fx.workspace, storageDir: fx.storageDir });
  assert.equal(reopenedCandidates.get(target.candidateId).status, 'known');
  assert.equal(reopenedCandidates.collectGarbage().includes(target.candidateId), false);
  reopenedDb.close();
});

test('review context proposal reference and rows roll back together on event failure', (t) => {
  const fx = fixture({ eventHook: ({ type }) => { if (type === 'review.tasks_proposed') throw new Error('proposal event rejected'); } });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  assert.throws(() => propose(fx, 'checkpoint-a', [{ role: 'auditor' }]), /proposal event rejected/);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM review_contexts').get().count, 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM review_tasks').get().count, 0);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE candidate_id='candidate-g' AND ref_type='review_context'").get().count, 0);
  assert.equal(fx.reviewStore.events.replay('project').some((event) => event.eventType === 'review.tasks_proposed'), false);
});

test('failed proposal after a committed duplicate context preserves the winner reference', (t) => {
  let armed = false;
  let proposalEvents = 0;
  let fx;
  let winner;
  fx = fixture({
    authorizeProposal: ({ projectId, objectiveId, checkpointId, candidateId }) => {
      if (armed) {
        armed = false;
        winner = fx.reviewStore.proposeReviews({ projectId, objectiveId, checkpointId, candidateId, reviewers: [{ role: 'auditor' }] }, { source: 'nested-winner' });
      }
      return true;
    },
    eventHook: ({ type }) => {
      if (type !== 'review.tasks_proposed') return;
      proposalEvents += 1;
      if (proposalEvents === 2) throw new Error('losing proposal event rejected');
    },
  });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  armed = true;
  assert.throws(() => propose(fx, 'checkpoint-a', [{ role: 'auditor' }]), /losing proposal event rejected/);
  assert.ok(winner);
  assert.ok(fx.reviewStore.getReviewTask(winner[0].task.taskId));
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM review_contexts').get().count, 1);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM review_tasks').get().count, 1);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS count FROM candidate_refs WHERE candidate_id='candidate-g' AND ref_type='review_context'").get().count, 1);
  assert.equal(fx.reviewStore.events.replay('project').filter((event) => event.eventType === 'review.tasks_proposed').length, 1);
  assert.equal(fx.candidateStore.collectGarbage().includes(fx.candidate.candidateId), false);
});

test('proposal validates registered checkpoint ancestry and preserves acceptance dependencies', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  const bytes = fs.readFileSync(path.join(fx.workspace, 'b.txt'));
  fx.known.set('checkpoint-b', { checkpointId: 'checkpoint-b', readManifest: [{ path: 'b.txt', digest: SHA(bytes) }], checkpointAncestors: ['checkpoint-a'] });
  fx.reviewStore.registerCheckpoint({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-b', kind: 'risk_change',
    reason: 'Inspect dependent checkpoint', checkIdentity: 'check-set-v1', checkPins: ['check-v1'], toolPins: ['tool-v1'],
    profilePins: ['auditor-v1'], environmentDigest: ENV, dependsOn: ['checkpoint-a'] }, { source: 'owner' });
  const [proposal] = propose(fx, 'checkpoint-b', [{ role: 'auditor' }]);
  assert.deepEqual(proposal.task.dependencies, [{ projectId: 'project', objectiveId: 'objective', predecessorType: 'checkpoint',
    predecessorId: 'checkpoint-a', successorTaskId: proposal.task.taskId, kind: 'requires_acceptance' }]);
  fx.known.get('checkpoint-b').checkpointAncestors = ['checkpoint-a', 'checkpoint-foreign'];
  assert.throws(() => propose(fx, 'checkpoint-b', [{ role: 'auditor' }]), { code: 'review_closure_checkpoint_scope_invalid' });
  fx.known.get('checkpoint-b').checkpointAncestors = [];
  assert.throws(() => propose(fx, 'checkpoint-b', [{ role: 'auditor' }]), { code: 'review_closure_ancestry_incomplete' });
});

test('verifier ordering is evidence-bound; distinct checkpoints remain independent; only unchanged attested closures promote', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-a', 'a.txt');
  addCheckpoint(fx, 'checkpoint-b', 'b.txt');
  const verifier = propose(fx, 'checkpoint-a', [{ role: 'verifier' }])[0];
  const dependentAuditor = propose(fx, 'checkpoint-a', [{ role: 'auditor', dependsOnVerifierEvidence: true }])[0];
  const independentAuditor = propose(fx, 'checkpoint-b', [{ role: 'auditor' }])[0];
  assert.equal(dependentAuditor.task.dependencies[0].predecessorId, verifier.task.taskId);
  assert.equal(dependentAuditor.task.dependencies[0].kind, 'requires_output');
  assert.equal(independentAuditor.task.dependencies.length, 0);
  assert.equal(fx.reviewStore.canReviewTogether(dependentAuditor.task.taskId, independentAuditor.task.taskId), true);
  assert.equal(fx.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).length, 2);

  const [auditor] = propose(fx, 'checkpoint-a', [{ role: 'auditor' }]);
  successfulAttempt(fx, auditor);
  const receipt = fx.reviewStore.settleReceipt({ taskId: auditor.task.taskId, outcome: 'passed' });
  fs.writeFileSync(path.join(fx.workspace, 'b.txt'), 'unrelated change\n');
  const next = fx.candidateStore.createCandidate({ candidateId: 'candidate-next', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'attempt-next', environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  assert.equal(fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: next.candidateId }, { controller: 'attested' }).targetCandidateId, next.candidateId);
  assert.equal(fx.reviewStore.getReceipt(receipt.receiptId).candidateId, fx.candidate.candidateId);
  assert.equal(fx.reviewStore.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: next.candidateId, role: 'auditor' }).length, 1);
  const environmentDrift = fx.candidateStore.createCandidate({ candidateId: 'candidate-env-drift', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: next.candidateId, integrationGeneration: 3, sourceAttemptId: 'attempt-env-drift', environmentDigest: 'f'.repeat(64), checkIdentity: 'check-set-v1' });
  assert.throws(() => fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: environmentDrift.candidateId }, { controller: 'attested' }), { code: 'promotion_identity_changed' });
  const checkDrift = fx.candidateStore.createCandidate({ candidateId: 'candidate-check-drift', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: environmentDrift.candidateId, integrationGeneration: 4, sourceAttemptId: 'attempt-check-drift', environmentDigest: ENV, checkIdentity: 'check-set-v2' });
  assert.throws(() => fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: checkDrift.candidateId }, { controller: 'attested' }), { code: 'promotion_identity_changed' });
  fx.known.get('checkpoint-a').readManifest = [{ path: 'a.txt', digest: SHA(Buffer.from('drift')) }];
  assert.throws(() => fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: next.candidateId }, { controller: 'attested' }), { code: 'promotion_identity_changed' });
  fx.known.delete('checkpoint-a');
  assert.throws(() => fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: next.candidateId }, { controller: 'attested' }), { code: 'promotion_identity_changed' });
  assert.equal(fx.reviewStore.isFinalStabilized({ projectId: 'project', objectiveId: 'objective', candidateId: next.candidateId }), false);
  const reopenedDb = new Database(fx.dbPath);
  const reopenedCandidates = new CandidateStore({ db: reopenedDb, workspace: fx.workspace, storageDir: fx.storageDir });
  const reopenedReviews = new CandidateReviewStore({ db: reopenedDb, candidateStore: reopenedCandidates,
    currentObjective: () => fx.objective, checkpointInventory: ({ projectId, objectiveId }) => [...fx.known.values()].map((cp) => ({ projectId, objectiveId, checkpointId: cp.checkpointId })),
    authorizeCheckpoint: () => true, authorizeProposal: () => true, authorizeBinding: () => true, authorizeThread: () => true,
    resolveAttempt: () => null, authorizeSettlement: () => true, verifyReviewExecution: () => true,
    attestClosure: ({ checkpointId }) => checkpointId === undefined ? { frozen: true } : { known: true, readManifest: [{ path: 'a.txt', digest: SHA(fs.readFileSync(path.join(fx.workspace, 'a.txt'))) }], checkpointAncestors: [] },
    attestPromotion: () => true });
  assert.equal(reopenedReviews.getReceipt(receipt.receiptId).candidateId, fx.candidate.candidateId);
  assert.equal(reopenedReviews.qualification({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-a', candidateId: next.candidateId, role: 'auditor' }).length, 1);
  reopenedDb.close();
});

test('finalization projection exposes exact qualified receipts and refuses undrained review tasks', (t) => {
  const fx = fixture(); t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  addCheckpoint(fx, 'checkpoint-final', 'a.txt');

  const before = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId });
  assert.equal(before.frozen, true);
  assert.equal(before.complete, false);
  assert.deepEqual(before.missingReceipts, [{ checkpointId: 'checkpoint-final', role: 'verifier' }]);

  const [proposal] = propose(fx, 'checkpoint-final', [{ role: 'verifier' }]);
  const withQueuedReview = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId });
  assert.equal(withQueuedReview.complete, false);
  assert.equal(withQueuedReview.pendingReviewTasks.length, 1);
  assert.equal(withQueuedReview.pendingReviewTasks[0].taskId, proposal.task.taskId);

  successfulAttempt(fx, proposal);
  const receipt = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed', evidenceRefs: ['evidence:final-review'] });
  const projection = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId });
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.missingReceipts, []);
  assert.deepEqual(projection.pendingReviewTasks, []);
  assert.equal(projection.receipts.length, 1);
  assert.equal(projection.receipts[0].qualified, true);
  assert.equal(projection.receipts[0].receipt.receiptId, receipt.receiptId);
  assert.equal(projection.receipts[0].targetCandidateId, fx.candidate.candidateId);
  assert.equal(projection.receipts[0].sourceContextId, projection.receipts[0].targetContextId);
  assert.equal(projection.receipts[0].currentClosureDigest, projection.requirements[0].closure.digest);
  assert.equal(projection.objectivePins.goalRevision, fx.objective.goalRevision);
  assert.equal(projection.candidatePins.manifestDigest, fx.candidate.manifestDigest);

  fs.writeFileSync(path.join(fx.workspace, 'b.txt'), 'unrelated change after review\n');
  const next = fx.candidateStore.createCandidate({ candidateId: 'candidate-final-next', projectId: 'project', objectiveId: 'objective',
    parentCandidateId: fx.candidate.candidateId, integrationGeneration: 2, sourceAttemptId: 'source-attempt-final-next',
    environmentDigest: ENV, checkIdentity: 'check-set-v1' });
  const promotion = fx.reviewStore.promoteReceipt({ receiptId: receipt.receiptId, targetCandidateId: next.candidateId }, { controller: 'attested' });
  const promoted = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: next.candidateId });
  assert.equal(promoted.complete, true);
  assert.equal(promoted.receipts[0].bindingKind, 'promotion');
  assert.equal(promoted.receipts[0].bindingId, promotion.promotionId);
  assert.equal(promoted.receipts[0].qualified, true);
  assert.equal(promoted.receipts[0].receipt.candidateId, fx.candidate.candidateId);
  assert.equal(promoted.receipts[0].targetCandidateId, next.candidateId);
});

test('owner checkpoint supersession keeps stale obligations active until authorized replacement and preserves history', (t) => {
  const authorizationCalls = [];
  const fx = fixture({ authorizeCheckpointSupersession: (context) => {
    authorizationCalls.push(context);
    return context.input.sourceMessageId === 'owner-correction-1' && context.mapping.length === 1;
  } }, { ownerCorrectionAuthorized: () => true });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const old = addCheckpoint(fx, 'checkpoint-owner-v1', 'a.txt');
  const [proposal] = propose(fx, old.checkpointId, [{ role: 'verifier' }]);
  successfulAttempt(fx, proposal);
  const receipt = fx.reviewStore.settleReceipt({ taskId: proposal.task.taskId, outcome: 'passed', evidenceRefs: ['owner:review-v1'] });

  const corrected = correctOwner(fx, 'owner-correction-1', `sha256:${'d'.repeat(64)}`);
  assert.equal(corrected.goalRevision, 4);
  assert.equal(corrected.controlRevision, 5);
  assert.deepEqual(fx.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId), [old.checkpointId]);
  assert.equal(fx.reviewStore.isCheckpointActive({ projectId: 'project', objectiveId: 'objective', checkpointId: old.checkpointId }), true);
  assert.equal(fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId }).complete, false);

  const replacement = addCheckpoint(fx, 'checkpoint-owner-v2', 'b.txt');
  const input = supersessionInput('owner-correction-1', 3, 4, 5,
    [{ checkpointId: old.checkpointId, replacementCheckpointId: replacement.checkpointId }]);
  assert.deepEqual(fx.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId).sort(),
    [old.checkpointId, replacement.checkpointId].sort());
  const beforeEvents = fx.reviewStore.events.replay('project').length;
  const supersession = fx.reviewStore.supersedeCheckpoints(input, { correction: 'attested' });
  assert.equal(supersession.sourceMessageId, 'owner-correction-1');
  assert.deepEqual(fx.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId), [replacement.checkpointId]);
  assert.equal(fx.reviewStore.isCheckpointActive({ projectId: 'project', objectiveId: 'objective', checkpointId: old.checkpointId }), false);
  assert.equal(fx.reviewStore.isCheckpointActive({ projectId: 'project', objectiveId: 'objective', checkpointId: replacement.checkpointId }), true);
  const projection = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId });
  assert.deepEqual(projection.requirements.map((row) => row.checkpointId), [replacement.checkpointId]);
  assert.equal(projection.receipts.some((row) => row.receipt.receiptId === receipt.receiptId && row.qualified === false), true);
  assert.deepEqual(fx.reviewStore.checkpointHistory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpoint.checkpointId),
    [old.checkpointId, replacement.checkpointId].sort());
  assert.equal(fx.reviewStore.getReceipt(receipt.receiptId).checkpointId, old.checkpointId);

  assert.deepEqual(fx.reviewStore.supersedeCheckpoints(input, { correction: 'attested' }), supersession);
  assert.equal(authorizationCalls.length, 2);
  assert.throws(() => fx.reviewStore.supersedeCheckpoints({ ...input, replacements: [
    { checkpointId: old.checkpointId, replacementCheckpointId: 'checkpoint-owner-conflict' },
  ] }, { correction: 'attested' }), { code: 'review_checkpoint_supersession_source_conflict' });
  assert.equal(fx.reviewStore.events.replay('project').length, beforeEvents + 1);
  assert.equal(fx.reviewStore.events.replay('project').filter((event) => event.eventType === 'review.checkpoints_superseded').length, 1);
  assert.equal(Object.isFrozen(authorizationCalls[0]), true);
  assert.equal(authorizationCalls[0].priorCheckpoints[0].checkpoint.checkIdentity, old.checkIdentity);
  assert.match(authorizationCalls[0].replacementCheckpoints[0].checkpointDigest, /^sha256:/);

  const reopenedDb = new Database(fx.dbPath);
  const reopenedCandidates = new CandidateStore({ db: reopenedDb, workspace: fx.workspace, storageDir: fx.storageDir });
  const reopenedReviews = new CandidateReviewStore({ db: reopenedDb, candidateStore: reopenedCandidates,
    currentObjective: () => fx.objective, checkpointInventory: ({ projectId, objectiveId }) => [...fx.known.values()]
      .map((checkpoint) => ({ projectId, objectiveId, checkpointId: checkpoint.checkpointId })),
    authorizeCheckpointSupersession: () => true, attestClosure: () => ({ frozen: true }) });
  assert.deepEqual(reopenedReviews.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId), [replacement.checkpointId]);
  assert.equal(reopenedReviews.checkpointHistory({ projectId: 'project', objectiveId: 'objective' }).length, 2);
  assert.equal(reopenedReviews.getReceipt(receipt.receiptId).checkpointId, old.checkpointId);
  reopenedDb.close();
});

test('finalization ignores a retired queued review but blocks the current replacement review until its receipt settles', (t) => {
  const fx = fixture({ authorizeCheckpointSupersession: () => true }, { ownerCorrectionAuthorized: () => true });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const oldCheckpoint = addCheckpoint(fx, 'queued-owner-v1', 'a.txt');
  const [oldProposal] = propose(fx, oldCheckpoint.checkpointId, [{ role: 'verifier' }]);
  const [boundOldProposal] = propose(fx, oldCheckpoint.checkpointId, [{ role: 'verifier' }]);
  const boundOldFact = successfulAttempt(fx, boundOldProposal);
  fx.attemptFacts.set(boundOldFact.attemptId, { ...boundOldFact, state: 'running', claimState: 'active',
    effect: { remoteQuiescent: false, processQuiescent: false, effectsSettled: false } });

  correctOwner(fx, 'queued-owner-correction', `sha256:${'d'.repeat(64)}`);
  const currentCheckpoint = addCheckpoint(fx, 'queued-owner-v2', 'b.txt');
  fx.reviewStore.supersedeCheckpoints(supersessionInput('queued-owner-correction', 3, 4, 5,
    [{ checkpointId: oldCheckpoint.checkpointId, replacementCheckpointId: currentCheckpoint.checkpointId }]), { source: 'owner' });

  const [currentProposal] = propose(fx, currentCheckpoint.checkpointId, [{ role: 'verifier' }]);
  const whileCurrentReviewQueued = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId });
  assert.deepEqual(whileCurrentReviewQueued.requirements.map((row) => row.checkpointId), [currentCheckpoint.checkpointId]);
  assert.equal(whileCurrentReviewQueued.complete, false);
  assert.deepEqual(whileCurrentReviewQueued.pendingReviewTasks.map((row) => row.taskId).sort(),
    [boundOldProposal.task.taskId, currentProposal.task.taskId].sort());
  assert.equal(whileCurrentReviewQueued.pendingReviewTasks.some((row) => row.taskId === oldProposal.task.taskId), false);

  successfulAttempt(fx, currentProposal);
  fx.reviewStore.settleReceipt({ taskId: currentProposal.task.taskId, outcome: 'passed', evidenceRefs: ['owner:review-v2'] });
  assert.equal(fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId })
    .pendingReviewTasks.some((row) => row.taskId === boundOldProposal.task.taskId), true);

  fx.backlogStore.settleAttempt('project', 'objective', boundOldFact.attemptId, boundOldFact.fencingToken,
    { state: 'failed', trusted: false }, { remoteQuiescent: true, processQuiescent: true, effectsSettled: true });
  fx.attemptFacts.set(boundOldFact.attemptId, { ...boundOldFact, state: 'failed', claimState: 'released',
    outcome: { state: 'failed', trusted: false }, effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } });
  const afterCurrentReceipt = fx.reviewStore.finalizationProjection({ projectId: 'project', objectiveId: 'objective', candidateId: fx.candidate.candidateId });
  assert.equal(afterCurrentReceipt.complete, true);
  assert.deepEqual(afterCurrentReceipt.pendingReviewTasks, []);
  assert.equal(fx.db.prepare('SELECT state FROM review_tasks WHERE task_id=?').get(oldProposal.task.taskId).state, 'queued');
  assert.equal(fx.backlogStore.getObjective('project', 'objective').tasks.find((task) => task.taskId === boundOldProposal.task.taskId).state, 'failed');
  assert.equal(fx.reviewStore.checkpointHistory({ projectId: 'project', objectiveId: 'objective' }).length, 2);
});

test('owner checkpoint supersession defaults to deny, requires exact coverage and rejects stale or downgraded mappings atomically', (t) => {
  const fixtures = [];
  const make = (reviewOverrides = {}) => {
    const fx = fixture(reviewOverrides, { ownerCorrectionAuthorized: () => true });
    fixtures.push(fx);
    return fx;
  };
  t.after(() => { for (const fx of fixtures) { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); } });

  const denied = make();
  const deniedOld = addCheckpoint(denied, 'denied-old', 'a.txt');
  correctOwner(denied, 'denied-source', `sha256:${'d'.repeat(64)}`);
  const deniedNew = addCheckpoint(denied, 'denied-new', 'b.txt');
  const deniedInput = supersessionInput('denied-source', 3, 4, 5,
    [{ checkpointId: deniedOld.checkpointId, replacementCheckpointId: deniedNew.checkpointId }]);
  assert.throws(() => denied.reviewStore.supersedeCheckpoints(deniedInput), { code: 'review_checkpoint_supersession_unauthorized' });
  assert.deepEqual(denied.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId).sort(),
    [deniedOld.checkpointId, deniedNew.checkpointId].sort());
  assert.equal(denied.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);

  for (const [authorizeCheckpointSupersession, code] of [
    [() => ({ allowed: true }), 'review_checkpoint_supersession_unauthorized'],
    [async () => true, 'checkpoint_supersession_authorization_async'],
  ]) {
    const invalidAuth = make({ authorizeCheckpointSupersession });
    const invalidOld = addCheckpoint(invalidAuth, `invalid-auth-old-${code}`, 'a.txt');
    correctOwner(invalidAuth, `invalid-auth-source-${code}`, `sha256:${'d'.repeat(64)}`);
    const invalidNew = addCheckpoint(invalidAuth, `invalid-auth-new-${code}`, 'b.txt');
    assert.throws(() => invalidAuth.reviewStore.supersedeCheckpoints(supersessionInput(`invalid-auth-source-${code}`, 3, 4, 5,
      [{ checkpointId: invalidOld.checkpointId, replacementCheckpointId: invalidNew.checkpointId }]), { correction: 'untrusted' }), { code });
    assert.equal(invalidAuth.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);
  }

  const incomplete = make({ authorizeCheckpointSupersession: () => true });
  const oldA = addCheckpoint(incomplete, 'incomplete-old-a', 'a.txt');
  const oldB = addCheckpoint(incomplete, 'incomplete-old-b', 'b.txt');
  correctOwner(incomplete, 'incomplete-source', `sha256:${'d'.repeat(64)}`);
  const newA = addCheckpoint(incomplete, 'incomplete-new-a', 'a.txt');
  assert.throws(() => incomplete.reviewStore.supersedeCheckpoints(supersessionInput('incomplete-source', 3, 4, 5,
    [{ checkpointId: oldA.checkpointId, replacementCheckpointId: newA.checkpointId }])), { code: 'review_checkpoint_supersession_incomplete' });
  assert.equal(incomplete.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);
  assert.deepEqual(incomplete.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId).sort(),
    [oldA.checkpointId, oldB.checkpointId, newA.checkpointId].sort());

  const stale = make({ authorizeCheckpointSupersession: () => true });
  const staleOld = addCheckpoint(stale, 'stale-old', 'a.txt');
  correctOwner(stale, 'stale-source', `sha256:${'d'.repeat(64)}`);
  const staleNew = addCheckpoint(stale, 'stale-new', 'b.txt');
  assert.throws(() => stale.reviewStore.supersedeCheckpoints(supersessionInput('stale-source', 3, 4, 4,
    [{ checkpointId: staleOld.checkpointId, replacementCheckpointId: staleNew.checkpointId }])), { code: 'review_checkpoint_supersession_pins_stale' });
  assert.equal(stale.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);

  const downgrade = make({ authorizeCheckpointSupersession: () => true });
  const criticalOld = addCheckpoint(downgrade, 'critical-old', 'a.txt');
  correctOwner(downgrade, 'downgrade-source', `sha256:${'d'.repeat(64)}`);
  downgrade.known.set('noncritical-new', { checkpointId: 'noncritical-new', readManifest: [{ path: 'b.txt', digest: SHA(fs.readFileSync(path.join(downgrade.workspace, 'b.txt'))) }] });
  const noncriticalNew = downgrade.reviewStore.registerCheckpoint({ projectId: 'project', objectiveId: 'objective', checkpointId: 'noncritical-new', kind: 'ordinary',
    reason: 'Owner replacement', checkIdentity: 'check-set-v1', checkPins: ['check-v1'], toolPins: ['tool-v1'], profilePins: ['auditor-v1'], environmentDigest: ENV }, { source: 'owner' });
  assert.equal(criticalOld.critical, true);
  assert.equal(noncriticalNew.critical, false);
  assert.throws(() => downgrade.reviewStore.supersedeCheckpoints(supersessionInput('downgrade-source', 3, 4, 5,
    [{ checkpointId: criticalOld.checkpointId, replacementCheckpointId: noncriticalNew.checkpointId }])), { code: 'review_checkpoint_supersession_critical_downgrade' });
  assert.equal(downgrade.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);

  const outside = make({ authorizeCheckpointSupersession: () => true });
  const outsideOld = addCheckpoint(outside, 'outside-old', 'a.txt');
  correctOwner(outside, 'outside-source', `sha256:${'d'.repeat(64)}`);
  const outsideNew = addCheckpoint(outside, 'outside-new', 'b.txt');
  outside.known.delete(outsideNew.checkpointId);
  assert.throws(() => outside.reviewStore.supersedeCheckpoints(supersessionInput('outside-source', 3, 4, 5,
    [{ checkpointId: outsideOld.checkpointId, replacementCheckpointId: outsideNew.checkpointId }])),
  { code: 'review_checkpoint_supersession_replacement_in_inventory' });
  assert.equal(outside.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);
});

test('owner checkpoint supersession rolls back relation and event together, requires fresh replay auth, and supports sequential corrections', (t) => {
  let allowed = true;
  const fx = fixture({ authorizeCheckpointSupersession: () => allowed }, { ownerCorrectionAuthorized: () => true });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const first = addCheckpoint(fx, 'sequence-v1', 'a.txt');
  correctOwner(fx, 'sequence-source-1', `sha256:${'d'.repeat(64)}`);
  const second = addCheckpoint(fx, 'sequence-v2', 'b.txt');
  const input1 = supersessionInput('sequence-source-1', 3, 4, 5,
    [{ checkpointId: first.checkpointId, replacementCheckpointId: second.checkpointId }]);

  fx.reviewStore.eventHook = (event) => { if (event.type === 'review.checkpoints_superseded') throw new Error('injected supersession hook failure'); };
  assert.throws(() => fx.reviewStore.supersedeCheckpoints(input1, { correction: 'attested' }), /injected supersession hook failure/);
  assert.deepEqual(fx.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId).sort(),
    [first.checkpointId, second.checkpointId].sort());
  assert.equal(fx.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' }).length, 0);
  assert.equal(fx.reviewStore.events.replay('project').filter((event) => event.eventType === 'review.checkpoints_superseded').length, 0);
  fx.reviewStore.eventHook = null;

  const saved = fx.reviewStore.supersedeCheckpoints(input1, { correction: 'attested' });
  allowed = false;
  assert.throws(() => fx.reviewStore.supersedeCheckpoints(input1, { correction: 'attested' }), { code: 'review_checkpoint_supersession_unauthorized' });
  allowed = true;
  correctOwner(fx, 'sequence-source-2', `sha256:${'e'.repeat(64)}`);
  const third = addCheckpoint(fx, 'sequence-v3', 'a.txt');
  const input2 = supersessionInput('sequence-source-2', 4, 5, 6,
    [{ checkpointId: second.checkpointId, replacementCheckpointId: third.checkpointId }]);
  assert.throws(() => fx.reviewStore.supersedeCheckpoints(supersessionInput('sequence-source-2', 4, 5, 6,
    [{ checkpointId: second.checkpointId, replacementCheckpointId: first.checkpointId }]), { correction: 'attested-2' }),
  { code: 'review_checkpoint_supersession_cycle' });
  fx.reviewStore.supersedeCheckpoints(input2, { correction: 'attested-2' });
  assert.deepEqual(fx.reviewStore.checkpointInventory({ projectId: 'project', objectiveId: 'objective' }).map((row) => row.checkpointId), [third.checkpointId]);
  assert.equal(fx.reviewStore.checkpointHistory({ projectId: 'project', objectiveId: 'objective' }).length, 3);
  assert.deepEqual(fx.reviewStore.checkpointSupersessions({ projectId: 'project', objectiveId: 'objective' })
    .map((entry) => entry.sourceMessageId), ['sequence-source-1', 'sequence-source-2']);
  assert.throws(() => fx.reviewStore.supersedeCheckpoints(input1, { correction: 'attested' }),
    { code: 'review_checkpoint_supersession_pins_stale' });
  assert.equal(saved.sourceMessageId, 'sequence-source-1');
});
