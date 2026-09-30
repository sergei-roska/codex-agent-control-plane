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
