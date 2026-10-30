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
const { normalizeSpecialistRequest, checkSpecialistRequest } = require('../src/contracts');
const { createDeliveryRoleCapabilities, deliveryRequestDigest, scopedExecutionDetails } = require('../src/delivery-role-capabilities');

function fixture({ disposition = 'executing', applyCorrection = false, executionPermissions = 'inherit' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-verifier-'));
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Capability Test');
  git('config', 'user.email', 'capability@example.invalid');
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'frozen input\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const db = new Database(path.join(root, 'state.sqlite'));
  const now = Date.now();
  const backlogStore = new BacklogStore(db, { now: () => now, roleCapacities: { verifier: 2 }, maxActiveTurns: 4,
    plannerReservedSlots: 1, selectedSettingsResolver: () => ({ model: 'review-model', effort: 'low' }),
    ownerCorrectionAuthorized: () => applyCorrection });
  backlogStore.createObjective({ schemaVersion: VERSION, projectId: 'project', objectiveId: 'objective', sessionId: 'session',
    engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`,
    checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 2, controlRevision: 4, disposition });
  if (applyCorrection) backlogStore.applyOwnerCorrection('project', 'objective', { sourceMessageId: 'owner-correction-1',
    expectedGoalRevision: 1, expectedAuthorityRevision: 2, expectedControlRevision: 4,
    requirementDigest: `sha256:${'d'.repeat(64)}` });
  const candidateStore = new CandidateStore({ db, workspace, storageDir: path.join(root, 'state', 'candidates') });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-one', projectId: 'project', objectiveId: 'objective',
    integrationGeneration: 1, sourceAttemptId: 'source-attempt', environmentDigest: 'c'.repeat(64), checkIdentity: 'checks-v1' });
  const reviewStore = new CandidateReviewStore({ db, candidateStore,
    currentObjective: () => {
      const current = backlogStore.getObjective('project', 'objective');
      return { projectId: current.projectId, objectiveId: current.objectiveId, goalRevision: current.goalRevision,
        requirementDigest: current.requirementDigest.slice(7), checksDigest: current.checksDigest.slice(7),
        authorityRevision: current.authorityRevision, controlRevision: current.controlRevision };
    },
    checkpointInventory: () => [{ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-one' }],
    authorizeCheckpoint: () => true, authorizeProposal: () => true, authorizeBinding: () => true,
    authorizeThread: () => true, authorizeSettlement: () => true, verifyReviewExecution: () => true,
    attestClosure: () => ({ frozen: true }) });
  const objective = backlogStore.getObjective('project', 'objective');
  reviewStore.registerCheckpoint({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-one',
    kind: 'risk_change', reason: 'Review frozen input', checkIdentity: 'checks-v1', checkPins: ['check-v1'],
    toolPins: ['tool-v1'], profilePins: ['profile-v1'], environmentDigest: 'c'.repeat(64),
    requirementDigest: objective.requirementDigest.slice(7), checksDigest: objective.checksDigest.slice(7),
    goalRevision: objective.goalRevision, authorityRevision: objective.authorityRevision,
    controlRevision: objective.controlRevision }, { source: 'owner' });
  const [proposal] = reviewStore.proposeReviews({ projectId: 'project', objectiveId: 'objective', checkpointId: 'checkpoint-one',
    candidateId: candidate.candidateId, reviewers: [{ role: 'verifier' }] }, { source: 'planner' });
  backlogStore.applyPlan('project', 'objective', { schemaVersion: VERSION, expectedPlanRevision: objective.planRevision,
    expectedGoalRevision: objective.goalRevision, expectedAuthorityRevision: objective.authorityRevision,
    expectedControlRevision: objective.controlRevision, nextPlanRevision: objective.planRevision + 1,
    tasks: [{ task: proposal.task }], dependencies: [] });
  const [{ task, attempt: claimedAttempt, claim }] = backlogStore.claimReady('project', 'objective', objective.ownerGeneration,
    { controlRevision: objective.controlRevision, limit: 1 });
  backlogStore.pinSelectedSettings('project', 'objective', claimedAttempt.attemptId, claim.fencingToken, { model: 'review-model', effort: 'low' });
  const attempt = backlogStore.listAttempts('project', 'objective').find((row) => row.attemptId === claimedAttempt.attemptId);
  const request = normalizeSpecialistRequest({ objective: task.objective, allowedFiles: [] }, { id: 'verifier', name: 'verifier', sandbox: 'workspace-write' });
  const requestDigest = deliveryRequestDigest({ request, settingsDigest: attempt.selectedSettingsDigest, taskDigest: attempt.contractDigest });
  const capabilities = createDeliveryRoleCapabilities({ backlogStore, candidateReview: reviewStore,
    executionPermissions,
    projectWorkspaceFor: () => workspace,
    scratchRootFor: ({ attemptId }) => path.join(root, 'scratch', attemptId) });
  const identity = { projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
    attemptId: attempt.attemptId, fencingToken: claim.fencingToken, providerContextId: attempt.providerContextId,
    requestDigest, role: 'verifier', request };
  return { root, db, workspace, reviewStore, candidate, backlogStore, task, attempt, claim, request, requestDigest, identity, capabilities };
}

test('only an independently resolved frozen verifier capability permits empty writable scope', (t) => {
  const fx = fixture();
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'verifier', sandbox: 'workspace-write' };
  assert.throws(() => checkSpecialistRequest(fx.request, role), (error) => error.violations?.[0]?.code === 'writer_scope_missing');
  assert.throws(() => checkSpecialistRequest(fx.request, role, { capability: { ...fx.identity }, requestDigest: fx.identity.requestDigest }),
    (error) => error.violations?.[0]?.code === 'writer_scope_missing');
  const capability = fx.capabilities.resolveVerifierCapability(fx.identity, fx.request);
  const checked = checkSpecialistRequest(fx.request, role, { capability, requestDigest: fx.identity.requestDigest });
  assert.deepEqual(checked.allowedFiles, []);
  assert.throws(() => checkSpecialistRequest({ ...fx.request, inputs: ['forged'] }, role,
    { capability, requestDigest: fx.identity.requestDigest }), (error) => error.violations?.[0]?.code === 'writer_scope_missing');
  assert.equal(Object.hasOwn(checked, 'capabilityId'), false);
  const details = scopedExecutionDetails(capability);
  assert.equal(details.candidateId, 'candidate-one');
  assert.equal(details.inputManifestDigest, fx.candidate.manifestDigest);
  assert.equal(details.verifyCandidate(), true);
  assert.equal(details.permissionWorkspace, fs.realpathSync(fx.workspace));
  assert.equal(path.dirname(details.candidatePath), path.dirname(details.scratchRoot));
  assert.equal(details.pinObservedThread('thread-capability'), 'thread-capability');
});

test('owner full-access is host-bound into the scoped verifier policy while frozen candidate identity remains enforced', (t) => {
  const fx = fixture({ executionPermissions: 'full-access' });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const capability = fx.capabilities.resolveVerifierCapability(fx.identity, fx.request);
  const details = scopedExecutionDetails(capability);
  assert.equal(details.executionPermissions, 'full-access');
  assert.equal(details.executionPolicyDigest, stableDigest({
    permissions: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user',
  }));
  assert.equal(details.permissionWorkspace, fs.realpathSync(fx.workspace));
  assert.equal(details.verifyCandidate(), true);
  assert.equal(details.assertCurrent(), true);
  fs.chmodSync(path.join(details.candidatePath, 'a.txt'), 0o644);
  fs.writeFileSync(path.join(details.candidatePath, 'a.txt'), 'tampered frozen input\n');
  assert.equal(details.verifyCandidate(), false);
});

test('a claimed planning verifier after owner correction resolves its frozen capability', (t) => {
  const fx = fixture({ disposition: 'validating', applyCorrection: true });
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const objective = fx.backlogStore.getObjective('project', 'objective');
  assert.equal(objective.disposition, 'planning');
  assert.equal(objective.goalRevision, 2);
  assert.equal(objective.controlRevision, 5);
  assert.equal(fx.attempt.state, 'claimed');
  assert.equal(fx.claim.state, 'active');
  assert.equal(fx.attempt.capturedControls.controlRevision, objective.controlRevision);
  const capability = fx.capabilities.resolveVerifierCapability(fx.identity, fx.request);
  assert.equal(scopedExecutionDetails(capability).assertCurrent(), true);
});

test('paused, budget-waiting, draining, validating, and terminal objectives still reject verifier capabilities', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-verifier-phases-'));
  const db = new Database(path.join(root, 'state.sqlite'));
  const backlogStore = new BacklogStore(db);
  const candidateReview = { bindClaimedAttempt() {}, prepareReviewInput() {}, verifyReviewInput() { return true; }, pinObservedThread() {} };
  const capabilities = createDeliveryRoleCapabilities({ backlogStore, candidateReview,
    projectWorkspaceFor: () => root, scratchRootFor: () => path.join(root, 'scratch') });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const rejected = ['draining', 'paused_owner', 'waiting_budget', 'waiting_owner', 'recovering', 'blocked_technical',
    'validating', 'accepted', 'partial', 'canceled'];
  for (const [index, disposition] of rejected.entries()) {
    const objectiveId = `objective-${index}`;
    backlogStore.createObjective({ schemaVersion: VERSION, projectId: 'project', objectiveId, sessionId: 'session',
      engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`,
      checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 1, controlRevision: 1, disposition });
    assert.throws(() => capabilities.resolveVerifierCapability({ projectId: 'project', objectiveId,
      taskId: 'task', attemptId: 'attempt', fencingToken: 1, providerContextId: 'provider-context',
      requestDigest: 'c'.repeat(64), request: {} }), { code: 'verifier_objective_inactive' }, disposition);
  }
});

