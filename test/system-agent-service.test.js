'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { checkSpecialistRequest } = require('../src/contracts');
const { openStateDatabase, InMemoryDispatchJournal } = require('../src/durable-store');
const { UsageLedger } = require('../src/usage-ledger');
const { loadRoles, loadSystemRole } = require('../src/role-catalog');
const { SYSTEM_REPAIR_CHECKS, SYSTEM_REPAIR_SCOPE, createSystemRepairClient } = require('../src/system-repair-client');
const { createSystemAgentService, normalizeRpcBody, normalizeSystemRequest, systemSourceManifest } = require('../src/system-agent-service');
const { startServer } = require('../src/server');
const { createLauncherApp } = require('../src/launcher-app');
const { createProjectManager } = require('../src/launcher-projects');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = crypto.randomBytes(32).toString('base64url');
const request = {
  incidentId: 'system-incident-1',
  question: 'Repair the bounded controller defect.',
  evidence: ['src/lead-graph.js: evidence from the failing transition'],
  relatedDecisionIds: ['run-1:r1:a0'],
  projectContext: { goal: 'Preserve the owner pause.', evidence: ['Read-only target evidence.'] },
};

function envelope(overrides = {}) {
  return {
    protocol: 'system-repair-request/v1',
    request: { incidentId: request.incidentId, question: request.question, evidence: request.evidence, relatedDecisionIds: request.relatedDecisionIds, ...overrides.request },
    serviceScope: [...SYSTEM_REPAIR_SCOPE],
    serviceChecks: [...SYSTEM_REPAIR_CHECKS],
    projectContext: { ...request.projectContext, ...overrides.projectContext },
  };
}

function report(overrides = {}) {
  return JSON.stringify({
    outcome: "completed",
    summary: "Controller repair is complete.",
    filesChanged: [],
    filesInspected: ["src/lead-graph.js"],
    checks: SYSTEM_REPAIR_CHECKS.map((command) => ({ command, result: "passed", detail: "Passed in the controller workspace." })),
    risks: [],
    scopeExpansion: [],
    decisionRequest: null,
    ...overrides,
  });
}

