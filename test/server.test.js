'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { startServer, makeLeadExecutor, registerLead, rejectOverlappingLeadTask, protectRoleRpcMounts } = require('../src/server');
const { makeLeadCard } = require('../src/server');

test('startup requires a ChatGPT OAuth account and closes the app server on rejection', async () => {
  let closed = false;
  await assert.rejects(startServer({
    listen: false,
    appServer: {
      async start() {},
      async getAccount() { return { account: { type: 'apiKey' } }; },
      async close() { closed = true; },
    },
  }), /requires an authenticated ChatGPT account/);
  assert.equal(closed, true);
});

test('lead executor publishes working, artifact and completed task events', async () => {
  const seen = [];
  const executor = makeLeadExecutor({
    orchestrator: {
      async run({ goal }) {
        assert.equal(goal, 'Build the feature');
        return { status: 'completed', text: 'Done', rounds: 2, assignments: ['orch-dev'] };
      },
    },
  });
  const taskId = 'task-1';
  await executor.execute({
    taskId,
    contextId: 'context-1',
    userMessage: { parts: [{ content: { $case: 'text', value: 'Build the feature' } }] },
  }, { publish: (event) => seen.push(event) });

  assert.equal(seen[0].kind, 'task');
  assert.equal(seen[1].data.status.state, TaskState.TASK_STATE_WORKING);
  assert.equal(seen[2].kind, 'artifactUpdate');
  assert.equal(seen[2].data.artifact.parts[0].content.value, 'Done');
  assert.equal(seen[3].data.status.state, TaskState.TASK_STATE_COMPLETED);
});

test('lead executor reports orchestrator exceptions as failed tasks', async () => {
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator: { async run() { throw new Error('dispatch failed'); } } });
  await executor.execute({ taskId: 'task-2', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, {
    publish: (event) => seen.push(event),
  });
  const finalStatus = seen.at(-1).data.status;
  assert.equal(finalStatus.state, TaskState.TASK_STATE_FAILED);
  assert.equal(finalStatus.message.parts[0].content.value, 'dispatch failed');
});

test('lead executor fails closed for a nonterminal orchestrator result', async () => {
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator: { async run() { return { status: 'paused', text: 'Needs review' }; } } });
  await executor.execute({ taskId: 'task-3', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, {
    publish: (event) => seen.push(event),
  });
  assert.equal(seen.some((event) => event.kind === 'artifactUpdate'), false);
  assert.equal(seen.at(-1).data.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(seen.at(-1).data.status.message.parts[0].content.value, 'Needs review');
});

test('lead card route is registered before the JSON-RPC route', async () => {
  const mounts = [];
  const authMiddleware = () => {};
  registerLead({ use: (...args) => mounts.push(args) }, {
    leadRole: { name: 'orch-lead', description: 'Lead' },
    orchestrator: { async run() {} },
    baseUrl: 'http://127.0.0.1:3000',
    authMiddleware,
  });
  assert.deepEqual(mounts.map(([path, ...handlers]) => [path, handlers.includes(authMiddleware)]), [
    ['/orchestrator/agent-card.json', false],
    ['/orchestrator', true],
  ]);
  assert.equal(mounts[1][2].name, 'jsonParser');
  assert.equal(mounts[1][3].name, 'rejectOverlappingLeadTaskMiddleware');
});

test('lead card bearer scheme survives A2A card JSON round trip', () => {
  const card = makeLeadCard({ leadRole: { name: 'orch-lead', description: 'Lead' }, endpoint: 'http://127.0.0.1:3000/orchestrator' });
  const wireCard = AgentCard.toJSON(card);
  const decodedCard = AgentCard.fromJSON(wireCard);
  assert.deepEqual(wireCard.securitySchemes.localBearer.httpAuthSecurityScheme, {
    description: 'Local A2A access token.',
    scheme: 'Bearer',
    bearerFormat: 'opaque',
  });
  assert.equal(decodedCard.securitySchemes.localBearer.scheme.$case, 'httpAuthSecurityScheme');
});

test('specialist RPC mounts require bearer auth while their cards remain public', () => {
  const mounts = [];
  const app = { use: (...args) => mounts.push(args), get() {} };
  const authMiddleware = () => {};
  const protectedApp = protectRoleRpcMounts(app, authMiddleware);
  protectedApp.use('/agents/orch-builder', () => {});
  protectedApp.use('/agents/orch-builder/agent-card.json', () => {});
  assert.equal(mounts[0][1], authMiddleware);
  assert.equal(mounts[1][1] === authMiddleware, false);
});

