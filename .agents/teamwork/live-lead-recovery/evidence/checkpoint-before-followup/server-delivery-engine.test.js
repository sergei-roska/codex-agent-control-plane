'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { TaskState } = require('@a2a-js/sdk');
const { startServer, projectIdForWorkspace } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { openStateDatabase, acquireWorkspaceLock } = require('../src/durable-store');
const { readProcessIdentity } = require('../src/process-quiescence');
const { scopedExecutionDetails } = require('../src/delivery-role-capabilities');

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-delivery-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function appServer(overrides = {}) {
  return {
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async run() {},
    async close() {},
    ...overrides,
  };
}

function message(text, extra = {}) {
  return { messageId: 'new-message', contextId: '', taskId: '', role: 1,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: undefined, extensions: [], referenceTaskIds: [], ...extra };
}

function assertStrictOutputSchema(schema) {
  const allowed = new Set(['type', 'additionalProperties', 'required', 'properties', 'items', 'anyOf', 'enum']);
  const visit = (node, at = '$') => {
    assert.ok(node && typeof node === 'object' && !Array.isArray(node), `schema node must be an object at ${at}`);
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `unsupported schema keyword ${key} at ${at}`);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `object must be closed at ${at}`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `every property must be required at ${at}`);
      for (const [key, child] of Object.entries(node.properties)) visit(child, `${at}.${key}`);
    }
    if (node.items) visit(node.items, `${at}[]`);
    for (const [index, child] of (node.anyOf || []).entries()) visit(child, `${at}.anyOf[${index}]`);
  };
  visit(schema);
}

const call = () => new ServerCallContext({ tenant: '' });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function createGitWorkspace(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Server Delivery Test');
  git('config', 'user.email', 'server-delivery@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'stable input\n');
  fs.writeFileSync(path.join(workspace, 'verify-source.js'), "'use strict';\nconst fs = require('node:fs');\nif (fs.readFileSync('source.txt', 'utf8') !== 'stable input\\n') process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'base');
}

test('direct server starts derive the normalized launcher project identity', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const runtime = await startServer({ listen: false, workspace, stateFile: ':memory:',
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    appServer: appServer(), orchestratorFactory: () => ({ async run() { return { status: 'completed' }; } }) });
  try {
    assert.equal(runtime.projectId, projectIdForWorkspace(workspace));
    assert.match(runtime.projectId, /^[0-9a-f]{10}$/);
    assert.equal(runtime.deliveryEngine, 'legacy');
  } finally {
    try { await runtime.close(); }
    catch (_) {
      runtime.httpServer?.closeAllConnections?.();
      if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      await runtime.appServer.close?.();
      if (runtime.state.db.open) await runtime.state.close();
    }
  }
});

test('legacy default composes the persisted router and completes a new A2A task on legacy', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const legacyRuns = [];
  const runtime = await startServer({ listen: false, workspace, stateFile: ':memory:',
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    appServer: appServer(), orchestratorFactory: () => ({
      async run(input) { legacyRuns.push(input); return { status: 'completed', text: 'legacy result' }; },
      async resume() { return { status: 'completed', text: 'legacy resume' }; },
    }) });
  try {
    const result = await runtime.leadAgent.requestHandler.sendMessage({ message: message('Use legacy default.'), configuration: {} }, call());
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify({ result, legacyRuns }));
    assert.equal(legacyRuns.length, 1);
    assert.equal(runtime.orchestrator.mapping(result.id).engine, 'legacy');
    assert.equal(runtime.orchestrator.mapping(result.id).projectId, runtime.projectId);
  } finally { await runtime.close(); }
});

test('configured project identity must match the exact real workspace hash', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  let started = false;
  await assert.rejects(startServer({ workspace, projectId: '0000000000', listen: false,
    appServer: appServer({ async start() { started = true; } }) }), { code: 'delivery_project_identity_invalid' });
  assert.equal(started, false);
});

test('state database mappings from another normalized project fail closed', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const stateFile = path.join(root, 'state.sqlite');
  fs.mkdirSync(workspace);
  const seed = await openStateDatabase({ filePath: stateFile });
  seed.db.exec(`CREATE TABLE delivery_run_engines (
    project_id TEXT NOT NULL, run_id TEXT NOT NULL, engine TEXT NOT NULL, objective_id TEXT, session_id TEXT,
    request_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,run_id));
    INSERT INTO delivery_run_engines(project_id,run_id,engine,request_json,created_at,updated_at)
    VALUES('ffffffffff','foreign-run','legacy','{}',1,1);`);
  await seed.close();
  await assert.rejects(startServer({ listen: false, workspace, stateFile,
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    appServer: appServer(), orchestratorFactory: () => ({ async run() {}, async resume() {} }) }),
  { code: 'delivery_project_identity_conflict' });
  const reopened = await openStateDatabase({ filePath: stateFile });
  assert.equal(reopened.db.prepare('SELECT run_id FROM delivery_run_engines').get().run_id, 'foreign-run');
  await reopened.close();
});

test('concurrent setting fails closed when startup selects unsupported shared isolation', async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const settings = path.join(root, 'project-settings.json');
  fs.mkdirSync(workspace);
  execFileSync('git', ['-C', workspace, 'init', '-q']);
  fs.writeFileSync(settings, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  let engineFactoryCalls = 0;
  let identityFactoryCalls = 0;
  await assert.rejects(startServer({ listen: false, workspace, stateFile: ':memory:',
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    projectSettingsFile: settings, appServer: appServer({
      async execCommand() { return { exitCode: 0, stdout: '', stderr: '' }; },
      getVersion() { return 'workspace-write-fixture'; },
      async resolveExecutionPermissions() { return { mode: 'inherit', profileApi: false, writerProfile: ':read-only', sandboxMode: 'read-only' }; },
    }),
    providerIdentityPinFactory() { identityFactoryCalls += 1; throw new Error('identity must not be read'); },
    concurrentEngineFactory() { engineFactoryCalls += 1; throw new Error('engine must not construct'); },
    orchestratorFactory: () => ({ async run() {}, async resume() {} }) }),
  (error) => error.code === 'concurrent_lane_isolation_required'
    && error.message === 'Concurrent delivery requires a supported lane isolation mode (native_permissions_use_shared_workspace)');
  assert.equal(identityFactoryCalls, 0);
  assert.equal(engineFactoryCalls, 0);
});

