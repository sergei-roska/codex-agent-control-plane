'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalRoleId, getRole } = require('./role-names');
const { isSafeIdentity } = require('./staging-log');

const MAX_ASSIGNMENTS = 4;
const MAX_ITEMS = 20;
const MAX_CHARS = 3_000;
const TRUNCATION_SUFFIX = '... [truncated]';
const WORKER_REPORT_CONTRACT = 'worker-report/v1';
const ASSIGNMENT_FIELDS = ['role', 'objective', 'allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions'];
const DECISION_ASSIGNMENT_FIELDS = [...ASSIGNMENT_FIELDS, 'skills', 'wave', 'continueFrom', 'review', 'repair'];
const DECISION_BASE_KEYS = ['action', 'assignments', 'final', 'resolutions', 'humanInput'];
const DECISION_KEYS = [...DECISION_BASE_KEYS, 'goalAchieved', 'acceptanceChecks', 'records', 'systemInput'];
const ASSIGNMENT_ARRAY_FIELDS = ASSIGNMENT_FIELDS.filter((field) => field !== 'role' && field !== 'objective');
const REPORT_OUTCOMES = ['completed', 'blocked', 'needs_decision', 'failed'];
const CHECK_RESULTS = ['passed', 'failed', 'not_run'];
// LL-6: the closed list of decisions only the owner may take (humanInput.reason). Interpreting the PRD,
// fixing evidence tooling, choosing an implementation, and expanding file scope are the lead's decisions.
const HUMAN_REASONS = ['paid_resources', 'credentials_or_access', 'external_write', 'irreversible_operation', 'prd_requirement_change', 'infeasible_requirement'];
const REVIEW_KINDS = ['routine', 'risk_change', 'performance', 'component_complete', 'investigation', 'owner_request', 'pinned_check'];
const REVIEW_GATED_KINDS = ['risk_change', 'performance', 'component_complete', 'owner_request', 'pinned_check'];
const RECORD_KINDS = ['problem', 'remedy', 'architecture', 'verification', 'decision'];
const RECORD_STATUSES = ['proposed', 'accepted', 'implemented', 'tested', 'open', 'resolved', 'rejected', 'failed', 'reopened', 'deferred', 'unknown'];
const USAGE_LIMIT_NAMES = new Set(['usageLimitExceeded', 'rateLimitExceeded']);
const MAX_CAUSE_DEPTH = 5;

