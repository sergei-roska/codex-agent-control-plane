'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectPatch, applyPatch } = require('./writer-worktree');
const { validateManifest, sha256 } = require('./candidate-store');
const { readProcessIdentity, isProcessGroupGone } = require('./process-quiescence');

class DeliveryOutputArtifactsError extends Error {
  constructor(code, message) { super(message || code); this.name = 'DeliveryOutputArtifactsError'; this.code = code; }
}

function fail(code, message) { throw new DeliveryOutputArtifactsError(code, message); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value); }
function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.includes('\\')
    && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function digestId(value, label) {
  if (typeof value !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) fail('identity_invalid', `${label} must be a SHA-256 digest`);
  return value;
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureDurableDirectory(dir, syncDir) {
  const target = path.resolve(dir); const missing = []; let cursor = target;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('storage_directory_unavailable');
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) fail('storage_path_unsafe');
  for (const created of missing.reverse()) {
    fs.mkdirSync(created, { mode: 0o700 }); syncDir(path.dirname(created)); syncDir(created);
  }
  syncDir(target);
}
function assertBlobDirectory(storageDir, dir, syncDir) {
  ensureDurableDirectory(dir, syncDir);
  if (fs.realpathSync(dir) !== path.resolve(dir) || !inside(storageDir, fs.realpathSync(dir)) || !fs.statSync(dir).isDirectory()) fail('storage_path_unsafe');
}
function readRegularBlob(storageDir, file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(storageDir, fs.realpathSync(file))) fail('blob_path_unsafe');
  return fs.readFileSync(file);
}
function assertSafeRoot(root, syncDir) {
  const absolute = path.resolve(root);
  ensureDurableDirectory(absolute, syncDir);
  const real = fs.realpathSync(absolute);
  if (real !== absolute || !fs.statSync(real).isDirectory()) fail('storage_path_unsafe');
  return real;
}
function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'].includes(key))),
  });
}
function splitNul(buffer) {
  const out = []; let start = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0) { out.push(buffer.subarray(start, i)); start = i + 1; }
  if (start !== buffer.length) fail('git_listing_malformed');
  return out;
}
function treeEntries(workspace, commit) {
  const result = new Map();
  for (const record of splitNul(git(workspace, ['ls-tree', '-r', '-l', '-z', commit]))) {
    const tab = record.indexOf(9);
    if (tab < 0) fail('base_tree_invalid');
    const header = record.subarray(0, tab).toString('ascii').split(' ');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(tab + 1));
    const mode = header[0];
    if (!validPath(name) || (mode !== '100644' && mode !== '100755') || header[1] !== 'blob') fail('base_tree_unsupported');
    const bytes = git(workspace, ['cat-file', 'blob', `${commit}:${name}`]);
    result.set(name, { path: name, mode, size: bytes.length, digest: sha256(bytes) });
  }
  return [...result.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function manifestOf(head, entries) {
  const value = { format: 'candidate-manifest-v1', head, entries };
  value.digest = sha256(canonical(value));
  return value;
}
function readLaneFile(root, relative) {
  if (!validPath(relative)) fail('path_unsafe');
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) fail('symlink_unsupported');
    if (cursor !== path.join(root, relative) && !stat.isDirectory()) fail('path_parent_not_directory');
    if (cursor === path.join(root, relative) && !stat.isFile()) fail('special_file_unsupported');
    if (!inside(root, fs.realpathSync(cursor))) fail('path_escape');
  }
  return fs.readFileSync(cursor);
}