test('lead executor reports cancellation as failed until downstream cancellation is confirmed', async () => {
  const seen = [];
  const executor = makeLeadExecutor({
    orchestrator: {
      run({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      },
    },
  });
  const pending = executor.execute({ taskId: 'task-cancel', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, {
    publish: (event) => seen.push(event),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await executor.cancelTask('task-cancel');
  await pending;
  const finalStatus = seen.at(-1).data.status;
  assert.equal(finalStatus.state, TaskState.TASK_STATE_FAILED);
  assert.match(finalStatus.message.parts[0].content.value, /cancellation could not be confirmed/);
});

test('pre-SDK duplicate guard leaves the original lead task running to completion', async () => {
  const executorEvents = [];
  let finishFirst;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const executor = makeLeadExecutor({
    orchestrator: { run: () => new Promise((resolve) => { finishFirst = resolve; started(); }) },
  });
  const context = { taskId: 'same-task', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } };
  const duplicateGuard = rejectOverlappingLeadTask(executor);
  const responseListeners = new Map();
  const firstResponse = { once: (event, callback) => responseListeners.set(event, callback) };
  let firstPassedToSdk = false;
  duplicateGuard({
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { taskId: 'same-task' } } },
  }, firstResponse, () => { firstPassedToSdk = true; });
  assert.equal(firstPassedToSdk, true);
  assert.equal(executor.isTaskActive('same-task'), true);

  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let passedToSdk = false;
  duplicateGuard({
    method: 'POST',
    body: { jsonrpc: '2.0', id: 7, method: 'SendMessage', params: { message: { taskId: 'same-task' } } },
  }, response, () => { passedToSdk = true; });
  assert.equal(passedToSdk, false);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.error.code, -32000);
  assert.equal(executor.isTaskActive('same-task'), true);

  const first = executor.execute(context, { publish: (event) => executorEvents.push(event) });
  await running;
  finishFirst({ status: 'completed', text: 'first result' });
  await first;
  assert.equal(executorEvents.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(executor.isTaskActive('same-task'), false);
});

test('port zero uses the actual bound port for A2A worker URLs without TCP in the test', async () => {
  const tokenDirectory = `/tmp/codex-a2a-port-test-${process.pid}`;
  const tokenPath = `${tokenDirectory}/a2a-token`;
  let orchestratorOptions;
  const runtime = await startServer({
    port: 0,
    tokenFile: tokenPath,
    appServer: {
      async start() {},
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async run() {},
      async close() {},
    },
    listenImpl(_app, _port, _host, callback) {
      const server = { address: () => ({ port: 43123 }), once() {}, close(done) { done(); } };
      queueMicrotask(callback);
      return server;
    },
    orchestratorFactory(options) {
      orchestratorOptions = options;
      return { async run() { return { status: 'completed', text: 'ok' }; } };
    },
  });
  try {
    assert.equal(orchestratorOptions.baseUrl, 'http://127.0.0.1:43123');
    assert.match(orchestratorOptions.authToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(require('node:fs').readFileSync(tokenPath, 'utf8'), orchestratorOptions.authToken);
  } finally {
    await runtime.close();
    require('node:fs').rmSync(tokenDirectory, { recursive: true, force: true });
  }
});

test('startup closes App Server after role profile loading fails', async () => {
  let closed = false;
  const tokenDirectory = `/tmp/codex-a2a-startup-test-${process.pid}`;
  const tokenPath = `${tokenDirectory}/a2a-token`;
  await assert.rejects(startServer({
    listen: false,
    profilesDir: `/tmp/missing-profiles-${process.pid}`,
    tokenFile: tokenPath,
    appServer: {
      async start() {},
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async close() { closed = true; },
    },
  }), /Role profiles directory is missing/);
  assert.equal(closed, true);
  require('node:fs').rmSync(tokenDirectory, { recursive: true, force: true });
});

test('startup closes App Server after HTTP listen fails', async () => {
  let closed = false;
  const tokenDirectory = `/tmp/codex-a2a-listen-test-${process.pid}`;
  await assert.rejects(startServer({
    port: 3000,
    tokenFile: `${tokenDirectory}/a2a-token`,
    appServer: {
      async start() {},
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async run() {},
      async close() { closed = true; },
    },
    listenImpl() { throw new Error('listen denied'); },
  }), /listen denied/);
  assert.equal(closed, true);
  require('node:fs').rmSync(tokenDirectory, { recursive: true, force: true });
});

test('shutdown interrupts active lead execution before draining HTTP requests', async () => {
  const events = [];
  const tokenDirectory = `/tmp/codex-a2a-shutdown-test-${process.pid}`;
  let execution;
  let markRunning;
  const running = new Promise((resolve) => { markRunning = resolve; });
  const appServer = {
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async run() {},
    async close() { events.push('app-server-close'); },
  };
  const runtime = await startServer({
    tokenFile: `${tokenDirectory}/a2a-token`,
    appServer,
    listenImpl(_app, _port, _host, callback) {
      const server = {
        address: () => ({ port: 43124 }),
        once() {},
        close(done) {
          events.push('http-close');
          execution.then(() => done());
        },
      };
      queueMicrotask(callback);
      return server;
    },
    orchestratorFactory: () => ({
      run({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          markRunning();
        });
      },
    }),
  });
  const eventsSeen = [];
  execution = runtime.leadAgent.executor.execute({
    taskId: 'active-at-shutdown',
    contextId: 'ctx',
    userMessage: { parts: [{ text: 'goal' }] },
  }, { publish: (event) => eventsSeen.push(event) });
  await running;
  await runtime.close();
  assert.ok(events.indexOf('app-server-close') < events.indexOf('http-close'));
  assert.equal(eventsSeen.at(-1).data.status.state, TaskState.TASK_STATE_FAILED);
  require('node:fs').rmSync(tokenDirectory, { recursive: true, force: true });
});
