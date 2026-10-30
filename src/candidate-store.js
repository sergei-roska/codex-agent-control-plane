'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { VERSION: DELIVERY_VERSION, validateCandidate } = require('./delivery-contracts');

const MAX_GIT_BUFFER = 256 * 1024 * 1024;

class CandidateStoreError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CandidateStoreError';
    this.code = code;
  }
}

function fail(code, message) { throw new CandidateStoreError(code, message); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function validPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_GIT_BUFFER,
  });
}
function nulList(buffer) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) {
      try { values.push(decoder.decode(buffer.subarray(start, index))); }
      catch (_) { fail('path_encoding_unsupported', 'Git path is not valid UTF-8'); }
    }
    start = index + 1;
  }
  if (start < buffer.length) fail('git_listing_malformed');
  return values;
}
function safeFile(root, relative) {
  if (!validPath(relative)) fail('path_unsafe', `Unsafe manifest path: ${relative}`);
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!inside(root, absolute)) fail('path_escape', `Path escapes workspace: ${relative}`);
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('symlink_unsupported', `Symlink in source path: ${relative}`);
    if (cursor !== absolute && !stat.isDirectory()) fail('path_parent_not_directory', `Invalid parent path: ${relative}`);
    if (cursor === absolute && !stat.isFile()) fail('special_file_unsupported', `Only regular files are supported: ${relative}`);
    if (!inside(root, fs.realpathSync(cursor))) fail('path_escape', `Resolved path escapes workspace: ${relative}`);
  }
  return absolute;
}

function syncFile(pathname) {
  const fd = fs.openSync(pathname, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncDirectory(pathname) {
  const fd = fs.openSync(pathname, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDurableDirectory(directory, syncDir) {
  const target = path.resolve(directory);
  const missing = [];
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('storage_directory_unavailable');
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) fail('storage_path_unsafe');
  for (const created of missing.reverse()) {
    fs.mkdirSync(created);
    syncDir(path.dirname(created));
    syncDir(created);
  }
  syncDir(target);
}

// Captures all tracked paths plus nonignored untracked files without touching the index.
// The digest covers HEAD, path, executable bit, byte length and complete file content.
function captureManifest(workspace) {
  const root = fs.realpathSync(workspace);
  try {
    if (git(root, ['rev-parse', '--is-inside-work-tree']).toString('utf8').trim() !== 'true') fail('not_git_repository');
    if (path.resolve(git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim()) !== root) fail('workspace_must_be_git_root');
  } catch (error) {
    if (error instanceof CandidateStoreError) throw error;
    fail('capture_unavailable', `Git capture failed: ${error.message}`);
  }
  let head;
  try { head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim() || null; } catch (_) { head = null; }
  let stage;
  let untracked;
  try {
    stage = git(root, ['ls-files', '--stage', '-z']);
    untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  } catch (error) { fail('capture_unavailable', `Git listing failed: ${error.message}`); }
  const stagedMode = new Map();
  for (const item of nulList(stage)) {
    const match = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(item);
    if (!match) fail('capture_unavailable', 'Could not parse Git index paths');
    if (match[2] !== '0') fail('unmerged_index_unsupported', `Unmerged index path: ${match[3]}`);
    if (match[1] === '160000') fail('submodule_unsupported', `Submodule path is unsupported: ${match[3]}`);
    if (match[1] !== '100644' && match[1] !== '100755') fail('special_file_unsupported', `Git mode ${match[1]} is unsupported`);
    stagedMode.set(match[3], true);
  }
  const names = new Set([...stagedMode.keys(), ...nulList(untracked)]);
  const entries = [];
  for (const name of [...names].sort()) {
    const absolute = safeFile(root, name);
    if (!absolute) continue; // A missing tracked file is an attested deletion.
    const bytes = fs.readFileSync(absolute);
    const stat = fs.statSync(absolute);
    entries.push({ path: name, mode: stat.mode & 0o111 ? '100755' : '100644', size: bytes.length, digest: sha256(bytes) });
  }
  const value = { format: 'candidate-manifest-v1', head, entries };
  return { ...value, digest: sha256(canonical(value)) };
}

function cleanId(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x20\x7f]/.test(value)) fail('identity_invalid', `${label} must be a nonempty printable identifier`);
  return value;
}
function cleanDigest(value, label) {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) fail('digest_invalid', `${label} must be a SHA-256 digest`);
  return value;
}

/**
 * Content-addressed candidates over an injected better-sqlite3 database.
 * Storage is outside the source workspace. `publish()` is deliberately disabled
 * unless trusted admission, control/fence, quiescence and effect adapters exist.
 * The database intent cannot make Git/file effects atomic with SQLite.
 */
