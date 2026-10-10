'use strict';

const path = require('node:path');
const { canonicalRoleId, getRole } = require('./role-names');

const MAX_ASSIGNMENTS = 4;
const MAX_ITEMS = 20;
const MAX_CHARS = 3_000;
const TRUNCATION_SUFFIX = '... [truncated]';
const WORKER_REPORT_CONTRACT = 'worker-report/v1';
const ASSIGNMENT_FIELDS = ['role', 'objective', 'allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions'];
const DECISION_ASSIGNMENT_FIELDS = [...ASSIGNMENT_FIELDS, 'skills', 'wave', 'continueFrom'];
const DECISION_BASE_KEYS = ['action', 'assignments', 'final', 'resolutions', 'humanInput'];
const DECISION_KEYS = [...DECISION_BASE_KEYS, 'goalAchieved', 'acceptanceChecks'];
const ASSIGNMENT_ARRAY_FIELDS = ASSIGNMENT_FIELDS.filter((field) => field !== 'role' && field !== 'objective');
const REPORT_OUTCOMES = ['completed', 'blocked', 'needs_decision', 'failed'];
const CHECK_RESULTS = ['passed', 'failed', 'not_run'];
const HUMAN_REASONS = ['missing_authority', 'irreversible_or_external', 'product_choice'];
const USAGE_LIMIT_NAMES = new Set(['usageLimitExceeded', 'rateLimitExceeded']);
const MAX_CAUSE_DEPTH = 5;

const BOUNDARY_PREDICATES = Object.freeze({
  'decision.parse': Object.freeze(['decision_empty', 'decision_not_json', 'decision_not_object']),
  'decision.envelope': Object.freeze(['decision_envelope_invalid', 'assignment_count_invalid']),
  'decision.resolutions': Object.freeze(['decision_unresolved']),
  'decision.goal': Object.freeze(['goal_unstated']),
  'decision.acceptance_checks': Object.freeze(['acceptance_checks_invalid']),
  'assignment.shape': Object.freeze(['assignment_shape_invalid', 'role_unknown', 'field_invalid']),
  'assignment.writer_scope': Object.freeze(['writer_scope_missing']),
  'assignment.paths': Object.freeze(['path_unsafe', 'path_glob_unsupported']),
  'assignment.skills': Object.freeze(['skill_invalid']),
  'assignment.wave': Object.freeze(['wave_invalid', 'wave_scope_overlap']),
  'assignment.continue_from': Object.freeze(['continue_from_unknown', 'continue_from_role', 'continue_from_duplicate']),
  'dispatch.skill_pins': Object.freeze(['skill_pin_drift']),
  'dispatch.writer_admission': Object.freeze(['fenced', 'admission_blocked']),
  'assignment.role_ladder': Object.freeze(['role_ladder_violation', 'architect_constraint']),
  'settle.lane_scope': Object.freeze(['lane_scope_refused']),
  'dispatch.writer_unresolved': Object.freeze(['writer_unresolved']),
  'dispatch.request_input': Object.freeze(['request_invalid', 'guarantee_unavailable']),
});

/** A lead-managed dispatch predicate FAIL. violations: [{ predicate, result, code, boundary, detail }] */
class BoundaryViolation extends Error {
  constructor(predicate, code, message) {
    super(message);
    this.name = 'BoundaryViolation';
    this.violations = [{ predicate, result: 'FAIL', code, boundary: 'dispatch', detail: String(message).slice(0, 500) }];
  }
}

