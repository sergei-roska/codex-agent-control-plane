'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSanitizedTrace } = require('./trace');
const { InProcessReceiver, exportTraces } = require('./exporter');
const { redactDiagnosticMessage } = require('../event-journal');

const ROOT = path.join(__dirname, '..', '..');

function withIsolatedWorkspace(caseItem, fn) {
  if (!caseItem.writesFiles) return fn(null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-eval-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function loadTraceFixture(caseItem) {
  const fixturePath = path.join(ROOT, 'eval/m8/fixtures', caseItem.input.fixture);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function executeCase(caseItem, workspace) {
  switch (caseItem.task) {
    case 'sanitize-trace':
      return { trace: buildSanitizedTrace(loadTraceFixture(caseItem)) };
    case 'export-trace-and-feedback': {
      const trace = buildSanitizedTrace(loadTraceFixture(caseItem));
      const receiver = new InProcessReceiver();
      const exported = exportTraces(receiver, [trace], {
        outcomeId: trace.correlation.outcomeId,
        status: trace.outcome.status,
        feedback: trace.outcome.feedback,
      });
      return { exported, receiver };
    }
    case 'defer-production-adoption': {
      // Lazy import avoids the experiment -> compare module initialization cycle.
      const { deriveAdoptDefer } = require('./experiment');
      return deriveAdoptDefer(caseItem.input);
    }
    case 'write-isolated-artifact': {
      if (!workspace) return { artifactCreated: false };
      const artifactPath = path.resolve(workspace, caseItem.input.filename);
      if (artifactPath === path.resolve(workspace)
        || !artifactPath.startsWith(`${path.resolve(workspace)}${path.sep}`)) {
        throw new Error('evaluation artifact must stay inside its isolated workspace');
      }
      fs.writeFileSync(artifactPath, `${caseItem.input.content}\n`);
      return { artifactPath, artifactCreated: true };
    }
    default:
      throw new Error(`unsupported evaluation task: ${caseItem.task}`);
  }
}

function assessCase(caseItem, output, workspace) {
  switch (caseItem.task) {
    case 'sanitize-trace': {
      const trace = output.trace;
      const serialized = JSON.stringify(trace);
      const containsSecret = caseItem.expect.secrets.some((secret) => serialized.includes(secret));
      const redactionMarkers = (serialized.match(/\[REDACTED\]/g) || []).length;
      const correlationMatchesFixture = trace.traceId === caseItem.expect.traceId
        && caseItem.expect.correlationFields.every((field) => {
          if (field === 'traceId') return trace.traceId === caseItem.expect.traceId;
          return trace.correlation[field] === caseItem.expect.correlation[field];
        });
      return {
        passed: correlationMatchesFixture && !containsSecret && redactionMarkers > 0,
        observed: {
          correlationMatchesFixture,
          containsSecret,
          redactionMarkers,
        },
      };
    }
    case 'export-trace-and-feedback': {
      const receiver = output.receiver;
      const run = receiver.runs[0];
      const feedback = receiver.feedback[0];
      const correlationPreserved = Boolean(run && run.correlationIds.length === 1
        && caseItem.expect.correlationFields.every((field) => (
          run.correlationIds[0][field] === (field === 'traceId'
            ? caseItem.expect.traceId
            : caseItem.expect.correlation[field])
        )));
      const feedbackAttached = Boolean(feedback
        && feedback.runId === output.exported.runId
        && feedback.feedback.outcomeId === caseItem.expect.outcomeId);
      return {
        passed: output.exported.status === 'accepted'
          && output.exported.feedbackAccepted
          && correlationPreserved
          && feedbackAttached,
        observed: {
          status: output.exported.status,
          feedbackAccepted: output.exported.feedbackAccepted,
          correlationPreserved,
          feedbackAttached,
        },
      };
    }
    case 'defer-production-adoption':
      return {
        passed: output.adoptDefer === caseItem.expect.adoptDefer
          && output.productionAdoption === caseItem.expect.productionAdoption,
        observed: {
          adoptDefer: output.adoptDefer,
          productionAdoption: output.productionAdoption,
        },
      };
    case 'write-isolated-artifact': {
      const artifactPath = output.artifactPath;
      const insideWorkspace = Boolean(workspace && artifactPath
        && path.dirname(path.resolve(artifactPath)) === path.resolve(workspace));
      const existsDuringRun = Boolean(artifactPath && fs.existsSync(artifactPath));
      const contentsMatch = existsDuringRun
        && fs.readFileSync(artifactPath, 'utf8') === `${caseItem.input.content}\n`;
      return {
        passed: caseItem.expect.artifactCreated
          && output.artifactCreated
          && insideWorkspace
          && contentsMatch,
        observed: {
          artifactCreated: output.artifactCreated,
          insideTemporaryWorkspace: insideWorkspace,
          contentsMatch,
          removedAfterRun: false,
        },
      };
    }
    default:
      throw new Error(`unsupported evaluation task: ${caseItem.task}`);
  }
}

function scoreExecution(suiteVersion, dataset) {
  const cases = dataset.cases.map((caseItem) => {
    let result;
    let workspacePath = null;
    withIsolatedWorkspace(caseItem, (workspace) => {
      workspacePath = workspace;
      const output = executeCase(caseItem, workspace);
      result = assessCase(caseItem, output, workspace);
    });
    if (caseItem.writesFiles) {
      result.observed.removedAfterRun = !fs.existsSync(workspacePath);
      result.passed = result.passed && result.observed.removedAfterRun;
    }
    return { id: caseItem.id, passed: result.passed, observed: result.observed };
  });
  return {
    suiteVersion,
    passed: cases.filter((item) => item.passed).length,
    total: cases.length,
    cases,
  };
}

function comparePrompts({ baseline, candidate, dataset }) {
  // The executable suite validates deterministic application behavior.
  // Prompt text itself is not interpreted or sent to a model, so it receives
  // no score and cannot be used to claim a baseline/candidate improvement.
  const runtimeContracts = scoreExecution(dataset.protocol, dataset);
  const scores = {
    evaluation: {
      protocol: dataset.protocol,
      modelRun: false,
      promptRun: false,
      promptComparison: {
        status: 'not-evaluated',
        baselineVersion: baseline.version,
        candidateVersion: candidate.version,
      },
      limitation: 'Scores are observed from M8 application code execution. Prompt quality is unmeasured because no model-backed prompt execution is configured.',
    },
    runtimeContracts,
  };
  const ok = runtimeContracts.total === dataset.cases.length
    && runtimeContracts.cases.length === dataset.cases.length
    && runtimeContracts.passed === runtimeContracts.total;
  return { ok, promoted: false, promptsCompared: false, scores };
}

const LIVE_MODEL = 'gpt-6-luna';
const LIVE_EFFORT = 'low';

function scoreLiveCase(caseItem, response, workspace) {
  const text = String(response || '');
  const checks = Object.fromEntries(caseItem.expect.responsePatterns.map((pattern) => [
    pattern, new RegExp(pattern, 'i').test(text),
  ]));
  if (caseItem.expect.artifact) {
    const artifactPath = path.join(workspace, caseItem.expect.artifact.name);
    checks.artifact = fs.existsSync(artifactPath)
      && fs.readFileSync(artifactPath, 'utf8').trim() === caseItem.expect.artifact.content;
  }
  return { passed: Object.values(checks).every(Boolean), checks };
}

async function comparePromptsLive({ baseline, candidate, fixture, dataset, runTurn }) {
  if (typeof runTurn !== 'function') throw new TypeError('runTurn is required');
  const trace = buildSanitizedTrace(fixture);
  const results = [];
  for (const prompt of [baseline, candidate]) {
    for (const caseItem of dataset.cases) {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-live-eval-'));
      try {
        const input = `${caseItem.request}\n\nSanitized fixture:\n${JSON.stringify(trace)}`;
        const result = await runTurn({
          instructions: prompt.text,
          input,
          cwd: workspace,
          sandbox: caseItem.writesFiles ? 'workspace-write' : 'read-only',
          model: LIVE_MODEL,
          effort: LIVE_EFFORT,
        });
        const score = scoreLiveCase(caseItem, result.text, workspace);
        results.push({ prompt: prompt.version, caseId: caseItem.id, status: 'evaluated',
          ...score, response: redactDiagnosticMessage(result.text).slice(0, 2000) });
      } catch (error) {
        results.push({ prompt: prompt.version, caseId: caseItem.id, status: 'not-evaluated',
          error: redactDiagnosticMessage(error.message || String(error)).slice(0, 500) });
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
  }
  const byPrompt = (version) => {
    const cases = results.filter((item) => item.prompt === version);
    return { passed: cases.filter((item) => item.passed).length,
      evaluated: cases.filter((item) => item.status === 'evaluated').length,
      total: cases.length };
  };
  const baselineScore = byPrompt(baseline.version);
  const candidateScore = byPrompt(candidate.version);
  const complete = baselineScore.evaluated === baselineScore.total
    && candidateScore.evaluated === candidateScore.total;
  return { protocol: dataset.protocol, model: LIVE_MODEL, effort: LIVE_EFFORT,
    freshThreadPerCase: true, promoted: false,
    promptComparison: { status: complete ? 'evaluated' : 'not-evaluated',
      baseline: baselineScore, candidate: candidateScore,
      improvementObserved: complete ? candidateScore.passed > baselineScore.passed : null },
    cases: results };
}

module.exports = { withIsolatedWorkspace, scoreExecution, comparePrompts, comparePromptsLive, scoreLiveCase };