test('default server composition routes an authenticated steer into a held real concurrent lead turn', { timeout: 20000 }, async (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const codexHome = path.join(root, 'codex-home');
  const stateFile = path.join(root, 'state.sqlite');
  const storageRoot = path.join(root, 'delivery-storage');
  const settingsFile = path.join(root, 'project-settings.json');
  const roleOverridesFile = path.join(root, 'role-overrides.json');
  createGitWorkspace(workspace);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'fake-account-id', access_token: 'fake-token' } }));
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: { coordinator: { model: 'test-model', effort: 'low', fastMode: 'off' }, verifier: { model: 'test-model', effort: 'low', fastMode: 'off' } } }));

  const leadEntered = deferred();
  const releaseLead = deferred();
  const workerEntered = deferred();
  const releaseWorker = deferred();
  let leadTurns = 0;
  let ignoreWorkerAbort = false;
  const calls = [];
  const fakeAppServer = appServer({
    getCodexHome: () => codexHome,
    getVersion: () => 'server-delivery-test/1',
    async execCommand({ command, cwd }) {
      try {
        const stdout = execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { exitCode: 0, stdout, stderr: '' };
      } catch (error) {
        return { exitCode: Number.isInteger(error.status) ? error.status : 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || error.message || '') };
      }
    },
    resolveExecutionPermissions: async () => ({ mode: 'inherit', profileApi: false, writerProfile: null, sandboxMode: 'workspace-write',
      sandboxWorkspaceWrite: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
      approvalPolicy: 'on-request', approvalsReviewer: 'user' }),
    async prepareThread({ role }) { return { threadId: `${role.id || role.name}-thread`, codexHome }; },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      calls.push(roleId);
      const turnId = `turn-${roleId}-${calls.length}`;
      const threadId = options.threadId || `${roleId}-thread`;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      if (roleId === 'coordinator') {
        leadTurns += 1;
        if (leadTurns === 1) {
          leadEntered.resolve();
          await releaseLead.promise;
        }
        const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
        const runId = runtime.concurrentEngine.activeRuns()[0].runId;
        const mapping = runtime.orchestrator.mapping(runId);
        const task = { schemaVersion: 'delivery/v1', projectId: runtime.projectId, objectiveId: mapping.objectiveId,
          taskId: 'integration-engineer', revision: 1, role: 'engineer', kind: 'implementation',
          objective: 'Hold the worker while owner steering is accepted.', priority: 1, dependencies: [],
          productWritePaths: ['worker-output.txt'], readScope: { kind: 'known', paths: ['source.txt'] },
          scratchWriteRoots: ['.scratch/integration-engineer'], resourceClaims: [],
          publicationAuthority: { state: 'unknown' }, state: 'queued' };
        const delta = { schemaVersion: 'delivery/v1', expectedPlanRevision: prompt.pins.planRevision,
          expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
          expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
          tasks: [{ task }], dependencies: [] };
        return { threadId, turnId, status: 'completed', text: JSON.stringify({ expected: prompt.pins, delta,
          dialogue: 'Start the scoped engineer task.', recovery: null, ownerDecision: null }), usage: {}, permissionEvents: [],
          execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
      }
      if (roleId === 'engineer') {
        workerEntered.resolve();
        if (ignoreWorkerAbort) await releaseWorker.promise;
        else await Promise.race([releaseWorker.promise, new Promise((resolve) => options.signal?.addEventListener('abort', resolve, { once: true }))]);
        return { threadId, turnId, status: 'completed', text: JSON.stringify({ outcome: 'completed', summary: 'Worker turn settled after cancel.',
          filesChanged: [], filesInspected: ['source.txt'], checks: [{ command: 'inspect source.txt', result: 'passed', detail: 'Inspected the frozen input.' }],
          risks: [], scopeExpansion: [], decisionRequest: null }), usage: {}, permissionEvents: [],
          execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
      }
      const turnText = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.', filesChanged: [],
        filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against the frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null });
      return { threadId, turnId, status: 'completed', text: turnText, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
    },
  });

  let runtime;
  try {
    runtime = await startServer({ port: 0, workspace, stateFile, deliveryStorageRoot: storageRoot,
      tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
      projectSettingsFile: settingsFile, roleOverridesFile, appServer: fakeAppServer,
      orchestratorFactory: (options) => new LeadOrchestrator(options),
    });
    assert.equal(runtime.deliveryEngine, 'concurrent-v1');
    assert.equal(runtime.concurrentEngine, runtime.orchestrator.concurrentEngine);
    assert.equal(runtime.writerIsolation.mode, 'cooperative');
    assert.equal(runtime.writerIsolation.reason, 'trusted_native_workspace_write_cooperative');
    assert.equal(runtime.writerIsolation.confinement, 'none');
    assert.equal(runtime.writerIsolation.inherited, true);
    const request = runtime.leadAgent.requestHandler.sendMessage({ message: message('Inspect the current candidate.'), configuration: {} }, call());
    let guard;
    const taskEnded = request.then((result) => {
      throw new Error(`Lead task ended before the fake provider turn was held: ${result.status?.state || 'unknown'}`);
    });
    const diagnosticTimeout = new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(JSON.stringify({
      tasks: runtime.state.db.prepare('SELECT id,status_state FROM tasks WHERE owner=?').all('orchestrator'),
      mappings: runtime.orchestrator.mappings(), active: runtime.concurrentEngine.activeRuns(),
      plannerTurns: runtime.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all(),
      roles: runtime.concurrentEngine.roleService.projection(), calls,
      objective: runtime.concurrentEngine.store.getObjective(runtime.projectId, runtime.orchestrator.mappings()[0]?.objectiveId),
    }))), 3000); });
    try { await Promise.race([leadEntered.promise, taskEnded, diagnosticTimeout]); }
    finally { clearTimeout(guard); }
    const runId = runtime.concurrentEngine.activeRuns()[0]?.runId;
    assert.ok(runId);
    releaseLead.resolve();
    await workerEntered.promise;
    const status = runtime.concurrentEngine.controlStatus(runId);
    const token = fs.readFileSync(path.join(root, 'token'), 'utf8').trim();
    const baseUrl = `http://127.0.0.1:${runtime.port}`;
    const getResponse = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(getResponse.status, 200);
    const receivedStatus = await getResponse.json();
    assert.equal(receivedStatus.projectId, runtime.projectId);
    assert.equal(receivedStatus.objectiveId, status.objectiveId);
    const body = { runId, projectId: runtime.projectId, sessionId: status.sessionId, objectiveId: status.objectiveId,
      messageId: 'integration-steer-1', text: 'Continue with the candidate review.',
      expectedPlanRevision: status.revisions.planRevision, expectedGoalRevision: status.revisions.goalRevision,
      expectedControlRevision: status.revisions.controlRevision };
    const steerResponse = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}/steer`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(steerResponse.status, 200);
    const acknowledgement = await steerResponse.json();
    assert.equal(acknowledgement.acknowledged, true);
    assert.equal(acknowledgement.state, 'received');
    assert.equal(acknowledgement.messageId, body.messageId);
    assert.ok(calls.includes('engineer'));
    assert.equal(calls.includes('verifier'), false);
    ignoreWorkerAbort = true;
    await assert.rejects(runtime.close(), (error) => ['server_shutdown_drain_unsafe', 'concurrent_shutdown_unsafe'].includes(error.code));
    assert.equal(runtime.state.db.open, true);
    assert.throws(() => acquireWorkspaceLock(workspace, { lockDir: path.join(root, 'workspace-locks') }), /workspace .* is in use/i);
    releaseWorker.resolve();
    ignoreWorkerAbort = false;
    await assert.rejects(runtime.close(), { code: 'concurrent_shutdown_unsafe' });
    assert.equal(runtime.state.db.open, true);
    assert.throws(() => acquireWorkspaceLock(workspace, { lockDir: path.join(root, 'workspace-locks') }), /workspace .* is in use/i);
    assert.equal(runtime.orchestrator.mapping(runId).engine, 'concurrent-v1');
    assert.ok(runtime.concurrentEngine.controlStatus(runId).messages.some((item) => item.messageId === body.messageId));
  } finally {
    releaseLead.resolve();
    if (runtime) {
      try { await runtime.close(); }
      catch (_) {
        runtime.httpServer?.closeAllConnections?.();
        if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
        await runtime.appServer.close?.();
        if (runtime.state.db.open) await runtime.state.close();
      }
    }
  }
});

async function idleConcurrentServer(t, name = 'project', provider = {}, { executionPermissions = 'inherit', legacyRows = [], concurrentEngineFactory } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-delivery-engine-'));
  const workspace = path.join(root, name);
  const settingsFile = path.join(root, 'settings.json');
  const roleOverridesFile = path.join(root, 'roles.json');
  createGitWorkspace(workspace);
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: { coordinator: { model: 'test-model', effort: 'low', fastMode: 'off' }, verifier: { model: 'test-model', effort: 'low', fastMode: 'off' } } }));
  const calls = [];
  const permissionCalls = [];
  fs.mkdirSync(path.join(root, 'fake-home'));
  const identity = { accountId: 'fake-account', codexHome: path.join(root, 'fake-home') };
  const options = { listen: true, port: 0, workspace, stateFile: path.join(root, 'state.sqlite'),
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    deliveryStorageRoot: path.join(root, 'delivery-storage'), projectSettingsFile: settingsFile, roleOverridesFile,
    autoResume: false, appServer: appServer({
      getVersion: () => 'server-delivery-test/1',
      async execCommand(request) {
        permissionCalls.push(request);
        const { command, cwd } = request;
        try {
          return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
        } catch (error) {
          return { exitCode: error.status || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
        }
      },
      resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
      getCodexHome: () => identity.codexHome,
      async prepareThread({ role }) { return { threadId: `${role.id || role.name}-thread`, codexHome: identity.codexHome }; },
      async run() { throw new Error('Unexpected provider work'); },
      ...provider,
    }),
    providerIdentityPinFactory: () => ({ providerIdentity: identity, providerIdentityFor: () => identity }),
    ...(concurrentEngineFactory ? { concurrentEngineFactory } : {}),
    orchestratorFactory: () => ({
      async run(input) { calls.push(input.runId); return { status: 'completed', text: 'legacy result' }; },
      async resume() { return { status: 'completed' }; },
    }),
  };
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions, deliveryEngine: 'concurrent-v1' }));
  if (legacyRows.length) {
    const seeded = await openStateDatabase({ filePath: options.stateFile });
    const insertTask = seeded.db.prepare(`INSERT INTO tasks(tenant,owner,id,context_id,status_last_updated,status_state,status,artifacts,history,metadata,protocol_version)
      VALUES('','orchestrator',?,?,?,?,'{}','[]','[]','{}','1.0')`);
    for (const row of legacyRows) {
      insertTask.run(row.id, `context-${row.id}`, Date.now(), row.state);
      if (row.mapped) {
        seeded.db.exec(`CREATE TABLE IF NOT EXISTS delivery_run_engines (
          project_id TEXT NOT NULL, run_id TEXT NOT NULL, engine TEXT NOT NULL,
          objective_id TEXT, session_id TEXT, request_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,run_id))`);
        seeded.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
          VALUES(?,?,'legacy',?,?, '{}',1,1)`)
          .run(projectIdForWorkspace(workspace), row.id, `objective-${row.id}`, `session-${row.id}`);
      }
    }
    await seeded.close();
  }
  const runtime = await startServer(options);
  t.after(async () => {
    try { await runtime.close(); }
    finally {
      // Failed assertions must not leave disposable HTTP/state handles alive.
      runtime.httpServer.closeAllConnections();
      if (runtime.httpServer.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      if (runtime.state.db.open) await runtime.state.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { runtime, root, options, calls, permissionCalls, settingsFile };
}

test('concurrent engine admission recognizes persisted terminal legacy task states', { timeout: 60000 }, async (t) => {
  const terminalStates = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'];
  const cases = [
    ...terminalStates.map((state) => ({ state, mapped: false })),
    ...terminalStates.map((state) => ({ state, mapped: true })),
    ...['TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_UNKNOWN'].map((state) => ({ state, mapped: false, blocked: true })),
  ];
  for (const [index, fixture] of cases.entries()) {
    await t.test(`${fixture.state} ${fixture.mapped ? 'mapped' : 'startup task'}${fixture.blocked ? ' remains blocked' : ' admits concurrent engine'}`, async (subtest) => {
      let engineCalls = 0;
      let modelCalls = 0;
      const concurrentEngineFactory = () => ({
        register() {},
        async recoverStoredRuns() { return []; },
        async run() { engineCalls += 1; return { status: 'completed' }; },
        async resume() { engineCalls += 1; return { status: 'completed' }; },
        fenceShutdown() {},
        async prepareShutdown() {},
        beginProviderShutdown() {},
        async finishShutdown() { return { safeToRelease: true }; },
        async shutdown() { return { safeToRelease: true }; },
      });
      const fx = await idleConcurrentServer(subtest, `terminal-fence-${index}`, {
        async run() { modelCalls += 1; throw new Error('Model calls are not part of this admission test'); },
      }, { legacyRows: [{ id: `legacy-${index}`, state: fixture.state, mapped: fixture.mapped }], concurrentEngineFactory });
      const run = { runId: `new-${index}`, goal: 'Admit only when prior legacy work is terminal.' };
      if (fixture.blocked) {
        await assert.rejects(fx.runtime.orchestrator.run(run), { code: 'delivery_engine_busy' });
        assert.equal(engineCalls, 0);
      } else {
        assert.deepEqual(await fx.runtime.orchestrator.run(run), { status: 'completed' });
        assert.equal(engineCalls, 1);
        assert.equal(fx.runtime.orchestrator.mapping(run.runId).engine, 'concurrent-v1');
      }
      assert.equal(modelCalls, 0);
    });
  }
});

test('restart excludes a persisted concurrent task from the startup legacy fence on first HTTP intake', { timeout: 20000 }, async (t) => {
  const fixture = await idleConcurrentServer(t, 'restart-concurrent-task');
  const stored = seedConcurrentFence(fixture.runtime);
  const taskStore = require('../src/durable-store').createTaskStore(fixture.runtime.state, 'orchestrator');
  await taskStore.save({ id: stored.runId, contextId: `context-${stored.runId}`,
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, history: [], artifacts: [],
    metadata: { pause: { kind: 'stopped' } } }, call());
  await fixture.runtime.close();
  const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    seeded.db.exec(`CREATE TABLE delivery_planner_turns (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
    seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,
      status,pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown','{}',NULL,1,1)`)
      .run(fixture.runtime.projectId, stored.sessionId, 'fake-scope', 'fake-thread', 'unknown-prestart-turn');
  } finally { await seeded.close(); }

  let engineCalls = 0;
  fixture.options.concurrentEngineFactory = () => ({
    register() {},
    async recoverStoredRuns() { return []; },
    async run() { engineCalls += 1; return { status: 'completed', text: 'admitted' }; },
    async resume() { throw new Error('resume is not expected'); },
    fenceShutdown() {},
    async prepareShutdown() {},
    beginProviderShutdown() {},
    async finishShutdown() { return { safeToRelease: true }; },
    async shutdown() { return { safeToRelease: true }; },
  });
  const restarted = await startServer(fixture.options);
  t.after(async () => { await restarted.close(); });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${restarted.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'http-intake', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Start a new concurrent task.' }], metadata: {} }, configuration: {} } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(engineCalls, 1, JSON.stringify(result));
  assert.equal(result.error, undefined, JSON.stringify(result));
  const newMapping = restarted.orchestrator.mappings({ engine: 'concurrent-v1' }).find((mapping) => mapping.runId !== stored.runId);
  assert.ok(newMapping);
  assert.equal(restarted.orchestrator.mappings({ engine: 'concurrent-v1' }).length, 2);
  assert.equal(restarted.state.db.prepare('SELECT status_state FROM tasks WHERE owner=? AND id=?')
    .get('orchestrator', stored.runId).status_state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(restarted.state.db.prepare('SELECT status FROM delivery_planner_turns WHERE turn_id=?')
    .get('unknown-prestart-turn').status, 'unknown');
});

test('restart settles a proven terminal schema failure before first HTTP intake', { timeout: 20000 }, async (t) => {
  const providerCalls = [];
  const fixture = await idleConcurrentServer(t, 'restart-interrupted-shutdown', {
    async _request(method, params) {
      assert.equal(method, 'thread/read');
      assert.equal(params.threadId, 'coordinator-thread');
      return { thread: { id: params.threadId, turns: [{ id: 'failed-schema-turn', status: 'failed',
        error: { message: JSON.stringify({ type: 'error', status: 400, error: {
          message: "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas.",
          type: 'invalid_request_error', param: 'text.format.schema', code: 'invalid_json_schema',
        } }) },
        items: [{ type: 'userMessage', id: 'user-message' }] }] } };
    },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      providerCalls.push(roleId);
      if (roleId === 'coordinator') {
        const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
        return turnResult(options, JSON.stringify({ expected: pins, delta: null,
          dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
      }
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.',
        filesChanged: [], filesInspected: ['source.txt'],
        checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }));
    },
  });
  const stored = seedConcurrentFence(fixture.runtime);
  const identity = fixture.options.providerIdentityPinFactory().providerIdentity;
  const providerScope = `lead:${fixture.runtime.projectId}:${stored.sessionId}:${identity.accountId}:${identity.codexHome}`;
  const turnId = 'lead-known-terminal-schema-failure';
  const threadId = 'coordinator-thread';
  const settings = { threadId, codexHome: identity.codexHome, accountId: identity.accountId,
    transportKey: providerScope, settings: {}, settingsDigest: 'test-settings' };
  fixture.runtime.state.db.prepare("UPDATE concurrent_delivery_runs SET status='running' WHERE project_id=? AND run_id=?")
    .run(fixture.runtime.projectId, stored.runId);
  fixture.runtime.state.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
    VALUES(?,?,'concurrent-v1','dangling-objective','dangling-session','{}',1,1)`)
    .run(fixture.runtime.projectId, 'failed-first-request');
  fixture.runtime.state.db.prepare(`UPDATE concurrent_delivery_runs SET lead_thread_id=?,lead_codex_home=?,lead_settings_json=?
    WHERE project_id=? AND run_id=?`).run(threadId, identity.codexHome, JSON.stringify(settings), fixture.runtime.projectId, stored.runId);
  const taskStore = require('../src/durable-store').createTaskStore(fixture.runtime.state, 'orchestrator');
  await taskStore.save({ id: stored.runId, contextId: `context-${stored.runId}`,
    status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, history: [], artifacts: [],
    metadata: { pause: { kind: 'stopped' } } }, call());
  await fixture.runtime.close();

  const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    seeded.db.exec(`CREATE TABLE delivery_planner_turns (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
      pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
    seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,
    pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown',?,?,1,1)`)
      .run(fixture.runtime.projectId, stored.sessionId, providerScope, threadId, turnId,
        JSON.stringify({ ownerGeneration: 0 }), JSON.stringify({ errorCode: 'turn_error', preDispatchSource: null,
          providerFailure: { failureClass: 'domain_failure', status: 'failed' } }));
    const oldProcessIdentity = { pid: 99999999, pgid: 99999999, startTime: '1' };
    seeded.db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
      VALUES(?,?,?,?,?,NULL)`).run(fixture.runtime.projectId, stored.sessionId, turnId, JSON.stringify({
      projectId: fixture.runtime.projectId, sessionId: stored.sessionId, turnId, providerThreadId: threadId,
      providerScope, ownerGeneration: 0,
    }), JSON.stringify({ threadId, processIdentity: oldProcessIdentity }));
    seeded.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?')
      .run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities: [oldProcessIdentity] }), fixture.runtime.projectId);
  } finally { await seeded.close(); }

  const restarted = await startServer(fixture.options);
  t.after(async () => { await restarted.close(); });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const request = fetch(`http://127.0.0.1:${restarted.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'after-shutdown-recovery', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Confirm the current source is acceptable.' }], metadata: {} }, configuration: {} } }),
  });
  let responseTimer;
  const response = await Promise.race([request, new Promise((_, reject) => {
    responseTimer = setTimeout(() => reject(new Error(JSON.stringify({ providerCalls, active: restarted.concurrentEngine.activeRuns(),
      controllers: [...restarted.concurrentEngine.controllers.entries()].map(([id, controller]) => ({ id, status: controller.status() })),
      planner: restarted.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all(),
      mappings: restarted.orchestrator.mappings() }))), 5000);
  })]).finally(() => clearTimeout(responseTimer));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result?.task?.status?.state, 'TASK_STATE_COMPLETED', JSON.stringify(result));
  assert.equal(restarted.concurrentEngine.getRunDigest(result.result.task.id)?.disposition, 'accepted');
  assert.ok(providerCalls.includes('coordinator'));
  assert.ok(providerCalls.includes('verifier'));
  assert.equal(restarted.state.db.prepare('SELECT status FROM delivery_planner_turns WHERE turn_id=?').get(turnId).status, 'reconciled_no_effect');
  assert.equal(JSON.parse(restarted.state.db.prepare('SELECT result_json FROM delivery_planner_turns WHERE turn_id=?').get(turnId).result_json)
    .originalResult.errorCode, 'turn_error');
  assert.equal(JSON.parse(restarted.state.db.prepare('SELECT result_json FROM delivery_planner_turns WHERE turn_id=?').get(turnId).result_json)
    .source, 'codex_app_server.thread_read');
  assert.equal(JSON.parse(restarted.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?')
    .get(restarted.projectId).phase_json).phase, 'released');
  assert.equal(restarted.state.db.prepare('SELECT status_state FROM tasks WHERE owner=? AND id=?')
    .get('orchestrator', stored.runId).status_state, 'TASK_STATE_INPUT_REQUIRED');
});

test('planner sends a strict usable schema and exposes a failed terminal provider turn', { timeout: 15000 }, async (t) => {
  let seenSchema = null;
  const fixture = await idleConcurrentServer(t, 'planner-schema-terminal-failure', {
    async run(options) {
      seenSchema = options.outputSchema;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId: options.threadId, processIdentity });
      const providerError = { code: 'invalid_json_schema', type: 'invalid_request_error', param: 'text.format.schema',
        message: "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas." };
      const terminalTurn = { id: 'terminal-schema-failure', status: 'failed', error: { ...providerError,
        message: JSON.stringify({ type: 'error', error: providerError, status: 400 }) }, itemTypes: ['userMessage'] };
      throw Object.assign(new Error('Codex turn failed'), { failureClass: 'domain_failure', status: 'failed', codexError: terminalTurn.error,
        terminalTurn, execution: { processIdentity, generation: 1, threadId: options.threadId, turnId: terminalTurn.id,
          turnStartSent: true, turnStartRejected: false, turnTerminal: true } });
    },
  });
  const token = fs.readFileSync(fixture.options.tokenFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${fixture.runtime.port}/orchestrator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { messageId: 'schema-terminal-failure', contextId: '', taskId: '', role: 'ROLE_USER',
        parts: [{ text: 'Create a simple plan.' }], metadata: {} }, configuration: {} } }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const task = payload.result?.task;
  assert.ok(seenSchema);
  assertStrictOutputSchema(seenSchema);
  const deltaSchema = seenSchema.properties.delta.anyOf.find((entry) => entry.type === 'object');
  assert.ok(deltaSchema);
  assert.ok(Object.hasOwn(deltaSchema.properties, 'tasks') && Object.hasOwn(deltaSchema.properties, 'dependencies'));
  const taskSchema = deltaSchema.properties.tasks.items.anyOf.find((entry) => Object.hasOwn(entry.properties, 'task'))
    .properties.task;
  for (const key of ['role', 'objective', 'productWritePaths', 'readScope', 'state']) assert.ok(Object.hasOwn(taskSchema.properties, key));
  const dependencySchema = deltaSchema.properties.dependencies.items;
  for (const key of ['predecessorType', 'predecessorId', 'successorTaskId', 'kind']) assert.ok(Object.hasOwn(dependencySchema.properties, key));
  assert.equal(task?.status?.state, 'TASK_STATE_INPUT_REQUIRED', JSON.stringify(payload));
  assert.equal(task?.metadata?.pause?.kind, 'error');
  assert.match(task?.status?.message?.parts?.[0]?.text || '', /invalid_json_schema/);
  const ledger = fixture.runtime.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').get();
  assert.equal(ledger.status, 'reconciled_no_effect');
  assert.equal(JSON.parse(ledger.result_json).providerFailure.terminalTurn.error.code, 'invalid_json_schema');
  assert.equal(JSON.parse(ledger.result_json).terminalProof.source, 'codex_app_server.terminal_schema_failure');
  const fact = fixture.runtime.state.db.prepare('SELECT terminal_json FROM concurrent_planner_execution_facts').get();
  assert.equal(JSON.parse(fact.terminal_json).terminalTurn.status, 'failed');
});

