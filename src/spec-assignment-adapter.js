'use strict';

const { deriveReviewKind, extractSourceLocation, validateTraceability } = require('./spec-context');
const { checkSpecialistRequest, validateDecision } = require('./contracts');
const { loadRoles } = require('./role-catalog');

const MAX_ITEMS = 20;
const MAX_CHARS = 3000;
const FIXED_STOPS = [
  'Stop if the accepted context or any bound source or artifact has drifted.',
  'Stop if a required write path is missing, denied, or outside the approved scope.',
];
const TAG_ORDER = ['risk_change', 'performance', 'component_complete'];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finding(code, taskId = null, path = '$') {
  return { code, path, taskId };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function scopeContains(parent, child) {
  if (!parent || !child || typeof parent.path !== 'string' || typeof child.path !== 'string') return false;
  if (parent.kind === 'file') return child.kind === 'file' && parent.path === child.path;
  return parent.kind === 'directory'
    && (parent.path === child.path ? child.kind === 'directory' : child.path.startsWith(`${parent.path}/`));
}

function taskRisk(context, task) {
  const tags = new Set();
  for (const requirement of context.requirements || []) {
    if (Array.isArray(task.requirementIds) && task.requirementIds.includes(requirement.id)) {
      for (const tag of requirement.riskTags || []) tags.add(tag);
    }
  }
  for (const rule of context.riskRules || []) {
    if ((Array.isArray(task.writePaths) ? task.writePaths : []).some((scope) => scopeContains(rule.path, scope))) {
      for (const tag of rule.riskTags || []) tags.add(tag);
    }
  }
  for (const checkId of Array.isArray(task.checkIds) ? task.checkIds : []) {
    const check = (context.checks || []).find((item) => item && item.id === checkId);
    for (const scope of check && Array.isArray(check.verifierWritePaths) ? check.verifierWritePaths : []) {
      for (const rule of context.riskRules || []) {
        if (scopeContains(rule.path, scope)) for (const tag of rule.riskTags || []) tags.add(tag);
      }
    }
  }
  for (const tag of Array.isArray(task.additionalRiskTags) ? task.additionalRiskTags : []) tags.add(tag);
  const ordered = [...tags].sort((left, right) => TAG_ORDER.indexOf(left) - TAG_ORDER.indexOf(right) || compareText(left, right));
  return { tags: ordered, kind: deriveReviewKind(tags) };
}

function sourceText(contextResult, location) {
  const source = contextResult.sources && contextResult.sources[location.sourceId];
  if (!source || typeof source.text !== 'string') throw new Error('source_unavailable');
  return { source, text: extractSourceLocation(source.text, location.startLine, location.endLine) };
}

function boundedArrays(assignment) {
  const errors = [];
  if (typeof assignment.objective !== 'string' || assignment.objective.length < 1 || assignment.objective.length > MAX_CHARS) errors.push('objective_size_limit');
  for (const field of ['allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions', 'skills']) {
    const value = assignment[field];
    if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > MAX_CHARS)) {
      errors.push(`${field}_size_limit`);
    }
  }
  const review = assignment.review;
  if (!review || !Array.isArray(review.paths) || review.paths.length > MAX_ITEMS
    || review.paths.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > MAX_CHARS)
    || !Array.isArray(review.evidenceIds) || review.evidenceIds.length > MAX_ITEMS
    || !Array.isArray(review.prerequisiteFor) || review.prerequisiteFor.length > MAX_ITEMS) {
    errors.push('review_size_limit');
  }
  return errors;
}

