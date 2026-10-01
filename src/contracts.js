'use strict';

const path = require('node:path');

const MAX_ASSIGNMENTS = 4;
const LEGACY_REPAIR_CHAINS = Object.freeze({ 'orch-builder': ['orch-repair-xhigh', 'orch-repair-sol'] });
const MAX_ITEMS = 20;
const MAX_CHARS = 3_000;
const WORKER_REPORT_CONTRACT = 'worker-report/v1';
const ASSIGNMENT_FIELDS = ['role', 'objective', 'allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions'];
const ASSIGNMENT_ARRAY_FIELDS = ASSIGNMENT_FIELDS.filter((field) => field !== 'role' && field !== 'objective');
const REPORT_OUTCOMES = ['completed', 'blocked', 'needs_decision', 'failed'];
const CHECK_RESULTS = ['passed', 'failed', 'not_run'];
const HUMAN_REASONS = ['missing_authority', 'irreversible_or_external', 'product_choice'];
const USAGE_LIMIT_NAMES = new Set(['usageLimitExceeded', 'rateLimitExceeded']);
const MAX_CAUSE_DEPTH = 5;

const stringArray = { type: 'array', items: { type: 'string' } };
const optionList = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'description'],
    properties: { id: { type: 'string' }, description: { type: 'string' } },
  },
};

const WORKER_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'filesChanged', 'filesInspected', 'checks', 'risks', 'scopeExpansion', 'decisionRequest'],
  properties: {
    outcome: { type: 'string', enum: REPORT_OUTCOMES },
    summary: { type: 'string' },
    filesChanged: stringArray,
    filesInspected: stringArray,
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'result', 'detail'],
        properties: {
          command: { type: 'string' },
          result: { type: 'string', enum: CHECK_RESULTS },
          detail: { type: 'string' },
        },
      },
    },
    risks: stringArray,
    scopeExpansion: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'reason'],
        properties: { path: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    decisionRequest: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'options', 'evidenceChecked', 'recommendation', 'consequenceIfWrong'],
          properties: {
            question: { type: 'string' },
            options: optionList,
            evidenceChecked: stringArray,
            recommendation: { type: 'string' },
            consequenceIfWrong: { type: 'string' },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'assignments', 'final', 'resolutions', 'humanInput'],
  properties: {
    action: { type: 'string', enum: ['dispatch', 'finish', 'request_human_input'] },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...ASSIGNMENT_FIELDS, 'stageId'],
        properties: {
          stageId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          role: { type: 'string' },
          objective: { type: 'string' },
          allowedFiles: stringArray,
          inputs: stringArray,
          evidence: stringArray,
          acceptanceCriteria: stringArray,
          checks: stringArray,
          stopConditions: stringArray,
        },
      },
    },
    final: { type: 'string' },
    resolutions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decisionId', 'choice', 'rationale'],
        properties: { decisionId: { type: 'string' }, choice: { type: 'string' }, rationale: { type: 'string' } },
      },
    },
    humanInput: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'question', 'options', 'recommendation', 'evidenceChecked', 'independentWork', 'relatedDecisionIds'],
          properties: {
            reason: { type: 'string', enum: HUMAN_REASONS },
            question: { type: 'string' },
            options: optionList,
            recommendation: { type: 'string' },
            evidenceChecked: stringArray,
            independentWork: { type: 'string' },
            relatedDecisionIds: stringArray,
          },
        },
        { type: 'null' },
      ],
    },
  },
};

const SETTINGS_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SETTINGS_TOKEN = /^[a-z0-9_-]{1,32}$/;

/**
 * Normalizes per-turn effective settings { model, effort, serviceTier } (profile format patterns).
 * Returns null when the value is absent or malformed; serviceTier null means the standard tier.
 */
function normalizeEffectiveSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { model, effort, serviceTier } = value;
  if (typeof model !== 'string' || !SETTINGS_MODEL.test(model)) return null;
  if (typeof effort !== 'string' || !SETTINGS_TOKEN.test(effort)) return null;
  if (serviceTier !== undefined && serviceTier !== null && (typeof serviceTier !== 'string' || !SETTINGS_TOKEN.test(serviceTier))) return null;
  return { model, effort, serviceTier: serviceTier || null };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, keys) {
  return Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}

function safeRelativePath(file) {
  if (!isNonEmptyString(file) || file.includes('\\') || file.includes('\0')) return false;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return false;
  const segments = file.split('/');
  return segments.every((segment) => segment !== '..' && segment !== '.' && segment !== '') && segments[0] !== '.';
}