async function serviceFixture({ mode = "worktree", laneAvailable = true, beforeRun = async () => {}, reportText = null, createAppServer: appServerFactory = null, createState: stateFactory = null, runtimeIdentity = null } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-agent-service-'));
  let app = (_req, res) => res.status(503).end();
  const httpServer = http.createServer((req, res) => app(req, res));
  await new Promise((resolve, reject) => httpServer.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const endpoint = `http://127.0.0.1:${httpServer.address().port}/agents/chuck-norris`;
  const stateful = { runs: [], active: 0, maxActive: 0, closes: 0, state: null, laneCompletions: [], preparedLanes: [], sharedPath: path.join(temp, "shared/src/repair.js") };
  const service = createSystemAgentService({
    repoDir: ROOT,
    runtimeDir: path.join(temp, 'runtime'),
    endpoint,
    token: TOKEN,
    runtimeIdentity: runtimeIdentity || {
      captureProfileSource() {},
      get snapshot() {
        return {
          pid: process.pid, moduleLoadedAt: '2026-10-14T00:00:00.000Z', startupGitRevision: 'test',
          sourceHashes: {}, profileHashes: {
            'profiles/system/chuck-norris.toml': crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'profiles/system/chuck-norris.toml'))).digest('hex'),
            'profiles/TEAM.md': crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'profiles/TEAM.md'))).digest('hex'),
          }, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [],
        };
      },
    },
    workspaceLockDir: path.join(temp, 'locks'),
    createState: async () => { stateful.state = await (stateFactory ? stateFactory(stateful) : openStateDatabase({ filePath: ':memory:' })); return stateful.state; },
    createAccountProfiles: () => ({ activeHome: () => null }),
    createAppServer: appServerFactory || (() => ({
      async start() {},
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async close() { stateful.closes += 1; },
      async run(options) {
        stateful.active += 1;
        stateful.maxActive = Math.max(stateful.maxActive, stateful.active);
        stateful.runs.push(options);
        try { await beforeRun(options); } finally { stateful.active -= 1; }
        return { threadId: "fake-thread", status: "completed", text: reportText || report() };
      },
    })),
    selectIsolation: async () => ({
      mode, reason: mode === 'worktree' ? null : 'isolation_unavailable', lanesRoot: path.join(temp, 'lanes'),
      links: [], networkAccess: false, probe: { ok: mode === 'worktree', version: 'fake-v1' },
    }),
    createLaneManager: ({ workspace, admission }) => ({
      workspace,
      admission,
      async available() { return laneAvailable && mode === 'worktree'; },
      recover() { return { orphaned: [], integrated: [], notIntegrated: [], removed: [], failed: [] }; },
      async prepare({ contextId, taskId }) {
        const candidatePath = path.join(temp, `candidate-${taskId}`);
        fs.mkdirSync(candidatePath, { recursive: true });
        const lane = { id: `fake-${taskId}`, path: candidatePath, workspacePath: candidatePath, base: "fake-base", linked: [] };
        stateful.preparedLanes.push(lane);
        return { lane };
      },
      laneInput(_lane, input) { return input; },
      sandboxPolicy() { return { type: 'workspaceWrite', writableRoots: ['/disposable/chuck-lane'] }; },
      markRunning() {},
      recordTurnStart() {},
      async complete({ lane, integrate, reason }) {
        stateful.laneCompletions.push({ integrate, reason });
        const candidate = path.join(lane.path, "src/repair.js");
        if (integrate && fs.existsSync(candidate)) {
          fs.mkdirSync(path.dirname(stateful.sharedPath), { recursive: true });
          fs.copyFileSync(candidate, stateful.sharedPath);
        }
        return { canceled: reason === "canceled", writerExecution: {
          executionId: integrate ? "fake-execution" : null, state: integrate ? "released" : null, reason: integrate ? null : reason, effects: "none",
          delta: integrate ? { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: "test" } : null,
          lane: { id: lane.id, state: integrate ? "integrated" : "not_integrated", reason: integrate ? null : reason, attemptedPaths: [] },
        } };
      },
      abandon(lane) { return { executionId: null, state: null, delta: null, reason: null, effects: 'none', lane: { ...lane, state: 'not_integrated' } }; },
    }),
  });
  const application = express();
  application.use(express.json());
  application.use('/api', (_req, res) => res.json({ ok: true }));
  application.use(service.router);
  app = application;
  const url = endpoint.slice(0, -'/agents/chuck-norris'.length);
  return {
    endpoint,
    url,
    temp,
    service,
    stateful,
    async close() {
      await service.close();
      await new Promise((resolve) => httpServer.close(resolve));
      fs.rmSync(temp, { recursive: true, force: true });
    },
  };
}

function repairFor(endpoint) {
  return createSystemRepairClient({
    endpoint,
    authToken: TOKEN,
    journal: new InMemoryDispatchJournal(),
    pollIntervalMs: 0,
    cancelTimeoutMs: 0,
    clientFactory: {
      createFromAgentCard: (card) => new ClientFactory().createFromAgentCard(card),
    },
  });
}

test('system profile is independently parsed and never appears in the project role catalog', () => {
  const loadedFiles = new Map();
  const roles = loadRoles({ onSourceFile: (file, source) => loadedFiles.set(path.relative(ROOT, file).split(path.sep).join('/'), source) });
  const systemRole = loadSystemRole({ profilePath: path.join(ROOT, 'profiles/system/chuck-norris.toml') });
  assert.equal(roles.has('chuck-norris'), false);
  assert.equal(loadedFiles.has('profiles/TEAM.md'), true);
  assert.ok([...loadedFiles.keys()].some((file) => file.startsWith('profiles/agents/')));
  assert.equal(systemRole.name, 'chuck-norris');
  assert.equal(systemRole.displayName, 'Chuck Norris');
  assert.equal(systemRole.model, 'gpt-6.1-sol');
  assert.equal(systemRole.effort, 'high');
  assert.equal(systemRole.sandbox, 'workspace-write');
  assert.deepEqual(systemRole.tools, { mcpServers: [], skills: false });
  assert.match(systemRole.instructions, /record that required reload in risks/);
});

