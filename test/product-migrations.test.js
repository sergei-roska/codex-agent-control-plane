'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { MIGRATIONS, migrateProductSchema, precreatePrivateFile } = require('../src/product-migrations');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-mig-'));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, 'state.sqlite') };
}

const fixedNow = () => new Date('2026-09-30T12:34:56.789Z');

test('fresh file database migrates without a backup', async () => {
  const { dir, file } = tempFile();
  const db = new Database(file);
  const result = await migrateProductSchema({ db, filePath: file, now: fixedNow });
  assert.deepEqual(result, { fromVersion: 0, toVersion: MIGRATIONS.length, backupPath: null });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const name of ['tickets', 'requirement_revisions', 'artifacts', 'product_commands', 'product_schema_migrations']) {
    assert.ok(tables.includes(name), name);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-')), []);
  db.close();
});

test('memory database migrates without a backup', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE other (x INTEGER)');
  const result = await migrateProductSchema({ db, now: fixedNow });
  assert.equal(result.backupPath, null);
  assert.equal(result.toVersion, MIGRATIONS.length);
  db.close();
});

test('existing database is backed up with mode 0600 before migrating', async () => {
  const { dir, file } = tempFile();
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE prior (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO prior (v) VALUES (?)').run('keep-me');
  const result = await migrateProductSchema({ db, filePath: file, now: fixedNow });
  assert.equal(result.fromVersion, 0);
  assert.equal(result.backupPath, `${file}.bak-v0-20260930T123456Z`);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  const backup = new Database(result.backupPath, { readonly: true });
  assert.equal(backup.prepare('SELECT v FROM prior').get().v, 'keep-me');
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tickets'").get(), undefined);
  backup.close();
  db.close();
  assert.ok(fs.existsSync(dir));
});

test('rerun is a no-op without a second backup', async () => {
  const { dir, file } = tempFile();
  const db = new Database(file);
  db.exec('CREATE TABLE prior (id INTEGER)');
  db.exec('INSERT INTO prior (id) VALUES (1)');
  await migrateProductSchema({ db, filePath: file, now: fixedNow });
  const again = await migrateProductSchema({ db, filePath: file, now: fixedNow });
  assert.deepEqual(again, { fromVersion: MIGRATIONS.length, toVersion: MIGRATIONS.length, backupPath: null });
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.bak-')).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM product_schema_migrations').get().c, MIGRATIONS.length);
  db.close();
});