// Bounded array of non-empty strings; returns an error text or null.
function checkStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) return `${label} must be an array of non-empty strings`;
  if (value.length > MAX_ITEMS || value.some((item) => item.length > MAX_CHARS)) return `${label} exceeds the size limit`;
  if (!allowEmpty && value.length === 0) return `${label} must not be empty`;
  return null;
}

// Options list plus recommendation; returns an error text or null.
function checkOptions(options, recommendation, label) {
  if (!Array.isArray(options) || options.length < 2) return `${label} needs at least 2 options`;
  if (options.length > MAX_ITEMS) return `${label} options exceed the size limit`;
  const ids = new Set();
  for (const option of options) {
    if (!isPlainObject(option) || !sameKeys(option, ['id', 'description'])) return `${label} options must contain exactly id and description`;
    if (!isNonEmptyString(option.id) || option.id.length > MAX_CHARS) return `${label} option ids must be non-empty strings`;
    if (!isNonEmptyString(option.description) || option.description.length > MAX_CHARS) return `${label} option descriptions must be non-empty strings`;
    if (ids.has(option.id)) return `${label} option ids must be unique`;
    ids.add(option.id);
  }
  if (!isNonEmptyString(recommendation) || !ids.has(recommendation)) return `${label} recommendation must be one of the option ids`;
  return null;
}

function boundedString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return `${label} must be a string`;
  if (!allowEmpty && !value.trim()) return `${label} must not be empty`;
  if (value.length > MAX_CHARS) return `${label} exceeds the size limit`;
  return null;
}

/** Validate a parsed worker report. Returns { ok, report, errors[] }; never throws. */
function validateWorkerReport(value) {
  const errors = [];
  const fail = () => ({ ok: false, report: null, errors });
  if (!isPlainObject(value)) {
    errors.push('report must be a JSON object');
    return fail();
  }
  if (!sameKeys(value, WORKER_REPORT_SCHEMA.required)) {
    errors.push(`report must contain exactly ${WORKER_REPORT_SCHEMA.required.join(', ')}`);
    return fail();
  }
  const push = (error) => { if (error) errors.push(error); };
  if (!REPORT_OUTCOMES.includes(value.outcome)) errors.push(`outcome must be one of ${REPORT_OUTCOMES.join(', ')}`);
  push(boundedString(value.summary, 'summary', { allowEmpty: true }));
  for (const field of ['filesChanged', 'filesInspected', 'risks']) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string')) errors.push(`${field} must be an array of strings`);
  }
  if (!Array.isArray(value.checks)) {
    errors.push('checks must be an array');
  } else {
    for (const check of value.checks) {
      if (!isPlainObject(check) || !sameKeys(check, ['command', 'result', 'detail'])
        || typeof check.command !== 'string' || typeof check.detail !== 'string' || !CHECK_RESULTS.includes(check.result)) {
        errors.push('each check must contain command, detail, and a result of passed, failed, or not_run');
        break;
      }
    }
  }
  if (!Array.isArray(value.scopeExpansion)) {
    errors.push('scopeExpansion must be an array');
  } else {
    for (const entry of value.scopeExpansion) {
      if (!isPlainObject(entry) || !sameKeys(entry, ['path', 'reason']) || typeof entry.path !== 'string' || typeof entry.reason !== 'string') {
        errors.push('each scopeExpansion entry must contain string path and reason');
        break;
      }
    }
  }
  const request = value.decisionRequest;
  if (request !== null && !isPlainObject(request)) {
    errors.push('decisionRequest must be null or an object');
  } else if ((value.outcome === 'needs_decision') !== (request !== null)) {
    errors.push('outcome needs_decision requires a decisionRequest, and a decisionRequest requires outcome needs_decision');
  } else if (request !== null) {
    if (!sameKeys(request, ['question', 'options', 'evidenceChecked', 'recommendation', 'consequenceIfWrong'])) {
      errors.push('decisionRequest must contain exactly question, options, evidenceChecked, recommendation, and consequenceIfWrong');
    } else {
      push(boundedString(request.question, 'decisionRequest.question'));
      push(boundedString(request.consequenceIfWrong, 'decisionRequest.consequenceIfWrong', { allowEmpty: true }));
      push(checkOptions(request.options, request.recommendation, 'decisionRequest'));
      push(checkStringArray(request.evidenceChecked, 'decisionRequest.evidenceChecked', { allowEmpty: false }));
    }
  }
  return errors.length ? fail() : { ok: true, report: value, errors };
}

/** Parse and validate worker report text. Never throws: { report | null, error | null }. */
function parseWorkerReport(text) {
  if (typeof text !== 'string' || !text.trim()) return { report: null, error: 'Worker report was empty' };
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { report: null, error: `Worker report was not valid JSON: ${error.message}` };
  }
  const result = validateWorkerReport(value);
  if (!result.ok) return { report: null, error: `Worker report was invalid: ${result.errors.join('; ')}` };
  return { report: result.report, error: null };
}

