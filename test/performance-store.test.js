'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { openStateDatabase } = require('../src/durable-store');
const { UsageLedger } = require('../src/usage-ledger');
const { collectOnce, parseArgs, ensureDistinctDatabases, main } = require('../src/performance-store');

const PROJECT = 'a1b2c3d4e5';

async function fixture(root) {
  const statePath = path.join(root, 'state.sqlite');
  const state = await openStateDatabase({ filePath: statePath });
  const db = state.db;
  const task = db.prepare(`INSERT INTO tasks
    (tenant, owner, id, context_id, status_last_updated, status_state, artifacts)
    VALUES ('t', ?, ?, ?, 1, ?, '[]')`);
  task.run('orchestrator', 'lead-1', 'session-1', 'TASK_STATE_COMPLETED');
  task.run('orchestrator', 'lead-2', 'session-2', 'TASK_STATE_COMPLETED');
  task.run('engineer', 'worker-1', 'worker-context-1', 'TASK_STATE_COMPLETED');
  task.run('engineer', 'worker-2', 'worker-context-2', 'TASK_STATE_WORKING');
  task.run('engineer', 'worker-other', 'worker-context-other', 'TASK_STATE_COMPLETED');
  const journal = db.prepare(`INSERT INTO dispatch_journal
    (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'read-only', ?, ?, ?, ?, '2026-01-01', '2026-01-01')`);
  const report = {
    status: 'TASK_STATE_COMPLETED',
    report: { summary: 'VERDICT: pass - all checks ran', checks: [{ result: 'passed' }] },
    reviewResult: { status: 'accepted', accepted: true, valid: true, verdict: null, reason: null },
  };
  journal.run('attempt-1', 'lead-1', 'lead-1:r2:a0', 'engineer', 'worker-context-1', 'worker-1', 'finished', JSON.stringify(report));
  journal.run('attempt-active', 'lead-1', 'lead-1:r3:a0', 'engineer', 'worker-context-2', 'worker-2', 'submitted', null);
  journal.run('attempt-other', 'lead-2', 'lead-2:r1:a0', 'engineer', 'worker-context-other', 'worker-other', 'finished', null);
  const ledger = new UsageLedger({ db });
  ledger.record({ entryId: 'worker-1:prior', kind: 'worker_turn', role: 'engineer', taskId: 'worker-1', contextId: 'worker-context-1',
    startedAt: '2026-01-01T00:00:01.000Z', recordedAt: '2026-01-01T00:00:01.000Z', retries: 1, outcome: 'failed', elapsedMs: null,
    tokens: { cachedInputTokens: 4 }, permissionEvents: [] });
  ledger.record({ entryId: 'worker-1:mid', kind: 'worker_turn', role: 'engineer', taskId: 'worker-1', contextId: 'worker-context-1',
    startedAt: '2026-01-01T00:00:01.500Z', recordedAt: '2026-01-01T00:00:01.500Z', retries: 1, outcome: 'failed', elapsedMs: 5,
    tokens: { inputTokens: 2, outputTokens: 1 }, permissionEvents: [] });
  ledger.record({ entryId: 'worker-1:latest', kind: 'worker_turn', role: 'engineer', taskId: 'worker-1', contextId: 'worker-context-1',
    startedAt: '2026-01-01T00:00:02.000Z', recordedAt: '2026-01-01T00:00:02.000Z', retries: 1, outcome: 'completed', elapsedMs: 30,
    tokens: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 8 }, permissionEvents: [] });
  ledger.record({ entryId: 'worker-other:1', kind: 'worker_turn', role: 'engineer', taskId: 'worker-other', contextId: 'worker-context-other',
    startedAt: '2026-01-02T00:00:02.000Z', recordedAt: '2026-01-02T00:00:02.000Z', outcome: 'completed', elapsedMs: 99,
    tokens: { inputTokens: 900, outputTokens: 90, totalTokens: 990 }, permissionEvents: [] });
  await state.close();
  return statePath;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('collector is idempotent, session-scoped, read-only on state, and writes a compact snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = await fixture(root);
  const before = digest(statePath);
  const snapshotDir = path.join(root, 'snapshots');
  const first = collectOnce({ statePath, projectId: PROJECT, contextId: 'session-1', snapshotDir, generatedAt: '2026-10-14T00:00:00.000Z' });
  assert.equal(first.report.totals.tokens.totalTokens, 11);
  assert.equal(first.report.totals.tokensUnknownRows, 1);
  assert.equal(first.report.totals.tokensPartial, true);
  const snapshotPath = path.join(snapshotDir, PROJECT, 'session-1.json');
  assert.equal(first.snapshotPath, snapshotPath);
  assert.deepEqual(first.snapshot.total, {
    inputTokens: 7, cachedInputTokens: 6, outputTokens: 4, totalTokens: 11, attempts: 3,
  });
  assert.equal(first.snapshot.tasks.length, 2);
  const worker = first.snapshot.tasks.find((row) => row.taskId === 'worker-1');
  assert.deepEqual(worker, {
    taskId: 'worker-1', assignmentId: 'lead-1:r2:a0', round: 2, role: 'engineer',
    totalTokens: 11, inputTokens: 7, cachedInputTokens: 6, outputTokens: 4, elapsedMs: 35,
    models: {}, state: 'TASK_STATE_COMPLETED', unknownTokenRows: 1, unknownTimeRows: 1,
  });
  const active = first.snapshot.tasks.find((row) => row.taskId === 'worker-2');
  assert.deepEqual([active.state, active.totalTokens, active.elapsedMs, active.unknownTokenRows, active.unknownTimeRows],
    ['TASK_STATE_WORKING', null, null, null, null]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).sort(), ['contextId', 'generatedAt', 'schema', 'tasks', 'total']);
  assert.equal(fs.readdirSync(path.dirname(snapshotPath)).some((name) => name.endsWith('.tmp')), false);
  assert.equal(digest(statePath), before);
  assert.throws(() => collectOnce({ statePath, metricsDbPath: `${statePath}-wal`, projectId: PROJECT,
    contextId: 'session-1', snapshotDir }), /separate/);
  assert.equal(digest(statePath), before);

  await main(['--state', statePath, '--project', PROJECT, '--session', 'session-1', '--snapshot-dir', snapshotDir]);
  const metricsDb = new Database(path.join(root, 'performance.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(metricsDb.prepare('SELECT count(*) AS n FROM performance_attempts WHERE project_id = ? AND session_id = ?').get(PROJECT, 'session-1').n, 3);
    const rows = metricsDb.prepare('SELECT entry_id, run_id, task_id, outcome, reported_verdict, checks_passed, receipt_status, task_state FROM performance_attempts WHERE session_id = ? ORDER BY entry_id').all('session-1');
    assert.deepEqual(rows.map((row) => [row.entry_id, row.run_id, row.task_id, row.outcome, row.reported_verdict, row.checks_passed, row.receipt_status, row.task_state]), [
      ['worker-1:latest', 'lead-1', 'worker-1', 'completed', 'pass', 1, 'accepted', 'TASK_STATE_COMPLETED'],
      ['worker-1:mid', 'lead-1', 'worker-1', 'failed', null, null, null, 'TASK_STATE_COMPLETED'],
      ['worker-1:prior', 'lead-1', 'worker-1', 'failed', null, null, null, 'TASK_STATE_COMPLETED'],
    ]);
    assert.equal(metricsDb.prepare("SELECT count(*) AS n FROM pragma_table_info('performance_attempts') WHERE name IN ('history', 'prompt', 'result_json')").get().n, 0);
  } finally {
    metricsDb.close();
  }

  const secondSession = collectOnce({ statePath, projectId: PROJECT, contextId: 'session-2', snapshotDir });
  assert.equal(secondSession.report.attempts.length, 1);
  assert.equal(secondSession.report.attempts[0].taskId, 'worker-other');
  const readMetrics = new Database(path.join(root, 'performance.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(readMetrics.prepare('SELECT count(*) AS n FROM performance_attempts WHERE project_id = ? AND session_id = ?').get(PROJECT, 'session-2').n, 1);
    assert.equal(readMetrics.prepare('SELECT count(*) AS n FROM performance_attempts WHERE project_id = ?').get(PROJECT).n, 4);
  } finally {
    readMetrics.close();
  }
  assert.equal(digest(statePath), before);
});

