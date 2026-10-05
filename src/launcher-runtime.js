'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readAuthToken } = require('./local-auth');

const execFileAsync = promisify(execFile);
const DEFAULT_LAUNCHER_PORT = 3100;
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 25_000;
const OUTPUT_LIMIT = 64 * 1024;

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeName(target) {
  return path.basename(target) || target;
}

function validatePort(value, fallback = 3000) {
  const port = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Dashboard port must be a number from 1 to 65535.');
  return port;
}

class LauncherRuntime {
  constructor({
    appRoot = path.resolve(__dirname, '..'),
    runtimeRoot = path.join(path.resolve(__dirname, '..'), '.runtime', 'launcher'),
    spawnImpl = spawn,
    execFileImpl = execFileAsync,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    startTimeoutMs = START_TIMEOUT_MS,
    stopTimeoutMs = STOP_TIMEOUT_MS,
  } = {}) {
    this.appRoot = fs.realpathSync(appRoot);
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.projectsRoot = path.join(this.runtimeRoot, 'projects');
    this.projectsFile = path.join(this.runtimeRoot, 'projects.json');
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.startTimeoutMs = startTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.status = 'stopped';
    this.projectPath = null;
    this.port = null;
    this.error = null;
    this.child = null;
    this.pairingUrl = null;
    this.operation = null;
    this.stdout = '';
    this.stderr = '';
    this.baseRef = null;
    this._closing = false;
  }

  _pathsFor(projectPath) {
    const id = crypto.createHash('sha256').update(projectPath).digest('hex');
    const root = path.join(this.projectsRoot, id);
    return {
      root,
      state: path.join(root, 'state.sqlite'),
      token: path.join(root, 'a2a-token'),
      config: path.join(root, 'project.json'),
      artifacts: path.join(root, 'artifacts'),
    };
  }

  async _git(projectPath, args) {
    const result = await this.execFileImpl('git', ['-C', projectPath, ...args], { timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024 });
    return String(result.stdout || '').trim();
  }