test('stale digests, task identity, product paths, and candidate drift fail closed', (t) => {
  const fx = fixture();
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  assert.throws(() => fx.capabilities.resolveVerifierCapability({ ...fx.identity, requestDigest: '0'.repeat(64) }, fx.request),
    (error) => error.code === 'verifier_request_digest_mismatch');
  assert.throws(() => fx.capabilities.resolveVerifierCapability({ ...fx.identity, taskId: 'other-task' }, fx.request),
    (error) => error.code === 'verifier_attempt_missing');
  const productRequest = { ...fx.request, allowedFiles: ['src/a.js'] };
  const productIdentity = { ...fx.identity, request: productRequest, requestDigest: deliveryRequestDigest({ request: productRequest,
    settingsDigest: fx.attempt.selectedSettingsDigest, taskDigest: fx.attempt.contractDigest }) };
  assert.throws(() => fx.capabilities.resolveVerifierCapability(productIdentity, productRequest),
    (error) => error.code === 'verifier_request_scope_mismatch');
  const capability = fx.capabilities.resolveVerifierCapability(fx.identity, fx.request);
  const details = scopedExecutionDetails(capability);
  fs.chmodSync(path.join(details.candidatePath, 'a.txt'), 0o644);
  fs.writeFileSync(path.join(details.candidatePath, 'a.txt'), 'mutated\n');
  assert.equal(details.verifyCandidate(), false);
  assert.throws(() => details.assertCurrent(), (error) => error.code === 'verifier_capability_stale');
});

