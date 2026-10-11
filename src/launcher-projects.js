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
const RUNNING_MARKERS = ['listening at', 'Codex Universal A2A'];

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
    killGraceMs = 2000,
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
      rt = { child: null, status: 'stopped', logs: [], exited: null, starting: null };
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
    try {
      await ensureToken();
      await serialize(async () => {
        if (!(await isPortFree(record.port))) {
          record.port = await allocatePort(id);
          persist();
        }
      });
      fs.mkdirSync(path.dirname(record.stateDb), { recursive: true, mode: 0o700 });
      const roleOverrides = path.resolve(roleOverridesPath(id));
      fs.mkdirSync(path.dirname(roleOverrides), { recursive: true, mode: 0o700 });
      const child = spawn(process.execPath, ['src/server.js'], {
        cwd: repoDir,
        env: {
          ...process.env,
          PORT: String(record.port),
          CODEX_WORKSPACE: record.path,
          CODEX_A2A_STATE_DB: record.stateDb,
          CODEX_A2A_ROLE_OVERRIDES: roleOverrides
        }
      });
      rt.child = child;
      rt.logs = [];
      rt.exited = new Promise((resolve) => {
        const onGone = (code) => {
          resolve();
          if (rt.child !== child) return;
          rt.child = null;
          rt.exited = null;
          rt.status = 'stopped';
          record.pid = null;
          appendLog(rt, `\n[LAUNCHER] Server process exited (code: ${code})\n`);
          persistQuietly();
        };
        child.on('close', onGone);
        child.on('error', (error) => {
          if (rt.child === child) appendLog(rt, `\n[LAUNCHER] Server process error: ${error && error.message}\n`);
          onGone(null);
        });
      });
      appendLog(rt, `[LAUNCHER] Starting orchestrator for workspace: ${record.path} on port ${record.port}\n`);
      const onData = (chunk) => {
        if (rt.child !== child) return;
        const text = String(chunk);
        appendLog(rt, text);
        if (RUNNING_MARKERS.some((marker) => text.includes(marker))) rt.status = 'running';
      };
      if (child.stdout) child.stdout.on('data', onData);
      if (child.stderr) child.stderr.on('data', onData);
      if (rt.child === child) {
        record.pid = Number.isInteger(child.pid) ? child.pid : null;
        await persistQuietly();
      }
    } catch (error) {
      if (!rt.child) rt.status = 'stopped';
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
    return { ...view(record), logs: runtimeFor(id).logs.slice(-STATUS_LOG_CHUNKS) };
  }

  async function stopAll() {
    const active = [...runtimes.values()].filter((rt) => rt.child);
    await Promise.all(active.map((rt) => terminateChild(rt, killGraceMs + 500)));
  }

  return { init, list, get, baseUrl, stateDbPath, roleOverridesPath, touch, add, remove, start, stop, refresh, status, stopAll };
}

module.exports = { createProjectManager, ProjectError };