function violation(predicate, code, message) {
  return new BoundaryViolation(predicate, code, message);
}

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
  required: ['action', 'assignments', 'final', 'resolutions', 'humanInput', 'goalAchieved', 'acceptanceChecks'],
  properties: {
    action: { type: 'string', enum: ['dispatch', 'finish', 'request_human_input'] },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: DECISION_ASSIGNMENT_FIELDS,
        properties: {
          role: { type: 'string' },
          objective: { type: 'string' },
          allowedFiles: stringArray,
          inputs: stringArray,
          evidence: stringArray,
          acceptanceCriteria: stringArray,
          checks: stringArray,
          stopConditions: stringArray,
          skills: { type: 'array', items: { type: 'string' }, maxItems: 5 },
          wave: { type: ['integer', 'null'], minimum: 1 },
          continueFrom: { type: ['string', 'null'] },
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
    goalAchieved: { type: ['boolean', 'null'] },
    acceptanceChecks: {
      anyOf: [
        {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'argv', 'timeoutMs'],
            properties: { id: { type: 'string' }, argv: stringArray, timeoutMs: { type: ['integer', 'null'] } },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

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
function checkOptions(options, recommendation, label, { lenientRecommendation = false } = {}) {
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
  if (lenientRecommendation) return null;
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
  const normalizations = [];
  // Over-long strings are cut to the limit with a marker instead of invalidating the report.
  const fit = (text, field) => {
    if (typeof text !== 'string' || text.length <= MAX_CHARS) return text;
    normalizations.push({ field, action: 'truncated', detail: `${text.length} chars cut to ${MAX_CHARS}` });
    return text.slice(0, MAX_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
  };
  value = { ...value, summary: fit(value.summary, 'summary') };
  if (isPlainObject(value.decisionRequest) && sameKeys(value.decisionRequest, ['question', 'options', 'evidenceChecked', 'recommendation', 'consequenceIfWrong'])) {
    const source = value.decisionRequest;
    value.decisionRequest = {
      ...source,
      question: fit(source.question, 'decisionRequest.question'),
      consequenceIfWrong: fit(source.consequenceIfWrong, 'decisionRequest.consequenceIfWrong'),
    };
  }
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
      push(checkOptions(request.options, request.recommendation, 'decisionRequest', { lenientRecommendation: true }));
      if (!errors.length && !(isNonEmptyString(request.recommendation) && request.options.some((option) => option.id === request.recommendation))) {
        value.decisionRequest = { ...request, recommendation: null };
        normalizations.push({ field: 'decisionRequest.recommendation', action: 'cleared', detail: 'the recommendation was not one of the option ids' });
      }
      push(checkStringArray(request.evidenceChecked, 'decisionRequest.evidenceChecked', { allowEmpty: false }));
    }
  }
  if (errors.length) return fail();
  return { ok: true, report: normalizations.length ? { ...value, normalizations } : value, errors };
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

// LL-5: continueFrom names a finished outcome of this run with the same role, used once per decision.
// ctx.continuable is a Map of assignmentId -> role of the finished outcomes.
function checkContinueFrom(assignment, role, decision, ctx) {
  const id = assignment.continueFrom;
  if (id === null) return;
  if (!isNonEmptyString(id)) throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} needs continueFrom as a non-empty string or null`);
  const originRole = ctx.continuable?.get(id);
  if (originRole === undefined) {
    throw violation('assignment.continue_from', 'continue_from_unknown', `continueFrom ${id} is not the assignmentId of a finished outcome in this run`);
  }
  if (canonicalRoleId(originRole) !== canonicalRoleId(role.name)) {
    throw violation('assignment.continue_from', 'continue_from_role', `continueFrom ${id} belongs to role ${originRole}, not ${role.name}`);
  }
  if (decision.assignments.some((other) => other !== assignment && isPlainObject(other) && other.continueFrom === id)) {
    throw violation('assignment.continue_from', 'continue_from_duplicate', `continueFrom ${id} is used by more than one assignment of this decision`);
  }
}

function checkAssignment(assignment, decision, ctx) {
  if (!isPlainObject(assignment)) throw violation('assignment.shape', 'assignment_shape_invalid', 'Each assignment must be an object');
  const keys = Object.keys(assignment);
  const shapeOk = ASSIGNMENT_FIELDS.every((field) => keys.includes(field)) && keys.every((field) => DECISION_ASSIGNMENT_FIELDS.includes(field));
  if (!shapeOk) {
    throw violation('assignment.shape', 'assignment_shape_invalid', 'Assignment must contain exactly role, objective, allowedFiles, inputs, evidence, acceptanceCriteria, checks, stopConditions, and optionally skills, wave, and continueFrom');
  }
  // Older checkpoints and callers predate assignment skill routing and waves.
  if (!keys.includes('skills')) assignment.skills = [];
  if (!keys.includes('wave')) assignment.wave = null;
  if (!keys.includes('continueFrom')) assignment.continueFrom = null;
  if (assignment.wave !== null && !(Number.isInteger(assignment.wave) && assignment.wave >= 1)) {
    throw violation('assignment.wave', 'wave_invalid', `Assignment wave must be an integer >= 1 or null, got ${JSON.stringify(assignment.wave)}`);
  }
  const role = getRole(ctx.roles, assignment.role);
  if (!role) throw violation('assignment.shape', 'role_unknown', `Unknown role: ${String(assignment.role)}`);
  assignment.role = role.name;
  checkContinueFrom(assignment, role, decision, ctx);
  if (!isNonEmptyString(assignment.objective)) throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} needs an objective`);
  if (assignment.objective.length > MAX_CHARS) throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} exceeds the size limit for objective`);
  for (const field of ASSIGNMENT_ARRAY_FIELDS) {
    if (!Array.isArray(assignment[field]) || assignment[field].some((value) => !isNonEmptyString(value))) {
      throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} needs a string array for ${field}`);
    }
    if (assignment[field].length > MAX_ITEMS || assignment[field].some((value) => value.length > MAX_CHARS)) {
      throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} exceeds the size limit for ${field}`);
    }
  }
  if (!Array.isArray(assignment.skills) || assignment.skills.some((id) => !isNonEmptyString(id))) {
    throw violation('assignment.skills', 'skill_invalid', `Assignment for ${role.name} needs a string array for skills`);
  }
  if (assignment.skills.length > 5) throw violation('assignment.skills', 'skill_invalid', `Assignment for ${role.name} may select at most 5 skills`);
  if (new Set(assignment.skills).size !== assignment.skills.length) throw violation('assignment.skills', 'skill_invalid', `Assignment for ${role.name} skills must be unique`);
  const selectable = ctx.skillCandidateIds ? new Set(ctx.skillCandidateIds) : null;
  const catalog = ctx.skillCatalog;
  for (const id of assignment.skills) {
    if (selectable && !selectable.has(id)) throw violation('assignment.skills', 'skill_invalid', `Skill ${id} was not advertised as a candidate`);
    if (catalog && !catalog.has(id)) throw violation('assignment.skills', 'skill_invalid', `Unknown skill: ${id}`);
  }
  if (assignment.inputs.length === 0) throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} requires bounded inputs`);
  if (assignment.evidence.length === 0) throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} requires prior evidence`);
  if (role.sandbox !== 'read-only' && assignment.allowedFiles.length === 0) {
    throw violation('assignment.writer_scope', 'writer_scope_missing', `Writable role ${role.name} requires explicit allowedFiles`);
  }
  for (const file of assignment.allowedFiles) {
    if (/[*?[]/.test(file)) {
      throw violation('assignment.paths', 'path_glob_unsupported', `Unsupported glob in allowedFiles path for ${role.name}: ${file}`);
    }
    if (!safeRelativePath(file)) throw violation('assignment.paths', 'path_unsafe', `Unsafe allowedFiles path for ${role.name}: ${file}`);
  }
  if (assignment.acceptanceCriteria.length === 0 || assignment.checks.length === 0 || assignment.stopConditions.length === 0) {
    throw violation('assignment.shape', 'field_invalid', `Assignment for ${role.name} requires acceptanceCriteria, checks, and stopConditions`);
  }
  const attemptedRoles = new Set([...ctx.attemptedRoles].map(canonicalRoleId));
  const canonicalRole = canonicalRoleId(role.name);
  if (canonicalRole === 'recovery-engineer' && !attemptedRoles.has('engineer')) {
    throw violation('assignment.role_ladder', 'role_ladder_violation', 'recovery-engineer can only be dispatched after an engineer attempt');
  }
  if (canonicalRole === 'senior-engineer' && !attemptedRoles.has('recovery-engineer')) {
    throw violation('assignment.role_ladder', 'role_ladder_violation', 'senior-engineer can only be dispatched after a recovery-engineer attempt');
  }
  if (canonicalRole === 'architect') {
    if (ctx.outcomeCount === 0) throw violation('assignment.role_ladder', 'architect_constraint', 'orch-architect requires inspected prior evidence');
    if (assignment.objective.length > 240 || decision.assignments.length !== 1) {
      throw violation('assignment.role_ladder', 'architect_constraint', 'orch-architect must receive one narrowly framed decision');
    }
  }
}

const SPECIALIST_REQUIRED_KEYS = ['objective', 'allowedFiles'];
const SPECIALIST_OPTIONAL_KEYS = [
  'role', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions',
  'skills', 'wave', 'skillPins', 'assignmentId', 'workspace', 'reportContract', 'requireAcceptance', 'continuation',
];
const SPECIALIST_ARRAY_KEYS = ['inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions'];

/**
 * Validate a structured direct specialist request (the JSON object the lead sends, or an equivalent
 * direct call) for the endpoint role { id, name?, sandbox }. Returns a normalized copy or throws
 * BoundaryViolation. Does not check skill pins (the executor does).
 */
function checkSpecialistRequest(request, role, { workspace } = {}) {
  const label = String(role?.name || role?.id || 'specialist');
  if (!isPlainObject(request)) throw violation('assignment.shape', 'assignment_shape_invalid', 'Specialist request must be a JSON object');
  if (request.requireAcceptance) {
    throw violation('dispatch.request_input', 'guarantee_unavailable', 'requireAcceptance cannot be guaranteed on a direct specialist request');
  }
  const keys = Object.keys(request);
  for (const key of SPECIALIST_REQUIRED_KEYS) {
    if (!Object.hasOwn(request, key)) throw violation('assignment.shape', 'assignment_shape_invalid', `Specialist request needs ${key}`);
  }
  const unknown = keys.filter((key) => !SPECIALIST_REQUIRED_KEYS.includes(key) && !SPECIALIST_OPTIONAL_KEYS.includes(key));
  if (unknown.length) throw violation('dispatch.request_input', 'request_invalid', `Unknown specialist request key: ${unknown[0]}`);
  if (request.role !== undefined) {
    const wanted = new Set([role?.id, role?.name].filter(Boolean).map(canonicalRoleId));
    if (typeof request.role !== 'string' || !wanted.has(canonicalRoleId(request.role))) {
      throw violation('assignment.shape', 'role_unknown', `Request role ${String(request.role)} does not match this endpoint (${label})`);
    }
  }
  if (!isNonEmptyString(request.objective)) throw violation('assignment.shape', 'field_invalid', `Request for ${label} needs an objective`);
  if (request.objective.length > MAX_CHARS) throw violation('assignment.shape', 'field_invalid', `Request for ${label} exceeds the size limit for objective`);
  const out = { objective: request.objective };
  for (const field of ['allowedFiles', ...SPECIALIST_ARRAY_KEYS]) {
    if (request[field] === undefined && field !== 'allowedFiles') { out[field] = []; continue; }
    const problem = checkStringArray(request[field], field);
    if (problem) throw violation('assignment.shape', 'field_invalid', `Request for ${label}: ${problem}`);
    out[field] = request[field].slice();
  }
  if (request.skills !== undefined) {
    if (!Array.isArray(request.skills)) throw violation('assignment.shape', 'field_invalid', `Request for ${label} needs a string array for skills`);
    out.skills = request.skills.slice();
  }
  if (request.skillPins !== undefined) {
    if (!Array.isArray(request.skillPins)) throw violation('assignment.shape', 'field_invalid', `Request for ${label} needs an array for skillPins`);
    out.skillPins = request.skillPins.slice();
  }
  const readOnly = role?.sandbox === 'read-only';
  if (readOnly) out.allowedFiles = out.allowedFiles.filter((file) => file !== '.' && file !== './');
  else if (out.allowedFiles.length === 0) {
    throw violation('assignment.writer_scope', 'writer_scope_missing', `Writable role ${label} requires explicit allowedFiles`);
  }
  for (const file of out.allowedFiles) {
    if (/[*?[]/.test(file)) {
      throw violation('assignment.paths', 'path_glob_unsupported', `Unsupported glob in allowedFiles path for ${label}: ${file}`);
    }
    if (!safeRelativePath(file)) throw violation('assignment.paths', 'path_unsafe', `Unsafe allowedFiles path for ${label}: ${file}`);
  }
  if (request.workspace !== undefined) {
    if (typeof request.workspace !== 'string' || !workspace || path.resolve(request.workspace) !== path.resolve(workspace)) {
      throw violation('dispatch.request_input', 'request_invalid', 'Request workspace does not match the executor workspace');
    }
  }
  for (const key of ['role', 'assignmentId', 'workspace', 'reportContract']) {
    if (request[key] !== undefined) out[key] = request[key];
  }
  if (request.continuation !== undefined) out.continuation = checkContinuation(request.continuation, label);
  return out;
}

// Continuation of an earlier attempt: { ofAttemptId, threadId, laneId, codexHome } after a usage limit, or
// the same plus reason 'scope' when the lead re-dispatched with expanded scope (LL-5).
function checkContinuation(value, label) {
  const bad = (detail) => violation('assignment.shape', 'field_invalid', `Request for ${label}: continuation ${detail}`);
  if (!isPlainObject(value)) throw bad('must be an object');
  const unknown = Object.keys(value).filter((key) => !['ofAttemptId', 'threadId', 'laneId', 'codexHome', 'reason'].includes(key));
  if (unknown.length) throw bad(`has an unknown key: ${unknown[0]}`);
  if (!isNonEmptyString(value.ofAttemptId)) throw bad('needs a non-empty ofAttemptId');
  if (value.reason !== undefined && value.reason !== 'scope') throw bad('reason must be "scope" when present');
  for (const key of ['threadId', 'laneId', 'codexHome']) {
    const field = value[key];
    if (field !== undefined && field !== null && !isNonEmptyString(field)) throw bad(`${key} must be a non-empty string or null`);
  }
  return {
    ofAttemptId: value.ofAttemptId,
    threadId: value.threadId ?? null,
    laneId: value.laneId ?? null,
    codexHome: value.codexHome ?? null,
    ...(value.reason === 'scope' ? { reason: 'scope' } : {}),
  };
}

function normalizeRel(file, workspace) {
  let value = String(file).replace(/\\/g, '/');
  if (workspace && value.startsWith(`${workspace}/`)) value = value.slice(workspace.length + 1);
  return path.posix.normalize(value).replace(/^\.\//, '');
}

// Paths outside allowedFiles (exact file or directory prefix).
function pathsOutsideAllowed(paths, allowedFiles, workspace) {
  const allowed = allowedFiles.map((file) => normalizeRel(file, workspace).replace(/\/+$/, ''));
  return paths.filter((file) => {
    const rel = normalizeRel(file, workspace);
    return !allowed.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
  });
}

function checkHumanInput(humanInput, openIds) {
  if (!isPlainObject(humanInput)) throw violation('decision.envelope', 'decision_envelope_invalid', 'request_human_input requires a humanInput object');
  const keys = ['reason', 'question', 'options', 'recommendation', 'evidenceChecked', 'independentWork', 'relatedDecisionIds'];
  if (!sameKeys(humanInput, keys)) throw violation('decision.envelope', 'decision_envelope_invalid', `humanInput must contain exactly ${keys.join(', ')}`);
  if (!HUMAN_REASONS.includes(humanInput.reason)) throw violation('decision.envelope', 'decision_envelope_invalid', `humanInput.reason must be one of ${HUMAN_REASONS.join(', ')}`);
  const problem = boundedString(humanInput.question, 'humanInput.question')
    || boundedString(humanInput.independentWork, 'humanInput.independentWork', { allowEmpty: true })
    || checkOptions(humanInput.options, humanInput.recommendation, 'humanInput')
    || checkStringArray(humanInput.evidenceChecked, 'humanInput.evidenceChecked', { allowEmpty: false })
    || checkStringArray(humanInput.relatedDecisionIds, 'humanInput.relatedDecisionIds');
  if (problem) throw violation('decision.envelope', 'decision_envelope_invalid', problem);
  for (const id of humanInput.relatedDecisionIds) {
    if (!openIds.has(id)) throw violation('decision.resolutions', 'decision_unresolved', `humanInput.relatedDecisionIds references a decision that is not open: ${id}`);
  }
}

/**
 * Execution groups of an assignment list: maximal runs of consecutive assignments sharing the same
 * non-null wave; a null wave is a group of one. Returns arrays of assignment indexes in array order.
 */
function executionGroups(assignments) {
  const groups = [];
  let previousWave = null;
  assignments.forEach((assignment, index) => {
    const wave = assignment?.wave ?? null;
    if (wave !== null && wave === previousWave) groups[groups.length - 1].push(index);
    else groups.push([index]);
    previousWave = wave;
  });
  return groups;
}

// Normalized scope path: no leading './', no trailing '/'; '' means the whole workspace root.
function scopePath(file) {
  const trimmed = String(file).trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

function scopesOverlap(a, b) {
  const left = scopePath(a);
  const right = scopePath(b);
  if (left === '' || right === '') return true;
  if (left === right) return true;
  return right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

function checkWaveScopes(assignments, ctx) {
  for (const group of executionGroups(assignments)) {
    const writers = group.filter((index) => getRole(ctx.roles, assignments[index].role)?.sandbox !== 'read-only');
    for (let i = 0; i < writers.length; i += 1) {
      for (let j = i + 1; j < writers.length; j += 1) {
        const first = assignments[writers[i]];
        const second = assignments[writers[j]];
        for (const left of first.allowedFiles) {
          const right = second.allowedFiles.find((file) => scopesOverlap(left, file));
          if (right === undefined) continue;
          throw violation('assignment.wave', 'wave_scope_overlap',
            `Wave ${first.wave}: writers #${writers[i]} (${first.role}) and #${writers[j]} (${second.role}) have overlapping allowedFiles: ${left} vs ${right}`);
        }
      }
    }
  }
}