test('system request normalization produces a valid standard specialist request in the fixed scope', () => {
  const normalized = JSON.parse(normalizeSystemRequest(JSON.stringify(envelope()), SYSTEM_REPAIR_SCOPE, SYSTEM_REPAIR_CHECKS));
  const checked = checkSpecialistRequest(normalized, { id: 'chuck-norris', name: 'chuck-norris', sandbox: 'workspace-write' }, { workspace: ROOT });
  assert.deepEqual(checked.allowedFiles, SYSTEM_REPAIR_SCOPE);
  assert.deepEqual(checked.checks, SYSTEM_REPAIR_CHECKS);
  assert.match(checked.objective, /Repair the bounded controller defect/);
  assert.ok(checked.inputs.some((item) => item.includes('Read-only project context')));
  for (const method of ['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']) {
    const body = { jsonrpc: '2.0', id: 'request-1', method, params: { message: { parts: [{ text: JSON.stringify(envelope()) }] } } };
    normalizeRpcBody(body, SYSTEM_REPAIR_SCOPE, SYSTEM_REPAIR_CHECKS);
    assert.ok(['SendMessage', 'SendStreamingMessage'].includes(body.method));
    checkSpecialistRequest(JSON.parse(body.params.message.parts[0].text), { id: 'chuck-norris', name: 'chuck-norris', sandbox: 'workspace-write' }, { workspace: ROOT });
  }
  const protobufBody = { jsonrpc: '2.0', id: 'request-2', method: 'SendMessage', params: { message: { parts: [{ content: { $case: 'text', value: JSON.stringify(envelope()) } }] } } };
  normalizeRpcBody(protobufBody, SYSTEM_REPAIR_SCOPE, SYSTEM_REPAIR_CHECKS);
  assert.ok(JSON.parse(protobufBody.params.message.parts[0].content.value).allowedFiles);
});

test('normalization rejects free text, sender scope, changed service scope, and malformed envelopes', () => {
  for (const value of [
    'please fix the system',
    JSON.stringify({ ...envelope(), serviceScope: ['.'] }),
    JSON.stringify({ ...envelope(), serviceChecks: ['npm test'] }),
    JSON.stringify({ ...envelope(), projectContext: { ...request.projectContext, workspace: '/tmp/foreign' } }),
    JSON.stringify({ ...envelope(), request: { incidentId: request.incidentId, question: request.question, evidence: request.evidence, relatedDecisionIds: request.relatedDecisionIds, allowedFiles: ['.'] } }),
    JSON.stringify({ ...envelope(), request: { incidentId: request.incidentId, question: 'x'.repeat(3001), evidence: request.evidence, relatedDecisionIds: request.relatedDecisionIds } }),
  ]) {
    assert.throws(() => normalizeSystemRequest(value, SYSTEM_REPAIR_SCOPE, SYSTEM_REPAIR_CHECKS));
  }
  for (const method of ['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']) {
    const body = { jsonrpc: '2.0', id: 1, method, params: { message: { parts: [{ text: 'free text' }] } } };
    assert.throws(() => normalizeRpcBody(body, SYSTEM_REPAIR_SCOPE, SYSTEM_REPAIR_CHECKS));
  }
});

