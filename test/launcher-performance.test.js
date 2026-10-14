'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openStateDatabase } = require('../src/durable-store');
const { UsageLedger } = require('../src/usage-ledger');
const { sessionPerformance } = require('../src/session-performance');
const { createLauncherApp } = require('../src/launcher-app');

async function fixture(withLedger = true) {
  const state = await openStateDatabase({ filePath: ':memory:' });
  const db = state.db;
  const addLead = (id, contextId) => db.prepare(`INSERT INTO tasks
    (tenant, owner, id, context_id, status_last_updated, status_state, artifacts)
    VALUES ('t', 'orchestrator', ?, ?, 1, 'completed', '[]')`).run(id, contextId);
  addLead('lead-1', 'session-a');
  addLead('lead-2', 'session-a');
  addLead('lead-other', 'session-b');
  if (!withLedger) return state;

  const ledger = new UsageLedger({ db });
  const journal = db.prepare(`INSERT INTO dispatch_journal
    (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'read-only', ?, ?, 'finished', ?, '2026-01-01', '2026-01-01')`);
  journal.run('worker-attempt', 'lead-1', 'lead-1:r2:a0', 'engineer', 'worker-context', 'worker-1', JSON.stringify({
    status: 'TASK_STATE_COMPLETED',
    reviewResult: { status: 'accepted', valid: true, verdict: null, reason: null, secret: 'omit' },
    report: { summary: 'VERDICT: pass - checkpoint summary\nChecks listed below.', checks: [
      { result: 'passed' }, { result: 'failed' }, { result: 'not_run' }, { result: 'other' },
    ] },
  }));
  journal.run('worker-attempt-duplicate', 'lead-2', 'lead-2:r1:a0', 'engineer', 'worker-context', 'worker-1', null);
  journal.run('foreign-attempt', 'lead-other', 'lead-other:r1:a0', 'engineer', 'foreign-context', 'foreign-worker', null);
  ledger.record({ entryId: 'lead:1', kind: 'lead_turn', runId: 'lead-1', role: 'orch-lead', startedAt: '2026-01-01T00:00:00.000Z', retries: 2,
    tokens: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 2, totalTokens: 13, apiKey: 'omit' }, permissionEvents: [] });
  ledger.record({ entryId: 'worker:1', kind: 'worker_turn', role: 'engineer', taskId: 'worker-1', contextId: 'worker-context',
    startedAt: '2026-01-01T00:00:01.000Z', elapsedMs: 42, retries: 3, startupMs: 9, coldStart: false, queueWaitMs: 5,
    tokens: { inputTokens: '10', outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 5 },
    outcome: 'failed', permissionEvents: [{ type: 'hook', status: 'blocked' }] });
  ledger.record({ entryId: 'lead:2', kind: 'lead_turn', runId: 'lead-2', role: 'coordinator', startedAt: '2026-01-02T00:00:00.000Z', retries: null,
    tokens: null, permissionEvents: [] });
  ledger.record({ entryId: 'foreign:1', kind: 'worker_turn', role: 'engineer', taskId: 'foreign-worker', contextId: 'foreign-context', tokens: {
    inputTokens: 999,
  }, permissionEvents: [] });
  return state;
}

test('session performance stays session-bound, deduplicates entries, and exposes sanitized usage and review receipt', async () => {
  const state = await fixture();
  try {
    const report = sessionPerformance(state.db, 'session-a', { generatedAt: '2026-10-14T00:00:00.000Z' });
    assert.equal(report.schema, 'session-performance/v1');
    assert.equal(report.generatedAt, '2026-10-14T00:00:00.000Z');
    assert.equal(report.totals.rows, 3);
    assert.deepEqual(report.totals.tokens, {
      inputTokens: 10, cachedInputTokens: 1, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 18,
    });
    assert.equal(report.totals.tokensUnknownRows, 1);
    assert.equal(report.totals.tokensPartial, true);
    assert.equal(report.totals.retries, 5);
    assert.equal(report.totals.retriesUnknownRows, 1);
    assert.equal(report.retryAttempts, 2);
    assert.deepEqual(report.attempts.map((row) => row.entryId), ['lead:1', 'worker:1', 'lead:2']);
    const worker = report.attempts[1];
    assert.deepEqual([worker.runId, worker.assignmentId, worker.round], ['lead-1', 'lead-1:r2:a0', 2]);
    assert.deepEqual(worker.tokens, {
      inputTokens: null, cachedInputTokens: null, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 5,
    });
    assert.equal(worker.permissionDenials, 1);
    assert.equal(worker.outcome, 'failed');
    assert.equal(worker.reportedVerdict, 'pass');
    assert.deepEqual(worker.checks, { passed: 1, failed: 1, notRun: 1, unknown: 1 });
    assert.deepEqual(worker.review, { status: 'accepted', accepted: null, valid: true, verdict: null, reason: null });
    assert.equal('secret' in worker.review, false);
    assert.equal('acceptance' in report, false);
    assert.equal(report.attempts[2].elapsedMs, null);
    assert.equal(report.attempts[2].reportedVerdict, null);
    assert.equal(report.attempts[2].checks, null);
    assert.equal(report.attempts[2].review, null);
    assert.equal(sessionPerformance(state.db, 'session-b').attempts.length, 1);
    assert.equal(sessionPerformance(state.db, 'missing'), null);
  } finally {
    await state.close();
  }
});

