'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const { AgentCard } = require('@a2a-js/sdk');
const { ClientFactory, JsonRpcTransportFactory } = require('@a2a-js/sdk/client');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { InMemoryTaskStore } = require('@a2a-js/sdk/server');
const Database = require('better-sqlite3');
const { registerRoleAgents } = require('../src/a2a-role-service');
const { WriterAdmission } = require('../src/writer-admission');
const { UsageLedger } = require('../src/usage-ledger');
const { WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT } = require('../src/contracts');
const { InMemoryStagingLog, StagingLog } = require('../src/staging-log');
const { buildReport } = require('../src/staging-report');

const roles = new Map([
  ['orch-planner', { name: 'Planner', description: 'Plans work.', instructions: 'Plan.', model: 'test', effort: 'low', sandbox: 'read-only' }],
  ['orch-reviewer', { name: 'Reviewer', description: 'Reviews work.', instructions: 'Review.', model: 'test', effort: 'low', sandbox: 'read-only' }],
]);

function makeService(appServer, options = {}) {
  const app = express();
  const mounted = [];
  const originalUse = app.use.bind(app);
  app.use = (path, ...handlers) => {
    mounted.push({ path, middleware: handlers[0], handlers });
    return originalUse(path, ...handlers);
  };
  const agents = registerRoleAgents(app, {
    roles,
    appServer,
    workspace: process.cwd(),
    baseUrl: 'http://127.0.0.1:7777',
    ...options,
  });
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  return { agents, context, mounted };
}

function message(text, parts, metadata) {
  return {
    messageId: `message-${Math.random()}`,
    role: 1,
    parts: parts || [{ content: { $case: 'text', value: text } }],
    ...(metadata ? { metadata } : {}),
  };
}

function sendParams(input, configuration = {}) {
  return {
    message: input,
    configuration: {
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
      ...configuration,
    },
  };
}

function taskResult(result) {
  assert.equal(result?.status?.state !== undefined, true, 'expected a Task result');
  return result;
}

test('publishes distinct role cards and routes each task to its role', async () => {
  const calls = [];
  const { agents, context } = makeService({
    async run(options) {
      calls.push(options);
      return { threadId: 'thread', turnId: 'turn', status: 'completed', text: `from ${options.role.id}: ${options.input}` };
    },
  });

  assert.equal(agents.get('orch-planner').card.name, 'Planner');
  assert.equal(agents.get('orch-planner').card.skills.length, 1);
  assert.ok(agents.get('orch-planner').card.skills.every(({ id }) => id !== 'aut-03-lead-decomposition-v1'));
  assert.deepEqual(agents.get('orch-planner').card.securityRequirements, [{ schemes: { bearerAuth: { list: [] } } }]);
  assert.equal(agents.get('orch-planner').card.securitySchemes.bearerAuth.scheme.$case, 'httpAuthSecurityScheme');
  assert.equal(agents.get('orch-reviewer').card.name, 'Reviewer');
  assert.notEqual(agents.get('orch-planner').handler, agents.get('orch-reviewer').handler);
  const planner = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('draft a plan')), context));
  const reviewer = taskResult(await agents.get('orch-reviewer').handler.sendMessage(sendParams(message('review this')), context));

  assert.equal(planner.status.state, 3);
  assert.equal(reviewer.status.state, 3);
  assert.equal(planner.artifacts[0].parts[0].content.value, 'from orch-planner: draft a plan');
  assert.equal(reviewer.artifacts[0].parts[0].content.value, 'from orch-reviewer: review this');
  assert.deepEqual(calls.map((call) => call.role.id), ['orch-planner', 'orch-reviewer']);
  assert.equal(calls[0].cwd, process.cwd());
});

test('serves a role Agent Card at its direct route before JSON-RPC middleware', async () => {
  const { mounted } = makeService({ async run() { return { status: 'completed', text: '' }; } });
  const cardPath = '/agents/orch-planner/agent-card.json';
  const cardIndex = mounted.findIndex(({ path }) => path === cardPath);
  const rpcIndex = mounted.findIndex(({ path }) => path === '/agents/orch-planner');
  assert.ok(cardIndex >= 0 && rpcIndex >= 0 && cardIndex < rpcIndex);

  const cardRouter = mounted[cardIndex].middleware;
  const getCard = cardRouter.stack.find((layer) => layer.route?.path === '/').route.stack[0].handle;
  const response = {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
  await getCard({ fresh: false }, response);
  assert.equal(response.statusCode, 200);
  const publishedCard = JSON.parse(response.body);
  assert.equal(publishedCard.name, 'Planner');
  const sdkCard = AgentCard.fromJSON(publishedCard);
  assert.equal(sdkCard.securitySchemes.bearerAuth.scheme.$case, 'httpAuthSecurityScheme');
  assert.equal(sdkCard.securitySchemes.bearerAuth.scheme.value.scheme, 'Bearer');
  assert.deepEqual(sdkCard.securityRequirements[0].schemes.bearerAuth.list, []);
});

test('reports App Server errors and unsupported non-text input as failed tasks', async () => {
  let calls = 0;
  const { agents, context } = makeService({
    async run() {
      calls += 1;
      throw new Error('App Server unavailable');
    },
  });
  const handler = agents.get('orch-planner').handler;

  const failed = taskResult(await handler.sendMessage(sendParams(message('fail')), context));
  assert.equal(failed.status.state, 4);
  assert.match(failed.status.message.parts[0].content.value, /App Server unavailable/);

  const unsupported = taskResult(await handler.sendMessage(sendParams(message('', [
    { content: { $case: 'data', value: { prompt: 'not text' } } },
  ])), context));
  assert.equal(unsupported.status.state, 4);
  assert.match(unsupported.status.message.parts[0].content.value, /text parts only/);
  assert.equal(calls, 1, 'unsupported input must not invoke Codex');
});

test('only a completed Codex status maps to A2A completed', async () => {
  for (const codexStatus of ['interrupted', 'working', 'unknown', undefined]) {
    const { agents, context } = makeService({
      async run() { return { status: codexStatus, text: 'unfinished result' }; },
    });
    const result = taskResult(await agents.get('orch-planner').handler.sendMessage(
      sendParams(message(`status ${codexStatus}`)), context,
    ));
    assert.equal(result.status.state, 4, `Codex status ${codexStatus} should fail the A2A task`);
  }
});

test('rejects a second active message for the same task without interrupting the first run', async () => {
  let runCount = 0;
  const { agents, context, mounted } = makeService({
    run({ signal }) {
      runCount += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const handler = agents.get('orch-planner').handler;
  const created = taskResult(await handler.sendMessage(
    sendParams(message('first turn'), { returnImmediately: true }), context,
  ));
  assert.equal(runCount, 1);

  const roleMount = mounted.find(({ path }) => path === '/agents/orch-planner');
  const guard = roleMount.handlers[1];
  let statusCode;
  let responseBody;
  let passedToNext = false;
  guard({
    method: 'POST',
    body: { id: 77, method: 'SendMessage', params: { message: { taskId: created.id } } },
  }, {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return this; },
  }, () => { passedToNext = true; });

  assert.equal(statusCode, 200);
  assert.equal(responseBody.error.code, -32000);
  assert.match(responseBody.error.message, /already executing/);
  assert.equal(passedToNext, false);
  assert.equal(runCount, 1, 'overlapping message must not start another Codex turn');

  await handler.cancelTask({ id: created.id }, context);
  let task;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    task = await handler.getTask({ id: created.id }, context);
    if (task.status.state === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(task.status.state, 5);
});

test('reserves taskId before SDK task-store awaits and lets only the original request complete', async () => {
  const taskId = 'sdk-delay-race-task';
  const contextId = 'sdk-delay-race-context';
  let runCount = 0;
  const { agents, context, mounted } = makeService({
    async run({ input }) {
      runCount += 1;
      return { status: 'completed', text: `completed: ${input}` };
    },
  });
  const handler = agents.get('orch-planner').handler;
  await handler.taskStore.save({
    id: taskId,
    contextId,
    status: { state: 2, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: {},
  }, context);

  const originalLoad = handler.taskStore.load.bind(handler.taskStore);
  let releaseLoad;
  let loadStarted;
  const blockedLoad = new Promise((resolve) => { releaseLoad = resolve; });
  const loadEntered = new Promise((resolve) => { loadStarted = resolve; });
  let delayOneLoad = true;
  handler.taskStore.load = async (id, callContext) => {
    if (id === taskId && delayOneLoad) {
      delayOneLoad = false;
      loadStarted();
      await blockedLoad;
    }
    return originalLoad(id, callContext);
  };

  const guard = mounted.find(({ path }) => path === '/agents/orch-planner').handlers[1];
  const firstMessage = message('finish original');
  firstMessage.taskId = taskId;
  firstMessage.contextId = contextId;
  let firstRequest;
  guard({ method: 'POST', body: { id: 1, method: 'SendMessage', params: { message: firstMessage } } }, {
    once() {},
  }, () => {
    firstRequest = handler.sendMessage(sendParams(firstMessage), context);
  });
  await loadEntered;

  const duplicateMessage = message('duplicate request');
  duplicateMessage.taskId = taskId;
  duplicateMessage.contextId = contextId;
  let rejectedBody;
  guard({ method: 'POST', body: { id: 2, method: 'SendMessage', params: { message: duplicateMessage } } }, {
    status() { return this; },
    json(body) { rejectedBody = body; return this; },
  }, () => assert.fail('overlapping request must be rejected before SDK handling'));
  assert.equal(rejectedBody.error.code, -32000);
  assert.equal(runCount, 0, 'the first App Server call is still behind the SDK task-store await');

  releaseLoad();
  const result = taskResult(await firstRequest);
  assert.equal(result.id, taskId);
  assert.equal(result.status.state, 3);
  assert.equal(result.artifacts[0].parts[0].content.value, 'completed: finish original');
  assert.equal(runCount, 1);
});

test('cancelTask aborts the running Codex request and stores canceled status', async () => {
  let observedAbort = false;
  let finishRun;
  let started;
  const runStarted = new Promise((resolve) => { started = resolve; });
  const { agents, context } = makeService({
    run({ signal }) {
      started();
      return new Promise((resolve) => {
        finishRun = resolve;
        signal.addEventListener('abort', () => {
          observedAbort = true;
        }, { once: true });
      });
    },
  });
  const handler = agents.get('orch-planner').handler;
  const created = taskResult(await handler.sendMessage(
    sendParams(message('wait forever'), { returnImmediately: true }),
    context,
  ));
  await runStarted;
  const cancelPromise = handler.cancelTask({ id: created.id }, context);
  for (let attempt = 0; attempt < 20 && !observedAbort; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(observedAbort, true);
  assert.equal((await handler.getTask({ id: created.id }, context)).status.state, 2,
    'task remains working until Codex confirms its turn has settled');
  finishRun({ status: 'completed', text: 'late completion after abort' });
  const canceled = await cancelPromise;
  assert.equal(canceled.id, created.id);

  let task;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    task = await handler.getTask({ id: created.id }, context);
    if (task.status.state === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(task.status.state, 5);
});

test('cancel publishes exactly one terminal canceled event', async () => {
  let started;
  const runStarted = new Promise((resolve) => { started = resolve; });
  const { agents } = makeService({
    run({ signal }) {
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const executor = agents.get('orch-planner').handler.agentExecutor;
  const events = [];
  const eventBus = { publish(event) { events.push(event); } };
  const execution = executor.execute({
    taskId: 'cancel-once-task',
    contextId: 'cancel-once-context',
    task: undefined,
    userMessage: message('cancel this'),
  }, eventBus);

  await runStarted;
  await executor.cancelTask('cancel-once-task', eventBus);
  await execution;
  const terminalEvents = events.filter((event) => event.kind === 'statusUpdate'
    && [3, 4, 5, 7].includes(event.data.status.state));
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].data.status.state, 5);
});

test('real A2A SDK client exchanges a role card and task over local HTTP', async (t) => {
  const appServer = {
    async run({ role, input }) {
      return { threadId: 'thread', turnId: 'turn', status: 'completed', text: `${role.id}: ${input}` };
    },
  };
  const app = express();
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('sandbox does not permit binding a local HTTP test server');
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  registerRoleAgents(app, { roles, appServer, workspace: process.cwd(), baseUrl });
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
  const client = await factory.createFromUrl(baseUrl, '/agents/orch-planner/agent-card.json');
  const result = taskResult(await client.sendMessage(sendParams(message('check protocol'))));
  assert.equal(result.status.state, 3);
  assert.equal(result.artifacts[0].parts[0].content.value, 'orch-planner: check protocol');
});

function validReport(overrides = {}) {
  return {
    outcome: 'completed', summary: 'done', filesChanged: [], filesInspected: [],
    checks: [], risks: [], scopeExpansion: [], decisionRequest: null, ...overrides,
  };
}

test('passes the worker report schema and tags the result artifact with contract metadata', async () => {
  const calls = [];
  const { agents, context } = makeService({
    async run(options) {
      calls.push(options);
      return { threadId: 'thread-7', status: 'completed', text: JSON.stringify(validReport()) };
    },
  });
  const result = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('go')), context));
  assert.equal(calls[0].outputSchema, WORKER_REPORT_SCHEMA);
  const artifact = result.artifacts[0];
  assert.equal(artifact.parts[0].content.value, JSON.stringify(validReport()));
  assert.equal(artifact.metadata.contract, WORKER_REPORT_CONTRACT);
  assert.deepEqual(artifact.metadata.boundary, { contract: 'legacy' });
  assert.equal(artifact.metadata.threadId, 'thread-7');

  const { agents: other, context: otherContext } = makeService({ async run() { return { status: 'completed', text: 'x' }; } });
  const noThread = taskResult(await other.get('orch-planner').handler.sendMessage(sendParams(message('go')), otherContext));
  assert.equal(noThread.artifacts[0].metadata.threadId, null);
});

test('failed status messages carry failureKind and codexErrorInfo metadata', async () => {
  const cases = [
    { error: Object.assign(new Error('limit'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } }), kind: 'usage_limit', info: 'usageLimitExceeded' },
    { error: new Error('plain', { cause: { rpcData: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } } }), kind: 'usage_limit', info: { httpConnectionFailed: { httpStatusCode: 429 } } },
    { error: Object.assign(new Error('turn interrupted'), { outcomeUnknown: true }), kind: 'interrupted', info: null },
    { error: Object.assign(new Error('turn interrupted at quota'), { outcomeUnknown: true, codexError: { codexErrorInfo: 'usageLimitExceeded' } }), kind: 'usage_limit', info: 'usageLimitExceeded' },
    { error: new Error('plain'), kind: 'other', info: null },
  ];
  for (const { error, kind, info } of cases) {
    const { agents, context } = makeService({ async run() { throw error; } });
    const failed = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('x')), context));
    assert.equal(failed.status.state, 4);
    const { failureKind, codexErrorInfo } = failed.status.message.metadata;
    assert.deepEqual({ failureKind, codexErrorInfo }, { failureKind: kind, codexErrorInfo: info });
  }

  const { agents, context } = makeService({ async run() { return { status: 'interrupted', text: 'partial' }; } });
  const nonCompleted = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('x')), context));
  assert.equal(nonCompleted.status.message.metadata.failureKind, 'other');
  assert.equal(nonCompleted.status.message.metadata.codexErrorInfo, null);

  const { agents: parse, context: parseContext } = makeService({ async run() { return { status: 'completed', text: '' }; } });
  const bad = taskResult(await parse.get('orch-planner').handler.sendMessage(sendParams(message('', [
    { content: { $case: 'data', value: {} } },
  ])), parseContext));
  assert.deepEqual(bad.status.message.metadata, { failureKind: 'other', codexErrorInfo: null });
});

