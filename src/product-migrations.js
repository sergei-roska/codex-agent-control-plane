'use strict';

const fs = require('node:fs');

const MIGRATION_1_SQL = `
CREATE TABLE tickets (
  ticket_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL,
  title TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL,
  current_revision_id TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL
);
CREATE INDEX tickets_updated_idx ON tickets (updated_at, ticket_id);
CREATE TABLE requirement_revisions (
  revision_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  parent_revision_id TEXT, ordinal INTEGER NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, criteria_json TEXT NOT NULL, references_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL, priority TEXT NOT NULL, tracking_mode TEXT NOT NULL,
  requested_specialty TEXT, actor TEXT NOT NULL, command_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (ticket_id, ordinal)
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY, ticket_id TEXT REFERENCES tickets(ticket_id),
  state TEXT NOT NULL, kind TEXT NOT NULL, media_type TEXT NOT NULL, display_name TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_ref TEXT NOT NULL,
  extraction TEXT NOT NULL, extracted_chars INTEGER, extraction_truncated INTEGER NOT NULL,
  origin TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE product_commands (
  command_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

const MIGRATIONS = [
  { version: 1, name: 'product_tickets', sql: MIGRATION_1_SQL },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
  if (Number.isNaN(date.getTime())) throw new Error('product migrations: invalid clock value');
  return date;
}

function resolveNow(now) {
  return toDate(typeof now === 'function' ? now() : now);
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasAnyTable(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get());
}

// Bookkeeping tables the state store fills on first open; they hold no operator data.
const STATE_BOOKKEEPING_TABLES = new Set(['a2a_tasks_migrations', 'a2a_migrations_lock']);

// True when every user table is empty, i.e. there is nothing worth backing up.
function allUserTablesEmpty(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .filter(({ name }) => !STATE_BOOKKEEPING_TABLES.has(name));
  return tables.every(({ name }) => !db.prepare(`SELECT 1 FROM "${String(name).replace(/"/g, '""')}" LIMIT 1`).get());
}

// Creates the backup target with mode 0600 from the start, so the copy is never readable by others.
function precreatePrivateFile(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  fs.closeSync(fd);
  if ((fs.statSync(filePath).mode & 0o777) !== 0o600) {
    throw new Error(`product migrations: backup file is not mode 0600: ${filePath}`);
  }
}

function currentVersion(db) {
  if (!tableExists(db, 'product_schema_migrations')) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM product_schema_migrations').get();
  return row && row.v ? row.v : 0;
}

async function migrateProductSchema({ db, filePath, now } = {}) {
  if (!db) throw new Error('migrateProductSchema requires db');
  const dbPath = filePath || db.name;
  const isFile = Boolean(dbPath) && dbPath !== ':memory:' && !db.memory;

  const fromVersion = currentVersion(db);
  if (fromVersion > LATEST_VERSION) {
    throw new Error(
      `product schema version ${fromVersion} is newer than this code supports (${LATEST_VERSION}); downgrade is not supported`,
    );
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) return { fromVersion, toVersion: fromVersion, backupPath: null };

  let backupPath = null;
  if (isFile && (tableExists(db, 'product_schema_migrations') || (hasAnyTable(db) && !allUserTablesEmpty(db)))) {
    backupPath = `${dbPath}.bak-v${fromVersion}-${utcStamp(resolveNow(now))}`;
    precreatePrivateFile(backupPath);
    await db.backup(backupPath);
    if ((fs.statSync(backupPath).mode & 0o777) !== 0o600) {
      throw new Error(`product migrations: backup file is not mode 0600: ${backupPath}`);
    }
  }

  db.exec(
    'CREATE TABLE IF NOT EXISTS product_schema_migrations ('
    + 'version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const record = db.prepare('INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  let toVersion = fromVersion;
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, resolveNow(now).toISOString());
    }).immediate();
    toVersion = migration.version;
  }
  return { fromVersion, toVersion, backupPath };
}

module.exports = { MIGRATIONS, LATEST_VERSION, migrateProductSchema, precreatePrivateFile };
