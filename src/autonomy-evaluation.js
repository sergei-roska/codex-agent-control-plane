'use strict';

// Pure CommonJS evaluator for the AUT-05 autonomy regression corpus baseline.
//
// This module is deliberately dependency-free: no ajv, no framework, no network,
// no model, no database, no filesystem writes. It takes already-parsed JSON
// objects (plus the raw-bytes sha256 of the corpus file) and returns plain
// objects. It NEVER throws for bad input; every failure becomes an error finding
// and a `valid: false` report.
//
// Validation is hand-written and matches the frozen schemas exactly:
//   schemas/autonomy-corpus-v1.schema.json
//   schemas/autonomy-observation-v1.schema.json
//   schemas/autonomy-baseline-v1.schema.json
// with `additionalProperties: false` semantics (exact key sets), closed enums,
// and no type coercion. A string "5" for an integer, or a boolean where a number
// is required, is an error, never coerced.

const VERSION = '1.0.0';

const CORPUS_SCHEMA_VERSION = 'autonomy-corpus/v1';
const OBSERVATION_SCHEMA_VERSION = 'autonomy-observation/v1';
const BASELINE_SCHEMA_VERSION = 'autonomy-baseline/v1';
const REPORT_SCHEMA_VERSION = 'autonomy-evaluation/v1';
const EVALUATION_SCOPE = 'offline_contract_and_artifact';

// The 9 stable metric IDs (docs/aut-05-metric-definitions.md section 2). Do not rename.
const METRIC_IDS = Object.freeze([
  'requirement_preservation',
  'first_pass_accepted_checkpoints',
  'accepted_results',
  'repair_cycles',
  'review_cycles',
  'owner_escalations',
  'elapsed_time',
  'tokens',
  'measured_cost_per_accepted_result',
]);

const METRIC_UNITS = Object.freeze({
  requirement_preservation: 'ratio',
  first_pass_accepted_checkpoints: 'ratio',
  accepted_results: 'count',
  repair_cycles: 'count',
  review_cycles: 'count',
  owner_escalations: 'count',
  elapsed_time: 'milliseconds',
  tokens: 'tokens',
  measured_cost_per_accepted_result: 'currency_per_accepted_result',
});

const RATIO_METRIC_IDS = Object.freeze(['requirement_preservation', 'first_pass_accepted_checkpoints']);

const EVALUATION_MODES = Object.freeze(['offline_contract', 'artifact_assessment', 'historical_observation', 'live_workflow']);
const FAILURE_FAMILIES = Object.freeze([
  'canonical_identity',
  'nested_manifest_contradiction',
  'producer_mismatch',
  'stale_review_continuation',
  'positive_control',
  'failed_incomplete_usage',
  'planning_baseline',
]);
const TARGET_SYSTEMS = Object.freeze(['harness', 'target_orchestrator']);
const ACTUAL_RESULTS = Object.freeze(['pass', 'fail', 'inconclusive', 'not_supported', 'not_run']);
const CHECK_RESULTS = Object.freeze(['passed', 'failed', 'not_run']);
const AVAILABILITIES = Object.freeze(['measured', 'derived', 'partial', 'unavailable']);
const TOKEN_COVERAGES = Object.freeze(['measured', 'derived', 'unavailable']);
const DATA_ORIGINS = Object.freeze(['illustrative', 'real']);
const LIFECYCLE_STATUSES = Object.freeze(['draft', 'captured', 'verified', 'baseline_ready', 'superseded']);
const UNITS = Object.freeze(['ratio', 'count', 'milliseconds', 'tokens', 'currency_per_accepted_result']);

const IDENTITY_FIELDS = Object.freeze(['runId', 'taskId', 'assignmentId', 'attemptId', 'checkpointId', 'candidateId']);
const TOKEN_FIELDS = Object.freeze(['input', 'cachedInput', 'output', 'reasoningOutput', 'total']);

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;

const RATIO_EPSILON = 1e-9;
const MAX_MESSAGE_LENGTH = 300;
const METRIC_DEFINITIONS_VERSION = 'aut-05-metrics/v1';
const SUPPORTED_HARD_RULES = Object.freeze([
  'corpusDigest must match the frozen corpus.json sha256',
  'an observation must never fabricate acceptance without current-target evidence',
  'a null metric value requires availability unavailable (or partial) and a non-empty missingReason',
  'a ratio metric must carry explicit numerator, denominator, and excludedIncompleteCount',
  'a nonzero denominator is required for measured_cost_per_accepted_result',
]);
const REQUIRED_BASELINE_PINS = Object.freeze([
  'docs/aut-05-metric-definitions.md',
  'schemas/autonomy-corpus-v1.schema.json',
  'schemas/autonomy-observation-v1.schema.json',
  'schemas/autonomy-baseline-v1.schema.json',
  'src/autonomy-evaluation.js',
  'tools/autonomy/evaluate.js',
]);

// ---------------------------------------------------------------------------
// Predicates (contracts.js style: exact, no coercion)
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isString(value) {
  return typeof value === 'string';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value) {
  return isInteger(value) && value >= 0;
}