class DeliveryOutputArtifacts {
  constructor({ db, backlogStore, laneManager, admission, workspace, storageDir, authorizeBinding,
    producerEvidenceFor, controls, quiescence, clock = () => new Date(), idFactory = () => crypto.randomUUID(), durability = {} }) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('db (better-sqlite3) is required');
    if (!backlogStore || !laneManager || !admission) throw new TypeError('backlogStore, laneManager and admission are required');
    this.db = db; this.backlogStore = backlogStore; this.laneManager = laneManager; this.admission = admission;
    this.workspace = fs.realpathSync(workspace);
    this.syncDirectory = durability.syncDirectory || syncDirectory;
    this.syncFile = durability.syncFile || syncFile;
    this.storageDir = assertSafeRoot(storageDir, this.syncDirectory);
    if (inside(this.workspace, this.storageDir) || inside(path.resolve(laneManager.lanesRoot), this.storageDir)
      || inside(this.storageDir, this.workspace) || inside(this.storageDir, path.resolve(laneManager.lanesRoot))) fail('storage_overlap');
    if (typeof authorizeBinding !== 'function') authorizeBinding = () => false;
    if (typeof producerEvidenceFor !== 'function') producerEvidenceFor = () => null;
    this.authorizeBinding = authorizeBinding; this.producerEvidenceFor = producerEvidenceFor;
    this.externalControls = controls || null;
    this.controlsResolver = (identity) => this.authorizedControls(identity);
    this.quiescenceResolver = quiescence || ((identity) => Boolean(identity && isProcessGroupGone(identity)));
    this.clock = clock; this.idFactory = idFactory; this.candidateStore = null;
    assertBlobDirectory(this.storageDir, path.join(this.storageDir, 'blobs'), this.syncDirectory);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_output_bindings (
        artifact_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL, task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL, lane_id TEXT NOT NULL, context_id TEXT NOT NULL, identity_json TEXT NOT NULL,
        state TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_output_binding_attempt_idx
        ON delivery_output_bindings(project_id,objective_id,attempt_id);
      CREATE TABLE IF NOT EXISTS delivery_output_publications (
        intent_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, request_json TEXT NOT NULL,
        state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  }

  now() { const value = this.clock(); return value instanceof Date ? value.toISOString() : String(value); }

  attachCandidateStore(store) {
    if (!store || typeof store.publish !== 'function' || typeof store.get !== 'function') throw new TypeError('CandidateStore is required');
    if (this.candidateStore && this.candidateStore !== store) fail('candidate_store_already_attached');
    this.candidateStore = store;
    return this;
  }

  candidateStoreOptions() {
    return { admission: this.publicationAdmission(), controls: (identity) => this.controlsResolver(identity),
      quiescence: (identity) => this.quiescenceResolver(identity), apply: (intent) => this.applyArtifact(intent) };
  }

  currentControls({ projectId, objectiveId, attemptId }) {
    const objective = this.backlogStore.getObjective(projectId, objectiveId);
    const attempt = this.backlogStore.listAttempts(projectId, objectiveId).find((item) => item.attemptId === attemptId);
    const current = { allowed: Boolean(objective && ['planning', 'executing'].includes(objective.disposition) && attempt),
      fenced: !attempt || ['expired', 'fenced'].includes(this.backlogStore.listClaims(projectId, objectiveId).find((item) => item.attemptId === attemptId)?.state),
      projectId, objectiveId, attemptId, controlRevision: objective?.controlRevision ?? -1, fencingToken: attempt?.fencingToken ?? 0 };
    if (this.externalControls) {
      const supplied = this.externalControls({ projectId, objectiveId, attemptId });
      if (!supplied || supplied.projectId !== projectId || supplied.objectiveId !== objectiveId || supplied.attemptId !== attemptId
        || supplied.controlRevision !== current.controlRevision || supplied.fencingToken !== current.fencingToken
        || supplied.allowed !== current.allowed || supplied.fenced !== current.fenced) return { ...current, allowed: false, fenced: true };
    }
    return current;
  }

  context(projectId, objectiveId, taskId, attemptId, fencingToken, { enrollment = false } = {}) {
    const objective = this.backlogStore.getObjective(projectId, objectiveId);
    if (!objective || !['planning', 'executing'].includes(objective.disposition)) fail('objective_not_active');
    const task = objective.tasks.find((item) => item.taskId === taskId);
    const attempt = this.backlogStore.listAttempts(projectId, objectiveId).find((item) => item.attemptId === attemptId);
    const claim = this.backlogStore.listClaims(projectId, objectiveId).find((item) => item.attemptId === attemptId);
    const activePair = claim?.state === 'active' && ['claimed', 'running'].includes(attempt?.state)
      && ['claimed', 'running'].includes(task?.state);
    const settledPair = claim?.state === 'released' && attempt?.state === 'succeeded' && task?.state === 'succeeded';
    const allowedState = activePair || settledPair;
    if (!task || !attempt || !claim || attempt.taskId !== taskId || attempt.fencingToken !== fencingToken || claim.fencingToken !== fencingToken
      || !allowedState || (!enrollment && attempt.state === 'claimed')) fail('backlog_attempt_stale');
    return { objective, task, attempt, claim };
  }

  bind(input) {
    const { projectId, objectiveId, taskId, attemptId, fencingToken, laneId, baseCandidateId,
      declaredWritePaths, environmentDigest, checkIdentity } = input || {};
    for (const [name, value] of Object.entries({ projectId, objectiveId, taskId, attemptId, laneId, baseCandidateId, checkIdentity })) {
      if (!validId(value)) fail('identity_invalid', `${name} is invalid`);
    }
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1 || !Array.isArray(declaredWritePaths)
      || declaredWritePaths.length > 1000 || declaredWritePaths.some((name) => !validPath(name)) || new Set(declaredWritePaths).size !== declaredWritePaths.length) fail('binding_invalid');
    const context = this.context(projectId, objectiveId, taskId, attemptId, fencingToken, { enrollment: true });
    if (declaredWritePaths.some((name) => !context.attempt.contractSnapshot.productWritePaths.includes(name))) fail('binding_scope_invalid');
    const lane = this.laneManager.store.get(laneId);
    if (!lane || lane.workspace !== this.workspace || lane.taskId !== attemptId || lane.contextId !== context.attempt.providerContextId
      || !['prepared', 'running'].includes(lane.state) || !lane.path || !lane.baseCommit) fail('private_lane_untrusted');
    const lanePath = fs.realpathSync(lane.path); const lanesRoot = fs.realpathSync(this.laneManager.lanesRoot);
    if (inside(lanesRoot, this.storageDir) || inside(this.storageDir, lanesRoot)) fail('storage_overlap');
    if (!inside(lanesRoot, lanePath) || inside(this.workspace, lanePath) || inside(lanePath, this.workspace)
      || inside(this.storageDir, lanePath) || inside(lanePath, this.storageDir)) fail('private_lane_unsafe');
    const binding = { projectId, objectiveId, taskId, attemptId, fencingToken, laneId, lanePath, baseCommit: lane.baseCommit,
      contextId: lane.contextId, providerContextId: context.attempt.providerContextId,
      taskRevision: context.attempt.taskRevision, contractDigest: context.attempt.contractDigest,
      taskContract: context.attempt.contractSnapshot, selectedSettingsDigest: context.attempt.selectedSettingsDigest,
      ownerGeneration: context.claim.ownerGeneration, controlRevision: context.objective.controlRevision,
      goalRevision: context.objective.goalRevision, requirementDigest: context.objective.requirementDigest,
      checksDigest: context.objective.checksDigest, authorityRevision: context.objective.authorityRevision,
      planRevision: context.objective.planRevision,
      declaredWritePaths: [...declaredWritePaths].sort(), baseCandidateId,
      environmentDigest: digestId(environmentDigest, 'environmentDigest'), checkIdentity };
    if (!binding.taskContract || binding.contractDigest !== `sha256:${sha256(Buffer.from(JSON.stringify(binding.taskContract)))}`
      || binding.taskRevision !== context.task.revision) fail('task_contract_pin_mismatch');
    this.assertHostAuthorization(binding, 'bind');
    const prior = this.db.prepare('SELECT artifact_id,identity_json,state,record_json,created_at FROM delivery_output_bindings WHERE project_id=? AND objective_id=? AND attempt_id=?')
      .get(projectId, objectiveId, attemptId);
    if (prior) {
      if (prior.identity_json !== canonical(binding)) fail('binding_identity_conflict');
      return { artifactId: prior.artifact_id, state: prior.state, binding: structuredClone(binding), createdAt: prior.created_at, replay: true };
    }
    const artifactId = this.idFactory(); if (!validId(artifactId)) fail('identity_invalid');
    const at = this.now();
    this.db.prepare(`INSERT INTO delivery_output_bindings(artifact_id,project_id,objective_id,task_id,attempt_id,lane_id,context_id,identity_json,state,record_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,'bound',?,?)`).run(artifactId, projectId, objectiveId, taskId, attemptId, laneId, lane.contextId, canonical(binding), canonical({ binding }), at);
    return { artifactId, state: 'bound', binding: structuredClone(binding), createdAt: at };
  }

