'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it, mock } = require('node:test');
const { createProjectManager, ProjectError, KILL_GRACE_MS } = require('../src/launcher-projects');
const { SHUTDOWN_TOTAL_MS } = require('../src/server');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.signals = [];
    this.closeOn = 'SIGTERM';
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === this.closeOn || signal === 'SIGKILL') setImmediate(() => this.emit('close', null));
    return true;
  }
}

let tmp;
let spawned;
let busyPorts;
let probeOk;
let quarantineReason;
let events;
let alivePids;
let listeners;
let killed;

function makeManager(extra = {}) {
  return createProjectManager({
    repoDir: path.join(tmp, 'repo'),
    runtimeDir: path.join(tmp, 'runtime'),
    portRange: [4000, 4009],
    killGraceMs: 30,
    logLimit: 5,
    spawn: (cmd, args, opts) => {
      events.push('spawn');
      const child = new FakeChild(5000 + spawned.length);
      spawned.push({ cmd, args, opts, child });
      return child;
    },
    fetch: async (url) => {
      if (url.endsWith('/control/quarantine')) {
        return quarantineReason
          ? { ok: true, json: async () => ({ state: 'quarantined', reason: quarantineReason }) }
          : Promise.reject(new Error('quarantine endpoint is not present'));
      }
      if (!probeOk(url)) throw new Error('server is not listening');
      return { ok: true };
    },
    readProbeToken: () => 'a'.repeat(43),
    isPortFree: async (port) => !busyPorts.has(port),
    listenersOnPort: async () => listeners,
    isPidAlive: (pid) => alivePids.has(pid),
    ensureToken: () => events.push('token'),
    kill: (pid, signal) => killed.push([pid, signal]),
    ...extra
  });
}

function mkdir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-projects-'));
  spawned = [];
  busyPorts = new Set();
  probeOk = () => false;
  quarantineReason = null;
  events = [];
  alivePids = new Set();
  listeners = [];
  killed = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('add', () => {
  it('dedupes by realpath including symlinks', async () => {
    const manager = makeManager();
    const dir = mkdir('a');
    fs.symlinkSync(dir, path.join(tmp, 'link'));
    const first = await manager.add(dir);
    const second = await manager.add(path.join(tmp, 'link'));
    assert.equal(second.id, first.id);
    assert.equal(manager.list().length, 1);
    assert.equal(first.name, 'a');
    assert.equal(first.status, 'stopped');
    assert.match(first.id, /^[0-9a-f]{10}$/);
  });

  it('rejects missing paths and files', async () => {
    const manager = makeManager();
    await assert.rejects(manager.add(path.join(tmp, 'nope')), (e) => e instanceof ProjectError && e.code === 'not_a_directory');
    fs.writeFileSync(path.join(tmp, 'f'), 'x');
    await assert.rejects(manager.add(path.join(tmp, 'f')), (e) => e.code === 'not_a_directory');
  });

  it('gives concurrent adds different ports and skips busy ones', async () => {
    busyPorts.add(4000);
    const manager = makeManager();
    const views = await Promise.all(['a', 'b', 'c'].map((n) => manager.add(mkdir(n))));
    assert.deepEqual(views.map((v) => v.port).sort(), [4001, 4002, 4003]);
  });

  it('adopts the legacy state db only for the first project and only if it exists', async () => {
    const runtime = path.join(tmp, 'runtime');
    const manager = makeManager();
    const a = await manager.add(mkdir('a'));
    assert.equal(a.stateDb, path.join(runtime, 'projects', a.id, 'state.sqlite'));

    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'state.sqlite'), '');
    const other = makeManager({ runtimeDir: path.join(tmp, 'rt2') });
    fs.mkdirSync(path.join(tmp, 'rt2'));
    fs.writeFileSync(path.join(tmp, 'rt2', 'state.sqlite'), '');
    const first = await other.add(mkdir('b'));
    const second = await other.add(mkdir('c'));
    assert.equal(first.stateDb, path.join(tmp, 'rt2', 'state.sqlite'));
    assert.equal(second.stateDb, path.join(tmp, 'rt2', 'projects', second.id, 'state.sqlite'));
    assert.equal(other.stateDbPath(first.id), first.stateDb);
    assert.equal(other.baseUrl(first.id), `http://127.0.0.1:${first.port}`);
    // Role overrides never follow the legacy state db: every project gets its own directory.
    assert.equal(other.roleOverridesPath(first.id), path.join(tmp, 'rt2', 'projects', first.id, 'role-overrides.json'));
    assert.equal(other.roleOverridesPath(second.id), path.join(tmp, 'rt2', 'projects', second.id, 'role-overrides.json'));
    assert.throws(() => other.roleOverridesPath('zzzzzzzzzz'), (e) => e.code === 'not_found');
    assert.equal(other.projectSettingsPath(first.id), path.join(tmp, 'rt2', 'projects', first.id, 'project-settings.json'));
    assert.equal(other.projectSettingsPath(second.id), path.join(tmp, 'rt2', 'projects', second.id, 'project-settings.json'));
    assert.throws(() => other.projectSettingsPath('zzzzzzzzzz'), (e) => e.code === 'not_found');
  });
});