test('running verifier claim is accepted only with its durably mapped external task identity', (t) => {
  const fx = fixture();
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  fx.backlogStore.recordSubmitted('project', 'objective', fx.attempt.attemptId, fx.claim.fencingToken, 'external-task-one');
  const mapped = { ...fx.identity, externalTaskId: 'external-task-one' };
  const capability = fx.capabilities.resolveVerifierCapability(mapped, fx.request);
  assert.equal(scopedExecutionDetails(capability).assertCurrent(), true);
  assert.throws(() => fx.capabilities.resolveVerifierCapability({ ...fx.identity, externalTaskId: 'external-task-two' }, fx.request),
    (error) => error.code === 'verifier_claim_stale');
});

test('scoped capability path roots reject workspace overlap and symlinks', (t) => {
  const fx = fixture();
  t.after(() => { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); });
  const overlapping = createDeliveryRoleCapabilities({ backlogStore: fx.backlogStore, candidateReview: fx.reviewStore,
    projectWorkspaceFor: () => fx.workspace, scratchRootFor: () => path.join(fx.workspace, '.scratch') });
  assert.throws(() => overlapping.resolveVerifierCapability(fx.identity, fx.request), (error) => error.code === 'verifier_scratch_workspace_overlap');
  const safeScratch = path.join(fx.root, 'safe-scratch');
  fs.mkdirSync(safeScratch, { recursive: true, mode: 0o700 });
  const linkedScratch = path.join(fx.root, 'linked-scratch');
  fs.symlinkSync(safeScratch, linkedScratch, 'dir');
  const symlinked = createDeliveryRoleCapabilities({ backlogStore: fx.backlogStore, candidateReview: fx.reviewStore,
    projectWorkspaceFor: () => fx.workspace, scratchRootFor: () => linkedScratch });
  assert.throws(() => symlinked.resolveVerifierCapability(fx.identity, fx.request), (error) => error.code === 'verifier_path_symlink');
});