  binding(artifactId) {
    const row = this.db.prepare('SELECT * FROM delivery_output_bindings WHERE artifact_id=?').get(artifactId);
    if (!row) fail('artifact_missing');
    return { row, record: JSON.parse(row.record_json), identity: JSON.parse(row.identity_json) };
  }

  assertHostAuthorization(binding, operation) {
    const { objective, task, attempt, claim } = this.context(binding.projectId, binding.objectiveId, binding.taskId, binding.attemptId,
      binding.fencingToken, { enrollment: operation === 'bind' });
    const controls = this.currentControls({ projectId: binding.projectId, objectiveId: binding.objectiveId, attemptId: binding.attemptId });
    if (controls.allowed !== true || controls.fenced !== false || controls.controlRevision !== binding.controlRevision
      || controls.fencingToken !== binding.fencingToken) fail('binding_controls_stale');
    const authorized = this.authorizeBinding({ ...structuredClone(binding), task, attempt, claim, objective, operation });
    if (authorized && typeof authorized.then === 'function') fail('binding_authorizer_must_be_synchronous');
    if (authorized !== true) fail('binding_authorization_denied');
    return { objective, task, attempt, claim };
  }

  assertCurrent(binding, operation = 'verify') {
    const { objective, task, attempt, claim } = this.context(binding.projectId, binding.objectiveId, binding.taskId, binding.attemptId, binding.fencingToken);
    if (task.revision !== binding.taskRevision || attempt.taskRevision !== binding.taskRevision || attempt.contractDigest !== binding.contractDigest
      || canonical(attempt.contractSnapshot) !== canonical(binding.taskContract)
      || attempt.selectedSettingsDigest !== binding.selectedSettingsDigest || attempt.providerContextId !== binding.providerContextId
      || claim.ownerGeneration !== binding.ownerGeneration || objective.ownerGeneration !== binding.ownerGeneration
      || objective.controlRevision !== binding.controlRevision
      || objective.goalRevision !== binding.goalRevision || objective.requirementDigest !== binding.requirementDigest
      || objective.checksDigest !== binding.checksDigest || objective.authorityRevision !== binding.authorityRevision
      || !Number.isSafeInteger(objective.planRevision) || objective.planRevision < binding.planRevision) fail('binding_pins_stale');
    this.assertHostAuthorization(binding, operation);
    return { objective, task, attempt, claim };
  }

