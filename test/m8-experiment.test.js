'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redactDiagnosticMessage } = require('../src/event-journal');
const { buildSanitizedTrace } = require('../src/m8/trace');
const {
  InProcessReceiver, ThrowingReceiver, exportTraces, resolveLiveExport,
} = require('../src/m8/exporter');
const { withIsolatedWorkspace, comparePrompts } = require('../src/m8/compare');
const {
  loadInputs, deriveAdoptDefer, completeDelivery, runExperiment,
} = require('../src/m8/experiment');

const ROOT = path.join(__dirname, '..');
const SECRETS = ['fixture-token-value', 'sk-fixturekey1234', 's3cret-pass', 'token=abc', 'user:s3cret-pass'];

const PINNED_SCORES = {
  evaluation: {
    protocol: 'm8-runtime-contract-v1',
    modelRun: false,
    promptRun: false,
    promptComparison: {
      status: 'not-evaluated',
      baselineVersion: 'baseline-v1',
      candidateVersion: 'candidate-v1',
    },
    limitation: 'Scores are observed from M8 application code execution. Prompt quality is unmeasured because no model-backed prompt execution is configured.',
  },
  runtimeContracts: {
    suiteVersion: 'm8-runtime-contract-v1',
    passed: 4,
    total: 4,
    cases: [
      { id: 'case-trace-sanitization', passed: true, observed: { correlationMatchesFixture: true, containsSecret: false, redactionMarkers: 3 } },
      { id: 'case-export-correlation-feedback', passed: true, observed: { status: 'accepted', feedbackAccepted: true, correlationPreserved: true, feedbackAttached: true } },
      { id: 'case-manual-adoption-review', passed: true, observed: { adoptDefer: 'defer', productionAdoption: 'defer' } },
      { id: 'case-isolated-artifact', passed: true, observed: { artifactCreated: true, insideTemporaryWorkspace: true, contentsMatch: true, removedAfterRun: true } },
    ],
  },
};

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
}

test('redacts fixture free text and keeps correlation ids', () => {
  const { fixture } = loadInputs();
  const trace = buildSanitizedTrace(fixture);
  assert.equal(trace.correlation.ticketId, 'tkt_m8_001');
  assert.equal(trace.correlation.runId, 'run_m8_001');
  assert.equal(trace.correlation.attemptId, 'att_m8_001');
  assert.equal(trace.correlation.outcomeId, 'out_m8_001');
  assert.equal(trace.ticket.ticketId, fixture.ticket.ticketId);
  assert.equal(trace.run.runId, fixture.run.runId);
  assert.equal(trace.run.ticketId, fixture.ticket.ticketId);
  assert.equal(trace.attempt.attemptId, fixture.attempt.attemptId);
  assert.equal(trace.attempt.runId, fixture.run.runId);
  assert.equal(trace.outcome.outcomeId, fixture.outcome.outcomeId);
  assert.equal(trace.ticket.text, redactDiagnosticMessage(fixture.ticket.text));
  assert.equal(trace.attempt.output, redactDiagnosticMessage(fixture.attempt.output));
  assert.equal(trace.outcome.feedback, redactDiagnosticMessage(fixture.outcome.feedback));
  assert.equal(trace.ticket.title, redactDiagnosticMessage(fixture.ticket.title));
  assertNoSecrets(trace);
  assert.equal(JSON.stringify(trace).includes('Bearer [REDACTED]'), true);
  assert.equal(JSON.stringify(trace).includes('[REDACTED]'), true);
});

test('in-process receiver records correlation ids and feedback', () => {
  const { fixture } = loadInputs();
  const trace = buildSanitizedTrace(fixture);
  const receiver = new InProcessReceiver();
  const exported = exportTraces(receiver, [trace], {
    outcomeId: trace.correlation.outcomeId,
    status: trace.outcome.status,
    feedback: trace.outcome.feedback,
  });
  assert.equal(exported.status, 'accepted');
  assert.equal(exported.feedbackAccepted, true);
  assert.equal(receiver.runs.length, 1);
  assert.deepEqual(receiver.runs[0].correlationIds[0], {
    traceId: trace.traceId,
    ticketId: 'tkt_m8_001',
    runId: 'run_m8_001',
    attemptId: 'att_m8_001',
    outcomeId: 'out_m8_001',
  });
  assert.equal(receiver.feedback[0].runId, exported.runId);
  assert.equal(receiver.feedback[0].feedback.outcomeId, 'out_m8_001');
  assertNoSecrets(receiver.runs);
  assertNoSecrets(receiver.feedback);
});

