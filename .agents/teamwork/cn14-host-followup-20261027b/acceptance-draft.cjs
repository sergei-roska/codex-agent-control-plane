'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { TaskState } = require('@a2a-js/sdk');
const { startServer, projectIdForWorkspace } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/server');
const { LeadOrchestrator } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/lead-orchestrator');
const { openStateDatabase, acquireWorkspaceLock } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/durable-store');
const { readProcessIdentity } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/process-quiescence');
const { scopedExecutionDetails } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-role-capabilities');

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

async function idleConcurrentServer(t, name = 'project', provider = {}) {
  const root = tempDir(t);
  const workspace = path.join(root, name);
  const settingsFile = path.join(root, 'settings.json');
  const roleOverridesFile = path.join(root, 'roles.json');
  createGitWorkspace(workspace);
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: { coordinator: { model: 'test-model', effort: 'low', fastMode: 'off' }, verifier: { model: 'test-model', effort: 'low', fastMode: 'off' } } }));
  const calls = [];
  fs.mkdirSync(path.join(root, 'fake-home'));
  const identity = { accountId: 'fake-account', codexHome: path.join(root, 'fake-home') };
  const options = { listen: true, port: 0, workspace, stateFile: path.join(root, 'state.sqlite'),
    tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'workspace-locks'),
    deliveryStorageRoot: path.join(root, 'delivery-storage'), projectSettingsFile: settingsFile, roleOverridesFile,
    autoResume: false, appServer: appServer({
      getVersion: () => 'server-delivery-test/1',
      async execCommand({ command, cwd }) {
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
    orchestratorFactory: () => ({
      async run(input) { calls.push(input.runId); return { status: 'completed', text: 'legacy result' }; },
      async resume() { return { status: 'completed' }; },
    }),
  };
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  const runtime = await startServer(options);
  t.after(() => runtime.close());
  return { runtime, root, options, calls, settingsFile };
}


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
test('default real server retains ownership during unsafe close and releases it after a safe retry', { timeout: 20000 }, async (t) => {
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
    resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
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
    ignoreWorkerAbort = true;
    await assert.rejects(runtime.close(), (error) => ['server_shutdown_drain_unsafe', 'concurrent_shutdown_unsafe'].includes(error.code));
    assert.equal(runtime.state.db.open, true);
    assert.throws(() => acquireWorkspaceLock(workspace, { lockDir: path.join(root, 'workspace-locks') }), /workspace .* is in use/i);
    releaseWorker.resolve();
    ignoreWorkerAbort = false;
    try { await runtime.close(); }
    catch (error) {
      console.error(JSON.stringify({ error: { code: error.code, projections: error.projections },
        roles: runtime.concurrentEngine.roleService.projection(),
        attempts: runtime.state.db.prepare('SELECT record_json,release_facts_json FROM backlog_attempts').all(),
        claims: runtime.state.db.prepare('SELECT record_json FROM backlog_claims').all(),
        evidence: runtime.state.db.prepare('SELECT kind,detail_json FROM task_executor_evidence').all() }, null, 2));
      throw error;
    }
    await request;
    assert.equal(runtime.state.db.open, false);
    const release = acquireWorkspaceLock(workspace, { lockDir: path.join(root, 'workspace-locks') });
    release();
    const reopened = await openStateDatabase({ filePath: stateFile });
    try {
      assert.equal(reopened.db.prepare('SELECT engine FROM delivery_run_engines WHERE run_id=?').get(runId).engine, 'concurrent-v1');
    } finally { await reopened.close(); }
  } finally {
    releaseLead.resolve();
    releaseWorker.resolve();
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