/**
 * Validate a parsed lead decision. Throws Error on violation.
 * ctx = { roles: Map, attemptedRoles: Set, outcomeCount: number, openDecisionIds: Set, unresolvedWriterCount?: number }
 */
function validateDecision(decision, ctx) {
  if (!isPlainObject(decision)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead decision must be a JSON object');
  const openIds = ctx.openDecisionIds || new Set();
  const keys = Object.keys(decision);
  if (!DECISION_BASE_KEYS.every((key) => keys.includes(key)) || keys.some((key) => !DECISION_KEYS.includes(key))) {
    throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead decision must contain only action, assignments, final, resolutions, and humanInput, plus goalAchieved and acceptanceChecks');
  }
  // Older callers and replays predate goalAchieved and acceptanceChecks: both default to null, and a
  // legacy finish without the key keeps finishing as before.
  const legacyGoal = !keys.includes('goalAchieved');
  if (legacyGoal) decision.goalAchieved = null;
  if (!keys.includes('acceptanceChecks')) decision.acceptanceChecks = null;
  if (decision.goalAchieved !== null && typeof decision.goalAchieved !== 'boolean') throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead goalAchieved must be true, false, or null');
  if (decision.acceptanceChecks !== null && !Array.isArray(decision.acceptanceChecks)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead acceptanceChecks must be an array or null');
  if (!['dispatch', 'finish', 'request_human_input'].includes(decision.action)) throw violation('decision.envelope', 'decision_envelope_invalid', `Unsupported lead action: ${String(decision.action)}`);
  if (!Array.isArray(decision.assignments)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead assignments must be an array');
  if (typeof decision.final !== 'string') throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead final must be a string');
  if (!Array.isArray(decision.resolutions)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead resolutions must be an array');
  if (decision.humanInput !== null && !isPlainObject(decision.humanInput)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead humanInput must be null or an object');

  const resolved = new Set();
  for (const resolution of decision.resolutions) {
    if (!isPlainObject(resolution) || !sameKeys(resolution, ['decisionId', 'choice', 'rationale'])) {
      throw violation('decision.envelope', 'decision_envelope_invalid', 'Each resolution must contain exactly decisionId, choice, and rationale');
    }
    if (!openIds.has(resolution.decisionId)) throw violation('decision.resolutions', 'decision_unresolved', `Resolution references a decision that is not open: ${String(resolution.decisionId)}`);
    if (resolved.has(resolution.decisionId)) throw violation('decision.resolutions', 'decision_unresolved', `Duplicate resolution for decision ${resolution.decisionId}`);
    const problem = boundedString(resolution.choice, 'Resolution choice') || boundedString(resolution.rationale, 'Resolution rationale');
    if (problem) throw violation('decision.envelope', 'decision_envelope_invalid', problem);
    resolved.add(resolution.decisionId);
  }

  if (decision.action === 'finish') {
    if (decision.assignments.length !== 0 || !decision.final.trim()) throw violation('decision.envelope', 'decision_envelope_invalid', 'Finish decisions require no assignments and non-empty final text');
    if (decision.humanInput !== null) throw violation('decision.envelope', 'decision_envelope_invalid', 'Finish decisions must leave humanInput null');
    if (decision.goalAchieved === null && !legacyGoal) throw violation('decision.goal', 'goal_unstated', 'finish requires goalAchieved true or false');
  } else if (decision.action === 'request_human_input') {
    if (decision.assignments.length !== 0) throw violation('decision.envelope', 'decision_envelope_invalid', 'request_human_input decisions require no assignments');
    if (decision.final.trim()) throw violation('decision.envelope', 'decision_envelope_invalid', 'request_human_input decisions must leave final empty');
    checkHumanInput(decision.humanInput, openIds);
  } else {
    if (decision.assignments.length < 1 || decision.assignments.length > MAX_ASSIGNMENTS) {
      throw violation('decision.envelope', 'assignment_count_invalid', `Dispatch must contain between 1 and ${MAX_ASSIGNMENTS} assignments`);
    }
    if (decision.final.trim()) throw violation('decision.envelope', 'decision_envelope_invalid', 'Dispatch decisions must leave final empty');
    if (decision.humanInput !== null) throw violation('decision.envelope', 'decision_envelope_invalid', 'Dispatch decisions must leave humanInput null');
    for (const assignment of decision.assignments) checkAssignment(assignment, decision, ctx);
    checkWaveScopes(decision.assignments, ctx);
    const unresolved = ctx.unresolvedWriterCount || 0;
    if (unresolved > 0 && decision.assignments.some((assignment) => getRole(ctx.roles, assignment.role)?.sandbox !== 'read-only')) {
      throw violation('dispatch.writer_unresolved', 'writer_unresolved', `Writable dispatch refused: ${unresolved} writer outcome(s) are unresolved`);
    }
  }

  const related = new Set(decision.action === 'request_human_input' ? decision.humanInput.relatedDecisionIds : []);
  for (const id of openIds) {
    if (!resolved.has(id) && !related.has(id)) throw violation('decision.resolutions', 'decision_unresolved', `Open decision ${id} must be resolved or listed in humanInput.relatedDecisionIds`);
  }
  // goalAchieved only means something on finish.
  if (decision.action !== 'finish') decision.goalAchieved = null;
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
  BoundaryViolation,
  BOUNDARY_PREDICATES,
  classifyCodexError,
  findCodexErrorInfo,
  safeRelativePath,
  checkSpecialistRequest,
  pathsOutsideAllowed,
  ASSIGNMENT_FIELDS,
  DECISION_ASSIGNMENT_FIELDS,
  MAX_ASSIGNMENTS,
  executionGroups,
};
