'use strict';

// Pure route logic for the lead runtime (ADR adaptive-delivery-route): which stages are required,
// which are skipped, and how the post-implement delta is judged. No I/O, no state.

const { evaluateDelta, resolveRouteLimits } = require('./route-gate');

const SATISFIED = Object.freeze(['succeeded', 'skipped']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function emptyRouting() {
  return {
    effective: 'full', skipStageIds: [], conditionalStageIds: [], gateStageIds: [], limits: resolveRouteLimits(null), purposeOverrides: {},
  };
}

// Normalized routing of a plan. Anything but an explicit lean routing is the full route.
function routingOf(plan) {
  const raw = isObject(plan) ? plan.routing : null;
  if (!isObject(raw) || raw.effective !== 'lean') return emptyRouting();
  const known = new Set((Array.isArray(plan.stages) ? plan.stages : []).map((stage) => stage && stage.stageId));
  const ids = (list) => (Array.isArray(list) ? list.filter((id, index) => typeof id === 'string' && known.has(id) && list.indexOf(id) === index) : []);
  const overrides = {};
  if (isObject(raw.purposeOverrides)) {
    Object.entries(raw.purposeOverrides).forEach(([id, text]) => { if (known.has(id) && typeof text === 'string') overrides[id] = text; });
  }
  return {
    effective: 'lean',
    skipStageIds: ids(raw.skipStageIds),
    conditionalStageIds: ids(raw.conditionalStageIds),
    gateStageIds: ids(raw.gateStageIds),
    limits: resolveRouteLimits(raw.limits),
    purposeOverrides: overrides,
  };
}

// The one place a lean routing is derived: from the preset lean block, the validated plan and the project
// policy. Callers never take skip/conditional/gate sets, limits or classification from client metadata.
// `isWritableRole(roleId)` says whether a stage role may write; every writable stage is a gate stage.
function buildLeanRouting({ preset, plan, projectConfig, isWritableRole } = {}) {
  const lean = isObject(preset) ? preset.lean : null;
  const stages = isObject(plan) && Array.isArray(plan.stages) ? plan.stages : [];
  if (!isObject(lean) || typeof isWritableRole !== 'function') return null;
  const idsOf = (keys) => stages.filter((stage) => Array.isArray(keys) && keys.includes(stage.presetStageKey)).map((stage) => stage.stageId);
  const purposeOverrides = {};
  stages.forEach((stage) => {
    const text = isObject(lean.purposeOverrides) ? lean.purposeOverrides[stage.presetStageKey] : null;
    if (typeof text === 'string') purposeOverrides[stage.stageId] = text;
  });
  return {
    effective: 'lean',
    skipStageIds: idsOf(lean.skip),
    conditionalStageIds: idsOf(lean.conditional),
    gateStageIds: stages.filter((stage) => isWritableRole(stage.roleId)).map((stage) => stage.stageId),
    limits: resolveRouteLimits(projectConfig && projectConfig.routeLimits),
    purposeOverrides,
  };
}

function isSatisfied(status) {
  return SATISFIED.includes(status);
}

// Effective required stage ids: the plan's required stages, minus skipped, minus conditional until promoted.
function requiredStageIds(plan, routing, promotion) {
  const stages = Array.isArray(plan && plan.stages) ? plan.stages : [];
  const required = stages.filter((stage) => stage.required === true).map((stage) => stage.stageId);
  if (!routing || routing.effective !== 'lean') return required;
  const skip = new Set(routing.skipStageIds || []);
  const conditional = new Set(promotion ? [] : (routing.conditionalStageIds || []));
  return required.filter((id) => !skip.has(id) && !conditional.has(id));
}

// Post-implement check. `delta` is the attested writer delta, `lines` the injected per-path line counts
// (or null), `report` the validated worker report. Anything unknown fails closed.
function evaluateImplementDelta({ allowedFiles, delta, lines, report, limits, requireChange = true } = {}) {
  let changed = null;
  if (isObject(delta) && delta.known === true && delta.headChanged !== true && Array.isArray(delta.changedPaths)) {
    if (delta.changedPaths.length === 0) changed = [];
    else if (Array.isArray(lines)) {
      const rows = delta.changedPaths.map((file) => lines.find((row) => isObject(row) && row.path === file));
      if (rows.every((row) => row !== undefined)) changed = rows;
    }
  }
  const reportObj = isObject(report) ? report : {};
  const checks = Array.isArray(reportObj.checks) ? reportObj.checks : [];
  const verdict = evaluateDelta({
    allowedFiles,
    changed,
    checksPassed: !checks.some((check) => isObject(check) && check.result === 'failed'),
    scopeExpansions: Array.isArray(reportObj.scopeExpansion) ? reportObj.scopeExpansion.length : 0,
    needsDecision: reportObj.outcome === 'needs_decision',
    limits,
  });
  // A bugfix implement stage that changed nothing is an anomaly, not a clean run (other writers may change nothing).
  if (requireChange && Array.isArray(changed) && changed.length === 0 && !verdict.reasons.includes('empty_delta')) {
    return { promote: true, reasons: [...verdict.reasons, 'empty_delta'] };
  }
  return verdict;
}

module.exports = { buildLeanRouting, routingOf, isSatisfied, requiredStageIds, evaluateImplementDelta };