test('startup refuses unsafe interrupted shutdowns and releases new server resources', { timeout: 20000 }, async (t) => {
  for (const scenario of ['live old provider group', 'started unknown planner']) {
    await t.test(scenario, async (subtest) => {
      let closeCalls = 0;
      let providerCalls = 0;
      const fixture = await idleConcurrentServer(subtest, `unsafe-recovery-${scenario.replaceAll(' ', '-')}`, {
        async run() { providerCalls += 1; throw new Error('No provider work is allowed during unsafe recovery.'); },
        async close() { closeCalls += 1; },
      });
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      closeCalls = 0;
      let startupListener = null;
      fixture.options.listenImpl = (application, port, host, callback) => {
        startupListener = application.listen(port, host, callback);
        return startupListener;
      };
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        let identities = [{ pid: 99999999, pgid: 99999999, startTime: '1' }];
        if (scenario === 'live old provider group') identities = [readProcessIdentity(process.pid)];
        seeded.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?')
          .run(JSON.stringify({ phase: 'provider_closing', attempts: [], identities }), fixture.runtime.projectId);
        if (scenario === 'started unknown planner') {
          seeded.db.exec(`CREATE TABLE delivery_planner_turns (
            project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
            provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
            pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id))`);
          seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,
            pins_json,result_json,started_at,updated_at) VALUES(?,?,?,?,?,'unknown','{}','{"errorCode":"provider_outcome_unknown"}',1,1)`)
            .run(fixture.runtime.projectId, stored.sessionId, 'unknown-scope', 'unknown-thread', 'started-unknown-turn');
          seeded.db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json,start_json,terminal_json)
            VALUES(?,?,?,?,?,NULL)`).run(fixture.runtime.projectId, stored.sessionId, 'started-unknown-turn', JSON.stringify({
            projectId: fixture.runtime.projectId, sessionId: stored.sessionId, turnId: 'started-unknown-turn',
          }), JSON.stringify({ threadId: 'unknown-thread', processIdentity: readProcessIdentity(process.pid) }));
        }
      } finally { await seeded.close(); }
      await assert.rejects(startServer(fixture.options), { code: 'concurrent_startup_recovery_unsafe' });
      assert.equal(closeCalls, 1);
      assert.ok(startupListener);
      assert.equal(startupListener.listening, false);
      assert.equal(providerCalls, 0);
      const reopened = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        assert.equal(JSON.parse(reopened.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?')
          .get(fixture.runtime.projectId).phase_json).phase, 'provider_closing');
        if (scenario === 'started unknown planner') {
          assert.equal(reopened.db.prepare('SELECT status FROM delivery_planner_turns WHERE turn_id=?')
            .get('started-unknown-turn').status, 'unknown');
        }
      } finally { await reopened.close(); }
    });
  }
});