describe('registry', () => {
  it('round-trips across instances with restricted modes', async () => {
    const one = makeManager();
    const a = await one.add(mkdir('a'));
    await one.touch(a.id);
    const two = makeManager();
    await two.init();
    assert.equal(two.list().length, 1);
    assert.equal(two.get(a.id).port, a.port);
    assert.ok(two.get(a.id).lastUsedAt);
    assert.equal(two.get('zzz'), null);
    const file = path.join(tmp, 'runtime', 'projects.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  });

  it('recovers from a corrupt file', async () => {
    const runtime = path.join(tmp, 'runtime');
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'projects.json'), '{not json');
    const manager = makeManager();
    await manager.init();
    assert.deepEqual(manager.list(), []);
    assert.ok(fs.readdirSync(runtime).some((n) => n.startsWith('projects.json.corrupt-')));
    await manager.add(mkdir('a'));
    assert.equal(manager.list().length, 1);
  });

  it('unknown ids give not_found', async () => {
    const manager = makeManager();
    await assert.rejects(manager.start('x'), (e) => e.code === 'not_found');
    await assert.rejects(manager.stop('x'), (e) => e.code === 'not_found');
    await assert.rejects(manager.remove('x'), (e) => e.code === 'not_found');
    await assert.rejects(manager.touch('x'), (e) => e.code === 'not_found');
    assert.throws(() => manager.status('x'), (e) => e.code === 'not_found');
  });
});

describe('start', () => {
  it('spawns with expected args and env, token first', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    const v = await manager.start(p.id);
    assert.equal(v.status, 'starting');
    assert.deepEqual(events, ['token', 'spawn']);
    const s = spawned[0];
    assert.equal(s.cmd, process.execPath);
    assert.deepEqual(s.args, ['server-bootstrap.js']);
    assert.equal(s.opts.cwd, path.join(tmp, 'repo'));
    assert.equal(s.opts.env.PORT, String(p.port));
    assert.equal(s.opts.env.CODEX_WORKSPACE, p.path);
    assert.equal(s.opts.env.CODEX_A2A_STATE_DB, p.stateDb);
    assert.equal(s.opts.env.CODEX_A2A_ROLE_OVERRIDES, path.join(tmp, 'runtime', 'projects', p.id, 'role-overrides.json'));
    assert.ok(fs.existsSync(path.dirname(s.opts.env.CODEX_A2A_ROLE_OVERRIDES)));
    assert.equal(s.opts.env.CODEX_A2A_PROJECT_SETTINGS, path.join(tmp, 'runtime', 'projects', p.id, 'project-settings.json'));
    assert.ok(fs.existsSync(path.dirname(p.stateDb)));
    assert.equal(fs.existsSync(s.opts.env.CODEX_A2A_PROJECT_SETTINGS), false, 'missing launcher settings preserve existing project defaults');
    assert.equal(manager.get(p.id).pid, s.child.pid);
    assert.match(manager.status(p.id).logs[0], /^\[LAUNCHER\] Starting orchestrator for workspace: .* on port \d+\n$/);
  });

  it('is idempotent including concurrent calls', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await Promise.all([manager.start(p.id), manager.start(p.id)]);
    await manager.start(p.id);
    assert.equal(spawned.length, 1);
  });

  it('applies the owner launcher default only where project execution permissions are omitted', async () => {
    const manager = makeManager();
    const runtime = path.join(tmp, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'launcher-settings.json'), JSON.stringify({ version: 1, defaultExecutionPermissions: 'full-access' }));

    const optedInProject = await manager.add(mkdir('new-after-opt-in'));
    const optedInSettingsPath = manager.projectSettingsPath(optedInProject.id);
    assert.equal(fs.existsSync(optedInSettingsPath), false);
    await manager.start(optedInProject.id);
    const applied = JSON.parse(fs.readFileSync(optedInSettingsPath, 'utf8'));
    assert.equal(applied.version, 1);
    assert.equal(applied.executionPermissions, 'full-access');
    assert.equal(applied.deliveryEngine, undefined);

    const omittedProject = await manager.add(mkdir('existing-omitted-permissions'));
    const omittedSettingsPath = manager.projectSettingsPath(omittedProject.id);
    const omittedSettings = { version: 1, deliveryEngine: 'concurrent-v1', aut03LeadSkillEnabled: true };
    fs.mkdirSync(path.dirname(omittedSettingsPath), { recursive: true });
    fs.writeFileSync(omittedSettingsPath, JSON.stringify(omittedSettings));
    await manager.start(omittedProject.id);
    const merged = JSON.parse(fs.readFileSync(omittedSettingsPath, 'utf8'));
    assert.equal(merged.executionPermissions, 'full-access');
    assert.equal(merged.deliveryEngine, omittedSettings.deliveryEngine);
    assert.equal(merged.aut03LeadSkillEnabled, omittedSettings.aut03LeadSkillEnabled);

    const explicitProject = await manager.add(mkdir('explicit-settings'));
    const explicitSettingsPath = manager.projectSettingsPath(explicitProject.id);
    const explicitSettings = { version: 1, executionPermissions: 'strict', deliveryEngine: 'concurrent-v1', aut03LeadSkillEnabled: true };
    fs.mkdirSync(path.dirname(explicitSettingsPath), { recursive: true });
    fs.writeFileSync(explicitSettingsPath, JSON.stringify(explicitSettings));
    await manager.start(explicitProject.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(explicitSettingsPath, 'utf8')), explicitSettings);
    assert.equal(spawned.length, 3);
  });

  it('fails before spawn for malformed or unsupported launcher defaults', async () => {
    const invalidDocuments = ['{not json', JSON.stringify({ version: 1, defaultExecutionPermissions: 'danger-full-access' }),
      JSON.stringify({ version: 1, defaultExecutionPermissions: 'full-access', extra: true })];
    for (let index = 0; index < invalidDocuments.length; index += 1) {
      const runtime = path.join(tmp, 'runtime-invalid-' + index);
      const manager = makeManager({ runtimeDir: runtime });
      const project = await manager.add(mkdir('invalid-' + index));
      fs.writeFileSync(path.join(runtime, 'launcher-settings.json'), invalidDocuments[index]);

      await assert.rejects(manager.start(project.id), /Launcher settings are invalid/);
      assert.equal(manager.get(project.id).status, 'stopped');
      assert.equal(spawned.length, 0);
      assert.deepEqual(events, [], 'invalid launcher settings must fail before token setup');
      const diagnostic = manager.status(project.id).startupDiagnostic;
      assert.equal(diagnostic.outcome, 'failed');
      assert.equal(diagnostic.stage, 'launcher_settings');
      assert.match(diagnostic.message, /Launcher settings are invalid/);
      assert.equal(fs.existsSync(manager.projectSettingsPath(project.id)), false);
    }
  });

  it('becomes running on stdout marker', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.stdout.emit('data', 'booting\n');
    assert.equal(manager.get(p.id).status, 'starting');
    spawned[0].child.stdout.emit('data', 'Codex Universal A2A listening at http://x\n');
    assert.equal(manager.get(p.id).status, 'running');
    assert.equal(manager.get(p.id).taskReady, false);
    await tick();
    assert.equal(manager.get(p.id).readiness, 'unavailable');
  });

  it('marks a quarantine stub as process-running but not task-ready', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('quarantined'));
    quarantineReason = 'concurrent_startup_recovery_unsafe';
    await manager.start(p.id);
    spawned[0].child.stdout.emit('data', 'Codex Universal A2A listening at http://x\n');
    await tick();

    const view = manager.get(p.id);
    assert.equal(view.status, 'running');
    assert.equal(view.readiness, 'quarantined');
    assert.equal(view.readinessReason, 'concurrent_startup_recovery_unsafe');
    assert.equal(view.taskReady, false);
    await manager.start(p.id);
    assert.equal(spawned.length, 1, 'quarantine must not trigger a second process start');
    await assert.rejects(manager.remove(p.id), (error) => error.code === 'running');
  });

  it('adopts a live quarantined process without clearing its managed pid', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('adopt-quarantined'));
    await manager.start(p.id);
    const pid = spawned[0].child.pid;
    alivePids.add(pid);
    quarantineReason = 'concurrent_startup_recovery_unsafe';

    const adopter = makeManager();
    await adopter.init();
    assert.equal(adopter.get(p.id).status, 'running');
    assert.equal(adopter.get(p.id).readiness, 'quarantined');
    assert.equal(adopter.get(p.id).taskReady, false);
    assert.equal(adopter.get(p.id).pid, pid);
  });

  it('does not treat generic product text or stderr as a successful listen marker', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.stderr.emit('data', 'Codex Universal A2A startup failed before listening\n');
    spawned[0].child.stdout.emit('data', 'Codex Universal A2A is initializing\n');
    assert.equal(manager.get(p.id).status, 'starting');
    spawned[0].child.stdout.emit('data', 'Codex Universal A2A listening at http:');
    assert.equal(manager.get(p.id).status, 'starting');
    spawned[0].child.stdout.emit('data', '//127.0.0.1:4000\n');
    assert.equal(manager.get(p.id).status, 'running');
  });

  it('reallocates a busy port and persists it', async () => {
    const manager = makeManager();
    const a = await manager.add(mkdir('a'));
    const b = await manager.add(mkdir('b'));
    busyPorts.add(a.port);
    await manager.start(a.id);
    assert.notEqual(manager.get(a.id).port, a.port);
    assert.notEqual(manager.get(a.id).port, b.port);
    assert.equal(spawned[0].opts.env.PORT, String(manager.get(a.id).port));
    const again = makeManager();
    await again.init();
    assert.equal(again.get(a.id).port, manager.get(a.id).port);
  });

  it('returns to stopped when ensureToken or spawn throws', async () => {
    let fail = true;
    const manager = makeManager({ ensureToken: () => { if (fail) throw new Error('token'); } });
    const p = await manager.add(mkdir('a'));
    await assert.rejects(manager.start(p.id), /token/);
    assert.equal(manager.get(p.id).status, 'stopped');
    fail = false;
    const m2 = makeManager({ spawn: () => { throw new Error('spawn'); } });
    await m2.init();
    await assert.rejects(m2.start(p.id), /spawn/);
    assert.equal(m2.get(p.id).status, 'stopped');
    const restarted = makeManager();
    await restarted.init();
    assert.equal(restarted.status(p.id).startupDiagnostic.outcome, 'failed');
    assert.equal(restarted.status(p.id).startupDiagnostic.stage, 'spawn');
    assert.match(restarted.status(p.id).logs.join(''), /spawn/);
  });

  it('persists early token failures for status after manager reinitialization', async () => {
    const manager = makeManager({ ensureToken: () => { throw new Error('token setup unavailable'); } });
    const p = await manager.add(mkdir('a'));
    await assert.rejects(manager.start(p.id), /token setup unavailable/);
    assert.equal(manager.status(p.id).startupDiagnostic.stage, 'token');
    const file = path.join(tmp, 'runtime', 'projects', p.id, 'last-startup.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

    const restarted = makeManager();
    await restarted.init();
    const recovered = restarted.status(p.id);
    assert.equal(recovered.status, 'stopped');
    assert.equal(recovered.startupDiagnostic.outcome, 'failed');
    assert.equal(recovered.startupDiagnostic.stage, 'token');
    assert.match(recovered.logs.join(''), /token setup unavailable/);
  });

  it('redacts credential values with quoted JSON keys and values', async () => {
    const dummy = ['review', 'dummy', 'credential', '123456'].join('_');
    const message = `{"OPENAI_API_KEY":"${dummy}"}\n{'refresh_token':'${dummy}'}`;
    const manager = makeManager({ ensureToken: () => { throw new Error(message); } });
    const p = await manager.add(mkdir('a'));
    await assert.rejects(manager.start(p.id));

    const file = path.join(tmp, 'runtime', 'projects', p.id, 'last-startup.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(body.message, /"OPENAI_API_KEY":"\[REDACTED\]"/);
    assert.match(body.message, /'refresh_token':"\[REDACTED\]"/);
    assert.doesNotMatch(body.message, new RegExp(dummy));
  });

  it('persists sanitized startup stderr without stdout and restores it after manager reinitialization', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.stdout.emit('data', 'private conversation text must not persist\n');
    spawned[0].child.stderr.emit('data', 'Startup failed\nOPENAI_API_');
    assert.doesNotMatch(manager.status(p.id).logs.join(''), /OPENAI_API_/);
    spawned[0].child.stderr.emit('data', 'KEY=first-half-');
    assert.doesNotMatch(manager.status(p.id).logs.join(''), /OPENAI_API_|first-half/);
    assert.doesNotMatch(JSON.stringify(manager.status(p.id).startupDiagnostic), /OPENAI_API_|first-half/);
    spawned[0].child.stderr.emit('data', 'second-half-private');
    const file = path.join(tmp, 'runtime', 'projects', p.id, 'last-startup.json');
    const duringStartup = fs.readFileSync(file, 'utf8');
    assert.match(duringStartup, /Startup failed/);
    assert.doesNotMatch(duringStartup, /private conversation text|first-half|second-half-private/);
    assert.doesNotMatch(manager.status(p.id).logs.join(''), /second-half-private/);
    spawned[0].child.emit('close', 3);
    assert.match(manager.status(p.id).logs.join(''), /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(manager.status(p.id).logs.join(''), /first-half|second-half-private/);
    assert.equal(manager.status(p.id).startupDiagnostic.outcome, 'failed');

    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /Startup failed/);
    assert.match(body, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(body, /first-half|second-half-private|private conversation text/);

    const restarted = makeManager();
    await restarted.init();
    const recovered = restarted.status(p.id);
    assert.equal(recovered.startupDiagnostic.outcome, 'failed');
    assert.equal(recovered.startupDiagnostic.stage, 'server_startup');
    assert.match(recovered.logs.join(''), /Startup failed/);
    assert.match(recovered.logs.join(''), /OPENAI_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(recovered.logs.join(''), /first-half|second-half-private/);
  });

  it('omits overlong startup stderr lines from logs and persistence', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.stderr.emit('data', 'OPENAI_API_KEY=' + 'private-value-'.repeat(700));
    assert.doesNotMatch(manager.status(p.id).logs.join(''), /private-value/);
    spawned[0].child.emit('close', 2);
    const file = path.join(tmp, 'runtime', 'projects', p.id, 'last-startup.json');
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /Startup stderr line omitted/);
    assert.doesNotMatch(body, /private-value/);
    const restarted = makeManager();
    await restarted.init();
    assert.match(restarted.status(p.id).logs.join(''), /Startup stderr line omitted/);
    assert.doesNotMatch(restarted.status(p.id).logs.join(''), /private-value/);

    const completeLineProject = await manager.add(mkdir('b'));
    await manager.start(completeLineProject.id);
    spawned[1].child.stderr.emit('data', 'TOKEN=' + 'private-value-'.repeat(700) + '\n');
    assert.match(manager.status(completeLineProject.id).logs.join(''), /Startup stderr line omitted/);
    assert.doesNotMatch(manager.status(completeLineProject.id).logs.join(''), /private-value/);
    spawned[1].child.emit('close', 2);
  });

  it('replaces a failed startup diagnostic after a later successful start', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.stderr.emit('data', 'Concurrent delivery requires supported isolation\n');
    spawned[0].child.emit('close', 1);
    assert.equal(manager.status(p.id).startupDiagnostic.outcome, 'failed');

    await manager.start(p.id);
    spawned[1].child.stdout.emit('data', 'Codex Universal A2A listening at http://127.0.0.1:4000\n');
    assert.equal(manager.status(p.id).startupDiagnostic.outcome, 'started');
    assert.doesNotMatch(manager.status(p.id).logs.join(''), /Concurrent delivery requires/);
  });

  it('caps logs at logLimit and status returns the tail', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    for (let i = 0; i < 10; i += 1) spawned[0].child.stderr.emit('data', `line${i}\n`);
    const logs = manager.status(p.id).logs;
    assert.equal(logs.length, 5);
    assert.equal(logs[4], 'line9\n');
    assert.equal(manager.status(p.id).child, undefined);
  });
});