  authorizedControls(identity) {
    const current = this.currentControls(identity);
    const row = this.db.prepare('SELECT identity_json FROM delivery_output_bindings WHERE project_id=? AND objective_id=? AND attempt_id=?')
      .get(identity.projectId, identity.objectiveId, identity.attemptId);
    if (!row) return { ...current, allowed: false, fenced: true };
    try { this.assertCurrent(JSON.parse(row.identity_json), 'candidate-control'); return current; }
    catch (_) { return { ...current, allowed: false, fenced: true }; }
  }

  proofFor(binding, supplied) {
    const proof = this.producerEvidenceFor(structuredClone(binding), supplied);
    if (proof && typeof proof.then === 'function') fail('producer_evidence_must_be_synchronous');
    const keys = ['projectId', 'objectiveId', 'taskId', 'attemptId', 'fencingToken', 'providerContextId', 'providerThreadId',
      'providerTurnId', 'providerThreadReceipt', 'terminalStatus', 'remoteQuiescent', 'processQuiescent', 'effectsSettled', 'evidenceDigest'];
    const receipt = proof?.providerThreadReceipt;
    const receiptKeys = ['processIdentity', 'threadId', 'turnId', 'turnStartSent', 'turnStartRejected', 'turnTerminal'];
    if (!proof || typeof proof !== 'object' || Object.keys(proof).sort().join('|') !== [...keys].sort().join('|')
      || proof.projectId !== binding.projectId || proof.objectiveId !== binding.objectiveId || proof.taskId !== binding.taskId
      || proof.attemptId !== binding.attemptId || proof.fencingToken !== binding.fencingToken
      || proof.providerContextId !== binding.providerContextId || !validId(proof.providerThreadId) || !validId(proof.providerTurnId)
      || proof.terminalStatus !== 'completed'
      || proof.remoteQuiescent !== true || proof.processQuiescent !== true || proof.effectsSettled !== true
      || !receipt || Object.keys(receipt).sort().join('|') !== [...receiptKeys].sort().join('|')
      || receipt.threadId !== proof.providerThreadId || receipt.turnId !== proof.providerTurnId
      || receipt.turnStartSent !== true || receipt.turnStartRejected !== false || receipt.turnTerminal !== true
      || !receipt.processIdentity || !Number.isSafeInteger(receipt.processIdentity.pid) || receipt.processIdentity.pid <= 1
      || !Number.isSafeInteger(receipt.processIdentity.pgid) || typeof receipt.processIdentity.startTime !== 'string'
      || digestId(proof.evidenceDigest, 'evidenceDigest') == null) fail('producer_quiescence_unproven');
    return structuredClone(proof);
  }