test('final task report and receipt attach only to the last recorded turn', async () => {
  const state = await fixture();
  try {
    new UsageLedger({ db: state.db }).record({
      entryId: 'worker:prior-turn', kind: 'worker_turn', role: 'engineer', taskId: 'worker-1', contextId: 'worker-context',
      startedAt: '2025-12-31T00:00:00.000Z', recordedAt: '2025-12-31T00:00:00.000Z', retries: 1,
      outcome: 'failed', tokens: {}, permissionEvents: [],
    });
    const report = sessionPerformance(state.db, 'session-a');
    const prior = report.attempts.find((row) => row.entryId === 'worker:prior-turn');
    const latest = report.attempts.find((row) => row.entryId === 'worker:1');
    assert.equal(prior.reportedVerdict, null);
    assert.equal(prior.checks, null);
    assert.equal(prior.review, null);
    assert.deepEqual(prior.tokens, {
      inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null,
    });
    assert.equal(report.totals.tokensUnknownRows, 2);
    assert.equal(report.totals.tokensPartial, true);
    assert.equal(latest.reportedVerdict, 'pass');
    assert.deepEqual(latest.checks, { passed: 1, failed: 1, notRun: 1, unknown: 1 });
    assert.equal(latest.review.status, 'accepted');
    assert.equal(latest.review.accepted, null);
  } finally {
    await state.close();
  }
});

test('an old database without a usage ledger returns a complete empty report for an existing session', async () => {
  const state = await fixture(false);
  try {
    const report = sessionPerformance(state.db, 'session-a', { generatedAt: 'now' });
    assert.deepEqual(report, {
      schema: 'session-performance/v1',
      generatedAt: 'now',
      totals: require('../src/usage-report').summarize([]),
      byRole: {},
      retryAttempts: 0,
      attempts: [],
    });
  } finally {
    await state.close();
  }
});

test('session performance parses a stored JSON worker-report without returning its text', async () => {
  const state = await fixture();
  try {
    const report = {
      outcome: 'completed', summary: 'VERDICT: inconclusive - evidence is incomplete', filesChanged: [], filesInspected: [],
      checks: [{ command: 'npm test', result: 'passed', detail: 'passed' }], risks: [], scopeExpansion: [], decisionRequest: null,
    };
    state.db.prepare(`INSERT INTO dispatch_journal
      (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, result_json, created_at, updated_at)
      VALUES ('text-attempt', 'lead-2', 'lead-2:r3:a1', 'auditor', 'read-only', 'text-context', 'text-worker', 'finished', ?, '2026-01-03', '2026-01-03')`)
    .run(JSON.stringify({ status: 'TASK_STATE_COMPLETED', artifacts: [{ text: JSON.stringify(report) }] }));
    new UsageLedger({ db: state.db }).record({ entryId: 'text-worker:turn', kind: 'worker_turn', role: 'auditor', taskId: 'text-worker', contextId: 'text-context', permissionEvents: [] });
    const attempt = sessionPerformance(state.db, 'session-a').attempts.find((row) => row.entryId === 'text-worker:turn');
    assert.equal(attempt.reportedVerdict, 'inconclusive');
    assert.deepEqual(attempt.checks, { passed: 1, failed: 0, notRun: 0, unknown: 0 });
    assert.equal('text' in attempt, false);
  } finally {
    await state.close();
  }
});

test('usage API keeps its default shape and adds performance only when requested', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-performance-'));
  const file = path.join(dir, 'state.sqlite');
  const state = await openStateDatabase({ filePath: file });
  state.db.prepare(`INSERT INTO tasks
    (tenant, owner, id, context_id, status_last_updated, status_state, artifacts)
    VALUES ('t', 'orchestrator', 'lead-route', 'route-session', 1, 'completed', '[]')`).run();
  new UsageLedger({ db: state.db }).record({ entryId: 'route:lead', kind: 'lead_turn', runId: 'lead-route',
    role: 'coordinator', tokens: { inputTokens: 8, outputTokens: 2, totalTokens: 10 }, permissionEvents: [] });
  await state.close();
  const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  const app = createLauncherApp({
    projects: { stateDbPath: () => file },
    readAuthToken: () => 'unused',
    openTasksDb: (dbFile, options) => {
      assert.equal(options.readonly, true);
      return new Database(dbFile, options);
    },
  });
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const route = app.router.stack.find((layer) => layer.route?.path === '/api/projects/:id/sessions/:contextId/usage');
  assert.ok(route);
  const request = (details) => {
    let status = 200;
    let body;
    route.route.stack[0].handle({ params: { id: 'aaaaaaaaaa', contextId: 'route-session' }, query: details ? { details } : {} }, {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
    });
    return { status, body };
  };
  const plain = request(null);
  const plainBody = plain.body;
  assert.equal(plain.status, 200);
  assert.deepEqual(Object.keys(plainBody).sort(), ['byRole', 'contextId', 'total', 'unknownCount']);
  const detailed = request('performance');
  const detailedBody = detailed.body;
  assert.equal(detailed.status, 200);
  assert.deepEqual(Object.keys(detailedBody).sort(), ['byRole', 'contextId', 'performance', 'total', 'unknownCount']);
  assert.equal(detailedBody.performance.schema, 'session-performance/v1');
  assert.equal(detailedBody.performance.attempts[0].entryId, 'route:lead');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
});