const BOUNDARY_PREDICATES = Object.freeze({
  'decision.parse': Object.freeze(['decision_empty', 'decision_not_json', 'decision_not_object']),
  'decision.envelope': Object.freeze(['decision_envelope_invalid', 'assignment_count_invalid']),
  'decision.resolutions': Object.freeze(['decision_unresolved']),
  'decision.goal': Object.freeze(['goal_unstated']),
  'decision.investigate_first': Object.freeze(['investigation_missing']),
  'decision.acceptance_checks': Object.freeze(['acceptance_checks_invalid']),
  'decision.records': Object.freeze(['records_invalid']),
  'decision.review_gate': Object.freeze(['review_receipt_missing', 'review_checkpoint_pending', 'review_context_mismatch', 'verifier_receipt_missing']),
  'review.continuation': Object.freeze(['review_origin_unknown', 'review_origin_stale']),
  'review.concurrent_writer': Object.freeze(['review_writer_unsettled']),
  'review.reservation': Object.freeze(['review_reservation_unavailable']),
  'review.target': Object.freeze(['review_target_unknown']),
  'assignment.shape': Object.freeze(['assignment_shape_invalid', 'role_unknown', 'field_invalid']),
  'assignment.writer_scope': Object.freeze(['writer_scope_missing']),
  'assignment.paths': Object.freeze(['path_unsafe', 'path_glob_unsupported']),
  'assignment.skills': Object.freeze(['skill_invalid']),
  'assignment.wave': Object.freeze(['wave_invalid', 'wave_scope_overlap']),
  'assignment.continue_from': Object.freeze(['continue_from_unknown', 'continue_from_role', 'continue_from_duplicate']),
  'assignment.review': Object.freeze(['review_context_invalid', 'review_context_missing', 'review_wave_conflict']),
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
    summary: {
      type: 'string',
      description: 'For an acceptance audit, the complete first line is exactly VERDICT: pass, VERDICT: fail, or VERDICT: inconclusive. Pinned-check integrity uses its separate preserve/weaken verdict contract.',
    },
    filesChanged: stringArray,
    filesInspected: stringArray,
    checks: {
      description: 'Required checks actually performed for this assignment, or explicit validation steps for cited prior evidence. Never list optional diagnostics or claim reused tests were freshly executed. Failed or unrun assigned checks must retain their result.',
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
    risks: {
      description: 'Include supplemental diagnostic commands, forbidden or unrun excluded tests, and reused verifier evidence here with exact command/result or artifact and the limitation. These entries do not satisfy assigned checks.',
      ...stringArray,
    },
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
  required: ['action', 'assignments', 'final', 'resolutions', 'humanInput', 'goalAchieved', 'acceptanceChecks', 'records', 'systemInput'],
  properties: {
    action: { type: 'string', enum: ['dispatch', 'finish', 'request_human_input', 'request_system_repair'] },
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
          review: {
            anyOf: [
              {
                type: 'object', additionalProperties: false,
                required: ['kind', 'checkpointId', 'reason', 'paths', 'evidenceIds', 'prerequisiteFor'],
                properties: {
                  kind: { type: 'string', enum: REVIEW_KINDS },
                  checkpointId: { type: 'string', minLength: 1, maxLength: 160 },
                  reason: { type: 'string', minLength: 1, maxLength: MAX_CHARS },
                  paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_ITEMS },
                  evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_ITEMS },
                  prerequisiteFor: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 160 }, maxItems: MAX_ITEMS },
                },
              },
              { type: 'null' },
            ],
          },
          repair: {
            anyOf: [
              {
                type: 'object', additionalProperties: false, required: ['checkpointIds'],
                properties: { checkpointIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 160 }, minItems: 1, maxItems: MAX_ITEMS } },
              },
              { type: 'null' },
            ],
          },
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
    systemInput: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['incidentId', 'question', 'evidence', 'relatedDecisionIds'],
          properties: {
            incidentId: { type: 'string', minLength: 1, maxLength: 160 },
            question: { type: 'string', minLength: 1, maxLength: MAX_CHARS },
            evidence: { type: 'array', items: { type: 'string', minLength: 1, maxLength: MAX_CHARS }, minItems: 1, maxItems: MAX_ITEMS },
            relatedDecisionIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 160 }, maxItems: MAX_ITEMS },
          },
        },
        { type: 'null' },
      ],
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
    records: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'kind', 'status', 'summary', 'evidenceIds', 'relatedIds', 'adrPath'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 160 },
          kind: { type: 'string', enum: RECORD_KINDS },
          status: { type: 'string', enum: RECORD_STATUSES },
          summary: { type: 'string', minLength: 1, maxLength: MAX_CHARS },
          evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_ITEMS },
          relatedIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_ITEMS },
          adrPath: { type: ['string', 'null'], maxLength: 240 },
        },
      },
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

