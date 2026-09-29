'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Kysely, Migrator, SqliteDialect, sql } = require('kysely');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');
const { TaskState } = require('@a2a-js/sdk');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { DatabaseTaskStore } = require('@a2a-js/sdk/server/database');

const DEFAULT_STATE_DB = path.resolve(__dirname, '..', '.runtime', 'state.sqlite');
const BUSY_TIMEOUT_MS = 5000;
const TASK_TABLE = 'tasks';
const JOURNAL_STATES = new Set(['submitting', 'submitted', 'finished']);

const INTERRUPTED_SPECIALIST_TEXT = 'Interrupted by server restart before completion; workspace effects are unknown.';
const INTERRUPTED_LEAD_TEXT = 'Run interrupted by server restart. Send a message to this task to resume.';

function stateDbPath(filePath = process.env.CODEX_A2A_STATE_DB || DEFAULT_STATE_DB) {
  return path.resolve(filePath);
}

// ---------------------------------------------------------------- ids

function assignmentId(runId, round, index) {
  return `${runId}:r${round}:a${index}`;
}

function attemptId(assignment) {
  return `${assignment}:t1`;
}

function deterministicContextId(attempt) {
  const hex = crypto.createHash('sha256').update(String(attempt), 'utf8').digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

// ------------------------------------------------------------ database

// Same DDL and ledger the SDK's `a2a-db` CLI applies for its task store (the CLI does not
// export its migrations), so `a2a-db` sees the schema as already upgraded.
function taskMigrations(tableName) {
  return {
    '0001_create_tasks': {
      async up(db) {
        const collated255 = sql.raw('varchar(255) collate binary');
        const collated36 = sql.raw('varchar(36) collate binary');
        await db.schema.createTable(tableName)
          .addColumn('tenant', collated255, (column) => column.notNull())
          .addColumn('owner', collated255, (column) => column.notNull())
          .addColumn('id', collated36, (column) => column.notNull())
          .addColumn('context_id', collated36, (column) => column.notNull())
          .addColumn('status_last_updated', 'bigint', (column) => column.notNull())
          .addColumn('status_state', collated255)
          .addColumn('status', 'text')
          .addColumn('artifacts', 'text')
          .addColumn('history', 'text')
          .addColumn('metadata', 'text')
          .addColumn('protocol_version', 'varchar(255)')
          .addPrimaryKeyConstraint(`${tableName}_pkey`, ['tenant', 'owner', 'id'])
          .execute();
        await db.schema.createIndex(`${tableName}_scope_updated_idx`).on(tableName)
          .columns(['tenant', 'owner', 'status_last_updated', 'id']).execute();
        await db.schema.createIndex(`${tableName}_scope_context_updated_idx`).on(tableName)
          .columns(['tenant', 'owner', 'context_id', 'status_last_updated', 'id']).execute();
      },
    },
  };
}

async function migrateTaskStore(kysely) {
  const migrator = new Migrator({
    db: kysely,
    provider: { getMigrations: () => Promise.resolve(taskMigrations(TASK_TABLE)) },
    migrationTableName: `a2a_${TASK_TABLE}_migrations`,
    migrationLockTableName: 'a2a_migrations_lock',
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

function createJournalTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_journal (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      role TEXT NOT NULL,
      sandbox TEXT NOT NULL,
      context_id TEXT NOT NULL,
      task_id TEXT,
      state TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dispatch_journal_run_idx ON dispatch_journal (run_id, created_at);
  `);
}

async function openStateDatabase({ filePath } = {}) {
  const inMemory = filePath === ':memory:';
  const target = inMemory ? filePath : stateDbPath(filePath);
  if (!inMemory) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    // Create the file with 0600 before SQLite does; WAL side files inherit its mode.
    try {
      fs.closeSync(fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((fs.statSync(target).mode & 0o777) !== 0o600) fs.chmodSync(target, 0o600);
    }
  }

  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const kysely = new Kysely({ dialect: new SqliteDialect({ database: db }) });
  try {
    await migrateTaskStore(kysely);
    createJournalTable(db);
  } catch (error) {
    await kysely.destroy();
    throw error;
  }
  // One connection shared by all three users: better-sqlite3 is synchronous, so the
  // checkpointer, Kysely, and the journal never interleave inside a statement.
  const checkpointer = new SqliteSaver(db);
  let closed = false;
  return {
    filePath: target,
    db,
    kysely,
    checkpointer,
    async close() {
      if (closed) return;
      closed = true;
      await kysely.destroy(); // closes the shared better-sqlite3 handle
      if (db.open) db.close();
    },
  };
}

// ------------------------------------------------------------ instance lock

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * Take an exclusive `<stateFile>.lock` (O_EXCL, holds our pid). A lock whose pid is dead is
 * stale and replaced; a live one fails with a clear error. Returns a release function.
 * In-memory state has nothing to protect and returns a no-op.
 */
function acquireStateLock(filePath) {
  if (filePath === ':memory:') return () => {};
  const lockPath = `${stateDbPath(filePath)}.lock`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10) === process.pid) fs.unlinkSync(lockPath);
        } catch (_) { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = Number.NaN;
    try { holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      throw new Error(`State file ${stateDbPath(filePath)} is in use by pid ${holder}`);
    }
    try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Could not acquire the state lock ${lockPath}`);
}

// ---------------------------------------------------------- task store

function createTaskStore(state, namespace) {
  if (typeof namespace !== 'string' || !namespace) throw new TypeError('A task store namespace is required');
  return new DatabaseTaskStore(state.kysely, {
    tableName: TASK_TABLE,
    ownerResolver: () => namespace,
  });
}

// ------------------------------------------------------------- journal

function nowIso() {
  return new Date().toISOString();
}

function parseResult(json) {
  if (json === null || json === undefined) return null;
  return JSON.parse(json);
}

function fromRow(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    assignmentId: row.assignment_id,
    role: row.role,
    sandbox: row.sandbox,
    contextId: row.context_id,
    taskId: row.task_id,
    state: row.state,
    result: parseResult(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireFields(row) {
  for (const key of ['attemptId', 'runId', 'assignmentId', 'role', 'sandbox', 'contextId']) {
    if (typeof row?.[key] !== 'string' || !row[key]) throw new TypeError(`Journal row requires ${key}`);
  }
}

class DispatchJournal {
  constructor(stateOrDb) {
    this.db = stateOrDb.db || stateOrDb;
    createJournalTable(this.db);
    this.selectOne = this.db.prepare('SELECT * FROM dispatch_journal WHERE attempt_id = ?');
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO dispatch_journal
        (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'submitting', NULL, ?, ?)`);
    this.markSubmitted = this.db.prepare(
      "UPDATE dispatch_journal SET task_id = ?, state = 'submitted', updated_at = ? WHERE attempt_id = ?");
    this.markFinished = this.db.prepare(
      "UPDATE dispatch_journal SET state = 'finished', result_json = ?, updated_at = ? WHERE attempt_id = ?");
    this.selectRun = this.db.prepare('SELECT * FROM dispatch_journal WHERE run_id = ? ORDER BY created_at, rowid');
  }

  recordSubmitting(row) {
    requireFields(row);
    const at = nowIso();
    this.insert.run(row.attemptId, row.runId, row.assignmentId, row.role, row.sandbox, row.contextId, at, at);
    return this.get(row.attemptId);
  }

  recordSubmitted(attempt, taskId) {
    const info = this.markSubmitted.run(taskId, nowIso(), attempt);
    if (info.changes === 0) throw new Error(`Unknown dispatch attempt: ${attempt}`);
    return this.get(attempt);
  }

  recordFinished(attempt, result) {
    const info = this.markFinished.run(JSON.stringify(result ?? null), nowIso(), attempt);
    if (info.changes === 0) throw new Error(`Unknown dispatch attempt: ${attempt}`);
    return this.get(attempt);
  }

  get(attempt) {
    return fromRow(this.selectOne.get(attempt));
  }

  listByRun(runId) {
    return this.selectRun.all(runId).map(fromRow);
  }
}

class InMemoryDispatchJournal {
  constructor() {
    this.rows = new Map();
  }

  recordSubmitting(row) {
    requireFields(row);
    if (!this.rows.has(row.attemptId)) {
      const at = nowIso();
      this.rows.set(row.attemptId, {
        attemptId: row.attemptId,
        runId: row.runId,
        assignmentId: row.assignmentId,
        role: row.role,
        sandbox: row.sandbox,
        contextId: row.contextId,
        taskId: null,
        state: 'submitting',
        result: null,
        createdAt: at,
        updatedAt: at,
      });
    }
    return this.get(row.attemptId);
  }

  update(attempt, changes) {
    const row = this.rows.get(attempt);
    if (!row) throw new Error(`Unknown dispatch attempt: ${attempt}`);
    Object.assign(row, changes, { updatedAt: nowIso() });
    return this.get(attempt);
  }

  recordSubmitted(attempt, taskId) {
    return this.update(attempt, { taskId, state: 'submitted' });
  }

  recordFinished(attempt, result) {
    return this.update(attempt, { state: 'finished', result: JSON.parse(JSON.stringify(result ?? null)) });
  }

  get(attempt) {
    const row = this.rows.get(attempt);
    return row ? JSON.parse(JSON.stringify(row)) : null;
  }

  listByRun(runId) {
    return [...this.rows.values()].filter((row) => row.runId === runId).map((row) => this.get(row.attemptId));
  }
}

// ------------------------------------------------------ reconciliation

function statusMessage(task, text, metadata) {
  return {
    messageId: `${task.id}-interrupted`,
    contextId: task.contextId,
    taskId: task.id,
    role: 2,
    parts: [{ content: { $case: 'text', value: text } }],
    metadata,
  };
}

async function reconcileInterruptedTasks(state, { leadNamespace = 'orchestrator' } = {}) {
  const candidates = state.db.prepare(
    'SELECT tenant, owner, id FROM tasks WHERE status_state IN (?, ?) ORDER BY owner, id',
  ).all('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING');

  const result = { specialists: [], lead: [] };
  const stores = new Map();
  for (const { tenant, owner, id } of candidates) {
    if (!stores.has(owner)) stores.set(owner, createTaskStore(state, owner));
    const store = stores.get(owner);
    const context = new ServerCallContext({ tenant });
    const task = await store.load(id, context);
    if (!task) continue;
    const working = task.status?.state === TaskState.TASK_STATE_SUBMITTED
      || task.status?.state === TaskState.TASK_STATE_WORKING;
    if (!working) continue;

    if (owner === leadNamespace) {
      task.status = {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: statusMessage(task, INTERRUPTED_LEAD_TEXT),
        timestamp: new Date().toISOString(),
      };
      task.metadata = { ...(task.metadata || {}), pause: { kind: 'restart' } };
      result.lead.push(id);
    } else {
      task.status = {
        state: TaskState.TASK_STATE_FAILED,
        message: statusMessage(task, INTERRUPTED_SPECIALIST_TEXT, { failureKind: 'interrupted' }),
        timestamp: new Date().toISOString(),
      };
      result.specialists.push(id);
    }
    await store.save(task, context);
  }
  return result;
}

module.exports = {
  acquireStateLock,
  DEFAULT_STATE_DB,
  DispatchJournal,
  InMemoryDispatchJournal,
  JOURNAL_STATES,
  assignmentId,
  attemptId,
  createTaskStore,
  deterministicContextId,
  openStateDatabase,
  reconcileInterruptedTasks,
  stateDbPath,
};
