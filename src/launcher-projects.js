'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { loadOrCreateAuthToken } = require('./local-auth');

const REGISTRY_VERSION = 1;
const PROBE_TIMEOUT_MS = 800;
const STATUS_LOG_CHUNKS = 200;
const STARTUP_DIAGNOSTIC_VERSION = 1;
const STARTUP_STDERR_LIMIT = 8000;
const STARTUP_MESSAGE_LIMIT = 2000;
const STARTUP_STDOUT_MARKER_BUFFER = 2000;
const STARTUP_STDERR_PERSIST_INTERVAL = 512;
const STARTUP_STDERR_PERSIST_MAX_WRITES = 24;
// STOP-01: after SIGTERM the project server parks its lead runs as resumable, then closes the app server
// and HTTP; that whole shutdown takes up to SHUTDOWN_TOTAL_MS (src/server.js, 2 x 5 s). SIGKILL is only
// the fallback once that total plus a margin has passed. A test ties these numbers to the server's.
const SERVER_SHUTDOWN_TOTAL_MS = 10000;
const KILL_GRACE_MS = SERVER_SHUTDOWN_TOTAL_MS + 2000;
const RUNNING_MARKERS = ['Codex Universal A2A listening at http://'];

class ProjectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
  }
}

function defaultIsPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function defaultListenersOnPort(port) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (error, stdout) => {
        if (error) return resolve([]);
        resolve(String(stdout).split(/\s+/).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0));
      });
    } catch {
      resolve([]);
    }
  });
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function projectId(realPath) {
  return crypto.createHash('sha1').update(realPath).digest('hex').slice(0, 10);
}