function checkReviewContext(value, label, { required = false, auditor = false, writable = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw violation('assignment.review', 'review_context_missing', `${label} requires review metadata`);
    return null;
  }
  const fields = ['kind', 'checkpointId', 'reason', 'paths', 'evidenceIds'];
  const allowedFields = [...fields, 'prerequisiteFor'];
  if (!isPlainObject(value) || Object.keys(value).some((field) => !allowedFields.includes(field))
    || fields.some((field) => !Object.hasOwn(value, field))) {
    throw violation('assignment.review', 'review_context_invalid', `${label}.review must contain exactly ${fields.join(', ')} and may include prerequisiteFor`);
  }
  if (!REVIEW_KINDS.includes(value.kind)) {
    throw violation('assignment.review', 'review_context_invalid', `${label}.review.kind must be one of ${REVIEW_KINDS.join(', ')}`);
  }
  const textProblem = boundedString(value.checkpointId, `${label}.review.checkpointId`)
    || (value.checkpointId.length > 160 ? `${label}.review.checkpointId exceeds 160 characters` : null)
    || boundedString(value.reason, `${label}.review.reason`);
  if (textProblem) throw violation('assignment.review', 'review_context_invalid', textProblem);
  const pathsProblem = checkStringArray(value.paths, `${label}.review.paths`, { allowEmpty: false });
  const evidenceProblem = checkStringArray(value.evidenceIds, `${label}.review.evidenceIds`);
  const prerequisiteFor = value.prerequisiteFor === undefined ? [] : value.prerequisiteFor;
  const prerequisiteProblem = checkStringArray(prerequisiteFor, `${label}.review.prerequisiteFor`);
  if (pathsProblem || evidenceProblem || prerequisiteProblem) {
    throw violation('assignment.review', 'review_context_invalid', pathsProblem || evidenceProblem || prerequisiteProblem);
  }
  if (value.paths.some((file) => !safeRelativePath(file) || /[*?[]/.test(file))) {
    throw violation('assignment.review', 'review_context_invalid', `${label}.review.paths must contain safe workspace-relative paths without globs`);
  }
  if (new Set(value.paths).size !== value.paths.length || new Set(value.evidenceIds).size !== value.evidenceIds.length
    || new Set(prerequisiteFor).size !== prerequisiteFor.length || prerequisiteFor.some((id) => id.length > 160)) {
    throw violation('assignment.review', 'review_context_invalid', `${label}.review paths, evidenceIds, and prerequisiteFor must be unique; prerequisite IDs are limited to 160 characters`);
  }
  if (auditor && value.kind === 'routine') {
    throw violation('assignment.review', 'review_context_invalid', 'Routine work is not an auditor trigger');
  }
  if (writable && !['routine', 'risk_change', 'performance', 'component_complete'].includes(value.kind)) {
    throw violation('assignment.review', 'review_context_invalid', `Writable assignments cannot use review kind ${value.kind}`);
  }
  return {
    kind: value.kind,
    checkpointId: value.checkpointId,
    reason: value.reason,
    paths: [...value.paths],
    evidenceIds: [...value.evidenceIds],
    prerequisiteFor: [...prerequisiteFor],
  };
}

function checkDecisionRecordsShape(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw violation('decision.records', 'records_invalid', 'records must be an array of at most 20 structured records');
  }
  const ids = new Set();
  const normalized = value.map((entry, index) => {
    const label = `records[${index}]`;
    const fields = ['id', 'kind', 'status', 'summary', 'evidenceIds', 'relatedIds', 'adrPath'];
    if (!isPlainObject(entry) || !sameKeys(entry, fields)) {
      throw violation('decision.records', 'records_invalid', `${label} must contain exactly ${fields.join(', ')}`);
    }
    if (boundedString(entry.id, `${label}.id`) || entry.id.length > 160 || !isSafeIdentity(entry.id)) {
      throw violation('decision.records', 'records_invalid', `${label}.id must be a safe non-empty staging identity of at most 160 characters`);
    }
    if (ids.has(entry.id)) throw violation('decision.records', 'records_invalid', `${label}.id must be unique in this decision`);
    ids.add(entry.id);
    if (!RECORD_KINDS.includes(entry.kind) || !RECORD_STATUSES.includes(entry.status)) {
      throw violation('decision.records', 'records_invalid', `${label} has an unsupported kind or status`);
    }
    if (boundedString(entry.summary, `${label}.summary`)) {
      throw violation('decision.records', 'records_invalid', `${label}.summary must be a non-empty string of at most ${MAX_CHARS} characters`);
    }
    const evidenceProblem = checkStringArray(entry.evidenceIds, `${label}.evidenceIds`);
    const relatedProblem = checkStringArray(entry.relatedIds, `${label}.relatedIds`);
    if (evidenceProblem || relatedProblem) {
      throw violation('decision.records', 'records_invalid', evidenceProblem || relatedProblem);
    }
    if (entry.relatedIds.some((relatedId) => !isSafeIdentity(relatedId))) {
      throw violation('decision.records', 'records_invalid', `${label}.relatedIds must use safe staging identity values`);
    }
    if (new Set(entry.evidenceIds).size !== entry.evidenceIds.length || new Set(entry.relatedIds).size !== entry.relatedIds.length) {
      throw violation('decision.records', 'records_invalid', `${label} evidenceIds and relatedIds must be unique`);
    }
    if (entry.kind === 'architecture') {
      if (!isNonEmptyString(entry.adrPath) || entry.adrPath.length > 240
        || !safeRelativePath(entry.adrPath) || !entry.adrPath.endsWith('.md') || /[*?[]/.test(entry.adrPath)) {
        throw violation('decision.records', 'records_invalid', `${label}.adrPath must be a safe workspace-relative .md path`);
      }
    } else if (entry.adrPath !== null) {
      throw violation('decision.records', 'records_invalid', `${label}.adrPath must be null unless kind is architecture`);
    }
    return { ...entry, evidenceIds: [...entry.evidenceIds], relatedIds: [...entry.relatedIds] };
  });
  return normalized;
}

function checkDecisionRecords(value, priorProblemIds = []) {
  const normalized = checkDecisionRecordsShape(value);
  const knownProblems = new Set([...priorProblemIds, ...normalized.filter((entry) => entry.kind === 'problem').map((entry) => entry.id)]);
  for (const [index, entry] of normalized.entries()) {
    if (!['remedy', 'verification'].includes(entry.kind)) continue;
    if (entry.relatedIds.length === 0 || entry.relatedIds.some((id) => !knownProblems.has(id))) {
      throw violation('decision.records', 'records_invalid', `records[${index}] ${entry.kind} must relate to an existing problem record ID`);
    }
  }
  return normalized;
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
    throw violation('assignment.shape', 'assignment_shape_invalid', 'Assignment must contain the ordinary fields and may include skills, wave, continueFrom, review, and repair');
  }
  // Older checkpoints and callers predate assignment skill routing and waves.
  if (!keys.includes('skills')) assignment.skills = [];
  if (!keys.includes('wave')) assignment.wave = null;
  if (!keys.includes('continueFrom')) assignment.continueFrom = null;
  if (!keys.includes('review')) assignment.review = null;
  if (!keys.includes('repair')) assignment.repair = null;
  if (assignment.wave !== null && !(Number.isInteger(assignment.wave) && assignment.wave >= 1)) {
    throw violation('assignment.wave', 'wave_invalid', `Assignment wave must be an integer >= 1 or null, got ${JSON.stringify(assignment.wave)}`);
  }
  const role = getRole(ctx.roles, assignment.role);
  if (!role) throw violation('assignment.shape', 'role_unknown', `Unknown role: ${String(assignment.role)}`);
  assignment.role = role.name;
  const canonicalRole = canonicalRoleId(role.name);
  if (assignment.repair !== null) {
    const repairRoles = new Set(['engineer', 'recovery-engineer', 'senior-engineer']);
    const repair = assignment.repair;
    if (!isPlainObject(repair) || !sameKeys(repair, ['checkpointIds'])
      || !Array.isArray(repair.checkpointIds) || repair.checkpointIds.length === 0 || repair.checkpointIds.length > MAX_ITEMS
      || repair.checkpointIds.some((id) => !isNonEmptyString(id) || id.length > 160)
      || new Set(repair.checkpointIds).size !== repair.checkpointIds.length) {
      throw violation('assignment.shape', 'field_invalid', 'repair must contain exactly a unique non-empty checkpointIds array of at most 20 IDs');
    }
    if (!repairRoles.has(canonicalRole) || role.sandbox === 'read-only' || assignment.review !== null) {
      throw violation('assignment.shape', 'field_invalid', 'repair is allowed only on one writable engineer, recovery-engineer, or senior-engineer assignment with review null');
    }
    if (decision.assignments.length !== 1) {
      throw violation('assignment.shape', 'field_invalid', 'A repair assignment must be the only assignment in its decision');
    }
    const expected = [...(ctx.incompleteCriticalCheckpointIds || [])].sort();
    const actual = [...repair.checkpointIds].sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
      throw violation('assignment.shape', 'field_invalid', 'repair.checkpointIds must name the exact set of currently incomplete critical checkpoints');
    }
    assignment.repair = { checkpointIds: [...repair.checkpointIds] };
  }
  const reviewRequired = canonicalRole === 'auditor' || canonicalRole === 'verifier';
  assignment.review = checkReviewContext(assignment.review, `Assignment for ${role.name}`, {
    required: reviewRequired,
    auditor: canonicalRole === 'auditor',
    writable: role.sandbox !== 'read-only' && canonicalRole !== 'verifier',
  });
  if (assignment.review?.prerequisiteFor.length > 0
    && (!['verifier', 'auditor'].includes(canonicalRole) || !REVIEW_GATED_KINDS.includes(assignment.review.kind))) {
    throw violation('assignment.review', 'review_context_invalid', 'review.prerequisiteFor is allowed only on a gated verifier scope and its matching auditor');
  }
  if (assignment.review && role.sandbox === 'read-only' && canonicalRole !== 'auditor') {
    throw violation('assignment.review', 'review_context_invalid', `Only the auditor may receive explicit read-only review metadata; ${role.name} should receive an investigation without it`);
  }
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
    const guidance = canonicalRole === 'verifier'
      ? '; choose 1-20 bounded existing test/check paths from workspace evidence. allowedFiles grants write permission but does not require edits'
      : '';
    throw violation('assignment.writer_scope', 'writer_scope_missing', `Writable role ${role.name} requires explicit allowedFiles${guidance}`);
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
  if (canonicalRole === 'verifier' && assignment.review
    && !['routine', ...REVIEW_GATED_KINDS].includes(assignment.review.kind)) {
    throw violation('assignment.review', 'review_context_invalid', 'Verifier assignments must declare a routine or gated review context');
  }
}

