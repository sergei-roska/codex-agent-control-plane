'use strict';

// Scripted lead decisions for a clean lean run (ADR adaptive-delivery-route, D8). Pure functions: the
// graph validates what they build exactly like a model decision and falls back to the LLM on any problem.

const { routingOf, requiredStageIds } = require('./route-runtime');

const GOAL_CHARS = 3000;
const EVIDENCE_CHARS = 1500;
const SUMMARY_CHARS = 600;
const NO_EVIDENCE = 'No prior stage evidence: this is the first dispatched stage; work from the inputs.';
const DEFAULT_CHECK = 'Run the focused check that exercises the change and report the exact result';

const cut = (text, max) => (String(text).length > max ? String(text).slice(0, max) : String(text));
const statusOf = (state, stageId) => state.stageStatuses?.[stageId]?.status || 'pending';

// True only while the run is clean: nothing the LLM lead would need to look at.
function canScript(state, { notes = [], roundLimit = Infinity } = {}) {
  if (!state || !state.plan || routingOf(state.plan).effective !== 'lean') return false;
  if (state.routePromotion) return false;
  if ((state.openDecisions || []).length > 0 || state.humanRequest || (state.humanAnswers || []).length > 0) return false;
  if ((state.unresolvedWriters || []).length > 0) return false;
  if (Object.values(state.stageStatuses || {}).some((entry) => entry && entry.status === 'failed')) return false;
  if (state.acceptance?.disposition === 'rejected' || state.acceptanceAttempts > 0) return false;
  if (notes.length > 0 || state.round >= roundLimit) return false;
  if (state.planViolations > 0 || state.decisionViolations > 0 || state.planRetry) return false;
  if (state.status || state.budget) return false;
  return true;
}

function evidenceOf(state, stage) {
  const rows = [];
  for (const dep of stage.dependencies || []) {
    if (statusOf(state, dep) !== 'succeeded') continue;
    const attemptIds = new Set(state.stageStatuses?.[dep]?.attemptIds || []);
    for (const outcome of state.outcomes || []) {
      if (outcome.kind === 'reconciliation' || !attemptIds.has(outcome.attemptId) || !outcome.report) continue;
      const report = outcome.report;
      const checks = (report.checks || []).map((check) => `${check.command}: ${check.result}`);
      rows.push(cut(`${dep} (${outcome.role}): ${report.outcome} - ${report.summary}; filesChanged: ${(report.filesChanged || []).join(', ') || 'none'}; checks: ${checks.join(' | ') || 'none'}`, EVIDENCE_CHARS));
    }
  }
  return rows;
}

function buildLeanAssignment(state, stage) {
  const routing = routingOf(state.plan);
  const objective = routing.purposeOverrides[stage.stageId] || stage.objective;
  const required = state.contract?.requiredChecks || [];
  const evidence = evidenceOf(state, stage);
  return {
    role: stage.roleId,
    objective,
    allowedFiles: [...(stage.allowedFiles || [])],
    inputs: [cut(state.goal, GOAL_CHARS), `Plan stage objective: ${stage.objective}`],
    evidence: evidence.length > 0 ? evidence : [NO_EVIDENCE],
    acceptanceCriteria: [objective, 'No file outside allowedFiles is changed', 'Report exact executed check results; never claim an unrun check passed'],
    checks: required.length > 0 ? required.map((check) => `${check.id}: ${check.argv.join(' ')}`) : [DEFAULT_CHECK],
    stopConditions: [
      'Stop and report scopeExpansion if another file is needed',
      'Stop with outcome needs_decision if the requirement is ambiguous or the defect cannot be located',
    ],
    stageId: stage.stageId,
  };
}

function buildLeanFinish(state) {
  const lines = ['Route: lean.'];
  const done = state.plan.stages.filter((stage) => statusOf(state, stage.stageId) === 'succeeded');
  lines.push(`Succeeded stages: ${done.map((stage) => stage.stageId).join(', ') || 'none'}.`);
  for (const stage of done) {
    const attemptIds = new Set(state.stageStatuses?.[stage.stageId]?.attemptIds || []);
    const outcome = [...(state.outcomes || [])].reverse().find((entry) => entry.kind !== 'reconciliation' && attemptIds.has(entry.attemptId) && entry.report);
    if (outcome) lines.push(`- ${stage.stageId}: ${cut(outcome.report.summary, SUMMARY_CHARS)}`);
  }
  return {
    action: 'finish', assignments: [], final: lines.join('\n'), resolutions: [], humanInput: null,
  };
}

// A scripted decision, or null when the run is not clean or the state is inconsistent.
function buildLeanDecision(state, { eligible, notes, roundLimit } = {}) {
  if (!canScript(state, { notes, roundLimit })) return null;
  const routing = routingOf(state.plan);
  const required = new Set(requiredStageIds(state.plan, routing, state.routePromotion));
  const next = (eligible || []).filter((stage) => required.has(stage.stageId));
  if (next.length > 0) {
    return {
      action: 'dispatch', assignments: [buildLeanAssignment(state, next[0])], final: '', resolutions: [], humanInput: null,
    };
  }
  const allDone = [...required].every((id) => statusOf(state, id) === 'succeeded');
  return allDone ? buildLeanFinish(state) : null;
}

module.exports = {
  canScript, buildLeanAssignment, buildLeanFinish, buildLeanDecision,
};
