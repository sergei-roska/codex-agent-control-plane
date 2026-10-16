'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { currentPins } = require('./acceptance');

const POLICY_ID = 'auditor-routing/v1';
const REVIEW_TARGET_ID = 'review-target/v1';
const GATED_REVIEW_KINDS = new Set(['risk_change', 'performance', 'component_complete', 'owner_request', 'pinned_check']);
const MAX_FILES = 5000;
const MAX_DEPTH = 24;
const MAX_BYTES = 64 * 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isGatedReview(review) {
  return Boolean(review && GATED_REVIEW_KINDS.has(review.kind));
}

function sameReviewScope(left, right) {
  if (!left || !right) return false;
  const paths = (value) => [...value.paths].sort();
  return left.kind === right.kind
    && left.checkpointId === right.checkpointId
    && left.reason === right.reason
    && JSON.stringify(paths(left)) === JSON.stringify(paths(right))
    && JSON.stringify([...left.evidenceIds].sort()) === JSON.stringify([...right.evidenceIds].sort())
    && JSON.stringify([...(left.prerequisiteFor || [])].sort()) === JSON.stringify([...(right.prerequisiteFor || [])].sort());
}

function unknown(reason) {
  return { known: false, identity: null, reason: String(reason).slice(0, 300), files: 0, bytes: 0 };
}