function checkAssignment(assignment, decision, ctx) {
  if (!isPlainObject(assignment)) throw new Error('Each assignment must be an object');
  // stageId is optional here (legacy callers omit it); the plan check in the graph requires it.
  const { stageId, ...fields } = assignment;
  if (!sameKeys(fields, ASSIGNMENT_FIELDS)) {
    throw new Error('Assignment must contain exactly role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, and stageId');
  }
  if (stageId !== undefined && stageId !== null && !isNonEmptyString(stageId)) throw new Error('Assignment stageId must be a string or null');
  const role = ctx.roles.get(assignment.role);
  if (!role) throw new Error(`Unknown role: ${String(assignment.role)}`);
  if (!isNonEmptyString(assignment.objective)) throw new Error(`Assignment for ${role.name} needs an objective`);
  for (const field of ASSIGNMENT_ARRAY_FIELDS) {
    if (!Array.isArray(assignment[field]) || assignment[field].some((value) => !isNonEmptyString(value))) {
      throw new Error(`Assignment for ${role.name} needs a string array for ${field}`);
    }
    if (assignment[field].length > MAX_ITEMS || assignment[field].some((value) => value.length > MAX_CHARS)) {
      throw new Error(`Assignment for ${role.name} exceeds the size limit for ${field}`);
    }
  }
  if (assignment.inputs.length === 0) throw new Error(`Assignment for ${role.name} requires bounded inputs`);
  if (assignment.evidence.length === 0) throw new Error(`Assignment for ${role.name} requires prior evidence`);
  if (role.sandbox !== 'read-only' && assignment.allowedFiles.length === 0) {
    throw new Error(`Writable role ${role.name} requires explicit allowedFiles`);
  }
  for (const file of assignment.allowedFiles) {
    if (!safeRelativePath(file)) throw new Error(`Unsafe allowedFiles path for ${role.name}: ${file}`);
  }
  if (assignment.acceptanceCriteria.length === 0 || assignment.checks.length === 0 || assignment.stopConditions.length === 0) {
    throw new Error(`Assignment for ${role.name} requires acceptanceCriteria, checks, and stopConditions`);
  }
  for (const [base, chain] of Object.entries({ ...LEGACY_REPAIR_CHAINS, ...(ctx.repairChains || {}) })) {
    const at = chain.indexOf(role.name);
    if (at < 0) continue;
    const previous = at === 0 ? base : chain[at - 1];
    if (!ctx.attemptedRoles.has(previous)) throw new Error(`${role.name} can only be dispatched after an ${previous} attempt`);
  }
  if (role.name === 'orch-architect') {
    if (ctx.outcomeCount === 0) throw new Error('orch-architect requires inspected prior evidence');
    if (assignment.objective.length > 240 || decision.assignments.length !== 1) {
      throw new Error('orch-architect must receive one narrowly framed decision');
    }
  }
}

function checkHumanInput(humanInput, openIds) {
  if (!isPlainObject(humanInput)) throw new Error('request_human_input requires a humanInput object');
  const keys = ['reason', 'question', 'options', 'recommendation', 'evidenceChecked', 'independentWork', 'relatedDecisionIds'];
  if (!sameKeys(humanInput, keys)) throw new Error(`humanInput must contain exactly ${keys.join(', ')}`);
  if (!HUMAN_REASONS.includes(humanInput.reason)) throw new Error(`humanInput.reason must be one of ${HUMAN_REASONS.join(', ')}`);
  const problem = boundedString(humanInput.question, 'humanInput.question')
    || boundedString(humanInput.independentWork, 'humanInput.independentWork', { allowEmpty: true })
    || checkOptions(humanInput.options, humanInput.recommendation, 'humanInput')
    || checkStringArray(humanInput.evidenceChecked, 'humanInput.evidenceChecked', { allowEmpty: false })
    || checkStringArray(humanInput.relatedDecisionIds, 'humanInput.relatedDecisionIds');
  if (problem) throw new Error(problem);
  for (const id of humanInput.relatedDecisionIds) {
    if (!openIds.has(id)) throw new Error(`humanInput.relatedDecisionIds references a decision that is not open: ${id}`);
  }
}

/**
 * Validate a parsed lead decision. Throws Error on violation.
 * ctx = { roles: Map, attemptedRoles: Set, outcomeCount: number, openDecisionIds: Set, unresolvedWriterCount?: number,
 *   repairChains?: { [baseRoleId]: [repairRoleId, ...] } } (the legacy orch-builder chain is always included)
 */