describe('exit handling', () => {
  it('marks stopped on close and appends the exit line', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.emit('close', 3);
    assert.equal(manager.get(p.id).status, 'stopped');
    assert.equal(manager.get(p.id).pid, null);
    assert.equal(manager.status(p.id).logs.at(-1), '\n[LAUNCHER] Server process exited (code: 3)\n');
  });

  it('a late close from an old child does not clobber a newer child', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    const oldChild = spawned[0].child;
    oldChild.emit('close', 1);
    await manager.start(p.id);
    const newChild = spawned[1].child;
    newChild.stdout.emit('data', 'Codex Universal A2A listening at http://127.0.0.1:4000');
    oldChild.emit('close', 0);
    oldChild.emit('error', new Error('late'));
    assert.equal(manager.get(p.id).status, 'running');
    assert.equal(manager.get(p.id).pid, newChild.pid);
  });

  it('ignores a late old-child close while a newer startup is still pending', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    const oldChild = spawned[0].child;
    oldChild.emit('close', 1);
    await manager.start(p.id);
    assert.equal(manager.get(p.id).status, 'starting');
    const before = manager.status(p.id).startupDiagnostic;

    oldChild.emit('close', 2);

    assert.equal(manager.get(p.id).status, 'starting');
    assert.deepEqual(manager.status(p.id).startupDiagnostic, before);
  });

  it('handles the spawn error event', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.emit('error', new Error('ENOENT'));
    assert.equal(manager.get(p.id).status, 'stopped');
    assert.equal(manager.get(p.id).pid, null);
  });
});

