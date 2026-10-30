'use strict';

const { canonicalRoleId } = require('./role-names');

const normalizeMode = (mode) => mode === 'isolated' ? 'isolated' : mode === 'shared' ? 'shared' : null;
const isReadOnly = (task) => Array.isArray(task?.productWritePaths) && task.productWritePaths.length === 0;
const isCriticalReview = (task) => ['auditor', 'verifier'].includes(canonicalRoleId(task?.role)) || /review|audit|verif(?:y|ication)/i.test(String(task?.kind || ''));

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function anyOverlap(left = [], right = [], overlap = (a, b) => a === b) {
  return left.some((a) => right.some((b) => overlap(a, b)));
}

function resourceConflict(candidate, live, { writerMode, isFrozenReview = () => false } = {}) {
  const mode = normalizeMode(writerMode);
  if (!mode) throw new TypeError('writerMode must be isolated or shared');
  if (typeof isFrozenReview !== 'function') throw new TypeError('isFrozenReview must be a function');
  const candidateReadOnly = isReadOnly(candidate);
  const candidateCritical = isCriticalReview(candidate);
  for (const entry of live || []) {
    const other = entry.task;
    if (!other || entry.claim?.state === 'released') continue;
    const otherReadOnly = isReadOnly(other);
    const otherCritical = isCriticalReview(other);
    const frozenCandidate = candidateReadOnly && isFrozenReview(Object.freeze({ task: candidate, live: entry })) === true;
    const frozenOther = otherReadOnly && isFrozenReview(Object.freeze({ task: other, live: { claim: entry.claim, attempt: entry.attempt, task: entry.task } })) === true;

    if ((candidateCritical && !frozenCandidate && !otherReadOnly)
      || (otherCritical && !frozenOther && !candidateReadOnly)) return { eligible: false, reason: 'review_barrier' };

    if (anyOverlap(candidate.resourceClaims, other.resourceClaims)) return { eligible: false, reason: 'resource_conflict' };
    if (candidate.dependencies?.some((dependency) => dependency.predecessorType === 'task' && dependency.predecessorId === other.taskId)
      || other.dependencies?.some((dependency) => dependency.predecessorType === 'task' && dependency.predecessorId === candidate.taskId)) {
      return { eligible: false, reason: 'dependency_conflict' };
    }

    if ((candidateCritical && frozenCandidate) || (otherCritical && frozenOther)) continue;

    if (candidateReadOnly && otherReadOnly) continue;
    if (mode === 'shared' && !candidateReadOnly && !otherReadOnly) return { eligible: false, reason: 'write_conflict' };
    if (anyOverlap(candidate.productWritePaths, other.productWritePaths, pathOverlaps)) return { eligible: false, reason: 'write_conflict' };
    if (candidate.readScope?.kind !== 'known' && !otherReadOnly) return { eligible: false, reason: 'read_conflict' };
    if (other.readScope?.kind !== 'known' && !candidateReadOnly) return { eligible: false, reason: 'read_conflict' };
    const candidateReads = candidate.readScope?.kind === 'known' ? candidate.readScope.paths : [];
    const otherReads = other.readScope?.kind === 'known' ? other.readScope.paths : [];
    if (anyOverlap(candidate.productWritePaths, otherReads, pathOverlaps)
      || anyOverlap(other.productWritePaths, candidateReads, pathOverlaps)) return { eligible: false, reason: 'read_conflict' };
  }
  return { eligible: true, reason: null };
}

module.exports = { isReadOnly, isCriticalReview, pathOverlaps, resourceConflict };
