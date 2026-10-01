'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSanitizedTrace } = require('./trace');
const { InProcessReceiver, exportTraces, resolveLiveExport } = require('./exporter');
const { comparePrompts, comparePromptsLive } = require('./compare');

const COMMAND = 'node scripts/m8-experiment.js';
const ROOT = path.join(__dirname, '..', '..');
const DISTINCTION = 'An unset MLflow tracking URI or experiment ID is a deferral of production adoption, not a failure of the local experiment.';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function loadInputs() {
  return {
    fixture: readJson('eval/m8/fixtures/trace-v1.json'),
    dataset: readJson('eval/m8/dataset/cases-v1.json'),
    baseline: {
      version: 'baseline-v1',
      text: fs.readFileSync(path.join(ROOT, 'eval/m8/prompts/baseline-v1.txt'), 'utf8'),
    },
    candidate: {
      version: 'candidate-v1',
      text: fs.readFileSync(path.join(ROOT, 'eval/m8/prompts/candidate-v1.txt'), 'utf8'),
    },
  };
}

function feedbackFromTrace(trace) {
  return {
    outcomeId: trace.correlation.outcomeId,
    status: trace.outcome.status,
    feedback: trace.outcome.feedback,
  };
}

function deriveAdoptDefer({ inProcessStatus, comparisonOk, liveStatus }) {
  const localExperiment = inProcessStatus === 'accepted' && comparisonOk === true ? 'success' : 'failed';
  // This experiment records evidence for review. It never promotes production automatically.
  const productionAdoption = 'defer';
  return {
    localExperiment,
    productionAdoption,
    adoptDefer: productionAdoption,
  };
}

// Delivery-shaped call. Local trace and scores are kept even when export throws.
function completeDelivery({ fixture, baseline, candidate, dataset, receiver, evidence }) {
  const trace = buildSanitizedTrace(fixture);
  const comparison = comparePrompts({ baseline, candidate, dataset });
  evidence.traces.push(trace);
  evidence.scores = comparison.scores;
  let exporterOutcome;
  try {
    exporterOutcome = exportTraces(receiver, [trace], feedbackFromTrace(trace));
  } catch (err) {
    exporterOutcome = { status: 'failed', message: err.message };
  }
  return { success: true, traceId: trace.traceId, exporterOutcome, comparisonOk: comparison.ok };
}

async function runExperiment(options = {}) {
  const inputs = options.inputs || loadInputs();
  const evidence = { traces: [], scores: null };
  const receiver = options.receiver || new InProcessReceiver();
  const delivery = completeDelivery({
    fixture: inputs.fixture,
    baseline: inputs.baseline,
    candidate: inputs.candidate,
    dataset: inputs.dataset,
    receiver,
    evidence,
  });
  const live = options.live || await resolveLiveExport(options.env || process.env, options.liveDeps || {}, {
    trace: evidence.traces[0],
    feedback: feedbackFromTrace(evidence.traces[0]),
  });
  const decision = deriveAdoptDefer({
    inProcessStatus: delivery.exporterOutcome.status,
    comparisonOk: delivery.comparisonOk,
    liveStatus: live.status,
  });
  return {
    command: COMMAND,
    fixtureVersions: {
      trace: inputs.fixture.version,
      dataset: inputs.dataset.version,
      baselinePrompt: inputs.baseline.version,
      candidatePrompt: inputs.candidate.version,
    },
    sanitizedTraceIds: evidence.traces.map((trace) => trace.traceId),
    scores: evidence.scores,
    exporter: {
      inProcess: delivery.exporterOutcome.status === 'accepted'
        ? { status: 'accepted', runId: delivery.exporterOutcome.runId }
        : { status: 'failed', message: delivery.exporterOutcome.message },
      live: {
        status: live.status,
        reason: live.reason,
        attemptedConfiguration: live.attemptedConfiguration,
      },
    },
    adoptDefer: decision.adoptDefer,
    localExperiment: decision.localExperiment,
    productionAdoption: decision.productionAdoption,
    distinction: DISTINCTION,
    rolePromptRewrite: false,
  };
}

async function runLiveExperiment(options = {}) {
  const inputs = options.inputs || loadInputs();
  const dataset = options.dataset || readJson('eval/m8/dataset/live-v1.json');
  const { CodexAppServer } = require('../codex-app-server');
  const client = options.client || new CodexAppServer({ turnTimeoutMs: 120_000 });
  try {
    return await comparePromptsLive({ ...inputs, dataset, runTurn: async (request) => {
      const result = await client.run({
        role: { name: 'm8-evaluator', model: request.model, effort: request.effort,
          sandbox: request.sandbox, instructions: request.instructions },
        cwd: request.cwd,
        input: request.input,
      });
      return { text: result.text };
    } });
  } finally {
    if (!options.client) await client.close();
  }
}

module.exports = {
  COMMAND,
  DISTINCTION,
  loadInputs,
  deriveAdoptDefer,
  completeDelivery,
  runExperiment,
  runLiveExperiment,
};
