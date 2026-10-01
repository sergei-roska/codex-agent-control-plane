'use strict';

// Per-turn usage ledger in the state database. Rows are keyed by a stable entry id so resume and
// re-collection can never double count. Unknown values stay null; nothing is coerced to 0.

const KINDS = new Set(['worker_turn', 'lead_turn', 'intake_turn']);

function createUsageLedgerTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      entry_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      run_id TEXT,
      role TEXT NOT NULL,
      task_id TEXT,
      context_id TEXT,
      attempt_id TEXT,
      model TEXT,
      effort TEXT,
      started_at TEXT,
      elapsed_ms INTEGER,
      turns INTEGER,
      model_requests INTEGER,
      retries INTEGER,
      tokens_json TEXT,
      token_source TEXT,
      cumulative_total_json TEXT,
      app_server_version TEXT,
      outcome TEXT,
      permission_events_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_ledger_task_idx ON usage_ledger (task_id);
    CREATE INDEX IF NOT EXISTS usage_ledger_run_idx ON usage_ledger (run_id);
    CREATE INDEX IF NOT EXISTS usage_ledger_context_idx ON usage_ledger (context_id);
  `);
  // Requested/reported settings (M5): idempotent add for databases created before the columns existed.
  const columns = new Set(db.prepare('PRAGMA table_info(usage_ledger)').all().map((column) => column.name));
  for (const name of ['requested_json', 'reported_json']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE usage_ledger ADD COLUMN ${name} TEXT`);
  }
}

const orNull = (value) => (value === undefined ? null : value);
const jsonOrNull = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const parseOrNull = (text) => (text == null ? null : JSON.parse(text));

function fromRow(row) {
  return {
    entryId: row.entry_id,
    kind: row.kind,
    runId: row.run_id,
    role: row.role,
    taskId: row.task_id,
    contextId: row.context_id,
    attemptId: row.attempt_id,
    model: row.model,
    effort: row.effort,
    requested: parseOrNull(row.requested_json ?? null),
    reported: parseOrNull(row.reported_json ?? null),
    startedAt: row.started_at,
    elapsedMs: row.elapsed_ms,
    turns: row.turns,
    modelRequests: row.model_requests,
    retries: row.retries,
    tokens: parseOrNull(row.tokens_json),
    tokenSource: row.token_source,
    cumulativeTotal: parseOrNull(row.cumulative_total_json),
    appServerVersion: row.app_server_version,
    outcome: row.outcome,
    permissionEvents: parseOrNull(row.permission_events_json) || [],
    recordedAt: row.recorded_at,
  };
}

class UsageLedger {
  constructor({ db, readonly = false }) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('UsageLedger requires a better-sqlite3 db');
    this.db = db;
    if (!readonly) createUsageLedgerTable(db);
    // A readonly handle on a pre-M5 database has no requested/reported columns and never inserts.
    this.insert = readonly ? null : db.prepare(`
      INSERT OR IGNORE INTO usage_ledger
        (entry_id, kind, run_id, role, task_id, context_id, attempt_id, model, effort, started_at, elapsed_ms,
         turns, model_requests, retries, tokens_json, token_source, cumulative_total_json, app_server_version,
         outcome, permission_events_json, recorded_at, requested_json, reported_json)
      VALUES
        (@entry_id, @kind, @run_id, @role, @task_id, @context_id, @attempt_id, @model, @effort, @started_at, @elapsed_ms,
         @turns, @model_requests, @retries, @tokens_json, @token_source, @cumulative_total_json, @app_server_version,
         @outcome, @permission_events_json, @recorded_at, @requested_json, @reported_json)
    `);
    this.countByContext = db.prepare(
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE kind = 'worker_turn' AND context_id = ?");
    this.selectTask = db.prepare('SELECT * FROM usage_ledger WHERE task_id = ? ORDER BY recorded_at, rowid');
    this.selectLead = db.prepare(
      "SELECT * FROM usage_ledger WHERE kind = 'lead_turn' AND run_id = ? ORDER BY recorded_at, rowid");
    // A task id can be reused by a retry attempt only through the journal, so join on both columns.
    this.selectWorkersSql = (`
      SELECT u.*, j.attempt_id AS j_attempt_id, j.run_id AS j_run_id
      FROM usage_ledger u
      JOIN dispatch_journal j ON j.task_id = u.task_id AND j.run_id = ?
      WHERE u.kind = 'worker_turn'
      ORDER BY u.recorded_at, u.rowid
    `);
    // Lost submissions: the journal has no (or another) task id, but the A2A context matches.
    this.selectWorkersByContextSql = (`
      SELECT u.*, j.attempt_id AS j_attempt_id, j.run_id AS j_run_id
      FROM usage_ledger u
      JOIN dispatch_journal j ON j.context_id = u.context_id AND j.run_id = ?
      WHERE u.kind = 'worker_turn' AND u.context_id IS NOT NULL
      ORDER BY u.recorded_at, u.rowid
    `);
    this.selectWorkers = null;
    this.selectWorkersByContext = null;
  }

