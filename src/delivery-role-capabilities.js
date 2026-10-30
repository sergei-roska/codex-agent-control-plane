'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stableDigest } = require('./backlog-store');
const { canonicalRoleId } = require('./role-names');

const capabilities = new WeakMap();
const preparedInputs = new Map();
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const reject = (code) => { throw Object.assign(new Error(code), { code }); };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function assertNoSymlinkPath(value, { create = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) reject('verifier_path_invalid');
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) reject('verifier_path_symlink');
      if (!stat.isDirectory()) reject('verifier_path_not_directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create) fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  try { return fs.realpathSync(resolved); } catch (error) {
    if (error.code === 'ENOENT' && !create) return resolved;
    throw error;
  }
}

function deliveryRequestDigest({ request, settingsDigest, taskDigest } = {}) {
  if (!request || typeof settingsDigest !== 'string' || typeof taskDigest !== 'string') reject('verifier_request_digest_input_invalid');
  return stableDigest({ request, settingsDigest, taskDigest });
}

function isScopedVerifierCapability(value, { requestDigest, objective, request } = {}) {
  const state = value && capabilities.get(value);
  if (!state || state.requestDigest !== requestDigest || state.objective !== objective || state.role !== 'verifier') return false;
  try {
    return deliveryRequestDigest({ request, settingsDigest: state.settingsDigest, taskDigest: state.attempt.contractDigest }) === requestDigest;
  } catch (_) { return false; }
}

function scopedExecutionDetails(value) {
  const state = value && capabilities.get(value);
  if (!state) reject('verifier_capability_invalid');
  return Object.freeze({
    capabilityId: state.capabilityId,
    requestDigest: state.requestDigest,
    attemptId: state.attempt.attemptId,
    taskId: state.task.taskId,
    candidateId: state.task.baseCandidateId,
    candidatePath: state.prepared.destination,
    permissionWorkspace: state.workspace,
    inputManifestDigest: state.prepared.inputManifestDigest,
    scratchRoot: state.scratchRoot,
    executionPermissions: state.executionPermissions,
    executionPolicyDigest: state.executionPolicyDigest,
    verifyCandidate: state.verifyCandidate,
    pinObservedThread: state.pinObservedThread,
    settleReviewReceipt: state.settleReviewReceipt,
    assertCurrent: state.assertCurrent,
  });
}