describe('stop', () => {
  it('sends SIGTERM and returns once the child closes', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    const v = await manager.stop(p.id);
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
    assert.equal(v.status, 'stopped');
    assert.equal((await manager.stop(p.id)).status, 'stopped');
  });

  it('waits for an in-flight start before stopping', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const manager = makeManager({ ensureToken: () => gate });
    const p = await manager.add(mkdir('a'));
    const starting = manager.start(p.id);
    await tick();
    assert.equal(manager.get(p.id).status, 'starting');
    const stopping = manager.stop(p.id);
    release();
    await starting;
    const v = await stopping;
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
    assert.equal(v.status, 'stopped');
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.closeOn = 'never';
    await manager.stop(p.id);
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM', 'SIGKILL']);
  });

  it('kills an adopted pid only when it listens on the port', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    const pid = spawned[0].child.pid;
    alivePids.add(pid);
    probeOk = () => true;
    const adopter = makeManager();
    await adopter.init();
    assert.equal(adopter.get(p.id).status, 'running');

    listeners = [pid + 1];
    await assert.rejects(adopter.stop(p.id), (e) => e.code === 'not_managed');
    assert.deepEqual(killed, []);

    listeners = [pid];
    const v = await adopter.stop(p.id);
    assert.deepEqual(killed, [[pid, 'SIGTERM']]);
    assert.equal(v.status, 'stopped');
    assert.equal(adopter.get(p.id).pid, null);
  });

  it('refuses a running project it did not start', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    probeOk = () => true;
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'running');
    await assert.rejects(manager.stop(p.id), (e) => e.code === 'not_managed');
    assert.deepEqual(killed, []);
  });
});

