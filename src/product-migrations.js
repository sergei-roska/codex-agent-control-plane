'use strict';

const fs = require('node:fs');
const { SOURCE_SCHEMA_SQL } = require('./integrations/source-import-store');

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

const MIGRATION_2_SQL = `
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  revision_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
  wait_reason TEXT, wait_detail_json TEXT, plan_revision_id TEXT, lead_task_id TEXT,
  lead_context_id TEXT, branch_name TEXT, base_commit TEXT, candidate_id TEXT,
  settings_snapshot_json TEXT NOT NULL, intake_turns INTEGER NOT NULL DEFAULT 0,
  command_id TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runs_one_active_per_ticket ON runs (ticket_id)
  WHERE status IN ('queued','running','paused','interrupted');
CREATE TABLE intake_results (
  intake_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn INTEGER NOT NULL, output_json TEXT NOT NULL,
  valid INTEGER NOT NULL, errors_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (run_id, turn)
);
CREATE TABLE plan_revisions (
  plan_revision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_plan_revision_id TEXT,
  classification TEXT NOT NULL, stages_json TEXT NOT NULL, check_ids_json TEXT NOT NULL,
  checks_json TEXT NOT NULL, requirements_json TEXT NOT NULL, validator_version TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, plan_revision_id TEXT, state TEXT NOT NULL, request_json TEXT NOT NULL,
  answer_json TEXT, actor TEXT, created_at TEXT NOT NULL, answered_at TEXT
);
CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL,
  base_commit TEXT NOT NULL, head TEXT NOT NULL, branch TEXT NOT NULL, head_moved INTEGER NOT NULL,
  manifest_json TEXT NOT NULL, diff_artifact_id TEXT, truncated INTEGER NOT NULL,
  acceptance_json TEXT, integrity_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE repository_leases (
  project_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ticket_id TEXT NOT NULL, acquired_at TEXT NOT NULL
);
CREATE TABLE ticket_branches (
  branch_name TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

const MIGRATION_3_SQL = `
CREATE TABLE role_settings_revisions (
  settings_revision_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, role_runtime_id TEXT NOT NULL,
  model TEXT NOT NULL, effort TEXT NOT NULL, service_tier TEXT,
  supersedes_id TEXT, actor TEXT NOT NULL, command_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX role_settings_rev_role_idx ON role_settings_revisions (pack_id, role_runtime_id, created_at);
CREATE TABLE role_settings_current (
  pack_id TEXT NOT NULL, role_runtime_id TEXT NOT NULL, settings_revision_id TEXT NOT NULL,
  PRIMARY KEY (pack_id, role_runtime_id)
);
`;

const MIGRATION_4_SQL = `
ALTER TABLE plan_revisions ADD COLUMN preset_id TEXT;
ALTER TABLE plan_revisions ADD COLUMN preset_version TEXT;
ALTER TABLE plan_revisions ADD COLUMN role_pack TEXT;
ALTER TABLE plan_revisions ADD COLUMN role_pack_version TEXT;
`;

const MIGRATION_5_SQL = `${SOURCE_SCHEMA_SQL}
CREATE TABLE ticket_source_revision_links (
  revision_id TEXT PRIMARY KEY REFERENCES requirement_revisions(revision_id),
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  identity_id TEXT NOT NULL REFERENCES m6_source_identities(identity_id),
  snapshot_id TEXT NOT NULL REFERENCES m6_source_snapshots(snapshot_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  created_at TEXT NOT NULL
);
CREATE INDEX ticket_source_revision_ticket_idx
  ON ticket_source_revision_links(ticket_id, created_at, revision_id);
`;

// Moves preset/pack identity out of requirements_json.planMeta into the new columns (runs in the migration transaction).
function backfillPlanIdentity(db) {
  const rows = db.prepare("SELECT plan_revision_id, requirements_json FROM plan_revisions WHERE requirements_json LIKE '%planMeta%'").all();
  const update = db.prepare(
    'UPDATE plan_revisions SET preset_id = ?, preset_version = ?, role_pack = ?, role_pack_version = ?, requirements_json = ? '
    + 'WHERE plan_revision_id = ?',
  );
  const str = (value) => (typeof value === 'string' ? value : null);
  for (const row of rows) {
    let stored;
    try { stored = JSON.parse(row.requirements_json); } catch { continue; }
    if (!stored || typeof stored !== 'object' || !stored.planMeta || typeof stored.planMeta !== 'object') continue;
    const { planMeta, ...requirements } = stored;
    update.run(str(planMeta.presetId), str(planMeta.presetVersion), str(planMeta.rolePack), str(planMeta.rolePackVersion),
      JSON.stringify(requirements), row.plan_revision_id);
  }
}

const MIGRATION_6_SQL = `
ALTER TABLE runs ADD COLUMN control_request TEXT;
ALTER TABLE runs ADD COLUMN control_command_id TEXT;
ALTER TABLE runs ADD COLUMN control_requested_at TEXT;
ALTER TABLE runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE runs ADD COLUMN rework_review_id TEXT;
ALTER TABLE tickets ADD COLUMN staged_revision_id TEXT;
CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, plan_revision_id TEXT, candidate_id TEXT, integrity_hash TEXT,
  verdict TEXT NOT NULL,
  findings TEXT, actor TEXT NOT NULL, command_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX reviews_one_per_run ON reviews (run_id);
CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, review_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  parent_delivery_id TEXT,
  branch TEXT NOT NULL, base_head TEXT NOT NULL, commit_sha TEXT,
  remote TEXT, remote_ref TEXT, message TEXT, error_json TEXT,
  command_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const MIGRATIONS = [
  { version: 1, name: 'product_tickets', sql: MIGRATION_1_SQL },
  { version: 2, name: 'delivery_runs', sql: MIGRATION_2_SQL },
  { version: 3, name: 'role_settings', sql: MIGRATION_3_SQL },
  { version: 4, name: 'plan_identity', sql: MIGRATION_4_SQL, after: backfillPlanIdentity },
  { version: 5, name: 'jira_source_tracking', sql: MIGRATION_5_SQL },
  { version: 6, name: 'operator_controls', sql: MIGRATION_6_SQL },
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
      if (migration.after) migration.after(db);
      record.run(migration.version, migration.name, resolveNow(now).toISOString());
    }).immediate();
    toVersion = migration.version;
  }
  return { fromVersion, toVersion, backupPath };
}

module.exports = { MIGRATIONS, LATEST_VERSION, migrateProductSchema, precreatePrivateFile };
