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

test('a role override is applied from the next dispatch and the base roles stay untouched', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createRoleOverrideSource, writeOverridesFile, RULES_HEADING } = require('../src/role-overrides');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-role-overrides-'));
  try {
    const file = path.join(dir, 'role-overrides.json');
    const roleSource = createRoleOverrideSource({ file, roles, leadRole: { name: 'coordinator', model: 'lead', effort: 'low', instructions: 'Lead.' } });
    const calls = [];
    const { agents, context } = makeService({
      async run(options) {
        calls.push(options.role);
        return { threadId: 'thread', turnId: 'turn', status: 'completed', text: 'ok' };
      },
    }, { roleSource });
    const send = (id, text) => agents.get(id).handler.sendMessage(sendParams(message(text)), context);

    await send('orch-planner', 'first');
    writeOverridesFile(file, { 'orch-planner': { model: 'gpt-6-luna', effort: 'high', extraRules: 'Plan in two steps.' } });
    await send('orch-planner', 'second');
    await send('orch-reviewer', 'review');
    writeOverridesFile(file, {});
    await send('orch-planner', 'third');

    assert.deepEqual(calls.map((role) => [role.id, role.model, role.effort]), [
      ['orch-planner', 'test', 'low'],
      ['orch-planner', 'gpt-6-luna', 'high'],
      ['orch-reviewer', 'test', 'low'],
      ['orch-planner', 'test', 'low'],
    ]);
    assert.equal(calls[0].instructions, 'Plan.');
    assert.equal(calls[1].instructions, `Plan.\n\n${RULES_HEADING}\nPlan in two steps.`);
    assert.equal(calls[1].sandbox, 'read-only');
    assert.equal(calls[3].instructions, 'Plan.');
    assert.equal(roles.get('orch-planner').model, 'test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