describe('init and refresh', () => {
  it('clears stale pids on init', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    const again = makeManager();
    await again.init();
    assert.equal(again.get(p.id).pid, null);
    assert.equal(again.get(p.id).status, 'stopped');
  });

  it('refresh transitions', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('a'));
    probeOk = () => true;
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'running');
    probeOk = () => false;
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'stopped');

    await manager.start(p.id);
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'starting');
    spawned[0].child.stdout.emit('data', 'Codex Universal A2A listening at http://127.0.0.1:4000');
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'running');
    probeOk = () => true;
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'running');
  });

  it('refresh preserves process liveness while changing task readiness', async () => {
    const manager = makeManager();
    const p = await manager.add(mkdir('readiness-refresh'));
    quarantineReason = 'concurrent_startup_recovery_unsafe';
    await manager.refresh();

    assert.equal(manager.get(p.id).status, 'running');
    assert.equal(manager.get(p.id).readiness, 'quarantined');
    assert.equal(manager.get(p.id).taskReady, false);

    quarantineReason = null;
    probeOk = () => true;
    await manager.refresh();
    assert.equal(manager.get(p.id).status, 'running');
    assert.equal(manager.get(p.id).readiness, 'ready');
    assert.equal(manager.get(p.id).taskReady, true);
  });

  it('keeps an HTTP server manageable when its A2A agent card is missing', async () => {
    const manager = makeManager({
      fetch: async () => ({ ok: false, status: 404 }),
    });
    const p = await manager.add(mkdir('missing-agent-card'));
    await manager.refresh();

    assert.equal(manager.get(p.id).status, 'running');
    assert.equal(manager.get(p.id).readiness, 'unavailable');
    assert.equal(manager.get(p.id).taskReady, false);
  });
});

