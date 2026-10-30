'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexAppServer } = require('../src/codex-app-server');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { CandidateStore } = require('../src/candidate-store');
const { CandidateReviewStore } = require('../src/candidate-review');
const { WriterAdmission } = require('../src/writer-admission');
const { execFileSync } = require('node:child_process');
const { stableDigest } = require('../src/backlog-store');
const { VERSION } = require('../src/delivery-contracts');
const { normalizeSpecialistRequest } = require('../src/contracts');
const { createDeliveryRoleCapabilities, deliveryRequestDigest, scopedExecutionDetails } = require('../src/delivery-role-capabilities');
const { TaskExecutor } = require('../src/task-executor');
const express = require('express');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { registerRoleAgents } = require('../src/a2a-role-service');

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        this.sent.push(message);
        if (message.method === 'initialize') this.respond(message, { userAgent: 'test' });
        if (message.method === 'config/read') this.respond(message, { config: { mcp_servers: {} } });
        if (message.method === 'thread/backgroundTerminals/clean') this.respond(message, {});
        if (message.method === 'thread/start') this.respond(message, { thread: { id: 'provider-thread-1' } });
        if (message.method === 'turn/start') {
          this.respond(message, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
          setImmediate(() => {
            this.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-1' } } })}\n`);
            this.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', text: 'report' } } })}\n`);
            this.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed' } } })}\n`);
          });
        }
      }
      callback();
    } });
  }
  respond(request, result) { this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`); }
  kill() { this.exitCode = 0; setImmediate(() => this.emit('exit', 0, 'SIGTERM')); return true; }
}

test('prepareThread creates a physical read-only provider thread without starting a model turn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-thread-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'inherit', profileApi: true, readOnlyProfile: ':read-only',
    writerProfile: ':workspace', approvalPolicy: 'never', approvalsReviewer: 'auto' });
  t.after(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'planner', name: 'Planner', model: 'planning-model', effort: 'high', sandbox: 'read-only',
    instructions: 'Plan carefully.', fastMode: 'off', tools: { mcpServers: [], skills: false } };
  const prepared = await client.prepareThread({ role, cwd, permissionWorkspace: cwd, executionPermissions: 'inherit' });
  assert.equal(prepared.threadId, 'provider-thread-1');
  assert.equal(prepared.model, 'planning-model');
  assert.equal(prepared.effort, 'high');
  assert.equal(prepared.permissionMode, 'inherit');
  assert.equal(prepared.toolPolicy.enforced, true);
  const threadStart = child.sent.find((request) => request.method === 'thread/start');
  assert.equal(threadStart.params.cwd, cwd);
  assert.equal(threadStart.params.permissions, ':read-only');
  assert.equal(threadStart.params.approvalPolicy, 'never');
  assert.equal(threadStart.params.approvalsReviewer, 'auto');
  assert.equal(child.sent.some((request) => request.method === 'turn/start'), false);
  const result = await client.run({ role, cwd, permissionWorkspace: cwd, input: 'Continue planning.',
    threadId: prepared.threadId, executionPermissions: 'inherit' });
  assert.equal(result.status, 'completed');
  const turnStart = child.sent.find((request) => request.method === 'turn/start');
  assert.equal(turnStart.params.model, role.model);
  assert.equal(turnStart.params.effort, role.effort);
  assert.equal(turnStart.params.serviceTierForTurn, 'default');
  assert.equal(turnStart.params.permissions, ':read-only');
  assert.equal(turnStart.params.approvalPolicy, 'never');
  assert.equal(turnStart.params.approvalsReviewer, 'auto');
  assert.equal(child.sent.filter((request) => request.method === 'thread/start').length, 1);
  assert.equal(child.sent.some((request) => request.method === 'thread/settings/update'), false);
});

test('prepared thread and run use the same inherited legacy read-only turn policy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-legacy-thread-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'inherit', profileApi: false,
    sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
  t.after(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'planner', name: 'Planner', model: 'planning-model', effort: 'medium', sandbox: 'read-only',
    tools: { mcpServers: [], skills: false } };
  const prepared = await client.prepareThread({ role, cwd, permissionWorkspace: cwd, executionPermissions: 'inherit' });
  const result = await client.run({ role, cwd, permissionWorkspace: cwd, input: 'Continue.',
    threadId: prepared.threadId, executionPermissions: 'inherit' });
  assert.equal(result.status, 'completed');
  const threadStart = child.sent.find((request) => request.method === 'thread/start');
  const turnStart = child.sent.find((request) => request.method === 'turn/start');
  assert.equal(threadStart.params.sandbox, 'read-only');
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(Object.hasOwn(turnStart.params, 'permissions'), false);
  assert.equal(turnStart.params.approvalPolicy, 'on-request');
  assert.equal(turnStart.params.approvalsReviewer, 'user');
  assert.equal(child.sent.some((request) => request.method === 'thread/settings/update'), false);
});

test('prepared read-only threads stay narrow under inherited full-access and strict modes', async (t) => {
  const scenarios = [
    { name: 'legacy full access', permissionMode: { mode: 'inherit', profileApi: false, sandboxMode: 'danger-full-access',
      approvalPolicy: 'on-request', approvalsReviewer: 'user' }, executionPermissions: 'inherit', expectedPolicy: { type: 'readOnly', networkAccess: false } },
    { name: 'strict', permissionMode: { mode: 'strict', profileApi: false }, executionPermissions: 'strict', expectedPolicy: { type: 'readOnly' } },
  ];
  for (const scenario of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-thread-policy-'));
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const child = new FakeProcess();
    const client = new CodexAppServer({ spawnImpl: () => child });
    client.resolveExecutionPermissions = async () => scenario.permissionMode;
    t.after(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const role = { id: 'planner', name: 'Planner', model: 'planning-model', effort: 'medium', sandbox: 'read-only',
      tools: { mcpServers: [], skills: false } };
    const prepared = await client.prepareThread({ role, cwd, permissionWorkspace: cwd, executionPermissions: scenario.executionPermissions });
    const result = await client.run({ role, cwd, permissionWorkspace: cwd, input: 'Use prepared thread.',
      threadId: prepared.threadId, executionPermissions: scenario.executionPermissions });
    assert.equal(result.status, 'completed', scenario.name);
    const turnStart = child.sent.find((request) => request.method === 'turn/start');
    assert.deepEqual(turnStart.params.sandboxPolicy, scenario.expectedPolicy, scenario.name);
    assert.equal(Object.hasOwn(turnStart.params, 'permissions'), false, scenario.name);
    assert.equal(child.sent.some((request) => request.method === 'thread/settings/update'), false, scenario.name);
  }
});

function scopedCapability(root, { executionPermissions = 'inherit' } = {}) {
  const workspace = path.join(root, 'workspace');
  const scratchParent = path.join(root, 'private');
  fs.mkdirSync(workspace, { recursive: true });
  const db = new Database(':memory:');
  const store = new BacklogStore(db, { selectedSettingsResolver: () => ({ model: 'review-model' }),
    roleCapacities: { verifier: 1 }, maxActiveTurns: 2, plannerReservedSlots: 0 });
  store.createObjective({ schemaVersion: VERSION, projectId: 'p', objectiveId: 'o', sessionId: 's', engineVersion: 'delivery-v1',
    goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const task = { schemaVersion: VERSION, projectId: 'p', objectiveId: 'o', taskId: 'review-task', revision: 1, role: 'verifier', kind: 'review',
    objective: 'Review the frozen candidate.', priority: 0, dependencies: [], productWritePaths: [],
    readScope: { kind: 'unknown', paths: null, reason: 'Review candidate.' }, scratchWriteRoots: ['review-scratch'], resourceClaims: [],
    publicationAuthority: { state: 'denied', reason: 'review_task', authorityRevision: 1 }, state: 'queued',
    checkpointId: 'checkpoint', baseCandidateId: 'candidate' };
  store.applyPlan('p', 'o', { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1,
    expectedControlRevision: 1, nextPlanRevision: 1, tasks: [{ task }], dependencies: [] });
  const [{ task: claimedTask, attempt: originalAttempt, claim }] = store.claimReady('p', 'o', 0, { controlRevision: 1 });
  store.pinSelectedSettings('p', 'o', originalAttempt.attemptId, claim.fencingToken, { model: 'review-model' });
  const attempt = store.listAttempts('p', 'o').find((row) => row.attemptId === originalAttempt.attemptId);
  let candidateContent = 'frozen';
  let boundThread = null;
  let receiptCommand = null;
  const review = {
    bindClaimedAttempt() { return true; },
    prepareReviewInput(taskId, destination) {
      assert.equal(taskId, claimedTask.taskId);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(destination, 'input.txt'), candidateContent, { mode: 0o444 });
      return { taskId, candidateId: 'candidate', contextId: 'review-context', inputManifestDigest: 'd'.repeat(64), destination };
    },
    verifyReviewInput(prepared) { return fs.readFileSync(path.join(prepared.destination, 'input.txt'), 'utf8') === candidateContent; },
    pinObservedThread(input) { boundThread = input.threadId; return boundThread; },
    settleReceipt(input) { receiptCommand = input; return { state: 'settled', receiptId: 'host-receipt' }; },
  };
  const request = normalizeSpecialistRequest({ objective: claimedTask.objective, allowedFiles: [] },
    { id: 'verifier', name: 'verifier', sandbox: 'workspace-write' });
  const requestDigest = deliveryRequestDigest({ request, settingsDigest: attempt.selectedSettingsDigest, taskDigest: attempt.contractDigest });
  const resolver = createDeliveryRoleCapabilities({ backlogStore: store, candidateReview: review, projectWorkspaceFor: () => workspace,
    executionPermissions,
    scratchRootFor: ({ attemptId }) => path.join(scratchParent, attemptId) });
  const identity = { projectId: 'p', objectiveId: 'o', taskId: claimedTask.taskId,
    attemptId: attempt.attemptId, fencingToken: claim.fencingToken, providerContextId: attempt.providerContextId,
    requestDigest, request, role: 'verifier' };
  const capability = resolver.resolveVerifierCapability(identity, request);
  return { db, store, resolver, capability, workspace, request, identity, task: claimedTask, attempt, claim,
    details: scopedExecutionDetails(capability), get boundThread() { return boundThread; }, get receiptCommand() { return receiptCommand; } };
}

function realReviewFixture(root, reviewerCount = 1) {
  const workspace = path.join(root, 'product');
  fs.mkdirSync(workspace, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Review Harness'); git('config', 'user.email', 'review@example.invalid');
  fs.writeFileSync(path.join(workspace, 'input.txt'), 'candidate input\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const db = new Database(path.join(root, 'review.sqlite'));
  const now = Date.now();
  const requirements = 'a'.repeat(64);
  const checksDigest = 'b'.repeat(64);
  const environmentDigest = 'c'.repeat(64);
  const settings = { model: 'review-model', effort: 'low' };
  const backlogStore = new BacklogStore(db, { now: () => now, selectedSettingsResolver: () => settings,
    roleCapacities: { verifier: reviewerCount, engineer: 1 }, maxActiveTurns: reviewerCount + 3, plannerReservedSlots: 1 });
  backlogStore.createObjective({ schemaVersion: VERSION, projectId: 'review-project', objectiveId: 'review-objective',
    sessionId: 'review-session', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: `sha256:${requirements}`,
    checksDigest: `sha256:${checksDigest}`, authorityRevision: 2, controlRevision: 4, disposition: 'executing' });
  const candidateStore = new CandidateStore({ db, workspace, storageDir: path.join(root, 'candidate-state') });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-frozen', projectId: 'review-project', objectiveId: 'review-objective',
    integrationGeneration: 1, sourceAttemptId: 'source-attempt', environmentDigest, checkIdentity: 'check-set' });
  const bytes = fs.readFileSync(path.join(workspace, 'input.txt'));
  const manifestEntry = { path: 'input.txt', digest: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
  const reviewFacts = new Map();
  const reviewStore = new CandidateReviewStore({ db, candidateStore,
    currentObjective: () => ({ projectId: 'review-project', objectiveId: 'review-objective', goalRevision: 1,
      requirementDigest: requirements, checksDigest, authorityRevision: 2, controlRevision: 4 }),
    checkpointInventory: () => [{ projectId: 'review-project', objectiveId: 'review-objective', checkpointId: 'checkpoint-review' }],
    authorizeCheckpoint: () => true, authorizeProposal: () => true, authorizeBinding: () => true, authorizeThread: () => true,
    authorizeSettlement: () => true, attestClosure: () => ({ known: true, readManifest: [manifestEntry], checkpointAncestors: [] }),
    resolveAttempt: ({ attemptId }) => reviewFacts.get(attemptId) || null,
    verifyReviewExecution: ({ attempt }) => attempt.effect?.effectsSettled === true,
  });
  reviewStore.registerCheckpoint({ projectId: 'review-project', objectiveId: 'review-objective', checkpointId: 'checkpoint-review',
    kind: 'risk_change', reason: 'Review frozen candidate input', checkIdentity: 'check-set', checkPins: ['check-v1'],
    toolPins: ['tool-v1'], profilePins: ['profile-v1'], environmentDigest }, { source: 'owner' });
  const proposals = reviewStore.proposeReviews({ projectId: 'review-project', objectiveId: 'review-objective',
    checkpointId: 'checkpoint-review', candidateId: candidate.candidateId,
    reviewers: Array.from({ length: reviewerCount }, (_, index) => ({ role: 'verifier', taskId: `review-task-${index}` })) }, { source: 'planner' });
  const objective = backlogStore.getObjective('review-project', 'review-objective');
  backlogStore.applyPlan('review-project', 'review-objective', { schemaVersion: VERSION, expectedPlanRevision: objective.planRevision,
    expectedGoalRevision: objective.goalRevision, expectedAuthorityRevision: objective.authorityRevision,
    expectedControlRevision: objective.controlRevision, nextPlanRevision: objective.planRevision + 1,
    tasks: proposals.map(({ task }) => ({ task })), dependencies: [] });
  const claimed = backlogStore.claimReady('review-project', 'review-objective', objective.ownerGeneration,
    { controlRevision: objective.controlRevision, limit: reviewerCount });
  const capabilities = createDeliveryRoleCapabilities({ backlogStore, candidateReview: reviewStore,
    projectWorkspaceFor: () => workspace,
    scratchRootFor: ({ attemptId }) => path.join(root, 'attempt-scratch', attemptId) });
  return { db, workspace, backlogStore, candidateStore, candidate, reviewStore, reviewFacts, proposals, claimed, capabilities, settings };
}

test('TaskExecutor resolves verifier capability and sends only durable lookup metadata', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-task-send-'));
  const fx = scopedCapability(root);
  t.after(() => { fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let sent;
  const executor = new TaskExecutor({ backlogStore: fx.store, db: fx.db,
    transportFor: async () => ({ async sendMessage({ message }) { sent = message; return { id: 'external-task', contextId: message.contextId,
      metadata: { attemptId: message.metadata.attemptId }, artifacts: [{ metadata: { threadId: 'a2a-provider-thread' } }] }; }, async findByContext() { return null; } }),
    settingsFor: async () => ({ model: 'review-model' }),
    roleFor: () => ({ id: 'verifier', sandbox: 'workspace-write' }),
    requestAdapter: () => ({ request: fx.request }), resultAdapter: async () => ({ result: { state: 'failed' }, evidence: {
      remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['host:failed-turn'],
    } }),
    receiptAdapter: async ({ attempt, remote, deliveryCapability }) => {
      assert.equal(attempt.state, 'failed');
      assert.equal(fx.store.listClaims('p', 'o').find((claim) => claim.attemptId === attempt.attemptId).state, 'released');
      assert.equal(remote.artifacts.at(-1).metadata.verifierExecution.providerThreadId, 'a2a-provider-thread');
      return scopedExecutionDetails(deliveryCapability).settleReviewReceipt('failed', ['host:failed-turn']);
    },
    resolveVerifierCapability: fx.resolver.resolveVerifierCapability });
  const result = await executor.execute({ projectId: 'p', objectiveId: 'o', taskId: fx.task.taskId,
    attemptId: fx.attempt.attemptId, fencingToken: fx.claim.fencingToken });
  assert.equal(result.state, 'submitted');
  assert.deepEqual(JSON.parse(sent.parts[0].content.value).allowedFiles, []);
  assert.deepEqual({ projectId: sent.metadata.projectId, objectiveId: sent.metadata.objectiveId, taskId: sent.metadata.taskId,
    attemptId: sent.metadata.attemptId, fencingToken: sent.metadata.fencingToken, providerContextId: sent.metadata.providerContextId },
  { projectId: 'p', objectiveId: 'o', taskId: fx.task.taskId, attemptId: fx.attempt.attemptId,
    fencingToken: fx.claim.fencingToken, providerContextId: fx.attempt.providerContextId });
  assert.equal(sent.metadata.capabilityId, fx.details.capabilityId);
  assert.equal(Object.hasOwn(JSON.parse(sent.parts[0].content.value), 'capabilityId'), false);
  const record = JSON.parse(fx.db.prepare('SELECT record_json FROM task_executor_attempts WHERE attempt_id=?').get(fx.attempt.attemptId).record_json);
  assert.equal(record.observedThreadId, 'a2a-provider-thread');
  const settled = await executor.acceptTerminal({ projectId: 'p', objectiveId: 'o', taskId: fx.task.taskId,
    attemptId: fx.attempt.attemptId, fencingToken: fx.claim.fencingToken }, {
    id: 'external-task', contextId: fx.attempt.providerContextId, threadId: 'a2a-provider-thread',
    metadata: { attemptId: fx.attempt.attemptId }, status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ metadata: { verifierExecution: { providerThreadId: 'a2a-provider-thread' } } }],
  });
  assert.deepEqual(settled.receipt, { state: 'settled', receiptId: 'host-receipt' });
  assert.deepEqual(fx.receiptCommand, { taskId: fx.task.taskId, outcome: 'failed', evidenceRefs: ['host:failed-turn'] });
});

test('configured A2A verifier independently resolves the claim and skips workspace writer admission', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-a2a-admission-'));
  const fx = scopedCapability(root);
  t.after(() => { fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let invocation;
  const appServer = { async run(options) {
    const details = scopedExecutionDetails(options.deliveryCapability);
    invocation = { cwd: options.cwd, permissionWorkspace: options.permissionWorkspace, details };
    return { status: 'completed', text: 'not a structured report', threadId: 'a2a-provider-thread',
      execution: { turnTerminal: true, turnStartSent: true, turnStartRejected: false } };
  } };
  const app = express();
  const role = { name: 'Verifier', description: 'Reviews frozen candidates.', instructions: 'Review.', model: 'review-model',
    effort: 'low', sandbox: 'workspace-write', tools: { mcpServers: [], skills: false } };
  const agents = registerRoleAgents(app, { roles: new Map([['verifier', role]]), appServer,
    workspace: fx.workspace, baseUrl: 'http://127.0.0.1:7777', resolveVerifierCapability: fx.resolver.resolveVerifierCapability });
  const metadata = { projectId: fx.identity.projectId, objectiveId: fx.identity.objectiveId, taskId: fx.identity.taskId,
    attemptId: fx.identity.attemptId, fencingToken: fx.identity.fencingToken, providerContextId: fx.identity.providerContextId,
    requestDigest: fx.identity.requestDigest, capabilityId: fx.details.capabilityId, productWritePaths: ['forged'],
    scratchWriteRoots: ['/forged'] };
  const message = { messageId: 'scoped-message', contextId: fx.identity.providerContextId, role: 1,
    parts: [{ content: { $case: 'text', value: JSON.stringify(fx.request) } }], metadata };
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  const result = await agents.get('verifier').handler.sendMessage({ message,
    configuration: { returnImmediately: false, acceptedOutputModes: ['text/plain'] } }, context);
  assert.equal(result.status.state, 3);
  assert.ok(invocation, JSON.stringify(result.status?.message?.metadata));
  assert.equal(invocation.cwd, fx.details.scratchRoot);
  assert.equal(invocation.permissionWorkspace, fx.workspace);
  assert.equal(invocation.details.candidateId, 'candidate');
  assert.equal(invocation.details.verifyCandidate(), true);
  assert.equal(fx.boundThread, 'a2a-provider-thread');
  assert.equal(result.artifacts.at(-1).metadata.threadId, 'a2a-provider-thread');
  assert.deepEqual(result.artifacts.at(-1).metadata.verifierExecution, {
    capabilityId: fx.details.capabilityId,
    taskId: fx.identity.taskId,
    attemptId: fx.identity.attemptId,
    candidateId: 'candidate',
    inputManifestDigest: 'd'.repeat(64),
    candidateVerified: true,
    providerThreadId: 'a2a-provider-thread',
    execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity: null },
  });
});

test('TaskExecutor to configured verifier to CandidateReview settles a candidate-bound receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-receipt-join-'));
  const fx = realReviewFixture(root);
  t.after(() => { fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const app = express();
  const role = { name: 'Verifier', description: 'Reviews frozen candidates.', instructions: 'Review.', model: 'review-model',
    effort: 'low', sandbox: 'workspace-write', tools: { mcpServers: [], skills: false } };
  const appServer = { async run(options) {
    const details = scopedExecutionDetails(options.deliveryCapability);
    assert.equal(options.cwd, details.scratchRoot);
    assert.equal(options.permissionWorkspace, fx.workspace);
    assert.equal(details.candidateId, fx.candidate.candidateId);
    assert.equal(details.inputManifestDigest, fx.candidate.manifestDigest);
    assert.equal(details.verifyCandidate(), true);
    return { status: 'completed', text: JSON.stringify({ outcome: 'completed', summary: 'No issues found.', filesChanged: [],
      filesInspected: ['input.txt'], checks: [{ command: 'check-v1', detail: 'Passed.', result: 'passed' }], risks: [], scopeExpansion: [], decisionRequest: null }),
      threadId: 'provider-thread-review', execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true,
        processIdentity: { pid: 123, startTime: 'fake-process' } } };
  } };
  const agents = registerRoleAgents(app, { roles: new Map([['verifier', role]]), appServer, workspace: fx.workspace,
    baseUrl: 'http://127.0.0.1:7777', resolveVerifierCapability: fx.capabilities.resolveVerifierCapability });
  const endpoint = agents.get('verifier').handler;
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  let receiptAttempt = null;
  const [{ task, attempt, claim }] = fx.claimed;
  const executor = new TaskExecutor({ backlogStore: fx.backlogStore, db: fx.db,
    transportFor: async () => ({
      async sendMessage({ message }) {
        const response = await endpoint.sendMessage({ message,
          configuration: { returnImmediately: false, acceptedOutputModes: ['text/plain'] } }, context);
        return { ...response, contextId: message.contextId,
          metadata: { ...(response.metadata || {}), attemptId: message.metadata.attemptId } };
      },
      async findByContext() { return null; },
    }),
    settingsFor: async () => fx.settings,
    roleFor: () => ({ id: 'verifier', sandbox: 'workspace-write' }),
    requestAdapter: ({ task: contract }) => ({ request: { objective: contract.objective, allowedFiles: [] } }),
    resultAdapter: async ({ remote }) => {
      const artifact = remote.artifacts.find((entry) => entry.metadata?.contract === 'worker-report/v1');
      assert.ok(artifact, JSON.stringify(remote.artifacts?.map((entry) => ({ name: entry.name, metadata: entry.metadata }))));
      const proof = artifact?.metadata?.verifierExecution;
      assert.equal(proof.candidateId, fx.candidate.candidateId);
      assert.equal(proof.inputManifestDigest, fx.candidate.manifestDigest);
      assert.equal(proof.candidateVerified, true);
      assert.equal(proof.execution.turnTerminal, true);
      assert.equal(proof.providerThreadId, 'provider-thread-review');
      const report = JSON.parse(artifact.parts[0].content.value);
      assert.equal(report.outcome, 'completed');
      return { result: { state: 'succeeded', trusted: true, output: 'review complete' }, evidence: {
        remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true,
        evidenceRefs: ['host:appserver-terminal', 'report:validated'],
      } };
    },
    resolveVerifierCapability: fx.capabilities.resolveVerifierCapability,
    receiptAdapter: async ({ task: settledTask, attempt: settledAttempt, remote, deliveryCapability }) => {
      assert.equal(settledTask.taskId, task.taskId);
      assert.equal(settledAttempt.state, 'succeeded');
      const proof = remote.artifacts.find((entry) => entry.metadata?.verifierExecution).metadata.verifierExecution;
      receiptAttempt = { projectId: settledAttempt.projectId, objectiveId: settledAttempt.objectiveId, taskId: settledTask.taskId,
        attemptId: settledAttempt.attemptId, role: settledTask.role, threadId: proof.providerThreadId,
        claimId: claim.claimId, fencingToken: settledAttempt.fencingToken, ownerGeneration: claim.ownerGeneration,
        selectedSettingsDigest: settledAttempt.selectedSettingsDigest, providerContextId: settledAttempt.providerContextId,
        candidateId: task.baseCandidateId, state: settledAttempt.state, inputManifestDigest: proof.inputManifestDigest,
        checksPassed: true, productWrites: [], outcome: settledAttempt.outcome,
        effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } };
      fx.reviewFacts.set(settledAttempt.attemptId, receiptAttempt);
      return scopedExecutionDetails(deliveryCapability).settleReviewReceipt('passed', ['host:appserver-terminal', 'report:validated']);
    },
  });
  const result = await executor.execute({ projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
    attemptId: attempt.attemptId, fencingToken: claim.fencingToken });
  assert.equal(result.state, 'submitted');
  const terminal = await endpoint.getTask({ id: result.externalTaskId }, context);
  const accepted = await executor.acceptTerminal({ projectId: task.projectId, objectiveId: task.objectiveId,
    taskId: task.taskId, attemptId: attempt.attemptId, fencingToken: claim.fencingToken }, terminal);
  assert.equal(accepted.state, 'succeeded');
  assert.equal(accepted.receipt.outcome, 'passed');
  assert.equal(accepted.receipt.candidateId, fx.candidate.candidateId);
  assert.equal(accepted.receipt.inputManifestDigest, fx.candidate.manifestDigest);
  assert.equal(accepted.receipt.role, 'verifier');
  assert.equal(receiptAttempt.productWrites.length, 0);
  assert.equal(fx.reviewStore.getReceipt(accepted.receipt.receiptId).receiptId, accepted.receipt.receiptId);
  assert.equal(fx.backlogStore.listAttempts(task.projectId, task.objectiveId).find((entry) => entry.attemptId === attempt.attemptId).state, 'succeeded');
});

test('acknowledgement-first configured A2A execution rechecks the mapped running attempt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-ack-first-'));
  const fx = realReviewFixture(root);
  t.after(() => { fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let releaseResolver;
  const resolverGate = new Promise((resolve) => { releaseResolver = resolve; });
  let resolverEntered;
  const enteredResolver = new Promise((resolve) => { resolverEntered = resolve; });
  let appServerReached;
  const appRun = new Promise((resolve) => { appServerReached = resolve; });
  let expectedExternalTaskId = null;
  let runCount = 0;
  const appServer = { async run(options) {
    runCount += 1;
    const details = scopedExecutionDetails(options.deliveryCapability);
    details.assertCurrent();
    const stored = fx.backlogStore.listAttempts('review-project', 'review-objective').find((row) => row.attemptId === details.attemptId);
    assert.equal(stored.state, 'running');
    assert.equal(stored.externalTaskId, expectedExternalTaskId);
    appServerReached();
    return { status: 'completed', text: JSON.stringify({ outcome: 'completed', summary: 'Reviewed.', filesChanged: [],
      filesInspected: ['input.txt'], checks: [{ command: 'check-v1', detail: 'Passed.', result: 'passed' }],
      risks: [], scopeExpansion: [], decisionRequest: null }), threadId: 'ack-first-provider-thread',
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity: { pid: 456 } } };
  } };
  const role = { name: 'Verifier', description: 'Reviews frozen candidates.', instructions: 'Review.', model: 'review-model',
    effort: 'low', sandbox: 'workspace-write', tools: { mcpServers: [], skills: false } };
  const a2aResolver = async (claim, request) => {
    resolverEntered();
    await resolverGate;
    return fx.capabilities.resolveVerifierCapability(claim, request);
  };
  const agents = registerRoleAgents(express(), { roles: new Map([['verifier', role]]), appServer, workspace: fx.workspace,
    baseUrl: 'http://127.0.0.1:7777', resolveVerifierCapability: a2aResolver });
  const handler = agents.get('verifier').handler;
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  const [{ task, attempt, claim }] = fx.claimed;
  const executor = new TaskExecutor({ backlogStore: fx.backlogStore, db: fx.db,
    transportFor: async () => ({
      async sendMessage({ message }) {
        const response = await handler.sendMessage({ message,
          configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain'] } }, context);
        return { ...response, contextId: message.contextId,
          metadata: { ...(response.metadata || {}), attemptId: message.metadata.attemptId } };
      },
      async findByContext() { return null; },
    }),
    settingsFor: async () => fx.settings,
    roleFor: () => ({ id: 'verifier', sandbox: 'workspace-write' }),
    requestAdapter: ({ task: contract }) => ({ request: { objective: contract.objective, allowedFiles: [] } }),
    resultAdapter: async () => ({ result: { state: 'failed' }, evidence: {
      remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['host:unused'],
    } }),
    resolveVerifierCapability: fx.capabilities.resolveVerifierCapability });
  const submittedPromise = executor.execute({ projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
    attemptId: attempt.attemptId, fencingToken: claim.fencingToken });
  await enteredResolver;
  const submitted = await submittedPromise;
  expectedExternalTaskId = submitted.externalTaskId;
  assert.equal(submitted.state, 'submitted');
  const running = fx.backlogStore.listAttempts(task.projectId, task.objectiveId).find((row) => row.attemptId === attempt.attemptId);
  assert.equal(running.state, 'running');
  assert.equal(running.externalTaskId, submitted.externalTaskId);
  releaseResolver();
  await appRun;
  assert.equal(runCount, 1);
  let remote;
  for (let index = 0; index < 30; index += 1) {
    remote = await handler.getTask({ id: submitted.externalTaskId }, context);
    if ([3, 4, 5].includes(remote.status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(remote.status.state, 3);
});

test('independent scoped reviews overlap while a product writer reservation remains held', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-review-overlap-'));
  const fx = realReviewFixture(root, 2);
  t.after(() => { fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const admission = new WriterAdmission({ db: fx.db, workspace: fx.workspace });
  const writer = await admission.acquire({ role: 'engineer', taskId: 'active-product-writer', contextId: 'writer-context' });
  assert.equal(admission.holder().executionId, writer.executionId);
  let releaseRuns;
  const runGate = new Promise((resolve) => { releaseRuns = resolve; });
  let resolveBothStarted;
  const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });
  const calls = [];
  const appServer = { async run(options) {
    const details = scopedExecutionDetails(options.deliveryCapability);
    calls.push(details);
    if (calls.length === 2) resolveBothStarted();
    await runGate;
    return { status: 'completed', text: JSON.stringify({ outcome: 'completed', summary: 'Reviewed.', filesChanged: [],
      filesInspected: ['input.txt'], checks: [{ command: 'check-v1', detail: 'Passed.', result: 'passed' }],
      risks: [], scopeExpansion: [], decisionRequest: null }), threadId: `thread-${details.attemptId}`,
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity: { pid: 321 } } };
  } };
  const role = { name: 'Verifier', description: 'Reviews frozen candidates.', instructions: 'Review.', model: 'review-model',
    effort: 'low', sandbox: 'workspace-write', tools: { mcpServers: [], skills: false } };
  const agents = registerRoleAgents(express(), { roles: new Map([['verifier', role]]), appServer, workspace: fx.workspace,
    baseUrl: 'http://127.0.0.1:7777', admission, resolveVerifierCapability: fx.capabilities.resolveVerifierCapability });
  const handler = agents.get('verifier').handler;
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  const sends = fx.claimed.map(({ task, attempt, claim }) => {
    const request = normalizeSpecialistRequest({ objective: task.objective, allowedFiles: [] },
      { id: 'verifier', name: 'Verifier', sandbox: 'workspace-write' });
    const requestDigest = deliveryRequestDigest({ request, settingsDigest: attempt.selectedSettingsDigest, taskDigest: attempt.contractDigest });
    const capability = fx.capabilities.resolveVerifierCapability({ projectId: task.projectId, objectiveId: task.objectiveId,
      taskId: task.taskId, attemptId: attempt.attemptId, fencingToken: claim.fencingToken,
      providerContextId: attempt.providerContextId, requestDigest, request, role: 'verifier' }, request);
    const message = { messageId: `message-${task.taskId}`, contextId: attempt.providerContextId, role: 1,
      parts: [{ content: { $case: 'text', value: JSON.stringify(request) } }],
      metadata: { projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
        attemptId: attempt.attemptId, fencingToken: claim.fencingToken, providerContextId: attempt.providerContextId,
        requestDigest, capabilityId: capability.capabilityId } };
    return handler.sendMessage({ message, configuration: { returnImmediately: false, acceptedOutputModes: ['text/plain'] } }, context);
  });
  await Promise.race([bothStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('two scoped reviews did not overlap')), 1500))]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].scratchRoot, calls[1].scratchRoot);
  assert.equal(admission.holder().executionId, writer.executionId);
  admission.release(writer.executionId);
  releaseRuns();
  const results = await Promise.all(sends);
  assert.deepEqual(results.map((result) => result.status.state), [3, 3]);
});

test('unknown verifier turn keeps its attempt reservation and scratch for reconciliation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-unknown-run-'));
  const fx = scopedCapability(root);
  t.after(() => { fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let runCount = 0;
  const appServer = { async run() {
    runCount += 1;
    const error = Object.assign(new Error('turn outcome unknown'), { outcomeUnknown: true,
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: false } });
    throw error;
  } };
  const role = { name: 'Verifier', description: 'Reviews frozen candidates.', instructions: 'Review.', model: 'review-model',
    effort: 'low', sandbox: 'workspace-write', tools: { mcpServers: [], skills: false } };
  const agents = registerRoleAgents(express(), { roles: new Map([['verifier', role]]), appServer, workspace: fx.workspace,
    baseUrl: 'http://127.0.0.1:7777', resolveVerifierCapability: fx.resolver.resolveVerifierCapability });
  const handler = agents.get('verifier').handler;
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  const send = (messageId) => handler.sendMessage({ message: { messageId, contextId: fx.identity.providerContextId, role: 1,
    parts: [{ content: { $case: 'text', value: JSON.stringify(fx.request) } }], metadata: {
      projectId: fx.identity.projectId, objectiveId: fx.identity.objectiveId, taskId: fx.identity.taskId,
      attemptId: fx.identity.attemptId, fencingToken: fx.identity.fencingToken,
      providerContextId: fx.identity.providerContextId, requestDigest: fx.identity.requestDigest,
      capabilityId: fx.details.capabilityId,
    } }, configuration: { returnImmediately: false, acceptedOutputModes: ['text/plain'] } }, context);
  const first = await send('unknown-send-one');
  assert.equal(first.status.state, 4);
  const second = await send('unknown-send-two');
  assert.equal(second.status.state, 4);
  assert.equal(runCount, 1);
  assert.equal(fs.existsSync(fx.details.scratchRoot), true);
});

test('scoped verifier run uses only its scratch root and inherited approvals, then pins the provider thread', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-run-'));
  const fx = scopedCapability(root);
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'inherit', profileApi: true, readOnlyProfile: ':read-only',
    writerProfile: ':workspace', approvalPolicy: 'never', approvalsReviewer: 'auto' });
  t.after(async () => { await client.close(); fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'Verifier', model: 'review-model', effort: 'low', sandbox: 'workspace-write',
    instructions: 'Review the frozen candidate.', tools: { mcpServers: [], skills: false } };
  const result = await client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Review.',
    executionPermissions: 'inherit', deliveryCapability: fx.capability });
  const thread = child.sent.find((request) => request.method === 'thread/start').params;
  const turn = child.sent.find((request) => request.method === 'turn/start').params;
  assert.equal(result.status, 'completed');
  assert.equal(result.execution.turnTerminal, true);
  assert.equal(thread.sandbox, 'workspace-write');
  assert.equal(Object.hasOwn(thread, 'permissions'), false);
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.approvalsReviewer, 'auto');
  assert.equal(turn.cwd, fx.details.scratchRoot);
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [fx.details.scratchRoot], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  assert.equal(Object.hasOwn(turn, 'permissions'), false);
  assert.equal(fx.boundThread, 'provider-thread-1');
  assert.equal(fx.details.verifyCandidate(), true);
  await assert.rejects(() => client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Continue.',
    threadId: result.threadId, executionPermissions: 'inherit', deliveryCapability: fx.capability }), { failureClass: 'request_rejected' });
});

test('scoped verifier run permits selected strict mode only with the branded scratch policy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-strict-'));
  const fx = scopedCapability(root, { executionPermissions: 'strict' });
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'strict', profileApi: false, reason: 'strict_setting' });
  t.after(async () => { await client.close(); fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'Verifier', model: 'review-model', effort: 'low', sandbox: 'workspace-write',
    instructions: 'Review the frozen candidate.', tools: { mcpServers: [], skills: false } };
  const result = await client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Review.',
    executionPermissions: 'strict', deliveryCapability: fx.capability });
  const thread = child.sent.find((request) => request.method === 'thread/start').params;
  const turn = child.sent.find((request) => request.method === 'turn/start').params;
  assert.equal(result.status, 'completed');
  assert.equal(thread.sandbox, 'workspace-write');
  assert.equal(thread.approvalPolicy, 'on-request');
  assert.equal(thread.approvalsReviewer, 'user');
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [fx.details.scratchRoot], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  assert.equal(fx.boundThread, 'provider-thread-1');
  fx.details.assertCurrent();
});

test('scoped verifier full-access uses the allowed profile and never approvals while retaining frozen candidate checks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-full-access-'));
  const fx = scopedCapability(root, { executionPermissions: 'full-access' });
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  const resolutions = [];
  client.resolveExecutionPermissions = async (workspace, requested, options) => {
    resolutions.push({ workspace, requested, options });
    return { mode: 'full-access', profileApi: true, writerProfile: ':danger-full-access',
      approvalPolicy: 'never', approvalsReviewer: 'user' };
  };
  t.after(async () => { await client.close(); fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'Verifier', model: 'review-model', effort: 'low', sandbox: 'read-only',
    instructions: 'Review the frozen candidate.', tools: { mcpServers: [], skills: false } };
  const result = await client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Review.',
    executionPermissions: 'full-access', deliveryCapability: fx.capability });
  const thread = child.sent.find((request) => request.method === 'thread/start').params;
  const turn = child.sent.find((request) => request.method === 'turn/start').params;
  assert.equal(result.status, 'completed');
  assert.equal(thread.permissions, ':danger-full-access');
  assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.approvalsReviewer, 'user');
  assert.equal(Object.hasOwn(thread, 'sandboxPolicy'), false);
  assert.equal(turn.permissions, ':danger-full-access');
  assert.equal(turn.approvalPolicy, 'never');
  assert.equal(turn.approvalsReviewer, 'user');
  assert.equal(Object.hasOwn(turn, 'sandboxPolicy'), false);
  assert.equal(turn.cwd, fx.details.scratchRoot);
  assert.ok(resolutions.length >= 2);
  assert.ok(resolutions.every(({ workspace, requested, options }) => workspace === fx.workspace
    && requested === 'full-access' && options?.fresh === true));
  assert.equal(fx.boundThread, 'provider-thread-1');
  assert.equal(fx.details.verifyCandidate(), true);

  fs.chmodSync(path.join(fx.details.candidatePath, 'input.txt'), 0o644);
  fs.writeFileSync(path.join(fx.details.candidatePath, 'input.txt'), 'tampered frozen candidate');
  await assert.rejects(() => client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace,
    input: 'Review tampered candidate.', executionPermissions: 'full-access', deliveryCapability: fx.capability }),
  { code: 'verifier_capability_stale' });
  assert.equal(child.sent.filter((request) => request.method === 'thread/start').length, 1);
  assert.equal(child.sent.filter((request) => request.method === 'turn/start').length, 1);
});

test('scoped verifier rejects inherit when native approvals are unavailable instead of falling back to strict', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-inherit-unavailable-'));
  const fx = scopedCapability(root);
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'strict', profileApi: false, reason: 'native_policy_unavailable' });
  t.after(async () => { await client.close(); fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'Verifier', model: 'review-model', effort: 'low', sandbox: 'workspace-write',
    instructions: 'Review the frozen candidate.', tools: { mcpServers: [], skills: false } };
  await assert.rejects(() => client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Review.',
    executionPermissions: 'inherit', deliveryCapability: fx.capability }), { failureClass: 'request_rejected' });
  assert.equal(child.sent.some((request) => ['thread/start', 'turn/start'].includes(request.method)), false);
});

test('owner pause in onTurnStart prevents the scoped turn from being written', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-revoke-'));
  const fx = scopedCapability(root);
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'inherit', profileApi: true, readOnlyProfile: ':read-only',
    writerProfile: ':workspace', approvalPolicy: 'never', approvalsReviewer: 'auto' });
  t.after(async () => { await client.close(); fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'Verifier', model: 'review-model', effort: 'low', sandbox: 'workspace-write',
    instructions: 'Review the frozen candidate.', tools: { mcpServers: [], skills: false } };
  let outcome;
  try {
    outcome = await client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Review.',
      executionPermissions: 'inherit', deliveryCapability: fx.capability, onTurnStart: () => {
        fx.store.transitionLifecycleControl('p', 'o', { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
      } });
  } catch (error) { outcome = { error, execution: error.execution }; }
  assert.equal(fx.store.getObjective('p', 'o').disposition, 'paused_owner');
  assert.equal(child.sent.filter((request) => request.method === 'thread/start').length, 1);
  assert.equal(child.sent.filter((request) => request.method === 'turn/start').length, 0);
  assert.equal(outcome.execution.turnStartSent, false);
  assert.equal(outcome.execution.turnTerminal, false);
  assert.equal(fx.receiptCommand, null);
  assert.equal(client.runs.size, 0);
});
