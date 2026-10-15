'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  VERSION,
  METRIC_IDS,
  validateCorpus,
  validateObservations,
  validateBaseline,
  evaluate: evaluatePure,
} = require('../src/autonomy-evaluation');

const ROOT = path.join(__dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'test/fixtures/autonomy/corpus-v3/corpus.json');
const OBS_PATH = path.join(ROOT, 'test/fixtures/autonomy/corpus-v3/observations.json');
const BASELINE_PATH = path.join(ROOT, 'test/fixtures/autonomy/corpus-v3/baseline.json');

function verifiedArtifacts() {
  const { corpus, observations, baseline } = fixtures();
  const paths = new Set(baseline.sourceOutputDigests.map((item) => item.path));
  for (const item of corpus.cases) for (const field of ['canonicalInputs', 'inputArtifacts', 'expectedOutcomeArtifacts']) {
    for (const ref of item[field]) paths.add(ref.path);
  }
  for (const item of observations.observations) for (const ref of item.evidenceArtifacts) paths.add(ref.path);
  const out = {};
  for (const item of [...paths]) out[item] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, item))).digest('hex');
  return out;
}

function verifiedRequirementAssessments() {
  const { observations } = fixtures();
  const output = {};
  for (const observation of observations.observations) {
    for (const metric of observation.metrics) {
      if (metric.metricId !== 'requirement_preservation' || metric.value === null) continue;
      const artifactPath = path.join(ROOT, metric.sourceRef);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      const review = artifact.independentReview;
      const scoring = artifact.scoring;
      output[metric.sourceRef] = {
        sha256: crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex'),
        inventoryPath: review.inventoryPath,
        inventorySha256: review.inventorySha256,
        verdict: review.verdict,
        semanticRequirementCount: review.semanticRequirementCount,
        semanticRequirementsSatisfied: review.semanticRequirementsSatisfied,
        numerator: scoring.numerator,
        denominator: scoring.denominator,
        excludedIncompleteCount: scoring.excludedIncompleteCount,
        value: scoring.value,
      };
    }
  }
  return output;
}

function fixtureEvaluate(input = {}) {
  return evaluatePure({ ...input, verifiedArtifacts: verifiedArtifacts(), verifiedRequirementAssessments: verifiedRequirementAssessments() });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function corpusSha256() {
  return crypto.createHash('sha256').update(fs.readFileSync(CORPUS_PATH)).digest('hex');
}

function fixtures() {
  return {
    corpus: readJson(CORPUS_PATH),
    observations: readJson(OBS_PATH),
    baseline: readJson(BASELINE_PATH),
    corpusSha256: corpusSha256(),
  };
}

function measuredRequirementMetric(observations) {
  const observation = observations.observations.find((item) => item.caseId === 'aut-01-planning-baseline');
  const metric = observation.metrics.find((item) => item.metricId === 'requirement_preservation');
  Object.assign(metric, { value: 0, availability: 'measured', missingReason: null, numerator: 0, denominator: 5, excludedIncompleteCount: 0 });
  return metric;
}

// Runs evaluate() and returns the list of error-severity finding codes.
function errorCodes(report) {
  return report.findings.filter((f) => f.severity === 'error').map((f) => f.code);
}

test('exports the stable contract surface', () => {
  assert.equal(typeof VERSION, 'string');
  assert.ok(VERSION.length > 0);
  assert.equal(METRIC_IDS.length, 9);
  assert.deepEqual(METRIC_IDS, [
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
});

test('standalone validators accept the fixture trio', () => {
  const { corpus, observations, baseline } = fixtures();
  assert.deepEqual(validateCorpus(corpus), { ok: true, errors: [], value: corpus });
  assert.equal(validateObservations(observations).ok, true);
  assert.equal(validateBaseline(baseline).ok, true);
});

test('validators never throw and return {ok, errors} for bad input', () => {
  assert.equal(validateCorpus(null).ok, false);
  assert.ok(Array.isArray(validateCorpus(null).errors));
  assert.equal(validateObservations(42).ok, false);
  assert.equal(validateBaseline('nope').ok, false);
  assert.equal(fixtureEvaluate({ corpus: null }).valid, false);
  assert.equal(fixtureEvaluate({}).valid, false);
  assert.equal(fixtureEvaluate().valid, false);
});

test('positive: evaluate() verifies the corrected cohort while leaving unsupported metrics unavailable', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });

  assert.equal(report.schemaVersion, 'autonomy-evaluation/v1');
  assert.equal(report.evaluatorVersion, VERSION);
  assert.equal(report.valid, true);
  assert.equal(report.caseCount, 7);
  assert.equal(report.observationCount, 7);
  assert.equal(report.corpusId, 'aut-05-regression-corpus-v3');
  assert.equal(report.baselineId, 'aut-05-baseline-offline-v3');
  assert.equal(report.corpusDigest, corpusSha256);

  assert.equal(errorCodes(report).length, 0);
  assert.equal(report.summary.passedCount, 4);
  assert.equal(report.summary.failedCount, 2);
  assert.equal(report.summary.inconclusiveCount, 1);
  assert.equal(report.summary.notRunCount, 0);
  assert.equal(report.summary.notSupportedCount, 0);
  assert.equal(report.summary.acceptedResults, null);
  assert.deepEqual(report.summary.requirementPreservation, { numerator: 5, denominator: 5, value: 1 });
  assert.equal(report.summary.firstPassAcceptedCheckpoints, null);
  assert.equal(report.summary.measuredCostPerAcceptedResult, null);

  assert.equal(report.eligibility.scope, 'offline_contract_and_artifact');
  assert.equal(report.eligibility.assessed, true);
  assert.equal(report.eligibility.ready, false);
  assert.ok(report.eligibility.limitations.length > 0);
});

