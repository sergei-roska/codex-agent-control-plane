'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { VERSION } = require('../src/delivery-contracts');
const { DeliveryEngineRouter } = require('../src/delivery-engine-router');
const { startServer } = require('../src/server');
const { readProcessIdentity } = require('../src/process-quiescence');

const projectId = '0123456789';
const objectiveId = 'migration-objective';
const legacy = { async run() {}, async resume() {} };

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('failed additive mapping migration preserves claims and evidence across reopen and retry', async (t) => {
  const file = path.join(directory(t), 'state.sqlite');
  let db = new Database(file);
  const store = new BacklogStore(db, { roleCapacities: { engineer: 1 }, maxActiveTurns: 2, plannerReservedSlots: 1 });
  store.createObjective({ projectId, objectiveId, sessionId: 'session', engineVersion: 'delivery-v1', goalRevision: 1,
    requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const task = { schemaVersion: VERSION, projectId, objectiveId, taskId: 'pending', revision: 1, role: 'engineer',
    kind: 'implementation', objective: 'Implement pending work', priority: 0, dependencies: [], productWritePaths: ['src/a'],
    readScope: { kind: 'known', paths: [] }, scratchWriteRoots: ['.scratch'], resourceClaims: [],
    publicationAuthority: { state: 'unknown' }, state: 'queued' };
  store.applyPlan(projectId, objectiveId, { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1, tasks: [{ task }], dependencies: [] });
  const [claim] = store.claimReady(projectId, objectiveId, 0, { controlRevision: 1 });
  db.exec(`CREATE TABLE delivery_run_engines (project_id TEXT NOT NULL, run_id TEXT NOT NULL, engine TEXT NOT NULL,
    objective_id TEXT, session_id TEXT, request_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, run_id));`);
  db.prepare('INSERT INTO delivery_run_engines VALUES(?,?,?,?,?,?,?,?)').run(projectId, 'old-run', 'concurrent-v1', objectiveId, 'session', JSON.stringify({ goal: 'Original goal' }), 1, 2);
  const rows = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const before = { claims: rows('backlog_claims'), attempts: rows('backlog_attempts'), events: rows('delivery_events'), mappings: rows('delivery_run_engines') };
  const failingDb = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql) => {
      if (sql.startsWith('ALTER TABLE delivery_run_engines')) throw new Error('injected migration failure');
      return target.exec(sql);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => new DeliveryEngineRouter({ db: failingDb, projectId, legacyEngine: legacy }), /injected migration failure/);
  db.close();
  db = new Database(file);
  assert.deepEqual(rows('backlog_claims'), before.claims);
  assert.deepEqual(rows('backlog_attempts'), before.attempts);
  assert.deepEqual(rows('delivery_events'), before.events);
  assert.deepEqual(rows('delivery_run_engines'), before.mappings);
  assert.equal(db.prepare('PRAGMA table_info(delivery_run_engines)').all().some((column) => column.name === 'resume_placeholder'), false);
  const interruptedDb = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql) => {
      const result = target.exec(sql);
      if (sql.startsWith('ALTER TABLE delivery_run_engines')) throw new Error('injected post-alter interruption');
      return result;
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => new DeliveryEngineRouter({ db: interruptedDb, projectId, legacyEngine: legacy }), /injected post-alter interruption/);
  db.close();
  db = new Database(file);
  assert.deepEqual(rows('backlog_claims'), before.claims);
  assert.deepEqual(rows('backlog_attempts'), before.attempts);
  assert.deepEqual(rows('delivery_events'), before.events);
  const migrated = rows('delivery_run_engines');
  assert.equal(migrated[0].resume_placeholder, 0);
  delete migrated[0].resume_placeholder;
  assert.deepEqual(migrated, before.mappings);
  const router = new DeliveryEngineRouter({ db, projectId, legacyEngine: legacy, concurrentEngine: legacy });
  assert.equal(router.mapping('old-run').engine, 'concurrent-v1');
  assert.deepEqual(router.mapping('old-run').request, { goal: 'Original goal' });
  await assert.rejects(router.run({ runId: 'old-run', goal: 'Changed goal' }), { code: 'run_intake_conflict' });
  assert.deepEqual(router.mapping('old-run').request, { goal: 'Original goal' });
  assert.equal(new BacklogStore(db).listClaims(projectId, objectiveId)[0].fencingToken, claim.claim.fencingToken);
  assert.deepEqual(rows('delivery_events'), before.events);
  db.close();
  db = new Database(file);
  assert.equal(new DeliveryEngineRouter({ db, projectId, legacyEngine: legacy }).mapping('old-run').request.goal, 'Original goal');
  assert.deepEqual(rows('backlog_claims'), before.claims);
  db.close();
});

