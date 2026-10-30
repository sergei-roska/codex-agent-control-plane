'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathsOutsideAllowed } = require('./contracts');
const { laneSandboxPolicy } = require('./codex-app-server');
const { nativeWorkspaceWriteBinding, createLaneExecutionCapability } = require('./lane-execution-policy');
const { inspectRepo, createBase, addLane, collectPatch, applyPatch, removeLane } = require('./writer-worktree');
const { runConfinementProbe, createLaneProbeStore } = require('./lane-probe');
const { readProcessIdentity } = require('./process-quiescence');

// Writer lanes (docs/parallel-writers-design.md): a writable attempt edits a private git
// worktree; the server integrates its patch into the shared tree under writer admission.

const DEFAULT_LINKS = '.venv,venv,node_modules';
const DEFAULT_RETENTION_HOURS = 72;
const LIVE_STATES = new Set(['preparing', 'prepared', 'running']);
const KEPT_STATES = new Set(['orphaned', 'not_integrated']);
const TERMINAL_STATES = new Set(['integrated', 'not_integrated', 'orphaned', 'removed', 'continued']);
const ADOPTABLE_REASONS = new Set(['turn_failed', 'outcome_unknown']);

function createLaneStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS writer_lanes (
      lane_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      task_id TEXT,
      workspace TEXT NOT NULL,
      path TEXT NOT NULL,
      base_commit TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      turn_start_json TEXT,
      execution_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      continued_from TEXT
    );
  `);
  // A table created before BUD-2 lacks the continued_from column.
  if (!db.prepare('PRAGMA table_info(writer_lanes)').all().some((column) => column.name === 'continued_from')) {
    db.exec('ALTER TABLE writer_lanes ADD COLUMN continued_from TEXT');
  }
  const columns = { state: 'state', reason: 'reason', baseCommit: 'base_commit', turnStart: 'turn_start_json', executionId: 'execution_id' };
  const toRecord = (row) => (row ? {
    laneId: row.lane_id,
    contextId: row.context_id,
    taskId: row.task_id,
    workspace: row.workspace,
    path: row.path,
    baseCommit: row.base_commit,
    state: row.state,
    reason: row.reason,
    turnStart: row.turn_start_json == null ? null : JSON.parse(row.turn_start_json),
    executionId: row.execution_id,
    continuedFrom: row.continued_from ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null);
  const now = () => new Date().toISOString();
  return {
    insert({ laneId, contextId, taskId = null, workspace, path: lanePath, continuedFrom = null }) {
      const at = now();
      db.prepare(`INSERT INTO writer_lanes (lane_id, context_id, task_id, workspace, path, state, continued_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`).run(laneId, contextId, taskId, workspace, lanePath, continuedFrom, at, at);
    },
    update(laneId, fields) {
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!Object.hasOwn(fields, key)) continue;
        sets.push(`${column} = ?`);
        values.push(key === 'turnStart' ? JSON.stringify(fields[key]) : (fields[key] ?? null));
      }
      db.prepare(`UPDATE writer_lanes SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE lane_id = ?`).run(...values, now(), laneId);
    },
    get(laneId) {
      return toRecord(db.prepare('SELECT * FROM writer_lanes WHERE lane_id = ?').get(laneId));
    },
    list(workspace) {
      return db.prepare('SELECT * FROM writer_lanes WHERE workspace = ? ORDER BY created_at, lane_id').all(workspace).map(toRecord);
    },
  };
}

// One shared-tree mutex per real workspace path, shared by every executor in the process (R9).
const mutexes = new Map();

function workspaceMutex(workspace) {
  const key = fs.realpathSync(workspace);
  if (!mutexes.has(key)) {
    let tail = Promise.resolve();
    mutexes.set(key, {
      run(fn) {
        const result = tail.then(() => fn());
        tail = result.then(() => {}, () => {});
        return result;
      },
    });
  }
  return mutexes.get(key);
}

function exists(target) {
  try { fs.lstatSync(target); return true; } catch (_) { return false; }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Realpath of the deepest existing ancestor joined with the rest.
function realish(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...rest); } catch (_) { /* climb */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    rest.unshift(path.basename(current));
    current = parent;
  }
}

// `<state dir>/lanes`, unless that is inside the workspace; then a per-workspace cache dir (R11).
function resolveLanesRoot({ workspace, stateFile, home = os.homedir() }) {
  const real = fs.realpathSync(workspace);
  if (stateFile && stateFile !== ':memory:') {
    const candidate = realish(path.join(path.dirname(path.resolve(stateFile)), 'lanes'));
    if (!isInside(real, candidate)) return candidate;
  }
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
  return path.join(home, '.cache', 'codex-a2a', 'lanes', hash);
}

function laneLinks(value) {
  const raw = value == null ? DEFAULT_LINKS : String(value);
  const names = raw.split(',').map((name) => name.trim().replace(/\/+$/, '')).filter(Boolean);
  return [...new Set(names.filter((name) => !path.isAbsolute(name) && !path.normalize(name).split(path.sep).includes('..')))];
}

function laneRetentionHours(value) {
  const hours = Number(value);
  return value != null && String(value).trim() !== '' && Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_RETENTION_HOURS;
}

// Effective `sandbox_workspace_write.network_access` of the App Server config; false when unknown.
async function readNetworkAccess(appServer, cwd) {
  try {
    let config = null;
    if (typeof appServer?.readConfig === 'function') {
      config = await appServer.readConfig(cwd);
    } else if (typeof appServer?._request === 'function') {
      await appServer.start?.();
      config = (await appServer._request('config/read', { cwd, includeLayers: false }))?.config ?? null;
    }
    return config?.sandbox_workspace_write?.network_access === true;
  } catch (_) {
    return false;
  }
}

function versionKey(version) {
  return version || 'unknown';
}

// Stored passing result for the running App Server version, else a fresh probe that is stored (R1).
// A stored failure is kept for diagnosis but never reused: it may be a false failure (for example
// the shared tree edited during the probe), so the probe runs again.
async function probeVersion({ appServer, db, workspace, lanesRoot, links, networkAccess, runProbe = runConfinementProbe }) {
  const store = createLaneProbeStore(db);
  const version = versionKey(appServer.getVersion());
  const stored = store.get(version);
  if (stored?.ok === true) return { version: stored.version, ok: stored.ok, reason: stored.reason ?? null, stored: true };
  let result;
  try {
    fs.mkdirSync(lanesRoot, { recursive: true });
    // The probe compares the shared tree before and after: no lane prepare or apply may run meanwhile.
    result = await workspaceMutex(workspace).run(() => runProbe({ appServer, workspace, lanesRoot: fs.realpathSync(lanesRoot), links, networkAccess }));
  } catch (error) {
    result = { ok: false, version, reason: `probe_error: ${error?.message || String(error)}`, checks: [] };
  }
  const record = { ...result, ok: result?.ok === true, version: versionKey(result?.version || version) };
  try { store.put(record); } catch (_) { /* the result still applies to this process */ }
  return { version: record.version, ok: record.ok, reason: record.reason ?? null, stored: false };
}

/**
 * Startup mode selection (design "Mode selection"). Never creates a lane unless the App Server
 * can run the probe and the workspace is the top of a git work tree without submodules.
 */
async function selectWriterIsolation({ env = process.env, appServer, workspace, db, stateFile, home, runProbe, executionPermissions = 'inherit' }) {
  const lanesRoot = resolveLanesRoot({ workspace, stateFile, home });
  const links = laneLinks(env.CODEX_A2A_LANE_LINKS);
  const shared = (reason, extra = {}) => ({ mode: 'shared', reason, lanesRoot, links, networkAccess: false, probe: null, ...extra });
  const setting = String(env.CODEX_A2A_WRITER_ISOLATION ?? '').trim().toLowerCase() || 'worktree';
  if (setting === 'shared') return shared('isolation_shared');
  if (setting !== 'worktree') return shared(`isolation_invalid: ${setting}`);
  if (typeof appServer?.execCommand !== 'function' || typeof appServer?.getVersion !== 'function') return shared('probe_unsupported');
  const repo = inspectRepo(workspace);
  if (!repo.ok) return shared(repo.reason);
  if (repo.prefix !== '') return shared('not_work_tree_top');
  if (executionPermissions === 'full-access' && typeof appServer?.resolveExecutionPermissions !== 'function') {
    throw Object.assign(new Error('Owner full-access execution is unavailable (permission_api_unavailable)'), { code: 'full_access_unavailable' });
  }
  if (typeof appServer?.resolveExecutionPermissions === 'function') {
    let native = null;
    try { native = await appServer.resolveExecutionPermissions(workspace, executionPermissions, { fresh: true }); } catch (_) { /* strict fallback */ }
    if (executionPermissions === 'full-access') {
      if (native?.mode !== 'full-access' || native.writerProfile !== ':danger-full-access' || native.approvalPolicy !== 'never') {
        throw Object.assign(new Error(`Owner full-access execution is unavailable (${native?.reason || 'full_access_policy_unavailable'})`), {
          code: 'full_access_unavailable',
        });
      }
      return {
        mode: 'cooperative', reason: 'owner_full_access_cooperative', lanesRoot, links,
        networkAccess: true, inherited: false, ownerFullAccess: true, profile: native.writerProfile, probe: null,
      };
    }
    if (native?.mode === 'inherit') {
      if (native.sandboxMode === 'workspace-write' && !native.writerProfile) {
        const lanePolicyBinding = nativeWorkspaceWriteBinding(native, workspace);
        if (!lanePolicyBinding) return shared('native_permissions_use_shared_workspace', { inherited: true, profile: null });
        return {
          mode: 'cooperative', reason: 'trusted_native_workspace_write_cooperative', lanesRoot, links,
          networkAccess: lanePolicyBinding.sandboxPolicy.networkAccess, inherited: true, profile: null, probe: null,
          lanePolicyBinding,
        };
      }
      const fullAccess = native.writerProfile === ':danger-full-access' || native.sandboxMode === 'danger-full-access';
      if (!fullAccess) return shared('native_permissions_use_shared_workspace', { inherited: true, profile: native.writerProfile || null });
      return {
        mode: 'cooperative', reason: 'trusted_native_full_access_cooperative', lanesRoot, links,
        networkAccess: true, inherited: true, profile: native.writerProfile || null, probe: null,
      };
    }
  }
  const networkAccess = await readNetworkAccess(appServer, workspace);
  const probe = await probeVersion({ appServer, db, workspace, lanesRoot, links, networkAccess, runProbe });
  if (!probe.ok) return shared(`probe_failed: ${probe.reason}`, { networkAccess, probe });
  return { mode: 'worktree', reason: null, lanesRoot, links, networkAccess, probe };
}

function laneView(lane, state, reason, extra = {}) {
  return { id: lane.id, path: lane.path, workspacePath: lane.workspacePath, base: lane.base, state, reason, ...extra };
}

// R5: `effects: 'none'` only when no writer_executions row exists for the attempt.
function unintegrated(lane, reason, extra) {
  return { executionId: null, state: null, delta: null, reason: null, effects: 'none', lane: laneView(lane, 'not_integrated', reason, extra) };
}

function linksTo(link, target) {
  try { return fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target; } catch (_) { return false; }
}

// Shared entry equals the lane entry (null lane: the shared path must be absent).
function sameEntry(shared, lane) {
  let a = null;
  let b = null;
  try { a = fs.lstatSync(shared); } catch (_) { a = null; }
  if (lane === null) return a === null;
  try { b = fs.lstatSync(lane); } catch (_) { b = null; }
  if (!a || !b) return false;
  if (b.isSymbolicLink()) return a.isSymbolicLink() && fs.readlinkSync(shared) === fs.readlinkSync(lane);
  if (!a.isFile() || !b.isFile()) return false;
  if (Boolean(a.mode & 0o100) !== Boolean(b.mode & 0o100)) return false;
  return fs.readFileSync(shared).equals(fs.readFileSync(lane));
}

class LaneManager {
  constructor({
    db, workspace, admission, appServer = null, mode = 'shared', reason = null, lanesRoot, links = [], networkAccess = false,
    probe = null, runProbe = runConfinementProbe, spawnFn = spawn, quiescence, lanePolicyBinding = null,
    inherited = null, ownerFullAccess = false, profile = null,
  }) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('db (better-sqlite3) is required');
    if (!admission) throw new TypeError('admission is required');
    if (!lanesRoot) throw new TypeError('lanesRoot is required');
    this.db = db;
    this.store = createLaneStore(db);
    this.workspace = fs.realpathSync(workspace);
    this.admission = admission;
    this.appServer = appServer;
    this.mode = mode;
    this.reason = reason;
    this.inherited = inherited ?? (mode === 'cooperative' && !ownerFullAccess);
    this.ownerFullAccess = ownerFullAccess;
    this.profile = profile;
    this.lanesRoot = lanesRoot;
    this.links = links;
    this.networkAccess = networkAccess;
    this.lanePolicyBinding = lanePolicyBinding;
    this.probe = probe;
    this.runProbe = runProbe;
    this.spawnFn = spawnFn;
    this.quiescenceOverride = quiescence;
    this.mutex = workspaceMutex(this.workspace);
    this.reprobing = null;
    this.failedProbes = new Map();
  }

  get quiescence() {
    return this.quiescenceOverride || require('./process-quiescence');
  }

  status() {
    return {
      mode: this.mode, reason: this.reason, lanesRoot: this.lanesRoot, links: [...this.links], networkAccess: this.networkAccess,
      confinement: this.mode === 'worktree' ? 'probe-confirmed' : this.mode === 'cooperative' ? 'none' : null,
      inherited: this.inherited,
      ...(this.ownerFullAccess ? { ownerFullAccess: true, profile: this.profile } : {}),
      probe: this.probe ? { version: this.probe.version, ok: this.probe.ok, reason: this.probe.reason ?? null } : null,
    };
  }

  // Worktree mode and a passing probe for the running App Server version; a new version is
  // probed once (serialized), and a failure sends attempts to shared mode.
  async available() {
    if (this.mode === 'cooperative') return true;
    if (this.mode !== 'worktree') return false;
    const version = versionKey(this.appServer?.getVersion?.());
    if (this.probe?.version === version) return this.probe.ok === true;
    // After a failure in this process, a version is not probed again (no probing on every attempt).
    if (this.failedProbes.has(version)) return false;
    if (!this.reprobing) {
      this.reprobing = probeVersion({
        appServer: this.appServer, db: this.db, workspace: this.workspace, lanesRoot: this.lanesRoot,
        links: this.links, networkAccess: this.networkAccess, runProbe: this.runProbe,
      }).then((probe) => {
        this.probe = probe;
        if (!probe.ok) this.failedProbes.set(version, probe);
      }, () => { this.failedProbes.set(version, null); }).finally(() => { this.reprobing = null; });
    }
    await this.reprobing;
    return this.probe?.version === version && this.probe.ok === true;
  }

  // Lifecycle step 1. `{ refused: { code, message } }` for a fenced context (no row), else `{ lane }`.
  async prepare({ contextId, taskId }) {
    if (this.admission.isFenced(contextId)) {
      return { refused: { code: 'fenced', message: `Context "${contextId}" is fenced; its writer will not run.` } };
    }
    fs.mkdirSync(this.lanesRoot, { recursive: true });
    const id = `lane-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(fs.realpathSync(this.lanesRoot), id);
    this.store.insert({ laneId: id, contextId, taskId, workspace: this.workspace, path: dir });
    try {
      const lane = await this.mutex.run(() => {
        const base = createBase(this.workspace);
        const added = addLane({ root: this.workspace, base: base.commit, dir, links: this.links });
        return { id, path: added.path, workspacePath: added.workspacePath, base: base.commit, linked: added.linked, adminDir: added.adminDir };
      });
      this.store.update(id, { state: 'prepared', baseCommit: lane.base });
      return { lane };
    } catch (error) {
      try { this.store.update(id, { state: 'not_integrated', reason: 'prepare_failed' }); } catch (_) { /* recovery orphans it */ }
      throw error;
    }
  }

  /**
   * BUD-2: continue a usage-limited attempt in its own lane. Adopts the kept lane `laneId` only if
   * its row belongs to `ofContextId` and is not_integrated with reason turn_failed or outcome_unknown.
   * The old row becomes `continued`; a new row records the same path and base with continued_from.
   * Returns `{ refused }` for a fenced context, `{ lane, continuedFrom }`, or `{ fallback: reason }`.
   */
  adopt({ contextId, taskId, ofContextId, laneId }) {
    if (this.admission.isFenced(contextId)) {
      return { refused: { code: 'fenced', message: `Context "${contextId}" is fenced; its writer will not run.` } };
    }
    const old = laneId ? this.store.get(laneId) : null;
    if (!old) return { fallback: 'lane_row_missing' };
    if (old.workspace !== this.workspace || old.contextId !== ofContextId) return { fallback: 'lane_not_owned' };
    if (old.state !== 'not_integrated' || !ADOPTABLE_REASONS.has(old.reason)) return { fallback: `lane_state_${old.state}` };
    if (!old.baseCommit || !exists(old.path)) return { fallback: 'lane_vanished' };
    const id = `lane-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    this.db.transaction(() => {
      this.store.update(old.laneId, { state: 'continued', reason: null });
      this.store.insert({ laneId: id, contextId, taskId, workspace: this.workspace, path: old.path, continuedFrom: old.laneId });
      this.store.update(id, { state: 'prepared', baseCommit: old.baseCommit });
    })();
    const linked = this.links.filter((name) => linksTo(path.join(old.path, name), path.join(this.workspace, name)));
    // No admin dir: collectPatch finds it from the shared root, as laneApplied does.
    return { lane: { id, path: old.path, workspacePath: old.path, base: old.baseCommit, linked, adminDir: undefined }, continuedFrom: old.laneId };
  }

  laneInput(lane, input) {
    const boundary = this.mode === 'cooperative'
      ? `You work in a separate Git worktree as a coordination aid, and it is already your current working directory (${lane.workspacePath}). Run commands without a workdir argument and use relative paths. This worktree is not a security boundary: the configured native permissions may let commands reach the shared workspace. Follow the assigned file scope. The server integrates content changes after your turn; Git commits made in this worktree do not update the shared project branch.`
      : `You work in an isolated copy of the workspace, and it is already your current working directory (${lane.workspacePath}). Run commands without a workdir argument and use relative paths; never type this directory path yourself. Edit files only here. The server integrates your changes into the shared workspace after your turn.`;
    return `${boundary}\n${input}`;
  }

  sandboxPolicy(lane) {
    if (this.mode === 'cooperative') {
      if (!this.lanePolicyBinding) return null;
      const lanePath = lane?.path;
      const laneId = lane?.id;
      const isCurrent = () => {
        if (!lane || lane.workspacePath !== lanePath || lane.workspace !== undefined && lane.workspace !== this.workspace) return false;
        try {
          const row = this.store.get(laneId);
          return Boolean(row && row.workspace === this.workspace && row.path === lanePath
            && ['prepared', 'running'].includes(row.state) && fs.realpathSync(row.path) === lanePath
            && typeof this.admission.isFenced === 'function' && !this.admission.isFenced(row.contextId));
        } catch (_) { return false; }
      };
      return createLaneExecutionCapability({
        laneId, workspace: this.workspace, lanePath, binding: this.lanePolicyBinding, isCurrent,
      });
    }
    return laneSandboxPolicy({ workspacePath: lane.workspacePath, networkAccess: this.networkAccess });
  }

  markRunning(lane) {
    this.store.update(lane.id, { state: 'running' });
  }

  recordTurnStart(lane, { processIdentity = null, threadId = null } = {}) {
    this.store.update(lane.id, { state: 'running', turnStart: { processIdentity, threadId } });
  }

  /**
   * Lifecycle steps 3-7 after the turn. Returns `{ writerExecution, canceled }`; `settle(executionId,
   * known, reason)` is the executor's release-or-reconcile. Every non-integrated outcome keeps the lane.
   */
  async complete({ lane, integrate, reason = null, allowedFiles = [], role, taskId, contextId, signal, settle }) {
    const refuse = (why, extra) => {
      this.store.update(lane.id, { state: 'not_integrated', reason: why });
      return { canceled: why === 'canceled', writerExecution: unintegrated(lane, why, extra) };
    };
    if (!integrate) return refuse(reason || 'turn_failed');
    let collected;
    try {
      collected = collectPatch({ lane: lane.path, base: lane.base, exclude: lane.linked, adminDir: lane.adminDir, ...(lane.adminDir ? {} : { root: this.workspace }) });
    } catch (error) {
      return refuse('lane_unsafe', { unsafePaths: error?.code === 'lane_unsafe' && Array.isArray(error.paths) ? error.paths : [] });
    }
    const attemptedPaths = collected.changes.map((change) => change.path);
    if (!collected.patch.length || !attemptedPaths.length) {
      const refused = refuse('no_changes');
      if (collected.patch.length === 0 && attemptedPaths.length === 0) {
        refused.writerExecution.delta = {
          known: true,
          headChanged: false,
          changedPaths: [],
          changedPathCount: 0,
          source: 'lane_collection',
        };
      }
      return refused;
    }
    // Scope gate (R7): one path outside allowedFiles refuses the whole patch.
    const outside = pathsOutsideAllowed(attemptedPaths, allowedFiles, this.workspace);
    if (outside.length) return refuse('lane_scope_refused', { attemptedPaths, scopeViolations: outside });

    // Integration (R3, R9): admission first, then the mutex only around check and apply.
    this.store.update(lane.id, { state: 'integrating' });
    let execution;
    try {
      execution = await this.admission.acquire({ role, taskId, contextId, signal });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') return refuse('canceled', { attemptedPaths });
      if (error?.code === 'fenced' || error?.code === 'admission_blocked') return refuse(error.code, { attemptedPaths });
      refuse('integration_interrupted');
      throw error;
    }
    const { executionId } = execution;
    let writer = null;
    let spawned = false;
    try {
      this.store.update(lane.id, { executionId });
      let outcome;
      try {
        outcome = await this.mutex.run(() => applyPatch({
          root: this.workspace,
          patch: collected.patch,
          // Crash window: a pending turn start before spawn keeps quiescence unproven until the real identity is recorded.
          spawnFn: (...args) => {
            this.admission.recordTurnStart(executionId, { processIdentity: null, pending: true, threadId: null });
            return this.spawnFn(...args);
          },
          onSpawn: (pid) => {
            spawned = true;
            this.admission.recordTurnStart(executionId, { processIdentity: readProcessIdentity(pid), threadId: null });
          },
        }));
      } catch (error) {
        outcome = { applied: false, conflict: false, partial: true, error };
      }
      // A failed apply that had spawned is settled through quiescence of its recorded group.
      writer = await settle(executionId, !(outcome.error && spawned), 'apply_error');
      if (outcome.applied) {
        try {
          await this.mutex.run(() => removeLane({ root: this.workspace, lane: lane.path, lanesRoot: this.lanesRoot }));
        } catch (_) { /* kept; retention removes it */ }
        this.store.update(lane.id, { state: 'integrated', reason: null });
        return { canceled: false, writerExecution: { ...writer, lane: laneView(lane, 'integrated', null, { attemptedPaths }) } };
      }
      const why = outcome.conflict ? 'integration_conflict' : 'partial_apply';
      this.store.update(lane.id, { state: 'not_integrated', reason: why });
      const extra = outcome.conflict ? { conflicts: outcome.paths || [], attemptedPaths } : { attemptedPaths };
      return { canceled: false, writerExecution: { ...writer, lane: laneView(lane, 'not_integrated', why, extra) } };
    } catch (error) {
      // Never leave the workspace held, whatever failed after admission.
      if (!writer) writer = await settle(executionId, !spawned, 'executor_error');
      try { this.store.update(lane.id, { state: 'not_integrated', reason: 'integration_interrupted' }); } catch (_) { /* recovery resolves it */ }
      return { canceled: false, writerExecution: { ...writer, lane: laneView(lane, 'not_integrated', 'integration_interrupted', { attemptedPaths }) } };
    }
  }

  // writerExecution for a lane attempt that fell out of the normal flow (executor error).
  abandon(lane) {
    let row = null;
    try { row = this.store.get(lane.id); } catch (_) { row = null; }
    const reason = row?.state === 'not_integrated' && row.reason ? row.reason : 'integration_interrupted';
    try {
      if (!row || !TERMINAL_STATES.has(row.state)) this.store.update(lane.id, { state: 'not_integrated', reason });
    } catch (_) { /* recovery resolves it */ }
    if (row?.executionId) {
      const record = this.admission.get(row.executionId);
      return {
        executionId: row.executionId,
        state: record?.state ?? null,
        delta: record?.delta ?? null,
        reason: record?.state === 'unresolved' ? (record.reason ?? null) : null,
        lane: laneView(lane, 'not_integrated', reason),
      };
    }
    return unintegrated(lane, reason);
  }

  // Integration row of an `integrating` lane when its execution_id was never stored.
  executionFor(row) {
    if (!row.taskId) return null;
    const found = this.admission.db.prepare(`SELECT execution_id FROM writer_executions
      WHERE workspace = ? AND context_id = ? AND task_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`)
      .get(this.admission.workspace, row.contextId, row.taskId, row.createdAt);
    return found ? this.admission.get(found.execution_id) : null;
  }

  // Every path the lane changed is present in the shared tree exactly as in the lane.
  laneApplied(row) {
    // Only a finished integration removes a lane before its row is final.
    if (!exists(row.path)) return true;
    try {
      const linked = this.links.filter((name) => linksTo(path.join(row.path, name), path.join(this.workspace, name)));
      const { changes } = collectPatch({ lane: row.path, base: row.baseCommit, exclude: linked, root: this.workspace });
      return changes.length > 0 && changes.every((change) => sameEntry(
        path.join(this.workspace, change.path), change.status === 'D' ? null : path.join(row.path, change.path),
      ));
    } catch (_) {
      return false;
    }
  }

  resolveIntegrating(row) {
    const execution = row.executionId ? this.admission.get(row.executionId) : this.executionFor(row);
    const finished = execution?.state === 'released' || execution?.state === 'reconciled';
    const applied = finished && this.laneApplied(row);
    if (applied && exists(row.path)) {
      try { removeLane({ root: this.workspace, lane: row.path, lanesRoot: this.lanesRoot }); } catch (_) { /* retention */ }
    }
    this.store.update(row.laneId, {
      state: applied ? 'integrated' : 'not_integrated',
      reason: applied ? null : 'integration_interrupted',
      ...(execution ? { executionId: execution.executionId } : {}),
    });
    return applied;
  }

  /**
   * Startup recovery, after admission.reconcileStale (design "Lanes table"). Never runs a
   * repo-wide prune; only lanes inside the lanes root are removed.
   */
  recover({ retentionHours = DEFAULT_RETENTION_HOURS, now = Date.now() } = {}) {
    const summary = { orphaned: [], integrated: [], notIntegrated: [], removed: [], failed: [] };
    for (const row of this.store.list(this.workspace)) {
      try {
        if (LIVE_STATES.has(row.state)) {
          const identity = row.turnStart?.processIdentity;
          // The helper signals only a group proven to be the original, orphaned process.
          if (identity) this.quiescence.killOrphanProcessGroup(identity);
          this.store.update(row.laneId, { state: 'orphaned', reason: 'server_restart' });
          summary.orphaned.push(row.laneId);
        } else if (row.state === 'integrating') {
          (this.resolveIntegrating(row) ? summary.integrated : summary.notIntegrated).push(row.laneId);
        }
      } catch (_) {
        summary.failed.push(row.laneId);
      }
    }
    const cutoff = now - retentionHours * 3600 * 1000;
    const root = realish(this.lanesRoot);
    for (const row of this.store.list(this.workspace)) {
      const kept = KEPT_STATES.has(row.state) || (row.state === 'integrated' && exists(row.path));
      if (!kept || !(Date.parse(row.updatedAt) <= cutoff) || !isInside(root, realish(row.path))) continue;
      // An adopted path stays while a non-terminal or newer row still references it.
      if (this.store.list(this.workspace).some((other) => other.laneId !== row.laneId && other.path === row.path
        && (!TERMINAL_STATES.has(other.state) || other.createdAt > row.createdAt || other.continuedFrom === row.laneId))) continue;
      try {
        removeLane({ root: this.workspace, lane: row.path, lanesRoot: this.lanesRoot });
        if (row.state !== 'integrated') this.store.update(row.laneId, { state: 'removed' });
        summary.removed.push(row.laneId);
      } catch (_) {
        summary.failed.push(row.laneId);
      }
    }
    return summary;
  }
}

module.exports = {
  LaneManager,
  createLaneStore,
  workspaceMutex,
  resolveLanesRoot,
  laneLinks,
  laneRetentionHours,
  readNetworkAccess,
  selectWriterIsolation,
};
