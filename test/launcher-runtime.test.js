'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LauncherRuntime, atlassianConfigPath, discoverAtlassianConfigPath, runDashboardChild } = require('../src/launcher-runtime');

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-launcher-')); }
function fakeChild({ ready = true, autoExit = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.signals.push(signal);
    if (autoExit) {
      setImmediate(() => {
        child.exitCode = 0;
        child.signalCode = signal;
        child.emit('exit', 0, signal);
      });
    }
    return true;
  };
  if (ready) setImmediate(() => child.stdout.write('Codex Universal A2A listening at http://127.0.0.1:3000\n'));
  return child;
}
function fakeGit(project) {
  return async (_command, args) => {
    const gitArgs = args.slice(2);
    if (gitArgs[0] === 'rev-parse') return { stdout: `${project}\n` };
    if (gitArgs[0] === 'symbolic-ref' && gitArgs[3] === 'refs/remotes/origin/HEAD') return { stdout: 'origin/main\n' };
    if (gitArgs[0] === 'show-ref') return { stdout: '' };
    throw new Error('unexpected git command');
  };
}
function makeRuntime(project, options = {}) {
  const children = [];
  const runtime = new LauncherRuntime({
    appRoot: path.resolve(__dirname, '..'),
    runtimeRoot: path.join(options.root || temporary(), 'runtime'),
    execFileImpl: fakeGit(project),
    spawnImpl: (_exe, _argv, spawnOptions) => {
      const child = fakeChild({ ready: options.ready !== false });
      children.push({ child, spawnOptions });
      fs.mkdirSync(path.dirname(spawnOptions.env.CODEX_A2A_TOKEN_FILE), { recursive: true });
      fs.writeFileSync(spawnOptions.env.CODEX_A2A_TOKEN_FILE, 'a'.repeat(43), { mode: 0o600 });
      return child;
    },
    fetchImpl: async (url) => { const port = new URL(url).port; return { ok: true, json: async () => ({ url: `http://127.0.0.1:${port}/dashboard/#pair=${'b'.repeat(43)}` }) }; },
    startTimeoutMs: options.startTimeoutMs ?? 100,
    stopTimeoutMs: 100,
  });
  return { runtime, children };
}