test('CLI validates file-safe IDs, options, and separate database identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-args-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.sqlite');
  fs.writeFileSync(statePath, 'placeholder');
  assert.deepEqual(parseArgs(['--state', statePath, '--project', PROJECT, '--session', 'ctx-1', '--watch-ms', '250']), {
    statePath, projectId: PROJECT, contextId: 'ctx-1', watchMs: 250,
  });
  assert.throws(() => parseArgs(['--state', statePath, '--project', '../../x', '--session', 'ctx']), /project/);
  assert.throws(() => parseArgs(['--state', statePath, '--project', PROJECT, '--session', '../x']), /safe path segment/);
  assert.throws(() => parseArgs(['--state', statePath, '--project', PROJECT, '--session', 'ctx', '--watch-ms', '0']), /positive integer/);
  assert.throws(() => ensureDistinctDatabases(statePath, path.join(root, '.', 'state.sqlite')), /separate/);
  const aliasPath = path.join(root, 'alias.sqlite');
  fs.symlinkSync(statePath, aliasPath);
  assert.throws(() => ensureDistinctDatabases(statePath, aliasPath), /separate/);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.throws(() => ensureDistinctDatabases(statePath, `${statePath}${suffix}`), /separate/);
  }
  const hardlinkPath = path.join(root, 'hardlink.sqlite');
  fs.linkSync(statePath, hardlinkPath);
  assert.throws(() => ensureDistinctDatabases(statePath, hardlinkPath), /separate/);
  const companionPath = `${statePath}-wal`;
  fs.writeFileSync(companionPath, 'disposable companion');
  const companionHardlink = path.join(root, 'companion-hardlink.sqlite');
  fs.linkSync(companionPath, companionHardlink);
  assert.throws(() => ensureDistinctDatabases(statePath, companionHardlink), /separate/);
});

