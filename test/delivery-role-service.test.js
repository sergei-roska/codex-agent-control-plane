'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { Role, TaskState } = require('@a2a-js/sdk');
const { BacklogStore, stableDigest } = require('../src/backlog-store');
const { CandidateStore } = require('../src/candidate-store');
const { CandidateReviewStore } = require('../src/candidate-review');
const { WriterAdmission } = require('../src/writer-admission');
const { LaneManager } = require('../src/writer-lanes');
const { DeliveryOutputArtifacts } = require('../src/delivery-output-artifacts');
const { TaskExecutor } = require('../src/task-executor');
const { DeliveryRoleService } = require('../src/delivery-role-service');
const { createDeliveryRoleCapabilities, deliveryRequestDigest, scopedExecutionDetails } = require('../src/delivery-role-capabilities');
const { normalizeSpecialistRequest } = require('../src/contracts');
const { readProcessIdentity } = require('../src/process-quiescence');

const PROJECT = 'role-service-project';
const OBJECTIVE = 'role-service-objective';
const SETTINGS = { model: 'test-model', effort: 'high', fast: true, codexHome: '/home/test-codex' };
const report = (filesChanged) => JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nImplementation completed.',
  filesChanged, filesInspected: ['source.txt'], checks: [{ command: 'node --test', result: 'passed', detail: 'One test ran.' }],
  risks: [], scopeExpansion: [], decisionRequest: null });
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const sha256 = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex');

function auth(req, res, next) {
  if (req.get('authorization') !== 'Bearer delivery-test-token') return res.status(401).json({ error: 'unauthorized' });
  return next();
}

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => {
    server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve());
  }) };
}

async function fixture(t, { appServer, role = 'engineer', reportText = null, artifactBindingAllowed = true, fastMode = null,
  ownerCorrectionAuthorized = false, executionPermissions = 'inherit', productWritePaths = ['source.txt'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-role-service-'));
  const workspace = path.join(root, 'repo');
  const state = path.join(root, 'state');
  const lanesRoot = path.join(root, 'lanes');
  fs.mkdirSync(workspace); fs.mkdirSync(state);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Role Service Test'); git('config', 'user.email', 'role-service@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  for (const relativePath of productWritePaths) {
    const file = path.join(workspace, relativePath);
    if (file === path.join(workspace, 'source.txt')) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'base\n');
  }
  if (productWritePaths.some((relativePath) => relativePath !== 'source.txt')) {
    git('add', '.'); git('commit', '-qm', 'add assigned output files');
  }
  const db = new Database(path.join(state, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace, settleMs: 100 });
  const store = new BacklogStore(db, { roleCapacities: { engineer: 4, explorer: 4, verifier: 4 }, maxActiveTurns: 8,
    plannerReservedSlots: 1, ownerCorrectionAuthorized: () => ownerCorrectionAuthorized });
  store.createObjective({ projectId: PROJECT, objectiveId: OBJECTIVE, sessionId: 'session', engineVersion: 'delivery-v1',
    goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const roleRecord = role === 'engineer'
    ? { role: 'engineer', kind: 'implementation', productWritePaths: [...productWritePaths], scratchWriteRoots: ['.scratch'], baseCandidateId: 'base-candidate' }
    : { role, kind: 'implementation', productWritePaths: [], scratchWriteRoots: ['.scratch'], baseCandidateId: 'base-candidate' };
  const task = { schemaVersion: 'delivery/v1', projectId: PROJECT, objectiveId: OBJECTIVE, taskId: 'task-1', revision: 1,
    ...roleRecord, objective: 'Update the assigned source file.', priority: 0, dependencies: [],
    readScope: { kind: 'unknown', paths: null, reason: 'Not established.' }, resourceClaims: [],
    publicationAuthority: { state: role === 'engineer' ? 'unknown' : 'denied' }, state: 'queued' };
  store.applyPlan(PROJECT, OBJECTIVE, { schemaVersion: 'delivery/v1', expectedPlanRevision: 0, expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1, tasks: [{ task }], dependencies: [] });
  const claim = store.claimReady(PROJECT, OBJECTIVE, 0, { controlRevision: 1 })[0];
  const lanes = new LaneManager({ db, workspace, admission, mode: 'worktree', lanesRoot, links: [] });
  let service;
  const artifacts = new DeliveryOutputArtifacts({ db, backlogStore: store, laneManager: lanes, admission, workspace,
    storageDir: path.join(state, 'artifacts'), authorizeBinding: (binding) => artifactBindingAllowed && service?.authorizeArtifactBinding(binding) === true,
    producerEvidenceFor: (binding) => service?.producerEvidenceFor(binding) || null });
  const candidates = new CandidateStore({ db, workspace, storageDir: path.join(state, 'candidates'), ...artifacts.candidateStoreOptions() });
  artifacts.attachCandidateStore(candidates);
  const base = candidates.createCandidate({ candidateId: 'base-candidate', projectId: PROJECT, objectiveId: OBJECTIVE,
    integrationGeneration: 1, sourceAttemptId: 'initial-attempt', environmentDigest: 'a'.repeat(64), checkIdentity: 'checks-v1' });
  const candidateReview = new CandidateReviewStore({ db, candidateStore: candidates,
    currentObjective: () => store.getObjective(PROJECT, OBJECTIVE), authorizeCheckpoint: () => true,
    authorizeProposal: () => true, authorizeBinding: () => true, authorizeThread: () => true,
    resolveAttempt: () => null, authorizeSettlement: () => true, attestClosure: () => ({ frozen: true }),
    attestPromotion: () => true, verifyReviewExecution: () => true });
  const app = express();
  const httpServer = await startServer(app);
  let runCalls = 0;
  let lastRunRole = null;
  let lastRunOptions = null;
  const fakeAppServer = appServer || { getCodexHome: () => SETTINGS.codexHome, async run(options) {
    runCalls += 1;
    lastRunOptions = options;
    lastRunRole = options.role;
    const threadId = `provider-thread-${runCalls}`;
    const turnId = `provider-turn-${runCalls}`;
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    if (options.cwd.includes(path.sep + 'lane-')) {
      for (const relativePath of productWritePaths) {
        const file = path.join(options.cwd, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `published-${runCalls}\n`);
      }
    }
    return { threadId, turnId, status: 'completed', text: reportText || report(role === 'engineer' ? productWritePaths : []),
      usage: { model: SETTINGS.model, effort: SETTINGS.effort, turns: 1 }, permissionEvents: [],
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true,
        processIdentity, threadId, turnId } };
  } };
  const roles = new Map([[role, { id: role, name: role, description: 'Configured delivery role.', sandbox: role === 'engineer' ? 'workspace-write' : 'read-only',
    model: SETTINGS.model, effort: SETTINGS.effort, fast: SETTINGS.fast, ...(fastMode ? { fastMode } : {}) }]]);
  service = new DeliveryRoleService({ db, backlogStore: store, candidateStore: candidates, candidateReview,
    outputArtifacts: artifacts, lanes, roles, appServer: fakeAppServer, workspace,
    baseUrl: httpServer.baseUrl, authMiddleware: auth, authToken: 'delivery-test-token',
    settingsFor: () => SETTINGS, roleFor: (id) => ({ ...roles.get(id), id }),
    executionPermissions,
    getProviderIdentity: () => ({ codexHome: SETTINGS.codexHome, transport: 'local-a2a', account: 'test-account' }),
    privateRoot: path.join(state, 'private') });
  const cards = service.register(app);
  const requestAdapter = ({ task: contract }) => ({ request: {
    objective: contract.objective, allowedFiles: contract.productWritePaths,
    inputs: [], evidence: [], acceptanceCriteria: [], checks: [], stopConditions: [],
  } });
  const executor = new TaskExecutor({ backlogStore: store, db,
    transportFor: (params, attemptId) => service.transportFor(params, attemptId),
    settingsFor: () => SETTINGS, roleFor: (id) => ({ ...roles.get(id), id }), requestAdapter,
    resultAdapter: (args) => service.resultAdapter(args), receiptAdapter: (args) => service.receiptAdapter(args),
    resolveVerifierCapability: undefined });
  t.after(async () => { await httpServer.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, db, store, claim, admission, candidates, base, candidateReview, lanes, artifacts, service, executor, cards,
    httpServer, get runCalls() { return runCalls; }, get lastRunRole() { return lastRunRole; }, get lastRunOptions() { return lastRunOptions; } };
}

function identity(fx) {
  return { projectId: PROJECT, objectiveId: OBJECTIVE, taskId: fx.claim.task.taskId,
    attemptId: fx.claim.attempt.attemptId, fencingToken: fx.claim.claim.fencingToken };
}

test('authenticated role card and returnImmediately TaskExecutor publish private output only through CandidateStore', async (t) => {
  const fx = await fixture(t);
  const cardResponse = await fetch(`${fx.httpServer.baseUrl}/delivery/agents/engineer/agent-card.json`, {
    headers: { Authorization: 'Bearer delivery-test-token' },
  });
  assert.equal(cardResponse.status, 200);
  const card = await cardResponse.json();
  assert.equal(card.supportedInterfaces[0].url, `${fx.httpServer.baseUrl}/delivery/agents/engineer`);
  assert.match(card.description, /model=test-model, effort=high, fastMode=on/);
  const denied = await fetch(`${fx.httpServer.baseUrl}/delivery/agents/engineer/agent-card.json`);
  assert.equal(denied.status, 401);
  const before = fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8');
  const sent = await fx.executor.execute(identity(fx));
  assert.equal(sent.state, 'submitted', JSON.stringify({ sent, evidence: fx.executor.listEvidence(fx.claim.attempt.attemptId) }));
  assert.equal(fx.service.getExecution(fx.claim.attempt.attemptId).state, 'terminal', JSON.stringify(fx.service.getExecution(fx.claim.attempt.attemptId)));
  const timing = fx.service.getExecution(fx.claim.attempt.attemptId);
  assert.ok(Number.isFinite(Date.parse(timing.providerInvocationStartedAt)));
  assert.ok(Number.isFinite(Date.parse(timing.turnStartObservedAt)));
  assert.ok(Date.parse(timing.terminalObservedAt) >= Date.parse(timing.turnStartObservedAt));
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), before);
  const result = await fx.executor.poll(identity(fx));
  assert.equal(result.state, 'succeeded');
  assert.equal(result.receipt.state, 'not_required');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), 'published-1\n');
  assert.equal(result.result.candidateId, `candidate-${fx.claim.attempt.attemptId}`);
  assert.equal(fx.candidates.get(result.result.candidateId).parentCandidateId, fx.base.candidateId);
  assert.equal(fx.artifacts.get(result.result.artifactId).state, 'captured');
  assert.equal(fx.service.getExecution(fx.claim.attempt.attemptId).state, 'settled');
});