test('acceptedResults stays unavailable for oracle passes without current-target receipts', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].actualResult = 'pass';
  observations.observations[0].checks = [{ checkId: 'deterministic-check', result: 'passed', detail: 'oracle check' }];
  assert.equal(fixtureEvaluate({ corpus, observations, baseline, corpusSha256 }).summary.acceptedResults, null);

  const illustrative = clone(observations);
  illustrative.observations[6].dataOrigin = 'illustrative'; // planning-baseline "pass"
  const report = fixtureEvaluate({ corpus, observations: illustrative, baseline, corpusSha256 });
  assert.equal(report.valid, true);
  assert.equal(report.eligibility.assessed, false);
  assert.equal(report.summary.passedCount, 5);
  assert.equal(report.summary.requirementPreservation, null);
  assert.equal(report.summary.acceptedResults, null);
});

test('requirement-preservation score must match its pinned independent assessment', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[6].metrics[0].numerator = 4;
  observations.observations[6].metrics[0].value = 0.8;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_assessment_unverified'));
});

test('requirement-preservation cannot be measured without verified assessment metadata', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  const report = evaluatePure({ corpus, observations, baseline, corpusSha256, verifiedArtifacts: verifiedArtifacts() });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_assessment_unverified'));
});

test('rejects a pass observation with a failed check (contradiction)', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  const bad = clone(observations);
  bad.observations[6].actualResult = 'pass';
  bad.observations[6].checks[0].result = 'failed';
  const report = fixtureEvaluate({ corpus, observations: bad, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_pass_with_incomplete_check'));
});

test('rejects duplicate observationId', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  const dup = clone(observations.observations[0]);
  observations.observations.push(dup);
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_duplicate_observation_id'));
});

test('rejects unknown caseId', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].caseId = 'nonexistent-case';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_unknown_case_id'));
});

test('rejects wrong corpusDigest (cross-run join)', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].corpusDigest = '0'.repeat(64);
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_corpus_digest_mismatch'));
});

test('rejects corpusRevision mismatch', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].corpusRevision = 5;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_corpus_revision_mismatch'));
});

test('rejects observation mode mismatch against case evaluationMode', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].mode = 'artifact_assessment';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_mode_mismatch'));
});

test('rejects an observation source-snapshot mismatch', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].targetSourceSnapshot = 'different source snapshot label';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.code === 'observation_source_snapshot_mismatch' && f.severity === 'error'));
});

test('rejects identity null without a reason', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  // obs[4] (positive control) has checkpointId populated and identityNullReasons.checkpointId null.
  observations.observations[4].checkpointId = null;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_identity_reason_mismatch'));
});

test('rejects identity populated with a non-null reason', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[4].identityNullReasons.checkpointId = 'should be null while checkpointId is populated';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_identity_reason_mismatch'));
});

test('rejects null metric value with null missingReason', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  // obs[0].metrics[0] is tokens with value null.
  observations.observations[0].metrics[0].missingReason = null;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_null_missing_reason'));
});

test('rejects ratio with denominator 0', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  measuredRequirementMetric(observations).denominator = 0;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_invalid_denominator'));
});

test('rejects ratio whose value != numerator/denominator', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  measuredRequirementMetric(observations).value = 0.4;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_ratio_mismatch'));
});

test('rejects non-null value with availability "unavailable"', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  measuredRequirementMetric(observations).availability = 'unavailable';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_value_availability_conflict'));
});

test('rejects wrong metric unit', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  // requirement_preservation must use unit "ratio".
  observations.observations[6].metrics[0].unit = 'count';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_invalid_unit'));
});

test('rejects a boolean where a number is required (no coercion)', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].metrics[0].value = true;
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_value_type'));
});

test('rejects a null nested metric without throwing', () => {
  const input = fixtures();
  input.observations.observations[0].metrics = [null];
  const report = fixtureEvaluate(input);
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('metric_fields'));
});

test('requires the raw corpus snapshot digest', () => {
  const { corpus, observations, baseline } = fixtures();
  const report = fixtureEvaluate({ corpus, observations, baseline });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('corpus_snapshot_unverified'));
});

test('rejects unsupported evaluator and metric-definition versions', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  baseline.evaluatorVersion = 'arbitrary-version';
  baseline.metricDefinitionsVersion = 'arbitrary-metrics';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('baseline_evaluator_version'));
  assert.ok(errorCodes(report).includes('baseline_metric_definitions_version'));
});

