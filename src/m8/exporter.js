'use strict';

// Receivers implement acceptTraces(traces) and attachFeedback(runId, feedback).
// Export is optional telemetry: callers keep local evidence when a receiver throws.

class InProcessReceiver {
  constructor() {
    this.runs = [];
    this.feedback = [];
  }

  acceptTraces(traces) {
    const correlationIds = traces.map((trace) => ({
      traceId: trace.traceId,
      ticketId: trace.correlation.ticketId,
      runId: trace.correlation.runId,
      attemptId: trace.correlation.attemptId,
      outcomeId: trace.correlation.outcomeId,
    }));
    const runId = `in-process:${traces.map((trace) => trace.traceId).join('|')}`;
    this.runs.push({ runId, correlationIds, traces });
    return { runId, correlationIds };
  }

  attachFeedback(runId, feedback) {
    const known = this.runs.some((run) => run.runId === runId);
    if (!known) throw new Error('unknown run');
    this.feedback.push({ runId, feedback });
    return { runId, accepted: true };
  }
}

class ThrowingReceiver {
  acceptTraces() {
    throw new Error('exporter unavailable');
  }

  attachFeedback() {
    throw new Error('exporter unavailable');
  }
}

function exportTraces(receiver, traces, feedback) {
  const accepted = receiver.acceptTraces(traces);
  const attached = receiver.attachFeedback(accepted.runId, feedback);
  return {
    status: 'accepted',
    runId: accepted.runId,
    correlationIds: accepted.correlationIds,
    feedbackAccepted: attached.accepted === true,
  };
}

function trackingEndpoint(trackingUri, route) {
  const uri = new URL(trackingUri);
  if (!['http:', 'https:'].includes(uri.protocol)) throw new Error('unsupported tracking URI protocol');
  uri.pathname = `${uri.pathname.replace(/\/$/, '')}/api/2.0/mlflow/${route}`;
  uri.search = '';
  uri.hash = '';
  return uri.toString();
}

function traceParams(trace, feedback) {
  // MLflow's log-batch API caps parameter values at 250 characters. Keep the
  // sanitized fields individually inspectable and bounded to that contract.
  return [
    ['m8.trace_id', trace.traceId],
    ['m8.fixture_version', trace.fixtureVersion],
    ['m8.ticket_id', trace.correlation.ticketId],
    ['m8.run_id', trace.correlation.runId],
    ['m8.attempt_id', trace.correlation.attemptId],
    ['m8.outcome_id', trace.correlation.outcomeId],
    ['m8.ticket.title', trace.ticket.title],
    ['m8.ticket.text', trace.ticket.text],
    ['m8.attempt.output', trace.attempt.output],
    ['m8.outcome.status', feedback.status],
    ['m8.outcome.feedback', feedback.feedback],
  ].map(([key, value]) => ({ key, value: String(value).slice(0, 250) }));
}

async function postJson(fetchImpl, endpoint, body) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response || response.ok !== true) {
    const status = response && Number.isInteger(response.status) ? response.status : null;
    const error = new Error(status ? `HTTP ${status}` : 'HTTP request failed');
    error.status = status;
    throw error;
  }
  return response.json();
}

async function sendTrackingExperiment({ trackingUri, experimentId, trace, feedback, fetch: fetchImpl }) {
  const created = await postJson(fetchImpl, trackingEndpoint(trackingUri, 'runs/create'), {
    experiment_id: String(experimentId),
    run_name: `m8-${trace.correlation.outcomeId}`,
    tags: [{ key: 'm8.export_contract', value: 'sanitized-trace-and-feedback-v1' }],
  });
  const runId = created && created.run && created.run.info && created.run.info.run_id;
  if (!runId) throw new Error('MLflow create-run response omitted run_id');
  await postJson(fetchImpl, trackingEndpoint(trackingUri, 'runs/log-batch'), {
    run_id: runId,
    params: traceParams(trace, feedback),
    metrics: [],
    tags: [{ key: 'm8.export_status', value: 'submitted' }],
  });
  return { ok: true, runId };
}

function resolveLiveExport(env = process.env, deps = {}, input = {}) {
  const attemptedConfiguration = [];
  const trackingUri = env.M8_MLFLOW_TRACKING_URI || '';
  const experimentId = env.M8_MLFLOW_EXPERIMENT_ID || '';
  if (!trackingUri || !experimentId) {
    const reason = !trackingUri ? 'tracking uri unset' : 'experiment id unset';
    attemptedConfiguration.push({
      step: 'skip-export',
      result: 'skipped',
      reason: !trackingUri
        ? 'M8_MLFLOW_TRACKING_URI is unset'
        : 'M8_MLFLOW_EXPERIMENT_ID is unset',
    });
    return { status: 'deferred', reason, attemptedConfiguration };
  }
  if (!input.trace || !input.feedback) {
    attemptedConfiguration.push({
      step: 'skip-export',
      result: 'skipped',
      reason: 'sanitized trace and feedback are required',
    });
    return { status: 'deferred', reason: 'trace input missing', attemptedConfiguration };
  }

  const send = deps.send || sendTrackingExperiment;
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    attemptedConfiguration.push({ step: 'mlflow-tracking-api', endpoint: '/runs/create', result: 'failed', code: 'fetch unavailable' });
    return { status: 'deferred', reason: 'fetch unavailable', attemptedConfiguration };
  }
  attemptedConfiguration.push({ step: 'mlflow-tracking-api', endpoint: '/runs/create + /runs/log-batch', result: 'attempted' });
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 3000;
  let rejectTimeout;
  const timeoutPromise = new Promise((resolve, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    const error = new Error('MLflow export timed out');
    error.code = 'ETIMEDOUT';
    rejectTimeout(error);
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const boundedFetch = (url, options) => fetchImpl(url, { ...options, signal: controller.signal });
  return Promise.resolve()
    .then(() => Promise.race([
      send({ trackingUri, experimentId, ...input, fetch: boundedFetch }),
      timeoutPromise,
    ]))
    .then((response) => {
      const ok = response && response.ok === true;
      if (ok) {
        attemptedConfiguration.push({ step: 'mlflow-tracking-api', endpoint: '/runs/create + /runs/log-batch', result: 'accepted' });
        return { status: 'accepted', reason: 'sanitized trace fields and feedback logged to MLflow run', attemptedConfiguration };
      }
      const statusCode = response && Number.isInteger(response.status) ? response.status : null;
      attemptedConfiguration.push({ step: 'mlflow-tracking-api', endpoint: '/runs/create + /runs/log-batch', result: 'failed', statusCode });
      return { status: 'deferred', reason: statusCode ? `HTTP ${statusCode}` : 'HTTP request failed', attemptedConfiguration };
    })
    .catch((err) => {
      const code = err && err.status ? `HTTP ${err.status}` : (err && err.code ? err.code : 'request failed');
      attemptedConfiguration.push({ step: 'mlflow-tracking-api', endpoint: '/runs/create + /runs/log-batch', result: 'failed', code });
      return { status: 'deferred', reason: code.startsWith('HTTP ') ? code : `MLflow export failed (${code})`, attemptedConfiguration };
    })
    .finally(() => {
      clearTimeout(timer);
      controller.abort();
    });
}

module.exports = {
  InProcessReceiver,
  ThrowingReceiver,
  exportTraces,
  resolveLiveExport,
  traceParams,
};