test('unsorted multi-path task binds sorted scope and refuses subset or added declarations', async (t) => {
  const writePaths = ['patches/shs-3620147-preselect-stored-values.patch', 'composer.json', 'patches.lock.json'];
  const sortedWritePaths = [...writePaths].sort();
  const fx = await fixture(t, { productWritePaths: writePaths });
  const id = identity(fx);
  const sent = await fx.executor.execute(id);
  assert.equal(sent.state, 'submitted', JSON.stringify({ sent, evidence: fx.executor.listEvidence(id.attemptId) }));

  const execution = fx.service.getExecution(id.attemptId);
  assert.equal(execution.state, 'terminal');
  assert.deepEqual(execution.writePaths, writePaths);
  const stored = fx.artifacts.binding(execution.artifactId);
  assert.equal(stored.row.state, 'bound');
  assert.deepEqual(stored.identity.declaredWritePaths, sortedWritePaths);
  assert.equal(fx.service.authorizeArtifactBinding(stored.identity), true);
  assert.equal(fx.service.authorizeArtifactBinding({ ...stored.identity,
    declaredWritePaths: sortedWritePaths.slice(0, -1) }), false);
  assert.equal(fx.service.authorizeArtifactBinding({ ...stored.identity,
    declaredWritePaths: [...sortedWritePaths, 'unassigned.txt'] }), false);
  assert.equal(fx.service.authorizeArtifactBinding({ ...stored.identity,
    declaredWritePaths: [...sortedWritePaths, sortedWritePaths[0]] }), false);
  assert.equal(fx.artifacts.binding(execution.artifactId).row.state, 'bound');

  const result = await fx.executor.poll(id);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.result.candidateId, `candidate-${id.attemptId}`);
  assert.deepEqual(fx.artifacts.get(result.result.artifactId).deltaPaths, sortedWritePaths);
  for (const relativePath of writePaths) {
    assert.equal(fs.readFileSync(path.join(fx.workspace, relativePath), 'utf8'), 'published-1\n');
  }
});

test('role card and execution provenance preserve effective Fast modes', async (t) => {
  for (const fastMode of ['inherit', 'off', 'on']) {
    await t.test(fastMode, async (st) => {
      const fx = await fixture(st, { fastMode });
      const response = await fetch(`${fx.httpServer.baseUrl}/delivery/agents/engineer/agent-card.json`, {
        headers: { Authorization: 'Bearer delivery-test-token' },
      });
      const card = await response.json();
      assert.match(card.description, new RegExp(`fastMode=${fastMode}`));
      const sent = await fx.executor.execute(identity(fx));
      assert.equal(sent.state, 'submitted');
      const execution = fx.service.getExecution(fx.claim.attempt.attemptId);
      assert.equal(fx.lastRunRole.fastMode, fastMode);
      assert.equal(execution.provenance.fastMode, fastMode);
    });
  }
});