test('maps supervisor_exhausted to its own failureKind with no workspace effects', async () => {
  const cases = [
    Object.assign(new Error('budget exhausted'), { failureClass: 'supervisor_exhausted', outcomeUnknown: false }),
    Object.assign(new Error('budget exhausted'), { code: 'supervisor_exhausted' }),
  ];
  for (const error of cases) {
    const { agents, context } = makeService({ async run() { throw error; } });
    const failed = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('x')), context));
    assert.equal(failed.status.state, 4);
    const metadata = failed.status.message.metadata;
    assert.equal(metadata.failureKind, 'supervisor_exhausted');
    assert.equal(metadata.effects, 'none');
  }
});

test('marks an active writable worker failure with unknown outcome as interrupted', async () => {
  const writerRoles = new Map([
    ['orch-writer', { name: 'Writer', description: 'Writes files.', instructions: 'Implement.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
  ]);
  const { agents, context } = makeService({
    async run() {
      throw Object.assign(new Error('Codex transport closed during the turn'), { outcomeUnknown: true });
    },
  }, { roles: writerRoles });

  const failed = taskResult(await agents.get('orch-writer').handler.sendMessage(sendParams(message('write the change')), context));
  assert.equal(failed.status.state, 4);
  const { writerExecution, ...metadata } = failed.status.message.metadata;
  assert.equal(metadata.failureKind, 'interrupted');
  assert.equal(metadata.codexErrorInfo, null);
  // No turn/start was recorded, so nothing could still be running and the writer reconciles.
  assert.equal(writerExecution.state, 'reconciled');
});

test('uses taskStoreFactory per role and defaults to an in-memory store', async () => {
  const seen = [];
  const stores = new Map();
  const { agents } = makeService({ async run() { return { status: 'completed', text: '' }; } }, {
    taskStoreFactory: (roleId) => {
      seen.push(roleId);
      const store = new InMemoryTaskStore();
      stores.set(roleId, store);
      return store;
    },
  });
  assert.deepEqual(seen, ['orch-planner', 'orch-reviewer']);
  assert.equal(agents.get('orch-planner').handler.taskStore, stores.get('orch-planner'));
  assert.equal(agents.get('orch-reviewer').handler.taskStore, stores.get('orch-reviewer'));
  const { agents: defaults } = makeService({ async run() { return { status: 'completed', text: '' }; } });
  assert.ok(defaults.get('orch-planner').handler.taskStore instanceof InMemoryTaskStore);
});

// ---------------------------------------------------------------- writer admission

const writerRoles = new Map([
  ['orch-writer-a', { name: 'Writer A', description: 'Writes.', instructions: 'Implement.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
  ['orch-writer-b', { name: 'Writer B', description: 'Writes too.', instructions: 'Implement.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
  ['orch-planner', roles.get('orch-planner')],
]);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function makeAdmission(quiescence) {
  return new WriterAdmission({
    db: new Database(':memory:'),
    workspace: process.cwd(),
    snapshot: () => ({ kind: 'unavailable', reason: 'test' }),
    quiescence,
    settleMs: 0,
  });
}

function writerMessage(text, ids = {}) {
  return { ...message(text), ...ids };
}

const okResult = (text = 'done') => ({ threadId: 't', turnId: 'u', status: 'completed', text });

test('shared execution target uses admitted workspace while the default target uses an available lane', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-shared-target-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const laneWorkspace = path.join(workspace, 'lane-workspace');
  const roleMap = new Map([
    ['engineer', { name: 'engineer', description: 'Implements scoped work.', instructions: 'Implement.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
  ]);
  const lane = { id: 'lane-1', path: path.join(workspace, 'lane-1'), workspacePath: laneWorkspace, base: 'base' };
  const laneStore = new Map([[lane.id, lane]]);
  const writerExecution = {
    executionId: null, state: null, reason: null, effects: 'none',
    lane: { id: lane.id, state: 'integrated', reason: null },
    delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
  };
  const laneCalls = { available: 0, prepare: 0, complete: 0 };
  const lanes = {
    store: laneStore,
    async available() { laneCalls.available += 1; return true; },
    async prepare() { laneCalls.prepare += 1; return { lane }; },
    laneInput(_lane, input) { return input; },
    sandboxPolicy() { return { type: 'workspaceWrite', writableRoots: [laneWorkspace], networkAccess: false }; },
    markRunning() {},
    recordTurnStart() {},
    async complete() {
      laneCalls.complete += 1;
      laneStore.delete(lane.id);
      return { canceled: false, writerExecution };
    },
  };
  const admission = makeAdmission({});
  const acquire = admission.acquire.bind(admission);
  let admissions = 0;
  admission.acquire = async (details) => { admissions += 1; return acquire(details); };
  const calls = [];
  const service = makeService({
    async run(options) {
      calls.push(options);
      return okResult(JSON.stringify(validReport()));
    },
  }, { roles: roleMap, workspace, lanes, admission });

  const sharedInput = JSON.stringify({ objective: 'Edit shared workspace.', allowedFiles: ['src'], executionTarget: 'shared' });
  const shared = taskResult(await service.agents.get('engineer').handler.sendMessage(
    sendParams(message(sharedInput)), service.context,
  ));
  assert.equal(shared.status.state, 3, JSON.stringify(shared.status.message?.metadata));
  assert.equal(admissions, 1);
  assert.deepEqual(laneCalls, { available: 0, prepare: 0, complete: 0 });
  assert.equal(calls[0].cwd, workspace);
  assert.equal(calls[0].permissionWorkspace, workspace);
  assert.equal(calls[0].executionPermissions, 'inherit');
  assert.equal(admission.holder(), null);

  const ordinaryInput = JSON.stringify({ objective: 'Use the default isolated target.', allowedFiles: ['src'] });
  const ordinary = taskResult(await service.agents.get('engineer').handler.sendMessage(
    sendParams(message(ordinaryInput)), service.context,
  ));
  assert.equal(ordinary.status.state, 3);
  assert.equal(admissions, 1);
  assert.deepEqual(laneCalls, { available: 1, prepare: 1, complete: 1 });
  assert.equal(calls[1].cwd, laneWorkspace);
  assert.equal(calls[1].permissionWorkspace, workspace);
  assert.equal(calls[1].executionPermissions, 'inherit');
});

test('a second writer on another role waits for the first; a read-only role runs concurrently', async () => {
  const gate = deferred();
  const started = [];
  const { agents, context } = makeService({
    async run(options) {
      started.push(options.role.id);
      if (options.role.id === 'orch-writer-a') await gate.promise;
      return okResult(options.role.id);
    },
  }, { roles: writerRoles, admission: makeAdmission({}) });

  const a = agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a')), context);
  await tick();
  const b = agents.get('orch-writer-b').handler.sendMessage(sendParams(writerMessage('b')), context);
  const planner = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('plan')), context));
  await tick();
  assert.equal(planner.status.state, 3);
  assert.deepEqual(started, ['orch-writer-a', 'orch-planner']);

  gate.resolve();
  const [doneA, doneB] = [taskResult(await a), taskResult(await b)];
  assert.equal(doneA.status.state, 3);
  assert.equal(doneB.status.state, 3);
  assert.deepEqual(started, ['orch-writer-a', 'orch-planner', 'orch-writer-b']);
  assert.equal(doneB.artifacts[0].metadata.writerExecution.state, 'released');
});

test('writers submitted under two different lead contexts and tasks are serialized workspace-wide', async () => {
  // Imitates two lead runs at the role-endpoint level (each lead dispatches with its own context and task ids).
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  const { agents, context } = makeService({
    async run() {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running -= 1;
      return okResult();
    },
  }, { roles: writerRoles, admission: makeAdmission({}) });

  const first = agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('one', { contextId: 'lead-run-1' })), context);
  const second = agents.get('orch-writer-b').handler.sendMessage(sendParams(writerMessage('two', { contextId: 'lead-run-2' })), context);
  await tick(60);
  assert.equal(running, 1);
  gate.resolve();
  assert.equal(taskResult(await first).status.state, 3);
  assert.equal(taskResult(await second).status.state, 3);
  assert.equal(maxRunning, 1);
});

test('an unknown writer outcome blocks the next writer until the process group is proven gone', async () => {
  let gone = false;
  const quiescence = {
    isProcessGroupGone: () => gone,
    killOrphanProcessGroup: () => false,
  };
  const admission = makeAdmission(quiescence);
  let runs = 0;
  const { agents, context } = makeService({
    async run(options) {
      runs += 1;
      if (runs === 1) {
        options.onTurnStart({ processIdentity: { pid: 1, pgid: 1, startTime: 'x' }, threadId: 'thr' });
        throw Object.assign(new Error('timeout'), { outcomeUnknown: true, execution: { turnTerminal: false } });
      }
      return okResult();
    },
  }, { roles: writerRoles, admission, reconcileRetry: { intervalMs: 5, totalMs: 20 } });

  const failed = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a')), context));
  assert.equal(failed.status.state, 4);
  assert.equal(failed.status.message.metadata.failureKind, 'interrupted');
  assert.equal(failed.status.message.metadata.writerExecution.state, 'unresolved');
  assert.equal(admission.holder().state, 'unresolved');

  const blocked = taskResult(await agents.get('orch-writer-b').handler.sendMessage(sendParams(writerMessage('b')), context));
  assert.equal(blocked.status.state, 4);
  assert.equal(blocked.status.message.metadata.failureKind, 'admission_blocked');
  assert.equal(blocked.status.message.metadata.effects, 'none');
  assert.equal(blocked.status.message.metadata.admission.holder.role, 'orch-writer-a');
  assert.equal(runs, 1);

  gone = true;
  const admitted = taskResult(await agents.get('orch-writer-b').handler.sendMessage(sendParams(writerMessage('b2')), context));
  assert.equal(admitted.status.state, 3);
  assert.equal(runs, 2);
  assert.equal(admission.holder(), null);
});

test('a fenced context is refused without running', async () => {
  const admission = makeAdmission({});
  admission.fence('ctx-fenced', 'lead gave up');
  let runs = 0;
  const { agents, context } = makeService({ async run() { runs += 1; return okResult(); } }, { roles: writerRoles, admission });
  const failed = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a', { contextId: 'ctx-fenced' })), context));
  assert.equal(failed.status.state, 4);
  assert.equal(failed.status.message.metadata.failureKind, 'fenced');
  assert.equal(runs, 0);
});

test('canceling a writer while it waits for admission cancels it without running', async () => {
  const gate = deferred();
  const started = [];
  const { agents, context } = makeService({
    async run(options) {
      started.push(options.role.id);
      await gate.promise;
      return okResult();
    },
  }, { roles: writerRoles, admission: makeAdmission({}) });

  const a = agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a')), context);
  await tick();
  const submitted = taskResult(await agents.get('orch-writer-b').handler.sendMessage(
    sendParams(writerMessage('b'), { returnImmediately: true }), context));
  await tick();
  await agents.get('orch-writer-b').handler.cancelTask({ id: submitted.id }, context);
  await tick();
  const canceled = await agents.get('orch-writer-b').handler.getTask({ id: submitted.id }, context);
  assert.equal(canceled.status.state, 5);
  assert.deepEqual(started, ['orch-writer-a']);
  gate.resolve();
  assert.equal(taskResult(await a).status.state, 3);
});

const sampleUsage = () => ({
  model: 'test', effort: 'low', startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 42, turns: 1, modelRequests: null,
  tokens: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, tokenSource: 'total_delta',
  cumulativeTotal: { totalTokens: 12 }, appServerVersion: '1.2.3',
});
const sampleConfig = { sandbox: 'read-only', sandboxPolicy: 'readOnly', approvalPolicy: 'on-request', cwd: process.cwd() };

function ledgerDb() {
  const db = new Database(':memory:');
  return { db, usageLedger: new UsageLedger({ db }) };
}

test('records one worker usage row and attaches usage, permissionEvents, provenance to the artifact', async () => {
  const { db, usageLedger } = ledgerDb();
  const events = [{ type: 'tool', tool: 'commandExecution', status: 'declined' }];
  const { agents, context } = makeService({
    async run() {
      return { ...okResult(JSON.stringify(validReport())), usage: sampleUsage(), permissionEvents: events, permissionConfig: sampleConfig };
    },
  }, { usageLedger });
  const params = sendParams(message('go'));
  const done = taskResult(await agents.get('orch-planner').handler.sendMessage(params, context));
  assert.equal(done.status.state, 3);
  const meta = done.artifacts[0].metadata;
  assert.equal(meta.usage.elapsedMs, 42);
  assert.deepEqual(meta.permissionEvents, events);
  assert.deepEqual(meta.provenance, {
    role: 'orch-planner', sandbox: 'read-only', taskId: done.id, contextId: done.contextId,
    workspace: process.cwd(), permissionConfig: sampleConfig,
  });
  assert.equal(meta.contract, WORKER_REPORT_CONTRACT);
  const rows = usageLedger.listByTask(done.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryId, `orch-planner:${done.id}:u`);
  assert.equal(rows[0].outcome, 'completed');
  assert.deepEqual(rows[0].tokens, sampleUsage().tokens);
  assert.equal(rows[0].retries, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get().n, 1);
});

test('a thrown run error still records a row and carries usage on the failure status', async () => {
  const { usageLedger } = ledgerDb();
  const { agents, context } = makeService({
    async run() {
      const error = new Error('boom');
      error.usage = sampleUsage();
      error.permissionEvents = [{ type: 'hook', status: 'blocked' }];
      error.permissionConfig = sampleConfig;
      throw error;
    },
  }, { usageLedger });
  const failed = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('go')), context));
  assert.equal(failed.status.state, 4);
  const meta = failed.status.message.metadata;
  assert.equal(meta.usage.turns, 1);
  assert.equal(meta.permissionEvents[0].type, 'hook');
  assert.equal(meta.provenance.taskId, failed.id);
  assert.equal(meta.failureKind, 'other');
  const [row] = usageLedger.listByTask(failed.id);
  assert.equal(row.outcome, 'failed');
});

