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
const { registerRoleAgents } = require('../src/a2a-role-service');
const { WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT } = require('../src/contracts');

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

function message(text, parts) {
  return {
    messageId: `message-${Math.random()}`,
    role: 1,
    parts: parts || [{ content: { $case: 'text', value: text } }],
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

test('passes the worker report schema and tags the result artifact with contract metadata', async () => {
  const calls = [];
  const { agents, context } = makeService({
    async run(options) {
      calls.push(options);
      return { threadId: 'thread-7', status: 'completed', text: '{"raw":true}' };
    },
  });
  const result = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('go')), context));
  assert.equal(calls[0].outputSchema, WORKER_REPORT_SCHEMA);
  const artifact = result.artifacts[0];
  assert.equal(artifact.parts[0].content.value, '{"raw":true}');
  assert.deepEqual(artifact.metadata, { contract: WORKER_REPORT_CONTRACT, threadId: 'thread-7' });

  const { agents: other, context: otherContext } = makeService({ async run() { return { status: 'completed', text: 'x' }; } });
  const noThread = taskResult(await other.get('orch-planner').handler.sendMessage(sendParams(message('go')), otherContext));
  assert.equal(noThread.artifacts[0].metadata.threadId, null);
});

test('failed status messages carry failureKind and codexErrorInfo metadata', async () => {
  const cases = [
    { error: Object.assign(new Error('limit'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } }), kind: 'usage_limit', info: 'usageLimitExceeded' },
    { error: new Error('plain', { cause: { rpcData: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } } }), kind: 'usage_limit', info: { httpConnectionFailed: { httpStatusCode: 429 } } },
    { error: new Error('plain'), kind: 'other', info: null },
  ];
  for (const { error, kind, info } of cases) {
    const { agents, context } = makeService({ async run() { throw error; } });
    const failed = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('x')), context));
    assert.equal(failed.status.state, 4);
    assert.deepEqual(failed.status.message.metadata, { failureKind: kind, codexErrorInfo: info });
  }

  const { agents, context } = makeService({ async run() { return { status: 'interrupted', text: 'partial' }; } });
  const nonCompleted = taskResult(await agents.get('orch-planner').handler.sendMessage(sendParams(message('x')), context));
  assert.deepEqual(nonCompleted.status.message.metadata, { failureKind: 'other', codexErrorInfo: null });

  const { agents: parse, context: parseContext } = makeService({ async run() { return { status: 'completed', text: '' }; } });
  const bad = taskResult(await parse.get('orch-planner').handler.sendMessage(sendParams(message('', [
    { content: { $case: 'data', value: {} } },
  ])), parseContext));
  assert.deepEqual(bad.status.message.metadata, { failureKind: 'other', codexErrorInfo: null });
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