test('same-role writers overlap in private lanes while the shared tree remains unchanged', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const fx = await fixture(t, { appServer: { getCodexHome: () => SETTINGS.codexHome, async run(options) {
    started += 1;
    const threadId = `parallel-thread-${started}`; const turnId = `parallel-turn-${started}`;
    options.onTurnStart({ threadId, processIdentity: readProcessIdentity(process.pid) });
    fs.writeFileSync(path.join(options.cwd, 'source.txt'), `private-${started}\n`);
    if (started === 2) release();
    await gate;
    const index = Number(threadId.split('-').at(-1));
    return { threadId, turnId, status: 'completed', text: report(['source.txt']), usage: {}, permissionEvents: [],
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity: readProcessIdentity(process.pid), threadId, turnId, cleanupSucceeded: true } };
  } } });
  const secondTask = { ...fx.claim.task, taskId: 'task-2', objective: 'Update the source independently.', state: 'queued' };
  fx.store.applyPlan(PROJECT, OBJECTIVE, { schemaVersion: 'delivery/v1', expectedPlanRevision: 1, expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 2, tasks: [{ task: secondTask }], dependencies: [] });
  const secondClaim = fx.store.claimReady(PROJECT, OBJECTIVE, 0, { controlRevision: 1, limit: 1 })[0];
  const original = fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8');
  const firstSend = fx.executor.execute(identity(fx));
  while (started < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await fx.executor.execute({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: secondClaim.task.taskId,
    attemptId: secondClaim.attempt.attemptId, fencingToken: secondClaim.claim.fencingToken });
  assert.equal(second.state, 'submitted');
  assert.equal(started, 2);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), original);
  release();
  assert.equal((await firstSend).state, 'submitted');
  const firstTerminal = await fx.executor.poll(identity(fx));
  const secondIdentity = { projectId: PROJECT, objectiveId: OBJECTIVE, taskId: secondClaim.task.taskId,
    attemptId: secondClaim.attempt.attemptId, fencingToken: secondClaim.claim.fencingToken };
  const secondTerminal = await fx.executor.poll(secondIdentity);
  assert.deepEqual([firstTerminal.state, secondTerminal.state].sort(), ['failed', 'succeeded']);
  assert.match(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), /^private-[12]\n$/);
  const refusal = [firstTerminal, secondTerminal].find((value) => value.state === 'failed');
  assert.equal(refusal.result.failureKind, 'candidate_publication_refused');
  assert.equal(refusal.result.publicationState, 'refused');
  assert.ok(refusal.result.artifactId);
});

test('same-owner pause or correction after turn admission settles terminal private output without publication', async (t) => {
  for (const controlAction of ['pause', 'correction']) {
    await t.test(controlAction, async (st) => {
      let release;
      let startedResolve;
      const gate = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { startedResolve = resolve; });
      const fx = await fixture(st, { ownerCorrectionAuthorized: controlAction === 'correction',
        appServer: { getCodexHome: () => SETTINGS.codexHome, async run(options) {
          const processIdentity = readProcessIdentity(process.pid);
          options.onTurnStart({ threadId: 'controlled-thread', processIdentity });
          startedResolve();
          await gate;
          fs.writeFileSync(path.join(options.cwd, 'source.txt'), 'controlled-private-output\n');
          return { status: 'completed', threadId: 'controlled-thread', turnId: 'controlled-turn', text: report(['source.txt']), usage: {}, permissionEvents: [],
            execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity,
              threadId: 'controlled-thread', turnId: 'controlled-turn', cleanupSucceeded: true } };
        } } });
      const identityValue = identity(fx);
      const original = fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8');
      const send = fx.executor.execute(identityValue);
      await started;
      if (controlAction === 'pause') fx.store.requestControl(PROJECT, OBJECTIVE, 'pause', 1);
      else fx.store.applyOwnerCorrection(PROJECT, OBJECTIVE, { sourceMessageId: 'owner-correction', expectedGoalRevision: 1,
        expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: `sha256:${'e'.repeat(64)}` });
      release();
      const sent = await send;
      assert.equal(sent.state, 'submitted');
      const settled = await fx.executor.poll(identityValue);
      assert.equal(settled.state, 'failed');
      assert.equal(settled.receipt?.state, 'not_required');
      assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), original);
      assert.equal(fx.candidates.get(`candidate-${fx.claim.attempt.attemptId}`), null);
      const execution = fx.service.getExecution(fx.claim.attempt.attemptId);
      assert.equal(execution.state, 'settled');
      assert.equal(execution.result.output.state, 'not_published');
      assert.equal(fx.lanes.store.list(fx.workspace).find((lane) => lane.laneId === execution.laneId).state, 'not_integrated');
      assert.equal(fx.store.projectCapacity(PROJECT, OBJECTIVE).active, 0);
    });
  }
});

test('stale refused bridge history cannot settle without current CandidateStore refusal evidence', async (t) => {
  const fx = await fixture(t);
  const identityValue = identity(fx);
  const sent = await fx.executor.execute(identityValue);
  assert.equal(sent.state, 'submitted');
  const originalPublish = fx.artifacts.publish.bind(fx.artifacts);
  fx.artifacts.publish = async (request) => {
    const at = new Date().toISOString();
    fx.db.prepare(`INSERT INTO delivery_output_publications(intent_id,artifact_id,request_json,state,result_json,created_at,updated_at)
      VALUES(?,?,?,'refused',?,?,?)`).run(request.intentId, request.artifactId, canonical({ artifactId: request.artifactId,
        candidateId: request.candidateId, intentId: request.intentId, integrationGeneration: request.integrationGeneration }),
      JSON.stringify({ state: 'refused' }), at, at);
    throw Object.assign(new Error('simulated stale bridge refusal'), { code: 'generation_not_monotonic' });
  };
  await assert.rejects(fx.executor.poll(identityValue), /simulated stale bridge refusal/);
  fx.artifacts.publish = originalPublish;
  assert.equal(fx.candidates.getIntent(`publication-${fx.claim.attempt.attemptId}`), null);
  assert.equal(fx.admission.findAnyByContextId(`publication-${fx.claim.attempt.attemptId}`), null);
  assert.equal(fx.service.getExecution(fx.claim.attempt.attemptId).state, 'terminal');
  assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE).find((item) => item.attemptId === fx.claim.attempt.attemptId).state, 'running');
});