test('missing usage is recorded as nulls with token source unavailable; retries count the context', async () => {
  const { usageLedger } = ledgerDb();
  const { agents, context } = makeService({ async run() { return okResult(); } }, { usageLedger });
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const done = taskResult(await agents.get('orch-planner').handler.sendMessage(
      sendParams(writerMessage('go', { contextId: 'ctx-u3' })), context));
    ids.push(done.id);
  }
  const second = usageLedger.listByTask(ids[1])[0];
  assert.equal(second.tokens, null);
  assert.equal(second.elapsedMs, null);
  assert.equal(second.tokenSource, 'unavailable');
  assert.equal(second.retries, 1);
  assert.equal(usageLedger.listByTask(ids[0])[0].retries, 0);
});

test('a ledger failure never changes the task outcome', async () => {
  const usageLedger = {
    workerRowsForContext() { return 0; },
    record() { throw new Error('disk full'); },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { agents, context } = makeService({ async run() { return okResult(); } }, { usageLedger });
    const done = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('go')), context));
    assert.equal(done.status.state, 3);
    assert.equal(done.artifacts[0].metadata.provenance.role, 'orch-planner');
  } finally {
    console.warn = warn;
  }
});

test('a turn/start rejected by the server (known outcome) releases the writer', async () => {
  const admission = makeAdmission({});
  const { agents, context } = makeService({
    async run(options) {
      options.onTurnStart({ processIdentity: { pid: 1, pgid: 1, startTime: 'x' }, threadId: 'thr' });
      throw Object.assign(new Error('invalid request'), { execution: { turnStartSent: true, turnTerminal: false, turnStartRejected: true } });
    },
  }, { roles: writerRoles, admission, reconcileRetry: { intervalMs: 5, totalMs: 20 } });
  const failed = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a')), context));
  assert.equal(failed.status.state, 4);
  assert.equal(admission.holder(), null);
});

test('a release() that throws once falls back to unresolved + reconcile instead of leaving the row active', async () => {
  const admission = makeAdmission({ isProcessGroupGone: () => true, killOrphanProcessGroup: () => false });
  const realRelease = admission.release.bind(admission);
  let throws = 1;
  admission.release = (id) => {
    if (throws-- > 0) throw new Error('SQLITE_BUSY');
    return realRelease(id);
  };
  const { agents, context } = makeService({ async run() { return okResult(); } },
    { roles: writerRoles, admission, reconcileRetry: { intervalMs: 5, totalMs: 20 } });
  const done = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a')), context));
  assert.equal(done.status.state, 3);
  assert.notEqual(admission.holder()?.state, 'active');
});

test('a second turn on the same A2A task is recorded under its own turn id', async () => {
  const { usageLedger } = ledgerDb();
  let n = 0;
  const { agents, context } = makeService({
    async run() { n += 1; return { ...okResult(), turnId: `turn-${n}`, execution: { turnId: `turn-${n}` } }; },
  }, { usageLedger });
  const first = taskResult(await agents.get('orch-planner').handler.sendMessage(
    sendParams(writerMessage('go', { contextId: 'ctx-two' })), context));
  await agents.get('orch-planner').handler.sendMessage(
    sendParams(writerMessage('again', { contextId: 'ctx-two', taskId: first.id })), context).catch(() => {});
  const ids = usageLedger.listByTask(first.id).map((row) => row.entryId);
  assert.equal(ids[0], `orch-planner:${first.id}:turn-1`);
  const { workerUsageEntry } = require('../src/a2a-role-service');
  assert.equal(workerUsageEntry({ roleId: 'r', taskId: 't', source: {} }).entryId, 'r:t');
  assert.equal(workerUsageEntry({ roleId: 'r', taskId: 't', source: { execution: { turnId: 'u' } } }).entryId, 'r:t:u');
});

// ---------------------------------------------------------------- MEA-02 pre-turn rows and queue wait

test('an input error writes one pre-turn row with outcome input_error and turns 0', async () => {
  const { usageLedger } = ledgerDb();
  let runs = 0;
  const { agents, context } = makeService({ async run() { runs += 1; return okResult(); } }, { usageLedger });
  const failed = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('x', [])), context));
  assert.equal(failed.status.state, 4);
  assert.equal(runs, 0);
  const rows = usageLedger.listByTask(failed.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryId, `orch-planner:${failed.id}:pre`);
  assert.equal(rows[0].outcome, 'input_error');
  assert.equal(rows[0].turns, 0);
  assert.equal(rows[0].tokens, null);
  assert.equal(rows[0].tokenSource, 'unavailable');
  assert.equal(typeof rows[0].elapsedMs, 'number');
  assert.equal(rows[0].queueWaitMs, null);
});

test('a fenced writer writes a refused row that counts toward later retries of the context', async () => {
  const { usageLedger } = ledgerDb();
  const admission = makeAdmission({});
  admission.fence('ctx-fenced', 'lead gave up');
  const { agents, context } = makeService({ async run() { return okResult(); } }, { roles: writerRoles, admission, usageLedger });
  const first = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a', { contextId: 'ctx-fenced' })), context));
  const second = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a2', { contextId: 'ctx-fenced' })), context));
  const [r1] = usageLedger.listByTask(first.id);
  const [r2] = usageLedger.listByTask(second.id);
  assert.equal(r1.outcome, 'refused');
  assert.equal(r1.turns, 0);
  assert.equal(r1.retries, 0);
  assert.equal(typeof r1.queueWaitMs, 'number');
  assert.equal(r2.outcome, 'refused');
  assert.equal(r2.retries, 1);
});

test('a writer canceled while waiting for admission writes a canceled row; a queued writer records queue wait', async () => {
  const { usageLedger } = ledgerDb();
  const gate = deferred();
  const { agents, context } = makeService({
    async run(options) {
      if (options.role.id === 'orch-writer-a') await gate.promise;
      return okResult();
    },
  }, { roles: writerRoles, admission: makeAdmission({}), usageLedger });

  const a = agents.get('orch-writer-a').handler.sendMessage(sendParams(writerMessage('a')), context);
  await tick();
  const canceledTask = taskResult(await agents.get('orch-writer-b').handler.sendMessage(
    sendParams(writerMessage('b'), { returnImmediately: true }), context));
  await tick();
  await agents.get('orch-writer-b').handler.cancelTask({ id: canceledTask.id }, context);
  await tick();
  const waiter = agents.get('orch-writer-b').handler.sendMessage(sendParams(writerMessage('c')), context);
  await tick(80);
  gate.resolve();
  const doneA = taskResult(await a);
  const doneC = taskResult(await waiter);

  const [canceled] = usageLedger.listByTask(canceledTask.id);
  assert.equal(canceled.outcome, 'canceled');
  assert.equal(canceled.turns, 0);
  assert.equal(typeof canceled.queueWaitMs, 'number');
  const [queued] = usageLedger.listByTask(doneC.id);
  assert.equal(queued.outcome, 'completed');
  assert.ok(queued.queueWaitMs >= 50, `queueWaitMs ${queued.queueWaitMs}`);
  const [first] = usageLedger.listByTask(doneA.id);
  assert.ok(first.queueWaitMs < 50);
});

test('a read-only role records null queue wait and passes startup fields through', async () => {
  const { usageLedger } = ledgerDb();
  const { agents, context } = makeService({
    async run() { return { ...okResult(), usage: { ...sampleUsage(), startupMs: 12, coldStart: true } }; },
  }, { usageLedger });
  const done = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('go')), context));
  const [row] = usageLedger.listByTask(done.id);
  assert.equal(row.queueWaitMs, null);
  assert.equal(row.startupMs, 12);
  assert.equal(row.coldStart, true);
});