function isDateTime(value) {
  if (!isString(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== 'Z') {
    const offsetHour = Number(match[7].slice(1, 3));
    const offsetMinute = Number(match[7].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

// Exact key set in any order (additionalProperties: false semantics).
function sameKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}

function truncate(message) {
  const text = String(message);
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}...` : text;
}

function addFinding(findings, code, severity, message, refs = {}) {
  const finding = { code, severity, message: truncate(message) };
  if (refs.observationId != null) finding.observationId = refs.observationId;
  if (refs.caseId != null) finding.caseId = refs.caseId;
  if (refs.metricId != null) finding.metricId = refs.metricId;
  findings.push(finding);
}

// ---------------------------------------------------------------------------
// Corpus validation (autonomy-corpus/v1)
// ---------------------------------------------------------------------------

const CASE_FIELDS = [
  'caseId', 'revision', 'title', 'failureFamily', 'evaluationMode', 'targetSystem',
  'sourceSnapshot', 'goal', 'canonicalInputs', 'constraints', 'inputArtifacts',
  'expectedOutcomeArtifacts', 'oracle', 'applicability', 'assessment',
];

function validatePathShaArray(value, label, code, findings, refs = {}) {
  if (!Array.isArray(value)) {
    addFinding(findings, code, 'error', `${label} must be an array`, refs);
    return;
  }
  value.forEach((item, i) => {
    if (!isPlainObject(item) || !sameKeys(item, ['path', 'sha256'])) {
      addFinding(findings, code, 'error', `${label}[${i}] must have exactly {path, sha256}`, refs);
      return;
    }
    if (!isString(item.path)) addFinding(findings, code, 'error', `${label}[${i}].path must be a string`, refs);
    if (!isString(item.sha256) || !SHA256_RE.test(item.sha256)) {
      addFinding(findings, code, 'error', `${label}[${i}].sha256 must be a 64-char lowercase hex digest`, refs);
    }
  });
  const paths = value.filter(isPlainObject).map((item) => item.path).filter(isString);
  if (new Set(paths).size !== paths.length) addFinding(findings, code, 'error', `${label} must not contain duplicate paths`, refs);
}

function validateStringArray(value, label, code, findings, refs = {}) {
  if (!Array.isArray(value) || value.some((item) => !isString(item))) {
    addFinding(findings, code, 'error', `${label} must be an array of strings`, refs);
  }
}

// Returns a Map<caseId, case> for cross-joins (insertion order = corpus order).
function validateCorpusInternal(value, findings) {
  const cases = new Map();
  if (!isPlainObject(value)) {
    addFinding(findings, 'corpus_not_object', 'error', 'corpus manifest must be a JSON object');
    return cases;
  }
  if (!sameKeys(value, ['schemaVersion', 'corpusId', 'revision', 'title', 'createdAt', 'cases'])) {
    addFinding(findings, 'corpus_top_level_fields', 'error', 'corpus manifest has wrong, missing, or unknown top-level fields');
  }
  if (value.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    addFinding(findings, 'corpus_schema_version', 'error', `corpus schemaVersion must be "${CORPUS_SCHEMA_VERSION}"`);
  }
  if (!isNonEmptyString(value.corpusId) || !ID_RE.test(value.corpusId)) {
    addFinding(findings, 'corpus_corpus_id', 'error', 'corpus corpusId must be a non-empty string matching ^[A-Za-z0-9_-]+$');
  }
  if (!isNonNegativeSafeInteger(value.revision)) {
    addFinding(findings, 'corpus_revision', 'error', 'corpus revision must be a non-negative safe integer (no coercion)');
  }
  if (!isString(value.title)) addFinding(findings, 'corpus_title', 'error', 'corpus title must be a string');
  if (!isString(value.createdAt)) addFinding(findings, 'corpus_created_at', 'error', 'corpus createdAt must be a string');
  if (!Array.isArray(value.cases)) {
    addFinding(findings, 'corpus_cases', 'error', 'corpus cases must be an array');
    return cases;
  }
  if (value.cases.length === 0) addFinding(findings, 'corpus_cases_empty', 'error', 'corpus must contain at least one case');
  const presentFamilies = new Set(value.cases.filter(isPlainObject).map((item) => item.failureFamily));
  for (const family of FAILURE_FAMILIES) {
    if (!presentFamilies.has(family)) addFinding(findings, 'corpus_required_family_missing', 'error', `corpus is missing required failure family "${family}"`);
  }

  value.cases.forEach((caseObj, index) => {
    const label = `corpus.cases[${index}]`;
    if (!isPlainObject(caseObj)) {
      addFinding(findings, 'corpus_case_fields', 'error', `${label} must be an object`);
      return;
    }
    const refs = isString(caseObj.caseId) ? { caseId: caseObj.caseId } : {};
    if (!sameKeys(caseObj, CASE_FIELDS)) {
      addFinding(findings, 'corpus_case_fields', 'error', `${label} has wrong, missing, or unknown fields`, refs);
    }
    if (!isNonEmptyString(caseObj.caseId) || !ID_RE.test(caseObj.caseId)) {
      addFinding(findings, 'corpus_case_id', 'error', `${label}.caseId must match ^[A-Za-z0-9_-]+$`, refs);
    } else if (cases.has(caseObj.caseId)) {
      addFinding(findings, 'corpus_duplicate_case_id', 'error', `duplicate caseId "${caseObj.caseId}" in corpus`, refs);
    }
    if (!isNonNegativeSafeInteger(caseObj.revision)) addFinding(findings, 'corpus_case_revision', 'error', `${label}.revision must be a non-negative safe integer`, refs);
    if (!isString(caseObj.title)) addFinding(findings, 'corpus_case_title', 'error', `${label}.title must be a string`, refs);
    if (!FAILURE_FAMILIES.includes(caseObj.failureFamily)) {
      addFinding(findings, 'corpus_case_failure_family', 'error', `${label}.failureFamily must be one of ${FAILURE_FAMILIES.join(', ')}`, refs);
    }
    if (!EVALUATION_MODES.includes(caseObj.evaluationMode)) {
      addFinding(findings, 'corpus_case_evaluation_mode', 'error', `${label}.evaluationMode must be one of ${EVALUATION_MODES.join(', ')}`, refs);
    }
    if (!TARGET_SYSTEMS.includes(caseObj.targetSystem)) {
      addFinding(findings, 'corpus_case_target_system', 'error', `${label}.targetSystem must be "harness" or "target_orchestrator"`, refs);
    }
    if (!isString(caseObj.sourceSnapshot)) addFinding(findings, 'corpus_case_source_snapshot', 'error', `${label}.sourceSnapshot must be a string`, refs);
    if (!isString(caseObj.goal)) addFinding(findings, 'corpus_case_goal', 'error', `${label}.goal must be a string`, refs);
    validatePathShaArray(caseObj.canonicalInputs, `${label}.canonicalInputs`, 'corpus_case_inputs', findings, refs);
    validateStringArray(caseObj.constraints, `${label}.constraints`, 'corpus_case_constraints', findings, refs);
    validatePathShaArray(caseObj.inputArtifacts, `${label}.inputArtifacts`, 'corpus_case_inputs', findings, refs);
    validatePathShaArray(caseObj.expectedOutcomeArtifacts, `${label}.expectedOutcomeArtifacts`, 'corpus_case_inputs', findings, refs);

    const oracle = caseObj.oracle;
    if (!isPlainObject(oracle) || !sameKeys(oracle, ['requiredOutcome', 'forbiddenEffects', 'acceptedEvidenceType', 'sourceContract'])) {
      addFinding(findings, 'corpus_case_oracle', 'error', `${label}.oracle must have exactly {requiredOutcome, forbiddenEffects, acceptedEvidenceType, sourceContract}`, refs);
    } else {
      if (!isString(oracle.requiredOutcome)) addFinding(findings, 'corpus_case_oracle', 'error', `${label}.oracle.requiredOutcome must be a string`, refs);
      validateStringArray(oracle.forbiddenEffects, `${label}.oracle.forbiddenEffects`, 'corpus_case_oracle', findings, refs);
      if (!isString(oracle.acceptedEvidenceType)) addFinding(findings, 'corpus_case_oracle', 'error', `${label}.oracle.acceptedEvidenceType must be a string`, refs);
      if (!isString(oracle.sourceContract)) addFinding(findings, 'corpus_case_oracle', 'error', `${label}.oracle.sourceContract must be a string`, refs);
    }

    const applicability = caseObj.applicability;
    if (!isPlainObject(applicability) || !sameKeys(applicability, ['affectedByAutInterventions', 'isRegressionControl'])) {
      addFinding(findings, 'corpus_case_applicability', 'error', `${label}.applicability must have exactly {affectedByAutInterventions, isRegressionControl}`, refs);
    } else {
      validateStringArray(applicability.affectedByAutInterventions, `${label}.applicability.affectedByAutInterventions`, 'corpus_case_applicability', findings, refs);
      if (typeof applicability.isRegressionControl !== 'boolean') {
        addFinding(findings, 'corpus_case_applicability', 'error', `${label}.applicability.isRegressionControl must be a boolean`, refs);
      }
    }

    const assessment = caseObj.assessment;
    if (!isPlainObject(assessment) || !sameKeys(assessment, ['adapter', 'supportedObservations', 'knownLimitations'])) {
      addFinding(findings, 'corpus_case_assessment', 'error', `${label}.assessment must have exactly {adapter, supportedObservations, knownLimitations}`, refs);
    } else {
      if (!isString(assessment.adapter)) addFinding(findings, 'corpus_case_assessment', 'error', `${label}.assessment.adapter must be a string`, refs);
      validateStringArray(assessment.supportedObservations, `${label}.assessment.supportedObservations`, 'corpus_case_assessment', findings, refs);
      validateStringArray(assessment.knownLimitations, `${label}.assessment.knownLimitations`, 'corpus_case_assessment', findings, refs);
    }

    if (isNonEmptyString(caseObj.caseId)) cases.set(caseObj.caseId, caseObj);
  });

  return cases;
}

// ---------------------------------------------------------------------------
// Observation validation (autonomy-observation/v1)
// ---------------------------------------------------------------------------

const OBSERVATION_FIELDS = [
  'observationId', 'caseId', 'corpusRevision', 'corpusDigest', 'mode', 'dataOrigin',
  'runId', 'taskId', 'assignmentId', 'attemptId', 'checkpointId', 'candidateId',
  'identityNullReasons', 'targetSourceSnapshot', 'configDigests', 'runtime',
  'actualResult', 'checks', 'acceptanceDisposition', 'forbiddenEffectObservations',
  'evidenceArtifacts', 'metrics', 'evaluatedAt', 'measurementInterval',
];

const METRIC_FIELDS = [
  'metricId', 'value', 'unit', 'availability', 'sourceRef', 'missingReason',
  'numerator', 'denominator', 'excludedIncompleteCount', 'observationMode', 'tokenBreakdown',
];

const CONFIG_DIGEST_FIELDS = ['promptConfig', 'skillConfig', 'roleConfig', 'acceptanceRules'];

function validateConfigDigests(value, label, findings, refs = {}) {
  if (!isPlainObject(value) || !sameKeys(value, CONFIG_DIGEST_FIELDS)) {
    addFinding(findings, 'observation_config_digests', 'error', `${label}.configDigests must have exactly ${CONFIG_DIGEST_FIELDS.join(', ')}`, refs);
    return;
  }
  for (const field of CONFIG_DIGEST_FIELDS) {
    const digest = value[field];
    if (digest !== null && (!isString(digest) || !SHA256_RE.test(digest))) {
      addFinding(findings, 'observation_config_digests', 'error', `${label}.configDigests.${field} must be null or a 64-char hex digest`, refs);
    }
  }
}

function validateRuntime(value, label, findings, refs = {}) {
  if (value === null) return;
  if (!isPlainObject(value) || !sameKeys(value, ['modelId', 'provider', 'reasoningSettings', 'promptHashes', 'skillHashes', 'budgets', 'toolConfig'])) {
    addFinding(findings, 'observation_runtime', 'error', `${label}.runtime must be null or an object with the exact runtime fields`, refs);
    return;
  }
  for (const field of ['modelId', 'provider', 'reasoningSettings']) {
    if (value[field] !== null && !isString(value[field])) {
      addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.${field} must be null or a string`, refs);
    }
  }
  for (const field of ['promptHashes', 'skillHashes']) {
    if (value[field] !== null && (!Array.isArray(value[field]) || value[field].some((s) => !isString(s)))) {
      addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.${field} must be null or an array of strings`, refs);
    }
  }
  const budgets = value.budgets;
  if (budgets !== null) {
    if (!isPlainObject(budgets) || !sameKeys(budgets, ['maxTokens', 'timeoutMs'])) {
      addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.budgets must be null or {maxTokens, timeoutMs}`, refs);
    } else {
      if (budgets.maxTokens !== null && !isInteger(budgets.maxTokens)) addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.budgets.maxTokens must be null or an integer`, refs);
      if (budgets.timeoutMs !== null && !isInteger(budgets.timeoutMs)) addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.budgets.timeoutMs must be null or an integer`, refs);
    }
  }
  const toolConfig = value.toolConfig;
  if (toolConfig !== null) {
    if (!isPlainObject(toolConfig) || !sameKeys(toolConfig, ['toolPolicyDigest'])) {
      addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.toolConfig must be null or {toolPolicyDigest}`, refs);
    } else if (toolConfig.toolPolicyDigest !== null && !isString(toolConfig.toolPolicyDigest)) {
      addFinding(findings, 'observation_runtime', 'error', `${label}.runtime.toolConfig.toolPolicyDigest must be null or a string`, refs);
    }
  }
}

function validateMeasurementInterval(value, label, findings, refs = {}) {
  if (!isPlainObject(value) || !sameKeys(value, ['start', 'end', 'pauseHandling'])) {
    addFinding(findings, 'observation_measurement_interval', 'error', `${label}.measurementInterval must have exactly {start, end, pauseHandling}`, refs);
    return;
  }
  for (const field of ['start', 'end']) {
    if (value[field] !== null && !isDateTime(value[field])) {
      addFinding(findings, 'observation_measurement_interval', 'error', `${label}.measurementInterval.${field} must be null or an RFC 3339 date-time`, refs);
    }
  }
  if (!isString(value.pauseHandling)) {
    addFinding(findings, 'observation_measurement_interval', 'error', `${label}.measurementInterval.pauseHandling must be a string`, refs);
  }
  if (value.start !== null && value.end !== null && Date.parse(value.end) < Date.parse(value.start)) {
    addFinding(findings, 'observation_measurement_interval', 'error', `${label}.measurementInterval.end must not precede start`, refs);
  }
}

function validateTokenBreakdown(value, label, findings, refs = {}) {
  if (!isPlainObject(value) || !sameKeys(value, ['input', 'cachedInput', 'output', 'reasoningOutput', 'total', 'derived', 'formula'])) {
    addFinding(findings, 'metric_token_field_invalid', 'error', `${label}.tokenBreakdown must have exactly {input, cachedInput, output, reasoningOutput, total, derived, formula}`, refs);
    return;
  }
  for (const field of TOKEN_FIELDS) {
    const tokenField = value[field];
    if (!isPlainObject(tokenField) || !sameKeys(tokenField, ['value', 'coverage'])
      || (tokenField.value !== null && !isNonNegativeSafeInteger(tokenField.value))
      || !TOKEN_COVERAGES.includes(tokenField.coverage)) {
      addFinding(findings, 'metric_token_field_invalid', 'error', `${label}.tokenBreakdown.${field} must be {value: number|null, coverage: measured|derived|unavailable}`, refs);
    }
    if (isPlainObject(tokenField)) {
      if (tokenField.coverage === 'unavailable' && tokenField.value !== null) addFinding(findings, 'metric_token_coverage_conflict', 'error', `${label}.tokenBreakdown.${field} unavailable coverage requires a null value`, refs);
      if (tokenField.coverage !== 'unavailable' && tokenField.value === null) addFinding(findings, 'metric_token_coverage_conflict', 'error', `${label}.tokenBreakdown.${field} measured or derived coverage requires a value`, refs);
    }
  }
  const derived = value.derived;
  const formula = value.formula;
  if (derived === true) {
    if (!isNonEmptyString(formula)) addFinding(findings, 'metric_token_derived_inconsistent', 'error', `${label}.tokenBreakdown.derived true requires a non-null formula`, refs);
  } else if (derived === false) {
    if (formula !== null) addFinding(findings, 'metric_token_derived_inconsistent', 'error', `${label}.tokenBreakdown.formula must be null when derived is false`, refs);
  } else {
    addFinding(findings, 'metric_token_derived_inconsistent', 'error', `${label}.tokenBreakdown.derived must be a boolean`, refs);
  }
  if (isPlainObject(value.input) && isPlainObject(value.output) && isPlainObject(value.total)) {
    if (derived === true) {
      if (formula !== 'total = input + output' || value.input.value === null || value.output.value === null
        || value.total.value !== value.input.value + value.output.value || value.total.coverage !== 'derived') {
        addFinding(findings, 'metric_token_derived_inconsistent', 'error', `${label}.tokenBreakdown derived total must equal input + output using the declared formula`, refs);
      }
    } else if (derived === false && value.total.coverage === 'derived') {
      addFinding(findings, 'metric_token_derived_inconsistent', 'error', `${label}.tokenBreakdown derived total requires derived=true`, refs);
    }
  }
  if (isPlainObject(value.input) && isPlainObject(value.cachedInput)
    && isNumber(value.input.value) && isNumber(value.cachedInput.value)
    && value.cachedInput.value > value.input.value) {
    addFinding(findings, 'metric_token_cached_input_invalid', 'error', `${label}.tokenBreakdown.cachedInput must be a subset of input`, refs);
  }
  if (isPlainObject(value.output) && isPlainObject(value.reasoningOutput)
    && isNumber(value.output.value) && isNumber(value.reasoningOutput.value)
    && value.reasoningOutput.value > value.output.value) {
    addFinding(findings, 'metric_token_reasoning_output_invalid', 'error', `${label}.tokenBreakdown.reasoningOutput must be included within output`, refs);
  }
}

function validateMetric(metric, label, observationMode, findings, refs = {}) {
  if (!isPlainObject(metric)) {
    addFinding(findings, 'metric_fields', 'error', `${label} must be a metric object`, refs);
    return;
  }
  const metricId = isString(metric.metricId) ? metric.metricId : null;
  const mrefs = metricId != null ? { ...refs, metricId } : refs;
  if (!isPlainObject(metric) || !sameKeys(metric, METRIC_FIELDS)) {
    addFinding(findings, 'metric_fields', 'error', `${label}.metrics must have exactly ${METRIC_FIELDS.join(', ')}`, mrefs);
    return;
  }
  if (!METRIC_IDS.includes(metric.metricId)) {
    addFinding(findings, 'metric_id_invalid', 'error', `${label}.metricId must be one of the 9 stable metric IDs`, mrefs);
  }
  if (metric.value !== null && !isNumber(metric.value)) {
    addFinding(findings, 'metric_value_type', 'error', `${label}.value must be a number or null (never a string/boolean)`, mrefs);
  }
  if (!UNITS.includes(metric.unit)) {
    addFinding(findings, 'metric_invalid_unit', 'error', `${label}.unit must be one of ${UNITS.join(', ')}`, mrefs);
  } else if (isString(metric.metricId) && METRIC_UNITS[metric.metricId] !== undefined && metric.unit !== METRIC_UNITS[metric.metricId]) {
    addFinding(findings, 'metric_invalid_unit', 'error', `${label}.unit "${metric.unit}" is invalid for metricId "${metric.metricId}" (expected "${METRIC_UNITS[metric.metricId]}")`, mrefs);
  }
  if (!AVAILABILITIES.includes(metric.availability)) {
    addFinding(findings, 'metric_availability_invalid', 'error', `${label}.availability must be one of ${AVAILABILITIES.join(', ')}`, mrefs);
  }
  if (!isString(metric.sourceRef)) addFinding(findings, 'metric_source_ref', 'error', `${label}.sourceRef must be a string`, mrefs);
  if (metric.missingReason !== null && !isString(metric.missingReason)) {
    addFinding(findings, 'metric_missing_reason', 'error', `${label}.missingReason must be null or a string`, mrefs);
  }
  if (metric.numerator !== null && (!isNumber(metric.numerator) || metric.numerator < 0)) addFinding(findings, 'metric_numerator_type', 'error', `${label}.numerator must be a non-negative finite number or null`, mrefs);
  if (metric.denominator !== null && !isNonNegativeSafeInteger(metric.denominator)) addFinding(findings, 'metric_denominator_type', 'error', `${label}.denominator must be a non-negative safe integer or null`, mrefs);
  if (metric.excludedIncompleteCount !== null && !isNonNegativeSafeInteger(metric.excludedIncompleteCount)) addFinding(findings, 'metric_excluded_type', 'error', `${label}.excludedIncompleteCount must be a non-negative safe integer or null`, mrefs);
  if (!EVALUATION_MODES.includes(metric.observationMode)) {
    addFinding(findings, 'metric_observation_mode_invalid', 'error', `${label}.observationMode must be one of ${EVALUATION_MODES.join(', ')}`, mrefs);
  } else if (metric.observationMode !== observationMode) {
    addFinding(findings, 'metric_observation_mode_mismatch', 'error', `${label}.observationMode "${metric.observationMode}" must equal the observation mode "${observationMode}"`, mrefs);
  }
  if (metric.metricId !== 'tokens' && metric.tokenBreakdown !== null) {
    addFinding(findings, 'metric_token_breakdown_scope', 'error', `${label}.tokenBreakdown must be null for metricId "${metric.metricId}"`, mrefs);
  }
  if (RATIO_METRIC_IDS.includes(metric.metricId)) {
    if (metric.value !== null && (!isNumber(metric.value) || metric.value < 0 || metric.value > 1)) {
      addFinding(findings, 'metric_ratio_bounds', 'error', `${label} ratio value must be between 0 and 1`, mrefs);
    }
    if (metric.value !== null && (metric.numerator === null || metric.denominator === null || metric.excludedIncompleteCount === null)) {
      addFinding(findings, 'metric_ratio_metadata', 'error', `${label} measured ratio requires numerator, denominator, and excludedIncompleteCount`, mrefs);
    }
    if (metric.value === null && (metric.numerator !== null || metric.denominator !== null || metric.excludedIncompleteCount !== null)) {
      addFinding(findings, 'metric_ratio_metadata', 'error', `${label} unavailable ratio must not claim numerator, denominator, or excluded counts`, mrefs);
    }
    if (metric.numerator !== null && !isNonNegativeSafeInteger(metric.numerator)) addFinding(findings, 'metric_ratio_metadata', 'error', `${label} ratio numerator must be a non-negative safe count`, mrefs);
  } else if (metric.metricId === 'accepted_results' || metric.metricId === 'repair_cycles'
    || metric.metricId === 'review_cycles' || metric.metricId === 'owner_escalations'
    || metric.metricId === 'elapsed_time') {
    if (metric.value !== null && !isNonNegativeSafeInteger(metric.value)) addFinding(findings, 'metric_count_bounds', 'error', `${label}.value must be a non-negative safe integer or null`, mrefs);
  }
  if (metric.metricId === 'tokens' && metric.value !== null && !isNonNegativeSafeInteger(metric.value)) {
    addFinding(findings, 'metric_count_bounds', 'error', `${label} token total must be a non-negative safe integer`, mrefs);
  }

  // Null semantics: value null requires availability unavailable/partial and a non-empty missingReason.
  if (metric.value === null) {
    if (!['unavailable', 'partial'].includes(metric.availability)) {
      addFinding(findings, 'metric_null_missing_reason', 'error', `${label}.value null requires availability "unavailable" or "partial"`, mrefs);
    }
    if (!isNonEmptyString(metric.missingReason)) {
      addFinding(findings, 'metric_null_missing_reason', 'error', `${label}.value null requires a non-empty missingReason`, mrefs);
    }
  } else if (metric.availability === 'unavailable') {
    addFinding(findings, 'metric_value_availability_conflict', 'error', `${label} has a non-null value with availability "unavailable"`, mrefs);
  }

  // Ratio metrics: non-null value requires numerator/denominator with denominator > 0 and value == numerator/denominator.
  if (['requirement_preservation', 'first_pass_accepted_checkpoints'].includes(metric.metricId) && metric.value !== null) {
    if (!isNumber(metric.numerator) || !isNumber(metric.denominator)) {
      addFinding(findings, 'metric_invalid_denominator', 'error', `${label} ratio metric requires non-null numerator and denominator`, mrefs);
    } else if (metric.denominator <= 0 || metric.numerator > metric.denominator) {
      addFinding(findings, 'metric_invalid_denominator', 'error', `${label} denominator must be greater than 0`, mrefs);
    } else if (Math.abs(metric.value - (metric.numerator / metric.denominator)) > RATIO_EPSILON) {
      addFinding(findings, 'metric_ratio_mismatch', 'error', `${label}.value must equal numerator/denominator (${metric.numerator}/${metric.denominator})`, mrefs);
    }
  }

  // measured_cost_per_accepted_result: non-null requires measured availability and a nonzero denominator.
  if (metric.metricId === 'measured_cost_per_accepted_result' && metric.value !== null) {
    if (metric.availability !== 'measured') {
      addFinding(findings, 'metric_cost_invalid', 'error', `${label} measured_cost_per_accepted_result requires availability "measured" when value is non-null`, mrefs);
    }
    if (!isNumber(metric.denominator) || metric.denominator <= 0) {
      addFinding(findings, 'metric_cost_invalid', 'error', `${label} measured_cost_per_accepted_result requires a nonzero denominator when value is non-null`, mrefs);
    }
    if (isNumber(metric.numerator) && isNumber(metric.denominator)
      && Math.abs(metric.value - metric.numerator / metric.denominator) > RATIO_EPSILON) {
      addFinding(findings, 'metric_cost_invalid', 'error', `${label}.value must equal cohort cost divided by accepted results`, mrefs);
    }
  }
  if (metric.metricId === 'measured_cost_per_accepted_result' && metric.value !== null
    && (metric.numerator === null || metric.denominator === null || metric.excludedIncompleteCount === null)) {
    addFinding(findings, 'metric_cost_invalid', 'error', `${label} measured_cost_per_accepted_result requires numerator, denominator, and excludedIncompleteCount`, mrefs);
  }

  if (metric.value === null && (metric.numerator !== null || metric.denominator !== null)
    && !['unavailable', 'partial'].includes(metric.availability)) {
    addFinding(findings, 'metric_null_denominator_conflict', 'error', `${label} unavailable value cannot claim measured denominator data`, mrefs);
  }

  // tokens: value null iff tokenBreakdown null.
  if (metric.metricId === 'tokens') {
    if ((metric.value === null) !== (metric.tokenBreakdown === null)) {
      addFinding(findings, 'metric_tokens_breakdown_mismatch', 'error', `${label} tokens value and tokenBreakdown must both be null or both be populated`, mrefs);
    }
    if (metric.tokenBreakdown !== null) {
      validateTokenBreakdown(metric.tokenBreakdown, label, findings, mrefs);
      if (isPlainObject(metric.tokenBreakdown) && metric.value !== metric.tokenBreakdown.total?.value) {
        addFinding(findings, 'metric_tokens_total_mismatch', 'error', `${label}.value must agree with tokenBreakdown.total.value`, mrefs);
      }
    }
  }
}

function validateObservationsInternal(value, findings) {
  const observations = [];
  if (!isPlainObject(value)) {
    addFinding(findings, 'observation_not_object', 'error', 'observation manifest must be a JSON object');
    return observations;
  }
  if (!sameKeys(value, ['schemaVersion', 'observations'])) {
    addFinding(findings, 'observation_top_level_fields', 'error', 'observation manifest has wrong, missing, or unknown top-level fields');
  }
  if (value.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    addFinding(findings, 'observation_schema_version', 'error', `observation schemaVersion must be "${OBSERVATION_SCHEMA_VERSION}"`);
  }
  if (!Array.isArray(value.observations)) {
    addFinding(findings, 'observation_list_invalid', 'error', 'observation observations must be an array');
    return observations;
  }

  const seenObservationIds = new Set();
  const seenAttemptIds = new Set();

  value.observations.forEach((obs, index) => {
    const label = `observations[${index}]`;
    if (!isPlainObject(obs)) {
      addFinding(findings, 'observation_fields', 'error', `${label} must be an object`);
      return;
    }
    observations.push(obs);
    const refs = isString(obs.observationId) ? { observationId: obs.observationId } : {};

    if (!sameKeys(obs, OBSERVATION_FIELDS)) {
      addFinding(findings, 'observation_fields', 'error', `${label} has wrong, missing, or unknown fields`, refs);
    }
    if (!isNonEmptyString(obs.observationId) || !ID_RE.test(obs.observationId)) {
      addFinding(findings, 'observation_id_invalid', 'error', `${label}.observationId must match ^[A-Za-z0-9_-]+$`, refs);
    } else if (seenObservationIds.has(obs.observationId)) {
      addFinding(findings, 'observation_duplicate_observation_id', 'error', `duplicate observationId "${obs.observationId}"`, refs);
    } else {
      seenObservationIds.add(obs.observationId);
    }
    if (!isNonEmptyString(obs.caseId) || !ID_RE.test(obs.caseId)) {
      addFinding(findings, 'observation_case_id_invalid', 'error', `${label}.caseId must match ^[A-Za-z0-9_-]+$`, refs);
    }
    if (!isNonNegativeSafeInteger(obs.corpusRevision)) {
      addFinding(findings, 'observation_corpus_revision_type', 'error', `${label}.corpusRevision must be a non-negative safe integer (no coercion)`, refs);
    }
    if (!isString(obs.corpusDigest) || !SHA256_RE.test(obs.corpusDigest)) {
      addFinding(findings, 'observation_corpus_digest_invalid', 'error', `${label}.corpusDigest must be a 64-char lowercase hex digest`, refs);
    }
    if (!EVALUATION_MODES.includes(obs.mode)) {
      addFinding(findings, 'observation_mode_invalid', 'error', `${label}.mode must be one of ${EVALUATION_MODES.join(', ')}`, refs);
    }
    if (!DATA_ORIGINS.includes(obs.dataOrigin)) {
      addFinding(findings, 'observation_data_origin_invalid', 'error', `${label}.dataOrigin must be "illustrative" or "real"`, refs);
    } else if (obs.dataOrigin === 'illustrative') {
      addFinding(findings, 'observation_illustrative_data', 'warning', `${label}.dataOrigin is "illustrative": schema-exercising example, not a real capture`, refs);
    }

    // Identity fields must be string or null.
    for (const id of IDENTITY_FIELDS) {
      if (obs[id] !== null && !isNonEmptyString(obs[id])) {
        addFinding(findings, 'observation_identity_type', 'error', `${label}.${id} must be a non-empty string or null`, refs);
      }
    }
    if (obs.attemptId != null) {
      if (seenAttemptIds.has(obs.attemptId)) addFinding(findings, 'observation_duplicate_attempt_id', 'error', `duplicate attemptId "${obs.attemptId}"`, refs);
      else seenAttemptIds.add(obs.attemptId);
    }
    // identityNullReasons: exact keys, each non-empty string iff identity null.
    if (!isPlainObject(obs.identityNullReasons) || !sameKeys(obs.identityNullReasons, IDENTITY_FIELDS)) {
      addFinding(findings, 'observation_identity_reasons_fields', 'error', `${label}.identityNullReasons must have exactly ${IDENTITY_FIELDS.join(', ')}`, refs);
    } else {
      for (const id of IDENTITY_FIELDS) {
        const reason = obs.identityNullReasons[id];
        const identity = obs[id];
        const consistent = (identity === null) ? isNonEmptyString(reason) : (reason === null);
        if (!consistent) {
          addFinding(findings, 'observation_identity_reason_mismatch', 'error', `${label}.${id} is ${identity === null ? 'null without a reason' : 'populated with a non-null reason'}; identityNullReasons.${id} must be a non-empty string iff ${id} is null`, refs);
        }
      }
    }

    if (!isString(obs.targetSourceSnapshot)) addFinding(findings, 'observation_target_source_snapshot', 'error', `${label}.targetSourceSnapshot must be a string`, refs);
    validateConfigDigests(obs.configDigests, label, findings, refs);
    validateRuntime(obs.runtime, label, findings, refs);

    if (!ACTUAL_RESULTS.includes(obs.actualResult)) {
      addFinding(findings, 'observation_actual_result', 'error', `${label}.actualResult must be one of ${ACTUAL_RESULTS.join(', ')}`, refs);
    }
    if (!Array.isArray(obs.checks)) {
      addFinding(findings, 'observation_checks', 'error', `${label}.checks must be an array`, refs);
    } else {
      const checkIds = new Set();
      obs.checks.forEach((check, ci) => {
        if (!isPlainObject(check) || !sameKeys(check, ['checkId', 'result', 'detail'])) {
          addFinding(findings, 'observation_checks', 'error', `${label}.checks[${ci}] must have exactly {checkId, result, detail}`, refs);
          return;
        }
        if (!isNonEmptyString(check.checkId) || !ID_RE.test(check.checkId)) addFinding(findings, 'observation_checks', 'error', `${label}.checks[${ci}].checkId must match ^[A-Za-z0-9_-]+$`, refs);
        if (isString(check.checkId) && checkIds.has(check.checkId)) addFinding(findings, 'observation_duplicate_check_id', 'error', `${label}.checks contains duplicate checkId "${check.checkId}"`, refs);
        if (isString(check.checkId)) checkIds.add(check.checkId);
        if (!CHECK_RESULTS.includes(check.result)) addFinding(findings, 'observation_checks', 'error', `${label}.checks[${ci}].result must be one of ${CHECK_RESULTS.join(', ')}`, refs);
        if (!isString(check.detail)) addFinding(findings, 'observation_checks', 'error', `${label}.checks[${ci}].detail must be a string`, refs);
      });
    }
    if (obs.actualResult === 'pass' && Array.isArray(obs.checks)
      && (obs.checks.length === 0 || obs.checks.some((check) => !isPlainObject(check) || check.result !== 'passed'))) {
      addFinding(findings, 'observation_pass_with_incomplete_check', 'error', `${label} actualResult "pass" requires at least one check and every check passed`, refs);
    }
    if (!isString(obs.acceptanceDisposition)) addFinding(findings, 'observation_acceptance_disposition', 'error', `${label}.acceptanceDisposition must be a string`, refs);
    validateStringArray(obs.forbiddenEffectObservations, `${label}.forbiddenEffectObservations`, 'observation_forbidden_effects', findings, refs);
    validatePathShaArray(obs.evidenceArtifacts, `${label}.evidenceArtifacts`, 'observation_evidence_artifacts', findings, refs);

    if (!Array.isArray(obs.metrics)) {
      addFinding(findings, 'observation_metrics', 'error', `${label}.metrics must be an array`, refs);
    } else {
      const metricIds = new Set();
      obs.metrics.forEach((metric) => {
        if (isPlainObject(metric) && isString(metric.metricId)) {
          if (metricIds.has(metric.metricId)) addFinding(findings, 'observation_duplicate_metric_id', 'error', `${label}.metrics contains duplicate metricId "${metric.metricId}"`, refs);
          metricIds.add(metric.metricId);
        }
      });
      obs.metrics.forEach((metric, mi) => validateMetric(metric, `${label}.metrics[${mi}]`, obs.mode, findings, refs));
      obs.metrics.forEach((metric) => {
        if (!isPlainObject(metric) || metric.value === null) return;
        const metricCanBeMeasured = metric.metricId === 'requirement_preservation' && obs.mode === 'artifact_assessment';
        if (!metricCanBeMeasured) addFinding(findings, 'metric_unsupported_measurement', 'error', `${label} cannot claim a measured ${String(metric.metricId)} value in this offline evaluator`, refs);
        if (metric.metricId === 'requirement_preservation' && (!Array.isArray(obs.evidenceArtifacts)
          || !obs.evidenceArtifacts.some((artifact) => isPlainObject(artifact) && artifact.path === metric.sourceRef))) {
          addFinding(findings, 'metric_source_unbound', 'error', `${label} requirement_preservation sourceRef must name one of its evidence artifact paths`, refs);
        }
      });
    }

    if (!isDateTime(obs.evaluatedAt)) addFinding(findings, 'observation_evaluated_at', 'error', `${label}.evaluatedAt must be an RFC 3339 date-time`, refs);
    validateMeasurementInterval(obs.measurementInterval, label, findings, refs);
  });

  return observations;
}

// ---------------------------------------------------------------------------
// Baseline validation (autonomy-baseline/v1)
// ---------------------------------------------------------------------------

const BASELINE_FIELDS = [
  'schemaVersion', 'baselineId', 'corpusDigest', 'corpusId', 'targetSourceSnapshot',
  'evaluatorVersion', 'metricDefinitionsVersion', 'configDigests', 'hardAcceptanceRules', 'caseObservations',
  'sourceOutputDigests', 'limitations', 'supportedScope', 'snapshotCompleteness',
  'metricAvailabilityCoverage', 'verificationEvidence', 'auditEvidence', 'lifecycleStatus',
];

function validateBaselineInternal(value, findings) {
  if (!isPlainObject(value)) {
    addFinding(findings, 'baseline_not_object', 'error', 'baseline manifest must be a JSON object');
    return;
  }
  if (!sameKeys(value, BASELINE_FIELDS)) {
    addFinding(findings, 'baseline_top_level_fields', 'error', 'baseline manifest has wrong, missing, or unknown top-level fields');
  }
  if (value.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    addFinding(findings, 'baseline_schema_version', 'error', `baseline schemaVersion must be "${BASELINE_SCHEMA_VERSION}"`);
  }
  if (!isNonEmptyString(value.baselineId) || !ID_RE.test(value.baselineId)) {
    addFinding(findings, 'baseline_id_invalid', 'error', 'baseline baselineId must match ^[A-Za-z0-9_-]+$');
  }
  if (!isString(value.corpusDigest) || !SHA256_RE.test(value.corpusDigest)) {
    addFinding(findings, 'baseline_corpus_digest_invalid', 'error', 'baseline corpusDigest must be a 64-char lowercase hex digest');
  }
  if (!isNonEmptyString(value.corpusId) || !ID_RE.test(value.corpusId)) {
    addFinding(findings, 'baseline_corpus_id_invalid', 'error', 'baseline corpusId must match ^[A-Za-z0-9_-]+$');
  }
  if (!isString(value.targetSourceSnapshot)) addFinding(findings, 'baseline_target_snapshot', 'error', 'baseline targetSourceSnapshot must be a string');
  if (value.evaluatorVersion !== VERSION) addFinding(findings, 'baseline_evaluator_version', 'error', `baseline evaluatorVersion must equal supported version "${VERSION}"`);
  if (value.metricDefinitionsVersion !== METRIC_DEFINITIONS_VERSION) addFinding(findings, 'baseline_metric_definitions_version', 'error', `baseline metricDefinitionsVersion must equal "${METRIC_DEFINITIONS_VERSION}"`);
  validateConfigDigests(value.configDigests, 'baseline', findings);
  if (!Array.isArray(value.hardAcceptanceRules) || value.hardAcceptanceRules.length !== SUPPORTED_HARD_RULES.length
    || value.hardAcceptanceRules.some((rule, i) => rule !== SUPPORTED_HARD_RULES[i])) {
    addFinding(findings, 'baseline_hard_rules', 'error', 'baseline hardAcceptanceRules must exactly match the supported ordered rule set');
  }
  validatePathShaArray(value.sourceOutputDigests, 'baseline.sourceOutputDigests', 'baseline_source_output_digests', findings);
  if (Array.isArray(value.sourceOutputDigests)) {
    const pinnedPaths = new Set(value.sourceOutputDigests.filter(isPlainObject).map((item) => item.path));
    for (const path of REQUIRED_BASELINE_PINS) {
      if (!pinnedPaths.has(path)) addFinding(findings, 'baseline_checker_pins', 'error', `baseline.sourceOutputDigests must pin checker or definition bytes at "${path}"`);
    }
  }
  validateStringArray(value.limitations, 'baseline.limitations', 'baseline_limitations', findings);
  if (!['offline_contract_and_artifact'].includes(value.supportedScope)) {
    addFinding(findings, 'baseline_supported_scope', 'error', 'baseline supportedScope must be "offline_contract_and_artifact"');
  }
  if (!isString(value.snapshotCompleteness)) addFinding(findings, 'baseline_snapshot_completeness', 'error', 'baseline snapshotCompleteness must be a string');
  validatePathShaArray(value.verificationEvidence, 'baseline.verificationEvidence', 'baseline_verification_evidence', findings);
  validatePathShaArray(value.auditEvidence, 'baseline.auditEvidence', 'baseline_audit_evidence', findings);
  if (!LIFECYCLE_STATUSES.includes(value.lifecycleStatus)) {
    addFinding(findings, 'baseline_lifecycle_status', 'error', `baseline lifecycleStatus must be one of ${LIFECYCLE_STATUSES.join(', ')}`);
  }

  if (!Array.isArray(value.caseObservations)) {
    addFinding(findings, 'baseline_case_observations', 'error', 'baseline caseObservations must be an array');
  } else {
    value.caseObservations.forEach((entry, i) => {
      if (!isPlainObject(entry) || !sameKeys(entry, ['caseId', 'observationIds'])) {
        addFinding(findings, 'baseline_case_observations', 'error', `baseline.caseObservations[${i}] must have exactly {caseId, observationIds}`);
        return;
      }
      if (!isNonEmptyString(entry.caseId) || !ID_RE.test(entry.caseId)) addFinding(findings, 'baseline_case_observations', 'error', `baseline.caseObservations[${i}].caseId must match ^[A-Za-z0-9_-]+$`);
      if (!Array.isArray(entry.observationIds) || entry.observationIds.length === 0 || entry.observationIds.some((id) => !isNonEmptyString(id) || !ID_RE.test(id))) {
        addFinding(findings, 'baseline_case_observations', 'error', `baseline.caseObservations[${i}].observationIds must be an array of strings`);
      }
    });
    const caseIds = value.caseObservations.filter(isPlainObject).map((entry) => entry.caseId).filter(isString);
    if (new Set(caseIds).size !== caseIds.length) addFinding(findings, 'baseline_case_observations', 'error', 'baseline.caseObservations must not contain duplicate case IDs');
    const observationIds = value.caseObservations.filter(isPlainObject).flatMap((entry) => Array.isArray(entry.observationIds) ? entry.observationIds : []).filter(isString);
    if (new Set(observationIds).size !== observationIds.length) addFinding(findings, 'baseline_case_observations', 'error', 'baseline observation references must not contain duplicate IDs');
  }

  if (!Array.isArray(value.metricAvailabilityCoverage)) {
    addFinding(findings, 'baseline_metric_coverage', 'error', 'baseline metricAvailabilityCoverage must be an array');
  } else {
    value.metricAvailabilityCoverage.forEach((entry, i) => {
      if (!isPlainObject(entry) || !sameKeys(entry, ['metricId', 'availability', 'reason'])) {
        addFinding(findings, 'baseline_metric_coverage', 'error', `baseline.metricAvailabilityCoverage[${i}] must have exactly {metricId, availability, reason}`);
        return;
      }
      if (!METRIC_IDS.includes(entry.metricId)) addFinding(findings, 'baseline_metric_coverage', 'error', `baseline.metricAvailabilityCoverage[${i}].metricId must be one of the 9 stable metric IDs`);
      if (!AVAILABILITIES.includes(entry.availability)) addFinding(findings, 'baseline_metric_coverage', 'error', `baseline.metricAvailabilityCoverage[${i}].availability must be one of ${AVAILABILITIES.join(', ')}`);
      if (!isString(entry.reason)) addFinding(findings, 'baseline_metric_coverage', 'error', `baseline.metricAvailabilityCoverage[${i}].reason must be a string`);
    });
    const coverageIds = value.metricAvailabilityCoverage.filter(isPlainObject).map((entry) => entry.metricId).filter(isString);
    if (new Set(coverageIds).size !== coverageIds.length || METRIC_IDS.some((id) => !coverageIds.includes(id))) {
      addFinding(findings, 'baseline_metric_coverage', 'error', 'baseline metricAvailabilityCoverage must list each stable metric exactly once');
    }
  }

  if (value.lifecycleStatus === 'baseline_ready'
    && (!Array.isArray(value.verificationEvidence) || value.verificationEvidence.length === 0
      || !Array.isArray(value.auditEvidence) || value.auditEvidence.length === 0)) {
    addFinding(findings, 'baseline_ready_without_reviews', 'error', 'baseline_ready requires non-empty verifier and auditor evidence references');
  }
  if (value.lifecycleStatus === 'baseline_ready') {
    addFinding(findings, 'baseline_ready_not_granted', 'error', 'the evaluator never grants baseline_ready; the lead records that decision outside this manifest after review');
  }
}

// ---------------------------------------------------------------------------
// Cross-joins (require corpus + observations + corpus sha256)
// ---------------------------------------------------------------------------

function crossJoin(observations, cases, corpus, corpusSha256, findings) {
  const corpusRevision = isPlainObject(corpus) && isNonNegativeSafeInteger(corpus.revision) ? corpus.revision : null;
  const digestProvided = isString(corpusSha256) && SHA256_RE.test(corpusSha256);
  for (const obs of observations) {
    const refs = {
      observationId: isString(obs.observationId) ? obs.observationId : null,
      caseId: isString(obs.caseId) ? obs.caseId : null,
    };
    if (isString(obs.caseId) && !cases.has(obs.caseId)) {
      addFinding(findings, 'observation_unknown_case_id', 'error', `observation references unknown caseId "${obs.caseId}"`, refs);
    }
    if (corpusRevision !== null && isNonNegativeSafeInteger(obs.corpusRevision) && obs.corpusRevision !== corpusRevision) {
      addFinding(findings, 'observation_corpus_revision_mismatch', 'error', `observation corpusRevision ${obs.corpusRevision} does not match corpus revision ${corpusRevision}`, refs);
    }
    if (digestProvided && isString(obs.corpusDigest) && SHA256_RE.test(obs.corpusDigest) && obs.corpusDigest !== corpusSha256) {
      addFinding(findings, 'observation_corpus_digest_mismatch', 'error', 'observation corpusDigest does not match the supplied corpus sha256 (cross-run join)', refs);
    }
    const caseObj = isString(obs.caseId) ? cases.get(obs.caseId) : undefined;
    if (caseObj && isString(caseObj.evaluationMode) && isString(obs.mode) && obs.mode !== caseObj.evaluationMode) {
      addFinding(findings, 'observation_mode_mismatch', 'error', `observation mode "${obs.mode}" does not match case evaluationMode "${caseObj.evaluationMode}"`, refs);
    }
    if (caseObj && isString(caseObj.sourceSnapshot) && isString(obs.targetSourceSnapshot)
      && caseObj.sourceSnapshot !== obs.targetSourceSnapshot) {
      addFinding(findings, 'observation_source_snapshot_mismatch', 'error', 'observation targetSourceSnapshot does not equal the frozen case sourceSnapshot', refs);
    }
  }
}

function checkCaseCoverage(cases, observations, baseline, findings) {
  const observed = new Set();
  for (const obs of observations) {
    if (isString(obs.caseId)) observed.add(obs.caseId);
  }
  for (const caseId of cases.keys()) {
    if (!observed.has(caseId)) {
      addFinding(findings, 'case_missing_observation', 'error', `corpus case "${caseId}" has no observation`, { caseId });
    } else if (observations.filter((obs) => isPlainObject(obs) && obs.caseId === caseId).every((obs) => obs.actualResult === 'not_run')) {
      addFinding(findings, 'case_only_not_run', 'error', `corpus case "${caseId}" has only not_run observations`, { caseId });
    }
  }
  if (!isPlainObject(baseline) || !Array.isArray(baseline.caseObservations)) return;
  const baselineCases = new Map();
  for (const entry of baseline.caseObservations) {
    if (!isPlainObject(entry) || !isString(entry.caseId) || !Array.isArray(entry.observationIds)) continue;
    baselineCases.set(entry.caseId, entry.observationIds);
  }
  for (const caseId of cases.keys()) {
    if (!baselineCases.has(caseId)) addFinding(findings, 'baseline_case_missing', 'error', `baseline has no observation references for case "${caseId}"`, { caseId });
  }
  for (const caseId of baselineCases.keys()) {
    if (!cases.has(caseId)) addFinding(findings, 'baseline_unknown_case', 'error', `baseline references unknown case "${caseId}"`, { caseId });
  }
  const observationById = new Map(observations.filter((obs) => isPlainObject(obs) && isString(obs.observationId)).map((obs) => [obs.observationId, obs]));
  const referenced = new Set();
  for (const [caseId, ids] of baselineCases) {
    for (const id of ids) {
      if (referenced.has(id)) addFinding(findings, 'baseline_duplicate_observation_reference', 'error', `baseline observation "${id}" is referenced more than once`, { caseId });
      referenced.add(id);
      const obs = observationById.get(id);
      if (!obs) addFinding(findings, 'baseline_unknown_observation', 'error', `baseline references unknown observation "${id}"`, { caseId });
      else if (isString(obs.caseId) && obs.caseId !== caseId) addFinding(findings, 'baseline_wrong_case_observation', 'error', `baseline observation "${id}" belongs to case "${obs.caseId}", not "${caseId}"`, { caseId, observationId: id });
      else if (isPlainObject(baseline.configDigests) && isPlainObject(obs.configDigests)
        && CONFIG_DIGEST_FIELDS.some((field) => baseline.configDigests[field] !== obs.configDigests[field])) {
        addFinding(findings, 'baseline_observation_config_mismatch', 'error', `observation "${id}" configDigests do not match baseline configuration`, { caseId, observationId: id });
      }
    }
  }
  for (const id of observationById.keys()) {
    if (!referenced.has(id)) addFinding(findings, 'baseline_unreferenced_observation', 'error', `observation "${id}" is not referenced by baseline`);
  }
}

function crossCheckBaseline(baseline, corpus, corpusSha256, findings) {
  if (!isPlainObject(baseline) || !isPlainObject(corpus)) return;
  if (isNonEmptyString(baseline.corpusId) && isNonEmptyString(corpus.corpusId) && baseline.corpusId !== corpus.corpusId) {
    addFinding(findings, 'baseline_corpus_id_mismatch', 'error', `baseline corpusId "${baseline.corpusId}" does not match corpus corpusId "${corpus.corpusId}"`);
  }
  if (isString(corpusSha256) && SHA256_RE.test(corpusSha256)
    && isString(baseline.corpusDigest) && SHA256_RE.test(baseline.corpusDigest)
    && baseline.corpusDigest !== corpusSha256) {
    addFinding(findings, 'baseline_corpus_digest_mismatch', 'error', 'baseline corpusDigest does not match the supplied corpus sha256');
  }
  if (!isString(corpusSha256) || !SHA256_RE.test(corpusSha256)) {
    addFinding(findings, 'corpus_snapshot_unverified', 'error', 'a verified raw-byte corpus sha256 is required');
  }
  if (isPlainObject(baseline) && isPlainObject(corpus) && Array.isArray(corpus.cases)) {
    const harnessSnapshots = new Set(corpus.cases.filter((item) => isPlainObject(item) && item.targetSystem === 'harness').map((item) => item.sourceSnapshot));
    if (harnessSnapshots.size > 0 && (!harnessSnapshots.has(baseline.targetSourceSnapshot))) {
      addFinding(findings, 'baseline_target_snapshot_mismatch', 'error', 'baseline targetSourceSnapshot does not match a frozen harness case snapshot');
    }
  }
}

function crossCheckMetricCoverage(baseline, observations, findings) {
  if (!isPlainObject(baseline) || !Array.isArray(baseline.metricAvailabilityCoverage)) return;
  const observed = new Map();
  for (const item of observations) {
    if (!isPlainObject(item) || !Array.isArray(item.metrics)) continue;
    for (const metric of item.metrics) {
      if (!isPlainObject(metric) || !METRIC_IDS.includes(metric.metricId)) continue;
      if (!observed.has(metric.metricId)) observed.set(metric.metricId, []);
      observed.get(metric.metricId).push(metric);
    }
  }
  for (const coverage of baseline.metricAvailabilityCoverage) {
    if (!isPlainObject(coverage) || !METRIC_IDS.includes(coverage.metricId)) continue;
    const metrics = observed.get(coverage.metricId) || [];
    const available = metrics.filter((metric) => metric.value !== null);
    if (coverage.availability === 'unavailable' && available.length > 0) {
      addFinding(findings, 'baseline_metric_coverage_mismatch', 'error', `baseline declares ${coverage.metricId} unavailable but observations contain a value`, { metricId: coverage.metricId });
    } else if (coverage.availability !== 'unavailable' && available.length === 0) {
      addFinding(findings, 'baseline_metric_coverage_mismatch', 'error', `baseline declares ${coverage.metricId} available but observations contain no value`, { metricId: coverage.metricId });
    }
    if (coverage.availability !== 'unavailable' && available.some((metric) => metric.availability !== coverage.availability)) {
      addFinding(findings, 'baseline_metric_coverage_mismatch', 'error', `baseline ${coverage.metricId} availability does not match its observation metrics`, { metricId: coverage.metricId });
    }
  }
}

// ---------------------------------------------------------------------------
// Summary + eligibility
// ---------------------------------------------------------------------------

function computeSummary(observations, listValid) {
  const summary = {
    acceptedResults: null,
    passedCount: 0,
    failedCount: 0,
    notRunCount: 0,
    inconclusiveCount: 0,
    notSupportedCount: 0,
    requirementPreservation: null,
    firstPassAcceptedCheckpoints: null,
    measuredCostPerAcceptedResult: null,
  };
  let reqNumerator = 0;
  let reqDenominator = 0;
  let reqSeen = false;
  let reqSourceRef = null;
  let reqConflict = false;
  const reqClaims = new Map();

  for (const obs of observations) {
    if (obs.actualResult === 'pass') {
      summary.passedCount += 1;
    } else if (obs.actualResult === 'fail') {
      summary.failedCount += 1;
    } else if (obs.actualResult === 'not_run') {
      summary.notRunCount += 1;
    } else if (obs.actualResult === 'inconclusive') {
      summary.inconclusiveCount += 1;
    } else if (obs.actualResult === 'not_supported') {
      summary.notSupportedCount += 1;
    }

    if (Array.isArray(obs.metrics)) {
      for (const metric of obs.metrics) {
        if (!isPlainObject(metric)) continue;
        if (metric.metricId === 'requirement_preservation' && obs.dataOrigin === 'real'
          && obs.mode === 'artifact_assessment' && metric.availability === 'measured'
          && isNumber(metric.value) && isNonNegativeSafeInteger(metric.numerator)
          && isNonNegativeSafeInteger(metric.denominator)) {
          if (reqSourceRef !== null && reqSourceRef !== metric.sourceRef) {
            reqConflict = true;
            continue;
          }
          const claim = [metric.numerator, metric.denominator, metric.value];
          const prior = reqClaims.get(metric.sourceRef);
          if (prior && prior.some((value, index) => value !== claim[index])) {
            reqConflict = true;
            continue;
          }
          if (prior) continue;
          reqClaims.set(metric.sourceRef, claim);
          reqSourceRef = metric.sourceRef;
          reqNumerator = metric.numerator;
          reqDenominator = metric.denominator;
          reqSeen = true;
        }
      }
    }
  }

  if (!listValid) return summary;

  if (!reqConflict && reqSeen && reqDenominator > 0) {
    summary.requirementPreservation = { numerator: reqNumerator, denominator: reqDenominator, value: reqNumerator / reqDenominator };
  }
  // First-pass acceptance requires current-target checkpoint evidence that this
  // offline evaluator does not collect.
  return summary;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function validateCorpus(value) {
  const findings = [];
  validateCorpusInternal(value, findings);
  const errors = findings.filter((f) => f.severity === 'error').map((f) => f.message);
  const ok = errors.length === 0;
  return ok ? { ok: true, errors: [], value } : { ok: false, errors };
}

function validateObservations(value) {
  const findings = [];
  validateObservationsInternal(value, findings);
  const errors = findings.filter((f) => f.severity === 'error').map((f) => f.message);
  const ok = errors.length === 0;
  return ok ? { ok: true, errors: [], value } : { ok: false, errors };
}

function validateBaseline(value) {
  const findings = [];
  validateBaselineInternal(value, findings);
  const errors = findings.filter((f) => f.severity === 'error').map((f) => f.message);
  const ok = errors.length === 0;
  return ok ? { ok: true, errors: [], value } : { ok: false, errors };
}

function verifyArtifactClaims({ corpus, observations, baseline, verifiedArtifacts }, findings) {
  const verified = isPlainObject(verifiedArtifacts) ? verifiedArtifacts : null;
  if (!verified) {
    addFinding(findings, 'artifact_snapshot_unverified', 'error', 'verified local artifact metadata from the CLI is required');
    return;
  }
  const claims = [];
  const addClaims = (list, label) => {
    if (Array.isArray(list)) list.forEach((ref, i) => {
      if (isPlainObject(ref) && isString(ref.path) && isString(ref.sha256)) claims.push({ ...ref, label: `${label}[${i}]` });
    });
  };
  if (isPlainObject(corpus) && Array.isArray(corpus.cases)) {
    corpus.cases.forEach((item, i) => {
      if (!isPlainObject(item)) return;
      addClaims(item.canonicalInputs, `corpus.cases[${i}].canonicalInputs`);
      addClaims(item.inputArtifacts, `corpus.cases[${i}].inputArtifacts`);
      addClaims(item.expectedOutcomeArtifacts, `corpus.cases[${i}].expectedOutcomeArtifacts`);
    });
  }
  if (isPlainObject(observations) && Array.isArray(observations.observations)) {
    observations.observations.forEach((item, i) => {
      if (isPlainObject(item)) addClaims(item.evidenceArtifacts, `observations[${i}].evidenceArtifacts`);
    });
  }
  if (isPlainObject(baseline)) {
    addClaims(baseline.sourceOutputDigests, 'baseline.sourceOutputDigests');
    addClaims(baseline.verificationEvidence, 'baseline.verificationEvidence');
    addClaims(baseline.auditEvidence, 'baseline.auditEvidence');
  }
  for (const claim of claims) {
    const actual = verified[claim.path];
    if (!isString(actual)) addFinding(findings, 'artifact_reference_unverified', 'error', `${claim.label} references unavailable local artifact "${claim.path}"`);
    else if (actual !== claim.sha256) addFinding(findings, 'artifact_digest_mismatch', 'error', `${claim.label} digest does not match local artifact "${claim.path}"`);
  }
}

function verifyRequirementAssessmentClaims(observations, verifiedArtifacts, verifiedRequirementAssessments, findings) {
  const assessments = isPlainObject(verifiedRequirementAssessments) ? verifiedRequirementAssessments : {};
  const verified = isPlainObject(verifiedArtifacts) ? verifiedArtifacts : {};
  if (!Array.isArray(observations)) return;
  const claimsBySource = new Map();
  for (const obs of observations) {
    if (!isPlainObject(obs) || !Array.isArray(obs.metrics)) continue;
    for (const metric of obs.metrics) {
      if (!isPlainObject(metric) || metric.metricId !== 'requirement_preservation' || metric.value === null) continue;
      const assessment = assessments[metric.sourceRef];
      const artifactDigest = verified[metric.sourceRef];
      const matches = isPlainObject(assessment)
        && assessment.sha256 === artifactDigest
        && isString(assessment.inventoryPath)
        && assessment.inventorySha256 === verified[assessment.inventoryPath]
        && assessment.verdict === 'approve'
        && isNonNegativeSafeInteger(assessment.semanticRequirementCount)
        && assessment.semanticRequirementCount > 0
        && assessment.semanticRequirementsSatisfied === metric.numerator
        && assessment.numerator === metric.numerator
        && assessment.denominator === metric.denominator
        && assessment.excludedIncompleteCount === metric.excludedIncompleteCount
        && assessment.value === metric.value;
      if (!matches) {
        addFinding(findings, 'metric_assessment_unverified', 'error', 'requirement_preservation must match an independently approved, locally verified reviewer-assessment artifact', {
          observationId: obs.observationId,
          caseId: obs.caseId,
          metricId: metric.metricId,
        });
      } else {
        const claim = [metric.numerator, metric.denominator, metric.excludedIncompleteCount, metric.value];
        const prior = claimsBySource.get(metric.sourceRef);
        if (prior && prior.some((value, index) => value !== claim[index])) {
          addFinding(findings, 'metric_assessment_conflict', 'error', 'one reviewer-assessment artifact has contradictory requirement_preservation values', {
            observationId: obs.observationId,
            caseId: obs.caseId,
            metricId: metric.metricId,
          });
        } else {
          claimsBySource.set(metric.sourceRef, claim);
        }
      }
    }
  }
  if (claimsBySource.size > 1) {
    addFinding(findings, 'metric_assessment_cohorts_ambiguous', 'error', 'multiple distinct reviewer-assessment artifacts require an explicit compatible inventory before aggregation');
  }
}

function evaluate({ corpus, observations, baseline, corpusSha256, verifiedArtifacts, verifiedRequirementAssessments } = {}) {
  const findings = [];
  const cases = validateCorpusInternal(corpus, findings);
  const observationList = validateObservationsInternal(observations, findings);
  validateBaselineInternal(baseline, findings);

  crossJoin(observationList, cases, corpus, corpusSha256, findings);
  checkCaseCoverage(cases, observationList, baseline, findings);
  crossCheckBaseline(baseline, corpus, corpusSha256, findings);
  crossCheckMetricCoverage(baseline, observationList, findings);
  verifyArtifactClaims({ corpus, observations, baseline, verifiedArtifacts }, findings);
  verifyRequirementAssessmentClaims(observationList, verifiedArtifacts, verifiedRequirementAssessments, findings);

  // Completeness notes: which of the 9 stable metrics have no observation coverage.
  const covered = new Set();
  for (const obs of observationList) {
    if (Array.isArray(obs.metrics)) {
      for (const metric of obs.metrics) {
        if (isPlainObject(metric) && isString(metric.metricId)) covered.add(metric.metricId);
      }
    }
  }
  for (const metricId of METRIC_IDS) {
    if (!covered.has(metricId)) {
      addFinding(findings, 'metric_not_covered', 'info', `metric "${metricId}" is not covered by any observation`);
    }
  }

  const corpusIsObject = isPlainObject(corpus);
  const corpusListValid = corpusIsObject && Array.isArray(corpus.cases);
  const observationListValid = isPlainObject(observations) && Array.isArray(observations.observations);

  const caseCount = corpusListValid ? corpus.cases.length : 0;
  const observationCount = observationListValid ? observations.observations.length : 0;

  const hasErrors = findings.some((f) => f.severity === 'error');
  const valid = !hasErrors;

  const everyCaseObserved = [...cases.keys()].every((caseId) =>
    observationList.some((obs) => isString(obs.caseId) && obs.caseId === caseId));
  const assessed = valid && everyCaseObserved && !hasErrors
    && findingCodesAbsent(findings, ['artifact_reference_unverified', 'artifact_digest_mismatch', 'artifact_snapshot_unverified'])
    && observationList.every((obs) => obs.dataOrigin === 'real');

  const limitations = [
    `${EVALUATION_SCOPE} scope: no live model execution, measured spend, or token capture; measured_cost_per_accepted_result is always null`,
    'eligibility.ready is always false; only the lead records baseline_ready after independent verification and audit',
  ];
  const illustrativeCount = observationList.filter((obs) => obs.dataOrigin === 'illustrative').length;
  if (illustrativeCount > 0) {
    limitations.push(`observations carry dataOrigin "illustrative" (${illustrativeCount}); they exercise the schema shape but are not real captures`);
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluatorVersion: VERSION,
    baselineId: isPlainObject(baseline) && isNonEmptyString(baseline.baselineId) ? baseline.baselineId : null,
    corpusId: corpusIsObject && isNonEmptyString(corpus.corpusId) ? corpus.corpusId : null,
    corpusDigest: corpusSha256 != null ? corpusSha256 : null,
    valid,
    caseCount,
    observationCount,
    findings,
    summary: computeSummary(observationList, assessed),
    eligibility: {
      scope: EVALUATION_SCOPE,
      assessed,
      ready: false,
      limitations,
    },
  };
}

function findingCodesAbsent(findings, codes) {
  const found = new Set(findings.map((finding) => finding.code));
  return codes.every((code) => !found.has(code));
}

module.exports = {
  VERSION,
  METRIC_DEFINITIONS_VERSION,
  METRIC_IDS,
  CORPUS_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  BASELINE_SCHEMA_VERSION,
  validateCorpus,
  validateObservations,
  validateBaseline,
  evaluate,
};