function seedConcurrentFence(runtime, { disposition = 'canceled', claimStates = [], publicationStates = [] } = {}) {
  const { db } = runtime.state;
  const projectId = runtime.projectId;
  const runId = 'stored-concurrent';
  const objectiveId = runtime.orchestrator.objectiveIdFor(runId);
  const sessionId = runtime.orchestrator.sessionIdFor(runId);
  db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,objective_id,session_id,request_json,created_at,updated_at)
    VALUES(?,?,'concurrent-v1',?,?,'{}',1,1)`).run(projectId, runId, objectiveId, sessionId);
  db.prepare(`INSERT INTO concurrent_delivery_runs(project_id,run_id,objective_id,session_id,goal,contract_json,contract_digest,
    requirement_digest,checks_digest,environment_digest,check_identity,checkpoint_ids_json,status,created_at,updated_at)
    VALUES(?,?,?,?,'Stored goal','{}','contract','requirements','checks','environment','identity','[]','canceled',1,1)`)
    .run(projectId, runId, objectiveId, sessionId);
  runtime.concurrentEngine.store.createObjective({ projectId, objectiveId, sessionId, legacyRunId: runId,
    engineVersion: 'delivery/v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition });
  const candidates = runtime.concurrentEngine.candidateStore;
  candidates.createCandidate({ candidateId: 'candidate-base', projectId, objectiveId, integrationGeneration: 1,
    sourceAttemptId: 'base-attempt', environmentDigest: `sha256:${'a'.repeat(64)}`, checkIdentity: 'checks' });
  for (let index = 0; index < 3; index += 1) {
    candidates.createCandidate({ candidateId: `candidate-next-${index}`, parentCandidateId: 'candidate-base', projectId, objectiveId,
      integrationGeneration: index + 2, sourceAttemptId: `attempt-${index}`,
      environmentDigest: `sha256:${'a'.repeat(64)}`, checkIdentity: 'checks' });
  }
  seedConcurrentEffects(db, projectId, objectiveId, { claimStates, publicationStates });
  return { runId, objectiveId, sessionId };
}

function seedConcurrentEffects(db, projectId, objectiveId, { claimStates = [], publicationStates = [] } = {}) {
  for (const [index, state] of claimStates.entries()) {
    db.prepare(`INSERT INTO backlog_claims(project_id,objective_id,claim_id,task_id,attempt_id,role,fencing_token,record_json)
      VALUES(?,?,?,?,?,'engineer',?,?)`).run(projectId, objectiveId, `claim-${index}`, `task-${index}`, `attempt-${index}`,
      index + 1, JSON.stringify({ state }));
  }
  for (const [index, state] of publicationStates.entries()) {
    const artifactId = `artifact-${index}`;
    db.prepare(`INSERT INTO delivery_output_bindings(artifact_id,project_id,objective_id,task_id,attempt_id,lane_id,context_id,identity_json,state,record_json,created_at)
      VALUES(?,?,?,?,?,'lane','context','{}','bound','{}','now')`).run(artifactId, projectId, objectiveId, `task-${index}`, `attempt-${index}`);
    db.prepare(`INSERT INTO delivery_output_publications(intent_id,artifact_id,request_json,state,created_at,updated_at)
      VALUES(?,?,'{}',?,'now','now')`).run(`intent-${index}`, artifactId, state);
    if (['applied', 'not_applied'].includes(state)) {
      seedAuthoritativeEffects(db, projectId, { objectiveId }, { intentState: state, intentIndex: index });
    }
  }
}

async function cleanupSeededRecoveryFixture(runtime) {
  // Remove fabricated recovery faults only after admission assertions. This is fixture
  // teardown, not evidence that unknown production effects can drain safely.
  const db = runtime.state.db;
  db.prepare("DELETE FROM concurrent_delivery_runs WHERE run_id='stored-concurrent'").run();
  await runtime.close();
}

test('restart with legacy default fences persisted concurrent objectives, mixed claims, and publications', async (t) => {
  for (const scenario of [
    { name: 'active objective', disposition: 'executing', code: 'delivery_engine_busy' },
    { name: 'unknown claim', claimStates: ['released', 'unknown'], code: 'delivery_engine_unsafe' },
    { name: 'active claim', claimStates: ['released', 'active'], code: 'delivery_engine_unsafe' },
    { name: 'unknown publication', publicationStates: ['applied', 'unknown'], code: 'delivery_engine_unsafe' },
    { name: 'pending publication', publicationStates: ['refused', 'pending'], code: 'delivery_engine_unsafe' },
    { name: 'settled effects', claimStates: ['released'], publicationStates: ['applied', 'refused', 'not_applied'] },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        const row = seeded.db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(fixture.runtime.projectId, stored.objectiveId);
        const objective = { ...JSON.parse(row.record_json), disposition: scenario.disposition || 'canceled' };
        seeded.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?')
          .run(JSON.stringify(objective), fixture.runtime.projectId, stored.objectiveId);
        seedConcurrentEffects(seeded.db, fixture.runtime.projectId, stored.objectiveId, scenario);
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        assert.equal(restarted.deliveryEngine, 'legacy');
        assert.ok(restarted.concurrentEngine, 'persisted concurrent mappings still compose the real engine');
        assert.equal(restarted.orchestrator.mapping(stored.runId).engine, 'concurrent-v1');
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'new-legacy', goal: 'New legacy intake' });
        if (scenario.code) {
          await assert.rejects(intake, { code: scenario.code });
          assert.equal(restarted.orchestrator.mapping('new-legacy'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['new-legacy']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

test('durable legacy mappings block concurrent intake while independent projects remain usable', async (t) => {
  const first = await idleConcurrentServer(t, 'first');
  const second = await idleConcurrentServer(t, 'second');
  try {
    const taskStore = require('../src/durable-store').createTaskStore(first.runtime.state, 'orchestrator');
    await taskStore.save({ id: 'old-legacy', contextId: 'old-context', status: { state: TaskState.TASK_STATE_WORKING }, history: [], artifacts: [], metadata: {} }, call());
    first.runtime.state.db.prepare(`INSERT INTO delivery_run_engines(project_id,run_id,engine,request_json,created_at,updated_at)
      VALUES(?,'old-legacy','legacy','{}',1,1)`).run(first.runtime.projectId);
    await assert.rejects(first.runtime.orchestrator.run({ runId: 'blocked-concurrent', goal: 'Must wait' }), { code: 'delivery_engine_busy' });
    assert.equal(first.runtime.orchestrator.mapping('blocked-concurrent'), null);
    const result = await second.runtime.orchestrator.runLegacy({ runId: 'independent-legacy', goal: 'Independent workspace' });
    assert.equal(result.status, 'completed');
    assert.notEqual(first.runtime.projectId, second.runtime.projectId);
    assert.deepEqual(second.calls, ['independent-legacy']);
    assert.equal(first.runtime.orchestrator.mapping('independent-legacy'), null);
  } finally { await Promise.all([first.runtime.close(), second.runtime.close()]); }
});

test('restart refuses unknown stored engine selections without rewriting the durable mapping', async (t) => {
  const fixture = await idleConcurrentServer(t);
  seedConcurrentFence(fixture.runtime);
  fixture.runtime.state.db.prepare("UPDATE delivery_run_engines SET engine='unknown-engine'").run();
  await fixture.runtime.close();
  await assert.rejects(startServer(fixture.options), { code: 'delivery_engine_selection_unsafe' });
  const reopened = await openStateDatabase({ filePath: fixture.options.stateFile });
  try {
    assert.equal(reopened.db.prepare('SELECT engine FROM delivery_run_engines').get().engine, 'unknown-engine');
  } finally { await reopened.close(); }
});

function turnResult(options, text) {
  const roleId = options.role.id || options.role.name;
  const threadId = options.threadId || `${roleId}-thread`;
  const turnId = `turn-${roleId}`;
  const processIdentity = readProcessIdentity(process.pid);
  options.onTurnStart({ threadId, processIdentity });
  return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
    execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
}

test('default real server accepts a base candidate with empty owner checks', { timeout: 15000 }, async (t) => {
  const providerCalls = [];
  const fixture = await idleConcurrentServer(t, 'accepted', { async run(options) {
    const roleId = options.role.id || options.role.name;
    providerCalls.push(roleId);
    if (roleId === 'coordinator') {
      const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
      return turnResult(options, JSON.stringify({ expected: pins, delta: null, dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
    }
    const details = scopedExecutionDetails(options.deliveryCapability);
    assert.equal(details.verifyCandidate(), true);
    execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
    return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.', filesChanged: [], filesInspected: ['source.txt'],
      checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }], risks: [], scopeExpansion: [], decisionRequest: null }));
  } });
  const { runtime } = fixture;
  try {
    const result = await runtime.leadAgent.requestHandler.sendMessage({ message: message('Confirm the current source is acceptable.'), configuration: {} }, call());
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    const mapping = runtime.orchestrator.mapping(result.id);
    assert.equal(mapping.engine, 'concurrent-v1');
    assert.equal(runtime.concurrentEngine.getRunDigest(result.id).disposition, 'accepted');
    assert.ok(providerCalls.includes('coordinator'));
    assert.ok(providerCalls.includes('verifier'));
  } finally { await runtime.close(); }
});

test('owner full-access composes coordinator, scoped verifier, and candidate-bound final checks', { timeout: 20000 }, async (t) => {
  const permissionResolutions = [];
  const providerCalls = [];
  const fixture = await idleConcurrentServer(t, 'full-access-accepted', {
    async resolveExecutionPermissions(workspace, requested, options) {
      permissionResolutions.push({ workspace, requested, options });
      if (requested !== 'full-access') return { mode: 'strict', profileApi: false, reason: 'unexpected_mode' };
      return { mode: 'full-access', profileApi: true, writerProfile: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
    },
    async run(options) {
      const roleId = options.role.id || options.role.name;
      providerCalls.push(roleId);
      assert.equal(options.executionPermissions, 'full-access');
      assert.equal(options.permissionWorkspace, fixture.options.workspace);
      if (roleId === 'coordinator') {
        const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
        return turnResult(options, JSON.stringify({ expected: pins, delta: null,
          dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }));
      }
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.executionPermissions, 'full-access');
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.',
        filesChanged: [], filesInspected: ['source.txt'],
        checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }));
    },
  }, { executionPermissions: 'full-access' });
  const { runtime } = fixture;
  try {
    const request = runtime.leadAgent.requestHandler.sendMessage({ message: message('Confirm the current source is acceptable.', {
      metadata: { acceptance: { source: 'agent', requiredChecks: [{ id: 'verify-source', argv: ['node', 'verify-source.js'], timeoutMs: 5000 }] } },
    }), configuration: {} }, call());
    let timer;
    const result = await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(JSON.stringify({ providerCalls, permissionResolutions,
        runs: runtime.concurrentEngine.activeRuns(), mappings: runtime.orchestrator.mappings(),
        executions: runtime.concurrentEngine.roleService.projection(),
        objectives: runtime.concurrentEngine.store.listObjectives?.(runtime.projectId) || null,
        planner: runtime.state.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all() }))), 10000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    assert.equal(runtime.concurrentEngine.getRunDigest(result.id).disposition, 'accepted');
    assert.ok(providerCalls.includes('coordinator'));
    assert.ok(providerCalls.includes('verifier'));
    assert.ok(permissionResolutions.length >= 3);
    assert.ok(permissionResolutions.every(({ workspace, requested, options }) => workspace === fixture.options.workspace
      && requested === 'full-access' && options?.fresh === true));
    assert.ok(fixture.permissionCalls.length >= 1);
    assert.ok(fixture.permissionCalls.every((request) => request.permissionProfile === ':danger-full-access'));
    assert.ok(fixture.permissionCalls.every((request) => !Object.hasOwn(request, 'sandboxPolicy')));
  } finally {
    try { await runtime.close(); }
    catch (_) {
      runtime.httpServer?.closeAllConnections?.();
      if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      await runtime.appServer.close?.();
      if (runtime.state.db.open) await runtime.state.close();
    }
  }
});

test('legacy downgrade checks the exact durable planner session even without a controller fence', async (t) => {
  for (const scenario of [
    { name: 'unknown planner turn', status: 'unknown', unsafe: true },
    { name: 'active planner turn', status: 'active', unsafe: true },
    { name: 'unrecognized planner state', status: 'unrecognized', unsafe: true },
    { name: 'complete planner turn', status: 'complete' },
    { name: 'stale planner turn', status: 'stale' },
    { name: 'reconciled planner turn', status: 'reconciled_no_effect' },
    { name: 'unrelated session', status: 'unknown', unrelated: true },
    { name: 'foreign project same session', status: 'unknown', foreignProject: true },
    { name: 'missing mapping session', status: 'unknown', mappingSession: null, unsafe: true },
    { name: 'empty mapping session', status: 'unknown', mappingSession: '', unsafe: true },
    { name: 'missing mapping objective', status: 'unknown', missingObjective: true, unsafe: true },
    { name: 'corrupt run session', status: 'unknown', corruptRun: true, unsafe: true },
    { name: 'corrupt mapping session', status: 'unknown', mappingSession: 'wrong-session', unsafe: true },
    { name: 'corrupt objective session', status: 'unknown', corruptObjective: true, unsafe: true },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        seeded.db.exec(`CREATE TABLE delivery_planner_turns (
          project_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
          provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
          pins_json TEXT NOT NULL, result_json TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id,session_id,provider_thread_id,turn_id));`);
        seeded.db.prepare(`INSERT INTO delivery_planner_turns(project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,started_at,updated_at)
          VALUES(?,?,'fake-scope','fake-thread','fake-turn',?,'{}',1,1)`)
          .run(scenario.foreignProject ? 'ffffffffff' : fixture.runtime.projectId, scenario.unrelated ? 'other-session' : stored.sessionId, scenario.status);
        if (Object.hasOwn(scenario, 'mappingSession')) {
          seeded.db.prepare('UPDATE delivery_run_engines SET session_id=? WHERE run_id=?').run(scenario.mappingSession, stored.runId);
        }
        if (scenario.missingObjective) seeded.db.prepare('UPDATE delivery_run_engines SET objective_id=NULL WHERE run_id=?').run(stored.runId);
        if (scenario.corruptRun) seeded.db.prepare("UPDATE concurrent_delivery_runs SET session_id='wrong-session' WHERE run_id=?").run(stored.runId);
        if (scenario.corruptObjective) {
          const row = seeded.db.prepare('SELECT record_json FROM backlog_objectives WHERE objective_id=?').get(stored.objectiveId);
          seeded.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE objective_id=?')
            .run(JSON.stringify({ ...JSON.parse(row.record_json), sessionId: 'wrong-session' }), stored.objectiveId);
        }
        assert.equal(seeded.db.prepare('SELECT COUNT(*) AS n FROM concurrent_controller_fences').get().n, 0);
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'legacy-after-planner', goal: 'Use the changed default' });
        if (scenario.unsafe) {
          await assert.rejects(intake, { code: 'delivery_engine_unsafe' });
          assert.equal(restarted.orchestrator.mapping('legacy-after-planner'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['legacy-after-planner']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
        const ledger = restarted.state.db.prepare('SELECT session_id,status FROM delivery_planner_turns').get();
        assert.equal(ledger.session_id, scenario.unrelated ? 'other-session' : stored.sessionId);
        assert.equal(ledger.status, scenario.status);
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

function seedAuthoritativeEffects(db, projectId, stored, scenario) {
  if (scenario.intentState) {
    const index = scenario.intentIndex || 0;
    const intentId = `intent-${index}`;
    const existing = db.prepare('SELECT intent_id FROM candidate_intents WHERE intent_id=?').get(intentId);
    if (existing) {
      db.prepare('UPDATE candidate_intents SET state=? WHERE intent_id=?').run(scenario.intentState, intentId);
    } else {
      // Use real CandidateStore candidates and frozen manifests for terminal intent fixtures.
      const candidate = db.prepare('SELECT * FROM candidates WHERE candidate_id=?').get(`candidate-next-${index}`);
      const base = db.prepare("SELECT * FROM candidates WHERE candidate_id='candidate-base'").get();
      const before = db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(base.manifest_digest);
      const expected = db.prepare('SELECT manifest_json FROM candidate_snapshots WHERE digest=?').get(candidate.manifest_digest);
      db.prepare(`INSERT INTO candidate_intents(intent_id,project_id,objective_id,candidate_id,base_candidate_id,attempt_id,
        parent_candidate_id,integration_generation,environment_digest,check_identity,content_manifest_digest,
        before_manifest_json,expected_manifest_json,delta_paths_json,controls_json,admission_json,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','{}','{}',?,'now','now')`)
        .run(intentId, projectId, stored.objectiveId, candidate.candidate_id, base.candidate_id, candidate.source_attempt_id,
          candidate.parent_candidate_id, candidate.integration_generation, candidate.environment_digest, candidate.check_identity,
          candidate.manifest_digest, before.manifest_json, expected.manifest_json, scenario.intentState);
    }
  }
  if (scenario.roleState) {
    const record = { projectId, objectiveId: stored.objectiveId, attemptId: 'role-attempt', taskId: 'role-task',
      state: scenario.roleState, effectsSettled: scenario.effectsSettled };
    db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,provider_context_id,
      external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at)
      VALUES('role-attempt',?,?,'role-task',1,'role-context','role-external','engineer','request','settings',?,?,'now','now')`)
      .run(projectId, stored.objectiveId, scenario.roleState, JSON.stringify(record));
  }
}

test('legacy downgrade fences authoritative effect records independently of settled publication caches', async (t) => {
  for (const scenario of [
    { name: 'unknown candidate intent', intentState: 'unknown', unsafe: true },
    { name: 'prepared candidate intent', intentState: 'prepared', unsafe: true },
    { name: 'applying candidate intent', intentState: 'applying', unsafe: true },
    { name: 'settling candidate intent', intentState: 'settling', unsafe: true },
    { name: 'refused candidate intent', intentState: 'refused' },
    { name: 'not-applied candidate intent', intentState: 'not_applied' },
    { name: 'unknown role execution', roleState: 'unknown', effectsSettled: false, unsafe: true },
    { name: 'terminal role effects unknown', roleState: 'terminal', effectsSettled: false, unsafe: true },
    { name: 'terminal role effects missing', roleState: 'terminal', unsafe: true },
    { name: 'settled role effects', roleState: 'settled', effectsSettled: true },
    { name: 'terminal role effects', roleState: 'terminal', effectsSettled: true },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        seedConcurrentEffects(seeded.db, fixture.runtime.projectId, stored.objectiveId, { publicationStates: ['applied'] });
        seedAuthoritativeEffects(seeded.db, fixture.runtime.projectId, stored, scenario);
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'legacy-after-effects', goal: 'Use the changed default' });
        if (scenario.unsafe) {
          await assert.rejects(intake, { code: 'delivery_engine_unsafe' });
          assert.equal(restarted.orchestrator.mapping('legacy-after-effects'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['legacy-after-effects']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
        assert.equal(restarted.state.db.prepare('SELECT state FROM delivery_output_publications').get().state, 'applied');
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

test('settled publication observations require matching authoritative intent identity', async (t) => {
  for (const scenario of [
    { name: 'applied cache missing intent', cacheState: 'applied', missing: true, unsafe: true },
    { name: 'not-applied cache missing intent', cacheState: 'not_applied', missing: true, unsafe: true },
    { name: 'applied intent wrong project', cacheState: 'applied', wrongProject: true, unsafe: true },
    { name: 'applied intent wrong objective', cacheState: 'applied', wrongObjective: true, unsafe: true },
    { name: 'applied intent wrong ID', cacheState: 'applied', wrongId: true, unsafe: true },
    { name: 'matching applied intent', cacheState: 'applied' },
    { name: 'matching not-applied intent', cacheState: 'not_applied' },
    { name: 'refused cache without intent', cacheState: 'refused' },
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await idleConcurrentServer(t);
      const stored = seedConcurrentFence(fixture.runtime);
      await fixture.runtime.close();
      const seeded = await openStateDatabase({ filePath: fixture.options.stateFile });
      try {
        seedConcurrentEffects(seeded.db, fixture.runtime.projectId, stored.objectiveId, { publicationStates: [scenario.cacheState] });
        if (scenario.missing) seeded.db.prepare("DELETE FROM candidate_intents WHERE intent_id='intent-0'").run();
        if (scenario.wrongProject) seeded.db.prepare("UPDATE candidate_intents SET project_id='ffffffffff' WHERE intent_id='intent-0'").run();
        if (scenario.wrongObjective) seeded.db.prepare("UPDATE candidate_intents SET objective_id='other-objective' WHERE intent_id='intent-0'").run();
        if (scenario.wrongId) seeded.db.prepare("UPDATE candidate_intents SET intent_id='other-intent' WHERE intent_id='intent-0'").run();
      } finally { await seeded.close(); }
      fs.writeFileSync(fixture.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
      const restarted = await startServer(fixture.options);
      try {
        const before = restarted.orchestrator.mapping(stored.runId);
        const intake = restarted.orchestrator.run({ runId: 'legacy-after-publication', goal: 'Use the changed default' });
        if (scenario.unsafe) {
          await assert.rejects(intake, { code: 'delivery_engine_unsafe' });
          assert.equal(restarted.orchestrator.mapping('legacy-after-publication'), null);
          assert.deepEqual(fixture.calls, []);
        } else {
          assert.equal((await intake).status, 'completed');
          assert.deepEqual(fixture.calls, ['legacy-after-publication']);
        }
        assert.deepEqual(restarted.orchestrator.mapping(stored.runId), before);
      } finally { await cleanupSeededRecoveryFixture(restarted); }
    });
  }
});

for (const delayedClose of [false, true]) test(`cooperative held lost acknowledgement retries staged close after original provider group death with ${delayedClose ? 'late' : 'immediate'} provider close`, { timeout: 30000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const { CodexAppServer } = require('../src/codex-app-server');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const producingIdentity = readProcessIdentity(child.pid);
  const cleanup = Object.create(CodexAppServer.prototype);
  cleanup.generation = 1; cleanup.child = child; cleanup.childExited = false;
  cleanup.currentChildState = { child, identity: producingIdentity, generation: 1, failed: false, exited: false };
  cleanup.readProcessIdentityImpl = readProcessIdentity;
  cleanup._request = async () => ({});
  const entered = deferred(); const release = deferred(); const providerClosed = deferred(); const abort = new AbortController();
  let workerCalls = 0; let closeCalls = 0; let fx;
  t.after(async () => { release.resolve(); providerClosed.resolve(); if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
  } });
  fx = await idleConcurrentServer(t, 'terminal-retry', {
    processIdentity: () => producingIdentity,
    async close() { closeCalls += 1; if (delayedClose) await providerClosed.promise; },
    async run(options) {
      const threadId = options.threadId || 'terminal-worker'; const turnId = `turn-${options.role.id}`;
      options.onTurnStart({ threadId, processIdentity: producingIdentity });
      let text;
      if ((options.role.id || options.role.name) === 'coordinator') {
        const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
        const task = { schemaVersion: 'delivery/v1', projectId: fx.runtime.projectId,
          objectiveId: fx.runtime.orchestrator.objectiveIdFor('terminal-retry'), taskId: 'terminal-worker', revision: 1,
          role: 'engineer', kind: 'implementation', objective: 'Retain terminal evidence.', priority: 0, dependencies: [],
          productWritePaths: ['worker.txt'], readScope: { kind: 'unknown', paths: null, reason: 'Test scope.' },
          scratchWriteRoots: [], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' };
        text = JSON.stringify({ expected: prompt.pins, delta: prompt.pins.planRevision === 0 ? { schemaVersion: 'delivery/v1',
          expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision,
          expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision,
          nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task }], dependencies: [] } : null,
          dialogue: 'Execute the worker.', recovery: null, ownerDecision: null });
      } else {
        workerCalls += 1;
        fs.writeFileSync(path.join(options.cwd, 'worker.txt'), 'private output\n');
        fs.writeFileSync(path.join(fx.options.workspace, 'source.txt'), 'shared drift\n');
        entered.resolve(); await release.promise;
        text = JSON.stringify({ outcome: 'completed', summary: 'Original terminal report.', filesChanged: ['worker.txt'],
          filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
      }
      const ctx = { generation: 1, childState: cleanup.currentChildState, processIdentity: producingIdentity };
      await cleanup._cleanupTerminal({ terminal: true, ctx, threadId, turnId });
      return { status: 'completed', text, threadId, turnId, execution: { generation: 1, processIdentity: producingIdentity,
        threadId, turnId, turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupReceipt: ctx.cleanupReceipt } };
    },
  });
  const { runtime } = fx;
  t.after(async () => {
    release.resolve();
    try { await runtime.close(); } catch (_) {
      runtime.httpServer.closeAllConnections();
      if (runtime.httpServer.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
      if (runtime.state.db.open) await runtime.state.close();
    }
  });
  const running = runtime.orchestrator.run({ runId: 'terminal-retry', goal: 'Retain private failure evidence.',
    contract: { requiredChecks: [] }, signal: abort.signal });
  await entered.promise; abort.abort(); await running;
  await assert.rejects(runtime.close(), { code: 'concurrent_shutdown_unsafe' });
  assert.equal(closeCalls, 0, 'provider close must wait for held invocation');
  assert.equal(runtime.state.db.open, true);
  assert.throws(() => acquireWorkspaceLock(fx.options.workspace, { lockDir: fx.options.workspaceLockDir }), /in use/i);
  await assert.rejects(runtime.concurrentEngine.resume({ runId: 'terminal-retry' }), { code: 'concurrent_shutdown_admission_closed' });
  // The caller's bound can expire just before the held drain rejects internally.
  const retainedPreparation = runtime.concurrentEngine.shutdownPreparation;
  if (retainedPreparation) await assert.rejects(retainedPreparation, { code: 'concurrent_shutdown_unsafe' });
  release.resolve();
  await waitFor(() => !runtime.concurrentEngine.roleService.active.size, 'held invocation did not finish');
  const pending = runtime.close();
  const overlapping = runtime.close();
  const outcomes = Promise.allSettled([pending, overlapping]);
  await waitFor(() => closeCalls > 0, 'provider close not called');
  assert.equal(runtime.state.db.open, true, 'close acknowledgement alone must retain ownership');
  const phase = JSON.parse(runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json);
  assert.deepEqual(phase.identities, [producingIdentity]);
  const timedOut = await outcomes;
  assert.ok(timedOut.every((result) => result.status === 'rejected'));
  assert.equal(runtime.state.db.open, true, 'caller timeout must retain state ownership');
  assert.equal(closeCalls, 1, 'overlapping timed-out callers must share provider close');
  if (delayedClose) {
    providerClosed.resolve();
    const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
    await waitFor(() => JSON.parse(runtime.state.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase === 'released',
      'late internal shutdown did not finish after caller timeout');
    assert.equal(runtime.state.db.open, true, 'internal completion awaits caller retry before releasing host ownership');
    assert.equal(closeCalls, 1);
  } else {
    const exit = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
  }
  // The internal bounded group observer may finish just after its caller timeout.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await runtime.close();
  await runtime.close();
  assert.equal(workerCalls, 1); assert.equal(closeCalls, 1);
  const reopened = await openStateDatabase({ filePath: fx.options.stateFile });
  assert.equal(JSON.parse(reopened.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'released');
  const attempt = JSON.parse(reopened.db.prepare('SELECT record_json FROM backlog_attempts').get().record_json);
  const record = JSON.parse(reopened.db.prepare('SELECT record_json FROM delivery_role_executions').get().record_json);
  assert.ok(['failed', 'canceled'].includes(attempt.state));
  assert.equal(record.result.output.state, 'not_published');
  assert.equal(record.report.summary, 'Original terminal report.');
  assert.equal(record.terminalShutdown.drift.changed, true);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM delivery_output_publications').get().n, 0);
  assert.equal(fs.readFileSync(path.join(fx.options.workspace, 'source.txt'), 'utf8'), 'shared drift\n');
  await reopened.close();
  const unlock = acquireWorkspaceLock(fx.options.workspace, { lockDir: fx.options.workspaceLockDir }); unlock();
  fs.writeFileSync(fx.settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'legacy' }));
  const legacy = await startServer(fx.options);
  try {
    assert.equal(legacy.orchestrator.mapping('terminal-retry').engine, 'concurrent-v1');
    assert.equal((await legacy.orchestrator.run({ runId: 'fresh-after-terminal', goal: 'Use the selected legacy engine.' })).status, 'completed');
    assert.equal(legacy.orchestrator.mapping('fresh-after-terminal').engine, 'legacy');
    assert.deepEqual(JSON.parse(legacy.state.db.prepare('SELECT record_json FROM backlog_attempts').get().record_json), attempt);
    assert.deepEqual(JSON.parse(legacy.state.db.prepare('SELECT record_json FROM delivery_role_executions').get().record_json), record);
    assert.equal(workerCalls, 1);
  } finally { await legacy.close(); }
});

test('released shutdown phase permits fresh host intake on the same workspace and database', { timeout: 15000 }, async (t) => {
  const fx = await idleConcurrentServer(t, 'released-reopen', { async run(options) {
    if ((options.role.id || options.role.name) === 'coordinator') {
      const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
      return turnResult(options, JSON.stringify({ expected: pins, delta: null, dialogue: 'Review the candidate.', recovery: null, ownerDecision: null }));
    }
    const details = scopedExecutionDetails(options.deliveryCapability);
    execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
    return turnResult(options, JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate accepted.', filesChanged: [],
      filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }],
      risks: [], scopeExpansion: [], decisionRequest: null }));
  } });
  await fx.runtime.close();
  const reopened = await startServer(fx.options);
  try {
    assert.equal(reopened.concurrentEngine.shutdownRequested, false);
    const result = await reopened.leadAgent.requestHandler.sendMessage({ message: message('Accept the unchanged candidate.'), configuration: {} }, call());
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    assert.equal(reopened.concurrentEngine.getRunDigest(result.id).disposition, 'accepted');
  } finally { await reopened.close(); }
});