describe('remove', () => {
  it('removes only stopped projects and keeps files', async () => {
    const manager = makeManager();
    const dir = mkdir('a');
    const p = await manager.add(dir);
    await manager.start(p.id);
    await assert.rejects(manager.remove(p.id), (e) => e.code === 'running');
    await manager.stop(p.id);
    await tick();
    await manager.remove(p.id);
    assert.equal(manager.list().length, 0);
    assert.ok(fs.existsSync(dir));
    const again = makeManager();
    await again.init();
    assert.equal(again.list().length, 0);
  });
});

describe('stop grace (STOP-01)', () => {
  const defaultGraceManager = () => makeManager({ killGraceMs: undefined });

  it('waits the whole server shutdown plus a margin before SIGKILL', async () => {
    assert.equal(KILL_GRACE_MS, SHUTDOWN_TOTAL_MS + 2000);
    const manager = defaultGraceManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.closeOn = 'never';
    const delays = [];
    const real = globalThis.setTimeout;
    // The grace timer fires at once; every other timer is left alone.
    const patched = mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
      delays.push(ms);
      return real(fn, ms === KILL_GRACE_MS ? 0 : ms, ...rest);
    });
    try {
      await manager.stop(p.id);
    } finally {
      patched.mock.restore();
    }
    assert.ok(delays.includes(KILL_GRACE_MS), `grace timer of ${KILL_GRACE_MS} ms was used: ${delays}`);
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM', 'SIGKILL']);
  });

  it('does not SIGKILL a server that finishes its drain inside the grace', async () => {
    const manager = defaultGraceManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.closeOn = 'never';
    const stopping = manager.stop(p.id);
    // A drain longer than the old 2 s grace is still waited out: the child exits on its own later.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
    spawned[0].child.emit('close', 0);
    await stopping;
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
  });

  it('stopAll waits at least the same grace before escalating', async () => {
    const manager = defaultGraceManager();
    const p = await manager.add(mkdir('a'));
    await manager.start(p.id);
    spawned[0].child.closeOn = 'never';
    const delays = [];
    const real = globalThis.setTimeout;
    const patched = mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
      delays.push(ms);
      return real(fn, ms >= KILL_GRACE_MS ? 0 : ms, ...rest);
    });
    try {
      await manager.stopAll();
    } finally {
      patched.mock.restore();
    }
    assert.ok(delays.some((ms) => ms >= KILL_GRACE_MS));
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM', 'SIGKILL']);
  });
});

describe('stopAll', () => {
  it('terminates all managed children and escalates stragglers', async () => {
    const manager = makeManager();
    const a = await manager.add(mkdir('a'));
    const b = await manager.add(mkdir('b'));
    await manager.start(a.id);
    await manager.start(b.id);
    spawned[1].child.closeOn = 'never';
    await manager.stopAll();
    assert.deepEqual(spawned[0].child.signals, ['SIGTERM']);
    assert.deepEqual(spawned[1].child.signals, ['SIGTERM', 'SIGKILL']);
  });
});