function nearestExistingInside(root, target) {
  let current = target;
  for (;;) {
    try {
      fs.lstatSync(current);
      const resolved = fs.realpathSync(current);
      return isWithin(root, resolved) ? resolved : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Compute a scoped, run-bound identity. Unreadable or escaping symlinks return unknown. */
function computeReviewTarget({ workspace, review, runId = null, goal = '', checks = [], requirementContext = null } = {}) {
  if (!review || !Array.isArray(review.paths) || review.paths.length === 0) return unknown('review_scope_missing');
  let root;
  try { root = fs.realpathSync(workspace); } catch (_) { return unknown('workspace_unavailable'); }
  const entries = [];
  const active = new Set();
  let files = 0;
  let bytes = 0;

  const walk = (logicalPath, actualPath, depth) => {
    if (depth > MAX_DEPTH) throw new Error('scope_depth_limit');
    files += 1;
    if (files > MAX_FILES) throw new Error('scope_file_limit');
    let stat;
    try { stat = fs.lstatSync(actualPath); } catch (error) {
      if (error?.code === 'ENOENT') {
        if (!nearestExistingInside(root, actualPath)) throw new Error('scope_path_or_parent_escape');
        entries.push({ path: logicalPath, type: 'missing' });
        return;
      }
      throw new Error('scope_unreadable');
    }
    let resolved;
    try { resolved = fs.realpathSync(actualPath); } catch (_) { throw new Error('scope_path_unreadable'); }
    if (!isWithin(root, resolved)) throw new Error('scope_path_escape');
    if (stat.isSymbolicLink()) {
      entries.push({ path: logicalPath, type: 'symlink', target: path.relative(root, resolved).split(path.sep).join('/') });
      try { stat = fs.statSync(resolved); } catch (_) { throw new Error('scope_symlink_unreadable'); }
    }
    if (stat.isDirectory()) {
      const key = path.resolve(resolved);
      if (active.has(key)) throw new Error('scope_symlink_cycle');
      active.add(key);
      let names;
      try { names = fs.readdirSync(resolved).sort(); } catch (_) { throw new Error('scope_unreadable'); }
      entries.push({ path: logicalPath, type: 'directory', entries: names.length });
      for (const name of names) {
        walk(`${logicalPath}/${name}`, path.join(resolved, name), depth + 1);
      }
      active.delete(key);
      return;
    }
    if (!stat.isFile()) throw new Error('scope_special_file');
    if (stat.size < 0 || bytes + stat.size > MAX_BYTES) throw new Error('scope_byte_limit');
    let content;
    try { content = fs.readFileSync(resolved); } catch (_) { throw new Error('scope_unreadable'); }
    bytes += content.length;
    entries.push({ path: logicalPath, type: 'file', bytes: content.length, sha256: sha256(content) });
  };

  try {
    for (const scopePath of [...review.paths].sort()) {
      if (typeof scopePath !== 'string' || !scopePath || scopePath.includes('\\') || path.posix.isAbsolute(scopePath)
        || scopePath.split('/').some((part) => !part || part === '.' || part === '..')) return unknown('scope_path_unsafe');
      const target = path.resolve(root, ...scopePath.split('/'));
      if (!isWithin(root, target)) return unknown('scope_path_escape');
      walk(scopePath, target, 0);
    }
  } catch (error) {
    return unknown(error?.message || 'scope_identity_unavailable');
  }

  let checkContext;
  try {
    checkContext = checks.map((check) => ({
      id: check.id,
      argvSha256: sha256(JSON.stringify(check.argv || [])),
      pins: currentPins(check, root),
    }));
  } catch (_) {
    return unknown('check_pins_unavailable');
  }
  const context = {
    policy: POLICY_ID,
    runId: runId || null,
    kind: review.kind,
    checkpointId: review.checkpointId,
    reason: review.reason,
    paths: [...review.paths].sort(),
    evidenceIds: [...review.evidenceIds].sort(),
    ...((review.prerequisiteFor || []).length > 0
      ? { prerequisiteFor: [...review.prerequisiteFor].sort() }
      : {}),
    goalSha256: sha256(String(goal || '')),
    requirementContext: requirementContext === null ? null : sha256(JSON.stringify(requirementContext)),
    checks: checkContext,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type)),
  };
  return {
    known: true,
    identity: `${REVIEW_TARGET_ID}:${sha256(JSON.stringify(context))}`,
    reason: null,
    files,
    bytes,
  };
}

function auditVerdict(report) {
  const first = String(report?.summary || '').split(/\r?\n/, 1)[0];
  const match = /^VERDICT: (pass|fail|inconclusive)$/.exec(first);
  return match ? match[1] : null;
}

function explicitVerifierVerdict(report) {
  const first = String(report?.summary || '').split(/\r?\n/, 1)[0];
  const match = /^VERDICT: (pass|fail|inconclusive)(?=$|\s|[.!:,;])/.exec(first);
  return match ? match[1] : null;
}

function inspectedScopeMatch(filesInspected, review) {
  if (!review || !Array.isArray(review.paths)) return true;
  const normalize = (value) => {
    if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) return null;
    const parts = value.replace(/^\.\//, '').replace(/\/$/, '').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) return null;
    return parts.join('/');
  };
  const scope = review.paths.map(normalize).filter(Boolean);
  return filesInspected.some((file) => {
    const inspected = normalize(file);
    return inspected && scope.some((entry) => inspected === entry || inspected.startsWith(`${entry}/`));
  });
}

function reviewResult(outcome, role, review = null) {
  const report = outcome?.report;
  const base = {
    valid: false,
    status: 'inconclusive',
    verdict: null,
    reason: 'review_evidence_unavailable',
  };
  if (!outcome || outcome.status !== 'TASK_STATE_COMPLETED' || !report || report.outcome !== 'completed' || report.decisionRequest) {
    return { ...base, reason: 'review_report_invalid_or_incomplete' };
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (checks.length === 0 || checks.some((check) => check.result !== 'passed')) {
    return { ...base, reason: 'review_checks_failed_or_unrun' };
  }
  if (!Array.isArray(report.filesInspected) || report.filesInspected.length === 0) {
    return { ...base, reason: 'review_has_no_inspected_evidence' };
  }
  if (!inspectedScopeMatch(report.filesInspected, review)) {
    return { ...base, reason: 'review_did_not_inspect_declared_scope' };
  }
  const failures = (outcome.boundary?.results || []).filter((entry) => entry.result !== 'PASS' && !entry.advisory);
  if (failures.length > 0) return { ...base, reason: 'review_boundary_failed' };
  if (outcome.sandbox !== 'read-only') {
    const writer = outcome.writerExecution;
    const delta = writer?.delta;
    const emptyLaneReview = role === 'verifier'
      && writer?.state === null
      && writer?.lane?.state === 'not_integrated'
      && writer.lane.reason === 'no_changes'
      && delta?.known === true
      && delta.source === 'lane_collection'
      && delta.headChanged === false
      && Array.isArray(delta.changedPaths)
      && delta.changedPaths.length === 0
      && delta.changedPathCount === 0;
    if (!writer || (!(['released', 'reconciled'].includes(writer.state) && delta?.known === true) && !emptyLaneReview)) {
      return { ...base, reason: 'review_writer_unsettled' };
    }
    if (emptyLaneReview) {
      const coverage = outcome.reviewCoverage;
      const identityKnown = (typeof coverage?.targetIdentity === 'string' && coverage.targetIdentity.length > 0)
        || coverage?.identityPresent === true;
      if (coverage?.targetKnown !== true || !identityKnown || coverage.stable !== true) {
        return { ...base, reason: 'review_target_unknown_or_changed' };
      }
      const scopeFailures = (outcome.boundary?.results || []).filter((entry) => /scope|lane_scope/.test(String(entry.code || '')));
      if (scopeFailures.length > 0 || (outcome.scopeViolations || []).length > 0
        || (outcome.attestedScopeViolations || []).length > 0) {
        return { ...base, reason: 'review_scope_violation' };
      }
    }
  }
  if (role === 'auditor') {
    const verdict = auditVerdict(report);
    if (!verdict) return { ...base, reason: 'audit_verdict_missing_or_invalid' };
    if (verdict !== 'pass') return { ...base, verdict, reason: `audit_verdict_${verdict}` };
    return { valid: true, status: 'accepted', verdict, reason: null };
  }
  if (role === 'verifier') {
    const verdict = explicitVerifierVerdict(report);
    if (verdict === 'fail' || verdict === 'inconclusive') {
      return { ...base, verdict, reason: `verifier_verdict_${verdict}` };
    }
  }
  return { valid: true, status: 'accepted', verdict: null, reason: null };
}

module.exports = {
  POLICY_ID,
  REVIEW_TARGET_ID,
  GATED_REVIEW_KINDS,
  isGatedReview,
  sameReviewScope,
  computeReviewTarget,
  auditVerdict,
  inspectedScopeMatch,
  reviewResult,
};