function sanitizeStartupText(value, limit) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:[A-Z0-9_]*[_-])?(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION))(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/((?:"|')?(?:[A-Z0-9_]*[_-])?(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[REDACTED]"')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(-limit);
}

function createProjectManager(options = {}) {
  const {
    repoDir = path.resolve(__dirname, '..'),
    runtimeDir = path.join(repoDir, '.runtime'),
    portRange = [3000, 3099],
    spawn = childProcess.spawn,
    fetch = globalThis.fetch,
    isPortFree = defaultIsPortFree,
    listenersOnPort = defaultListenersOnPort,
    isPidAlive = defaultIsPidAlive,
    ensureToken = () => loadOrCreateAuthToken(),
    kill = (pid, signal) => process.kill(pid, signal),
    killGraceMs = KILL_GRACE_MS,
    logLimit = 500
  } = options;

  const registryPath = path.join(runtimeDir, 'projects.json');
  let records = [];
  let loaded = false;
  let chain = Promise.resolve();
  let tmpCounter = 0;
  // id -> { child, status, logs, exited }
  const runtimes = new Map();

  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  function runtimeFor(id) {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = {
        child: null, status: 'stopped', logs: [], exited: null, starting: null, startupDiagnostic: null,
        startupStderr: '', startupError: null, startupStage: null, startupStdout: '',
        startupStderrPersistedLength: 0, startupStderrPersistWrites: 0
      };
      runtimes.set(id, rt);
    }
    return rt;
  }

  function findRecord(id) {
    const record = records.find((item) => item.id === id);
    if (!record) throw new ProjectError('not_found', `Unknown project: ${id}`);
    return record;
  }

  function view(record) {
    return { ...record, status: runtimeFor(record.id).status };
  }

  function appendLog(rt, chunk) {
    rt.logs.push(String(chunk));
    if (rt.logs.length > logLimit) rt.logs.splice(0, rt.logs.length - logLimit);
  }

  function ensureRuntimeDir() {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  }

  function persist() {
    ensureRuntimeDir();
    const tmp = path.join(runtimeDir, `projects.json.tmp-${process.pid}-${tmpCounter += 1}`);
    const body = `${JSON.stringify({ version: REGISTRY_VERSION, projects: records }, null, 2)}\n`;
    const descriptor = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(descriptor, body);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(tmp, registryPath);
  }

  function persistQuietly() {
    return serialize(() => persist()).catch(() => {});
  }

  function startupDiagnosticPath(id) {
    return path.join(runtimeDir, 'projects', id, 'last-startup.json');
  }

  function readStartupDiagnostic(id) {
    try {
      const parsed = JSON.parse(fs.readFileSync(startupDiagnosticPath(id), 'utf8'));
      if (!parsed || parsed.version !== STARTUP_DIAGNOSTIC_VERSION
        || !['starting', 'started', 'failed'].includes(parsed.outcome)
        || typeof parsed.stage !== 'string') return null;
      return {
        version: STARTUP_DIAGNOSTIC_VERSION,
        outcome: parsed.outcome,
        stage: sanitizeStartupText(parsed.stage, 80),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        code: typeof parsed.code === 'string' ? sanitizeStartupText(parsed.code, 80) : null,
        message: typeof parsed.message === 'string' ? sanitizeStartupText(parsed.message, STARTUP_MESSAGE_LIMIT) : null,
        stderr: typeof parsed.stderr === 'string' ? sanitizeStartupText(parsed.stderr, STARTUP_STDERR_LIMIT) : null
      };
    } catch {
      return null;
    }
  }

  function writeStartupDiagnostic(id, diagnostic) {
    const target = startupDiagnosticPath(id);
    const directory = path.dirname(target);
    const temporary = `${target}.tmp-${process.pid}-${tmpCounter += 1}`;
    let descriptor = null;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      descriptor = fs.openSync(temporary, 'w', 0o600);
      fs.writeSync(descriptor, `${JSON.stringify({
        version: STARTUP_DIAGNOSTIC_VERSION,
        outcome: diagnostic.outcome,
        stage: sanitizeStartupText(diagnostic.stage, 80),
        updatedAt: new Date().toISOString(),
        code: diagnostic.code ? sanitizeStartupText(diagnostic.code, 80) : null,
        message: diagnostic.message ? sanitizeStartupText(diagnostic.message, STARTUP_MESSAGE_LIMIT) : null,
        stderr: diagnostic.stderr ? sanitizeStartupText(diagnostic.stderr, STARTUP_STDERR_LIMIT) : null
      })}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      return null;
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      return error;
    }
  }

  function recordStartup(rt, record, diagnostic) {
    const normalized = {
      outcome: diagnostic.outcome,
      stage: sanitizeStartupText(diagnostic.stage, 80),
      code: diagnostic.code ? sanitizeStartupText(diagnostic.code, 80) : null,
      message: diagnostic.message ? sanitizeStartupText(diagnostic.message, STARTUP_MESSAGE_LIMIT) : null,
      stderr: diagnostic.stderr ? sanitizeStartupText(diagnostic.stderr, STARTUP_STDERR_LIMIT) : null
    };
    rt.startupDiagnostic = normalized;
    const error = writeStartupDiagnostic(record.id, normalized);
    if (error) appendLog(rt, `\n[LAUNCHER] Could not persist startup diagnostic (${error.code || 'write_error'}).\n`);
  }

  function loadRegistry() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(registryPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.projects)) throw new Error('bad registry shape');
      records = parsed.projects.map((item) => {
        if (!item || typeof item.id !== 'string' || typeof item.path !== 'string' || !Number.isInteger(item.port) || typeof item.stateDb !== 'string') {
          throw new Error('bad project record');
        }
        return {
          id: item.id,
          path: item.path,
          name: item.name || path.basename(item.path),
          port: item.port,
          stateDb: item.stateDb,
          addedAt: item.addedAt || null,
          lastUsedAt: item.lastUsedAt || null,
          pid: Number.isInteger(item.pid) ? item.pid : null
        };
      });
    } catch {
      records = [];
      fs.renameSync(registryPath, `${registryPath}.corrupt-${Date.now()}`);
    }
  }

  async function probe(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/orchestrator/agent-card.json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return Boolean(response && response.ok);
    } catch {
      return false;
    }
  }

  async function allocatePort(exceptId) {
    const taken = new Set(records.filter((item) => item.id !== exceptId).map((item) => item.port));
    for (let port = portRange[0]; port <= portRange[1]; port += 1) {
      if (taken.has(port)) continue;
      if (await isPortFree(port)) return port;
    }
    throw new ProjectError('no_port', `No free port in range ${portRange[0]}-${portRange[1]}`);
  }

  function waitForExit(rt, ms) {
    if (!rt.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      rt.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  function signalChild(child, signal) {
    try {
      child.kill(signal);
    } catch {
      // process already gone
    }
  }

  async function terminateChild(rt, waitMs) {
    const child = rt.child;
    if (!child) return;
    signalChild(child, 'SIGTERM');
    const exited = await waitForExit(rt, waitMs);
    if (!exited && rt.child === child) signalChild(child, 'SIGKILL');
  }

  async function init() {
    await serialize(async () => {
      loadRegistry();
      let changed = false;
      await Promise.all(records.map(async (record) => {
        if (record.pid === null) return;
        if (isPidAlive(record.pid) && await probe(record.port)) {
          runtimeFor(record.id).status = 'running';
        } else {
          record.pid = null;
          changed = true;
        }
      }));
      if (changed) persist();
    });
  }

  function list() {
    return records.map(view);
  }

  function get(id) {
    const record = records.find((item) => item.id === id);
    return record ? view(record) : null;
  }

  function baseUrl(id) {
    return `http://127.0.0.1:${findRecord(id).port}`;
  }

  function stateDbPath(id) {
    return path.resolve(findRecord(id).stateDb);
  }

  // Role overrides always live in the project's own runtime dir, also for the legacy project whose
  // state database sits in the runtime root.
  function roleOverridesPath(id) {
    findRecord(id);
    return path.join(runtimeDir, 'projects', id, 'role-overrides.json');
  }

  // Owner project settings (project-settings.json) live next to the role overrides.
  function projectSettingsPath(id) {
    findRecord(id);
    return path.join(runtimeDir, 'projects', id, 'project-settings.json');
  }

  async function touch(id) {
    return serialize(() => {
      const record = findRecord(id);
      record.lastUsedAt = new Date().toISOString();
      persist();
      return view(record);
    });
  }

  async function add(inputPath) {
    let realPath;
    try {
      realPath = await fs.promises.realpath(inputPath);
      if (!(await fs.promises.stat(realPath)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new ProjectError('not_a_directory', `Not an existing directory: ${inputPath}`);
    }
    return serialize(async () => {
      loadRegistry();
      const id = projectId(realPath);
      const existing = records.find((item) => item.id === id);
      if (existing) return view(existing);
      const legacyDb = path.join(runtimeDir, 'state.sqlite');
      const stateDb = records.length === 0 && fs.existsSync(legacyDb)
        ? legacyDb
        : path.join(runtimeDir, 'projects', id, 'state.sqlite');
      const port = await allocatePort(null);
      const now = new Date().toISOString();
      const record = { id, path: realPath, name: path.basename(realPath), port, stateDb, addedAt: now, lastUsedAt: null, pid: null };
      records.push(record);
      try {
        persist();
      } catch (error) {
        records.pop();
        throw error;
      }
      return view(record);
    });
  }

  async function remove(id) {
    return serialize(() => {
      const record = findRecord(id);
      if (runtimeFor(id).status !== 'stopped') throw new ProjectError('running', `Project is not stopped: ${id}`);
      const previous = records;
      records = records.filter((item) => item.id !== id);
      try {
        persist();
      } catch (error) {
        records = previous;
        throw error;
      }
      runtimes.delete(id);
      return view(record);
    });
  }

  async function start(id) {
    const record = findRecord(id);
    const rt = runtimeFor(id);
    if (rt.status === 'starting' || rt.status === 'running') return view(record);
    rt.status = 'starting';
    const pending = runStart(record, rt);
    rt.starting = pending;
    try {
      return await pending;
    } finally {
      if (rt.starting === pending) rt.starting = null;
    }
  }

  async function runStart(record, rt) {
    const id = record.id;
    let stage = 'token';
    rt.startupStderr = '';
    rt.startupError = null;
    rt.startupStage = stage;
    rt.startupStdout = '';
    rt.startupStderrPersistedLength = 0;
    rt.startupStderrPersistWrites = 0;
    rt.logs = [];
    recordStartup(rt, record, { outcome: 'starting', stage });
    try {
      await ensureToken();
      stage = 'port';
      rt.startupStage = stage;
      recordStartup(rt, record, { outcome: 'starting', stage });
      await serialize(async () => {
        if (!(await isPortFree(record.port))) {
          record.port = await allocatePort(id);
          persist();
        }
      });
      stage = 'prepare';
      rt.startupStage = stage;
      recordStartup(rt, record, { outcome: 'starting', stage });
      fs.mkdirSync(path.dirname(record.stateDb), { recursive: true, mode: 0o700 });
      const roleOverrides = path.resolve(roleOverridesPath(id));
      fs.mkdirSync(path.dirname(roleOverrides), { recursive: true, mode: 0o700 });
      stage = 'spawn';
      rt.startupStage = stage;
      recordStartup(rt, record, { outcome: 'starting', stage });
      const child = spawn(process.execPath, ['server-bootstrap.js'], {
        cwd: repoDir,
        env: {
          ...process.env,
          PORT: String(record.port),
          CODEX_WORKSPACE: record.path,
          CODEX_A2A_STATE_DB: record.stateDb,
          CODEX_A2A_ROLE_OVERRIDES: roleOverrides,
          CODEX_A2A_PROJECT_SETTINGS: path.resolve(projectSettingsPath(id))
        }
      });
      rt.child = child;
      stage = 'server_startup';
      rt.startupStage = stage;
      recordStartup(rt, record, { outcome: 'starting', stage });
      rt.exited = new Promise((resolve) => {
        const onGone = (code) => {
          resolve();
          if (rt.child !== child) return;
          const failedDuringStartup = rt.status === 'starting';
          if (failedDuringStartup) {
            recordStartup(rt, record, {
              outcome: 'failed',
              stage: rt.startupStage || 'server_startup',
              code: code === null || code === undefined ? null : String(code),
              message: rt.startupError || (code === null ? 'Server process ended before the listener became ready.' : `Server process exited before readiness with code ${code}.`),
              stderr: rt.startupStderr
            });
          }
          rt.child = null;
          rt.exited = null;
          rt.status = 'stopped';
          record.pid = null;
          appendLog(rt, `\n[LAUNCHER] Server process exited (code: ${code})\n`);
          persistQuietly();
        };
        child.on('close', onGone);
        child.on('error', (error) => {
          if (rt.child === child) {
            rt.startupError = sanitizeStartupText(error && error.message, STARTUP_MESSAGE_LIMIT);
            appendLog(rt, `\n[LAUNCHER] Server process error: ${rt.startupError}\n`);
          }
          onGone(null);
        });
      });
      appendLog(rt, `[LAUNCHER] Starting orchestrator for workspace: ${record.path} on port ${record.port}\n`);
      const onStdout = (chunk) => {
        if (rt.child !== child) return;
        const text = String(chunk);
        appendLog(rt, text);
        if (rt.status === 'starting') {
          rt.startupStdout = sanitizeStartupText(`${rt.startupStdout}${text}`, STARTUP_STDOUT_MARKER_BUFFER);
        }
        if (rt.status === 'starting' && RUNNING_MARKERS.some((marker) => rt.startupStdout.includes(marker))) {
          rt.status = 'running';
          recordStartup(rt, record, { outcome: 'started', stage: 'listening' });
        }
      };
      const onStderr = (chunk) => {
        if (rt.child !== child) return;
        const text = String(chunk);
        appendLog(rt, text);
        if (rt.status === 'starting') {
          rt.startupStderr = sanitizeStartupText(`${rt.startupStderr}${text}`, STARTUP_STDERR_LIMIT);
          if (rt.startupStderrPersistWrites < STARTUP_STDERR_PERSIST_MAX_WRITES
            && (rt.startupStderrPersistWrites === 0
              || rt.startupStderr.length - rt.startupStderrPersistedLength >= STARTUP_STDERR_PERSIST_INTERVAL
              || rt.startupStderr.length === STARTUP_STDERR_LIMIT)) {
            recordStartup(rt, record, { outcome: 'starting', stage: 'server_startup', stderr: rt.startupStderr });
            rt.startupStderrPersistedLength = rt.startupStderr.length;
            rt.startupStderrPersistWrites += 1;
          }
        }
      };
      if (child.stdout) child.stdout.on('data', onStdout);
      if (child.stderr) child.stderr.on('data', onStderr);
      if (rt.child === child) {
        record.pid = Number.isInteger(child.pid) ? child.pid : null;
        await persistQuietly();
      }
    } catch (error) {
      if (!rt.child) {
        rt.status = 'stopped';
        recordStartup(rt, record, {
          outcome: 'failed',
          stage,
          code: error && error.code,
          message: error && error.message ? error.message : String(error)
        });
      }
      throw error;
    }
    return view(record);
  }

  async function stop(id) {
    const record = findRecord(id);
    const rt = runtimeFor(id);
    if (rt.starting) await rt.starting.catch(() => {});
    if (rt.status === 'stopped') return view(record);
    if (rt.child) {
      await terminateChild(rt, killGraceMs);
      return view(record);
    }
    if (record.pid !== null) {
      const pid = record.pid;
      const listeners = await listenersOnPort(record.port);
      if (!listeners.includes(pid)) throw new ProjectError('not_managed', `Project ${id} pid ${pid} is not listening on port ${record.port}`);
      kill(pid, 'SIGTERM');
      record.pid = null;
      rt.status = 'stopped';
      await persistQuietly();
      return view(record);
    }
    throw new ProjectError('not_managed', `Project ${id} was not started by this launcher`);
  }

  async function refresh() {
    await Promise.all(records.map(async (record) => {
      const rt = runtimeFor(record.id);
      const ok = await probe(record.port);
      if (ok) {
        rt.status = 'running';
      } else if (!rt.child && rt.status !== 'starting') {
        rt.status = 'stopped';
        if (record.pid !== null) {
          record.pid = null;
          await persistQuietly();
        }
      }
    }));
    return list();
  }

  function status(id) {
    const record = findRecord(id);
    const runtime = runtimeFor(id);
    let startupDiagnostic = runtime.startupDiagnostic || readStartupDiagnostic(id);
    if (startupDiagnostic?.outcome === 'starting' && !runtime.child && runtime.status !== 'starting') {
      startupDiagnostic = {
        ...startupDiagnostic,
        outcome: 'failed',
        message: 'Launcher restarted before startup readiness was recorded.'
      };
    }
    const logs = runtime.logs.slice(-STATUS_LOG_CHUNKS);
    if (logs.length === 0 && startupDiagnostic?.outcome === 'failed') {
      logs.push(`[LAUNCHER] Last startup failed during ${startupDiagnostic.stage}${startupDiagnostic.code ? ` (${startupDiagnostic.code})` : ''}.\n`);
      if (startupDiagnostic.message) logs.push(`${startupDiagnostic.message}\n`);
      if (startupDiagnostic.stderr) logs.push(startupDiagnostic.stderr);
    }
    return { ...view(record), logs, startupDiagnostic };
  }

  async function stopAll() {
    const active = [...runtimes.values()].filter((rt) => rt.child);
    await Promise.all(active.map((rt) => terminateChild(rt, killGraceMs + 500)));
  }

  return { init, list, get, baseUrl, stateDbPath, roleOverridesPath, projectSettingsPath, touch, add, remove, start, stop, refresh, status, stopAll };
}

module.exports = { createProjectManager, ProjectError, KILL_GRACE_MS };