test('export throw keeps local trace and scores and still succeeds', () => {
  const inputs = loadInputs();
  const evidence = { traces: [], scores: null };
  const result = completeDelivery({
    ...inputs,
    receiver: new ThrowingReceiver(),
    evidence,
  });
  assert.equal(result.success, true);
  assert.equal(result.exporterOutcome.status, 'failed');
  assert.equal(evidence.traces.length, 1);
  assert.equal(evidence.traces[0].traceId, result.traceId);
  assert.equal(evidence.traces[0].correlation.ticketId, 'tkt_m8_001');
  assert.deepEqual(evidence.scores, PINNED_SCORES);
  assertNoSecrets(evidence.traces);
});

test('runtime scores execute M8 code and do not claim prompt quality', () => {
  const inputs = loadInputs();
  const comparison = comparePrompts(inputs);
  assert.equal(comparison.ok, true);
  assert.equal(comparison.promoted, false);
  assert.equal(comparison.promptsCompared, false);
  assert.deepEqual(comparison.scores, PINNED_SCORES);
  assert.equal(comparison.scores.evaluation.modelRun, false);
  assert.equal(comparison.scores.evaluation.promptRun, false);
  assert.equal(comparison.scores.evaluation.promptComparison.status, 'not-evaluated');
  assert.match(comparison.scores.evaluation.limitation, /Prompt quality is unmeasured/);
  assert.equal(comparison.scores.runtimeContracts.passed, 4);
  assert.equal('baseline' in comparison.scores, false);
  assert.equal('candidate' in comparison.scores, false);
  assert.equal(inputs.dataset.protocol, 'm8-runtime-contract-v1');
  assert.equal('requiredPhrases' in inputs.dataset.cases[0], false);
});

test('prompt text changes cannot alter or improve runtime contract evidence', () => {
  const inputs = loadInputs();
  const changed = {
    ...inputs.candidate,
    text: 'Completely different text that was not executed.',
  };
  const comparison = comparePrompts({ ...inputs, candidate: changed });
  assert.equal(comparison.ok, true);
  assert.equal(comparison.promptsCompared, false);
  assert.deepEqual(comparison.scores.runtimeContracts, PINNED_SCORES.runtimeContracts);
});

test('file-writing cases use a temporary workspace and remove it', () => {
  const seen = [];
  withIsolatedWorkspace({ id: 'case-isolation', writesFiles: true }, (root) => {
    seen.push(root);
    assert.equal(root.startsWith(os.tmpdir()), true);
    assert.equal(fs.existsSync(path.join(root, 'case-isolation.txt')), false);
    fs.writeFileSync(path.join(root, 'case-isolation.txt'), 'artifact');
    assert.equal(fs.readFileSync(path.join(root, 'case-isolation.txt'), 'utf8'), 'artifact');
  });
  assert.equal(seen.length, 1);
  assert.equal(fs.existsSync(seen[0]), false);
});

test('MLflow Tracking REST rejection is a visible deferral', async () => {
  const { fixture } = loadInputs();
  const trace = buildSanitizedTrace(fixture);
  const requests = [];
  const live = await resolveLiveExport({
    M8_MLFLOW_TRACKING_URI: 'http://mlflow.invalid',
    M8_MLFLOW_EXPERIMENT_ID: '17',
  }, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 503 };
    },
  }, {
    trace,
    feedback: { outcomeId: trace.correlation.outcomeId, status: trace.outcome.status, feedback: trace.outcome.feedback },
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/2\.0\/mlflow\/runs\/create$/);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(live.status, 'deferred');
  assert.equal(live.reason, 'HTTP 503');
  assert.equal(live.attemptedConfiguration[0].step, 'mlflow-tracking-api');
  assert.equal(live.attemptedConfiguration[0].result, 'attempted');
  assert.equal(live.attemptedConfiguration[1].result, 'failed');
});