test('rejects empty or mismatched baseline observation joins', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  baseline.caseObservations = [];
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('baseline_case_missing'));
});

test('baseline pins the evaluator, CLI, schemas, and metric definitions', () => {
  const { baseline } = fixtures();
  baseline.sourceOutputDigests = baseline.sourceOutputDigests.filter((item) => item.path !== 'tools/autonomy/evaluate.js');
  assert.ok(validateBaseline(baseline).errors.some((message) => message.includes('tools/autonomy/evaluate.js')));
});

test('rejects duplicate and wrong-case baseline observation references', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  baseline.caseObservations[0].observationIds.push(baseline.caseObservations[0].observationIds[0]);
  const duplicate = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.ok(errorCodes(duplicate).includes('baseline_case_observations'));

  const wrongCase = fixtures();
  wrongCase.baseline.caseObservations[0].observationIds = ['obs-aut-01-planning-baseline'];
  const mismatch = fixtureEvaluate(wrongCase);
  assert.ok(errorCodes(mismatch).includes('baseline_wrong_case_observation'));
});

test('never accepts baseline_ready inside an input manifest', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  baseline.lifecycleStatus = 'baseline_ready';
  baseline.verificationEvidence = [{ path: 'test/fixtures/autonomy/corpus-v3/README.md', sha256: '0'.repeat(64) }];
  baseline.auditEvidence = [{ path: 'test/fixtures/autonomy/corpus-v3/README.md', sha256: '0'.repeat(64) }];
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('baseline_ready_not_granted'));
});

test('rejects a corpus with no required family and a case with only not_run observations', () => {
  const missingFamily = fixtures();
  missingFamily.corpus.cases.pop();
  assert.ok(errorCodes(fixtureEvaluate(missingFamily)).includes('corpus_required_family_missing'));

  const notRun = fixtures();
  notRun.observations.observations[0].actualResult = 'not_run';
  notRun.observations.observations[0].checks = [{ checkId: 'still-not-run', result: 'not_run', detail: 'not executed' }];
  assert.ok(errorCodes(fixtureEvaluate(notRun)).includes('case_only_not_run'));
});

test('rejects duplicate metric IDs and unavailable pass checks', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  const dup = clone(observations);
  dup.observations[0].metrics.push(clone(dup.observations[0].metrics[0]));
  assert.ok(errorCodes(fixtureEvaluate({ corpus, observations: dup, baseline, corpusSha256 })).includes('observation_duplicate_metric_id'));

  const notRunPass = clone(observations);
  notRunPass.observations[0].actualResult = 'pass';
  notRunPass.observations[0].checks = [{ checkId: 'not-run', result: 'not_run', detail: 'not executed' }];
  assert.ok(errorCodes(fixtureEvaluate({ corpus, observations: notRunPass, baseline, corpusSha256 })).includes('observation_pass_with_incomplete_check'));
});

test('candidate references may be reused across observations', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].candidateId = 'shared-candidate';
  observations.observations[1].candidateId = 'shared-candidate';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.ok(!errorCodes(report).includes('observation_duplicate_candidate_id'));
});

test('rejects a string "5" for an integer field (no coercion)', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  observations.observations[0].corpusRevision = '5';
  const report = fixtureEvaluate({ corpus, observations, baseline, corpusSha256 });
  assert.equal(report.valid, false);
  assert.ok(errorCodes(report).includes('observation_corpus_revision_type'));
});

test('rejects negative revisions and non-date-time timestamps to match the schemas', () => {
  const { corpus, observations } = fixtures();
  const badCorpus = clone(corpus);
  badCorpus.revision = -1;
  badCorpus.cases[0].revision = -1;
  assert.ok(validateCorpus(badCorpus).errors.some((message) => message.includes('corpus revision')));
  assert.ok(validateCorpus(badCorpus).errors.some((message) => message.includes('cases[0].revision')));

  const badObservations = clone(observations);
  badObservations.observations[0].corpusRevision = -1;
  badObservations.observations[0].evaluatedAt = 'yesterday';
  badObservations.observations[0].measurementInterval.start = 'tomorrow';
  const errors = validateObservations(badObservations).errors;
  assert.ok(errors.some((message) => message.includes('corpusRevision')));
  assert.ok(errors.some((message) => message.includes('RFC 3339')));
});

test('malformed metric identifiers and case identifiers return findings without throwing', () => {
  const { corpus, observations, baseline, corpusSha256 } = fixtures();
  const badMetric = clone(observations);
  badMetric.observations[0].metrics[0].metricId = { toString: null, valueOf: null };
  assert.equal(fixtureEvaluate({ corpus, observations: badMetric, baseline, corpusSha256 }).valid, false);

  const badCase = clone(observations);
  badCase.observations[0].caseId = { toString: null, valueOf: null };
  assert.equal(fixtureEvaluate({ corpus, observations: badCase, baseline, corpusSha256 }).valid, false);
});