test('forged claim metadata is rejected before AppServer execution', async (t) => {
  const fx = await fixture(t);
  const attempt = fx.store.listAttempts(PROJECT, OBJECTIVE).find((row) => row.attemptId === fx.claim.attempt.attemptId);
  const settingsDigest = attempt.selectedSettingsDigest;
  const request = normalizeSpecialistRequest({ objective: fx.claim.task.objective, allowedFiles: ['source.txt'] },
    { id: 'engineer', name: 'engineer', sandbox: 'workspace-write' }, { workspace: fx.workspace });
  const requestDigest = deliveryRequestDigest({ request, settingsDigest, taskDigest: attempt.contractDigest });
  const transport = fx.service.transportFor({ role: { id: 'engineer' }, settings: SETTINGS, transportKey: 'forged-test' });
  const originalError = console.error;
  let response;
  try {
    console.error = () => {};
    response = await transport.sendMessage({ message: { messageId: 'forged-message', contextId: attempt.providerContextId,
    role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: JSON.stringify(request) } }], metadata: {
      projectId: PROJECT, objectiveId: OBJECTIVE, taskId: fx.claim.task.taskId, attemptId: attempt.attemptId,
      fencingToken: fx.claim.claim.fencingToken + 1, providerContextId: attempt.providerContextId,
      requestDigest, productWritePaths: ['source.txt'], scratchWriteRoots: ['.scratch'],
    } } }, { signal: undefined });
  } finally { console.error = originalError; }
  assert.equal(response.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(fx.runCalls, 0);
  assert.equal(fx.service.getExecution(attempt.attemptId), null);
});

test('known host rejection before AppServer invocation settles failed without retaining uncertainty', async (t) => {
  const fx = await fixture(t, { artifactBindingAllowed: false });
  const identityValue = identity(fx);
  const sent = await fx.executor.execute(identityValue);
  assert.equal(sent.state, 'submitted');
  assert.equal(fx.runCalls, 0);
  const settled = await fx.executor.poll(identityValue);
  assert.equal(settled.state, 'failed');
  const record = fx.service.getExecution(fx.claim.attempt.attemptId);
  assert.equal(record.providerInvocationStarted, false);
  assert.equal(record.state, 'settled');
  assert.equal(record.terminalStatus, 'not_started');
  assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE).find((item) => item.attemptId === fx.claim.attempt.attemptId).state, 'failed');
});

test('configured read-only role executes against an immutable candidate copy', async (t) => {
  const fx = await fixture(t, { role: 'explorer', reportText: report([]) });
  const original = fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8');
  const result = await fx.executor.execute(identity(fx));
  assert.equal(result.state, 'submitted');
  assert.equal(fx.service.getExecution(fx.claim.attempt.attemptId).state, 'terminal');
  const settled = await fx.executor.poll(identity(fx));
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.result.outputContract, 'delivery-role-output/v1');
  assert.equal(settled.result.candidateId, fx.base.candidateId);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), original);
  assert.equal(fx.service.getExecution(fx.claim.attempt.attemptId).laneId, null);
});

test('owner full-access read-only roles resolve policy at the project root while keeping the private candidate cwd', async (t) => {
  const fx = await fixture(t, { role: 'explorer', reportText: report([]), executionPermissions: 'full-access' });
  const result = await fx.executor.execute(identity(fx));
  assert.equal(result.state, 'submitted');
  assert.equal(fx.lastRunOptions.role.sandbox, 'read-only');
  assert.equal(fx.lastRunOptions.executionPermissions, 'full-access');
  assert.notEqual(fx.lastRunOptions.cwd, fx.workspace);
  assert.equal(fx.lastRunOptions.permissionWorkspace, fx.workspace);
  const settled = await fx.executor.poll(identity(fx));
  assert.equal(settled.state, 'succeeded');
  assert.equal(fx.service.getExecution(fx.claim.attempt.attemptId).laneId, null);
});