function assignmentInputs(contextResult, task) {
  const context = contextResult.context;
  const requirements = new Map(context.requirements.map((item) => [item.id, item]));
  const criteria = new Map(context.acceptanceCriteria.map((item) => [item.id, item]));
  const evidence = new Map(context.priorEvidence.map((item) => [item.id, item]));
  const inputs = [];
  const acceptanceCriteria = [];
  const priorEvidence = [];

  for (const id of [...task.requirementIds].sort(compareText)) {
    const item = requirements.get(id);
    if (!item) throw new Error('requirement_reference_unknown');
    const { source, text } = sourceText(contextResult, item.sourceLocation);
    inputs.push(`REQUIREMENT ${id} source=${source.path} lines=${item.sourceLocation.startLine}-${item.sourceLocation.endLine}: ${text}`);
  }
  for (const id of [...task.acceptanceIds].sort(compareText)) {
    const item = criteria.get(id);
    if (!item) throw new Error('acceptance_reference_unknown');
    const { source, text } = sourceText(contextResult, item.sourceLocation);
    acceptanceCriteria.push(`ACCEPTANCE ${id} source=${source.path} lines=${item.sourceLocation.startLine}-${item.sourceLocation.endLine}: ${text}`);
  }
  for (const id of [...task.priorEvidenceIds].sort(compareText)) {
    const item = evidence.get(id);
    if (!item) throw new Error('evidence_reference_unknown');
    const { source, text } = sourceText(contextResult, item.sourceLocation);
    priorEvidence.push(`EVIDENCE ${id} source=${source.path} lines=${item.sourceLocation.startLine}-${item.sourceLocation.endLine} sha256=${source.sha256}: ${item.description} ${text}`);
  }
  return { inputs, acceptanceCriteria, priorEvidence };
}

function checkStrings(context, task, roleKind) {
  const checksById = new Map((context.checks || []).map((check) => [check.id, check]));
  return [...task.checkIds].sort(compareText).map((id) => {
    const check = checksById.get(id);
    if (!check) throw new Error('check_reference_unknown');
    if (roleKind === 'auditor') return `Assess planned CHECK ${id}; verifier execution evidence is pending.`;
    return `CHECK ${id} argv=${JSON.stringify(check.argv)} timeoutMs=${check.timeoutMs}`;
  });
}

function buildAssignment({ task, contextResult, roles, workspaceRoot, mode, review }) {
  const context = contextResult.context;
  const sourceData = assignmentInputs(contextResult, task);
  const selectedChecks = new Set(task.checkIds);
  const checks = [...selectedChecks].sort(compareText).map((id) => {
    const found = context.checks.find((entry) => entry.id === id);
    if (!found) throw new Error('check_reference_unknown');
    return found;
  });
  const verifierPaths = uniqueSorted(checks.flatMap((check) => check.verifierWritePaths.map((entry) => entry.path)));
  const taskPaths = uniqueSorted(task.writePaths.map((entry) => entry.path));
  let role;
  let objective = task.objective;
  let allowedFiles = taskPaths;
  let checkList = checkStrings(context, task, 'engineer');
  if (mode === 'verifier') {
    role = roles.get('verifier')?.name;
    objective = `Verify checkpoint ${task.checkpointId}: ${task.objective}`;
    allowedFiles = verifierPaths;
  } else if (mode === 'auditor') {
    role = roles.get('auditor')?.name;
    objective = `Audit checkpoint ${task.checkpointId}: ${task.objective}`;
    allowedFiles = [];
    checkList = checkStrings(context, task, 'auditor');
  } else {
    role = roles.get('engineer')?.name;
  }
  if (!role) throw new Error(`role_missing_${mode}`);
  const reviewPaths = uniqueSorted([...taskPaths, ...verifierPaths]);
  const assignmentReview = structuredClone(review);
  if (mode === 'verifier' || mode === 'auditor') assignmentReview.paths = reviewPaths;
  const assignment = {
    role,
    objective,
    allowedFiles,
    inputs: sourceData.inputs,
    evidence: sourceData.priorEvidence,
    acceptanceCriteria: sourceData.acceptanceCriteria,
    checks: checkList,
    stopConditions: [...task.stopConditions, ...FIXED_STOPS],
    skills: [],
    wave: null,
    continueFrom: null,
    review: assignmentReview,
    repair: null,
  };
  const violations = boundedArrays(assignment);
  if (violations.length > 0) throw new Error(violations.sort(compareText).join(','));
  return { assignment, roleObject: roles.get(role), workspaceRoot };
}