function validateDecision(decision, ctx) {
  if (!isPlainObject(decision)) throw new Error('Lead decision must be a JSON object');
  const openIds = ctx.openDecisionIds || new Set();
  const keys = ['action', 'assignments', 'final', 'resolutions', 'humanInput'];
  if (!sameKeys(decision, keys)) throw new Error('Lead decision must contain only action, assignments, final, resolutions, and humanInput');
  if (!['dispatch', 'finish', 'request_human_input'].includes(decision.action)) throw new Error(`Unsupported lead action: ${String(decision.action)}`);
  if (!Array.isArray(decision.assignments)) throw new Error('Lead assignments must be an array');
  if (typeof decision.final !== 'string') throw new Error('Lead final must be a string');
  if (!Array.isArray(decision.resolutions)) throw new Error('Lead resolutions must be an array');
  if (decision.humanInput !== null && !isPlainObject(decision.humanInput)) throw new Error('Lead humanInput must be null or an object');

  const resolved = new Set();
  for (const resolution of decision.resolutions) {
    if (!isPlainObject(resolution) || !sameKeys(resolution, ['decisionId', 'choice', 'rationale'])) {
      throw new Error('Each resolution must contain exactly decisionId, choice, and rationale');
    }
    if (!openIds.has(resolution.decisionId)) throw new Error(`Resolution references a decision that is not open: ${String(resolution.decisionId)}`);
    if (resolved.has(resolution.decisionId)) throw new Error(`Duplicate resolution for decision ${resolution.decisionId}`);
    const problem = boundedString(resolution.choice, 'Resolution choice') || boundedString(resolution.rationale, 'Resolution rationale');
    if (problem) throw new Error(problem);
    resolved.add(resolution.decisionId);
  }

  if (decision.action === 'finish') {
    if (decision.assignments.length !== 0 || !decision.final.trim()) throw new Error('Finish decisions require no assignments and non-empty final text');
    if (decision.humanInput !== null) throw new Error('Finish decisions must leave humanInput null');
  } else if (decision.action === 'request_human_input') {
    if (decision.assignments.length !== 0) throw new Error('request_human_input decisions require no assignments');
    if (decision.final.trim()) throw new Error('request_human_input decisions must leave final empty');
    checkHumanInput(decision.humanInput, openIds);
  } else {
    if (decision.assignments.length < 1 || decision.assignments.length > MAX_ASSIGNMENTS) {
      throw new Error(`Dispatch must contain between 1 and ${MAX_ASSIGNMENTS} assignments`);
    }
    if (decision.final.trim()) throw new Error('Dispatch decisions must leave final empty');
    if (decision.humanInput !== null) throw new Error('Dispatch decisions must leave humanInput null');
    for (const assignment of decision.assignments) checkAssignment(assignment, decision, ctx);
    const unresolved = ctx.unresolvedWriterCount || 0;
    if (unresolved > 0 && decision.assignments.some((assignment) => ctx.roles.get(assignment.role)?.sandbox !== 'read-only')) {
      throw new Error(`Writable dispatch refused: ${unresolved} writer outcome(s) are unresolved`);
    }
  }

  const related = new Set(decision.action === 'request_human_input' ? decision.humanInput.relatedDecisionIds : []);
  for (const id of openIds) {
    if (!resolved.has(id) && !related.has(id)) throw new Error(`Open decision ${id} must be resolved or listed in humanInput.relatedDecisionIds`);
  }
}

/** Locate a codexErrorInfo value on an error, its rpcData, or along its cause chain. */
function findCodexErrorInfo(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return null;
    seen.add(current);
    const info = current.codexError?.codexErrorInfo ?? current.rpcData?.codexErrorInfo;
    if (info !== undefined && info !== null) return info;
    current = current.cause;
  }
  return null;
}

function isUsageLimitInfo(info) {
  if (typeof info === 'string') return USAGE_LIMIT_NAMES.has(info);
  if (!info || typeof info !== 'object') return false;
  return Object.values(info).some((variant) => variant && typeof variant === 'object' && variant.httpStatusCode === 429);
}

/** Classify a Codex failure for budget handling: 'usage_limit' or 'other'. */
function classifyCodexError(error) {
  return isUsageLimitInfo(findCodexErrorInfo(error)) ? 'usage_limit' : 'other';
}

module.exports = {
  WORKER_REPORT_SCHEMA,
  WORKER_REPORT_CONTRACT,
  validateWorkerReport,
  parseWorkerReport,
  DECISION_SCHEMA,
  validateDecision,
  classifyCodexError,
  findCodexErrorInfo,
  safeRelativePath,
  normalizeEffectiveSettings,
  LEGACY_REPAIR_CHAINS,
  ASSIGNMENT_FIELDS,
  MAX_ASSIGNMENTS,
};