test('verifier host check proof and frozen CandidateReview receipt require pinned passing checks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-verifier-role-service-'));
  const workspace = path.join(root, 'repo'); const state = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(state);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Verifier Test'); git('config', 'user.email', 'verifier@example.invalid');
  fs.writeFileSync(path.join(workspace, 'input.txt'), 'frozen input\n'); git('add', '.'); git('commit', '-qm', 'base');
  const db = new Database(path.join(state, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace });
  const store = new BacklogStore(db, { roleCapacities: { verifier: 1 }, maxActiveTurns: 2, plannerReservedSlots: 0 });
  store.createObjective({ projectId: PROJECT, objectiveId: OBJECTIVE, sessionId: 'review-session', engineVersion: 'delivery-v1',
    goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const candidates = new CandidateStore({ db, workspace, storageDir: path.join(state, 'candidates') });
  const candidate = candidates.createCandidate({ candidateId: 'review-candidate', projectId: PROJECT, objectiveId: OBJECTIVE,
    integrationGeneration: 1, sourceAttemptId: 'initial-attempt', environmentDigest: 'c'.repeat(64), checkIdentity: 'check-set-v1' });
  const bytes = fs.readFileSync(path.join(workspace, 'input.txt'));
  const reviewFacts = new Map();
  const review = new CandidateReviewStore({ db, candidateStore: candidates,
    currentObjective: () => { const item = store.getObjective(PROJECT, OBJECTIVE); return { ...item,
      requirementDigest: item.requirementDigest.replace(/^sha256:/, ''), checksDigest: item.checksDigest.replace(/^sha256:/, '') }; },
    checkpointInventory: () => [{ projectId: PROJECT, objectiveId: OBJECTIVE, checkpointId: 'checkpoint-1' }],
    authorizeCheckpoint: () => true, authorizeProposal: () => true, authorizeBinding: () => true, authorizeThread: () => true,
    authorizeSettlement: () => true, attestClosure: ({ checkpointId }) => ({ known: true, checkpointId,
      readManifest: [{ path: 'input.txt', digest: sha256(bytes) }], checkpointAncestors: [] }),
    resolveAttempt: ({ attemptId }) => reviewFacts.get(attemptId) || null,
    verifyReviewExecution: ({ attempt }) => attempt.effect?.effectsSettled === true && attempt.checksPassed === true });
  review.registerCheckpoint({ projectId: PROJECT, objectiveId: OBJECTIVE, checkpointId: 'checkpoint-1', kind: 'risk_change',
    reason: 'Review frozen input.', checkIdentity: 'check-set-v1', checkPins: ['check-v1'], toolPins: [], profilePins: [],
    environmentDigest: 'c'.repeat(64) }, { source: 'owner' });
  const proposals = review.proposeReviews({ projectId: PROJECT, objectiveId: OBJECTIVE, checkpointId: 'checkpoint-1',
    candidateId: candidate.candidateId, reviewers: [{ role: 'verifier', taskId: 'review-task' }] }, { source: 'planner' });
  assert.equal(review.getReviewTask('review-task').readScope.kind, 'known', JSON.stringify(review.getReviewTask('review-task')));
  const objective = store.getObjective(PROJECT, OBJECTIVE);
  store.applyPlan(PROJECT, OBJECTIVE, { schemaVersion: 'delivery/v1', expectedPlanRevision: objective.planRevision,
    expectedGoalRevision: objective.goalRevision, expectedAuthorityRevision: objective.authorityRevision,
    expectedControlRevision: objective.controlRevision, nextPlanRevision: objective.planRevision + 1,
    tasks: proposals.map(({ task }) => ({ task })), dependencies: [] });
  const claim = store.claimReady(PROJECT, OBJECTIVE, objective.ownerGeneration, { controlRevision: objective.controlRevision })[0];
  const capabilities = createDeliveryRoleCapabilities({ backlogStore: store, candidateReview: review,
    projectWorkspaceFor: () => workspace, scratchRootFor: ({ attemptId }) => path.join(state, 'scratch', attemptId) });
  const settings = { model: 'review-model', effort: 'low', fast: false, codexHome: '/home/review-codex' };
  const lanes = new LaneManager({ db, workspace, admission, mode: 'worktree', lanesRoot: path.join(state, 'lanes'), links: [] });
  const artifacts = new DeliveryOutputArtifacts({ db, backlogStore: store, laneManager: lanes, admission, workspace,
    storageDir: path.join(state, 'artifacts'), authorizeBinding: () => false, producerEvidenceFor: () => null });
  const serviceCandidateStore = candidates;
  artifacts.attachCandidateStore(serviceCandidateStore);
  const app = express(); const httpServer = await startServer(app);
  const role = { id: 'verifier', name: 'Verifier', description: 'Checks a frozen candidate.', sandbox: 'workspace-write', ...settings };
  const roles = new Map([['verifier', role]]);
  const appServer = { getCodexHome: () => settings.codexHome, async run(options) {
    const details = scopedExecutionDetails(options.deliveryCapability);
    assert.equal(details.verifyCandidate(), true);
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId: 'review-thread', processIdentity });
    return { status: 'completed', threadId: 'review-thread', turnId: 'review-turn',
      text: JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nNo issues found.', filesChanged: [],
        filesInspected: ['input.txt'], checks: [{ command: 'check-v1', result: 'passed', detail: 'Passed.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }), usage: {}, permissionEvents: [],
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity,
        threadId: 'review-thread', turnId: 'review-turn' } };
  } };
  let forgeCheckProof = true;
  const makeCheckProof = ({ task, attempt, execution, candidate: candidatePin, requiredCheckPins }) => {
    const proof = { projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId, attemptId: attempt.attemptId,
      fencingToken: attempt.fencingToken, providerContextId: execution.providerContextId, providerThreadId: execution.providerThreadId,
      candidateId: candidatePin.candidateId, inputManifestDigest: candidatePin.inputManifestDigest,
      selectedSettingsDigest: execution.settingsDigest, requestDigest: execution.requestDigest,
      checkPins: forgeCheckProof ? ['unrequested-check'] : [...requiredCheckPins],
      results: requiredCheckPins.map((checkId) => ({ checkId, state: 'passed', evidenceRef: `host-check:${checkId}` })),
      evidenceRefs: requiredCheckPins.map((checkId) => `host-check:${checkId}`) };
    proof.evidenceDigest = `sha256:${sha256(canonical(proof))}`;
    return proof;
  };
  let service;
  const boundArtifacts = new DeliveryOutputArtifacts({ db, backlogStore: store, laneManager: lanes, admission, workspace,
    storageDir: path.join(state, 'service-artifacts'), authorizeBinding: (binding) => service?.authorizeArtifactBinding(binding) === true,
    producerEvidenceFor: (binding) => service?.producerEvidenceFor(binding) || null });
  boundArtifacts.attachCandidateStore(serviceCandidateStore);
  service = new DeliveryRoleService({ db, backlogStore: store, candidateStore: candidates, candidateReview: review,
    outputArtifacts: boundArtifacts, lanes, roles, appServer, workspace, baseUrl: httpServer.baseUrl,
    authMiddleware: auth, authToken: 'delivery-test-token', settingsFor: () => settings,
    roleFor: (id) => ({ ...role, id }), resolveVerifierCapability: capabilities.resolveVerifierCapability,
    checkEvidenceFor: makeCheckProof, getProviderIdentity: () => ({ codexHome: settings.codexHome, transport: 'local-a2a', account: 'review' }),
    privateRoot: path.join(state, 'private') });
  service.register(app);
  const executor = new TaskExecutor({ backlogStore: store, db,
    transportFor: (params, attemptId) => service.transportFor(params, attemptId), settingsFor: () => settings,
    roleFor: (id) => ({ ...role, id }), requestAdapter: ({ task: contract }) => ({ request: { objective: contract.objective, allowedFiles: [] } }),
    resolveVerifierCapability: capabilities.resolveVerifierCapability, resultAdapter: (args) => service.resultAdapter(args),
    receiptAdapter: (args) => service.receiptAdapter(args) });
  review.resolveAttempt = ({ attemptId, taskId, claimId }) => {
    const current = store.listAttempts(PROJECT, OBJECTIVE).find((item) => item.attemptId === attemptId);
    const activeClaim = store.listClaims(PROJECT, OBJECTIVE).find((item) => item.claimId === claimId);
    const execution = service.getExecution(attemptId);
    return { ...current, projectId: PROJECT, objectiveId: OBJECTIVE, taskId, role: 'verifier', threadId: execution?.providerThreadId,
      claimId, ownerGeneration: activeClaim?.ownerGeneration, selectedSettingsDigest: current?.selectedSettingsDigest,
      providerContextId: current?.providerContextId, candidateId: candidate.candidateId, state: current?.state,
      inputManifestDigest: candidate.manifestDigest, checksPassed: current?.outcome?.checksPassed === true,
      productWrites: [], outcome: current?.outcome, effect: current?.effect };
  };
  t.after(async () => { await httpServer.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const sent = await executor.execute({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: claim.task.taskId,
    attemptId: claim.attempt.attemptId, fencingToken: claim.claim.fencingToken });
  assert.equal(sent.state, 'submitted');
  await assert.rejects(executor.poll({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: claim.task.taskId,
    attemptId: claim.attempt.attemptId, fencingToken: claim.claim.fencingToken }), { code: 'delivery_role_check_evidence_invalid' });
  const refusedAttempt = store.listAttempts(PROJECT, OBJECTIVE).find((item) => item.attemptId === claim.attempt.attemptId);
  assert.equal(refusedAttempt.state, 'running');
  assert.notEqual(refusedAttempt.outcome?.checksPassed, true);
  forgeCheckProof = false;
  const settled = await executor.poll({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: claim.task.taskId,
    attemptId: claim.attempt.attemptId, fencingToken: claim.claim.fencingToken });
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.receipt.state, 'settled');
  assert.equal(settled.receipt.receipt.outcome, 'passed');
  const attempt = store.listAttempts(PROJECT, OBJECTIVE).find((item) => item.attemptId === claim.attempt.attemptId);
  assert.equal(attempt.outcome.checksPassed, true);
  assert.equal(review.getReceipt(settled.receipt.receipt.receiptId).candidateId, candidate.candidateId);
});