class CandidateStore {
  constructor({ db, workspace, storageDir, admission, controls, quiescence, apply, eventHook, clock = () => new Date(), durability = {} }) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('db (better-sqlite3) is required');
    this.db = db;
    this.workspace = fs.realpathSync(workspace);
    this.storageDir = path.resolve(storageDir);
    if (inside(this.workspace, this.storageDir)) fail('storage_inside_workspace', 'Candidate storage must be outside the source workspace');
    this.admission = admission;
    this.controls = controls;
    this.quiescence = quiescence;
    this.applyEffect = apply;
    this.eventHook = eventHook;
    this.clock = clock;
    this.syncFile = durability.syncFile || syncFile;
    this.syncDirectory = durability.syncDirectory || syncDirectory;
    ensureDurableDirectory(this.storageDir, this.syncDirectory);
    ensureDurableDirectory(path.join(this.storageDir, 'blobs'), this.syncDirectory);
    ensureDurableDirectory(path.join(this.storageDir, 'manifests'), this.syncDirectory);
    this.storageDir = fs.realpathSync(this.storageDir);
    if (inside(this.workspace, this.storageDir)) fail('storage_inside_workspace', 'Resolved candidate storage must be outside the source workspace');
    for (const child of ['blobs', 'manifests']) {
      const childPath = path.join(this.storageDir, child);
      if (fs.realpathSync(childPath) !== childPath) fail('storage_path_unsafe');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_snapshots (
        digest TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        candidate_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        parent_candidate_id TEXT, integration_generation INTEGER NOT NULL,
        source_attempt_id TEXT NOT NULL, environment_digest TEXT NOT NULL, check_identity TEXT NOT NULL,
        manifest_digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS candidates_generation_idx
        ON candidates(project_id, objective_id, integration_generation);
      CREATE TABLE IF NOT EXISTS candidate_refs (
        ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(ref_type, ref_id, candidate_id)
      );
      CREATE TABLE IF NOT EXISTS candidate_generations (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, generation INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id)
      );
      CREATE TABLE IF NOT EXISTS candidate_admission_timing (
        intent_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, acquired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS candidate_intents (
        intent_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL, base_candidate_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        parent_candidate_id TEXT NOT NULL, integration_generation INTEGER NOT NULL,
        environment_digest TEXT NOT NULL, check_identity TEXT NOT NULL, content_manifest_digest TEXT NOT NULL,
        before_manifest_json TEXT NOT NULL, expected_manifest_json TEXT NOT NULL,
        delta_paths_json TEXT NOT NULL, controls_json TEXT NOT NULL, admission_json TEXT NOT NULL,
        state TEXT NOT NULL, process_identity_json TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const intentColumns = new Set(this.db.prepare('PRAGMA table_info(candidate_intents)').all().map((row) => row.name));
    for (const [name, type] of [['parent_candidate_id', 'TEXT'], ['integration_generation', 'INTEGER'], ['environment_digest', 'TEXT'], ['check_identity', 'TEXT'], ['content_manifest_digest', 'TEXT']]) {
      if (!intentColumns.has(name)) this.db.exec(`ALTER TABLE candidate_intents ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`INSERT INTO candidate_generations(project_id,objective_id,generation)
      SELECT project_id,objective_id,MAX(integration_generation) FROM candidates
      GROUP BY project_id,objective_id
      ON CONFLICT(project_id,objective_id) DO UPDATE SET generation=MAX(generation,excluded.generation)`);
    this.repairMissingManifests();
  }

  now() { const value = this.clock(); return value instanceof Date ? value.toISOString() : String(value); }
  get(candidateId) {
    const row = this.db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(candidateId);
    return row ? this.record(row) : null;
  }
  record(row) {
    return { candidateId: row.candidate_id, projectId: row.project_id, objectiveId: row.objective_id,
      parentCandidateId: row.parent_candidate_id, integrationGeneration: row.integration_generation,
      sourceAttemptId: row.source_attempt_id, environmentDigest: row.environment_digest,
      checkIdentity: row.check_identity, manifestDigest: row.manifest_digest, status: row.status, createdAt: row.created_at };
  }
  // Internal records retain checkIdentity; this projection emits only delivery/v1 fields.
  projectDeliveryCandidate(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) return null;
    const createdAt = Date.parse(candidate.createdAt);
    if (!Number.isSafeInteger(createdAt)) fail('candidate_created_at_invalid');
    return validateCandidate({
      schemaVersion: DELIVERY_VERSION,
      projectId: candidate.projectId,
      objectiveId: candidate.objectiveId,
      candidateId: candidate.candidateId,
      integrationGeneration: candidate.integrationGeneration,
      snapshotRef: `snapshot:sha256:${candidate.manifestDigest}`,
      contentManifestDigest: `sha256:${candidate.manifestDigest}`,
      status: candidate.status,
      parentCandidateId: candidate.parentCandidateId,
      sourceAttemptId: candidate.sourceAttemptId,
      environmentDigest: candidate.environmentDigest,
      createdAt,
    });
  }
  putBlob(bytes) {
    const digest = sha256(bytes);
    const target = path.join(this.storageDir, 'blobs', digest);
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile()) fail('stored_content_corrupt', `Blob is not a regular file: ${digest}`);
      if (sha256(fs.readFileSync(target)) !== digest) fail('stored_content_corrupt', `Blob is corrupt: ${digest}`);
      this.syncFile(target);
      this.syncDirectory(path.dirname(target));
    } else {
      const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        this.syncFile(temporary);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, target);
        this.syncDirectory(path.dirname(target));
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (_) { /* Preserve the original durability error. */ }
        }
        try { fs.unlinkSync(temporary); } catch (_) { /* Preserve the original durability error. */ }
        throw error;
      }
    }
    return digest;
  }
  manifestPath(digest) { return path.join(this.storageDir, 'manifests', digest); }
  writeManifestFile(digest, body) {
    const target = this.manifestPath(digest);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  ensureManifestFile(digest, body) {
    const target = this.manifestPath(digest);
    try {
      if (!fs.lstatSync(target).isFile()) fail('stored_manifest_corrupt', digest);
      if (fs.readFileSync(target, 'utf8') !== body) fail('stored_manifest_corrupt', digest);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.writeManifestFile(digest, body);
    }
  }
  repairMissingManifests() {
    this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT digest,manifest_json FROM candidate_snapshots').all()) {
        this.ensureManifestFile(row.digest, row.manifest_json);
      }
    }).immediate();
  }
  storeManifest(workspace = this.workspace) {
    const manifest = captureManifest(workspace);
    const body = canonical(manifest);
    return this.db.transaction(() => {
      const root = fs.realpathSync(workspace);
      for (const entry of manifest.entries) {
        const bytes = fs.readFileSync(safeFile(root, entry.path));
        if (sha256(bytes) !== entry.digest) fail('workspace_changed_during_capture', entry.path);
        this.putBlob(bytes);
      }
      this.ensureManifestFile(manifest.digest, body);
      if (captureManifest(workspace).digest !== manifest.digest) fail('workspace_changed_during_capture');
      const at = this.now();
      this.db.prepare('INSERT OR IGNORE INTO candidate_snapshots(digest,manifest_json,created_at) VALUES(?,?,?)')
        .run(manifest.digest, body, at);
      const row = this.db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest = ?').get(manifest.digest);
      if (!row || row.manifest_json !== body) fail('stored_manifest_collision');
      return manifest;
    }).immediate();
  }
  readManifest(digest) {
    return this.db.transaction(() => this.readManifestUnsafe(digest)).immediate();
  }
  readManifestUnsafe(digest) {
    const row = this.db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest = ?').get(digest);
    if (!row) fail('snapshot_missing', `Unknown snapshot ${digest}`);
    let file;
    try {
      if (!fs.lstatSync(this.manifestPath(digest)).isFile()) fail('stored_manifest_corrupt', digest);
      file = fs.readFileSync(this.manifestPath(digest), 'utf8');
      if (file !== row.manifest_json) fail('stored_manifest_corrupt', digest);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.writeManifestFile(digest, row.manifest_json);
      file = row.manifest_json;
    }
    const stored = JSON.parse(file, safeJsonReviver);
    const { digest: recordedDigest, ...body } = stored;
    if (file !== row.manifest_json || recordedDigest !== digest || sha256(canonical(body)) !== digest) fail('stored_manifest_corrupt', digest);
    const manifest = JSON.parse(file);
    for (const entry of manifest.entries) {
      const blobPath = path.join(this.storageDir, 'blobs', entry.digest);
      if (!fs.lstatSync(blobPath).isFile()) fail('stored_content_corrupt', entry.digest);
      const blob = fs.readFileSync(blobPath);
      if (blob.length !== entry.size || sha256(blob) !== entry.digest) fail('stored_content_corrupt', entry.digest);
    }
    return manifest;
  }
  syncManifestBlobs(manifest) {
    for (const entry of manifest.entries) {
      const blobPath = path.join(this.storageDir, 'blobs', entry.digest);
      if (!fs.lstatSync(blobPath).isFile()) fail('stored_content_corrupt', entry.digest);
      const bytes = fs.readFileSync(blobPath);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.digest) fail('stored_content_corrupt', entry.digest);
      this.syncFile(blobPath);
    }
    if (manifest.entries.length) this.syncDirectory(path.join(this.storageDir, 'blobs'));
  }
  materialize(candidateId, destination) {
    const candidate = this.get(candidateId);
    if (!candidate || candidate.status !== 'known') fail('candidate_not_known');
    const manifest = this.readManifest(candidate.manifestDigest);
    const target = path.resolve(destination);
    if (inside(this.workspace, target) || inside(target, this.workspace)) fail('unsafe_materialization_target');
    fs.mkdirSync(target, { recursive: true });
    if (!inside(target, fs.realpathSync(target))) fail('unsafe_materialization_target');
    if (fs.readdirSync(target).length) fail('materialization_target_not_empty');
    for (const entry of manifest.entries) {
      const file = path.resolve(target, ...entry.path.split('/'));
      if (!inside(target, file)) fail('path_escape');
      let cursor = target;
      for (const part of entry.path.split('/').slice(0, -1)) {
        cursor = path.join(cursor, part);
        try {
          const stat = fs.lstatSync(cursor);
          if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(target, fs.realpathSync(cursor))) fail('unsafe_materialization_target');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          fs.mkdirSync(cursor);
        }
      }
      const bytes = fs.readFileSync(path.join(this.storageDir, 'blobs', entry.digest));
      fs.writeFileSync(file, bytes, { mode: entry.mode === '100755' ? 0o555 : 0o444 });
      fs.chmodSync(file, entry.mode === '100755' ? 0o555 : 0o444);
      if (sha256(fs.readFileSync(file)) !== entry.digest) fail('materialized_content_corrupt', entry.path);
    }
    return { candidateId, manifestDigest: manifest.digest, destination: target };
  }
  commitCandidate(input, manifest, { verifyCurrent, onCommit, reservationIntentId = null } = {}) {
    const candidateId = cleanId(input.candidateId, 'candidateId');
    const projectId = cleanId(input.projectId, 'projectId');
    const objectiveId = cleanId(input.objectiveId, 'objectiveId');
    const sourceAttemptId = cleanId(input.sourceAttemptId, 'sourceAttemptId');
    const environmentDigest = cleanDigest(input.environmentDigest, 'environmentDigest');
    const checkIdentity = cleanId(input.checkIdentity, 'checkIdentity');
    const generation = input.integrationGeneration;
    if (!Number.isSafeInteger(generation) || generation < 1) fail('generation_invalid');
    const parent = input.parentCandidateId ?? null;
    const at = this.now();
    const save = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(candidateId);
      const snapshot = this.db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(manifest.digest);
      if (!snapshot || snapshot.manifest_json !== canonical(manifest)) fail('candidate_snapshot_missing');
      this.readManifestUnsafe(manifest.digest);
      this.syncManifestBlobs(manifest);
      const reservation = reservationIntentId
        ? this.db.prepare('SELECT * FROM candidate_intents WHERE intent_id=?').get(reservationIntentId)
        : null;
      if (reservationIntentId) {
        if (!reservation || reservation.project_id !== projectId || reservation.objective_id !== objectiveId ||
            reservation.candidate_id !== candidateId || reservation.parent_candidate_id !== parent ||
            reservation.attempt_id !== sourceAttemptId || reservation.integration_generation !== generation ||
            reservation.environment_digest !== environmentDigest || reservation.check_identity !== checkIdentity ||
            reservation.content_manifest_digest !== manifest.digest || !['applying', 'unknown', 'settling'].includes(reservation.state)) fail('candidate_intent_identity_mismatch');
      }
      if (existing) {
        const record = this.record(existing);
        if (record.projectId !== projectId || record.objectiveId !== objectiveId || record.parentCandidateId !== parent || record.integrationGeneration !== generation || record.sourceAttemptId !== sourceAttemptId || record.environmentDigest !== environmentDigest || record.checkIdentity !== checkIdentity || record.manifestDigest !== manifest.digest) fail('candidate_identity_collision');
        if (verifyCurrent && verifyCurrent() !== true) fail('workspace_changed_during_commit');
        onCommit?.(record);
        return record;
      }
      if (parent !== null) {
        const parentRow = this.db.prepare('SELECT project_id,objective_id,integration_generation,status FROM candidates WHERE candidate_id = ?').get(parent);
        if (!parentRow || parentRow.project_id !== projectId || parentRow.objective_id !== objectiveId || parentRow.status !== 'known') fail('parent_invalid');
        if (generation <= parentRow.integration_generation) fail('generation_not_monotonic');
      }
      const latest = this.db.prepare('SELECT generation FROM candidate_generations WHERE project_id=? AND objective_id=?').get(projectId, objectiveId)?.generation;
      if (reservationIntentId) {
        const earlier = this.db.prepare(`SELECT 1 FROM candidate_intents WHERE project_id=? AND objective_id=? AND integration_generation<?
          AND intent_id<>? AND state IN ('prepared','applying','unknown','settling') LIMIT 1`).get(projectId, objectiveId, generation, reservationIntentId);
        if (earlier) fail('generation_order_blocked');
        if (latest == null || generation > latest) fail('generation_reservation_missing');
      } else {
        const earlier = this.db.prepare(`SELECT 1 FROM candidate_intents WHERE project_id=? AND objective_id=? AND integration_generation<?
          AND state IN ('prepared','applying','unknown','settling') LIMIT 1`).get(projectId, objectiveId, generation);
        if (earlier) fail('generation_order_blocked');
        if (latest != null && generation <= latest) fail('generation_not_monotonic');
      }
      this.db.prepare(`INSERT INTO candidates(candidate_id,project_id,objective_id,parent_candidate_id,integration_generation,source_attempt_id,environment_digest,check_identity,manifest_digest,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'known',?)`).run(candidateId, projectId, objectiveId, parent, generation, sourceAttemptId, environmentDigest, checkIdentity, manifest.digest, at);
      if (!reservationIntentId) {
        this.db.prepare(`INSERT INTO candidate_generations(project_id,objective_id,generation) VALUES(?,?,?)
          ON CONFLICT(project_id,objective_id) DO UPDATE SET generation=excluded.generation`)
          .run(projectId, objectiveId, generation);
      }
      if (parent) this.db.prepare('INSERT OR IGNORE INTO candidate_refs(ref_type,ref_id,candidate_id,created_at) VALUES(?,?,?,?)').run('lineage', candidateId, parent, at);
      const record = this.get(candidateId);
      if (this.eventHook) {
        const result = this.eventHook({ type: 'candidate.created', candidate: record, at });
        if (result && typeof result.then === 'function') fail('event_hook_must_be_synchronous');
      }
      if (verifyCurrent && verifyCurrent() !== true) fail('workspace_changed_during_commit');
      onCommit?.(record);
      return record;
    });
    return save.immediate();
  }
  createCandidate(input) {
    const manifest = this.storeManifest();
    if (input.expectedManifestDigest && input.expectedManifestDigest !== manifest.digest) fail('manifest_mismatch');
    return this.commitCandidate(input, manifest);
  }
  addReference(candidateId, refType, refId) {
    cleanId(refType, 'refType'); cleanId(refId, 'refId');
    this.db.transaction(() => {
      if (!this.get(candidateId)) fail('candidate_missing');
      this.db.prepare('INSERT OR IGNORE INTO candidate_refs(ref_type,ref_id,candidate_id,created_at) VALUES(?,?,?,?)').run(refType, refId, candidateId, this.now());
    }).immediate();
  }
  removeReference(candidateId, refType, refId) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM candidate_refs WHERE candidate_id=? AND ref_type=? AND ref_id=?').run(candidateId, refType, refId);
    }).immediate();
  }
  collectGarbage() {
    const removed = [];
    const removedManifests = [];
    const protectedSnapshots = new Set();
    const drop = this.db.transaction(() => {
      const protectedIds = new Set();
      for (const row of this.db.prepare('SELECT candidate_id,parent_candidate_id FROM candidates').all()) {
        if (row.parent_candidate_id) protectedIds.add(row.parent_candidate_id);
        if (this.db.prepare('SELECT 1 FROM candidate_refs WHERE candidate_id=? LIMIT 1').get(row.candidate_id)) protectedIds.add(row.candidate_id);
      }
      for (const row of this.db.prepare(`SELECT base_candidate_id,candidate_id FROM candidate_intents
        WHERE state IN ('prepared','applying','unknown','settling')`).all()) {
        protectedIds.add(row.base_candidate_id);
        protectedIds.add(row.candidate_id);
      }
      for (const row of this.db.prepare(`SELECT before_manifest_json,expected_manifest_json FROM candidate_intents
        WHERE state IN ('prepared','applying','unknown','settling')`).all()) {
        protectedSnapshots.add(JSON.parse(row.before_manifest_json).digest);
        protectedSnapshots.add(JSON.parse(row.expected_manifest_json).digest);
      }
      for (const row of this.db.prepare('SELECT * FROM candidates WHERE status = \'known\'').all()) {
        if (protectedIds.has(row.candidate_id)) continue;
        this.db.prepare('DELETE FROM candidates WHERE candidate_id=?').run(row.candidate_id);
        this.db.prepare('DELETE FROM candidate_refs WHERE ref_id=?').run(row.candidate_id);
        removed.push(row.manifest_digest);
      }
      for (const row of this.db.prepare('SELECT digest FROM candidate_snapshots').all()) {
        if (protectedSnapshots.has(row.digest)) continue;
        if (this.db.prepare('SELECT 1 FROM candidates WHERE manifest_digest=? LIMIT 1').get(row.digest)) continue;
        const snapshot = this.db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(row.digest);
        this.db.prepare('DELETE FROM candidate_snapshots WHERE digest=?').run(row.digest);
        removedManifests.push(row.digest);
        if (!snapshot) fail('snapshot_missing');
      }
      return true;
    });
    drop.immediate();
    for (const digest of removedManifests) {
      fs.rmSync(this.manifestPath(digest), { force: true });
      this.db.transaction(() => {
        const row = this.db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(digest);
        if (row) this.ensureManifestFile(digest, row.manifest_json);
      }).immediate();
    }
    return removed;
  }

  async publish(input) {
    // controls() returns the exact currently authorized identity, revision and fence.
    // Admission acquire returns a durable lease with matching project/objective/attempt
    // and fencingToken. reconcile/findByContextId recover that exact lease after restart.
    // apply({ ...intent, onSpawn(identity) }) must not perform unpinned effects.
    if (!this.admission || typeof this.admission.acquire !== 'function' || typeof this.admission.release !== 'function' || typeof this.admission.markUnresolved !== 'function') fail('publication_admission_required');
    if (typeof this.controls !== 'function') fail('publication_controls_required');
    if (typeof this.quiescence !== 'function') fail('publication_quiescence_required');
    if (typeof this.applyEffect !== 'function') throw new TypeError('apply adapter is required for publish()');
    const base = this.get(input.baseCandidateId);
    if (!base || base.status !== 'known') fail('base_candidate_unknown');
    const before = this.readManifest(base.manifestDigest);
    const expected = validateManifest(input.expectedManifest);
    const identity = {
      projectId: base.projectId,
      objectiveId: base.objectiveId,
      candidateId: cleanId(input.candidateId, 'candidateId'),
      parentCandidateId: base.candidateId,
      sourceAttemptId: cleanId(input.sourceAttemptId, 'sourceAttemptId'),
      integrationGeneration: input.integrationGeneration,
      environmentDigest: cleanDigest(input.environmentDigest, 'environmentDigest'),
      checkIdentity: cleanId(input.checkIdentity, 'checkIdentity'),
      contentManifestDigest: expected.digest,
    };
    if (!Number.isSafeInteger(identity.integrationGeneration) || identity.integrationGeneration < 1) fail('generation_invalid');
    if (identity.integrationGeneration <= base.integrationGeneration) fail('generation_not_monotonic');
    if (this.get(identity.candidateId)) fail('candidate_identity_collision');
    const generationRow = this.db.prepare('SELECT generation FROM candidate_generations WHERE project_id=? AND objective_id=?').get(identity.projectId, identity.objectiveId);
    if (generationRow && identity.integrationGeneration <= generationRow.generation) fail('generation_not_monotonic');
    if (!Array.isArray(input.deltaPaths) || input.deltaPaths.some((name) => !validPath(name))) fail('delta_scope_invalid');
    const deltaPaths = [...new Set(input.deltaPaths)].sort();
    const beforeEntries = new Map(before.entries.map((entry) => [entry.path, canonical(entry)]));
    const expectedEntries = new Map(expected.entries.map((entry) => [entry.path, canonical(entry)]));
    const actualDelta = [...new Set([...beforeEntries.keys(), ...expectedEntries.keys()])]
      .filter((name) => beforeEntries.get(name) !== expectedEntries.get(name));
    if (actualDelta.some((name) => !deltaPaths.includes(name)) || (before.head !== expected.head && input.allowHeadChange !== true)) fail('delta_scope_mismatch');
    const controls = this.controls({ projectId: base.projectId, objectiveId: base.objectiveId, attemptId: cleanId(input.sourceAttemptId, 'sourceAttemptId') });
    this.assertControls(controls, base, input.sourceAttemptId);
    const admissionFacts = input.admissionFacts ?? {};
    const at = this.now();
    const intent = {
      intentId: cleanId(input.intentId, 'intentId'), ...identity, baseCandidateId: base.candidateId,
      attemptId: identity.sourceAttemptId, before, expected,
      controls, admissionFacts, deltaPaths,
    };
    this.db.transaction(() => {
      if (this.get(identity.candidateId)) fail('candidate_identity_collision');
      const latest = this.db.prepare('SELECT generation FROM candidate_generations WHERE project_id=? AND objective_id=?').get(identity.projectId, identity.objectiveId)?.generation;
      if (latest != null && identity.integrationGeneration <= latest) fail('generation_not_monotonic');
      if (this.db.prepare('SELECT 1 FROM candidate_intents WHERE candidate_id=? OR (project_id=? AND objective_id=? AND integration_generation=?) LIMIT 1')
        .get(identity.candidateId, identity.projectId, identity.objectiveId, identity.integrationGeneration)) fail('candidate_intent_identity_collision');
      const parent = this.db.prepare('SELECT status FROM candidates WHERE candidate_id=? AND project_id=? AND objective_id=?').get(identity.parentCandidateId, identity.projectId, identity.objectiveId);
      if (!parent || parent.status !== 'known') fail('parent_invalid');
      const baseSnapshot = this.db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(before.digest);
      if (!baseSnapshot || baseSnapshot.manifest_json !== canonical(before)) fail('base_snapshot_missing');
      this.db.prepare(`INSERT INTO candidate_intents(intent_id,project_id,objective_id,candidate_id,base_candidate_id,attempt_id,parent_candidate_id,integration_generation,environment_digest,check_identity,content_manifest_digest,before_manifest_json,expected_manifest_json,delta_paths_json,controls_json,admission_json,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(intent.intentId, intent.projectId, intent.objectiveId, intent.candidateId, base.candidateId, intent.attemptId, identity.parentCandidateId, identity.integrationGeneration, identity.environmentDigest, identity.checkIdentity, identity.contentManifestDigest, canonical(before), canonical(expected), canonical(deltaPaths), canonical(controls), canonical({ contextId: intent.intentId, projectId: base.projectId, objectiveId: base.objectiveId, attemptId: intent.attemptId, fencingToken: controls.fencingToken, controlRevision: controls.controlRevision, requested: admissionFacts }), at, at);
      this.db.prepare(`INSERT INTO candidate_generations(project_id,objective_id,generation) VALUES(?,?,?)
        ON CONFLICT(project_id,objective_id) DO UPDATE SET generation=excluded.generation`)
        .run(identity.projectId, identity.objectiveId, identity.integrationGeneration);
    }).immediate();
    let lease;
    try { this.db.prepare('INSERT INTO candidate_admission_timing(intent_id,started_at) VALUES(?,?)').run(intent.intentId, this.now()); } catch (_) { /* Timing must not affect publication. */ }
    try {
      lease = await this.admission.acquire({ role: 'integration', taskId: intent.attemptId, contextId: intent.intentId });
      const admissionAcquiredAt = this.now();
      this.db.prepare('UPDATE candidate_intents SET admission_json=?,updated_at=? WHERE intent_id=?')
        .run(canonical(lease), this.now(), intent.intentId);
      const current = captureManifest(this.workspace);
      const currentControls = this.controls({ projectId: base.projectId, objectiveId: base.objectiveId, attemptId: intent.attemptId });
      this.assertControls(currentControls, base, intent.attemptId);
      if (!lease || lease.projectId !== base.projectId || lease.objectiveId !== base.objectiveId || lease.attemptId !== intent.attemptId || lease.fencingToken !== controls.fencingToken) fail('admission_identity_mismatch');
      try { this.db.prepare('UPDATE candidate_admission_timing SET acquired_at=? WHERE intent_id=?').run(admissionAcquiredAt, intent.intentId); } catch (_) { /* Timing must not affect publication. */ }
      if (current.digest !== before.digest || canonical(currentControls) !== canonical(controls)) {
        this.setIntent(intent.intentId, 'refused', { reason: 'base_or_controls_changed' });
        let released;
        try { released = await this.admission.release(lease.executionId); } catch (_) { released = null; }
        if (!this.isTerminalAdmission(released)) {
          this.setIntent(intent.intentId, 'unknown', { reason: 'admission_release_unconfirmed' });
          this.admission.markUnresolved(lease.executionId, 'candidate_admission_release_unknown');
          return { state: 'unknown', intentId: intent.intentId };
        }
        return { state: 'refused', reason: 'base_or_controls_changed' };
      }
      this.db.transaction(() => {
        const earlier = this.db.prepare(`SELECT 1 FROM candidate_intents WHERE project_id=? AND objective_id=? AND integration_generation<?
          AND state IN ('prepared','applying','unknown','settling') LIMIT 1`).get(identity.projectId, identity.objectiveId, identity.integrationGeneration);
        if (earlier) fail('generation_order_blocked');
        this.db.prepare("UPDATE candidate_intents SET state='applying',process_identity_json=NULL,updated_at=? WHERE intent_id=? AND state='prepared'")
          .run(this.now(), intent.intentId);
      }).immediate();
      let result;
      try { result = await this.applyEffect({ ...intent, onSpawn: (identity) => this.setIntent(intent.intentId, 'applying', { processIdentity: identity }) }); }
      catch (error) {
        this.setIntent(intent.intentId, 'unknown', { result: { error: String(error.message || error) } });
        this.admission.markUnresolved?.(lease.executionId, 'candidate_apply_unknown');
        return { state: 'unknown', intentId: intent.intentId };
      }
      const quiet = await this.quiescence(result?.processIdentity ?? this.getIntent(intent.intentId).processIdentity);
      const after = captureManifest(this.workspace);
      if (quiet !== true || after.digest !== expected.digest) {
        this.setIntent(intent.intentId, 'unknown', { result: { applied: result?.applied ?? null, actualDigest: after.digest, quiescent: quiet } });
        this.admission.markUnresolved?.(lease.executionId, 'candidate_apply_unreconciled');
        return { state: 'unknown', intentId: intent.intentId, actualManifestDigest: after.digest };
      }
      const stored = this.storeManifest();
      if (stored.digest !== expected.digest) fail('workspace_changed_during_capture');
      const record = this.commitCandidate({ ...input, projectId: base.projectId, objectiveId: base.objectiveId,
        parentCandidateId: base.candidateId, integrationGeneration: identity.integrationGeneration }, stored, {
        reservationIntentId: intent.intentId,
        verifyCurrent: () => captureManifest(this.workspace).digest === expected.digest,
        onCommit: (saved) => this.setIntent(intent.intentId, 'settling', { result: { candidateId: saved.candidateId, manifestDigest: stored.digest, applied: result?.applied ?? true } }),
      });
      let released;
      try { released = await this.admission.release(lease.executionId); }
      catch (error) {
        this.admission.markUnresolved(lease.executionId, 'candidate_admission_release_unknown');
        return { state: 'unknown', intentId: intent.intentId, candidate: record };
      }
      if (!this.isTerminalAdmission(released)) {
        this.admission.markUnresolved(lease.executionId, 'candidate_admission_release_unknown');
        return { state: 'unknown', intentId: intent.intentId, candidate: record };
      }
      this.setIntent(intent.intentId, 'applied', { result: { candidateId: record.candidateId, manifestDigest: stored.digest, applied: result?.applied ?? true } });
      return { state: 'applied', candidate: record, intentId: intent.intentId };
    } catch (error) {
      const state = this.db.prepare('SELECT state FROM candidate_intents WHERE intent_id=?').get(intent.intentId)?.state;
      if (lease?.executionId && state === 'prepared') {
        this.setIntent(intent.intentId, 'refused', { reason: error.code || 'admission_failed' });
        let released;
        try { released = await this.admission.release(lease.executionId); } catch (_) { released = null; }
        if (!this.isTerminalAdmission(released)) {
          this.setIntent(intent.intentId, 'unknown', { reason: 'admission_release_unconfirmed' });
          this.admission.markUnresolved(lease.executionId, 'candidate_admission_release_unknown');
          return { state: 'unknown', intentId: intent.intentId };
        }
      } else if (lease?.executionId && state === 'refused') {
        this.setIntent(intent.intentId, 'unknown', { result: { error: String(error.message || error) } });
        this.admission.markUnresolved(lease.executionId, 'candidate_admission_release_unknown');
        return { state: 'unknown', intentId: intent.intentId };
      } else if (lease?.executionId && state !== 'applied') {
        this.setIntent(intent.intentId, 'unknown', { result: { error: String(error.message || error) } });
        this.admission.markUnresolved(lease.executionId, 'candidate_publish_unknown');
        return { state: 'unknown', intentId: intent.intentId };
      }
      throw error;
    }
  }
  assertControls(value, base, attemptId) {
    if (!value || typeof value !== 'object' || value.allowed !== true || value.fenced !== false ||
        value.projectId !== base.projectId || value.objectiveId !== base.objectiveId || value.attemptId !== attemptId ||
        !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0 ||
        !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
      fail('publication_controls_denied_or_unknown');
    }
  }
  isTerminalAdmission(result) {
    return result !== null && typeof result === 'object' && ['released', 'reconciled'].includes(result.state);
  }
  setIntent(intentId, state, { processIdentity, result } = {}) {
    const sets = ['state = ?', 'updated_at = ?']; const values = [state, this.now()];
    if (processIdentity !== undefined) { sets.push('process_identity_json = ?'); values.push(processIdentity === null ? null : canonical(processIdentity)); }
    if (result !== undefined) { sets.push('result_json = ?'); values.push(canonical(result)); }
    this.db.prepare(`UPDATE candidate_intents SET ${sets.join(', ')} WHERE intent_id = ?`).run(...values, intentId);
  }
  getIntent(intentId) {
    const row = this.db.prepare('SELECT * FROM candidate_intents WHERE intent_id=?').get(intentId);
    return row ? { intentId: row.intent_id, candidateId: row.candidate_id, baseCandidateId: row.base_candidate_id,
      attemptId: row.attempt_id, state: row.state, processIdentity: row.process_identity_json ? JSON.parse(row.process_identity_json) : null,
      result: row.result_json ? JSON.parse(row.result_json) : null } : null;
  }
  async reconcile(intentId, { candidate, integrationGeneration } = {}) {
    const row = this.db.prepare('SELECT * FROM candidate_intents WHERE intent_id=?').get(intentId);
    if (!row) fail('intent_missing');
    const pinned = {
      projectId: row.project_id,
      objectiveId: row.objective_id,
      candidateId: row.candidate_id,
      parentCandidateId: row.parent_candidate_id,
      sourceAttemptId: row.attempt_id,
      integrationGeneration: row.integration_generation,
      environmentDigest: row.environment_digest,
      checkIdentity: row.check_identity,
      contentManifestDigest: row.content_manifest_digest,
    };
    if (Object.values(pinned).some((value) => value === null || value === undefined)) fail('candidate_intent_identity_missing');
    if (candidate) {
      const supplied = candidate.candidate ?? candidate;
      const assertions = {
        projectId: supplied.projectId,
        objectiveId: supplied.objectiveId,
        candidateId: supplied.candidateId,
        parentCandidateId: supplied.parentCandidateId ?? supplied.baseCandidateId,
        sourceAttemptId: supplied.sourceAttemptId,
        integrationGeneration: integrationGeneration ?? supplied.integrationGeneration,
        environmentDigest: supplied.environmentDigest,
        checkIdentity: supplied.checkIdentity,
        contentManifestDigest: supplied.contentManifestDigest ?? supplied.manifestDigest ?? supplied.expectedManifest?.digest,
      };
      for (const [key, value] of Object.entries(assertions)) {
        if (value !== undefined && value !== null && value !== pinned[key]) fail('candidate_intent_identity_mismatch', `Recovery ${key} does not match the intent`);
      }
    } else if (integrationGeneration !== undefined && integrationGeneration !== pinned.integrationGeneration) {
      fail('candidate_intent_identity_mismatch', 'Recovery integrationGeneration does not match the intent');
    }
    if (!['prepared', 'applying', 'unknown', 'settling'].includes(row.state)) return { state: row.state };
    const identity = row.process_identity_json ? JSON.parse(row.process_identity_json) : null;
    if ((await this.quiescence(identity)) !== true) return { state: 'unknown', reason: 'quiescence_unproven' };
    const before = JSON.parse(row.before_manifest_json);
    const expected = JSON.parse(row.expected_manifest_json);
    if (expected.digest !== pinned.contentManifestDigest) fail('candidate_intent_manifest_corrupt');
    const actual = captureManifest(this.workspace);
    let admission = JSON.parse(row.admission_json);
    const settleAdmission = async () => {
      if (!admission.executionId) {
        const found = this.admission?.findByContextId?.(intentId) ?? this.admission?.findAnyByContextId?.(intentId) ?? null;
        if (found?.executionId) {
          admission = found;
          this.db.prepare('UPDATE candidate_intents SET admission_json=?,updated_at=? WHERE intent_id=?').run(canonical(found), this.now(), intentId);
          if (found.state === 'active') this.admission.markUnresolved?.(found.executionId, 'server_restart');
        } else if (row.state === 'prepared') return true;
      }
      if (!admission.executionId || typeof this.admission?.reconcile !== 'function') return false;
      const result = await this.admission.reconcile(admission.executionId);
      return this.isTerminalAdmission(result);
    };
    if (actual.digest === before.digest) {
      if (!(await settleAdmission())) return { state: 'unknown', reason: 'admission_unresolved' };
      this.setIntent(intentId, 'not_applied', { result: { actualManifestDigest: actual.digest } });
      return { state: 'not_applied' };
    }
    if (actual.digest !== expected.digest) return { state: 'unknown', reason: 'manifest_not_exactly_reconciled', actualManifestDigest: actual.digest };
    const pinnedControls = JSON.parse(row.controls_json);
    const currentControls = this.controls?.({ projectId: row.project_id, objectiveId: row.objective_id, attemptId: row.attempt_id });
    const baseCandidate = this.get(row.base_candidate_id);
    if (!baseCandidate) return { state: 'unknown', reason: 'base_candidate_missing' };
    try { this.assertControls(currentControls, baseCandidate, row.attempt_id); }
    catch (_) { return { state: 'unknown', reason: 'controls_denied_or_unknown' }; }
    if (canonical(currentControls) !== canonical(pinnedControls)) return { state: 'unknown', reason: 'controls_changed' };
    const stored = this.storeManifest();
    if (stored.digest !== expected.digest) return { state: 'unknown', reason: 'manifest_changed_during_reconciliation' };
    const base = baseCandidate;
    const record = this.commitCandidate({ ...pinned }, stored, {
      reservationIntentId: intentId,
      verifyCurrent: () => captureManifest(this.workspace).digest === expected.digest,
      onCommit: (saved) => this.setIntent(intentId, 'settling', { result: { candidateId: saved.candidateId, manifestDigest: stored.digest, reconciled: true } }),
    });
    if (!(await settleAdmission())) return { state: 'unknown', reason: 'admission_unresolved', candidate: record };
    this.setIntent(intentId, 'applied', { result: { candidateId: record.candidateId, manifestDigest: stored.digest, reconciled: true } });
    return { state: 'applied', candidate: record };
  }
}

function validateManifest(input) {
  if (!input || input.format !== 'candidate-manifest-v1' || !Array.isArray(input.entries) || typeof input.digest !== 'string') fail('manifest_invalid');
  const entries = input.entries.map((entry) => {
    if (!validPath(entry.path)) fail('path_unsafe', `Unsafe expected path: ${entry.path}`);
    if (!['100644', '100755'].includes(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.digest)) fail('manifest_entry_invalid');
    return { path: entry.path, mode: entry.mode, size: entry.size, digest: entry.digest };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) fail('manifest_path_duplicate');
  const value = { format: input.format, head: input.head ?? null, entries };
  value.digest = sha256(canonical(value));
  if (value.digest !== input.digest) fail('manifest_digest_invalid');
  return value;
}

function safeJsonReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('stored_manifest_invalid');
  return value;
}

module.exports = { CandidateStore, CandidateStoreError, captureManifest, validateManifest, sha256 };