test('collector handles a legacy state database without usage_ledger and keeps unknowns null', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.sqlite');
  const state = await openStateDatabase({ filePath: statePath });
  state.db.prepare(`INSERT INTO tasks
    (tenant, owner, id, context_id, status_last_updated, status_state, artifacts)
    VALUES ('t', 'orchestrator', 'legacy-lead', 'legacy-session', 1, 'TASK_STATE_WORKING', '[]')`).run();
  state.db.prepare(`INSERT INTO dispatch_journal
    (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, created_at, updated_at)
    VALUES ('legacy-attempt', 'legacy-lead', 'legacy-lead:r1:a0', 'engineer', 'read-only', 'worker-context', NULL, 'submitting', 'n', 'n')`).run();
  await state.close();
  const before = digest(statePath);
  const snapshotDir = path.join(root, 'snapshots');
  const result = collectOnce({ statePath, projectId: PROJECT, contextId: 'legacy-session', snapshotDir });
  assert.equal(result.report.totals.rows, 0);
  assert.deepEqual(result.snapshot.total, {
    inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, attempts: 0,
  });
  assert.deepEqual(result.snapshot.tasks, [{
    taskId: null, assignmentId: 'legacy-lead:r1:a0', round: 1, role: 'engineer',
    totalTokens: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, elapsedMs: null,
    models: {}, state: 'submitting', unknownTokenRows: null, unknownTimeRows: null,
  }]);
  assert.equal(digest(statePath), before);
});