const SPECIALIST_REQUIRED_KEYS = ['objective', 'allowedFiles'];
const SPECIALIST_OPTIONAL_KEYS = [
  'role', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions',
  'skills', 'wave', 'skillPins', 'assignmentId', 'workspace', 'reportContract', 'requireAcceptance', 'continuation', 'review', 'repair',
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
  const canonicalRole = canonicalRoleId(role?.name || role?.id);
  if (request.repair !== undefined && request.repair !== null) {
    const repairRoles = new Set(['engineer', 'recovery-engineer', 'senior-engineer']);
    const repair = request.repair;
    if (!isPlainObject(repair) || !sameKeys(repair, ['checkpointIds'])
      || !Array.isArray(repair.checkpointIds) || repair.checkpointIds.length === 0 || repair.checkpointIds.length > MAX_ITEMS
      || repair.checkpointIds.some((id) => !isNonEmptyString(id) || id.length > 160)
      || new Set(repair.checkpointIds).size !== repair.checkpointIds.length
      || !repairRoles.has(canonicalRole) || readOnly || request.review !== null) {
      throw violation('dispatch.request_input', 'request_invalid', 'repair must be a unique checkpointIds list on a writable engineering request with review null');
    }
    out.repair = { checkpointIds: [...repair.checkpointIds] };
  }
  const reviewRequired = canonicalRole === 'auditor';
  if (request.review !== undefined || reviewRequired) {
    out.review = checkReviewContext(request.review, `Request for ${label}`, {
      required: reviewRequired,
      auditor: canonicalRole === 'auditor',
    });
  }
  if (out.review?.prerequisiteFor.length > 0
    && (!['verifier', 'auditor'].includes(canonicalRole) || !REVIEW_GATED_KINDS.includes(out.review.kind))) {
    throw violation('dispatch.request_input', 'request_invalid', 'review.prerequisiteFor is allowed only on a gated verifier scope and its matching auditor request');
  }
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

// True when `text` names `id`, and not only as the prefix of a longer id (r1:a1 is not cited by r1:a10).
function citesId(text, id) {
  if (typeof text !== 'string' || !id) return false;
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
    if (!/[0-9]/.test(text[at + id.length] || '')) return true;
  }
  return false;
}