test('launch uses isolated paths, creates policy once, and stops only its owned child', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { runtime, children } = makeRuntime(project, { root });
  const started = await runtime.start({ projectPath: project });
  const paths = children[0].spawnOptions.env;
  assert.equal(started.status, 'running');
  assert.equal(started.port, 3000);
  assert.equal(started.canStop, true);
  assert.equal(started.baseRef, 'main');
  assert.equal(children.length, 1);
  assert.equal(children[0].spawnOptions.cwd, path.resolve(__dirname, '..'));
  assert.equal(children[0].spawnOptions.detached, true);
  assert.equal(paths.CODEX_WORKSPACE, project);
  if (Object.prototype.hasOwnProperty.call(process.env, 'CODEX_ATLASSIAN_CONFIG')) {
    assert.equal(paths.CODEX_ATLASSIAN_CONFIG, process.env.CODEX_ATLASSIAN_CONFIG);
  } else {
    const discovered = discoverAtlassianConfigPath(process.env);
    if (discovered) assert.equal(paths.CODEX_ATLASSIAN_CONFIG, discovered);
    else assert.equal(Object.hasOwn(paths, 'CODEX_ATLASSIAN_CONFIG'), false);
  }
  assert.equal(Object.hasOwn(paths, 'CODEX_A2A_WORKSPACE_LOCK_DIR'), false);
  assert.match(paths.CODEX_A2A_STATE_DB, /runtime\/projects\/[a-f0-9]{64}\/state\.sqlite$/);
  assert.equal(JSON.parse(fs.readFileSync(paths.CODEX_PROJECT_CONFIG, 'utf8')).baseRef, 'main');
  const stopped = await runtime.stop();
  assert.equal(stopped.status, 'stopped');
  assert.equal(children[0].child.signalCode, 'SIGTERM');
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('Atlassian config discovery honors explicit overrides and XDG or home defaults', () => {
  const home = path.join(path.sep, 'home', 'operator');
  const xdg = path.join(path.sep, 'custom', 'config');
  assert.equal(atlassianConfigPath({}, home), path.join(home, '.config', 'orchestrator-atlassian', 'config.json'));
  assert.equal(atlassianConfigPath({ XDG_CONFIG_HOME: xdg }, home), path.join(xdg, 'orchestrator-atlassian', 'config.json'));
  assert.equal(atlassianConfigPath({ CODEX_ATLASSIAN_CONFIG: '/explicit/config.json', XDG_CONFIG_HOME: xdg }, home), '/explicit/config.json');
  assert.equal(atlassianConfigPath({ CODEX_ATLASSIAN_CONFIG: '' }, home), '');
});

test('launcher only discovers an existing regular Atlassian config file', () => {
  const home = temporary();
  const env = {};
  const config = path.join(home, '.config', 'orchestrator-atlassian', 'config.json');
  assert.equal(discoverAtlassianConfigPath(env, home), null);
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '{}\n');
  assert.equal(discoverAtlassianConfigPath(env, home), config);
  fs.rmSync(config);
  fs.rmdirSync(path.dirname(config));
  fs.rmdirSync(path.dirname(path.dirname(config)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('existing operator policy is preserved and its baseRef is reported', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const runtimeRoot = path.join(root, 'runtime');
  const key = crypto.createHash('sha256').update(project).digest('hex');
  const privateProject = path.join(runtimeRoot, 'projects', key);
  fs.mkdirSync(privateProject, { recursive: true });
  const config = path.join(privateProject, 'project.json');
  fs.writeFileSync(config, '{"baseRef":"release/2026","checks":[]}\n');
  const { runtime } = makeRuntime(project, { root });
  const started = await runtime.start({ projectPath: project, port: 3001 });
  assert.equal(started.baseRef, 'release/2026');
  assert.equal(fs.readFileSync(config, 'utf8'), '{"baseRef":"release/2026","checks":[]}\n');
  await runtime.stop();
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('rejects unsafe workspace and unknown dashboard port without starting a process', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { runtime, children } = makeRuntime(project, { root });
  await assert.rejects(runtime.start({ projectPath: 'relative/project' }), /full path/);
  await assert.rejects(runtime.start({ projectPath: project, port: 70000 }), /1 to 65535/);
  await assert.rejects(runtime.start({ projectPath: path.resolve(__dirname, '..') }), /outside/);
  assert.equal(children.length, 0);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('refuses concurrent starts while the first start is unresolved', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  let release;
  const { runtime, children } = makeRuntime(project, { root, ready: false, startTimeoutMs: 500 });
  runtime.spawnImpl = (_exe, _args, opts) => {
    const child = fakeChild({ ready: false });
    children.push({ child, spawnOptions: opts });
    fs.mkdirSync(path.dirname(opts.env.CODEX_A2A_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(opts.env.CODEX_A2A_TOKEN_FILE, 'a'.repeat(43), { mode: 0o600 });
    release = () => child.stdout.write('Codex Universal A2A listening at http://127.0.0.1:3000\n');
    return child;
  };
  const pending = runtime.start({ projectPath: project });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(runtime.start({ projectPath: project }), /already in progress/);
  release();
  await pending;
  await runtime.stop();
  await fs.promises.rm(root, { recursive: true, force: true });
});


test('failed startup retains an unconfirmed child, blocks replacement, and allows a later stop retry', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { runtime, children } = makeRuntime(project, { root, ready: false, startTimeoutMs: 40 });
  runtime.stopTimeoutMs = 70;
  runtime.spawnImpl = (_exe, _args, spawnOptions) => {
    const child = fakeChild({ ready: false, autoExit: false });
    children.push({ child, spawnOptions });
    fs.mkdirSync(path.dirname(spawnOptions.env.CODEX_A2A_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(spawnOptions.env.CODEX_A2A_TOKEN_FILE, 'a'.repeat(43), { mode: 0o600 });
    return child;
  };
  await assert.rejects(runtime.start({ projectPath: project }), /Cleanup is still waiting/);
  assert.equal(runtime.snapshot().status, 'error');
  assert.equal(runtime.snapshot().canStop, true);
  await assert.rejects(runtime.start({ projectPath: project }), /owned project server/);
  children[0].child.kill = (signal) => {
    children[0].child.killed = true;
    children[0].child.signals.push(signal);
    setTimeout(() => {
      children[0].child.exitCode = 0;
      children[0].child.signalCode = signal;
      children[0].child.emit('exit', 0, signal);
    }, 35);
    return true;
  };
  const stop = runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.snapshot().status, 'stopping');
  assert.equal(runtime.snapshot().canStop, true);
  assert.equal(children[0].child.signalCode, null);
  const stopped = await stop;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.canStop, false);
  assert.deepEqual(children[0].child.signals, ['SIGTERM', 'SIGTERM']);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('unexpected child exit clears ownership and never remains reported as running', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { runtime, children } = makeRuntime(project, { root });
  await runtime.start({ projectPath: project });
  children[0].child.exitCode = 1;
  children[0].child.emit('exit', 1, null);
  assert.equal(runtime.snapshot().status, 'error');
  assert.equal(runtime.snapshot().canStop, false);
  assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /pair=/);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('startup wrapper records an early SIGTERM and closes a newly ready server once', async () => {
  const processObject = new (require('node:events').EventEmitter)();
  let finishStartup;
  let closeCalls = 0;
  const out = [];
  const result = runDashboardChild({
    processObject,
    startServerImpl: () => new Promise((resolve) => { finishStartup = resolve; }),
    stdout: { write: (text) => out.push(text) },
    stderr: { write() {} },
  });
  while (!finishStartup) await new Promise((resolve) => setImmediate(resolve));
  processObject.emit('SIGTERM');
  finishStartup({ host: '127.0.0.1', port: 3000, dashboardAuth: { issuePairingCode() { throw new Error('must not issue after stop'); } }, async close() { closeCalls += 1; } });
  assert.equal(await result, 0);
  assert.equal(closeCalls, 1);
  assert.deepEqual(out, []);
  assert.equal(processObject.listenerCount('SIGTERM'), 0);
});

test('rejects an off-port pairing URL without placing any pairing secret in status', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { runtime, children } = makeRuntime(project, { root, startTimeoutMs: 100 });
  runtime.fetchImpl = async () => ({ ok: true, json: async () => ({ url: `http://127.0.0.1:3000/dashboard/#pair=${'s'.repeat(43)}` }) });
  await assert.rejects(runtime.start({ projectPath: project, port: 3001 }), /did not become ready/);
  assert.equal(runtime.snapshot().status, 'error');
  assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /pair=|s{43}/);
  assert.equal(children[0].child.signalCode, 'SIGTERM');
  await fs.promises.rm(root, { recursive: true, force: true });
});

test('auto-discovered Atlassian config is skipped for a port its redirect does not name', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const xdg = path.join(root, 'xdg');
  const config = path.join(xdg, 'orchestrator-atlassian', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, `${JSON.stringify({ redirectUri: 'http://127.0.0.1:3000/api/dashboard/v1/integrations/atlassian/callback' })}\n`);
  const saved = { xdg: process.env.XDG_CONFIG_HOME, explicit: process.env.CODEX_ATLASSIAN_CONFIG };
  const hadExplicit = Object.hasOwn(process.env, 'CODEX_ATLASSIAN_CONFIG');
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.CODEX_ATLASSIAN_CONFIG;
  try {
    const skipped = makeRuntime(project, { root });
    const offPort = await skipped.runtime.start({ projectPath: project, port: 3001 });
    assert.equal(offPort.status, 'running');
    assert.equal(Object.hasOwn(skipped.children[0].spawnOptions.env, 'CODEX_ATLASSIAN_CONFIG'), false);
    assert.match(offPort.notice, /Atlassian is off for port 3001.*port 3000/);
    assert.doesNotMatch(JSON.stringify(skipped.runtime.snapshot()), /pair=/);
    await skipped.runtime.stop();

    const matched = makeRuntime(project, { root });
    const onPort = await matched.runtime.start({ projectPath: project });
    assert.equal(matched.children[0].spawnOptions.env.CODEX_ATLASSIAN_CONFIG, config);
    assert.equal(onPort.notice, undefined);
    await matched.runtime.stop();

    process.env.CODEX_ATLASSIAN_CONFIG = config;
    const explicit = makeRuntime(project, { root });
    await explicit.runtime.start({ projectPath: project, port: 3001 });
    assert.equal(explicit.children[0].spawnOptions.env.CODEX_ATLASSIAN_CONFIG, config);
    await explicit.runtime.stop();
  } finally {
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
    if (hadExplicit) process.env.CODEX_ATLASSIAN_CONFIG = saved.explicit; else delete process.env.CODEX_ATLASSIAN_CONFIG;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('startup exit reports a short redacted tail of the child stderr', async () => {
  const root = temporary();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { runtime, children } = makeRuntime(project, { root, ready: false, startTimeoutMs: 500 });
  runtime.spawnImpl = (_exe, _args, spawnOptions) => {
    const child = fakeChild({ ready: false });
    children.push({ child, spawnOptions });
    fs.mkdirSync(path.dirname(spawnOptions.env.CODEX_A2A_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(spawnOptions.env.CODEX_A2A_TOKEN_FILE, 'a'.repeat(43), { mode: 0o600 });
    setImmediate(() => {
      child.stderr.write('Atlassian configuration is invalid\n');
      child.stderr.write('Bearer SECRETBEARER123 pair=SECRETPAIR456 client_secret=SECRETCLIENT789\n');
      child.stderr.end();
      child.exitCode = 1;
      child.emit('exit', 1, null);
    });
    return child;
  };
  await assert.rejects(runtime.start({ projectPath: project }), (error) => {
    assert.match(error.message, /^Project server exited during startup \(1\)\. Server output: /);
    assert.match(error.message, /Atlassian configuration is invalid/);
    assert.match(error.message, /pair=\[redacted\]/);
    assert.doesNotMatch(error.message, /SECRETBEARER123|SECRETPAIR456|SECRETCLIENT789/);
    return true;
  });
  assert.equal(runtime.snapshot().status, 'error');
  assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /SECRETBEARER123|SECRETPAIR456|SECRETCLIENT789/);
  await fs.promises.rm(root, { recursive: true, force: true });
});