test('reopened running execution projects unknown and is never resent', async (t) => {
  const fx = await fixture(t);
  const attemptId = fx.claim.attempt.attemptId;
  const record = { schemaVersion: 'delivery-role-execution/v1', attemptId, projectId: PROJECT, objectiveId: OBJECTIVE,
    taskId: fx.claim.task.taskId, fencingToken: fx.claim.claim.fencingToken, providerContextId: fx.claim.attempt.providerContextId,
    contextId: fx.claim.attempt.providerContextId, externalTaskId: 'known-external-task', roleId: 'engineer',
    requestDigest: 'sha256:' + 'c'.repeat(64), settingsDigest: 'sha256:' + 'd'.repeat(64), state: 'running', updatedAt: new Date().toISOString() };
  fx.db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,provider_context_id,
    external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'running',?,?,?)`).run(attemptId, PROJECT, OBJECTIVE, record.taskId, record.fencingToken,
    record.providerContextId, record.externalTaskId, 'engineer', record.requestDigest, record.settingsDigest,
    JSON.stringify(record), record.updatedAt, record.updatedAt);
  const fresh = new DeliveryRoleService({ db: fx.db, backlogStore: fx.store, candidateStore: fx.candidates,
    candidateReview: fx.candidateReview, outputArtifacts: fx.artifacts, lanes: fx.lanes,
    roles: new Map([['engineer', { id: 'engineer', name: 'engineer', description: 'Configured role.', sandbox: 'workspace-write' }]]),
    appServer: { run: async () => { throw new Error('must not resend'); } }, workspace: fx.workspace,
    baseUrl: fx.httpServer.baseUrl, authMiddleware: auth, authToken: 'delivery-test-token',
    settingsFor: () => SETTINGS, roleFor: (id) => ({ id, sandbox: 'workspace-write' }), privateRoot: path.join(fx.root, 'reopened-private') });
  assert.equal(fresh.projection()[0].state, 'unknown');
  assert.equal(fresh.projection()[0].reconciliation, 'reopen_requires_host_reconciliation');
  assert.equal(fresh.getExecution(attemptId).externalTaskId, 'known-external-task');
});


test('terminal private output prepares an immutable no-publication proof for executor recovery', async (t) => {
  const fx = await fixture(t);
  await fx.executor.execute(identity(fx));
  const original = fx.service.getExecution(fx.claim.attempt.attemptId);
  assert.equal(original.state, 'terminal');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), 'base\n');
  const recovery = { ...identity(fx), recoveryGeneration: 0 };
  const prepared = await fx.service.prepareNoPublicationRecovery(recovery);
  assert.equal(prepared.state, 'prepared');
  assert.deepEqual(await fx.service.prepareNoPublicationRecovery(recovery), prepared);
  const roleRecord = fx.service.getExecution(recovery.attemptId);
  assert.equal(roleRecord.state, 'settled');
  assert.equal(roleRecord.result.output.state, 'not_published');
  const lane = fx.lanes.store.get(original.laneId);
  assert.equal(lane.state, 'not_integrated');
  assert.equal(lane.reason, 'recovery_no_publication');
  assert.equal(fs.existsSync(lane.path), true, 'private evidence is retained');
  assert.equal(fs.readFileSync(path.join(lane.path, 'source.txt'), 'utf8'), 'published-1\n');
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM delivery_output_publications').get().count, 0);
  fx.store.requestLifecycleRecovery(PROJECT, OBJECTIVE, 0);
  const proof = fx.service.recoveryProofFor({ identity: recovery });
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.isFrozen(proof.evidenceRefs), true);
  assert.deepEqual(Object.keys(proof).sort(), ['projectId', 'objectiveId', 'taskId', 'attemptId', 'fencingToken',
    'claimOwnerGeneration', 'recoveryGeneration', 'providerContextId', 'intentState', 'noEffect',
    'remoteQuiescent', 'processQuiescent', 'effectsSettled', 'evidenceRefs'].sort());
  fx.executor.recoveryProofAdapter = (input) => fx.service.recoveryProofFor(input);
  const result = fx.executor.recover(recovery);
  assert.equal(result.state, 'no_effect_requeued');
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'released');
  assert.equal(fx.executor.getAttempt(recovery.attemptId).state, 'settled');
  assert.equal(fx.runCalls, 1);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), 'base\n');
});

for (const defect of ['provider', 'settings', 'model', 'context', 'request', 'contract', 'fence', 'generation', 'terminal', 'process', 'lane-owner', 'publication']) {
  test(`no-publication recovery refuses altered durable facts: ${defect}`, async (t) => {
    const fx = await fixture(t);
    await fx.executor.execute(identity(fx));
    const recovery = { ...identity(fx), recoveryGeneration: 0 };
    const record = fx.service.getExecution(recovery.attemptId);
    if (defect === 'provider') fx.service.getProviderIdentity = () => ({ account: 'replacement', codexHome: SETTINGS.codexHome });
    else if (defect === 'settings') fx.service.settingsFor = () => ({ ...SETTINGS, model: 'changed-model' });
    else if (defect === 'model') fx.service.roleFor = () => ({ id: 'engineer', model: 'replacement-model' });
    else if (defect === 'generation') recovery.recoveryGeneration = 1;
    else if (defect === 'lane-owner') fx.db.prepare('UPDATE writer_lanes SET task_id=? WHERE lane_id=?').run('other-attempt', record.laneId);
    else if (defect === 'publication') fx.db.prepare(`INSERT INTO delivery_output_publications
      (intent_id,artifact_id,request_json,state,created_at,updated_at) VALUES(?,?,'{}','unknown','now','now')`)
      .run('unknown-publication', record.artifactId);
    else {
      if (defect === 'context') record.providerContextId = 'wrong-context';
      if (defect === 'fence') record.fencingToken += 1;
      if (defect === 'request') record.requestDigestObserved = 'sha256:' + '0'.repeat(64);
      if (defect === 'contract') record.contractDigest = 'sha256:' + '0'.repeat(64);
      if (defect === 'terminal') record.execution.turnTerminal = false;
      if (defect === 'process') record.execution.processIdentity.startTime = 'changed-start';
      fx.db.prepare('UPDATE delivery_role_executions SET record_json=? WHERE attempt_id=?').run(JSON.stringify(record), record.attemptId);
    }
    await assert.rejects(fx.service.prepareNoPublicationRecovery(recovery), { code: 'delivery_role_recovery_proof_unavailable' });
    assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
    assert.equal(fx.executor.getAttempt(recovery.attemptId).state, 'submitted');
    assert.equal(fx.runCalls, 1);
  });
}

test('no-publication preparation closes publication before late terminal delivery and rechecks proof pins', async (t) => {
  const fx = await fixture(t);
  await fx.executor.execute(identity(fx));
  const recovery = { ...identity(fx), recoveryGeneration: 0 };
  await fx.service.prepareNoPublicationRecovery(recovery);
  await assert.rejects(fx.executor.poll(identity(fx)), { code: 'delivery_role_terminal_proof_missing' });
  assert.equal(fx.service.getExecution(recovery.attemptId).result.output.state, 'not_published');
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM delivery_output_publications').get().count, 0);
  fx.store.requestLifecycleRecovery(PROJECT, OBJECTIVE, 0);
  assert.equal(fx.service.recoveryProofFor({ identity: recovery }).noEffect, true);
  fx.service.getProviderIdentity = () => ({ codexHome: SETTINGS.codexHome, account: 'replaced-after-preparation' });
  assert.throws(() => fx.service.recoveryProofFor({ identity: recovery }), { code: 'delivery_role_recovery_proof_unavailable' });
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'expired');
});

test('canceled owner generation recovers private output without requeue or publication', async (t) => {
  const fx = await fixture(t);
  await fx.executor.execute(identity(fx));
  const objective = fx.store.getObjective(PROJECT, OBJECTIVE);
  fx.store.transitionLifecycleControl(PROJECT, OBJECTIVE, { action: 'cancel', expectedControlRevision: objective.controlRevision,
    expectedOwnerGeneration: objective.ownerGeneration });
  fx.store.advanceOwnerGeneration(PROJECT, OBJECTIVE, 0);
  const recovery = { ...identity(fx), recoveryGeneration: 1 };
  await fx.service.prepareNoPublicationRecovery(recovery);
  fx.store.requestLifecycleRecovery(PROJECT, OBJECTIVE, 1);
  fx.executor.recoveryProofAdapter = (input) => fx.service.recoveryProofFor(input);
  const result = fx.executor.recover(recovery);
  assert.equal(result.state, 'canceled');
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'released');
  assert.equal(fx.store.getObjective(PROJECT, OBJECTIVE).tasks[0].state, 'canceled');
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM delivery_output_publications').get().count, 0);
});

async function shutdownFixture(t, { role = 'engineer' } = {}) {
  const { spawn } = require('node:child_process');
  const { CodexAppServer } = require('../src/codex-app-server');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const processIdentity = readProcessIdentity(child.pid);
  const client = Object.create(CodexAppServer.prototype);
  client.generation = 1; client.child = child; client.childExited = false;
  client.currentChildState = { child, identity: processIdentity, generation: 1, failed: false, exited: false };
  client.readProcessIdentityImpl = readProcessIdentity;
  client._request = async (method, params) => {
    assert.equal(method, 'thread/backgroundTerminals/clean');
    assert.equal(params.threadId, 'shutdown-thread');
    return {};
  };
  let calls = 0;
  const fx = await fixture(t, { role, appServer: { async run(options) {
    calls += 1;
    options.onTurnStart({ threadId: 'shutdown-thread', processIdentity });
    if (role === 'engineer') fs.writeFileSync(path.join(options.cwd, 'source.txt'), 'private terminal evidence\n');
    const ctx = { generation: 1, childState: client.currentChildState, processIdentity };
    await client._cleanupTerminal({ terminal: true, ctx, threadId: 'shutdown-thread', turnId: 'shutdown-turn' });
    return { status: 'completed', text: report(role === 'engineer' ? ['source.txt'] : []), threadId: 'shutdown-thread', turnId: 'shutdown-turn',
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, generation: 1,
        processIdentity, threadId: 'shutdown-thread', turnId: 'shutdown-turn', cleanupReceipt: ctx.cleanupReceipt } };
  } } });
  const settings = { ...SETTINGS, accountId: 'test-account' };
  const providerIdentity = { codexHome: SETTINGS.codexHome, accountId: 'test-account' };
  fx.service.settingsFor = () => settings;
  fx.service.getProviderIdentity = () => providerIdentity;
  fx.executor.settingsFor = () => settings;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  } });
  await fx.executor.execute(identity(fx));
  const recovery = { ...identity(fx), recoveryGeneration: 0 };
  fx.executor.terminalFailureProofAdapter = (input) => fx.service.terminalFailureProofFor(input);
  return { ...fx, recovery, child, processIdentity, calls: () => calls, async stop() {
    const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  } };
}

async function settleShutdownFixture(fx) {
  fx.service.prepareTerminalShutdown(fx.recovery);
  await fx.stop();
  const proof = await fx.service.prepareTerminalFailure(fx.recovery);
  fx.store.requestLifecycleRecovery(PROJECT, OBJECTIVE, 0);
  fx.store.reconcileAttempt(PROJECT, OBJECTIVE, fx.recovery.attemptId, fx.recovery.fencingToken, proof);
  fx.executor.reconcileTerminalFailure(fx.recovery);
  return proof;
}

function changeCurrentRoleIdentity(service) {
  service.getProviderIdentity = () => ({ codexHome: '/home/changed-codex', accountId: 'changed-account' });
  service.settingsFor = () => ({ ...SETTINGS, model: 'changed-model', effort: 'low',
    codexHome: '/home/changed-codex', accountId: 'changed-account' });
  service.roleFor = (id) => ({ id, name: id, model: 'changed-model', effort: 'low', fastMode: 'on' });
}

test('settled terminal shutdown proof replays under changed provider and role settings without rewriting history', async (t) => {
  const fx = await shutdownFixture(t);
  const proof = await settleShutdownFixture(fx);
  const before = fx.service.getExecution(fx.recovery.attemptId);
  assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE)[0].state, 'failed');
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'released');
  assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, 'settled');
  changeCurrentRoleIdentity(fx.service);

  const replay = await fx.service.prepareTerminalFailure(fx.recovery);

  assert.deepEqual(replay, proof);
  assert.deepEqual(fx.service.getExecution(fx.recovery.attemptId), before);
  assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE)[0].state, 'failed');
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'released');
  assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, 'settled');
  assert.equal(fx.calls(), 1, 'replay must not invoke the provider again');
});

test('terminal shutdown recovery still rejects provider drift before settlement', async (t) => {
  const fx = await shutdownFixture(t);
  fx.service.prepareTerminalShutdown(fx.recovery);
  await fx.stop();
  changeCurrentRoleIdentity(fx.service);
  const attemptState = fx.store.listAttempts(PROJECT, OBJECTIVE)[0].state;
  const executorState = fx.executor.getAttempt(fx.recovery.attemptId).state;

  await assert.rejects(fx.service.prepareTerminalFailure(fx.recovery), { code: 'delivery_role_recovery_proof_unavailable' });

  assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE)[0].state, attemptState);
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
  assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, executorState);
  assert.equal(fx.service.getExecution(fx.recovery.attemptId).terminalShutdown.phase, 'prepared');
  assert.equal(fx.calls(), 1);
});

for (const defect of ['cleanup receipt', 'terminal proof digest']) {
  test(`settled terminal shutdown replay refuses a tampered ${defect}`, async (t) => {
    const fx = await shutdownFixture(t);
    await settleShutdownFixture(fx);
    const record = fx.service.getExecution(fx.recovery.attemptId);
    if (defect === 'cleanup receipt') record.execution.cleanupReceipt.turnId = 'tampered-turn';
    else record.terminalShutdown.digest = `sha256:${'0'.repeat(64)}`;
    fx.db.prepare('UPDATE delivery_role_executions SET record_json=? WHERE attempt_id=?')
      .run(JSON.stringify(record), fx.recovery.attemptId);
    changeCurrentRoleIdentity(fx.service);

    await assert.rejects(fx.service.prepareTerminalFailure(fx.recovery));

    assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE)[0].state, 'failed');
    assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'released');
    assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, 'settled');
    assert.equal(fx.calls(), 1);
  });
}

test('terminal failure requires independent original group death, preserves drift and replays executor closure', async (t) => {
  const fx = await shutdownFixture(t);
  const prepared = fx.service.prepareTerminalShutdown(fx.recovery);
  assert.equal(prepared.phase, 'prepared');
  await assert.rejects(fx.service.prepareTerminalFailure(fx.recovery), { code: 'delivery_role_shutdown_process_alive' });
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
  fs.writeFileSync(path.join(fx.workspace, 'source.txt'), 'shared drift\n');
  fs.writeFileSync(path.join(fx.workspace, '.gitignore'), '.venv/\n');
  fs.mkdirSync(path.join(fx.workspace, '.venv'));
  fs.symlinkSync(process.execPath, path.join(fx.workspace, '.venv', 'runtime'));
  await fx.stop();
  const proof = await fx.service.prepareTerminalFailure(fx.recovery);
  assert.equal(proof.noEffect, undefined);
  const record = fx.service.getExecution(fx.recovery.attemptId);
  assert.equal(record.result.output.state, 'not_published');
  assert.equal(record.terminalShutdown.drift.changed, true);
  assert.equal(record.report.summary.includes('Implementation completed.'), true);
  assert.equal(fs.readFileSync(path.join(fx.lanes.store.get(record.laneId).path, 'source.txt'), 'utf8'), 'private terminal evidence\n');
  fx.store.requestLifecycleRecovery(PROJECT, OBJECTIVE, 0);
  // Simulate death after store settlement and before executor bookkeeping.
  fx.store.reconcileAttempt(PROJECT, OBJECTIVE, fx.recovery.attemptId, fx.recovery.fencingToken, proof);
  assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, 'submitted');
  assert.equal(fx.executor.reconcileTerminalFailure(fx.recovery).state, 'failed');
  assert.equal(fx.executor.reconcileTerminalFailure(fx.recovery).duplicate, true);
  assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, 'settled');
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM task_executor_thread_reservations').get().n, 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM delivery_output_publications').get().n, 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM candidate_intents').get().n, 0);
  assert.equal(fx.calls(), 1);
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), 'shared drift\n');
});

for (const defect of ['receipt', 'receipt-generation', 'receipt-turn', 'escaped', 'owner', 'request', 'settings', 'publication']) {
  test(`shutdown terminal failure denies ${defect}`, async (t) => {
    const fx = await shutdownFixture(t);
    const record = fx.service.getExecution(fx.recovery.attemptId);
    if (defect === 'receipt') delete record.execution.cleanupReceipt;
    if (defect === 'receipt-generation') record.execution.cleanupReceipt.generation += 1;
    if (defect === 'receipt-turn') record.execution.cleanupReceipt.turnId = 'unrelated';
    if (defect === 'escaped') record.execution.escapedProcesses = [{ pid: 1234 }];
    if (defect === 'owner') record.ownerGeneration += 1;
    if (defect === 'request') record.requestDigestObserved = 'wrong';
    if (defect === 'settings') record.selectedSettings.model = 'wrong';
    if (defect === 'publication') fx.db.prepare("UPDATE delivery_output_bindings SET state='published' WHERE attempt_id=?").run(record.attemptId);
    fx.db.prepare('UPDATE delivery_role_executions SET record_json=? WHERE attempt_id=?').run(JSON.stringify(record), record.attemptId);
    assert.throws(() => fx.service.prepareTerminalShutdown(fx.recovery));
    assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
    assert.equal(fx.calls(), 1);
  });
}

test('shutdown preparation excludes succeeded read-only execution with an actual qualified receipt', async (t) => {
  const fx = await shutdownFixture(t, { role: 'explorer' });
  assert.equal(fx.service.getExecution(fx.recovery.attemptId).execution.cleanupReceipt.completion, 'confirmed');
  assert.equal((await fx.executor.poll(identity(fx))).state, 'succeeded');
  assert.throws(() => fx.service.prepareTerminalShutdown(fx.recovery), { code: 'delivery_role_shutdown_replay_unavailable' });
  assert.equal(fx.store.listAttempts(PROJECT, OBJECTIVE)[0].state, 'succeeded');
  assert.equal(fx.calls(), 1);
});

for (const defect of ['request', 'settings', 'receipt']) {
  test(`shutdown reconciliation revalidates ${defect} after lane completion await`, async (t) => {
    const fx = await shutdownFixture(t);
    fx.service.prepareTerminalShutdown(fx.recovery);
    await fx.stop();
    const complete = fx.lanes.complete.bind(fx.lanes);
    fx.lanes.complete = async (options) => {
      const result = await complete(options);
      const record = fx.service.getExecution(fx.recovery.attemptId);
      if (defect === 'request') record.requestDigestObserved = 'changed-during-await';
      if (defect === 'settings') record.selectedSettings.model = 'changed-during-await';
      if (defect === 'receipt') record.execution.cleanupReceipt.turnId = 'changed-during-await';
      fx.db.prepare('UPDATE delivery_role_executions SET record_json=? WHERE attempt_id=?').run(JSON.stringify(record), record.attemptId);
      return result;
    };
    await assert.rejects(fx.service.prepareTerminalFailure(fx.recovery));
    assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
    assert.equal(fx.executor.getAttempt(fx.recovery.attemptId).state, 'submitted');
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM delivery_output_publications').get().n, 0);
  });
}

test('shutdown writable reconciliation refuses unavailable shared workspace observation', async (t) => {
  const fx = await shutdownFixture(t);
  fx.service.prepareTerminalShutdown(fx.recovery); await fx.stop();
  fs.symlinkSync('/nonexistent-terminal-test-target', path.join(fx.workspace, 'unobservable'));
  await assert.rejects(fx.service.prepareTerminalFailure(fx.recovery), { code: 'symlink_unsupported' });
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
  assert.equal(fx.service.getExecution(fx.recovery.attemptId).terminalShutdown.phase, 'prepared');
});
