'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { sessionLeadTaskIds } = require('./launcher-sessions');
const { sessionPerformance } = require('./session-performance');

const PROJECT_ID = /^[0-9a-f]{10}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'];
const ATTEMPT_TOKEN_FIELDS = [
  ['inputTokens', 'input_tokens'],
  ['cachedInputTokens', 'cached_input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ['totalTokens', 'total_tokens'],
];
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
function totalTokenContribution(tokens) {
  if (isNum(tokens?.totalTokens)) return tokens.totalTokens;
  if (isNum(tokens?.inputTokens) && isNum(tokens?.outputTokens)) return tokens.inputTokens + tokens.outputTokens;
  return null;
}
const sumKnown = (values) => {
  const known = values.filter(isNum);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};
const chunksOf = (values, size = 400) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

function validateIds(projectId, contextId) {
  if (!PROJECT_ID.test(String(projectId || ''))) throw new Error('project must be a 10-character hex project id');
  if (!SAFE_SEGMENT.test(String(contextId || '')) || contextId === '.' || contextId === '..') {
    throw new Error('session must be a safe path segment');
  }
}

function canonicalPath(file) {
  let current = path.resolve(file);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function ensureDistinctDatabases(statePath, metricsDbPath) {
  if (typeof statePath !== 'string' || !statePath || statePath === ':memory:') throw new Error('state must be a database file path');
  if (typeof metricsDbPath !== 'string' || !metricsDbPath || metricsDbPath === ':memory:') throw new Error('metrics-db must be a database file path');
  const requestedState = path.resolve(statePath);
  const canonicalState = canonicalPath(requestedState);
  const protectedPaths = new Set([requestedState, canonicalState]);
  for (const base of [requestedState, canonicalState]) {
    for (const suffix of ['-wal', '-shm', '-journal']) protectedPaths.add(`${base}${suffix}`);
  }
  const metricsPath = path.resolve(metricsDbPath);
  const canonicalMetrics = canonicalPath(metricsPath);
  const protectedCanonicalPaths = new Set([...protectedPaths].map(canonicalPath));
  const overlapsPath = protectedCanonicalPaths.has(canonicalMetrics);
  let metricsStat = null;
  try { metricsStat = fs.statSync(metricsPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const overlapsInode = metricsStat && [...protectedPaths].some((file) => {
    try {
      const sourceStat = fs.statSync(file);
      return sourceStat.dev === metricsStat.dev && sourceStat.ino === metricsStat.ino;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
  if (overlapsPath || overlapsInode) {
    throw new Error('metrics-db must be separate from the state database');
  }
}

function parseArgs(argv) {
  const out = {};
  const flags = new Map([
    ['--state', 'statePath'],
    ['--project', 'projectId'],
    ['--session', 'contextId'],
    ['--metrics-db', 'metricsDbPath'],
    ['--snapshot-dir', 'snapshotDir'],
    ['--watch-ms', 'watchMs'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = flags.get(argv[index]);
    if (!field || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`unknown or incomplete argument "${argv[index]}"`);
    }
    if (Object.hasOwn(out, field)) throw new Error(`duplicate argument "${argv[index]}"`);
    out[field] = argv[index + 1];
    index += 1;
  }
  if (!out.statePath || !out.projectId || !out.contextId) {
    throw new Error('usage: node src/performance-store.js --state <file> --project <id> --session <context> [--metrics-db <file>] [--snapshot-dir <dir>] [--watch-ms <interval>]');
  }
  validateIds(out.projectId, out.contextId);
  if (out.watchMs !== undefined) {
    if (!/^\d+$/.test(out.watchMs) || Number(out.watchMs) <= 0 || !Number.isSafeInteger(Number(out.watchMs))) {
      throw new Error('watch-ms must be a positive integer');
    }
    out.watchMs = Number(out.watchMs);
  }
  return out;
}

function createPerformanceTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_attempts (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT,
      entry_id TEXT NOT NULL,
      kind TEXT,
      assignment_id TEXT,
      round INTEGER,
      role TEXT,
      task_id TEXT,
      model TEXT,
      effort TEXT,
      started_at TEXT,
      elapsed_ms REAL,
      retries REAL,
      queue_wait_ms REAL,
      startup_ms REAL,
      cold_start INTEGER,
      input_tokens REAL,
      cached_input_tokens REAL,
      output_tokens REAL,
      reasoning_output_tokens REAL,
      total_tokens REAL,
      outcome TEXT,
      permission_denials INTEGER,
      reported_verdict TEXT,
      checks_passed INTEGER,
      checks_failed INTEGER,
      checks_not_run INTEGER,
      checks_unknown INTEGER,
      receipt_status TEXT,
      receipt_accepted INTEGER,
      receipt_valid INTEGER,
      receipt_verdict TEXT,
      receipt_reason TEXT,
      task_state TEXT,
      collected_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS performance_attempts_task_idx
      ON performance_attempts (project_id, session_id, task_id, assignment_id);
    CREATE INDEX IF NOT EXISTS performance_attempts_run_idx
      ON performance_attempts (project_id, session_id, run_id);
  `);
}

function taskStates(db, leadIds, report, assignments = []) {
  const states = new Map();
  if (!leadIds.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()) return states;
  const ids = new Set(leadIds);
  for (const attempt of report.attempts) {
    const taskId = attempt.kind === 'lead_turn' ? attempt.runId : attempt.taskId;
    if (taskId) ids.add(taskId);
  }
  for (const assignment of assignments) if (assignment.task_id) ids.add(assignment.task_id);
  const list = [...ids];
  if (!list.length) return states;
  for (const chunk of chunksOf(list)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, status_state, status_last_updated FROM tasks
      WHERE id IN (${placeholders}) ORDER BY status_last_updated DESC`).all(...chunk);
    for (const row of rows) {
      if (!states.has(row.id)) states.set(row.id, row.status_state ?? null);
    }
  }
  return states;
}

function assignmentRows(db, leadIds) {
  if (!leadIds.length || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_journal'").get()) return [];
  const rows = [];
  for (const chunk of chunksOf(leadIds)) {
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(...db.prepare(`SELECT run_id, assignment_id, role, task_id, state, created_at, updated_at
      FROM dispatch_journal WHERE run_id IN (${placeholders}) ORDER BY created_at, assignment_id`).all(...chunk));
  }
  return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.assignment_id.localeCompare(b.assignment_id));
}

function assignmentStates(rows) {
  const states = new Map();
  for (const row of rows) {
    const key = groupKey(row.task_id, row.assignment_id, row.run_id);
    if (!states.has(key) || String(row.updated_at) > String(states.get(key)?.updatedAt || '')) {
      states.set(key, { state: row.state ?? null, updatedAt: row.updated_at });
    }
  }
  return states;
}

function groupKey(taskId, assignmentId, runId) {
  return JSON.stringify([taskId ?? null, assignmentId ?? null, runId ?? null]);
}

function buildSnapshot(db, projectId, contextId, report) {
  const leadIds = sessionLeadTaskIds(db, contextId);
  const assignments = assignmentRows(db, leadIds);
  const states = taskStates(db, leadIds, report, assignments);
  const groups = new Map();
  const ensure = (values) => {
    const taskId = values.taskId ?? null;
    const assignmentId = values.assignmentId ?? null;
    const runId = values.runId ?? null;
    const key = groupKey(taskId, assignmentId, runId);
    if (!groups.has(key)) {
      groups.set(key, {
        taskId,
        assignmentId,
        round: values.round ?? null,
        role: values.role ?? null,
        runId,
        input: [],
        cached: [],
        output: [],
        total: [],
        elapsed: [],
        models: new Map(),
        attempts: 0,
        knownTotalTokenRows: 0,
        knownTimeRows: 0,
        state: values.state ?? null,
      });
    }
    return groups.get(key);
  };

  for (const row of assignments) {
    // Lead planning dispatches carry no attempts of their own; their time is the lead row's (from lead_turn attempts).
    if (/^(lead|coordinator)$/i.test(row.role ?? '')) continue;
    const group = ensure({
      taskId: row.task_id,
      assignmentId: row.assignment_id,
      round: (() => { const match = /:r(\d+):/.exec(row.assignment_id || ''); return match ? Number(match[1]) : null; })(),
      role: row.role,
      runId: row.run_id,
      state: row.task_id ? states.get(row.task_id) ?? row.state : row.state,
    });
  }

  for (const attempt of report.attempts) {
    const taskId = attempt.kind === 'lead_turn' ? attempt.runId : attempt.taskId;
    const group = ensure({
      taskId,
      assignmentId: attempt.assignmentId,
      round: attempt.round,
      role: attempt.role,
      runId: attempt.runId,
      state: taskId ? states.get(taskId) ?? null : null,
    });
    group.attempts += 1;
    const tokens = attempt.tokens || {};
    if (attempt.model) {
      const m = group.models.get(attempt.model) || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) if (isNum(tokens[key])) m[key] += tokens[key];
      group.models.set(attempt.model, m);
    }
    for (const [key, collection] of [['inputTokens', group.input], ['cachedInputTokens', group.cached], ['outputTokens', group.output]]) {
      if (isNum(tokens[key])) collection.push(tokens[key]);
    }
    const total = totalTokenContribution(tokens);
    if (isNum(total)) {
      group.total.push(total);
      group.knownTotalTokenRows += 1;
    }
    if (isNum(attempt.elapsedMs)) {
      group.elapsed.push(attempt.elapsedMs);
      group.knownTimeRows += 1;
    }
  }

  const tasks = [...groups.values()].map((group) => ({
    taskId: group.taskId,
    assignmentId: group.assignmentId,
    round: group.round,
    role: group.role,
    totalTokens: sumKnown(group.total),
    inputTokens: sumKnown(group.input),
    cachedInputTokens: sumKnown(group.cached),
    outputTokens: sumKnown(group.output),
    elapsedMs: sumKnown(group.elapsed),
    models: Object.fromEntries(group.models),
    state: group.state,
    unknownTokenRows: group.knownTotalTokenRows === 0 ? null : group.attempts - group.knownTotalTokenRows,
    unknownTimeRows: group.knownTimeRows === 0 ? null : group.attempts - group.knownTimeRows,
  }));
  tasks.sort((a, b) => String(a.assignmentId || a.taskId || '').localeCompare(String(b.assignmentId || b.taskId || '')));

  const total = {};
  for (const key of TOKEN_FIELDS) {
    total[key] = key === 'totalTokens'
      ? sumKnown(report.attempts.map((attempt) => totalTokenContribution(attempt.tokens)))
      : sumKnown(report.attempts.map((attempt) => attempt.tokens?.[key]));
  }
  total.attempts = report.attempts.length;
  return { schema: 'task-metrics/v1', generatedAt: report.generatedAt, contextId, total, tasks };
}

function attemptRecord(projectId, contextId, attempt, taskState, collectedAt) {
  const record = {
    project_id: projectId,
    session_id: contextId,
    run_id: attempt.runId,
    entry_id: attempt.entryId,
    kind: attempt.kind,
    assignment_id: attempt.assignmentId,
    round: attempt.round,
    role: attempt.role,
    task_id: attempt.taskId,
    model: attempt.model,
    effort: attempt.effort,
    started_at: attempt.startedAt,
    elapsed_ms: attempt.elapsedMs,
    retries: attempt.retries,
    queue_wait_ms: attempt.queueWaitMs,
    startup_ms: attempt.startupMs,
    cold_start: attempt.coldStart == null ? null : (attempt.coldStart ? 1 : 0),
    outcome: attempt.outcome,
    permission_denials: attempt.permissionDenials,
    reported_verdict: attempt.reportedVerdict,
    checks_passed: attempt.checks?.passed ?? null,
    checks_failed: attempt.checks?.failed ?? null,
    checks_not_run: attempt.checks?.notRun ?? null,
    checks_unknown: attempt.checks?.unknown ?? null,
    receipt_status: attempt.review?.status ?? null,
    receipt_accepted: attempt.review?.accepted == null ? null : (attempt.review.accepted ? 1 : 0),
    receipt_valid: attempt.review?.valid == null ? null : (attempt.review.valid ? 1 : 0),
    receipt_verdict: attempt.review?.verdict ?? null,
    receipt_reason: attempt.review?.reason ?? null,
    task_state: taskState ?? null,
    collected_at: collectedAt,
  };
  for (const [source, target] of ATTEMPT_TOKEN_FIELDS) record[target] = isNum(attempt.tokens?.[source]) ? attempt.tokens[source] : null;
  return record;
}

function upsertAttempts(db, records) {
  if (!records.length) return;
  const keys = Object.keys(records[0]);
  const values = keys.map((key) => `@${key}`).join(', ');
  const updates = keys.filter((key) => !['project_id', 'session_id', 'entry_id'].includes(key))
    .map((key) => `${key} = excluded.${key}`).join(', ');
  const statement = db.prepare(`INSERT INTO performance_attempts (${keys.join(', ')}) VALUES (${values})
    ON CONFLICT(project_id, session_id, entry_id) DO UPDATE SET ${updates}`);
  const insertAll = db.transaction((rows) => { for (const row of rows) statement.run(row); });
  insertAll(records);
}

function writeSnapshotAtomic(snapshotDir, projectId, contextId, snapshot) {
  validateIds(projectId, contextId);
  const root = path.resolve(snapshotDir);
  const projectDir = path.join(root, projectId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    if (fs.lstatSync(projectDir).isSymbolicLink()) throw new Error('snapshot project directory must not be a symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const target = path.join(projectDir, `${contextId}.json`);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('snapshot target must not be a symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = path.join(projectDir, `.${contextId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) {}
  }
  return target;
}

function collectOnce(options) {
  const projectId = options.projectId;
  const contextId = options.contextId;
  validateIds(projectId, contextId);
  const statePath = path.resolve(options.statePath);
  const metricsDbPath = path.resolve(options.metricsDbPath || path.join(path.dirname(statePath), 'performance.sqlite'));
  const snapshotDir = path.resolve(options.snapshotDir || path.join(__dirname, '..', 'launcher-ui', 'metrics'));
  ensureDistinctDatabases(statePath, metricsDbPath);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const stateDb = new Database(statePath, { readonly: true, fileMustExist: true });
  let metricsDb;
  try {
    const report = sessionPerformance(stateDb, contextId, { generatedAt });
    if (!report) throw new Error('session not found');
    const snapshot = buildSnapshot(stateDb, projectId, contextId, report);
    const leadIds = sessionLeadTaskIds(stateDb, contextId);
    const assignments = assignmentRows(stateDb, leadIds);
    const states = taskStates(stateDb, leadIds, report, assignments);
    const journalStates = assignmentStates(assignments);
    fs.mkdirSync(path.dirname(metricsDbPath), { recursive: true, mode: 0o700 });
    metricsDb = new Database(metricsDbPath);
    fs.chmodSync(metricsDbPath, 0o600);
    createPerformanceTable(metricsDb);
    const collectedAt = new Date().toISOString();
    const records = report.attempts.map((attempt) => {
      const taskId = attempt.kind === 'lead_turn' ? attempt.runId : attempt.taskId;
      const state = (taskId ? states.get(taskId) : null)
        ?? journalStates.get(groupKey(attempt.taskId, attempt.assignmentId, attempt.runId))?.state
        ?? null;
      return attemptRecord(projectId, contextId, attempt, state, collectedAt);
    });
    upsertAttempts(metricsDb, records);
    const snapshotPath = writeSnapshotAtomic(snapshotDir, projectId, contextId, snapshot);
    return { report, snapshot, snapshotPath, metricsDbPath, upserted: records.length };
  } finally {
    if (metricsDb?.open) metricsDb.close();
    if (stateDb.open) stateDb.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  while (true) {
    const metricsDbPath = options.metricsDbPath || path.join(path.dirname(path.resolve(options.statePath)), 'performance.sqlite');
    collectOnce({ ...options, metricsDbPath });
    if (!options.watchMs) return;
    await new Promise((resolve) => setTimeout(resolve, options.watchMs));
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`performance collection failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  validateIds,
  ensureDistinctDatabases,
  createPerformanceTable,
  buildSnapshot,
  attemptRecord,
  upsertAttempts,
  writeSnapshotAtomic,
  collectOnce,
  main,
};
