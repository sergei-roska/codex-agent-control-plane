'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInputs, runExperiment } = require('../src/m8/experiment');
const { buildSanitizedTrace } = require('../src/m8/trace');
const { resolveLiveExport } = require('../src/m8/exporter');

const SECRETS = ['fixture-token-value', 'sk-fixturekey1234', 's3cret-pass', 'token=abc'];

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('submits sanitized trace correlation and feedback through MLflow tracking REST API', async () => {
  const { fixture } = loadInputs();
  const trace = buildSanitizedTrace(fixture);
  const feedback = {
    outcomeId: trace.correlation.outcomeId,
    status: trace.outcome.status,
    feedback: trace.outcome.feedback,
  };
  const requests = [];
  const live = await resolveLiveExport({
    M8_MLFLOW_TRACKING_URI: 'http://mlflow.example/prefix/',
    M8_MLFLOW_EXPERIMENT_ID: '42',
  }, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) return response({ run: { info: { run_id: 'mlflow-run-1' } } });
      return response({});
    },
  }, { trace, feedback });

  assert.equal(live.status, 'accepted');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://mlflow.example/prefix/api/2.0/mlflow/runs/create');
  assert.equal(requests[1].url, 'http://mlflow.example/prefix/api/2.0/mlflow/runs/log-batch');
  for (const request of requests) {
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['content-type'], 'application/json');
  }
  const createBody = JSON.parse(requests[0].options.body);
  assert.equal(createBody.experiment_id, '42');
  const batch = JSON.parse(requests[1].options.body);
  assert.equal(batch.run_id, 'mlflow-run-1');
  const params = Object.fromEntries(batch.params.map(({ key, value }) => [key, value]));
  assert.equal(params['m8.trace_id'], trace.traceId);
  assert.equal(params['m8.ticket_id'], trace.correlation.ticketId);
  assert.equal(params['m8.run_id'], trace.correlation.runId);
  assert.equal(params['m8.attempt_id'], trace.correlation.attemptId);
  assert.equal(params['m8.outcome_id'], trace.correlation.outcomeId);
  assert.equal(params['m8.outcome.status'], trace.outcome.status);
  assert.equal(params['m8.outcome.feedback'], trace.outcome.feedback);
  for (const secret of SECRETS) assert.equal(JSON.stringify(requests).includes(secret), false, secret);
});

test('MLflow HTTP errors defer export without escaping the optional telemetry path', async () => {
  const trace = buildSanitizedTrace(loadInputs().fixture);
  const live = await resolveLiveExport({
    M8_MLFLOW_TRACKING_URI: 'http://localhost:5000',
    M8_MLFLOW_EXPERIMENT_ID: '42',
  }, {
    fetch: async () => response({ error_code: 'INVALID_PARAMETER_VALUE' }, 400),
  }, { trace, feedback: { status: trace.outcome.status, feedback: trace.outcome.feedback } });
  assert.equal(live.status, 'deferred');
  assert.equal(live.reason, 'HTTP 400');
  assert.equal(live.attemptedConfiguration.some(({ result }) => result === 'failed'), true);
});

test('no MLflow config skips network and identifies the concrete deferral', async () => {
  let called = false;
  const trace = buildSanitizedTrace(loadInputs().fixture);
  const live = await resolveLiveExport({}, { fetch: async () => { called = true; } }, {
    trace,
    feedback: { status: trace.outcome.status, feedback: trace.outcome.feedback },
  });
  assert.equal(called, false);
  assert.equal(live.status, 'deferred');
  assert.equal(live.reason, 'tracking uri unset');
});

test('a stalled MLflow request has a bounded deferral', async () => {
  const trace = buildSanitizedTrace(loadInputs().fixture);
  const live = await resolveLiveExport({
    M8_MLFLOW_TRACKING_URI: 'http://localhost:5000',
    M8_MLFLOW_EXPERIMENT_ID: '42',
  }, {
    timeoutMs: 5,
    fetch: async () => new Promise(() => {}),
  }, { trace, feedback: { status: trace.outcome.status, feedback: trace.outcome.feedback } });
  assert.equal(live.status, 'deferred');
  assert.match(live.reason, /ETIMEDOUT/);
});

test('the default experiment result is deterministic and production remains deferred', async () => {
  const first = await runExperiment({ env: {} });
  const second = await runExperiment({ env: {} });
  assert.deepEqual(second, first);
  assert.equal(first.exporter.live.reason, 'tracking uri unset');
  assert.equal(first.productionAdoption, 'defer');
  assert.equal(first.adoptDefer, 'defer');
});