// ---------------------------------------------------------------- direct specialist requests (DBC-03)

function structured(overrides = {}) {
  return JSON.stringify({
    objective: 'Do it', allowedFiles: ['src'], inputs: ['a'], evidence: ['b'],
    acceptanceCriteria: ['c'], checks: ['d'], stopConditions: ['e'], ...overrides,
  });
}

test('a JSON request with requireAcceptance but no allowedFiles still fails with guarantee_unavailable', async () => {
  for (const text of [JSON.stringify({ requireAcceptance: true }), JSON.stringify({ objective: 'Do it', requireAcceptance: true })]) {
    const meta = await rejected('orch-writer-a', text);
    assert.equal(meta.failureKind, 'guarantee_unavailable');
    assert.equal(meta.boundary.results[0].code, 'guarantee_unavailable');
    assert.equal(meta.boundary.results[0].predicate, 'dispatch.request_input');
  }
});

test('skill pin mismatches are skill_pin_drift; skill shape errors stay skill_invalid', async () => {
  const { loadSkillCatalog } = require('../src/skill-catalog');
  const skillCatalog = loadSkillCatalog();
  const id = [...skillCatalog.keys()][0];
  const drift = await rejected('orch-planner', structured({ skills: [id], skillPins: [{ id, sha256: '0'.repeat(64) }] }), { skillCatalog });
  assert.equal(drift.boundary.results[0].predicate, 'dispatch.skill_pins');
  assert.equal(drift.boundary.results[0].code, 'skill_pin_drift');
  const shape = await rejected('orch-planner', structured({ skills: [id, id] }), { skillCatalog });
  assert.equal(shape.boundary.results[0].predicate, 'assignment.skills');
  assert.equal(shape.boundary.results[0].code, 'skill_invalid');
  const unknown = await rejected('orch-planner', structured({ skills: ['no-such-skill'] }), { skillCatalog });
  assert.equal(unknown.boundary.results[0].code, 'skill_invalid');
});

// Admission whose snapshots report a known delta touching the given paths.
function deltaAdmission(changed) {
  let calls = 0;
  return new WriterAdmission({
    db: new Database(':memory:'),
    workspace: process.cwd(),
    snapshot: () => {
      calls += 1;
      return calls % 2 === 1
        ? { kind: 'git', head: 'h', entries: [], fingerprint: 'a' }
        : { kind: 'git', head: 'h', entries: changed.map((file) => ({ path: file, status: 'M', sha256: 'x' })), fingerprint: 'b' };
    },
    quiescence: {},
    settleMs: 0,
  });
}

async function rejected(roleId, text, extra = {}) {
  const { usageLedger } = ledgerDb();
  let runs = 0;
  const { agents, context } = makeService({ async run() { runs += 1; return okResult(); } },
    { roles: writerRoles, admission: makeAdmission({}), usageLedger, ...extra });
  const result = taskResult(await agents.get(roleId).handler.sendMessage(sendParams(message(text)), context));
  assert.equal(result.status.state, 4);
  assert.equal(runs, 0);
  const meta = result.status.message.metadata;
  assert.equal(meta.effects, 'none');
  assert.equal(meta.boundary.contract, 'boundary-contract/v1');
  const rows = usageLedger.listByTask(result.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'input_error');
  return meta;
}

test('structured request failures stop before admission and the model with specific codes', async () => {
  let meta = await rejected('orch-writer-a', structured({ allowedFiles: [] }));
  assert.equal(meta.failureKind, 'request_invalid');
  assert.equal(meta.boundary.results[0].code, 'writer_scope_missing');
  assert.equal(meta.boundary.results[0].predicate, 'assignment.writer_scope');

  meta = await rejected('orch-planner', structured({ requireAcceptance: true }));
  assert.equal(meta.failureKind, 'guarantee_unavailable');
  assert.equal(meta.boundary.results[0].code, 'guarantee_unavailable');

  meta = await rejected('orch-planner', structured({ workspace: '/somewhere/else' }));
  assert.equal(meta.failureKind, 'request_invalid');
  assert.equal(meta.boundary.results[0].predicate, 'dispatch.request_input');

  meta = await rejected('orch-planner', structured({ allowedFiles: ['../x'] }));
  assert.equal(meta.boundary.results[0].code, 'path_unsafe');

  meta = await rejected('orch-planner', structured({ objective: '' }));
  assert.equal(meta.boundary.results[0].code, 'field_invalid');
});

test('a writer request refused before admission leaves the workspace unheld', async () => {
  const admission = makeAdmission({});
  const { agents, context } = makeService({ async run() { return okResult(); } }, { roles: writerRoles, admission });
  const failed = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(message(structured({ allowedFiles: [] }))), context));
  assert.equal(failed.status.state, 4);
  assert.equal(admission.holder(), null);
});

test('a valid structured writer request whose delta leaves allowedFiles completes with an attested_scope_violation', async () => {
  const { agents, context } = makeService({
    async run() { return okResult(JSON.stringify(validReport())); },
  }, { roles: writerRoles, admission: deltaAdmission(['src/ok.js', 'other/bad.js']) });
  const done = taskResult(await agents.get('orch-writer-a').handler.sendMessage(sendParams(message(structured({ workspace: process.cwd() }))), context));
  assert.equal(done.status.state, 3);
  const meta = done.artifacts[0].metadata;
  assert.equal(meta.contract, WORKER_REPORT_CONTRACT);
  assert.equal(meta.boundary.contract, 'boundary-contract/v1');
  assert.equal(meta.boundary.results.length, 1);
  const record = meta.boundary.results[0];
  assert.equal(record.predicate, 'settle.attested_scope');
  assert.equal(record.result, 'FAIL');
  assert.equal(record.code, 'attested_scope_violation');
  assert.equal(record.boundary, 'settlement');
  assert.equal(record.advisory, false);
  assert.match(record.detail, /other\/bad\.js/);
});

test('a structured writer request inside allowedFiles has no violations; an unknown delta is UNKNOWN', async () => {
  const run = async () => okResult(JSON.stringify(validReport()));
  let service = makeService({ run }, { roles: writerRoles, admission: deltaAdmission(['src/ok.js']) });
  let done = taskResult(await service.agents.get('orch-writer-a').handler.sendMessage(sendParams(message(structured())), service.context));
  assert.deepEqual(done.artifacts[0].metadata.boundary.results, []);

  service = makeService({ run }, { roles: writerRoles, admission: makeAdmission({}) });
  done = taskResult(await service.agents.get('orch-writer-a').handler.sendMessage(sendParams(message(structured())), service.context));
  assert.equal(done.status.state, 3);
  assert.equal(done.artifacts[0].metadata.boundary.results[0].result, 'UNKNOWN');
  assert.equal(done.artifacts[0].metadata.boundary.results[0].code, 'delta_unknown');
});

test('an invalid report drops the contract label and records report_invalid', async () => {
  const { agents, context } = makeService({ async run() { return okResult('not a report'); } });
  const done = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message(structured({ allowedFiles: ['.'] }))), context));
  assert.equal(done.status.state, 3);
  const meta = done.artifacts[0].metadata;
  assert.equal(meta.contract, null);
  assert.match(meta.reportError, /Worker report/);
  assert.equal(meta.boundary.results[0].code, 'report_invalid');
  assert.equal(meta.boundary.results[0].advisory, true);
});

test('legacy plain text keeps running with boundary legacy and no predicate records', async () => {
  const { agents, context } = makeService({ async run() { return okResult('plain answer'); } });
  const done = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('just do it')), context));
  assert.equal(done.status.state, 3);
  const meta = done.artifacts[0].metadata;
  assert.deepEqual(meta.boundary, { contract: 'legacy' });
  assert.equal(meta.contract, null);
  assert.ok(meta.reportError);
});

test('records live activity for a worker turn and ends it on success and error', async () => {
  const { createActivityStore } = require('../src/activity-store');
  const db = new Database(':memory:');
  const activityStore = createActivityStore(db);
  const rows = () => db.prepare('SELECT * FROM live_activity').all();
  let mode = 'ok';
  const { agents, context } = makeService({
    async run({ onEvent }) {
      assert.equal(rows()[rows().length - 1].phase, 'starting');
      onEvent({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'ls', exitCode: 0 } } });
      if (mode === 'error') throw new Error('boom');
      return { threadId: 't', turnId: 'u', status: 'completed', text: 'done' };
    },
  }, { activityStore });
  const handler = agents.get('orch-planner').handler;
  const ok = taskResult(await handler.sendMessage(sendParams(message('work')), context));
  let row = db.prepare('SELECT * FROM live_activity WHERE key = ?').get(ok.id);
  assert.deepEqual([row.role, row.phase, row.summary, row.ended_at !== null], ['orch-planner', 'done', 'completed', true]);

  mode = 'error';
  const failed = taskResult(await handler.sendMessage(sendParams(message('work')), context));
  row = db.prepare('SELECT * FROM live_activity WHERE key = ?').get(failed.id);
  assert.deepEqual([row.phase, row.summary, row.ended_at !== null], ['done', 'failed', true]);
});

