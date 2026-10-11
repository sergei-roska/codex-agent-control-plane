'use strict';

// One lead Codex thread per dashboard session (A2A contextId), in the shared state database.
// See docs/session-continuity-design.md. run_ids_json lists the runs of the session that took a
// lead turn, oldest first, so a rollover can show the final texts of the earlier ones.

const MAX_RUN_IDS = 50;

function createSessionThreadsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_threads (
      context_id TEXT PRIMARY KEY,
      thread_id TEXT,
      codex_home TEXT,
      last_input_tokens INTEGER,
      context_window INTEGER,
      rollovers INTEGER NOT NULL DEFAULT 0,
      run_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT,
      profile_sha256 TEXT
    );
  `);
  // Older state files have no context_window or profile_sha256 column.
  const columns = db.prepare("PRAGMA table_info('session_threads')").all();
  if (!columns.some((column) => column.name === 'context_window')) {
    db.exec('ALTER TABLE session_threads ADD COLUMN context_window INTEGER');
  }
  if (!columns.some((column) => column.name === 'profile_sha256')) {
    db.exec('ALTER TABLE session_threads ADD COLUMN profile_sha256 TEXT');
  }
}

function fromRow(row) {
  if (!row) return null;
  let runIds = [];
  try { runIds = JSON.parse(row.run_ids_json || '[]'); } catch (_) { runIds = []; }
  return {
    contextId: row.context_id,
    threadId: row.thread_id ?? null,
    codexHome: row.codex_home ?? null,
    lastInputTokens: row.last_input_tokens ?? null,
    contextWindow: row.context_window ?? null,
    profileSha256: row.profile_sha256 ?? null,
    rollovers: row.rollovers,
    runIds: Array.isArray(runIds) ? runIds : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class SessionThreads {
  constructor({ db } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('SessionThreads requires a better-sqlite3 db');
    this.db = db;
    createSessionThreadsTable(db);
    this.selectStmt = db.prepare('SELECT * FROM session_threads WHERE context_id = ?');
    this.insertStmt = db.prepare(`
      INSERT INTO session_threads (context_id, thread_id, codex_home, last_input_tokens, context_window, profile_sha256, rollovers, run_ids_json, created_at, updated_at)
      VALUES (@context_id, @thread_id, @codex_home, @last_input_tokens, @context_window, @profile_sha256, @rollovers, @run_ids_json, @now, @now)
    `);
    this.updateStmt = db.prepare(`
      UPDATE session_threads
      SET thread_id = @thread_id, codex_home = @codex_home, last_input_tokens = @last_input_tokens, context_window = @context_window, profile_sha256 = @profile_sha256,
          rollovers = @rollovers, run_ids_json = @run_ids_json, updated_at = @now
      WHERE context_id = @context_id
    `);
  }

  /** The session row or null. */
  get(contextId) {
    if (typeof contextId !== 'string' || !contextId) return null;
    return fromRow(this.selectStmt.get(contextId));
  }

  /**
   * Records the thread of a session after a lead turn. lastInputTokens is the context size (input of the
   * last model request) and contextWindow the model window, either may be null when unknown. `rolledOver` adds one to the rollover count;
   * `runId` is appended to the session's run list (once). `profileSha256` is the hash of the lead profile the thread
   * runs under; when omitted the stored one is kept.
   */
  upsert({ contextId, threadId, codexHome = null, lastInputTokens = null, contextWindow = null, runId = null, rolledOver = false, profileSha256 = null }) {
    if (typeof contextId !== 'string' || !contextId) throw new TypeError('contextId is required');
    const existing = this.get(contextId);
    const runIds = existing ? [...existing.runIds] : [];
    if (runId && !runIds.includes(runId)) runIds.push(runId);
    const params = {
      context_id: contextId,
      thread_id: threadId ?? null,
      codex_home: codexHome ?? null,
      last_input_tokens: Number.isFinite(lastInputTokens) ? Math.round(lastInputTokens) : null,
      context_window: Number.isFinite(contextWindow) ? Math.round(contextWindow) : null,
      profile_sha256: profileSha256 ?? existing?.profileSha256 ?? null,
      rollovers: (existing?.rollovers || 0) + (rolledOver ? 1 : 0),
      run_ids_json: JSON.stringify(runIds.slice(-MAX_RUN_IDS)),
      now: new Date().toISOString(),
    };
    if (existing) this.updateStmt.run(params);
    else this.insertStmt.run(params);
    return this.get(contextId);
  }
}

module.exports = { SessionThreads, createSessionThreadsTable };