test('authenticated runtime identity is available without initializing the service and records loaded system profiles', async () => {
  const profileHashes = {};
  const identity = {
    captureProfileSource(file, source) {
      profileHashes[path.relative(ROOT, file).split(path.sep).join('/')] = crypto.createHash('sha256').update(source).digest('hex');
    },
    get snapshot() { return { pid: 42, moduleLoadedAt: '2026-10-14T00:00:00.000Z', startupGitRevision: 'fake-revision', sourceHashes: { 'launcher.js': 'a'.repeat(64) }, profileHashes, uncapturedSourceFiles: [] }; },
  };
  const fixture = await serviceFixture({ runtimeIdentity: identity });
  try {
    const unauthorized = await fetch(fixture.endpoint + '/runtime');
    assert.equal(unauthorized.status, 401);
    const response = await fetch(fixture.endpoint + '/runtime', { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.schema, 'system-agent-runtime-identity/v1');
    assert.equal(value.sourceHashes['launcher.js'], 'a'.repeat(64));
    assert.equal(value.profileHashes['profiles/system/chuck-norris.toml'], crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'profiles/system/chuck-norris.toml'))).digest('hex'));
    assert.equal(value.profileHashes['profiles/TEAM.md'], crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'profiles/TEAM.md'))).digest('hex'));
    assert.equal(fixture.service.descriptor().status, 'lazy');
  } finally { await fixture.close(); }
});