test('ends the live activity of a canceled worker turn', async () => {
  const { createActivityStore } = require('../src/activity-store');
  const db = new Database(':memory:');
  const activityStore = createActivityStore(db);
  let started;
  const runStarted = new Promise((resolve) => { started = resolve; });
  const { agents, context } = makeService({
    run({ signal }) {
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  }, { activityStore });
  const handler = agents.get('orch-planner').handler;
  const created = taskResult(await handler.sendMessage(sendParams(message('wait'), { returnImmediately: true }), context));
  await runStarted;
  assert.equal(db.prepare('SELECT ended_at FROM live_activity WHERE key = ?').get(created.id).ended_at, null);
  await handler.cancelTask({ id: created.id }, context);
  let row;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    row = db.prepare('SELECT * FROM live_activity WHERE key = ?').get(created.id);
    if (row.phase === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual([row.phase, row.summary, row.ended_at !== null], ['done', 'canceled', true]);
});

test('effective roles with a project override reach appServer.run and the base roles stay untouched', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEffectiveRoles, writeOverridesFile, RULES_HEADING } = require('../src/role-overrides');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-role-overrides-'));
  try {
    const file = path.join(dir, 'role-overrides.json');
    writeOverridesFile(file, { 'orch-planner': { model: 'gpt-6-luna', effort: 'high', extraRules: 'Plan in two steps.' } });
    const loaded = loadEffectiveRoles({ file, roles, leadRole: { name: 'coordinator', model: 'lead', effort: 'low', instructions: 'Lead.' } });
    const calls = [];
    const { agents, context } = makeService({
      async run(options) {
        calls.push(options.role);
        return { threadId: 'thread', turnId: 'turn', status: 'completed', text: 'ok' };
      },
    }, { roles: loaded.roles });
    const send = (id, text) => agents.get(id).handler.sendMessage(sendParams(message(text)), context);
    await send('orch-planner', 'plan');
    await send('orch-reviewer', 'review');
    assert.deepEqual(calls.map((role) => [role.id, role.model, role.effort]), [
      ['orch-planner', 'gpt-6-luna', 'high'],
      ['orch-reviewer', 'test', 'low'],
    ]);
    assert.equal(calls[0].instructions, `Plan.\n\n${RULES_HEADING}\nPlan in two steps.`);
    assert.equal(calls[0].sandbox, 'read-only');
    assert.equal(calls[1].instructions, 'Review.');
    assert.equal(roles.get('orch-planner').model, 'test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const auditorRoles = new Map([
  ['auditor', { name: 'auditor', description: 'Checks scoped changes.', instructions: 'Review only.', model: 'test', effort: 'low', sandbox: 'read-only' }],
]);
const verifierRoles = new Map([
  ['verifier', { name: 'verifier', description: 'Checks integrated work.', instructions: 'Verify assigned tests.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
]);
const pinnedFallbackRoles = new Map([
  ['explorer', { name: 'explorer', description: 'Explores read-only context.', instructions: 'Investigate.', model: 'test', effort: 'low', sandbox: 'read-only' }],
  ['scout', { name: 'scout', description: 'Explores read-only context.', instructions: 'Investigate.', model: 'test', effort: 'low', sandbox: 'read-only' }],
]);

function auditReview(kind = 'risk_change', paths = ['src/a2a-role-service.js']) {
  return { kind, checkpointId: 'checkpoint-1', reason: 'Check the changed role boundary.', paths, evidenceIds: ['artifact-1'] };
}

function auditRequest(review = auditReview()) {
  return structured({ objective: 'Review the declared checkpoint.', allowedFiles: [], review });
}

function auditReport(summary = 'VERDICT: pass', overrides = {}) {
  return JSON.stringify(validReport({
    summary,
    filesInspected: ['src/a2a-role-service.js'],
    checks: [{ command: 'inspect', result: 'passed', detail: 'Scoped review completed.' }],
    ...overrides,
  }));
}

test('auditor refuses plain text and missing or routine review context before model execution', async () => {
  let calls = 0;
  const admission = makeAdmission({});
  const { agents, context } = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, { roles: auditorRoles, admission });
  for (const input of ['please review this', structured({ objective: 'Review', allowedFiles: [] }), auditRequest(auditReview('routine'))]) {
    const failed = taskResult(await agents.get('auditor').handler.sendMessage(sendParams(message(input)), context));
    assert.equal(failed.status.state, 4);
    assert.equal(failed.status.message.metadata.effects, 'none');
    assert.ok(failed.status.message.metadata.boundary?.results?.length || failed.status.message.metadata.review);
  }
  assert.equal(calls, 0);
  assert.equal(admission.db.prepare('SELECT COUNT(*) AS count FROM writer_executions').get().count, 0);

  const aliases = new Map([['orch-auditor', { ...auditorRoles.get('auditor'), name: 'Code Auditor' }]]);
  const aliasService = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, { roles: aliases });
  const aliasFailed = taskResult(await aliasService.agents.get('orch-auditor').handler.sendMessage(
    sendParams(message('plain audit request')), aliasService.context,
  ));
  assert.equal(aliasFailed.status.state, 4);
  assert.equal(calls, 0);
});

test('auditor accepts a stable scoped owner review; investigation and pinned checks preserve their distinct semantics', async () => {
  let lastInput = '';
  const run = async ({ input, summary }) => {
    const { agents, context } = makeService({
      async run(options) {
        lastInput = options.input;
        return okResult(auditReport(summary));
      },
    }, { roles: auditorRoles });
    return taskResult(await agents.get('auditor').handler.sendMessage(sendParams(message(input)), context));
  };
  const owner = await run({ input: auditRequest(auditReview('owner_request')), summary: 'VERDICT: pass' });
  assert.equal(owner.status.state, 3);
  assert.deepEqual(owner.artifacts[0].metadata.reviewCoverage, {
    targetKnown: true,
    targetIdentity: owner.artifacts[0].metadata.reviewCoverage.targetIdentity,
    stable: true,
    reason: null,
  });
  assert.equal(owner.artifacts[0].metadata.review.accepted, true);

  const investigation = await run({ input: auditRequest(auditReview('investigation')), summary: 'Found a possible edge case.' });
  assert.equal(investigation.status.state, 3);
  assert.equal(investigation.artifacts[0].metadata.review.accepted, false);
  assert.equal(investigation.artifacts[0].metadata.review.reason, 'diagnostic_only');
  assert.doesNotMatch(lastInput, /VERDICT: pass, VERDICT: fail, or VERDICT: inconclusive/);

  const pinned = await run({ input: auditRequest(auditReview('pinned_check')), summary: 'VERDICT: preserve' });
  assert.equal(pinned.status.state, 3);
  assert.equal(pinned.artifacts[0].metadata.review.verdict, 'preserve');
  assert.equal(pinned.artifacts[0].metadata.review.accepted, true);
  assert.match(lastInput, /Pinned-check integrity report contract/);
  assert.match(lastInput, /VERDICT: preserve or VERDICT: weaken/);
  assert.doesNotMatch(lastInput, /VERDICT: pass, VERDICT: fail, or VERDICT: inconclusive/);
  const weakened = await run({ input: auditRequest(auditReview('pinned_check')), summary: 'VERDICT: weaken' });
  assert.equal(weakened.status.state, 3);
  assert.equal(weakened.artifacts[0].metadata.review.verdict, 'weaken');
  assert.equal(weakened.artifacts[0].metadata.review.accepted, false);
});

test('auditor report contract keeps supplemental and reused evidence separate from required checks', async () => {
  const diagnostics = [
    'Excluded diagnostic: `node --test test/filesystem.test.js` was forbidden and not run; it was not required by this assignment.',
    'Prior verifier evidence: artifact r31 reports 199 disk-backed tests; no test execution is claimed for this audit.',
  ];
  let receivedInput = '';
  const stagingLog = new InMemoryStagingLog();
  const service = makeService({
    async run(options) {
      receivedInput = options.input;
      return okResult(auditReport('VERDICT: pass', {
        checks: [{
          command: 'inspect assigned source and tests', result: 'passed',
          detail: 'Inspected the assigned scope and validated the cited r31 verifier report as prior evidence; no tests were executed for this check.',
        }],
        risks: diagnostics,
      }));
    },
  }, { roles: auditorRoles, stagingLog });
  const result = taskResult(await service.agents.get('auditor').handler.sendMessage(
    sendParams(message(auditRequest())), service.context,
  ));
  assert.equal(result.status.state, 3);
  assert.equal(result.artifacts[0].metadata.review.accepted, true);
  assert.match(receivedInput, /checks\. State what was actually run or validated; never describe reused tests as freshly executed/);
  assert.match(receivedInput, /Do not move an assigned failed or unrun check into risks/);
  const audit = stagingLog.list({ type: 'audit_result' }).at(-1);
  assert.deepEqual(audit.payload.findings, diagnostics);

  for (const checkResult of ['failed', 'not_run']) {
    const invalid = makeService({
      async run() {
        return okResult(auditReport('VERDICT: pass', {
          checks: [{ command: 'inspect assigned scope', result: checkResult, detail: 'Required review step.' }],
          risks: diagnostics,
        }));
      },
    }, { roles: auditorRoles });
    const rejected = taskResult(await invalid.agents.get('auditor').handler.sendMessage(
      sendParams(message(auditRequest())), invalid.context,
    ));
    assert.notEqual(rejected.artifacts[0].metadata.review.accepted, true, checkResult);
    assert.equal(rejected.artifacts[0].metadata.review.reason, 'review_checks_failed_or_unrun');
  }
});

test('auditor runtime rejects an embellished verdict line and inconclusive evidence', async () => {
  for (const summary of ['VERDICT: pass. Authority/release: PASS', 'VERDICT: inconclusive']) {
    const service = makeService({ async run() { return okResult(auditReport(summary)); } }, { roles: auditorRoles });
    const result = taskResult(await service.agents.get('auditor').handler.sendMessage(
      sendParams(message(auditRequest())), service.context,
    ));
    assert.notEqual(result.artifacts[0].metadata.review.accepted, true, summary);
    assert.equal(result.artifacts[0].metadata.review.reason, summary === 'VERDICT: inconclusive'
      ? 'audit_verdict_inconclusive' : 'audit_verdict_missing_or_invalid');
  }
});

test('auditor rejects escaped targets and a scope changed during the read-only turn', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-auditor-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-auditor-outside-'));
  try {
    fs.writeFileSync(path.join(root, 'scope.txt'), 'before');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    let calls = 0;
    let service = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, { roles: auditorRoles, workspace: root });
    const escaped = taskResult(await service.agents.get('auditor').handler.sendMessage(
      sendParams(message(auditRequest(auditReview('risk_change', ['escape.txt'])))), service.context,
    ));
    assert.equal(escaped.status.state, 4);
    assert.equal(calls, 0);

    service = makeService({
      async run() {
        fs.writeFileSync(path.join(root, 'scope.txt'), 'changed during review');
        return okResult(auditReport());
      },
    }, { roles: auditorRoles, workspace: root });
    const changed = taskResult(await service.agents.get('auditor').handler.sendMessage(
      sendParams(message(auditRequest(auditReview('risk_change', ['scope.txt'])))), service.context,
    ));
    assert.equal(changed.status.state, 4);
    assert.equal(changed.artifacts[0].metadata.reviewCoverage.targetKnown, true);
    assert.equal(changed.artifacts[0].metadata.reviewCoverage.stable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('exclusive auditor reservation blocks an attempted change-and-restore during the review turn', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-audit-exclusive-'));
  const target = path.join(root, 'scope.txt');
  fs.writeFileSync(target, 'original');
  const auditGate = deferred();
  let signalAuditStarted;
  const auditStarted = new Promise((resolve) => { signalAuditStarted = resolve; });
  let writerCalls = 0;
  const admission = new WriterAdmission({
    db: new Database(':memory:'),
    workspace: root,
    snapshot: () => ({ kind: 'unavailable', reason: 'test' }),
    quiescence: {},
    settleMs: 0,
  });
  const roles = new Map([
    ['auditor', auditorRoles.get('auditor')],
    ['writer', { name: 'Writer', description: 'Writes scoped work.', instructions: 'Write.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
  ]);
  try {
    const { agents, context } = makeService({
      async run({ role }) {
        if (role.id === 'auditor') {
          signalAuditStarted();
          await auditGate.promise;
          return okResult(auditReport('VERDICT: pass', { filesInspected: ['scope.txt'] }));
        }
        writerCalls += 1;
        fs.writeFileSync(target, 'temporary mutation');
        fs.writeFileSync(target, 'original');
        return okResult(JSON.stringify(validReport()));
      },
    }, { roles, workspace: root, admission });
    const auditPromise = agents.get('auditor').handler.sendMessage(sendParams(message(
      auditRequest(auditReview('risk_change', ['scope.txt'])),
    )), context);
    await auditStarted;
    const writerPromise = agents.get('writer').handler.sendMessage(sendParams(message(structured({
      objective: 'Change and restore the reviewed file.', allowedFiles: ['scope.txt'],
    }))), context);
    await tick(20);
    assert.equal(writerCalls, 0, 'the writer must wait while the audit reservation is held');
    assert.equal(admission.holder()?.role, 'auditor');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    auditGate.resolve();
    const audit = taskResult(await auditPromise);
    assert.equal(audit.status.state, 3, JSON.stringify(audit.status.message));
    assert.equal(audit.artifacts[0].metadata.reviewCoverage.stable, true);
    assert.equal(audit.artifacts[0].metadata.review.accepted, true);
    const writer = taskResult(await writerPromise);
    assert.equal(writer.status.state, 3);
    assert.equal(writerCalls, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(admission.holder(), null);
  } finally {
    auditGate.resolve();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auditor continuations require a known unchanged originating review target', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-audit-continuation-'));
  const target = path.join(root, 'scope.txt');
  fs.writeFileSync(target, 'original');
  const stagingLog = new InMemoryStagingLog();
  const metadata = { runId: 'continuation-run', assignmentId: 'reviewer-1', attemptId: 'attempt-1' };
  const fullReview = { ...auditReview('risk_change', ['scope.txt']), prerequisiteFor: ['critical-1'] };
  const request = JSON.parse(auditRequest(fullReview));
  const report = auditReport('VERDICT: pass', { filesInspected: ['scope.txt'] });
  let calls = 0;
  let receivedInput = '';
  try {
    const firstService = makeService({ async run(options) { calls += 1; receivedInput = options.input; return okResult(report); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    const first = taskResult(await firstService.agents.get('auditor').handler.sendMessage(
      sendParams(message(JSON.stringify(request), undefined, metadata)), firstService.context,
    ));
    assert.equal(first.status.state, 3);
    assert.ok(receivedInput.includes(JSON.stringify(fullReview)), 'App Server input must retain all six review fields');

    const unchangedService = makeService({ async run() { calls += 1; return okResult(report); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    const continued = taskResult(await unchangedService.agents.get('auditor').handler.sendMessage(
      sendParams(message(JSON.stringify({ ...request, continuation: { ofAttemptId: 'attempt-1', threadId: null, laneId: null, codexHome: null } }), undefined, {
        ...metadata, attemptId: 'attempt-2',
      })), unchangedService.context,
    ));
    assert.equal(continued.status.state, 3);
    assert.equal(calls, 2);

    fs.writeFileSync(target, 'changed after the originating review');
    const staleService = makeService({ async run() { calls += 1; return okResult(report); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    const stale = taskResult(await staleService.agents.get('auditor').handler.sendMessage(
      sendParams(message(JSON.stringify({ ...request, continuation: { ofAttemptId: 'attempt-1', threadId: null, laneId: null, codexHome: null } }), undefined, {
        ...metadata, assignmentId: 'reviewer-2', attemptId: 'attempt-3',
      })), staleService.context,
    ));
    assert.equal(stale.status.state, 4);
    assert.equal(stale.status.message.metadata.review.reason, 'review_origin_stale');
    assert.equal(calls, 2, 'stale continuations must not invoke Codex');

    const unknownService = makeService({ async run() { calls += 1; return okResult(report); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    const unknown = taskResult(await unknownService.agents.get('auditor').handler.sendMessage(
      sendParams(message(JSON.stringify({ ...request, continuation: { ofAttemptId: 'missing-attempt', threadId: null, laneId: null, codexHome: null } }), undefined, {
        ...metadata, assignmentId: 'reviewer-3', attemptId: 'attempt-4',
      })), unknownService.context,
    ));
    assert.equal(unknown.status.state, 4);
    assert.equal(unknown.status.message.metadata.review.reason, 'review_origin_unknown');
    assert.equal(calls, 2, 'unknown continuations must not invoke Codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('direct review continuations bind thread lane and codex home to their origin attempt', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-review-continuation-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'scope.txt');
  fs.writeFileSync(target, 'candidate A');
  const stagingLog = new InMemoryStagingLog();
  const calls = [];
  const appServer = {
    getCodexHome() { return 'home-A'; },
    async run(options) {
      calls.push(options);
      return { ...okResult(auditReport('VERDICT: pass', { filesInspected: ['scope.txt'] })), threadId: `thread-${calls.length}` };
    },
  };
  const request = auditRequest(auditReview('risk_change', ['scope.txt']));
  const sendReview = async (attemptId, continuation) => {
    const service = makeService(appServer, { roles: auditorRoles, workspace: root, stagingLog });
    const input = continuation ? JSON.stringify({ ...JSON.parse(request), continuation }) : request;
    return taskResult(await service.agents.get('auditor').handler.sendMessage(
      sendParams(message(input, undefined, { runId: 'binding-run', assignmentId: `review-${attemptId}`, attemptId })), service.context,
    ));
  };

  const first = await sendReview('binding-A');
  assert.equal(first.status.state, 3);
  fs.writeFileSync(target, 'candidate B');
  const second = await sendReview('binding-B');
  assert.equal(second.status.state, 3);
  const origin = second.artifacts[0].metadata.continuation;
  assert.deepEqual(origin, { threadId: 'thread-2', laneId: null, codexHome: 'home-A' });

  for (const [field, value] of [
    ['threadId', 'thread-1'],
    ['laneId', 'lane-from-another-attempt'],
    ['codexHome', 'home-from-another-attempt'],
  ]) {
    const before = calls.length;
    const failed = await sendReview(`mismatch-${field}`, {
      ofAttemptId: 'binding-B', ...origin, [field]: value,
    });
    assert.equal(failed.status.state, 4, `${field} mismatch must fail before App Server execution`);
    assert.equal(failed.status.message.metadata.review.reason, 'review_origin_stale');
    assert.equal(calls.length, before, `${field} mismatch must not call App Server`);
  }

  const sameOrigin = await sendReview('matching-B', { ofAttemptId: 'binding-B', ...origin });
  assert.equal(sameOrigin.status.state, 3, 'matching origin tuple remains resumable');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].threadId, 'thread-2');
});

test('direct review resumable context distinguishes unknown bindings from proven tuple mismatches', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-review-continuation-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'scope.txt'), 'candidate');

  for (const evidenceCase of ['missing', 'malformed', 'unknown-version', 'ambiguous', 'unavailable']) {
    const stagingLog = new InMemoryStagingLog();
    let calls = 0;
    const appServer = { async run() { calls += 1; return { ...okResult(auditReport('VERDICT: pass', { filesInspected: ['scope.txt'] })), threadId: 'origin-thread' }; } };
    const originService = makeService(appServer, { roles: auditorRoles, workspace: root, stagingLog });
    const origin = taskResult(await originService.agents.get('auditor').handler.sendMessage(
      sendParams(message(auditRequest(auditReview('risk_change', ['scope.txt'])), undefined, {
        runId: 'binding-evidence-run', assignmentId: 'binding-origin', attemptId: 'binding-origin',
      })), originService.context,
    ));
    assert.equal(origin.status.state, 3);
    const binding = [...stagingLog.events.values()].find((event) => event.type === 'review_continuation_emitted');
    assert.ok(binding);
    if (evidenceCase === 'malformed') {
      stagingLog.events.set(binding.eventId, {
        ...binding,
        payload: { ...binding.payload, tupleDigest: 'not-a-digest' },
      });
    } else if (evidenceCase === 'unknown-version') {
      stagingLog.events.set(binding.eventId, {
        ...binding,
        payload: { ...binding.payload, version: 2 },
      });
    } else if (evidenceCase === 'ambiguous') {
      stagingLog.events.set('duplicate-continuation-binding', {
        ...binding,
        eventId: 'duplicate-continuation-binding',
      });
    } else if (evidenceCase === 'unavailable') {
      const actualList = stagingLog.list.bind(stagingLog);
      stagingLog.list = (filter) => {
        if (filter.type === 'review_continuation_emitted') throw new Error('binding unavailable');
        return actualList(filter);
      };
    } else {
      stagingLog.events.delete(binding.eventId);
    }
    const continuationService = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    const continuation = taskResult(await continuationService.agents.get('auditor').handler.sendMessage(
      sendParams(message(JSON.stringify({
        ...JSON.parse(auditRequest(auditReview('risk_change', ['scope.txt']))),
        continuation: { ofAttemptId: 'binding-origin', threadId: 'origin-thread', laneId: null, codexHome: null },
      }), undefined, { runId: 'binding-evidence-run', assignmentId: `binding-next-${evidenceCase}`, attemptId: `binding-next-${evidenceCase}` })),
      continuationService.context,
    ));
    assert.equal(continuation.status.state, 4, evidenceCase);
    assert.equal(continuation.status.message.metadata.review.reason, 'review_origin_unknown', evidenceCase);
    assert.equal(calls, 1, 'missing or corrupt tuple evidence must reject before App Server execution');

    const freshService = makeService(appServer, { roles: auditorRoles, workspace: root, stagingLog });
    const fresh = taskResult(await freshService.agents.get('auditor').handler.sendMessage(
      sendParams(message(JSON.stringify({
        ...JSON.parse(auditRequest(auditReview('risk_change', ['scope.txt']))),
        continuation: { ofAttemptId: 'binding-origin', threadId: null, laneId: null, codexHome: null },
      }), undefined, { runId: 'binding-evidence-run', assignmentId: `binding-fresh-${evidenceCase}`, attemptId: `binding-fresh-${evidenceCase}` })),
      freshService.context,
    ));
    assert.equal(fresh.status.state, 3, 'clearing resumable fields permits a fresh execution');
    assert.equal(calls, 2);
  }
});

test('auditor continuations fail closed for missing, other-run, corrupt, and ambiguous origins', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-audit-origin-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'scope.txt'), 'candidate');

  for (const originCase of ['missing', 'other-run', 'corrupt', 'conflicting-corrupt', 'ambiguous', 'overflow']) {
    const stagingLog = new InMemoryStagingLog();
    let runId = originCase === 'other-run' ? 'continuation-run' : 'origin-run';
    let calls = 0;
    const firstService = makeService({ async run() { calls += 1; return okResult(auditReport('VERDICT: pass', { filesInspected: ['scope.txt'] })); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    if (originCase !== 'missing') {
      const first = taskResult(await firstService.agents.get('auditor').handler.sendMessage(
        sendParams(message(auditRequest(auditReview('risk_change', ['scope.txt'])), undefined, {
          runId, assignmentId: 'reviewer-1', attemptId: 'origin-attempt',
        })), firstService.context,
      ));
      assert.equal(first.status.state, 3, `${originCase} setup review`);
    }
    if (['corrupt', 'conflicting-corrupt', 'ambiguous', 'overflow'].includes(originCase)) {
      const event = [...stagingLog.events.values()].find((entry) => entry.type === 'audit_started');
      assert.ok(event, `${originCase} setup must produce origin evidence`);
      if (originCase === 'corrupt') {
        stagingLog.events.set(event.eventId, { ...event, target: null });
      } else if (originCase === 'conflicting-corrupt') {
        stagingLog.events.set('corrupt-origin', { ...event, eventId: 'corrupt-origin', target: null });
      } else if (originCase === 'ambiguous') {
        stagingLog.events.set('ambiguous-origin', { ...event, eventId: 'ambiguous-origin', target: 'review-target/v1:other' });
      }
    }
    if (originCase === 'overflow') {
      const actualList = stagingLog.list.bind(stagingLog);
      stagingLog.list = (filter) => {
        const listed = actualList(filter);
        return [
          ...listed,
          ...Array.from({ length: 10000 - listed.length }, (_, index) => ({
            ...listed[0], eventId: `overflow-${index}`, attemptId: `unrelated-${index}`,
          })),
        ];
      };
    }
    if (originCase === 'other-run') {
      runId = 'another-run';
    }
    const continuedService = makeService({ async run() { calls += 1; return okResult(auditReport('VERDICT: pass', { filesInspected: ['scope.txt'] })); } }, {
      roles: auditorRoles, workspace: root, stagingLog,
    });
    const continuation = originCase === 'missing' ? 'missing-attempt' : 'origin-attempt';
    const continuedRequest = JSON.stringify({
      ...JSON.parse(auditRequest(auditReview('risk_change', ['scope.txt']))),
      continuation: { ofAttemptId: continuation, threadId: null, laneId: null, codexHome: null },
    });
    const failed = taskResult(await continuedService.agents.get('auditor').handler.sendMessage(
      sendParams(message(continuedRequest, undefined, {
        runId, assignmentId: 'reviewer-2', attemptId: `${originCase}-continuation`,
      })), continuedService.context,
    ));
    assert.equal(failed.status.state, 4, originCase);
    assert.equal(failed.status.message.metadata.review.reason, 'review_origin_unknown', originCase);
    assert.equal(calls, originCase === 'missing' ? 0 : 1, `${originCase} must fail before appServer.run`);
  }
});

test('direct verifier continuation requires its originating target and preserves same-target control', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-verifier-continuation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'scope.txt');
  fs.writeFileSync(target, 'candidate A');
  const calls = [];
  const review = {
    kind: 'routine', checkpointId: 'verifier-checkpoint', reason: 'Verify the current candidate.',
    paths: ['scope.txt'], evidenceIds: ['evidence-1'], prerequisiteFor: [],
  };
  const lane = { id: 'verifier-lane', path: path.join(root, 'lane'), workspacePath: root, base: 'base' };
  const writerExecution = {
    executionId: null, state: null, reason: null, effects: 'none',
    lane: { id: lane.id, state: 'not_integrated', reason: 'no_changes' },
    delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
  };
  const laneStore = new Map([[lane.id, lane]]);
  let laneExistedAtCompletion = false;
  const lanes = {
    async available() { return true; },
    async prepare() { return { lane }; },
    store: laneStore,
    markRunning() {},
    laneInput(_lane, input) { return input; },
    sandboxPolicy() { return {}; },
    recordTurnStart() {},
    async complete() {
      laneExistedAtCompletion = Boolean(laneStore.get(lane.id));
      laneStore.delete(lane.id);
      return { canceled: false, writerExecution };
    },
  };
  const service = makeService({
    async run(options) {
      calls.push(options);
      return {
        ...okResult(JSON.stringify(validReport({
          summary: 'Verified the current candidate.',
          filesInspected: ['scope.txt'],
          checks: [{ command: 'inspect scope', result: 'passed', detail: 'Current scope inspected.' }],
        }))),
        threadId: 'verifier-thread-a',
      };
    },
  }, { roles: verifierRoles, workspace: root, lanes });
  const request = structured({ objective: 'Verify the current candidate.', allowedFiles: ['tests'], review });
  const first = taskResult(await service.agents.get('verifier').handler.sendMessage(
    sendParams(message(request, undefined, { runId: 'verifier-run', assignmentId: 'verifier-1', attemptId: 'verifier-a' })), service.context,
  ));
  assert.equal(first.status.state, 3);
  assert.equal(calls.length, 1);
  assert.equal(laneExistedAtCompletion, true);
  assert.equal(first.artifacts[0].metadata.continuation.laneId, null, 'published tuple reflects lane removal during completion');
  const firstTarget = first.artifacts[0].metadata.reviewCoverage.targetIdentity;

  const forgedRequest = JSON.stringify({
    ...JSON.parse(request),
    continuation: { ofAttemptId: 'verifier-a', threadId: 'different-thread', laneId: null, codexHome: null },
  });
  const forged = taskResult(await service.agents.get('verifier').handler.sendMessage(
    sendParams(message(forgedRequest, undefined, { runId: 'verifier-run', assignmentId: 'verifier-forged', attemptId: 'verifier-forged' })), service.context,
  ));
  assert.equal(forged.status.state, 4);
  assert.equal(forged.status.message.metadata.failureKind, 'request_invalid');
  assert.equal(forged.status.message.metadata.effects, 'none');
  assert.equal(forged.status.message.metadata.boundary.results[0].code, 'review_origin_stale');
  assert.equal(forged.status.message.metadata.review.reason, 'review_origin_stale');
  assert.equal(calls.length, 1, 'forged verifier thread must fail before the App Server boundary');

  const continuedRequest = JSON.stringify({
    ...JSON.parse(request),
    continuation: { ofAttemptId: 'verifier-a', threadId: 'verifier-thread-a', laneId: null, codexHome: null },
  });
  const unchanged = taskResult(await service.agents.get('verifier').handler.sendMessage(
    sendParams(message(continuedRequest, undefined, { runId: 'verifier-run', assignmentId: 'verifier-2', attemptId: 'verifier-same' })), service.context,
  ));
  assert.equal(calls.length, 2, 'same-target verifier continuation reaches the injected App Server boundary');
  assert.equal(calls[1].threadId, 'verifier-thread-a');
  assert.equal(unchanged.status.state, 3);
  assert.equal(unchanged.artifacts[0].metadata.review.accepted, true);
  assert.equal(unchanged.artifacts[0].metadata.reviewCoverage.stable, true);
  assert.equal(unchanged.artifacts[0].metadata.reviewCoverage.targetIdentity, firstTarget);

  fs.writeFileSync(target, 'candidate B');
  const continued = taskResult(await service.agents.get('verifier').handler.sendMessage(
    sendParams(message(continuedRequest, undefined, { runId: 'verifier-run', assignmentId: 'verifier-3', attemptId: 'verifier-b' })), service.context,
  ));
  if (process.env.AUT02_TRACE_DIR) {
    const failureMetadata = continued.status.message?.metadata || {};
    const resultMetadata = continued.artifacts?.[0]?.metadata || continued.status.message.metadata;
    const trace = {
      scenario: 'direct-verifier-origin-a-to-b',
      runId: 'verifier-run',
      checkpointId: review.checkpointId,
      originAttemptId: 'verifier-a',
      retryAttemptId: 'verifier-b',
      leadToServiceMessages: 3,
      appServerCalls: calls.length,
      targetA: firstTarget,
      targetB: resultMetadata.reviewCoverage?.targetIdentity || null,
      outcome: resultMetadata.review.reason || resultMetadata.review.status || null,
      boundaryCode: failureMetadata.boundary?.results?.[0]?.code || null,
    };
    fs.mkdirSync(process.env.AUT02_TRACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.AUT02_TRACE_DIR, 'direct-verifier-continuation.json'), `${JSON.stringify(trace, null, 2)}\n`);
  }
  assert.equal(calls.length, 2, 'stale verifier continuation must fail before the injected App Server boundary');
  assert.equal(continued.status.state, 4);
  assert.equal(continued.status.message.metadata.failureKind, 'request_invalid');
  assert.equal(continued.status.message.metadata.effects, 'none');
  assert.equal(continued.status.message.metadata.boundary.results[0].code, 'review_origin_stale');
  assert.deepEqual(
    [continued.status.message.metadata.review.policyId, continued.status.message.metadata.review.kind,
      continued.status.message.metadata.review.checkpointId, continued.status.message.metadata.review.status,
      continued.status.message.metadata.review.reason, continued.status.message.metadata.review.accepted,
      continued.status.message.metadata.review.valid, continued.status.message.metadata.review.verdict],
    ['auditor-routing/v1', 'routine', 'verifier-checkpoint', 'rejected', 'review_origin_stale', false, false, null],
  );
  assert.deepEqual(continued.status.message.metadata.review.reviewCoverage, {
    targetKnown: true,
    targetIdentity: continued.status.message.metadata.review.reviewCoverage.targetIdentity,
    stable: false,
    reason: 'review_origin_stale',
  });
});

test('direct verifier continuation fails closed for missing, cross-run, corrupt, and ambiguous origins', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-verifier-origin-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'scope.txt'), 'candidate');
  const review = {
    kind: 'routine', checkpointId: 'verifier-origin-checkpoint', reason: 'Verify the current candidate.',
    paths: ['scope.txt'], evidenceIds: ['evidence-1'], prerequisiteFor: [],
  };
  const request = structured({ objective: 'Verify the current candidate.', allowedFiles: ['tests'], review });
  const lane = { id: 'verifier-origin-lane', path: path.join(root, 'lane'), workspacePath: root, base: 'base' };
  const writerExecution = {
    executionId: null, state: null, reason: null, effects: 'none',
    lane: { id: lane.id, state: 'not_integrated', reason: 'no_changes' },
    delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
  };
  const lanes = {
    async available() { return true; },
    async prepare() { return { lane }; },
    markRunning() {},
    laneInput(_lane, input) { return input; },
    sandboxPolicy() { return {}; },
    recordTurnStart() {},
    async complete() { return { canceled: false, writerExecution }; },
  };

  for (const originCase of ['missing', 'cross-run', 'missing-run', 'corrupt', 'conflicting-corrupt', 'wrong-role', 'ambiguous', 'overflow', 'unavailable']) {
    const stagingLog = new InMemoryStagingLog();
    let calls = 0;
    const appServer = {
      async run() {
        calls += 1;
        return {
          ...okResult(JSON.stringify(validReport({
            summary: 'Verified the current candidate.',
            filesInspected: ['scope.txt'],
            checks: [{ command: 'inspect scope', result: 'passed', detail: 'Current scope inspected.' }],
          }))),
          threadId: 'verifier-origin-thread',
        };
      },
    };
    const originRunId = 'verifier-origin-run';
    if (originCase !== 'missing' && originCase !== 'unavailable') {
      const originService = makeService(appServer, {
        roles: verifierRoles, workspace: root, lanes, stagingLog,
      });
      const origin = taskResult(await originService.agents.get('verifier').handler.sendMessage(
        sendParams(message(request, undefined, { runId: originRunId, assignmentId: 'verifier-origin', attemptId: 'origin-attempt' })), originService.context,
      ));
      assert.equal(origin.status.state, 3, `${originCase} setup`);
    }
    if (['corrupt', 'conflicting-corrupt', 'wrong-role', 'ambiguous', 'overflow'].includes(originCase)) {
      const event = [...stagingLog.events.values()].find((entry) => entry.type === 'verifier_started');
      assert.ok(event, `${originCase} setup must produce verifier origin evidence`);
      if (originCase === 'corrupt') {
        stagingLog.events.set(event.eventId, { ...event, target: null });
      } else if (originCase === 'conflicting-corrupt') {
        stagingLog.events.set('corrupt-verifier-origin', { ...event, eventId: 'corrupt-verifier-origin', target: null });
      } else if (originCase === 'wrong-role') {
        stagingLog.events.set('wrong-role-verifier-origin', { ...event, eventId: 'wrong-role-verifier-origin', role: 'auditor' });
      } else if (originCase === 'ambiguous') {
        stagingLog.events.set('ambiguous-verifier-origin', { ...event, eventId: 'ambiguous-verifier-origin', target: 'review-target/v1:other' });
      }
    }
    if (originCase === 'overflow') {
      const actualList = stagingLog.list.bind(stagingLog);
      stagingLog.list = (filter) => {
        const listed = actualList(filter);
        return [
          ...listed,
          ...Array.from({ length: 10000 - listed.length }, (_, index) => ({
            ...listed[0], eventId: `overflow-${index}`, attemptId: `unrelated-${index}`,
          })),
        ];
      };
    }
    if (originCase === 'unavailable') {
      stagingLog.list = () => { throw new Error('staging evidence unavailable'); };
    }
    const runId = originCase === 'cross-run' ? 'another-verifier-run'
      : originCase === 'missing-run' ? undefined : originRunId;
    const attemptId = originCase === 'missing' ? 'missing-attempt' : 'origin-attempt';
    const continuedRequest = JSON.stringify({
      ...JSON.parse(request),
      continuation: { ofAttemptId: attemptId, threadId: 'verifier-origin-thread', laneId: null, codexHome: null },
    });
    const continuedService = makeService(appServer, {
      roles: verifierRoles, workspace: root, lanes, stagingLog,
    });
    const failed = taskResult(await continuedService.agents.get('verifier').handler.sendMessage(
      sendParams(message(continuedRequest, undefined, { runId, assignmentId: 'verifier-retry', attemptId: `${originCase}-attempt` })), continuedService.context,
    ));
    assert.equal(failed.status.state, 4, originCase);
    assert.equal(failed.status.message.metadata.boundary.results[0].code, 'review_origin_unknown', originCase);
    assert.equal(calls, ['missing', 'unavailable'].includes(originCase) ? 0 : 1, `${originCase} must fail before appServer.run`);
  }
});

test('successful audit events retain checkpoint correlation without creating problem entries', async () => {
  const db = new Database(':memory:');
  const stagingLog = new StagingLog({ db });
  try {
    const { agents, context } = makeService({ async run() { return okResult(auditReport()); } }, {
      roles: auditorRoles, stagingLog,
    });
    const result = taskResult(await agents.get('auditor').handler.sendMessage(sendParams(message(auditRequest(), undefined, {
      runId: 'problem-separation-run', assignmentId: 'reviewer-1', attemptId: 'problem-separation-attempt',
    })), context));
    assert.equal(result.status.state, 3);
    const events = stagingLog.list({ runId: 'problem-separation-run' });
    assert.ok(events.every((event) => event.problemId === null));
    assert.ok(events.some((event) => event.type === 'audit_started' && event.payload.checkpointId === 'checkpoint-1'));
    assert.deepEqual(buildReport(db, { runId: 'problem-separation-run' }).problems, []);
  } finally {
    db.close();
  }
});

test('pinned-check fallback continuations fail closed when origin evidence is missing', async () => {
  const stagingLog = new InMemoryStagingLog();
  let calls = 0;
  const { agents, context } = makeService({ async run() { calls += 1; return okResult(auditReport('VERDICT: preserve')); } }, {
    roles: pinnedFallbackRoles, stagingLog,
  });
  const request = structured({
    objective: 'Review the pinned check.',
    allowedFiles: [],
    review: auditReview('pinned_check'),
    continuation: { ofAttemptId: 'missing-pinned-attempt', threadId: null, laneId: null, codexHome: null },
  });
  const failed = taskResult(await agents.get('explorer').handler.sendMessage(sendParams(message(request, undefined, {
    runId: 'pinned-continuation-run', assignmentId: 'reviewer-1', attemptId: 'pinned-attempt-2',
  })), context));
  assert.equal(failed.status.state, 4);
  assert.equal(failed.status.message.metadata.review.reason, 'review_origin_unknown');
  assert.equal(calls, 0);
  assert.equal(stagingLog.list({ type: 'pinned_check_started' }).length, 0);
});

test('pinned-check fallback continuation accepts a known unchanged origin', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-pinned-continuation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'scope.txt'), 'candidate');
  const stagingLog = new InMemoryStagingLog();
  const review = auditReview('pinned_check', ['scope.txt']);
  const request = structured({ objective: 'Review the pinned check.', allowedFiles: [], review });
  const report = auditReport('VERDICT: preserve', { filesInspected: ['scope.txt'] });
  let calls = 0;
  const makePinnedService = () => makeService({
    async run() { calls += 1; return { ...okResult(report), threadId: 'pinned-thread' }; },
  }, { roles: pinnedFallbackRoles, workspace: root, stagingLog });
  const firstService = makePinnedService();
  const first = taskResult(await firstService.agents.get('explorer').handler.sendMessage(
    sendParams(message(request, undefined, { runId: 'pinned-run', assignmentId: 'reviewer-1', attemptId: 'pinned-attempt-1' })), firstService.context,
  ));
  assert.equal(first.status.state, 3);
  assert.equal(first.artifacts[0].metadata.review.accepted, true);

  const continuedRequest = JSON.stringify({
    ...JSON.parse(request),
    continuation: { ofAttemptId: 'pinned-attempt-1', threadId: null, laneId: null, codexHome: null },
  });
  const continuedService = makePinnedService();
  const continued = taskResult(await continuedService.agents.get('explorer').handler.sendMessage(
    sendParams(message(continuedRequest, undefined, { runId: 'pinned-run', assignmentId: 'reviewer-2', attemptId: 'pinned-attempt-2' })), continuedService.context,
  ));
  assert.equal(continued.status.state, 3);
  assert.equal(continued.artifacts[0].metadata.review.accepted, true);
  assert.equal(calls, 2);
});

test('verifier binds coverage to the post-verification target after an authorized test-file write', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-verifier-'));
  try {
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/check.test.js'), 'before');
    let snapshots = 0;
    const admission = new WriterAdmission({
      db: new Database(':memory:'),
      workspace: root,
      snapshot: () => {
        snapshots += 1;
        return snapshots % 2 === 1
          ? { kind: 'git', head: 'h', entries: [], fingerprint: 'before' }
          : { kind: 'git', head: 'h', entries: [{ path: 'tests/check.test.js', status: 'M', sha256: 'after' }], fingerprint: 'after' };
      },
      quiescence: {},
      settleMs: 0,
    });
    const review = auditReview('routine', ['tests']);
    const { agents, context } = makeService({
      async run() {
        fs.writeFileSync(path.join(root, 'tests/check.test.js'), 'after');
        return okResult(JSON.stringify(validReport({
          summary: 'Tests pass against the integrated candidate.',
          filesChanged: ['tests/check.test.js'],
          filesInspected: ['tests/check.test.js'],
          checks: [{ command: 'node --test tests/check.test.js', result: 'passed', detail: '1 test passed.' }],
        })));
      },
    }, { roles: verifierRoles, workspace: root, admission });
    const result = taskResult(await agents.get('verifier').handler.sendMessage(
      sendParams(message(structured({ objective: 'Verify the integrated test candidate.', allowedFiles: ['tests'], review }))), context,
    ));
    assert.equal(result.status.state, 3);
    const { reviewCoverage } = result.artifacts[0].metadata;
    assert.equal(reviewCoverage.targetKnown, true);
    assert.ok(reviewCoverage.targetIdentity.startsWith('review-target/v1:'));
    assert.equal(reviewCoverage.stable, false);
    assert.equal(reviewCoverage.reason, 'verifier_target_changed_during_review');
    assert.equal(result.artifacts[0].metadata.review.accepted, true);
    assert.deepEqual(result.artifacts[0].metadata.writerExecution.delta.changedPaths, ['tests/check.test.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a writable verifier accepts a collected empty lane only with stable scope coverage', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-empty-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'src', 'file.js'), 'candidate');
  const lane = { id: 'lane-empty', path: path.join(root, 'lane'), workspacePath: root, base: 'base' };
  const writerExecution = {
    executionId: null, state: null, reason: null, effects: 'none',
    lane: { id: lane.id, state: 'not_integrated', reason: 'no_changes' },
    delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
  };
  const lanes = {
    async available() { return true; },
    async prepare() { return { lane }; },
    markRunning() {},
    laneInput(_lane, input) { return input; },
    sandboxPolicy() { return {}; },
    recordTurnStart() {},
    async complete() { return { canceled: false, writerExecution }; },
  };
  const review = auditReview('routine', ['src/file.js']);
  const { agents, context } = makeService({
    async run() {
      return okResult(JSON.stringify(validReport({
        summary: 'Focused verification passed.',
        filesInspected: ['src/file.js'],
        checks: [{ command: 'inspect', result: 'passed', detail: 'Scope checked.' }],
      })));
    },
  }, { roles: verifierRoles, workspace: root, lanes });
  const result = taskResult(await agents.get('verifier').handler.sendMessage(
    sendParams(message(structured({ objective: 'Verify without edits.', allowedFiles: ['tests'], review }))), context,
  ));
  assert.equal(result.status.state, 3);
  assert.equal(result.artifacts[0].metadata.review.status, 'accepted');
  assert.equal(result.artifacts[0].metadata.review.accepted, true);
  assert.equal(result.artifacts[0].metadata.reviewCoverage.stable, true);
  assert.deepEqual(result.artifacts[0].metadata.writerExecution.delta.changedPaths, []);
});

test('pinned-check fallback reviewer holds the workspace exclusively while ordinary explorer remains concurrent', async () => {
  const gate = deferred();
  let started;
  const runStarted = new Promise((resolve) => { started = resolve; });
  const admission = makeAdmission({});
  const { agents, context } = makeService({
    async run({ role }) {
      if (role.id === 'explorer') {
        started();
        await gate.promise;
        return okResult(auditReport('VERDICT: preserve'));
      }
      return okResult('ordinary read-only result');
    },
  }, { roles: pinnedFallbackRoles, admission });
  const review = auditReview('pinned_check');
  const pinnedPromise = agents.get('explorer').handler.sendMessage(
    sendParams(message(structured({ objective: 'Review the pinned check.', allowedFiles: [], review }))), context,
  );
  await runStarted;
  assert.equal(admission.holder()?.role, 'explorer');
  const ordinary = taskResult(await agents.get('scout').handler.sendMessage(sendParams(message('inspect without a review')), context));
  assert.equal(ordinary.status.state, 3);
  assert.equal(ordinary.artifacts[0].parts[0].content.value, 'ordinary read-only result');
  assert.equal(admission.holder()?.role, 'explorer');
  gate.resolve();
  const pinned = taskResult(await pinnedPromise);
  assert.equal(pinned.status.state, 3);
  assert.equal(pinned.artifacts[0].metadata.review.verdict, 'preserve');
  assert.equal(pinned.artifacts[0].metadata.reviewCoverage.stable, true);
  assert.equal(admission.holder(), null);
});

test('pinned-check fallback exposes reservation refusal as unknown coverage', async () => {
  const admission = makeAdmission({});
  await admission.acquire({ role: 'worker', taskId: 'held-task', contextId: 'held-context' });
  let calls = 0;
  const { agents, context } = makeService({ async run() { calls += 1; return okResult(auditReport('VERDICT: preserve')); } }, {
    roles: pinnedFallbackRoles, admission,
  });
  const failed = taskResult(await agents.get('explorer').handler.sendMessage(sendParams(message(structured({
    objective: 'Review the pinned check.', allowedFiles: [], review: auditReview('pinned_check'),
  }))), context));
  assert.equal(failed.status.state, 4);
  assert.equal(calls, 0);
  assert.equal(failed.status.message.metadata.reviewCoverage.targetKnown, false);
  assert.equal(failed.status.message.metadata.reviewCoverage.stable, false);
  assert.equal(failed.status.message.metadata.review.reason, 'review_writer_unsettled');
});

test('canceling an auditor turn reconciles and releases its exclusive reservation', async () => {
  const admission = new WriterAdmission({
    db: new Database(':memory:'),
    workspace: process.cwd(),
    snapshot: () => ({ kind: 'unavailable', reason: 'test' }),
    quiescence: { isProcessGroupGone: () => true },
    settleMs: 0,
  });
  let started;
  const runStarted = new Promise((resolve) => { started = resolve; });
  const { agents, context } = makeService({
    run({ signal, onTurnStart }) {
      onTurnStart({ processIdentity: { pid: 321 }, threadId: 'audit-thread' });
      started();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  }, { roles: auditorRoles, admission });
  const handler = agents.get('auditor').handler;
  const taskPromise = handler.sendMessage(sendParams(message(auditRequest()), { returnImmediately: true }), context);
  const submitted = taskResult(await taskPromise);
  await runStarted;
  assert.equal(admission.holder()?.role, 'auditor');
  await handler.cancelTask({ id: submitted.id }, context);
  for (let attempt = 0; attempt < 30 && admission.holder(); attempt += 1) await tick(10);
  assert.equal(admission.holder(), null);
  assert.equal(admission.findByContextId(submitted.contextId)?.state, 'reconciled');
});

test('auditor refuses an active writer and required staging log failures cannot accept a review', async () => {
  const admission = makeAdmission({});
  await admission.acquire({ role: 'worker', taskId: 'writer-task', contextId: 'writer-context' });
  let calls = 0;
  let service = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, { roles: auditorRoles, admission });
  let failed = taskResult(await service.agents.get('auditor').handler.sendMessage(
    sendParams(message(auditRequest())), service.context,
  ));
  assert.equal(failed.status.state, 4);
  assert.equal(calls, 0);
  assert.equal(failed.status.message.metadata.review.reason, 'review_writer_unsettled');

  const unresolvedAdmission = makeAdmission({});
  const writer = await unresolvedAdmission.acquire({ role: 'worker', taskId: 'writer-task-2', contextId: 'writer-context-2' });
  unresolvedAdmission.markUnresolved(writer.executionId, 'test');
  service = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, {
    roles: auditorRoles, admission: unresolvedAdmission,
  });
  failed = taskResult(await service.agents.get('auditor').handler.sendMessage(
    sendParams(message(auditRequest())), service.context,
  ));
  assert.equal(failed.status.state, 4);
  assert.equal(failed.status.message.metadata.review.reason, 'review_writer_unsettled');

  let logCalls = 0;
  const failedLogAdmission = makeAdmission({});
  service = makeService({ async run() { calls += 1; return okResult(auditReport()); } }, {
    roles: auditorRoles,
    admission: failedLogAdmission,
    stagingLog: { record() { logCalls += 1; if (logCalls === 2) throw new Error('log unavailable'); } },
  });
  failed = taskResult(await service.agents.get('auditor').handler.sendMessage(
    sendParams(message(auditRequest())), service.context,
  ));
  assert.equal(failed.status.state, 4);
  assert.equal(failed.status.message.metadata.review.reason, 'staging_log_unavailable');
  assert.equal(calls, 0);
  assert.equal(failedLogAdmission.holder(), null, 'a result-log failure releases the audit reservation');
});

test('staging events correlate direct audits and store bounded redacted report summaries', async () => {
  const stagingLog = new InMemoryStagingLog();
  const { agents, context } = makeService({ async run() { return okResult(auditReport('VERDICT: pass\nBearer abcdefghijklmnop')); } }, {
    roles: auditorRoles, stagingLog,
  });
  const result = taskResult(await agents.get('auditor').handler.sendMessage(sendParams(message(auditRequest(), undefined, {
    runId: 'run-7', assignmentId: 'assignment-8', attemptId: 'attempt-9',
  })), context));
  assert.equal(result.status.state, 3);
  const events = stagingLog.list({ runId: 'run-7' });
  assert.deepEqual(events.map((event) => event.type), [
    'role_selected', 'audit_selected', 'audit_started', 'review_continuation_emitted', 'audit_result',
  ]);
  assert.ok(events.every((event) => event.assignmentId === 'assignment-8' && event.attemptId === 'attempt-9'));
  const continuationBinding = events.find((event) => event.type === 'review_continuation_emitted');
  assert.deepEqual(Object.keys(continuationBinding.payload).sort(), ['checkpointId', 'kind', 'policyId', 'tupleDigest', 'version']);
  assert.equal(continuationBinding.payload.version, 1);
  assert.match(continuationBinding.payload.tupleDigest, /^[a-f0-9]{64}$/);
  const payload = events.at(-1).payload;
  assert.match(payload.summary, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(payload.summary, /abcdefghijklmnop/);

  const failingService = makeService({ async run() { throw new Error('model unavailable'); } }, { roles: auditorRoles, stagingLog });
  const failed = taskResult(await failingService.agents.get('auditor').handler.sendMessage(sendParams(message(auditRequest(), undefined, {
    runId: 'run-10', assignmentId: 'assignment-11', attemptId: 'attempt-12',
  })), failingService.context));
  assert.equal(failed.status.state, 4);
  const failureEvents = stagingLog.list({ runId: 'run-10', type: 'audit_failure' });
  assert.equal(failureEvents.length, 1);
  assert.equal(failureEvents[0].assignmentId, 'assignment-11');
  assert.equal(failureEvents[0].attemptId, 'attempt-12');
});

test('non-auditor direct calls retain plain-text support and emit best-effort role telemetry', async () => {
  const stagingLog = new InMemoryStagingLog();
  const { agents, context } = makeService({ async run() { return okResult('plain result'); } }, { stagingLog });
  const result = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('legacy plain request')), context));
  assert.equal(result.status.state, 3);
  assert.equal(result.artifacts[0].parts[0].content.value, 'plain result');
  assert.deepEqual(stagingLog.list().map((event) => event.type), ['role_selected', 'role_started', 'role_result']);
});