  putBlob(bytes) {
    const digest = sha256(bytes); const dir = path.join(this.storageDir, 'blobs', digest.slice(0, 2));
    assertBlobDirectory(this.storageDir, path.dirname(dir), this.syncDirectory);
    assertBlobDirectory(this.storageDir, dir, this.syncDirectory);
    const file = path.join(dir, digest); const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    if (fs.existsSync(file)) {
      const existing = readRegularBlob(this.storageDir, file); if (sha256(existing) !== digest) fail('blob_corrupt');
      return { digest, size: bytes.length };
    }
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    this.syncFile(temp);
    try { fs.renameSync(temp, file); } catch (error) { fs.rmSync(temp, { force: true }); if (error.code !== 'EEXIST') throw error; }
    this.syncDirectory(dir);
    if (sha256(readRegularBlob(this.storageDir, file)) !== digest) fail('blob_corrupt');
    return { digest, size: bytes.length };
  }

  readBlob(digest, size) {
    const file = path.join(this.storageDir, 'blobs', digest.slice(0, 2), digest);
    const bytes = readRegularBlob(this.storageDir, file);
    if (sha256(bytes) !== digest || bytes.length !== size) fail('blob_corrupt');
    return bytes;
  }

  capture({ artifactId, producerEvidence } = {}) {
    const { row, record, identity } = this.binding(artifactId);
    if (row.state === 'captured' || row.state === 'no_change') {
      this.assertCurrent(identity, 'capture-replay');
      return { ...record.artifact, replay: true };
    }
    if (row.state !== 'bound') fail('artifact_state_conflict');
    this.assertCurrent(identity, 'capture');
    const proof = this.proofFor(identity, producerEvidence);
    const laneRow = this.laneManager.store.get(identity.laneId);
    if (!laneRow || laneRow.path !== identity.lanePath || laneRow.baseCommit !== identity.baseCommit
      || !['prepared', 'running'].includes(laneRow.state)) fail('private_lane_changed');
    if (fs.realpathSync(identity.lanePath) !== identity.lanePath || !inside(fs.realpathSync(this.laneManager.lanesRoot), identity.lanePath)) fail('private_lane_unsafe');
    const base = this.candidateStore?.get(identity.baseCandidateId);
    if (!base || base.status !== 'known' || base.projectId !== identity.projectId || base.objectiveId !== identity.objectiveId) fail('base_candidate_unknown');
    const before = this.candidateStore.readManifest(base.manifestDigest);
    const baseTreeEntries = treeEntries(this.workspace, identity.baseCommit);
    if (canonical(baseTreeEntries) !== canonical(before.entries)) fail('lane_base_candidate_mismatch');
    if (git(identity.lanePath, ['rev-parse', 'HEAD']).toString('utf8').trim() !== identity.baseCommit) fail('lane_head_changed');
    const collected = collectPatch({ lane: identity.lanePath, base: identity.baseCommit, exclude: this.laneManager.links || [], root: this.workspace });
    const paths = collected.changes.map((change) => change.path).sort();
    if (paths.some((name) => !identity.declaredWritePaths.includes(name))) fail('output_scope_violation');
    const patch = Buffer.from(collected.patch);
    const patchBlob = this.putBlob(patch);
    const entryMap = new Map(before.entries.map((entry) => [entry.path, entry]));
    const outputFiles = [];
    for (const change of collected.changes) {
      if (change.status === 'D') { entryMap.delete(change.path); outputFiles.push({ path: change.path, deleted: true }); continue; }
      const bytes = readLaneFile(identity.lanePath, change.path);
      if (!bytes) fail('lane_output_missing');
      const stat = fs.statSync(path.join(identity.lanePath, ...change.path.split('/')));
      const fileBlob = this.putBlob(bytes);
      const entry = { path: change.path, mode: stat.mode & 0o111 ? '100755' : '100644', size: bytes.length, digest: fileBlob.digest };
      entryMap.set(change.path, entry); outputFiles.push({ path: change.path, deleted: false, mode: entry.mode, ...fileBlob });
    }
    const recollected = collectPatch({ lane: identity.lanePath, base: identity.baseCommit, exclude: this.laneManager.links || [], root: this.workspace });
    if (!Buffer.from(recollected.patch).equals(patch) || canonical(recollected.changes) !== canonical(collected.changes)) fail('lane_output_changed_during_capture');
    const expected = validateManifest(manifestOf(before.head, [...entryMap.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
    const deltaPaths = [...new Set([...before.entries.map((entry) => entry.path), ...expected.entries.map((entry) => entry.path)])]
      .filter((name) => canonical(before.entries.find((item) => item.path === name) || null) !== canonical(expected.entries.find((item) => item.path === name) || null)).sort();
    if (canonical(paths) !== canonical(deltaPaths)) fail('output_delta_mismatch');
    const artifact = { artifactId, state: patch.length ? 'captured' : 'no_change', binding: identity, baseCandidateId: base.candidateId,
      baseManifestDigest: before.digest, expectedManifest: expected, deltaPaths, patch: patchBlob, files: outputFiles,
      producerEvidence: proof, capturedAt: this.now() };
    const saved = this.db.transaction(() => {
      this.assertCurrent(identity, 'capture-commit');
      return this.db.prepare("UPDATE delivery_output_bindings SET state=?,record_json=? WHERE artifact_id=? AND state='bound'")
        .run(artifact.state, canonical({ binding: identity, artifact }), artifactId);
    }).immediate();
    if (saved.changes !== 1) fail('artifact_capture_conflict');
    return structuredClone(artifact);
  }

  get(artifactId) {
    const { row, record } = this.binding(artifactId);
    return row.state === 'bound' ? { artifactId, state: 'bound', binding: record.binding }
      : structuredClone(record.artifact);
  }

  publicationAdmission() {
    return {
      acquire: async ({ taskId, contextId }) => {
        const pub = this.db.prepare('SELECT artifact_id FROM delivery_output_publications WHERE intent_id=?').get(contextId);
        if (!pub) fail('publication_artifact_unbound');
        const { row, identity } = this.binding(pub.artifact_id);
        if (row.state !== 'captured') fail('artifact_not_publishable');
        this.assertCurrent(identity, 'publication-admission');
        const controls = this.controlsResolver({ projectId: identity.projectId, objectiveId: identity.objectiveId, attemptId: identity.attemptId });
        if (!controls || controls.allowed !== true || controls.fenced !== false || controls.fencingToken !== identity.fencingToken
          || controls.controlRevision !== identity.controlRevision) fail('publication_controls_stale');
        const lease = await this.admission.acquire({ role: 'integration', taskId, contextId });
        return { ...lease, projectId: identity.projectId, objectiveId: identity.objectiveId, attemptId: identity.attemptId,
          fencingToken: identity.fencingToken, controlRevision: identity.controlRevision };
      },
      release: (executionId) => this.admission.release(executionId),
      markUnresolved: (executionId, reason) => this.admission.markUnresolved(executionId, reason),
      findByContextId: (contextId) => this.admission.findByContextId(contextId),
      findAnyByContextId: (contextId) => this.admission.findAnyByContextId(contextId),
      reconcile: (executionId) => this.admission.reconcile(executionId),
    };
  }

  async applyArtifact(intent) {
    const pub = this.db.prepare('SELECT artifact_id FROM delivery_output_publications WHERE intent_id=?').get(intent.intentId);
    if (!pub) fail('publication_artifact_unbound');
    const { row, record, identity } = this.binding(pub.artifact_id);
    const artifact = record.artifact;
    if (row.state !== 'captured' || artifact.expectedManifest.digest !== intent.expected.digest
      || canonical(artifact.deltaPaths) !== canonical(intent.deltaPaths) || artifact.binding.attemptId !== intent.attemptId) fail('artifact_intent_mismatch');
    this.assertCurrent(identity, 'publication-apply');
    const patch = this.readBlob(artifact.patch.digest, artifact.patch.size);
    let processIdentity = null;
    const result = await applyPatch({ root: this.workspace, patch, onSpawn: (pid) => {
      processIdentity = readProcessIdentity(pid); intent.onSpawn(processIdentity);
    } });
    return { ...result, processIdentity };
  }

  publicationInput(publication, identity, artifact) {
    const request = JSON.parse(publication.request_json);
    return { candidateId: request.candidateId, intentId: request.intentId, baseCandidateId: artifact.baseCandidateId,
      sourceAttemptId: identity.attemptId, integrationGeneration: request.integrationGeneration,
      environmentDigest: identity.environmentDigest, checkIdentity: identity.checkIdentity,
      expectedManifest: artifact.expectedManifest, deltaPaths: artifact.deltaPaths };
  }

  assertPublicationCommand(publication, identity, artifact) {
    const request = JSON.parse(publication.request_json);
    if (request.intentId !== publication.intent_id || request.artifactId !== publication.artifact_id
      || artifact.artifactId !== publication.artifact_id || artifact.binding.attemptId !== identity.attemptId
      || artifact.baseCandidateId !== identity.baseCandidateId) fail('publication_identity_conflict');
    return request;
  }

  assertPublicationIntent(publication, identity, artifact) {
    const request = this.assertPublicationCommand(publication, identity, artifact);
    const row = this.db.prepare('SELECT * FROM candidate_intents WHERE intent_id=?').get(publication.intent_id);
    if (!row) return null;
    const expectedInput = this.publicationInput(publication, identity, artifact);
    const before = JSON.parse(row.before_manifest_json);
    const expected = JSON.parse(row.expected_manifest_json);
    const deltaPaths = JSON.parse(row.delta_paths_json);
    const controls = JSON.parse(row.controls_json);
    const admission = JSON.parse(row.admission_json);
    const currentControls = this.controlsResolver({ projectId: identity.projectId, objectiveId: identity.objectiveId, attemptId: identity.attemptId });
    const base = this.candidateStore.get(identity.baseCandidateId);
    if (!base || row.intent_id !== request.intentId || row.project_id !== identity.projectId || row.objective_id !== identity.objectiveId
      || row.candidate_id !== request.candidateId || row.base_candidate_id !== expectedInput.baseCandidateId
      || row.parent_candidate_id !== expectedInput.baseCandidateId || row.attempt_id !== identity.attemptId
      || row.integration_generation !== request.integrationGeneration || row.environment_digest !== identity.environmentDigest
      || row.check_identity !== identity.checkIdentity || row.content_manifest_digest !== artifact.expectedManifest.digest
      || row.content_manifest_digest !== expected.digest || canonical(expected) !== canonical(artifact.expectedManifest)
      || canonical(deltaPaths) !== canonical(artifact.deltaPaths) || before.digest !== artifact.baseManifestDigest
      || before.digest !== base.manifestDigest || canonical(before) !== canonical(this.candidateStore.readManifest(base.manifestDigest))
      || controls.allowed !== true || controls.fenced !== false || controls.projectId !== identity.projectId
      || controls.objectiveId !== identity.objectiveId || controls.attemptId !== identity.attemptId
      || controls.controlRevision !== identity.controlRevision || controls.fencingToken !== identity.fencingToken
      || (admission.contextId !== undefined && admission.contextId !== request.intentId)
      || (admission.taskId !== undefined && admission.taskId !== identity.attemptId)
      || (admission.projectId !== undefined && admission.projectId !== identity.projectId)
      || (admission.objectiveId !== undefined && admission.objectiveId !== identity.objectiveId)
      || (admission.attemptId !== undefined && admission.attemptId !== identity.attemptId)
      || (admission.fencingToken !== undefined && admission.fencingToken !== identity.fencingToken)
      || (admission.controlRevision !== undefined && admission.controlRevision !== identity.controlRevision)
      || canonical(currentControls) !== canonical(controls)) fail('candidate_intent_projection_mismatch');
    if (admission.executionId) {
      const live = this.admission.findByContextId(request.intentId) || this.admission.findAnyByContextId(request.intentId);
      if (!live || live.executionId !== admission.executionId) fail('candidate_intent_admission_mismatch');
    }
    return row;
  }

  // CandidateStore owns current effect state; bridge result columns are observations only.
  projectPublication(publication, identity, artifact, { replay = true } = {}) {
    this.assertCurrent(identity, 'publication-replay');
    this.assertPublicationCommand(publication, identity, artifact);
    const candidateIntent = this.candidateStore.getIntent(publication.intent_id);
    if (!candidateIntent) {
      if (publication.state === 'refused') return { state: 'refused', intentId: publication.intent_id, replay };
      return { state: 'unknown', intentId: publication.intent_id, replay };
    }
    this.assertPublicationIntent(publication, identity, artifact);
    if (candidateIntent.state === 'applied') {
      const candidate = this.candidateStore.get(candidateIntent.candidateId);
      if (!candidate || candidate.status !== 'known' || candidate.candidateId !== JSON.parse(publication.request_json).candidateId
        || candidate.projectId !== identity.projectId || candidate.objectiveId !== identity.objectiveId
        || candidate.parentCandidateId !== artifact.baseCandidateId || candidate.sourceAttemptId !== identity.attemptId
        || candidate.integrationGeneration !== JSON.parse(publication.request_json).integrationGeneration
        || candidate.environmentDigest !== identity.environmentDigest || candidate.checkIdentity !== identity.checkIdentity
        || candidate.manifestDigest !== artifact.expectedManifest.digest) fail('candidate_intent_projection_mismatch');
      return { state: 'applied', intentId: publication.intent_id, candidate, replay };
    }
    if (candidateIntent.state === 'not_applied') return { state: 'not_applied', intentId: publication.intent_id, replay };
    if (candidateIntent.state === 'refused') return { state: 'refused', intentId: publication.intent_id, replay };
    return { state: 'unknown', intentId: publication.intent_id, replay };
  }

  async publish({ artifactId, candidateId, intentId, integrationGeneration } = {}) {
    if (!this.candidateStore) fail('candidate_store_required');
    if (!validId(artifactId) || !validId(candidateId) || !validId(intentId)
      || !Number.isSafeInteger(integrationGeneration) || integrationGeneration < 1) fail('publication_input_invalid');
    const { row, record, identity } = this.binding(artifactId);
    if (row.state !== 'captured') fail(row.state === 'no_change' ? 'artifact_has_no_changes' : 'artifact_not_publishable');
    this.assertCurrent(identity, 'publish');
    const request = { artifactId, candidateId, intentId, integrationGeneration };
    const existing = this.db.prepare('SELECT * FROM delivery_output_publications WHERE intent_id=?').get(intentId);
    if (existing) {
      if (existing.artifact_id !== artifactId || existing.request_json !== canonical(request)) fail('publication_identity_conflict');
      return this.projectPublication(existing, identity, record.artifact);
    }
    if (this.db.prepare('SELECT intent_id FROM delivery_output_publications WHERE artifact_id=?').get(artifactId)) fail('artifact_already_published');
    const at = this.now();
    this.db.prepare("INSERT INTO delivery_output_publications(intent_id,artifact_id,request_json,state,created_at,updated_at) VALUES(?,?,?,'prepared',?,?)")
      .run(intentId, artifactId, canonical(request), at, at);
    const input = { candidateId, intentId, baseCandidateId: record.artifact.baseCandidateId, sourceAttemptId: identity.attemptId,
      integrationGeneration, environmentDigest: identity.environmentDigest, checkIdentity: identity.checkIdentity,
      expectedManifest: record.artifact.expectedManifest, deltaPaths: record.artifact.deltaPaths,
      admissionFacts: { artifactId, patchDigest: record.artifact.patch.digest, fencingToken: identity.fencingToken,
        controlRevision: identity.controlRevision } };
    try {
      const value = await this.candidateStore.publish(input);
      this.db.prepare('UPDATE delivery_output_publications SET state=?,result_json=?,updated_at=? WHERE intent_id=?')
        .run(value.state, canonical(value), this.now(), intentId);
      const saved = this.db.prepare('SELECT * FROM delivery_output_publications WHERE intent_id=?').get(intentId);
      return this.projectPublication(saved, identity, record.artifact, { replay: false });
    } catch (error) {
      const candidateIntent = this.candidateStore.getIntent(intentId);
      const state = !candidateIntent || candidateIntent.state === 'refused' ? 'refused' : 'unknown';
      this.db.prepare('UPDATE delivery_output_publications SET state=?,result_json=?,updated_at=? WHERE intent_id=?')
        .run(state, canonical({ state, error: error.code || 'publish_error' }), this.now(), intentId);
      throw error;
    }
  }

  async reconcilePublication({ intentId, candidateId, integrationGeneration } = {}) {
    if (!this.candidateStore || !validId(intentId)) fail('publication_input_invalid');
    const publication = this.db.prepare('SELECT * FROM delivery_output_publications WHERE intent_id=?').get(intentId);
    if (!publication) fail('publication_missing');
    const request = JSON.parse(publication.request_json);
    if ((candidateId !== undefined && candidateId !== request.candidateId)
      || (integrationGeneration !== undefined && integrationGeneration !== request.integrationGeneration)) fail('publication_identity_conflict');
    const { record, identity } = this.binding(publication.artifact_id);
    this.assertCurrent(identity, 'publication-reconcile');
    const intent = this.candidateStore.getIntent(intentId);
    if (!intent) return this.projectPublication(publication, identity, record.artifact);
    this.assertPublicationIntent(publication, identity, record.artifact);
    await this.candidateStore.reconcile(intentId, { integrationGeneration: request.integrationGeneration });
    const current = this.db.prepare('SELECT * FROM delivery_output_publications WHERE intent_id=?').get(intentId);
    return this.projectPublication(current, identity, record.artifact);
  }
}

module.exports = { DeliveryOutputArtifacts, DeliveryOutputArtifactsError };