  async _selectBaseRef(projectPath) {
    const exists = async (branch) => {
      if (!branch || branch.startsWith('-') || branch.includes('..') || branch.includes(' ')) return false;
      try { await this._git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch (_) { return false; }
    };
    try {
      const remoteHead = await this._git(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      const candidate = remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : '';
      if (await exists(candidate)) return candidate;
    } catch (_) { /* use a local fallback */ }
    for (const candidate of ['main', 'master']) if (await exists(candidate)) return candidate;
    try {
      const current = await this._git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (await exists(current)) return current;
    } catch (_) { /* detached HEAD */ }
    throw new Error('This Git checkout has no local branch to use as a base. Create or check out a branch, then try again.');
  }

  _ensurePrivateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Launcher state path must be a real directory: ${directory}`);
    try { fs.chmodSync(directory, 0o700); } catch (_) { /* Windows ACLs control access there. */ }
  }

  _rememberProject(projectPath) {
    this._ensurePrivateDirectory(this.runtimeRoot);
    let recent = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.projectsFile, 'utf8'));
      if (Array.isArray(parsed)) recent = parsed.filter((entry) => typeof entry === 'string');
    } catch (error) { if (error.code !== 'ENOENT') recent = []; }
    const updated = [projectPath, ...recent.filter((entry) => entry !== projectPath)].slice(0, 12);
    const temp = `${this.projectsFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.projectsFile);
  }

  recentProjects() {
    try {
      const entries = JSON.parse(fs.readFileSync(this.projectsFile, 'utf8'));
      if (!Array.isArray(entries)) return [];
      return entries.filter((entry) => typeof entry === 'string').slice(0, 12).map((projectPath) => ({ path: projectPath, name: safeName(projectPath) }));
    } catch (_) { return []; }
  }

  snapshot() {
    const dashboardUrl = this.projectPath && this.port ? `http://127.0.0.1:${this.port}/dashboard/` : null;
    return {
      status: this.status,
      projectPath: this.projectPath,
      port: this.port,
      dashboardUrl,
      error: this.error,
      recentProjects: this.recentProjects(),
      canStop: Boolean(this.child),
      ...(this.baseRef ? { baseRef: this.baseRef } : {}),
    };
  }

  async start({ projectPath, port } = {}) {
    if (this._closing) throw new Error('Launcher is shutting down.');
    if (this.status === 'starting' || this.status === 'stopping') throw new Error('A launcher operation is already in progress.');
    if (this.child) throw new Error('Stop the owned project server before starting another one.');
    if (this.status === 'running') throw new Error('Stop the running project before starting another one.');
    if (this.operation) throw new Error('A launcher operation is already in progress.');
    this.operation = this._start({ projectPath, port });
    try { return await this.operation; } finally { this.operation = null; }
  }

  async _start({ projectPath, port }) {
    this.status = 'starting';
    this.error = null;
    this.pairingUrl = null;
    this.stdout = '';
    this.stderr = '';
    try {
      if (typeof projectPath !== 'string' || !projectPath.trim()) throw new TypeError('Choose a project folder.');
      if (!path.isAbsolute(projectPath.trim())) throw new TypeError('Choose a project folder using its full path.');
      let canonical;
      try { canonical = fs.realpathSync(projectPath.trim()); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('That project folder does not exist. Choose an existing folder.');
        throw error;
      }
      if (!fs.statSync(canonical).isDirectory()) throw new Error('Choose an existing project folder.');
      const appReal = this.appRoot;
      if (within(appReal, canonical) || within(canonical, appReal)) throw new Error('Choose a project folder outside the launcher application folder.');
      let gitRoot;
      try { gitRoot = await this._git(canonical, ['rev-parse', '--show-toplevel']); }
      catch (error) {
        if (/not a git repository/i.test(String(error?.stderr || error?.message || ''))) throw new Error('The selected folder is not the root of a Git project.');
        throw error;
      }
      const canonicalGitRoot = fs.realpathSync(gitRoot);
      if (canonicalGitRoot !== canonical) throw new Error('Choose the root folder of a Git project.');
      const targetPort = validatePort(port, 3000);
      const paths = this._pathsFor(canonical);
      this._ensurePrivateDirectory(paths.root);
      this._ensurePrivateDirectory(paths.artifacts);
      let baseRef;
      try {
        const policy = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
        if (!policy || typeof policy.baseRef !== 'string' || !policy.baseRef.trim()) throw new Error('The saved project policy needs a valid baseRef.');
        baseRef = policy.baseRef;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Could not read the saved project policy: ${error.message}`);
        baseRef = await this._selectBaseRef(canonical);
        try {
          const descriptor = fs.openSync(paths.config, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
          try { fs.writeFileSync(descriptor, `${JSON.stringify({ baseRef }, null, 2)}\n`, 'utf8'); fs.fsyncSync(descriptor); }
          finally { fs.closeSync(descriptor); }
        } catch (createError) {
          if (createError.code !== 'EEXIST') throw createError;
          const policy = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
          if (!policy || typeof policy.baseRef !== 'string' || !policy.baseRef.trim()) throw new Error('The saved project policy needs a valid baseRef.');
          baseRef = policy.baseRef;
        }
      }
      this._rememberProject(canonical);
      this.projectPath = canonical;
      this.port = targetPort;
      this.baseRef = baseRef;
      const env = {
        ...process.env,
        CODEX_WORKSPACE: canonical,
        CODEX_A2A_STATE_DB: paths.state,
        CODEX_A2A_TOKEN_FILE: paths.token,
        CODEX_PROJECT_CONFIG: paths.config,
        CODEX_A2A_ARTIFACT_DIR: paths.artifacts,
        PORT: String(targetPort),
      };
      delete env.CODEX_A2A_WORKSPACE_LOCK_DIR;
      const child = this.spawnImpl(process.execPath, [path.join(this.appRoot, 'src', 'launcher-runtime.js'), '--dashboard-child'], {
        cwd: this.appRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      });
      this.child = child;
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        this.pairingUrl = null;
        if (this.status === 'running') {
          this.status = 'error';
          this.error = `Project server stopped unexpectedly (${signal || code || 'unknown'}).`;
        }
      });
      const ready = await this._waitUntilReady(child, paths.token, targetPort);
      this.pairingUrl = ready;
      if (child.exitCode !== null || child.killed) throw new Error('The project server stopped during startup.');
      this.status = 'running';
      return { ...this.snapshot(), pairingUrl: ready };
    } catch (error) {
      const message = this._safeError(error);
      this.error = message;
      if (this.child) {
        try {
          await this._terminateOwnedChild(this.child, this.stopTimeoutMs);
          this.child = null;
        } catch (_) {
          this.error = `${message} Cleanup is still waiting for the project server to exit.`.slice(0, 500);
        }
      }
      this.pairingUrl = null;
      this.status = 'error';
      throw new Error(this.error || message);
    }
  }

  _safeError(error) {
    const text = String(error?.message || error || 'Launcher failed.');
    if (/requires an authenticated ChatGPT account|not logged in|login required/i.test(text)) return 'Sign in to Codex with ChatGPT, then start the project again.';
    if (/spawn codex ENOENT|codex.*not found|codex.*ENOENT/i.test(text)) return 'The Codex CLI is not installed or is not available on PATH.';
    if (/EADDRINUSE/.test(text) && this.port) return `Dashboard port ${this.port} is already in use. Stop its owner or choose another port, such as 3001.`;
    return text.replace(/(pair=)[A-Za-z0-9_-]+/gi, '$1[redacted]').replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer [redacted]').slice(0, 500);
  }

  _appendOutput(kind, chunk) {
    const current = kind === 'stdout' ? this.stdout : this.stderr;
    const updated = `${current}${chunk.toString('utf8')}`;
    const bounded = updated.length > OUTPUT_LIMIT ? updated.slice(-OUTPUT_LIMIT) : updated;
    if (kind === 'stdout') this.stdout = bounded; else this.stderr = bounded;
  }

  async _freshPairingUrl(tokenFile, port) {
    const token = readAuthToken({ filePath: tokenFile });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/api/dashboard/v1/pairing-codes`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Pairing request failed with HTTP ${response.status}.`);
      const body = await response.json();
      if (typeof body?.url !== 'string' || !new RegExp(`^http://127\\.0\\.0\\.1:${port}/dashboard/#pair=[A-Za-z0-9_-]{40,60}$`).test(body.url)) throw new Error('Project server returned an invalid pairing URL.');
      return body.url;
    } finally { clearTimeout(timer); }
  }

  _waitUntilReady(child, tokenFile, port) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let polling = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        error ? reject(error) : resolve(value);
      };
      const onError = () => finish(new Error('Could not start the project server process.'));
      const onExit = (code, signal) => {
        const occupied = /EADDRINUSE/.test(`${this.stdout}\n${this.stderr}`);
        const loginNeeded = /requires an authenticated ChatGPT account|not logged in|login required/i.test(this.stderr);
        const codexMissing = /spawn codex ENOENT|codex.*not found|codex.*ENOENT/i.test(this.stderr);
        finish(new Error(occupied
          ? `Dashboard port ${port} is already in use. Stop its owner or choose another port, such as 3001.`
          : (loginNeeded ? 'Sign in to Codex with ChatGPT, then start the project again.'
            : (codexMissing ? 'The Codex CLI is not installed or is not available on PATH.'
              : `Project server exited during startup (${signal || code || 'unknown'}).`))));
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout?.on('data', (chunk) => this._appendOutput('stdout', chunk));
      child.stderr?.on('data', (chunk) => this._appendOutput('stderr', chunk));
      const timeout = setTimeout(() => finish(new Error(`Project server did not become ready within ${Math.ceil(this.startTimeoutMs / 1000)} seconds.`)), this.startTimeoutMs);
      timeout.unref?.();
      const poll = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try {
          const text = `${this.stdout}\n${this.stderr}`;
          if (/Codex Universal A2A listening at http:\/\/127\.0\.0\.1:/i.test(text)) {
            const url = await this._freshPairingUrl(tokenFile, port);
            finish(null, url);
          }
        } catch (_) { /* The child may still be initializing its local token or HTTP route. */ }
        finally { polling = false; }
      }, 50);
      poll.unref?.();
    });
  }

  async _terminateOwnedChild(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Project server did not stop after SIGTERM.')); }, timeoutMs);
      timer.unref?.();
      const onExit = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); child.removeListener('exit', onExit); };
      child.once('exit', onExit);
      try { child.kill('SIGTERM'); } catch (error) { cleanup(); reject(error); }
    });
  }

  async stop() {
    if (this.status === 'starting' || this.status === 'stopping' || this.operation) throw new Error('A launcher operation is already in progress.');
    if (!this.child) return this.snapshot();
    this.operation = this._stop();
    try { return await this.operation; } finally { this.operation = null; }
  }

  async _stop() {
    this.status = 'stopping';
    const child = this.child;
    try {
      await this._terminateOwnedChild(child, this.stopTimeoutMs);
      this.child = null;
      this.pairingUrl = null;
      this.status = 'stopped';
      this.error = null;
      return this.snapshot();
    } catch (error) {
      this.status = 'error';
      this.error = this._safeError(error);
      throw new Error(this.error);
    }
  }

  async openPairing() {
    if (this.status !== 'running' || !this.projectPath || !this.port) throw new Error('Start a project before requesting a pairing link.');
    const paths = this._pathsFor(this.projectPath);
    return { pairingUrl: await this._freshPairingUrl(paths.token, this.port) };
  }

  async close() {
    this._closing = true;
    if (this.operation) {
      try { await this.operation; } catch (_) { /* cleanup below */ }
    }
    if (this.child) {
      this.status = 'stopping';
      await this._terminateOwnedChild(this.child, this.stopTimeoutMs);
      this.child = null;
      this.status = 'stopped';
    }
  }
}