function createDeliveryRoleCapabilities({ backlogStore, candidateReview, projectWorkspaceFor, scratchRootFor, executionPermissions = 'inherit' } = {}) {
  if (!backlogStore || typeof backlogStore.getObjective !== 'function' || typeof backlogStore.listAttempts !== 'function'
    || typeof backlogStore.listClaims !== 'function') throw new TypeError('A BacklogStore is required');
  if (!candidateReview || typeof candidateReview.bindClaimedAttempt !== 'function'
    || typeof candidateReview.prepareReviewInput !== 'function' || typeof candidateReview.verifyReviewInput !== 'function'
    || typeof candidateReview.pinObservedThread !== 'function') throw new TypeError('A CandidateReviewStore is required');
  if (typeof projectWorkspaceFor !== 'function' || typeof scratchRootFor !== 'function') throw new TypeError('Host path callbacks are required');
  if (!['inherit', 'strict', 'full-access'].includes(executionPermissions)) throw new TypeError('executionPermissions is invalid');

  function load(claim) {
    if (!claim || typeof claim !== 'object') reject('verifier_claim_invalid');
    const { projectId, objectiveId, taskId, attemptId, fencingToken, providerContextId, requestDigest } = claim;
    if (![projectId, objectiveId, taskId, attemptId, providerContextId, requestDigest].every((value) => typeof value === 'string' && value)
      || !Number.isSafeInteger(fencingToken)) reject('verifier_claim_invalid');
    const objective = backlogStore.getObjective(projectId, objectiveId);
    if (!objective || !['active', 'planning', 'executing'].includes(objective.disposition)) reject('verifier_objective_inactive');
    const attempt = backlogStore.listAttempts(projectId, objectiveId).find((row) => row.attemptId === attemptId);
    const liveClaim = backlogStore.listClaims(projectId, objectiveId).find((row) => row.attemptId === attemptId);
    const task = objective.tasks.find((row) => row.taskId === taskId);
    const contract = attempt?.contractSnapshot;
    if (!attempt || !liveClaim || !task || !contract) reject('verifier_attempt_missing');
    const claimedState = attempt.state === 'claimed' && task.state === 'claimed';
    const mappedRunningState = attempt.state === 'running' && task.state === 'running'
      && typeof claim.externalTaskId === 'string' && claim.externalTaskId.length > 0
      && attempt.externalTaskId === claim.externalTaskId;
    if (attempt.projectId !== projectId || attempt.objectiveId !== objectiveId || attempt.taskId !== taskId
      || liveClaim.projectId !== projectId || liveClaim.objectiveId !== objectiveId || liveClaim.taskId !== taskId
      || liveClaim.attemptId !== attemptId || liveClaim.fencingToken !== fencingToken || attempt.fencingToken !== fencingToken
      || liveClaim.state !== 'active' || liveClaim.leaseUntil <= Date.now() || (!claimedState && !mappedRunningState)
      || attempt.executionGeneration !== objective.ownerGeneration || liveClaim.ownerGeneration !== objective.ownerGeneration
      || attempt.providerContextId !== providerContextId || task.revision !== attempt.taskRevision
      || stableDigest(contract) !== attempt.contractDigest || stableDigest({ ...task, state: contract.state }) !== attempt.contractDigest
      || attempt.capturedControls?.ownerGeneration !== undefined && attempt.capturedControls.ownerGeneration !== objective.ownerGeneration
      || attempt.capturedControls?.controlRevision !== objective.controlRevision
      || attempt.capturedControls?.authorityRevision !== objective.authorityRevision
      || attempt.capturedControls?.selectedSettingsKnown !== true || !/^sha256:[a-f0-9]{64}$/.test(attempt.selectedSettingsDigest)) reject('verifier_claim_stale');
    if (task.role !== 'verifier' || task.kind !== 'review' || task.productWritePaths?.length !== 0
      || task.publicationAuthority?.state !== 'denied' || (!claimedState && !mappedRunningState) || contract.role !== 'verifier'
      || contract.kind !== 'review' || contract.productWritePaths?.length !== 0
      || contract.publicationAuthority?.state !== 'denied' || contract.revision !== task.revision) reject('verifier_task_not_scoped');
    const expectedDigest = deliveryRequestDigest({ request: claim.request, settingsDigest: attempt.selectedSettingsDigest, taskDigest: attempt.contractDigest });
    if (!claim.request || expectedDigest !== requestDigest) reject('verifier_request_digest_mismatch');
    candidateReview.bindClaimedAttempt({ task, attempt, claim: liveClaim });
    return { objective, attempt, claim: liveClaim, task, contract };
  }

  function resolveVerifierCapability(claim, request = claim?.request) {
    const snapshot = load({ ...claim, request });
    if (canonicalRoleId(claim.role || 'verifier') !== 'verifier' || request?.objective !== snapshot.contract.objective
      || !Array.isArray(request.allowedFiles) || request.allowedFiles.length !== 0) reject('verifier_request_scope_mismatch');
    const workspaceValue = projectWorkspaceFor({ projectId: snapshot.task.projectId });
    let workspace;
    try { workspace = fs.realpathSync(workspaceValue); } catch (_) { reject('verifier_workspace_unavailable'); }
    const scratchValue = scratchRootFor({ projectId: snapshot.task.projectId, objectiveId: snapshot.task.objectiveId,
      taskId: snapshot.task.taskId, attemptId: snapshot.attempt.attemptId });
    const scratchRoot = assertNoSymlinkPath(scratchValue, { create: true });
    if (inside(workspace, scratchRoot) || inside(scratchRoot, workspace)) reject('verifier_scratch_workspace_overlap');
    if ((fs.statSync(scratchRoot).mode & 0o077) !== 0) reject('verifier_scratch_permissions_invalid');
    const candidatePath = assertNoSymlinkPath(`${scratchRoot}.candidate`, { create: false });
    if (inside(workspace, candidatePath) || inside(candidatePath, workspace) || inside(scratchRoot, candidatePath) || inside(candidatePath, scratchRoot)) reject('verifier_candidate_path_overlap');
    const preparedKey = `${snapshot.task.taskId}:${snapshot.task.baseCandidateId}:${snapshot.contract.checks?.checkPins?.length ?? 0}:${candidatePath}`;
    let prepared = preparedInputs.get(preparedKey);
    if (prepared && !candidateReview.verifyReviewInput(prepared)) reject('verifier_candidate_drift');
    if (!prepared) {
      prepared = candidateReview.prepareReviewInput(snapshot.task.taskId, candidatePath);
      preparedInputs.set(preparedKey, prepared);
    }
    if (fs.realpathSync(prepared.destination) !== prepared.destination) reject('verifier_candidate_path_noncanonical');
    const verifyCandidate = () => candidateReview.verifyReviewInput(prepared);
    if (!verifyCandidate()) reject('verifier_candidate_invalid');
    const state = {
      ...snapshot,
      requestDigest: claim.requestDigest,
      settingsDigest: snapshot.attempt.selectedSettingsDigest,
      objective: request.objective,
      role: 'verifier',
      executionPermissions,
      scratchRoot,
      workspace,
      prepared,
      capabilityId: sha256(`${snapshot.task.taskId}:${snapshot.attempt.attemptId}:${claim.requestDigest}:${prepared.inputManifestDigest}`),
      executionPolicyDigest: executionPermissions === 'full-access'
        ? stableDigest({ permissions: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' })
        : stableDigest({ type: 'workspaceWrite', writableRoots: [scratchRoot], networkAccess: true,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true }),
      verifyCandidate,
      assertCurrent() {
        const fresh = load({ ...claim, request });
        if (fresh.attempt.attemptId !== snapshot.attempt.attemptId || fresh.attempt.fencingToken !== snapshot.attempt.fencingToken
          || fresh.attempt.contractDigest !== snapshot.attempt.contractDigest || fresh.attempt.selectedSettingsDigest !== snapshot.attempt.selectedSettingsDigest
          || fresh.objective.ownerGeneration !== snapshot.objective.ownerGeneration || fresh.objective.controlRevision !== snapshot.objective.controlRevision
          || fresh.objective.authorityRevision !== snapshot.objective.authorityRevision || !verifyCandidate()) reject('verifier_capability_stale');
        return true;
      },
      pinObservedThread(threadId) {
        state.assertCurrent();
        return candidateReview.pinObservedThread({ taskId: snapshot.task.taskId, attemptId: snapshot.attempt.attemptId,
          fencingToken: snapshot.attempt.fencingToken, providerContextId: snapshot.attempt.providerContextId, threadId });
      },
      settleReviewReceipt(outcome, evidenceRefs = []) {
        if (!verifyCandidate()) reject('verifier_candidate_drift');
        return candidateReview.settleReceipt({ taskId: snapshot.task.taskId, outcome, evidenceRefs });
      },
    };
    const capability = Object.freeze({ capabilityId: state.capabilityId, attemptId: state.attempt.attemptId,
      taskId: state.task.taskId, requestDigest: state.requestDigest, objective: state.objective });
    capabilities.set(capability, state);
    return capability;
  }

  return Object.freeze({ resolveVerifierCapability });
}

module.exports = {
  createDeliveryRoleCapabilities,
  deliveryRequestDigest,
  isScopedVerifierCapability,
  scopedExecutionDetails,
};