  /** Number of worker rows already recorded for a context (retries of the same assignment). */
  workerRowsForContext(contextId) {
    if (contextId == null) return 0;
    return this.countByContext.get(contextId).n;
  }

  /** Insert-or-ignore. Returns true when a new row was written. */
  record(entry) {
    if (!entry || typeof entry.entryId !== 'string' || !entry.entryId) throw new TypeError('entryId is required');
    if (!KINDS.has(entry.kind)) throw new TypeError(`Invalid usage kind "${entry.kind}"`);
    if (typeof entry.role !== 'string' || !entry.role) throw new TypeError('role is required');
    const info = this.insert.run({
      entry_id: entry.entryId,
      kind: entry.kind,
      run_id: orNull(entry.runId),
      role: entry.role,
      task_id: orNull(entry.taskId),
      context_id: orNull(entry.contextId),
      attempt_id: orNull(entry.attemptId),
      model: orNull(entry.model),
      effort: orNull(entry.effort),
      started_at: orNull(entry.startedAt),
      elapsed_ms: orNull(entry.elapsedMs),
      turns: orNull(entry.turns),
      model_requests: orNull(entry.modelRequests),
      retries: orNull(entry.retries),
      tokens_json: jsonOrNull(entry.tokens),
      token_source: orNull(entry.tokenSource),
      cumulative_total_json: jsonOrNull(entry.cumulativeTotal),
      app_server_version: orNull(entry.appServerVersion),
      outcome: orNull(entry.outcome),
      permission_events_json: JSON.stringify(entry.permissionEvents || []),
      recorded_at: entry.recordedAt || new Date().toISOString(),
      requested_json: jsonOrNull(entry.requested),
      reported_json: jsonOrNull(entry.reported),
    });
    return info.changes > 0;
  }

  listByTask(taskId) {
    return this.selectTask.all(taskId).map(fromRow);
  }

  /** Lead rows of the run plus worker rows linked through the dispatch journal. */
  listByRun(runId) {
    const lead = this.selectLead.all(runId).map(fromRow);
    const seen = new Set();
    const workers = [];
    if (!this.selectWorkers) {
      const hasJournal = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_journal'").get();
      if (!hasJournal) return lead;
      this.selectWorkers = this.db.prepare(this.selectWorkersSql);
      this.selectWorkersByContext = this.db.prepare(this.selectWorkersByContextSql);
    }
    const joined = [...this.selectWorkers.all(runId), ...this.selectWorkersByContext.all(runId)];
    for (const row of joined) {
      if (seen.has(row.entry_id)) continue;
      seen.add(row.entry_id);
      const entry = fromRow(row);
      entry.attemptId = row.j_attempt_id;
      entry.runId = row.j_run_id;
      workers.push(entry);
    }
    return [...lead, ...workers];
  }
}

module.exports = { UsageLedger, createUsageLedgerTable, fromRow };