/**
 * LL-6 investigate first. An investigation of a blocker is a finished read-only outcome of this run with
 * a valid report (ctx.investigations: [{ assignmentId, round }]) from a round after `afterRound`, the round
 * in which the blocker first appeared, and the escalation must cite its assignmentId (in `ids` or `texts`).
 */
function citedInvestigation(ctx, afterRound, { ids = [], texts = [] }) {
  return (ctx.investigations || []).find((entry) => entry.round > afterRound
    && (ids.includes(entry.assignmentId) || texts.some((text) => citesId(text, entry.assignmentId)))) || null;
}

function checkHumanInput(humanInput, openIds, ctx = {}) {
  if (!isPlainObject(humanInput)) throw violation('decision.envelope', 'decision_envelope_invalid', 'request_human_input requires a humanInput object');
  const keys = ['reason', 'question', 'options', 'recommendation', 'evidenceChecked', 'independentWork', 'relatedDecisionIds'];
  if (!sameKeys(humanInput, keys)) throw violation('decision.envelope', 'decision_envelope_invalid', `humanInput must contain exactly ${keys.join(', ')}`);
  if (!HUMAN_REASONS.includes(humanInput.reason)) {
    throw violation('decision.envelope', 'decision_envelope_invalid', `humanInput.reason must be an owner-only decision: one of ${HUMAN_REASONS.join(', ')}; anything else is yours to decide after investigation`);
  }
  const problem = boundedString(humanInput.question, 'humanInput.question')
    || boundedString(humanInput.independentWork, 'humanInput.independentWork', { allowEmpty: true })
    || checkOptions(humanInput.options, humanInput.recommendation, 'humanInput')
    || checkStringArray(humanInput.evidenceChecked, 'humanInput.evidenceChecked', { allowEmpty: false })
    || checkStringArray(humanInput.relatedDecisionIds, 'humanInput.relatedDecisionIds');
  if (problem) throw violation('decision.envelope', 'decision_envelope_invalid', problem);
  const investigationIds = new Set((ctx.investigations || []).map((entry) => entry.assignmentId));
  for (const id of humanInput.relatedDecisionIds) {
    // An investigation may be cited here by its assignmentId; every other id must be an open decision.
    if (!openIds.has(id) && !investigationIds.has(id)) throw violation('decision.resolutions', 'decision_unresolved', `humanInput.relatedDecisionIds references a decision that is not open: ${id}`);
  }
  // The blocker first appeared in the latest round of the related open worker decisions (0 when none).
  const rounds = humanInput.relatedDecisionIds.filter((id) => openIds.has(id)).map((id) => ctx.openDecisionRounds?.get(id) ?? 0);
  const blockerRound = Math.max(0, ...rounds);
  if (!citedInvestigation(ctx, blockerRound, { ids: humanInput.relatedDecisionIds, texts: humanInput.evidenceChecked })) {
    throw violation('decision.investigate_first', 'investigation_missing',
      `request_human_input needs a finished read-only investigation of the blocker from a round after ${blockerRound}, cited by its assignmentId in evidenceChecked or relatedDecisionIds`);
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
  const groups = executionGroups(assignments);
  const groupOf = new Map();
  groups.forEach((members, groupIndex) => members.forEach((index) => groupOf.set(index, groupIndex)));
  for (const group of groups) {
    const writers = group.filter((index) => getRole(ctx.roles, assignments[index].role)?.sandbox !== 'read-only');
    const reviewers = group.filter((index) => ['auditor', 'verifier'].includes(canonicalRoleId(assignments[index].role)));
    for (const reviewerIndex of reviewers) {
      const concurrentWriter = writers.find((index) => index !== reviewerIndex);
      if (concurrentWriter !== undefined) {
        const reviewer = assignments[reviewerIndex];
        throw violation('assignment.review', 'review_wave_conflict',
          `Review assignment #${reviewerIndex} (${reviewer.role}) cannot share a wave with writer assignment #${concurrentWriter} (${assignments[concurrentWriter].role})`);
      }
    }
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
  for (let index = 0; index < assignments.length; index += 1) {
    const reviewer = assignments[index];
    const reviewerRole = canonicalRoleId(reviewer.role);
    if (!['auditor', 'verifier'].includes(reviewerRole) || !reviewer.review) continue;
    const sameCheckpoint = assignments.map((entry, candidateIndex) => ({ entry, candidateIndex }))
      .filter(({ entry }) => entry.review?.checkpointId === reviewer.review.checkpointId);
    for (const { entry, candidateIndex } of sameCheckpoint) {
      if (entry.review.kind !== reviewer.review.kind || entry.review.reason !== reviewer.review.reason
        || JSON.stringify([...entry.review.paths].sort()) !== JSON.stringify([...reviewer.review.paths].sort())
        || JSON.stringify([...entry.review.evidenceIds].sort()) !== JSON.stringify([...reviewer.review.evidenceIds].sort())
        || JSON.stringify([...(entry.review.prerequisiteFor || [])].sort()) !== JSON.stringify([...(reviewer.review.prerequisiteFor || [])].sort())) {
        throw violation('assignment.review', 'review_context_invalid', 'Assignments for the same checkpoint must cite the same review kind, reason, scope, and evidence IDs');
      }
      if (getRole(ctx.roles, entry.role)?.sandbox !== 'read-only' && canonicalRoleId(entry.role) !== 'verifier'
        && groupOf.get(candidateIndex) >= groupOf.get(index)) {
        throw violation('assignment.review', 'review_wave_conflict', `${reviewer.role} must follow all same-checkpoint writers in the decision`);
      }
    }
    if (reviewerRole !== 'auditor') continue;
    const matchingVerifier = assignments.findIndex((entry) => canonicalRoleId(entry.role) === 'verifier'
      && entry.review?.checkpointId === reviewer.review.checkpointId);
    if (matchingVerifier >= 0) {
      if (groupOf.get(matchingVerifier) >= groupOf.get(index)) {
        throw violation('assignment.review', 'review_wave_conflict', 'Run the verifier before the auditor in separate execution groups');
      }
    }
  }
}

/**
 * Validate a parsed lead decision. Throws Error on violation.
 * ctx = { roles: Map, attemptedRoles: Set, outcomeCount: number, openDecisionIds: Set, unresolvedWriterCount?: number,
 *   investigations?: [{ assignmentId, round }], openDecisionRounds?: Map, goalInvestigationRound?: number | null }
 */
function checkSystemInput(value, openIds, ctx) {
  const fields = ['incidentId', 'question', 'evidence', 'relatedDecisionIds'];
  if (!isPlainObject(value) || !sameKeys(value, fields)) {
    throw violation('decision.envelope', 'decision_envelope_invalid', `systemInput must contain exactly ${fields.join(', ')}`);
  }
  const problem = boundedString(value.incidentId, 'systemInput.incidentId')
    || value.incidentId.length > 160 && 'systemInput.incidentId must be at most 160 characters'
    || boundedString(value.question, 'systemInput.question')
    || checkStringArray(value.evidence, 'systemInput.evidence', { allowEmpty: false })
    || checkStringArray(value.relatedDecisionIds, 'systemInput.relatedDecisionIds');
  if (problem) throw violation('decision.envelope', 'decision_envelope_invalid', problem);
  if (value.evidence.length > MAX_ITEMS || value.relatedDecisionIds.length > MAX_ITEMS
    || value.relatedDecisionIds.some((id) => id.length > 160)
    || new Set(value.evidence).size !== value.evidence.length || new Set(value.relatedDecisionIds).size !== value.relatedDecisionIds.length) {
    throw violation('decision.envelope', 'decision_envelope_invalid', 'systemInput evidence and relatedDecisionIds must be bounded and unique');
  }
  for (const id of value.relatedDecisionIds) {
    if (!openIds.has(id)) throw violation('decision.resolutions', 'decision_unresolved', `systemInput.relatedDecisionIds references a decision that is not open: ${id}`);
  }
  const completed = ctx.systemIncidents || new Set();
  const incidentKey = crypto.createHash('sha256').update(value.incidentId).update('\0').update(JSON.stringify(value.evidence)).digest('hex');
  if (completed.has(incidentKey)) {
    throw violation('decision.envelope', 'decision_envelope_invalid', `System incident ${value.incidentId} already has a completed repair request`);
  }
}

function validateDecision(decision, ctx) {
  if (!isPlainObject(decision)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead decision must be a JSON object');
  const openIds = ctx.openDecisionIds || new Set();
  const keys = Object.keys(decision);
  if (!DECISION_BASE_KEYS.every((key) => keys.includes(key)) || keys.some((key) => !DECISION_KEYS.includes(key))) {
    throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead decision contains an unsupported field');
  }
  // Older callers and replays predate goalAchieved and acceptanceChecks: both default to null, and a
  // legacy finish without the key keeps finishing as before.
  const legacyGoal = !keys.includes('goalAchieved');
  if (legacyGoal) decision.goalAchieved = null;
  if (!keys.includes('acceptanceChecks')) decision.acceptanceChecks = null;
  if (!keys.includes('systemInput')) decision.systemInput = null;
  if (decision.goalAchieved !== null && typeof decision.goalAchieved !== 'boolean') throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead goalAchieved must be true, false, or null');
  if (decision.acceptanceChecks !== null && !Array.isArray(decision.acceptanceChecks)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead acceptanceChecks must be an array or null');
  if (!['dispatch', 'finish', 'request_human_input', 'request_system_repair'].includes(decision.action)) throw violation('decision.envelope', 'decision_envelope_invalid', `Unsupported lead action: ${String(decision.action)}`);
  if (!Array.isArray(decision.assignments)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead assignments must be an array');
  if (typeof decision.final !== 'string') throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead final must be a string');
  if (!Array.isArray(decision.resolutions)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead resolutions must be an array');
  if (decision.humanInput !== null && !isPlainObject(decision.humanInput)) throw violation('decision.envelope', 'decision_envelope_invalid', 'Lead humanInput must be null or an object');
  if (!keys.includes('records')) decision.records = [];
  decision.records = checkDecisionRecords(decision.records, ctx.knownProblemIds || []);

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

  if (decision.action === 'request_system_repair') {
    checkSystemInput(decision.systemInput, openIds, ctx);
  } else if (decision.systemInput !== null) {
    throw violation('decision.envelope', 'decision_envelope_invalid', 'systemInput is allowed only for request_system_repair');
  }

  if (decision.action === 'finish') {
    if (decision.assignments.length !== 0 || !decision.final.trim()) throw violation('decision.envelope', 'decision_envelope_invalid', 'Finish decisions require no assignments and non-empty final text');
    if (decision.humanInput !== null) throw violation('decision.envelope', 'decision_envelope_invalid', 'Finish decisions must leave humanInput null');
    if (decision.goalAchieved === null && !legacyGoal) throw violation('decision.goal', 'goal_unstated', 'finish requires goalAchieved true or false');
    // LL-6: after the first unmet-goal finish, another one needs an investigation finished since then, cited in final.
    const since = ctx.goalInvestigationRound;
    if (decision.goalAchieved === false && Number.isInteger(since) && !citedInvestigation(ctx, since, { texts: [decision.final] })) {
      throw violation('decision.investigate_first', 'investigation_missing',
        `A repeated finish with goalAchieved false needs a finished read-only investigation from a round after ${since}, cited by its assignmentId in final, and final must state why each remaining blocker is owner-only`);
    }
  } else if (decision.action === 'request_human_input') {
    if (decision.assignments.length !== 0) throw violation('decision.envelope', 'decision_envelope_invalid', 'request_human_input decisions require no assignments');
    if (decision.final.trim()) throw violation('decision.envelope', 'decision_envelope_invalid', 'request_human_input decisions must leave final empty');
    checkHumanInput(decision.humanInput, openIds, ctx);
  } else if (decision.action === 'request_system_repair') {
    if (decision.assignments.length !== 0 || decision.final.trim() || decision.humanInput !== null
      || decision.goalAchieved !== null || decision.acceptanceChecks !== null || decision.resolutions.length !== 0) {
      throw violation('decision.envelope', 'decision_envelope_invalid', 'request_system_repair requires no assignments, final, humanInput, goalAchieved, acceptanceChecks, or resolutions');
    }
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

  const related = new Set(decision.action === 'request_human_input' ? decision.humanInput.relatedDecisionIds
    : decision.action === 'request_system_repair' ? decision.systemInput.relatedDecisionIds : []);
  // LL-6: a dispatch of only read-only roles may leave open decisions open while they are investigated;
  // without it no investigation could follow the round a worker decision was raised in.
  const investigating = decision.action === 'dispatch'
    && decision.assignments.every((assignment) => getRole(ctx.roles, assignment.role)?.sandbox === 'read-only');
  for (const id of investigating ? [] : openIds) {
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
  REVIEW_KINDS,
  REVIEW_GATED_KINDS,
  RECORD_KINDS,
  RECORD_STATUSES,
  checkReviewContext,
  checkDecisionRecordsShape,
  checkDecisionRecords,
  MAX_ASSIGNMENTS,
  executionGroups,
  HUMAN_REASONS,
};