function workspace(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Qualification Test');
  git('config', 'user.email', 'qualification@example.invalid');
  fs.writeFileSync(path.join(dir, 'source.txt'), 'initial\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return dir;
}

function serverOptions(root, work, name, legacyRun) {
  const settings = path.join(root, `${name}-settings.json`);
  fs.writeFileSync(settings, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  const home = path.join(root, `${name}-home`);
  fs.mkdirSync(home);
  const identity = { accountId: 'fake-account', codexHome: home };
  return { settings, options: { listen: false, workspace: work, stateFile: path.join(root, `${name}.sqlite`),
    tokenFile: path.join(root, `${name}-token`), workspaceLockDir: path.join(root, 'locks'),
    deliveryStorageRoot: path.join(root, `${name}-storage`), projectSettingsFile: settings, autoResume: false,
    appServer: { async start() {}, async close() {}, getCodexHome: () => home, getVersion: () => 'test',
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async prepareThread({ role }) { return { threadId: `${role.id || role.name}-thread`, codexHome: home }; },
      async execCommand({ command, cwd }) {
        try { return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
        catch (error) { return { exitCode: error.status || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }; }
      },
      async resolveExecutionPermissions() { return { mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }; },
      async run() { throw new Error('Unexpected provider call'); } },
    providerIdentityPinFactory: () => ({ providerIdentity: identity, providerIdentityFor: () => identity }),
    orchestratorFactory: () => ({ run: legacyRun, async resume() { return { status: 'completed' }; } }) } };
}

test('composed engines fence mixed intake and workspace aliases while an independent project runs', async (t) => {
  const root = directory(t);
  const firstWorkspace = workspace(root, 'first');
  const secondWorkspace = workspace(root, 'second');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(firstWorkspace, alias);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const first = serverOptions(root, firstWorkspace, 'first', async () => {
    entered();
    await held;
    fs.writeFileSync(path.join(firstWorkspace, 'source.txt'), 'legacy publication\n');
    return { status: 'completed' };
  });
  const second = serverOptions(root, secondWorkspace, 'second', async () => {
    fs.writeFileSync(path.join(secondWorkspace, 'source.txt'), 'independent publication\n');
    return { status: 'completed' };
  });
  const runtime = await startServer(first.options);
  let independent;
  let restarted;
  try {
    const running = runtime.orchestrator.runLegacy({ runId: 'held-legacy', goal: 'Publish legacy' });
    await started;
    await assert.rejects(runtime.orchestrator.run({ runId: 'blocked-concurrent', goal: 'Publish concurrent' }), { code: 'delivery_engine_unsafe' });
    assert.equal(runtime.orchestrator.mapping('blocked-concurrent'), null);
    assert.equal(fs.readFileSync(path.join(firstWorkspace, 'source.txt'), 'utf8'), 'initial\n');
    await assert.rejects(startServer({ ...first.options, workspace: alias, stateFile: path.join(root, 'other.sqlite'), tokenFile: path.join(root, 'other-token') }), /in use/);
    independent = await startServer(second.options);
    await independent.orchestrator.runLegacy({ runId: 'independent', goal: 'Publish independently' });
    assert.equal(fs.readFileSync(path.join(secondWorkspace, 'source.txt'), 'utf8'), 'independent publication\n');
    release();
    await running;
    assert.equal(fs.readFileSync(path.join(firstWorkspace, 'source.txt'), 'utf8'), 'legacy publication\n');
    const mapping = runtime.orchestrator.mapping('held-legacy');
    await runtime.close();
    fs.writeFileSync(first.settings, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
    restarted = await startServer(first.options);
    assert.deepEqual(restarted.orchestrator.mapping('held-legacy'), mapping);
    assert.equal(restarted.deliveryEngine, 'legacy');
  } finally {
    release();
    if (restarted) await restarted.close();
    if (independent) await independent.close();
    await runtime.close();
  }
});

test('held concurrent writer prevents legacy publication through the composed router', { timeout: 15000 }, async (t) => {
  const root = directory(t);
  const work = workspace(root, 'concurrent');
  let releaseWorker;
  let enteredWorker;
  const workerHeld = new Promise((resolve) => { releaseWorker = resolve; });
  const workerStarted = new Promise((resolve) => { enteredWorker = resolve; });
  let legacyCalls = 0;
  const fixture = serverOptions(root, work, 'concurrent', async () => {
    legacyCalls += 1;
    fs.writeFileSync(path.join(work, 'source.txt'), 'legacy publication\n');
    return { status: 'completed' };
  });
  fixture.options.listen = true;
  fixture.options.port = 0;
  const roles = path.join(root, 'roles.json');
  fs.writeFileSync(roles, JSON.stringify({ version: 1, roles: {
    coordinator: { model: 'test-model', effort: 'low', fastMode: 'off' },
    engineer: { model: 'test-model', effort: 'low', fastMode: 'off' },
    verifier: { model: 'test-model', effort: 'low', fastMode: 'off' },
  } }));
  fixture.options.roleOverridesFile = roles;
  let runtime;
  fixture.options.appServer.run = async (options) => {
    const role = options.role.id || options.role.name;
    const threadId = options.threadId || `${role}-thread`;
    const turnId = `turn-${role}`;
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    let text;
    if (role === 'coordinator') {
      const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      const mapping = runtime.orchestrator.mapping('concurrent-run');
      const task = { schemaVersion: VERSION, projectId: runtime.projectId, objectiveId: mapping.objectiveId,
        taskId: 'held-writer', revision: 1, role: 'engineer', kind: 'implementation', objective: 'Write a scoped result',
        priority: 1, dependencies: [], productWritePaths: ['writer.txt'], readScope: { kind: 'known', paths: ['source.txt'] },
        scratchWriteRoots: ['.scratch/held-writer'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' };
      const delta = { schemaVersion: VERSION, expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision,
        expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision,
        nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task }], dependencies: [] };
      text = JSON.stringify({ expected: prompt.pins, delta, dialogue: 'Run the scoped writer.', recovery: null, ownerDecision: null });
    } else if (role === 'engineer') {
      fs.writeFileSync(path.join(options.cwd, 'writer.txt'), 'private candidate\n');
      enteredWorker(options.cwd);
      await workerHeld;
      text = JSON.stringify({ outcome: 'completed', summary: 'Writer finished.', filesChanged: ['writer.txt'],
        filesInspected: ['source.txt'], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
    } else throw new Error(`Unexpected role ${role}`);
    return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
  };
  runtime = await startServer(fixture.options);
  const abort = new AbortController();
  const running = runtime.orchestrator.run({ runId: 'concurrent-run', goal: 'Write a scoped result', signal: abort.signal });
  running.catch(() => {});
  try {
    const lane = await Promise.race([workerStarted, running.then((value) => { throw new Error(`Concurrent run ended early: ${JSON.stringify(value)}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Writer did not start')), 7000); timer.unref(); })]);
    assert.notEqual(fs.realpathSync(lane), fs.realpathSync(work));
    assert.equal(fs.readFileSync(path.join(lane, 'writer.txt'), 'utf8'), 'private candidate\n');
    await assert.rejects(runtime.orchestrator.runLegacy({ runId: 'blocked-legacy', goal: 'Publish legacy' }), (error) => ['delivery_engine_busy', 'delivery_engine_unsafe'].includes(error.code));
    assert.equal(legacyCalls, 0);
    assert.equal(runtime.orchestrator.mapping('blocked-legacy'), null);
    assert.equal(fs.readFileSync(path.join(work, 'source.txt'), 'utf8'), 'initial\n');
    assert.equal(fs.existsSync(path.join(work, 'writer.txt')), false);
    fs.writeFileSync(fixture.settings, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
    await assert.rejects(startServer({ ...fixture.options, stateFile: path.join(root, 'disabled.sqlite'), tokenFile: path.join(root, 'disabled-token') }), /in use/);
    assert.equal(runtime.orchestrator.mapping('concurrent-run').engine, 'concurrent-v1');
  } finally {
    releaseWorker();
    abort.abort();
    await running.catch(() => {});
    try { await runtime.close(); }
    catch (_) {
      runtime.httpServer?.closeAllConnections?.();
      if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      await runtime.appServer.close?.();
      if (runtime.state.db.open) await runtime.state.close();
    }
  }
});