test('public discovery is side-effect free and bad/project bearer tokens cannot initialize the service', async () => {
  const fixture = await serviceFixture();
  try {
    const discovery = await fetch(fixture.endpoint + '/agent-card.json');
    assert.equal(discovery.status, 200);
    const card = await discovery.json();
    const identity = card.capabilities.extensions.find((item) => item.uri === 'urn:codex:system-profile-identity:v1');
    assert.match(identity.description, /^sha256=[a-f0-9]{64}$/);
    assert.equal(fixture.service.descriptor().status, 'lazy');
    const body = { jsonrpc: '2.0', id: 'unauth', method: 'SendMessage', params: { message: { parts: [{ text: JSON.stringify(envelope()) }] } } };
    const unauthorized = await fetch(fixture.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(unauthorized.status, 401);
    const projectToken = crypto.randomBytes(32).toString('base64url');
    const wrong = await fetch(fixture.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${projectToken}` }, body: JSON.stringify(body) });
    assert.equal(wrong.status, 401);
    const freeTextBody = { ...body, params: { message: { parts: [{ text: 'free text' }] } } };
    const malformed = await fetch(fixture.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'A2A-Version': '1.0' }, body: JSON.stringify(freeTextBody) });
    assert.equal(malformed.status, 400, JSON.stringify(await malformed.clone().json()));
    assert.equal(fixture.service.descriptor().status, 'lazy');
    assert.equal(fixture.stateful.runs.length, 0);
  } finally { await fixture.close(); }
});

test('real SDK client and handler run in an isolated lane and return authoritative metadata', async () => {
  const fixture = await serviceFixture();
  try {
    const repair = repairFor(fixture.endpoint);
    const result = await repair(request, { runId: 'run-1', requestId: 'run-1:system:1', contextId: 'project-context', workspace: '/tmp/read-only-project' });
    const taskRow = fixture.stateful.state.db.prepare('SELECT artifacts FROM tasks WHERE owner = ? AND id = ?').get('chuck-norris', result.taskId);
    const storedArtifact = JSON.parse(taskRow.artifacts)[0];
    assert.deepEqual(storedArtifact.metadata.systemSourceManifest, result.systemSourceManifest);
    assert.equal(result.status, 'completed', JSON.stringify({ result, artifacts: taskRow?.artifacts }));
    assert.equal(result.writerExecution.state, 'released');
    assert.equal(result.writerExecution.lane.state, 'integrated');
    assert.equal(result.delta.known, true);
    assert.deepEqual(result.systemSourceManifest, { schema: 'system-source-manifest/v1', known: true, files: [] });
    assert.equal(fixture.stateful.runs.length, 1);
    assert.equal(fixture.stateful.runs[0].cwd, fixture.stateful.preparedLanes[0].path);
    assert.equal(fixture.stateful.runs[0].role.id, 'chuck-norris');
    assert.deepEqual(fixture.stateful.runs[0].role.allowedFiles, undefined);
    assert.equal(fixture.service.descriptor().workspace, fs.realpathSync(ROOT));
    assert.equal(fixture.service.descriptor().status, 'ready');
  } finally { await fixture.close(); }
});

test("system repair keeps failed report candidates isolated", async () => {
  const decisionRequest = {
    question: "Which repair should proceed?",
    options: [{ id: "repair", description: "Apply the repair." }, { id: "defer", description: "Defer the repair." }],
    evidenceChecked: ["Read the bounded evidence."],
    recommendation: "repair",
    consequenceIfWrong: "The repair may need another review.",
  };
  const cases = [
    { label: "failed outcome", overrides: { outcome: "failed", checks: SYSTEM_REPAIR_CHECKS.map((command) => ({ command, result: "failed", detail: "Failed." })) } },
    { label: "failed required check", overrides: { checks: SYSTEM_REPAIR_CHECKS.map((command, index) => ({ command, result: index === 0 ? "failed" : "passed", detail: "Recorded." })) } },
    { label: "pending decision", overrides: { outcome: "needs_decision", decisionRequest } },
    { label: "scope expansion", overrides: { scopeExpansion: [{ path: "src/extra.js", reason: "Needs a second change." }] } },
    { label: "reported scope violation", overrides: { filesChanged: ["outside.js"] } },
  ];
  for (const [index, item] of cases.entries()) {
    const fixture = await serviceFixture({
      reportText: report(item.overrides),
      beforeRun: async (options) => {
        fs.mkdirSync(path.join(options.cwd, "src"), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, "src/repair.js"), "candidate source");
      },
    });
    try {
      const repair = repairFor(fixture.endpoint);
      const result = await repair({ ...request, incidentId: `invalid-report-${index}` }, {
        runId: `invalid-report-run-${index}`, requestId: `invalid-report-run-${index}:system:1`, contextId: `invalid-report-context-${index}`,
      });
      assert.equal(fixture.stateful.laneCompletions.length, 1, item.label);
      assert.equal(fixture.stateful.laneCompletions[0].integrate, false, item.label);
      assert.equal(fixture.stateful.laneCompletions[0].reason, "system_report_not_integrable", item.label);
      const row = fixture.stateful.state.db.prepare("SELECT artifacts FROM tasks WHERE owner = ? AND id = ?").get("chuck-norris", result.taskId);
      const artifact = JSON.parse(row.artifacts)[0];
      assert.equal(artifact.metadata.writerExecution.lane.state, "not_integrated", item.label);
      assert.equal(artifact.metadata.writerExecution.lane.reason, "system_report_not_integrable", item.label);
      assert.notEqual(result.status, "completed", item.label);
      assert.equal(fs.existsSync(fixture.stateful.sharedPath), false, item.label);
      assert.equal(fs.readFileSync(path.join(fixture.stateful.preparedLanes[0].path, "src/repair.js"), "utf8"), "candidate source", item.label);
    } finally { await fixture.close(); }
  }
});

test('shared or downgraded lane mode refuses the writable turn before calling the fake model', async () => {
  const fixture = await serviceFixture({ mode: 'shared' });
  try {
    const repair = repairFor(fixture.endpoint);
    const result = await repair(request, { runId: 'run-2', requestId: 'run-2:system:1', contextId: 'project-context-2', workspace: '/tmp/read-only-project' });
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(fixture.stateful.runs.length, 0);
  } finally { await fixture.close(); }
});

test('distinct repair requests serialize their complete model turns', async () => {
  const fixture = await serviceFixture({ beforeRun: async () => new Promise((resolve) => setTimeout(resolve, 20)) });
  try {
    const repair = repairFor(fixture.endpoint);
    const results = await Promise.all([
      repair({ ...request, incidentId: 'incident-a' }, { runId: 'run-a', requestId: 'run-a:system:1', contextId: 'ctx-a' }),
      repair({ ...request, incidentId: 'incident-b' }, { runId: 'run-b', requestId: 'run-b:system:1', contextId: 'ctx-b' }),
    ]);
    assert.deepEqual(results.map((item) => item.status), ['completed', 'completed']);
    assert.equal(fixture.stateful.runs.length, 2);
    assert.equal(fixture.stateful.maxActive, 1);
  } finally { await fixture.close(); }
});

test('source manifest is based on integrated on-disk files and unknown lanes have no manifest', () => {
  const actual = systemSourceManifest(ROOT, {
    state: 'released', lane: { state: 'integrated' }, delta: { known: true, changedPaths: ['src/server.js', 'launcher.js', 'profiles/system/chuck-norris.toml', 'profiles/TEAM.md', 'test/ignored.js', 'launcher-ui/ignored.js', 'docs/note.md'] },
  });
  assert.equal(actual.known, true);
  assert.deepEqual(actual.files.map((item) => item.path), ['src/server.js', 'launcher.js', 'profiles/system/chuck-norris.toml', 'profiles/TEAM.md']);
  assert.equal(actual.files[0].sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/server.js'))).digest('hex'));
  const unknown = systemSourceManifest(ROOT, { state: 'unresolved', lane: { state: 'not_integrated' }, delta: null });
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.files, []);
});


test('project server exposes system-agent availability and passes its sealed runtime identity to the client callback', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-agent-server-'));
  const tokenPath = path.join(temp, 'system-token');
  fs.writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
  const previous = {
    url: process.env.CODEX_A2A_SYSTEM_AGENT_URL,
    token: process.env.CODEX_A2A_SYSTEM_AGENT_TOKEN_FILE,
    isolation: process.env.CODEX_A2A_WRITER_ISOLATION,
    resume: process.env.CODEX_A2A_AUTO_RESUME,
  };
  process.env.CODEX_A2A_SYSTEM_AGENT_URL = 'http://127.0.0.1:8080/agents/chuck-norris';
  process.env.CODEX_A2A_SYSTEM_AGENT_TOKEN_FILE = tokenPath;
  process.env.CODEX_A2A_WRITER_ISOLATION = 'shared';
  process.env.CODEX_A2A_AUTO_RESUME = '0';
  let capturedOptions;
  let capturedContext;
  const state = await openStateDatabase({ filePath: ':memory:' });
  try {
    const server = await startServer({
      workspace: ROOT,
      port: 0,
      listen: false,
      state,
      workspaceLockDir: path.join(temp, 'locks'),
      tokenFile: path.join(temp, 'project-token'),
      appServer: {
        async start() {},
        async getAccount() { return { account: { type: 'chatgpt' } }; },
        async close() {},
        async run() { throw new Error('fake App Server must not run'); },
      },
      systemRepairClientFactory: (options) => {
        assert.equal(options.endpoint, 'http://127.0.0.1:8080/agents/chuck-norris');
        assert.equal(options.authToken, TOKEN);
        return async (_request, context) => { capturedContext = context; return { status: 'blocked' }; };
      },
      orchestratorFactory: (options) => {
        capturedOptions = options;
        const { LeadOrchestrator } = require('../src/lead-orchestrator');
        return new LeadOrchestrator(options);
      },
    });
    assert.equal(capturedOptions.systemAgentAvailable, true);
    assert.equal(typeof capturedOptions.repairSystem, 'function');
    await capturedOptions.repairSystem(request, { runId: 'requester-run', contextId: 'requester-context' });
    assert.equal(capturedContext.requesterRuntimeIdentity.pid, process.pid);
    assert.equal(typeof capturedContext.requesterRuntimeIdentity.moduleLoadedAt, 'string');
    assert.equal(capturedContext.requesterRuntimeIdentity.sourceHashes['src/server.js'], undefined);
    assert.ok(capturedContext.requesterRuntimeIdentity.uncapturedSourceFiles.includes('src/server.js')); 
    assert.ok(capturedContext.requesterRuntimeIdentity.profileHashes['profiles/agents/engineer.toml']);
    assert.equal(Object.hasOwn(process.env, 'CODEX_A2A_SYSTEM_AGENT_TOKEN_FILE'), false);
    await server.close();
  } finally {
    await state.close();
    for (const [key, value] of Object.entries({
      CODEX_A2A_SYSTEM_AGENT_URL: previous.url,
      CODEX_A2A_SYSTEM_AGENT_TOKEN_FILE: previous.token,
      CODEX_A2A_WRITER_ISOLATION: previous.isolation,
      CODEX_A2A_AUTO_RESUME: previous.resume,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});


test('initialization failure closes its resources and a later authorized RPC can retry safely', async () => {
  let accountCalls = 0;
  let stateCloses = 0;
  const fixture = await serviceFixture({
    createAppServer: () => ({
      async start() {},
      async getAccount() { accountCalls += 1; return { account: { type: accountCalls === 1 ? 'apiKey' : 'chatgpt' } }; },
      async close() {},
      async run() { throw new Error('model run must not be reached'); },
    }),
    createState: async () => {
      const state = await openStateDatabase({ filePath: ':memory:' });
      const close = state.close.bind(state);
      state.close = async () => { stateCloses += 1; return close(); };
      return state;
    },
  });
  try {
    await assert.rejects(fixture.service.initialize(), /authenticated ChatGPT account/);
    assert.equal(fixture.service.descriptor().status, 'lazy');
    assert.equal(stateCloses, 1);
    const initialized = await fixture.service.initialize();
    assert.equal(initialized.role.name, 'chuck-norris');
    assert.equal(fixture.service.descriptor().status, 'ready');
    await fixture.service.close();
    assert.equal(stateCloses, 2);
    assert.equal(fixture.stateful.runs.length, 0);
  } finally { await fixture.close(); }
});

test('service shutdown aborts the active handler, waits for reservation cleanup, then closes its App Server', async () => {
  let started;
  const runStarted = new Promise((resolve) => { started = resolve; });
  const fixture = await serviceFixture({
    beforeRun: ({ signal }) => new Promise((resolve) => {
      started();
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', resolve, { once: true });
    }),
  });
  try {
    const repair = repairFor(fixture.endpoint);
    const pending = repair(request, { runId: 'run-close', requestId: 'run-close:system:1', contextId: 'ctx-close' });
    await runStarted;
    await fixture.service.close();
    const result = await pending;
    assert.ok(['blocked', 'unknown'].includes(result.status));
    assert.equal(fixture.stateful.runs.length, 1);
    assert.equal(fixture.stateful.closes, 1);
    assert.equal(fixture.stateful.active, 0);
  } finally { await fixture.close(); }
});


test('launcher exposes the separate system descriptor without initializing its service', async () => {
  const fixture = await serviceFixture();
  const app = createLauncherApp({ projects: { list: () => [] }, readAuthToken: () => TOKEN, systemAgent: fixture.service });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/system-agent`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      name: 'chuck-norris', displayName: 'Chuck Norris', model: 'gpt-6.1-sol', effort: 'high',
      defaults: { model: 'gpt-6.1-sol', effort: 'high' },
      sandbox: 'workspace-write', scope: 'system', workspace: fs.realpathSync(ROOT),
      endpoint: fixture.endpoint, status: 'lazy', configuredModel: 'gpt-6.1-sol', configuredEffort: 'high',
      pendingRestart: false, usage: null,
    });
    assert.equal(fixture.service.descriptor().status, 'lazy');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

test('launcher passes the separate system endpoint and token-file path only to child server configuration', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-agent-project-env-'));
  const repoDir = path.join(temp, 'repo');
  const runtimeDir = path.join(temp, 'runtime');
  const projectDir = path.join(temp, 'project');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  let captured;
  const fakeChild = new EventEmitter();
  fakeChild.pid = 987654;
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.kill = () => true;
  const manager = createProjectManager({
    repoDir,
    runtimeDir,
    systemAgentUrl: 'http://127.0.0.1:8080/agents/chuck-norris',
    systemAgentTokenFile: path.join(runtimeDir, 'system/chuck-norris/a2a-token'),
    portRange: [45100, 45110],
    spawn: (_command, _args, options) => { captured = options; return fakeChild; },
    fetch: async () => ({ ok: true }),
    isPortFree: async () => true,
    listenersOnPort: async () => [],
    isPidAlive: () => true,
    ensureToken() {},
  });
  try {
    await manager.init();
    const project = await manager.add(projectDir);
    await manager.start(project.id);
    assert.equal(captured.env.CODEX_A2A_SYSTEM_AGENT_URL, 'http://127.0.0.1:8080/agents/chuck-norris');
    assert.equal(captured.env.CODEX_A2A_SYSTEM_AGENT_TOKEN_FILE, path.resolve(runtimeDir, 'system/chuck-norris/a2a-token'));
    assert.equal(Object.hasOwn(captured.env, 'CODEX_A2A_SYSTEM_AGENT_TOKEN'), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});


test('launcher bootstrap loads launcher.js under runtime identity capture without starting services', () => {
  const source = [
    "const { bootstrap } = require('./launcher-bootstrap');",
    "bootstrap({ start(_launcher, identity) { process.stdout.write(JSON.stringify(identity.snapshot)); } });",
  ].join(' ');
  const snapshot = JSON.parse(execFileSync(process.execPath, ['-e', source], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(snapshot.sourceHashes['launcher.js'].length, 64);
  assert.equal(snapshot.sourceHashes['src/system-agent-service.js'].length, 64);
  assert.ok(snapshot.uncapturedSourceFiles.includes('launcher.js') === false);
  assert.equal(snapshot.sourceHashes['src/runtime-identity.js'].length, 64);
});


test('server bootstrap captures src/server.js as loaded and reports actual unverified loaded modules', () => {
  const source = [
    "const { bootstrap } = require('./server-bootstrap');",
    "bootstrap({ start(_server, identity) { process.stdout.write(JSON.stringify(identity.snapshot)); } });",
  ].join(' ');
  const snapshot = JSON.parse(execFileSync(process.execPath, ['-e', source], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(snapshot.sourceHashes['src/server.js'], crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/server.js'))).digest('hex'));
  assert.equal(snapshot.loadedUncapturedSourceFiles.includes('src/server.js'), false);
  assert.equal(snapshot.sourceHashes['src/runtime-identity.js'].length, 64);
  assert.equal(snapshot.loadedUncapturedSourceFiles.includes('src/runtime-identity.js'), false);
});

test('descriptor usage is null without a state db and sums the system ledger from the state file', async () => {
  const fixture = await serviceFixture();
  const tokens = (inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens) => ({
    inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens,
  });
  try {
    assert.equal(fixture.service.descriptor().usage, null);
    const state = await openStateDatabase({ filePath: path.join(fixture.temp, 'runtime', 'system', 'chuck-norris', 'state.sqlite') });
    const ledger = new UsageLedger({ db: state.db });
    ledger.record({ entryId: 'chuck-norris:run-1', kind: 'lead_turn', role: 'chuck-norris', runId: 'run-1', tokens: tokens(100, 40, 20, 5, 120) });
    ledger.record({ entryId: 'chuck-norris:run-2', kind: 'lead_turn', role: 'chuck-norris', runId: 'run-2', tokens: tokens(50, 0, 10, 0, 60) });
    ledger.record({ entryId: 'chuck-norris:run-3', kind: 'lead_turn', role: 'chuck-norris', runId: 'run-3' });
    await state.close();
    assert.deepEqual(fixture.service.descriptor().usage, {
      inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 180, attempts: 3,
    });
    await fixture.service.initialize();
    new UsageLedger({ db: fixture.stateful.state.db }).record({
      entryId: 'chuck-norris:run-4', kind: 'lead_turn', role: 'chuck-norris', runId: 'run-4', tokens: tokens(1, 0, 1, 0, 2),
    });
    const live = fixture.service.descriptor().usage;
    assert.equal(live.attempts, 1);
    assert.equal(live.totalTokens, 2);
  } finally { await fixture.close(); }
});

test('descriptor usage is null when the system state file is unreadable', async () => {
  const fixture = await serviceFixture();
  try {
    const stateDir = path.join(fixture.temp, 'runtime', 'system', 'chuck-norris');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state.sqlite'), 'not a sqlite database at all');
    assert.doesNotThrow(() => fixture.service.descriptor());
    assert.equal(fixture.service.descriptor().usage, null);
  } finally { await fixture.close(); }
});