test('a ledger newer than the code refuses to migrate', async () => {
  const { file } = tempFile();
  const db = new Database(file);
  await migrateProductSchema({ db, filePath: file, now: fixedNow });
  db.prepare('INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(MIGRATIONS.length + 1, 'future', 'x');
  await assert.rejects(() => migrateProductSchema({ db, filePath: file, now: fixedNow }), /newer than this code/);
  db.close();
});

test('a failing migration rolls back and leaves no ledger row', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE tickets (x INTEGER)');
  await assert.rejects(() => migrateProductSchema({ db, now: fixedNow }), /already exists/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM product_schema_migrations').get().c, 0);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'artifacts'").get(), undefined);
  db.close();
});

test('backup target is created 0600 before any data is written', () => {
  const { dir } = tempFile();
  const target = path.join(dir, 'pre.bak');
  precreatePrivateFile(target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(target).size, 0);
  assert.throws(() => precreatePrivateFile(target), /EEXIST/);
});

test('a fresh state database with only empty tables is not backed up', async () => {
  const { openStateDatabase } = require('../src/durable-store');
  const { dir, file } = tempFile();
  const state = await openStateDatabase({ filePath: file });
  const result = await migrateProductSchema({ db: state.db, filePath: file, now: fixedNow });
  assert.equal(result.backupPath, null);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-')), []);
  state.db.close();
});

test('a state database with one task row is backed up', async () => {
  const { openStateDatabase } = require('../src/durable-store');
  const { file } = tempFile();
  const state = await openStateDatabase({ filePath: file });
  const columns = state.db.prepare('PRAGMA table_info(tasks)').all();
  const values = columns.map((c) => (c.type.toUpperCase().includes('INT') ? 1 : 'x'));
  state.db.prepare(`INSERT INTO tasks (${columns.map((c) => c.name).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
  const result = await migrateProductSchema({ db: state.db, filePath: file, now: fixedNow });
  assert.ok(result.backupPath);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  state.db.close();
});

const DELIVERY_TABLES = ['runs', 'intake_results', 'plan_revisions', 'decisions', 'candidates', 'repository_leases', 'ticket_branches'];

test('migration 2 creates the delivery tables and the one-active-run index', async () => {
  const db = new Database(':memory:');
  const result = await migrateProductSchema({ db, now: fixedNow });
  assert.equal(result.toVersion, MIGRATIONS.length);
  assert.deepEqual(MIGRATIONS.map((m) => [m.version, m.name]), [
    [1, 'product_tickets'], [2, 'delivery_runs'], [3, 'role_settings'], [4, 'plan_identity'], [5, 'jira_source_tracking'], [6, 'operator_controls'], [7, 'role_rules'],
  ]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const name of DELIVERY_TABLES) assert.ok(tables.includes(name), name);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs_one_active_per_ticket'").get();
  assert.match(index.sql, /UNIQUE INDEX/);
  assert.match(index.sql, /'queued','running','paused','interrupted'/);
  assert.deepEqual(db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name), [
    'run_id', 'ticket_id', 'revision_id', 'project_id', 'status', 'phase', 'wait_reason', 'wait_detail_json', 'plan_revision_id',
    'lead_task_id', 'lead_context_id', 'branch_name', 'base_commit', 'candidate_id', 'settings_snapshot_json', 'intake_turns',
    'command_id', 'created_at', 'started_at', 'finished_at', 'updated_at',
    'control_request', 'control_command_id', 'control_requested_at', 'run_kind', 'parent_run_id', 'rework_review_id']);
  assert.equal(db.prepare("SELECT dflt_value FROM pragma_table_info('runs') WHERE name = 'intake_turns'").get().dflt_value, '0');
  db.close();
});

test('migration 3 creates the role settings tables', async () => {
  const db = new Database(':memory:');
  await migrateProductSchema({ db, now: fixedNow });
  assert.deepEqual(db.prepare('PRAGMA table_info(role_settings_revisions)').all().map((c) => c.name), [
    'settings_revision_id', 'pack_id', 'role_runtime_id', 'model', 'effort', 'service_tier',
    'supersedes_id', 'actor', 'command_id', 'created_at']);
  assert.deepEqual(db.prepare('PRAGMA table_info(role_settings_current)').all().map((c) => c.name), [
    'pack_id', 'role_runtime_id', 'settings_revision_id']);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'role_settings_rev_role_idx'").get());
  db.close();
});

test('a version 1 database is backed up and upgraded to the latest version with its tickets intact', async () => {
  const { file } = tempFile();
  const db = new Database(file);
  db.exec(MIGRATIONS[0].sql);
  db.exec('CREATE TABLE product_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (1, ?, ?)').run('product_tickets', 'then');
  db.prepare(
    "INSERT INTO tickets (ticket_id, project_id, source, title, priority, status, current_revision_id, version, created_at, updated_at, created_by) "
    + "VALUES ('t1', 'p', 'direct', 'Keep me', 'normal', 'backlog', 'r1', 1, 'a', 'a', 'operator')",
  ).run();
  const result = await migrateProductSchema({ db, filePath: file, now: fixedNow });
  assert.deepEqual([result.fromVersion, result.toVersion], [1, MIGRATIONS.length]);
  assert.equal(result.backupPath, `${file}.bak-v1-20260930T123456Z`);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  const backup = new Database(result.backupPath, { readonly: true });
  assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs'").get(), undefined);
  assert.equal(backup.prepare("SELECT title FROM tickets WHERE ticket_id = 't1'").get().title, 'Keep me');
  backup.close();
  assert.equal(db.prepare("SELECT title FROM tickets WHERE ticket_id = 't1'").get().title, 'Keep me');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM runs').get().c, 0);
  db.close();
});

const IDENTITY_COLUMNS = ['preset_id', 'preset_version', 'role_pack', 'role_pack_version'];

test('migration 4 adds nullable plan identity columns on a fresh database', async () => {
  const db = new Database(':memory:');
  await migrateProductSchema({ db, now: fixedNow });
  const cols = db.prepare('PRAGMA table_info(plan_revisions)').all();
  for (const name of IDENTITY_COLUMNS) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, name);
    assert.equal(col.notnull, 0);
  }
  db.close();
});

test('migration 5 upgrades version 4 with shared source tables and revision links intact', async () => {
  const db = new Database(':memory:');
  for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration.sql);
  db.exec('CREATE TABLE product_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 4)) {
    db.prepare('INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, 'then');
  }
  db.exec(`INSERT INTO tickets (ticket_id, project_id, source, title, priority, status, current_revision_id, version, created_at, updated_at, created_by)
    VALUES ('keep', 'project', 'direct', 'M4/M5 ticket', 'normal', 'backlog', 'keep-rev', 1, 'a', 'a', 'operator')`);
  db.exec(`INSERT INTO requirement_revisions (revision_id, ticket_id, ordinal, title, description, criteria_json, references_json,
    artifact_ids_json, priority, tracking_mode, actor, command_id, created_at)
    VALUES ('keep-rev', 'keep', 1, 'M4/M5 revision', '', '[]', '{}', '[]', 'normal', 'internal', 'operator', 'keep-cmd', 'a')`);
  await migrateProductSchema({ db, now: fixedNow });
  assert.equal(db.prepare('SELECT title FROM tickets WHERE ticket_id = ?').get('keep').title, 'M4/M5 ticket');
  assert.equal(db.prepare('SELECT title FROM requirement_revisions WHERE revision_id = ?').get('keep-rev').title, 'M4/M5 revision');
  for (const name of ['m6_source_identities', 'm6_source_snapshots', 'ticket_source_revision_links']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name), name);
  }
  const shared = require('../src/integrations/source-import-store').SOURCE_SCHEMA_SQL;
  assert.equal(MIGRATIONS[4].sql.startsWith(shared), true);
  db.close();
});

test('a version 3 database with a planMeta row is backfilled, cleaned and backed up', async () => {
  const { file } = tempFile();
  const db = new Database(file);
  for (const migration of MIGRATIONS.slice(0, 3)) db.exec(migration.sql);
  db.exec('CREATE TABLE product_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 3)) {
    db.prepare('INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, 'then');
  }
  const insert = db.prepare(
    'INSERT INTO plan_revisions (plan_revision_id, run_id, parent_plan_revision_id, classification, stages_json, check_ids_json, '
    + "checks_json, requirements_json, validator_version, reason, created_at) VALUES (?, 'r', NULL, 'feature', '[]', '[]', '[]', ?, 'v', 'intake', 'a')",
  );
  const meta = { presetId: 'feature', presetVersion: '1', rolePack: 'delivery', rolePackVersion: '2' };
  insert.run('p1', JSON.stringify({ goal: 'x', planMeta: meta }));
  insert.run('p2', JSON.stringify({ goal: 'y' }));
  const result = await migrateProductSchema({ db, filePath: file, now: fixedNow });
  assert.deepEqual([result.fromVersion, result.toVersion], [3, MIGRATIONS.length]);
  assert.equal(result.backupPath, `${file}.bak-v3-20260930T123456Z`);
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  const backup = new Database(result.backupPath, { readonly: true });
  assert.match(backup.prepare("SELECT requirements_json FROM plan_revisions WHERE plan_revision_id = 'p1'").get().requirements_json, /planMeta/);
  backup.close();
  const p1 = db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id = 'p1'").get();
  assert.deepEqual([p1.preset_id, p1.preset_version, p1.role_pack, p1.role_pack_version], ['feature', '1', 'delivery', '2']);
  assert.deepEqual(JSON.parse(p1.requirements_json), { goal: 'x' });
  const p2 = db.prepare("SELECT * FROM plan_revisions WHERE plan_revision_id = 'p2'").get();
  assert.deepEqual([p2.preset_id, p2.role_pack], [null, null]);
  assert.deepEqual(JSON.parse(p2.requirements_json), { goal: 'y' });
  db.close();
});

test('migration 6 adds operator controls, reviews and deliveries and keeps version 5 rows', async () => {
  const db = new Database(':memory:');
  for (const migration of MIGRATIONS.slice(0, 5)) db.exec(migration.sql);
  db.exec('CREATE TABLE product_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 5)) {
    db.prepare('INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, 'then');
  }
  db.exec(`INSERT INTO tickets (ticket_id, project_id, source, title, priority, status, current_revision_id, version, created_at, updated_at, created_by)
    VALUES ('keep', 'project', 'direct', 'Kept', 'normal', 'blocked', 'keep-rev', 3, 'a', 'a', 'operator')`);
  db.exec(`INSERT INTO runs (run_id, ticket_id, revision_id, project_id, status, phase, settings_snapshot_json, command_id, created_at, updated_at)
    VALUES ('run1', 'keep', 'keep-rev', 'project', 'failed', 'settled', '{}', 'cmd', 'a', 'a')`);
  const result = await migrateProductSchema({ db, now: fixedNow });
  assert.deepEqual([result.fromVersion, result.toVersion], [5, 7]);
  const run = db.prepare("SELECT * FROM runs WHERE run_id = 'run1'").get();
  assert.equal(run.run_kind, 'initial');
  assert.equal(run.control_request, null);
  assert.equal(run.parent_run_id, null);
  assert.equal(db.prepare("SELECT staged_revision_id FROM tickets WHERE ticket_id = 'keep'").get().staged_revision_id, null);
  assert.equal(db.prepare("SELECT dflt_value FROM pragma_table_info('runs') WHERE name = 'run_kind'").get().dflt_value, "'initial'");
  assert.deepEqual(db.prepare('PRAGMA table_info(reviews)').all().map((c) => c.name), [
    'review_id', 'ticket_id', 'run_id', 'revision_id', 'plan_revision_id', 'candidate_id', 'integrity_hash',
    'verdict', 'findings', 'actor', 'command_id', 'created_at']);
  assert.deepEqual(db.prepare('PRAGMA table_info(deliveries)').all().map((c) => c.name), [
    'delivery_id', 'ticket_id', 'run_id', 'candidate_id', 'review_id', 'kind', 'state', 'parent_delivery_id', 'branch',
    'base_head', 'commit_sha', 'remote', 'remote_ref', 'message', 'error_json', 'command_id', 'created_at', 'updated_at']);
  const insert = db.prepare("INSERT INTO reviews (review_id, ticket_id, run_id, revision_id, verdict, actor, command_id, created_at) VALUES (?, 'keep', ?, 'keep-rev', 'accepted', 'operator', 'c', 'a')");
  insert.run('rv1', 'run1');
  assert.throws(() => insert.run('rv2', 'run1'), /UNIQUE/);
  db.close();
});