test('Tracking REST connection refusal defers without client module checks', async () => {
  const { fixture } = loadInputs();
  const trace = buildSanitizedTrace(fixture);
  const live = await resolveLiveExport({
    M8_MLFLOW_TRACKING_URI: 'http://mlflow.invalid',
    M8_MLFLOW_EXPERIMENT_ID: '17',
  }, {
    fetch: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); },
  }, {
    trace,
    feedback: { outcomeId: trace.correlation.outcomeId, status: trace.outcome.status, feedback: trace.outcome.feedback },
  });
  assert.equal(live.status, 'deferred');
  assert.equal(live.reason, 'MLflow export failed (ECONNREFUSED)');
  assert.equal(live.attemptedConfiguration.some((step) => step.step === 'mlflow-tracking-api' && step.result === 'failed'), true);
});

test('adopt/defer follows in-process success and live deferral', () => {
  const deferred = deriveAdoptDefer({
    inProcessStatus: 'accepted',
    comparisonOk: true,
    liveStatus: 'deferred',
  });
  assert.deepEqual(deferred, {
    localExperiment: 'success',
    productionAdoption: 'defer',
    adoptDefer: 'defer',
  });
  const failedExport = deriveAdoptDefer({
    inProcessStatus: 'failed',
    comparisonOk: true,
    liveStatus: 'accepted',
  });
  assert.equal(failedExport.localExperiment, 'failed');
  assert.equal(failedExport.adoptDefer, 'defer');
  const ready = deriveAdoptDefer({
    inProcessStatus: 'accepted',
    comparisonOk: true,
    liveStatus: 'accepted',
  });
  assert.equal(ready.adoptDefer, 'defer');
  assert.equal(ready.productionAdoption, 'defer');
});

async function runCommand() {
  const res = spawnSync(process.execPath, ['scripts/m8-experiment.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, M8_MLFLOW_TRACKING_URI: '', M8_MLFLOW_EXPERIMENT_ID: '' },
  });
  if (res.error && res.error.code === 'EPERM') return runExperiment({ env: {} });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('two experiment runs match with explicit MLflow REST deferral', async () => {
  const first = await runCommand();
  const second = await runCommand();
  assert.deepEqual(second.scores, first.scores);
  assert.equal(second.adoptDefer, first.adoptDefer);
  assert.deepEqual(first.scores, PINNED_SCORES);
  assert.equal(first.scores.evaluation.promptComparison.status, 'not-evaluated');
  assert.equal(first.command, 'node scripts/m8-experiment.js');
  assert.deepEqual(first.fixtureVersions, {
    trace: 'trace-v1',
    dataset: 'cases-v2',
    baselinePrompt: 'baseline-v1',
    candidatePrompt: 'candidate-v1',
  });
  assert.deepEqual(first.sanitizedTraceIds, [
    'trace:trace-v1:tkt_m8_001:run_m8_001:att_m8_001',
  ]);
  assert.equal(first.exporter.inProcess.status, 'accepted');
  assert.equal(typeof first.exporter.inProcess.runId, 'string');
  assert.equal(first.exporter.live.status, 'deferred');
  assert.equal(first.exporter.live.reason, 'tracking uri unset');
  assert.equal(first.exporter.live.attemptedConfiguration[0].step, 'skip-export');
  assert.equal(first.localExperiment, 'success');
  assert.equal(first.productionAdoption, 'defer');
  assert.equal(first.adoptDefer, 'defer');
  assert.equal(first.rolePromptRewrite, false);
  assert.match(first.distinction, /deferral of production adoption/);
  assert.match(first.distinction, /not a failure of the local experiment/);
  const derived = deriveAdoptDefer({
    inProcessStatus: first.exporter.inProcess.status,
    comparisonOk: true,
    liveStatus: first.exporter.live.status,
  });
  assert.equal(first.adoptDefer, derived.adoptDefer);
  assert.equal(first.localExperiment, derived.localExperiment);
  assert.equal(first.productionAdoption, derived.productionAdoption);
  assert.deepEqual(second.exporter, first.exporter);
  assertNoSecrets(first);
});

test('runExperiment matches the command result shape', async () => {
  const result = await runExperiment({ env: {} });
  assert.deepEqual(result.scores, PINNED_SCORES);
  assert.equal(result.adoptDefer, 'defer');
  assert.equal(result.localExperiment, 'success');
  assert.equal(result.exporter.inProcess.runId, 'in-process:trace:trace-v1:tkt_m8_001:run_m8_001:att_m8_001');
});
