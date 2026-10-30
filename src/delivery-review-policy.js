'use strict';

const crypto = require('node:crypto');
const { VERSION, validateReceipt } = require('./delivery-contracts');

const CRITICAL_KINDS = new Set(['risk_change', 'performance', 'component_complete', 'owner_request', 'pinned_check']);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value) => `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
function id(value, name) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value)) fail('review_identity_invalid', `${name} must be a printable ID`);
  return value;
}
function digestValue(value, name) {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) fail('review_digest_invalid', `${name} must be a SHA-256 digest`);
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}
function pins(value, name) {
  if (!Array.isArray(value) || value.length > 100) fail('review_pins_invalid', `${name} must be an array`);
  const result = value.map((item) => id(item, name));
  if (new Set(result).size !== result.length) fail('review_pins_duplicate', `${name} contains duplicates`);
  return result.sort();
}
function normalizeClosure(value) {
  if (!value || value.known !== true || !Array.isArray(value.readManifest) || !Array.isArray(value.checkpointAncestors)) {
    return { known: false, readManifest: [], checkpointAncestors: [], digest: null };
  }
  const readManifest = value.readManifest.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) fail('review_closure_path_invalid');
    return { path: entry.path, digest: digestValue(entry.digest, 'readManifest.digest') };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(readManifest.map((entry) => entry.path)).size !== readManifest.length) fail('review_closure_duplicate_path');
  const checkpointAncestors = [...new Set(value.checkpointAncestors.map((entry) => id(entry, 'checkpointAncestor')))].sort();
  const checkpointId = value.checkpointId == null ? null : id(value.checkpointId, 'checkpointId');
  return { known: true, checkpointId, readManifest, checkpointAncestors,
    digest: digest({ checkpointId, readManifest, checkpointAncestors }) };
}
function closuresIndependent(left, right) {
  if (!left?.known || !right?.known) return false;
  const leftAncestors = new Set(left.checkpointAncestors);
  const rightAncestors = new Set(right.checkpointAncestors);
  return !leftAncestors.has(right.checkpointId) && !rightAncestors.has(left.checkpointId);
}
function samePromotionIdentity(source, target) {
  return source.projectId === target.projectId && source.objectiveId === target.objectiveId
    && source.requirementDigest === target.requirementDigest && source.checkIdentity === target.checkIdentity
    && source.checkPins.join('\0') === target.checkPins.join('\0')
    && source.toolPins.join('\0') === target.toolPins.join('\0')
    && source.profilePins.join('\0') === target.profilePins.join('\0')
    && source.environmentDigest === target.environmentDigest
    && source.closure?.known === true && target.closure?.known === true
    && source.closure.digest === target.closure.digest;
}
function reviewDependencyEdges(checkpoints, proposals) {
  const byId = new Map(checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]));
  const edges = [];
  for (const proposal of proposals) {
    const checkpoint = byId.get(proposal.checkpointId);
    if (!checkpoint) fail('review_checkpoint_missing');
    for (const dependency of checkpoint.dependsOn || []) {
      if (!byId.has(dependency)) fail('review_checkpoint_dependency_missing');
      edges.push({ predecessorCheckpointId: dependency, successorCheckpointId: checkpoint.checkpointId, evidenceBound: true });
    }
    if (proposal.role === 'auditor' && proposal.dependsOnVerifierEvidence === true) {
      edges.push({ predecessorRole: 'verifier', predecessorCheckpointId: checkpoint.checkpointId,
        successorRole: 'auditor', successorCheckpointId: checkpoint.checkpointId, evidenceBound: true });
    }
  }
  return edges;
}
function frozenReviewMatches(task, registered) {
  if (!task || !registered || task.kind !== 'review' || task.productWritePaths?.length) return false;
  const entry = registered.task;
  return task.projectId === entry.projectId && task.objectiveId === entry.objectiveId
    && task.taskId === entry.taskId && task.revision === entry.revision
    && task.role === entry.role && task.baseCandidateId === entry.baseCandidateId
    && task.checkpointId === entry.checkpointId
    && registered.context.candidateId === entry.baseCandidateId && typeof registered.context.contextDigest === 'string' && registered.candidate.status === 'known'
    && registered.candidate.manifestDigest === registered.context.candidateManifestDigest;
}
function projectReceipt(receipt) {
  return validateReceipt({ schemaVersion: VERSION, projectId: receipt.projectId, objectiveId: receipt.objectiveId,
    receiptId: receipt.receiptId, checkpointId: receipt.checkpointId, candidateId: receipt.candidateId,
    contextDigest: receipt.contextDigest, inputManifestDigest: receipt.inputManifestDigest,
    checkPins: receipt.checkPins, toolPins: receipt.toolPins, profilePins: receipt.profilePins,
    role: receipt.role, attemptId: receipt.attemptId, outcome: receipt.outcome,
    evidenceRefs: receipt.evidenceRefs, createdAt: receipt.createdAt });
}

module.exports = { CRITICAL_KINDS, canonical, digest, clone, deepFreeze, fail, id, digestValue, pins,
  normalizeClosure, closuresIndependent, samePromotionIdentity, reviewDependencyEdges, frozenReviewMatches, projectReceipt };
