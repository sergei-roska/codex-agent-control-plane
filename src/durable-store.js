'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
      updated_at TEXT NOT NULL,
      objective_sha256 TEXT
    );
    CREATE INDEX IF NOT EXISTS dispatch_journal_run_idx ON dispatch_journal (run_id, created_at);
  `);
  // Existing state files predate objective_sha256.
  const columns = db.prepare("PRAGMA table_info('dispatch_journal')").all();
  if (!columns.some((column) => column.name === 'objective_sha256')) {
    db.exec('ALTER TABLE dispatch_journal ADD COLUMN objective_sha256 TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_call_bindings (
      invocation_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      task_id TEXT,
      account_id_sha256 TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      UNIQUE (attempt_id, invocation_id)
    );
    CREATE INDEX IF NOT EXISTS dispatch_call_bindings_attempt_idx ON dispatch_call_bindings (attempt_id, bound_at, invocation_id);
  `);
  const bindingColumns = db.prepare("PRAGMA table_info('dispatch_call_bindings')").all();
  if (bindingColumns.find((column) => column.name === 'task_id')?.notnull) {
    db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS dispatch_call_bindings_attempt_idx;
        ALTER TABLE dispatch_call_bindings RENAME TO dispatch_call_bindings_legacy;
        CREATE TABLE dispatch_call_bindings (
          invocation_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          assignment_id TEXT NOT NULL,
          task_id TEXT,
          account_id_sha256 TEXT NOT NULL,
          bound_at TEXT NOT NULL,
          UNIQUE (attempt_id, invocation_id)
        );
        INSERT INTO dispatch_call_bindings SELECT * FROM dispatch_call_bindings_legacy;
        DROP TABLE dispatch_call_bindings_legacy;
        CREATE INDEX dispatch_call_bindings_attempt_idx ON dispatch_call_bindings (attempt_id, bound_at, invocation_id);
      `);
    })();
  }
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
  // FULL: every commit is fsynced, so intent rows are durable before the effect they guard (intent-recovery/v1 D1).
  db.pragma('synchronous = FULL');
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

/**
 * Take a kernel-held exclusive lock: a small SQLite file with `BEGIN EXCLUSIVE` kept open for
 * the holder's lifetime. The kernel drops it when the process dies, so nothing is ever stale
 * and there is no takeover. A second holder (any process or connection) gets SQLITE_BUSY and
 * fails via inUseMessage(lockPath). Returns a release function.
 */
function acquireKernelLock(lockPath, inUseMessage) {
  let db = null;
  try {
    db = new Database(lockPath, { timeout: 0 });
    // A read-only lock file still grants BEGIN EXCLUSIVE to several processes: refuse it.
    if (db.readonly) throw new Error(`Cannot hold lock ${lockPath}: lock file is not writable`);
    try { fs.accessSync(lockPath, fs.constants.W_OK); } catch (_) {
      throw new Error(`Cannot hold lock ${lockPath}: lock file is not writable`);
    }
    db.pragma('busy_timeout = 0');
    try { db.pragma('journal_mode = DELETE'); } catch (error) { if (!/^SQLITE_BUSY/.test(error.code || '')) throw error; }
    db.exec('CREATE TABLE IF NOT EXISTS holder(x)');
    db.exec('BEGIN EXCLUSIVE');
    // A real write under the exclusive lock: a connection that cannot write fails here, not later.
    db.exec('INSERT INTO holder VALUES (1)');
  } catch (error) {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
    if (/^SQLITE_BUSY|^SQLITE_LOCKED/.test(error.code || '')) throw new Error(inUseMessage(lockPath));
    if (/^Cannot hold lock /.test(error.message)) throw error;
    throw new Error(`Cannot open lock ${lockPath}: ${error.message}`, { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec('ROLLBACK'); } catch (_) { /* connection already closed */ }
    try { db.close(); } catch (_) { /* ignore */ }
  };
}

/**
 * Take an exclusive `<stateFile>.lockdb`. In-memory state has nothing to protect and returns
 * a no-op. An old `<stateFile>.lock` text file is ignored.
 */
function acquireStateLock(filePath) {
  if (filePath === ':memory:') return () => {};
  const lockPath = `${stateDbPath(filePath)}.lockdb`;
  return acquireKernelLock(lockPath, (held) => `State file ${stateDbPath(filePath)} is in use (lock held: ${held})`);
}

function repoCommonDir(workspace) {
  try {
    const out = execFileSync('git', ['-C', workspace, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? path.resolve(workspace, out) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Take an exclusive per-workspace lock so two servers with different state files cannot
 * share one workspace. The lock identity is the realpath of the git common dir (one lock per
 * repository, so nested workspaces exclude each other) or, outside git, the canonical
 * workspace. The file is `<common dir>/codex-a2a-writer.lockdb` by default; with `lockDir` it
 * is `<lockDir>/codex-a2a-writer-<hash of identity>.lockdb`; non-git without `lockDir` uses
 * the OS temp dir.
 */
function acquireWorkspaceLock(workspace, { lockDir = process.env.CODEX_A2A_WORKSPACE_LOCK_DIR || null } = {}) {
  const canonical = fs.realpathSync(workspace);
  const common = repoCommonDir(canonical);
  const isRepo = Boolean(common && fs.existsSync(common));
  const identity = isRepo ? fs.realpathSync(common) : canonical;
  let lockPath;
  if (!lockDir && isRepo) {
    lockPath = path.join(identity, 'codex-a2a-writer.lockdb');
  } else {
    const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
    const dir = lockDir || os.tmpdir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lockPath = path.join(dir, `codex-a2a-writer-${digest}.lockdb`);
  }
  return acquireKernelLock(lockPath, (held) => `Workspace ${canonical} is in use (lock held: ${held})`);
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
    objectiveSha256: row.objective_sha256 ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireFields(row) {
  for (const key of ['attemptId', 'runId', 'assignmentId', 'role', 'sandbox', 'contextId']) {
    if (typeof row?.[key] !== 'string' || !row[key]) throw new TypeError(`Journal row requires ${key}`);
  }
}

const CALL_BINDING_FIELDS = ['invocationId', 'attemptId', 'runId', 'assignmentId', 'taskId', 'accountId', 'boundAt'];

function normalizeCallBinding(row) {
  for (const key of CALL_BINDING_FIELDS) {
    if (key === 'taskId' && row?.taskId === null) continue;
    if (typeof row?.[key] !== 'string' || !row[key]) throw new TypeError(`Call binding requires ${key}`);
  }
  if (!/^[0-9a-f]{64}$/.test(row.accountId)) throw new TypeError('Call binding accountId must be a SHA-256 digest');
  const time = new Date(row.boundAt);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== row.boundAt) throw new TypeError('Call binding boundAt must be an ISO timestamp');
  return Object.fromEntries(CALL_BINDING_FIELDS.map((key) => [key, row[key]]));
}

function callBindingFromRow(row) {
  if (!row) return null;
  return {
    invocationId: row.invocation_id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    assignmentId: row.assignment_id,
    taskId: row.task_id,
    accountId: row.account_id_sha256,
    boundAt: row.bound_at,
  };
}

class CallBindingConflictError extends Error {
  constructor(invocationId) {
    super(`Provider call binding conflict for invocation ${invocationId}`);
    this.name = 'CallBindingConflictError';
    this.code = 'call_binding_conflict';
    this.invocationId = invocationId;
  }
}

class JournalTransitionError extends Error {
  constructor(attempt, from, to, detail) {
    super(`Journal transition refused for ${attempt}: ${from} -> ${to}${detail ? ` (${detail})` : ''}`);
    this.name = 'JournalTransitionError';
    this.code = 'journal_transition_refused';
    this.attemptId = attempt;
    this.from = from;
    this.to = to;
  }
}

class DispatchJournal {
  constructor(stateOrDb) {
    this.db = stateOrDb.db || stateOrDb;
    createJournalTable(this.db);
    this.selectOne = this.db.prepare('SELECT * FROM dispatch_journal WHERE attempt_id = ?');
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO dispatch_journal
        (attempt_id, run_id, assignment_id, role, sandbox, context_id, task_id, state, result_json, created_at, updated_at, objective_sha256)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'submitting', NULL, ?, ?, ?)`);
    this.markSubmitted = this.db.prepare(
      "UPDATE dispatch_journal SET task_id = ?, state = 'submitted', updated_at = ? WHERE attempt_id = ? AND (state = 'submitting' OR (state = 'submitted' AND task_id = ?))");
    this.markFinished = this.db.prepare(
      "UPDATE dispatch_journal SET state = 'finished', result_json = ?, updated_at = ? WHERE attempt_id = ? AND state IN ('submitting', 'submitted')");
    this.selectRun = this.db.prepare('SELECT * FROM dispatch_journal WHERE run_id = ? ORDER BY created_at, rowid');
    this.insertCallBinding = this.db.prepare(`
      INSERT OR IGNORE INTO dispatch_call_bindings
        (invocation_id, attempt_id, run_id, assignment_id, task_id, account_id_sha256, bound_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.selectCallBinding = this.db.prepare('SELECT * FROM dispatch_call_bindings WHERE invocation_id = ?');
    this.selectCallBindingsByAttempt = this.db.prepare('SELECT * FROM dispatch_call_bindings WHERE attempt_id = ? ORDER BY rowid');
  }

  recordSubmitting(row) {
    requireFields(row);
    const at = nowIso();
    this.insert.run(row.attemptId, row.runId, row.assignmentId, row.role, row.sandbox, row.contextId, at, at, row.objectiveSha256 ?? null);
    return this.get(row.attemptId);
  }

  recordSubmitted(attempt, taskId) {
    const info = this.markSubmitted.run(taskId, nowIso(), attempt, taskId);
    if (info.changes === 0) {
      const row = this.get(attempt);
      if (!row) throw new Error(`Unknown dispatch attempt: ${attempt}`);
      throw new JournalTransitionError(attempt, row.state, 'submitted');
    }
    return this.get(attempt);
  }

  recordFinished(attempt, result) {
    const json = JSON.stringify(result ?? null);
    const info = this.markFinished.run(json, nowIso(), attempt);
    if (info.changes === 0) {
      const raw = this.selectOne.get(attempt);
      if (!raw) throw new Error(`Unknown dispatch attempt: ${attempt}`);
      // An identical second result is a replay: no-op. Anything else on a finished row is refused.
      if (raw.state === 'finished' && raw.result_json === json) return this.get(attempt);
      throw new JournalTransitionError(attempt, raw.state, 'finished', 'different result');
    }
    return this.get(attempt);
  }

  get(attempt) {
    return fromRow(this.selectOne.get(attempt));
  }

  listByRun(runId) {
    return this.selectRun.all(runId).map(fromRow);
  }

  recordCallBound(input) {
    const row = normalizeCallBinding(input);
    return this.db.transaction(() => {
      const existing = this.getCallBinding(row.invocationId);
      if (existing) {
        if (CALL_BINDING_FIELDS.every((key) => existing[key] === row[key])) return existing;
        throw new CallBindingConflictError(row.invocationId);
      }
      let attempt = this.get(row.attemptId);
      if (!attempt || attempt.runId !== row.runId || attempt.assignmentId !== row.assignmentId
        || attempt.state === 'finished'
        || (row.taskId === null
          ? attempt.role !== 'coordinator' || attempt.assignmentId !== `${row.runId}:lead-planning` || attempt.taskId !== null
          : attempt.role === 'coordinator' || (attempt.taskId && attempt.taskId !== row.taskId))) {
        throw new Error(`Provider call binding does not match an active dispatch attempt: ${row.attemptId}`);
      }
      if (row.taskId !== null && !attempt.taskId) {
        this.recordSubmitted(row.attemptId, row.taskId);
        attempt = this.get(row.attemptId);
      }
      this.insertCallBinding.run(row.invocationId, row.attemptId, row.runId, row.assignmentId, row.taskId, row.accountId, row.boundAt);
      const saved = this.getCallBinding(row.invocationId);
      if (saved && CALL_BINDING_FIELDS.every((key) => saved[key] === row[key])) return saved;
      throw new CallBindingConflictError(row.invocationId);
    })();
  }

  getCallBinding(invocationId) {
    return callBindingFromRow(this.selectCallBinding.get(invocationId));
  }

  listCallBindingsByAttempt(attemptId) {
    return this.selectCallBindingsByAttempt.all(attemptId).map(callBindingFromRow);
  }
}

class InMemoryDispatchJournal {
  constructor() {
    this.rows = new Map();
    this.callBindings = new Map();
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
        objectiveSha256: row.objectiveSha256 ?? null,
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
    const row = this.rows.get(attempt);
    if (!row) throw new Error(`Unknown dispatch attempt: ${attempt}`);
    if (row.state === 'submitted' && row.taskId === taskId) return this.get(attempt);
    if (row.state !== 'submitting') throw new JournalTransitionError(attempt, row.state, 'submitted');
    return this.update(attempt, { taskId, state: 'submitted' });
  }

  recordFinished(attempt, result) {
    const row = this.rows.get(attempt);
    if (!row) throw new Error(`Unknown dispatch attempt: ${attempt}`);
    const copy = JSON.parse(JSON.stringify(result ?? null));
    if (row.state === 'finished') {
      if (JSON.stringify(row.result) === JSON.stringify(copy)) return this.get(attempt);
      throw new JournalTransitionError(attempt, row.state, 'finished', 'different result');
    }
    return this.update(attempt, { state: 'finished', result: copy });
  }

  get(attempt) {
    const row = this.rows.get(attempt);
    return row ? JSON.parse(JSON.stringify(row)) : null;
  }

  listByRun(runId) {
    return [...this.rows.values()].filter((row) => row.runId === runId).map((row) => this.get(row.attemptId));
  }

  recordCallBound(input) {
    const row = normalizeCallBinding(input);
    const existing = this.callBindings.get(row.invocationId);
    if (existing) {
      if (CALL_BINDING_FIELDS.every((key) => existing[key] === row[key])) return { ...existing };
      throw new CallBindingConflictError(row.invocationId);
    }
    const attempt = this.rows.get(row.attemptId);
    if (!attempt || attempt.runId !== row.runId || attempt.assignmentId !== row.assignmentId
      || attempt.state === 'finished'
      || (row.taskId === null
        ? attempt.role !== 'coordinator' || attempt.assignmentId !== `${row.runId}:lead-planning` || attempt.taskId !== null
        : attempt.role === 'coordinator' || (attempt.taskId && attempt.taskId !== row.taskId))) {
      throw new Error(`Provider call binding does not match an active dispatch attempt: ${row.attemptId}`);
    }
    if (row.taskId !== null && !attempt.taskId) this.recordSubmitted(row.attemptId, row.taskId);
    this.callBindings.set(row.invocationId, row);
    return { ...row };
  }

  getCallBinding(invocationId) {
    const row = this.callBindings.get(invocationId);
    return row ? { ...row } : null;
  }

  listCallBindingsByAttempt(attemptId) {
    return [...this.callBindings.values()].filter((row) => row.attemptId === attemptId).map((row) => ({ ...row }));
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
  acquireKernelLock,
  acquireStateLock,
  acquireWorkspaceLock,
  DEFAULT_STATE_DB,
  DispatchJournal,
  InMemoryDispatchJournal,
  CallBindingConflictError,
  JournalTransitionError,
  JOURNAL_STATES,
  assignmentId,
  attemptId,
  createTaskStore,
  deterministicContextId,
  openStateDatabase,
  reconcileInterruptedTasks,
  stateDbPath,
};