function validateProposal(assignment, roleObject, workspaceRoot) {
  const decision = {
    action: 'dispatch',
    assignments: [structuredClone(assignment)],
    final: '',
    resolutions: [],
    humanInput: null,
    goalAchieved: null,
    acceptanceChecks: null,
    records: [],
  };
  const validationContext = {
    roles: new Map([[roleObject.name, roleObject]]),
    openDecisionIds: new Set(),
    unresolvedWriterCount: 0,
    incompleteCriticalCheckpointIds: [],
    continuations: [],
    attemptedRoles: new Set(),
    outcomeCount: 0,
    skillCandidateIds: [],
  };
  const errors = [];
  let normalizedAssignment = null;
  try {
    validateDecision(decision, validationContext);
    normalizedAssignment = decision.assignments[0];
  } catch (error) {
    const violation = error && Array.isArray(error.violations) ? error.violations[0] : null;
    errors.push({ boundary: violation?.predicate || 'decision', code: violation?.code || 'decision_validation_failed' });
  }

  const request = {
    role: assignment.role,
    objective: assignment.objective,
    allowedFiles: [...assignment.allowedFiles],
    inputs: [...assignment.inputs],
    evidence: [...assignment.evidence],
    acceptanceCriteria: [...assignment.acceptanceCriteria],
    checks: [...assignment.checks],
    stopConditions: [...assignment.stopConditions],
    skills: [...assignment.skills],
    wave: assignment.wave,
    review: structuredClone(assignment.review),
    repair: assignment.repair,
    workspace: workspaceRoot,
    reportContract: 'worker-report/v1',
  };
  let requestOk = false;
  try {
    checkSpecialistRequest(request, roleObject, { workspace: workspaceRoot });
    requestOk = true;
  } catch (error) {
    const violation = error && Array.isArray(error.violations) ? error.violations[0] : null;
    errors.push({ boundary: violation?.predicate || 'specialist_request', code: violation?.code || 'specialist_request_invalid' });
  }
  return {
    ok: errors.length === 0,
    validateDecision: { ok: normalizedAssignment !== null, errors: normalizedAssignment ? [] : errors.filter((entry) => entry.boundary !== 'dispatch.request_input') },
    checkSpecialistRequest: { ok: requestOk, errors: requestOk ? [] : errors.filter((entry) => entry.boundary === 'dispatch.request_input' || entry.boundary === 'specialist_request') },
    normalization: normalizedAssignment ? { role: normalizedAssignment.role } : null,
    errors,
  };
}