async function runDashboardChild({
  startServerImpl = () => require('./server').startServer(),
  processObject = process,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let stopRequested = false;
  let resolveStop;
  const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
  const requestStop = () => { stopRequested = true; resolveStop(); };
  processObject.once('SIGTERM', requestStop);
  processObject.once('SIGINT', requestStop);
  try {
    const server = await startServerImpl();
    if (!stopRequested) {
      stdout.write(`Codex Universal A2A listening at http://${server.host}:${server.port}\n`);
      const { code } = server.dashboardAuth.issuePairingCode();
      stdout.write(`Dashboard pairing URL: ${server.dashboardAuth.pairingUrl(code)}\n`);
    }
    await stopSignal;
    await server.close();
    return 0;
  } catch (error) {
    stderr.write(`${String(error?.message || error).replace(/(pair=)[A-Za-z0-9_-]+/gi, '$1[redacted]')}\n`);
    return 1;
  } finally {
    processObject.removeListener?.('SIGTERM', requestStop);
    processObject.removeListener?.('SIGINT', requestStop);
  }
}

if (require.main === module && process.argv[2] === '--dashboard-child') {
  runDashboardChild().then((code) => { process.exitCode = code; });
}

module.exports = { LauncherRuntime, DEFAULT_LAUNCHER_PORT, validatePort, runDashboardChild };