function adaptAssignments({ workspaceRoot, contextResult, expectedContextSha256, map, analysisResult, profilesDir, onSourceFile } = {}) {
  const findings = [];
  const proposals = [];
  const reviewPlan = [];
  let roles;
  try { roles = loadRoles({ ...(profilesDir ? { profilesDir } : {}), onSourceFile }); } catch (_) {
    roles = new Map();
    findings.push(finding('role_profiles_unavailable'));
  }
  if (!contextResult || contextResult.ok !== true || !contextResult.context) findings.push(finding('context_unverified'));
  if (!analysisResult || typeof analysisResult.ok !== 'boolean') findings.push(finding('analysis_result_missing'));
  if (!Array.isArray(map && map.tasks)) findings.push(finding('tasks_invalid'));
  else if (map.tasks.length > 100) findings.push(finding('task_count_limit_exceeded'));
  if (!roles || typeof roles.get !== 'function') findings.push(finding('roles_invalid'));

  let validation = { ok: false, errors: [] };
  if (contextResult && contextResult.ok === true && contextResult.context && Array.isArray(map && map.tasks)) {
    validation = validateTraceability(map, { workspaceRoot, contextResult, expectedContextSha256 });
    for (const error of validation.errors || []) findings.push(finding(error.code || 'map_invalid', null, error.path || '$'));
  }
  if (analysisResult && Array.isArray(analysisResult.findings)) {
    for (const item of analysisResult.findings) {
      if (!item || typeof item !== 'object') {
        findings.push(finding('analysis_finding_invalid'));
        continue;
      }
      findings.push(finding(item.code || 'analysis_invalid', item.taskIds?.[0] || null, item.path || '$'));
    }
  }

  const context = contextResult && contextResult.context;
  const tasksWithinContract = Array.isArray(map && map.tasks) && map.tasks.length <= 100;
  for (const [index, task] of (tasksWithinContract ? map.tasks : []).entries()) {
    const taskId = task && typeof task.id === 'string' ? task.id : null;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      findings.push(finding('task_shape_invalid', null, `$.tasks[${index}]`));
      continue;
    }
    if (!context || !Array.isArray(task.requirementIds) || !Array.isArray(task.writePaths)
      || !Array.isArray(task.checkIds) || !Array.isArray(task.acceptanceIds) || !Array.isArray(task.priorEvidenceIds)
      || !Array.isArray(task.stopConditions)) {
      findings.push(finding('task_shape_invalid', taskId, `$.tasks[${index}]`));
      continue;
    }
    const risk = taskRisk(context, task);
    if (task.declaredReviewKind !== risk.kind) {
      findings.push(finding('review_risk_downgrade', taskId, `$.tasks[${index}].declaredReviewKind`));
    }
    const review = {
      kind: risk.kind,
      checkpointId: task.checkpointId,
      reason: task.reviewReason,
      paths: uniqueSorted([
        ...task.writePaths.map((entry) => entry && entry.path).filter((value) => typeof value === 'string'),
        ...task.checkIds.flatMap((id) => {
          const check = context.checks.find((entry) => entry && entry.id === id);
          return check && Array.isArray(check.verifierWritePaths)
            ? check.verifierWritePaths.map((entry) => entry && entry.path).filter((value) => typeof value === 'string')
            : [];
        }),
      ]),
      evidenceIds: uniqueSorted(task.priorEvidenceIds.filter((value) => typeof value === 'string')),
      prerequisiteFor: [],
    };
    const gated = risk.kind !== 'routine';
    const modes = gated ? ['engineer', 'verifier', 'auditor'] : ['engineer', 'verifier'];
    const taskProposals = [];
    for (const mode of modes) {
      try {
        const built = buildAssignment({ task, contextResult, roles, workspaceRoot, mode, review });
        const result = validateProposal(built.assignment, built.roleObject, workspaceRoot);
        const proposal = { taskId, kind: mode, assignment: built.assignment, validation: result };
        taskProposals.push(proposal);
        proposals.push(proposal);
        if (!result.ok) findings.push(finding('assignment_contract_invalid', taskId, `$.tasks.${taskId}.${mode}`));
      } catch (error) {
        const code = typeof error?.message === 'string' ? error.message.split(',').sort(compareText)[0] : 'assignment_compile_failed';
        const proposal = { taskId, kind: mode, assignment: null, validation: { ok: false, errors: [{ code }] } };
        taskProposals.push(proposal);
        proposals.push(proposal);
        findings.push(finding('assignment_compile_failed', taskId, `$.tasks.${taskId}.${mode}`));
      }
    }
    reviewPlan.push({
      taskId,
      checkpointId: task.checkpointId || null,
      kind: risk.kind,
      riskTags: risk.tags,
      sequence: modes,
      executionGroups: modes.map((mode) => [mode]),
      futureEvidenceDependencies: gated
        ? [{ reviewer: 'auditor', requires: 'verifier_execution_evidence', status: 'not_yet_available' }]
        : [{ reviewer: 'verifier', requires: 'integrated_candidate', status: 'not_yet_available' }],
      proposalKinds: taskProposals.map((proposal) => proposal.kind),
    });
  }

  findings.sort((left, right) => compareText(left.code, right.code)
    || compareText(left.taskId || '', right.taskId || '')
    || compareText(left.path, right.path));
  const uniqueFindings = findings.filter((item, index) => index === 0
    || item.code !== findings[index - 1].code || item.taskId !== findings[index - 1].taskId || item.path !== findings[index - 1].path);
  const taskCountValid = Array.isArray(map && map.tasks) && proposals.length > 0
    && proposals.length === map.tasks.reduce((count, task) => count + (task && typeof task === 'object' ? (taskRisk(context || {}, task).kind === 'routine' ? 2 : 3) : 0), 0);
  const ok = validation.ok && Boolean(analysisResult && analysisResult.ok) && taskCountValid
    && uniqueFindings.length === 0 && proposals.every((proposal) => proposal.validation.ok);
  return {
    ok,
    proposals,
    validation: { mapOk: validation.ok, structuralAnalysisOk: Boolean(analysisResult && analysisResult.ok) },
    reviewPlan,
    assumptions: {
      mode: 'offline',
      rolesLoadedFromProfiles: true,
      openDecisions: 0,
      unresolvedWriters: 0,
      incompleteCriticalCheckpoints: 0,
      attemptedRoles: [],
      selectedSkills: [],
      liveRunStateValidationRequiredBeforeDispatch: true,
    },
    implementationAcceptance: 'not_evaluated',
    findings: uniqueFindings,
  };
}

module.exports = { adaptAssignments };
