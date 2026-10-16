'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { startServer, describePause, makeLeadExecutor, registerLead, registerControl, rejectOverlappingLeadTask, protectRoleRpcMounts } = require('../src/server');
const { makeLeadCard } = require('../src/server');
const fs = require('node:fs');
const { ResumeInputError } = require('../src/lead-orchestrator');
const os = require('node:os');
const path = require('node:path');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { openStateDatabase, createTaskStore } = require('../src/durable-store');
const { WriterAdmission } = require('../src/writer-admission');
const { validateAcceptanceContract } = require('../src/acceptance');
const { createRuntimeIdentity } = require('../src/runtime-identity');
const { createAuthMiddleware } = require('../src/local-auth');
const { parseTrialRunIds } = require('../src/aut03-lead-skill');

// Test files run in parallel processes; keep workspace locks private to this process.
process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));

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
  protectedApp.use('/agents/engineer', () => {});
  protectedApp.use('/agents/engineer/agent-card.json', () => {});
  assert.equal(mounts[0][1], authMiddleware);
  assert.equal(mounts[1][1] === authMiddleware, false);
  assert.equal(mounts[2][1], authMiddleware);
  assert.equal(mounts[3][1] === authMiddleware, false);
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
    stateFile: ':memory:',
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
    assert.equal(typeof orchestratorOptions.usageLedger.record, 'function');
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
    stateFile: ':memory:',
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
    stateFile: ':memory:',
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
    stateFile: ':memory:',
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
  // STOP-01: a shutdown parks the run as a resumable stopped pause instead of failing it.
  assert.equal(eventsSeen.at(-1).data.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(eventsSeen.at(-1).data.metadata.pause.kind, 'stopped');
  require('node:fs').rmSync(tokenDirectory, { recursive: true, force: true });
});

// ------------------------------------------------ durable state and pause/resume

const CHATGPT_APP_SERVER = () => ({
  async start() {},
  async getAccount() { return { account: { type: 'chatgpt' } }; },
  async run() {},
  async close() {},
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-server-test-'));
}

function userMessage(text, extra = {}) {
  return {
    messageId: `msg-${Math.random().toString(16).slice(2)}`,
    contextId: '',
    taskId: '',
    role: 1,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
    ...extra,
  };
}

function statusText(task) {
  return task.status?.message?.parts?.map((part) => part.content?.value).join('\n') || '';
}

async function startLeadServer(orchestrator, dir, extra = {}) {
  return startServer({
    listen: false,
    stateFile: ':memory:',
    tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory: () => orchestrator,
    ...extra,
  });
}

const CALL = () => new ServerCallContext({ tenant: '' });

const HUMAN_PAUSE = {
  kind: 'human_decision',
  decisionId: 'run:h1',
  reason: 'product_choice',
  question: 'Which storage?',
  options: [{ id: 'a', description: 'SQLite' }, { id: 'b', description: 'Postgres' }],
  recommendation: 'a',
  evidenceChecked: ['README'],
  independentWork: 'none',
  relatedDecisionIds: [],
};

test('startup passes checkpointer and journal to the orchestrator factory', async () => {
  const dir = tmpDir();
  let options;
  const runtime = await startLeadServer({ async run() {} }, dir, { orchestratorFactory: (o) => { options = o; return { async run() {} }; } });
  try {
    assert.ok(options.checkpointer);
    assert.equal(typeof options.journal.recordSubmitting, 'function');
    assert.equal(typeof options.stagingLog.record, 'function');
    assert.equal(options.stagingLog.db, runtime.state.db);
    assert.deepEqual(options.stagingLog.list(), []);
    assert.equal(options.leadRole.name, 'coordinator');
    assert.ok(options.skillCatalog instanceof Map);
    assert.deepEqual(options.aut03TrialRunIds, new Set());
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUT-03 startup parses only exact UUID allowlist values', async (t) => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(parseTrialRunIds(''), new Set());
  assert.deepEqual(parseTrialRunIds(id), new Set([id]));
  assert.throws(() => parseTrialRunIds(`${id},${id}`), /unique lowercase UUIDs/);
  assert.throws(() => parseTrialRunIds(`${id},not-a-uuid`), /unique lowercase UUIDs/);
  assert.throws(() => parseTrialRunIds(id.toUpperCase()), /unique lowercase UUIDs/);

  const previous = process.env.CODEX_A2A_AUT03_TRIAL_RUN_IDS;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_A2A_AUT03_TRIAL_RUN_IDS;
    else process.env.CODEX_A2A_AUT03_TRIAL_RUN_IDS = previous;
  });
  process.env.CODEX_A2A_AUT03_TRIAL_RUN_IDS = id;
  let options;
  const dir = tmpDir();
  const runtime = await startServer({
    listen: false,
    stateFile: ':memory:',
    tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory(value) { options = value; return { async run() {} }; },
  });
  try {
    assert.deepEqual(options.aut03TrialRunIds, new Set([id]));
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup reconciliation runs after listen and rewrites stale tasks', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.sqlite');
  const seed = await openStateDatabase({ filePath: stateFile });
  const working = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() };
  await createTaskStore(seed, 'orchestrator').save({ id: 'lead-stale', contextId: 'c1', status: working, artifacts: [], history: [], metadata: {} }, CALL());
  await createTaskStore(seed, 'orch-builder').save({ id: 'spec-stale', contextId: 'c2', status: working, artifacts: [], history: [], metadata: {} }, CALL());
  await seed.close();

  const events = [];
  const runtime = await startServer({
    port: 0,
    stateFile,
    tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory: () => ({ async run() {} }),
    listenImpl(_app, _port, _host, callback) {
      events.push('listen');
      const server = { address: () => ({ port: 43125 }), once() {}, close(done) { done(); } };
      queueMicrotask(callback);
      return server;
    },
  });
  try {
    assert.deepEqual(events, ['listen']);
    const lead = await runtime.leadAgent.requestHandler.getTask({ id: 'lead-stale' }, CALL());
    assert.equal(lead.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(lead.metadata.pause.kind, 'restart');
    const specialistStore = createTaskStore(runtime.state, 'orch-builder');
    const specialist = await specialistStore.load('spec-stale', CALL());
    assert.equal(specialist.status.state, TaskState.TASK_STATE_FAILED);
    assert.equal(specialist.status.message.metadata.failureKind, 'interrupted');
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('close() closes the state database', async () => {
  const dir = tmpDir();
  const runtime = await startLeadServer({ async run() {} }, dir);
  assert.equal(runtime.state.db.open, true);
  await runtime.close();
  assert.equal(runtime.state.db.open, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pause result becomes INPUT_REQUIRED with metadata.pause visible through getTask', async () => {
  const dir = tmpDir();
  const runs = [];
  const runtime = await startLeadServer({
    async run(args) { runs.push(args); return { runId: args.runId, status: 'input_required', text: '', rounds: 1, assignments: [], pause: HUMAN_PAUSE }; },
    async getPause() { return HUMAN_PAUSE; },
  }, dir);
  try {
    const handler = runtime.leadAgent.requestHandler;
    const task = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    assert.equal(runs[0].runId, task.id);
    assert.equal(task.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    const stored = await handler.getTask({ id: task.id }, CALL());
    assert.deepEqual(stored.metadata.pause, HUMAN_PAUSE);
    const text = statusText(stored);
    assert.match(text, /Which storage\?/);
    assert.match(text, /a: SQLite/);
    assert.match(text, /Recommendation: a/);
    assert.match(text, /Decision ID: run:h1/);
    assert.match(text, new RegExp(`npm run ask -- --task ${task.id} --decision run:h1 --choice <optionId> "<answer>"`));
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a follow-up message resumes the paused task and clears metadata.pause', async () => {
  const dir = tmpDir();
  const resumes = [];
  const runtime = await startLeadServer({
    async run(args) { return { runId: args.runId, status: 'input_required', text: '', rounds: 1, assignments: [], pause: HUMAN_PAUSE }; },
    async getPause() { return HUMAN_PAUSE; },
    async resume(args) { resumes.push(args); return { runId: args.runId, status: 'completed', text: 'Final answer', rounds: 2, assignments: ['orch-dev'] }; },
  }, dir);
  try {
    const handler = runtime.leadAgent.requestHandler;
    const paused = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    const done = await handler.sendMessage({
      message: userMessage('use sqlite', { taskId: paused.id, contextId: paused.contextId, metadata: { choice: 'a', decisionId: 'run:h1' } }),
      configuration: {},
    }, CALL());
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].runId, paused.id);
    assert.deepEqual(resumes[0].input, { answer: 'use sqlite', choice: 'a', decisionId: 'run:h1' });
    assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
    const stored = await handler.getTask({ id: paused.id }, CALL());
    assert.equal(stored.metadata.pause, null);
    assert.equal(stored.artifacts.at(-1).parts[0].content.value, 'Final answer');
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a decisionId mismatch keeps INPUT_REQUIRED and does not resume', async () => {
  const dir = tmpDir();
  let resumed = 0;
  const runtime = await startLeadServer({
    async run(args) { return { runId: args.runId, status: 'input_required', text: '', rounds: 1, assignments: [], pause: HUMAN_PAUSE }; },
    async getPause() { return HUMAN_PAUSE; },
    async resume() { resumed += 1; return { status: 'completed', text: 'x' }; },
  }, dir);
  try {
    const handler = runtime.leadAgent.requestHandler;
    const paused = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    const again = await handler.sendMessage({
      message: userMessage('answer', { taskId: paused.id, contextId: paused.contextId, metadata: { decisionId: 'run:h9' } }),
      configuration: {},
    }, CALL());
    assert.equal(resumed, 0);
    assert.equal(again.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.match(statusText(again), /does not match the pending decision "run:h1"/);
    const stored = await handler.getTask({ id: paused.id }, CALL());
    assert.deepEqual(stored.metadata.pause, HUMAN_PAUSE);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart and budget pauses resume with the plain answer and a completed task rejects messages', async () => {
  const dir = tmpDir();
  const resumes = [];
  const budgetPause = { kind: 'waiting_for_budget', source: 'lead', message: 'usage limit', resetsAt: null };
  const runtime = await startLeadServer({
    async run(args) { return { runId: args.runId, status: 'waiting_for_budget', text: '', rounds: 0, assignments: [], pause: budgetPause }; },
    async getPause() { return budgetPause; },
    async resume(args) { resumes.push(args); return { runId: args.runId, status: 'completed', text: 'ok', rounds: 1, assignments: [] }; },
  }, dir);
  try {
    const handler = runtime.leadAgent.requestHandler;
    const paused = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    assert.equal(paused.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(paused.metadata.pause.kind, 'waiting_for_budget');
    const done = await handler.sendMessage({ message: userMessage('retry', { taskId: paused.id, contextId: paused.contextId }), configuration: {} }, CALL());
    assert.deepEqual(resumes[0].input, { answer: 'retry' });
    assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
    await assert.rejects(
      handler.sendMessage({ message: userMessage('more', { taskId: paused.id, contextId: paused.contextId }), configuration: {} }, CALL()),
      /terminal state/,
    );
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lead executor resumes a restart pause with an empty message', async () => {
  const seen = [];
  const resumes = [];
  const executor = makeLeadExecutor({
    orchestrator: { async resume(args) { resumes.push(args); return { status: 'completed', text: 'back' }; } },
  });
  await executor.execute({
    taskId: 't-restart',
    contextId: 'ctx',
    task: { id: 't-restart', contextId: 'ctx', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, artifacts: [], history: [], metadata: { pause: { kind: 'restart' } } },
    userMessage: { parts: [{ text: '' }] },
  }, { publish: (event) => seen.push(event) });
  assert.deepEqual(resumes[0], { runId: 't-restart', input: { answer: '' }, signal: resumes[0].signal, onEvent: resumes[0].onEvent, contextId: 'ctx' });
  assert.equal(typeof resumes[0].onEvent, 'function');
  assert.equal(seen.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED);
});

// ---------------------------------------------------- audit regression tests


function pausedContext(taskId, pause, userMessage, extra = {}) {
  return {
    taskId,
    contextId: 'ctx',
    task: { id: taskId, contextId: 'ctx', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED }, artifacts: [], history: [], metadata: { pause }, ...extra },
    userMessage,
  };
}

function lastStatus(seen) {
  return seen.filter((event) => event.kind === 'statusUpdate').at(-1).data;
}

test('input problems on a paused task republish the same pause instead of failing', async () => {
  const restart = { kind: 'restart' };
  let resumes = 0;
  const orchestrator = {
    async getPause() { return null; },
    async resume() { resumes += 1; return { status: 'completed', text: 'x' }; },
  };
  const human = { ...HUMAN_PAUSE };
  const humanOrchestrator = { ...orchestrator, async getPause() { return human; } };
  const cases = [
    { orchestrator, pause: restart, message: { parts: [{ content: { $case: 'data', value: {} } }] }, note: /text parts only/ },
    { orchestrator: humanOrchestrator, pause: human, message: { parts: [{ text: '  ' }] }, note: /non-empty text/ },
  ];
  for (const entry of cases) {
    const seen = [];
    const executor = makeLeadExecutor({ orchestrator: entry.orchestrator });
    await executor.execute(pausedContext('t-input', entry.pause, entry.message), { publish: (event) => seen.push(event) });
    const final = lastStatus(seen);
    assert.equal(final.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.deepEqual(final.metadata.pause, entry.pause);
    assert.match(statusText({ status: final.status }), entry.note);
  }
  assert.equal(resumes, 0);

  for (const error of [new ResumeInputError('bad input'), new ResumeInputError('decisionId x does not match')]) {
    const seen = [];
    const executor = makeLeadExecutor({ orchestrator: { async getPause() { return human; }, async resume() { throw error; } } });
    await executor.execute(pausedContext('t-throw', human, { parts: [{ text: 'answer' }] }), { publish: (event) => seen.push(event) });
    const final = lastStatus(seen);
    assert.equal(final.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.deepEqual(final.metadata.pause, human);
  }
});

test('a resumable run error becomes an error pause and a follow-up retries; otherwise FAILED', async () => {
  const seen = [];
  const long = 'x'.repeat(5000);
  const executor = makeLeadExecutor({ orchestrator: { async run() { throw Object.assign(new Error(long), { name: 'BoomError' }); }, async isResumable() { return true; } } });
  await executor.execute({ taskId: 't-err', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, { publish: (event) => seen.push(event) });
  const final = lastStatus(seen);
  assert.equal(final.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(final.metadata.pause.kind, 'error');
  assert.equal(final.metadata.pause.errorName, 'BoomError');
  assert.equal(final.metadata.pause.message.length, 2000);
  assert.match(statusText({ status: final.status }), /retry the failed step/);

  const resumes = [];
  const seen2 = [];
  const retry = makeLeadExecutor({ orchestrator: { async getPause() { return null; }, async resume(args) { resumes.push(args); return { status: 'completed', text: 'ok' }; } } });
  await retry.execute(pausedContext('t-err', final.metadata.pause, { parts: [{ text: 'try again' }] }), { publish: (event) => seen2.push(event) });
  assert.deepEqual(resumes[0].input, { answer: 'try again' });
  assert.equal(lastStatus(seen2).status.state, TaskState.TASK_STATE_COMPLETED);

  const failing = [];
  const notResumable = makeLeadExecutor({ orchestrator: { async run() { throw new Error('nope'); }, async isResumable() { return false; } } });
  await notResumable.execute({ taskId: 't-fail', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, { publish: (event) => failing.push(event) });
  assert.equal(lastStatus(failing).status.state, TaskState.TASK_STATE_FAILED);

  const canceled = [];
  const unconfirmed = makeLeadExecutor({
    orchestrator: {
      run({ signal }) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('late')), { once: true })); },
      async isResumable() { return true; },
    },
  });
  const running = unconfirmed.execute({ taskId: 't-abort', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, { publish: (event) => canceled.push(event) });
  await new Promise((resolve) => setImmediate(resolve));
  await unconfirmed.cancelTask('t-abort', { publish() {}, finished() {} });
  await running;
  assert.equal(lastStatus(canceled).status.state, TaskState.TASK_STATE_FAILED);
});

test('cancelTask on a paused lead task returns CANCELED promptly', async () => {
  const dir = tmpDir();
  const runtime = await startLeadServer({
    async run(args) { return { runId: args.runId, status: 'input_required', text: '', rounds: 1, assignments: [], pause: HUMAN_PAUSE }; },
    async getPause() { return HUMAN_PAUSE; },
  }, dir);
  try {
    const handler = runtime.leadAgent.requestHandler;
    const paused = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    const canceled = await Promise.race([
      handler.cancelTask({ id: paused.id }, CALL()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung')), 1000)),
    ]);
    assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await handler.getTask({ id: paused.id }, CALL())).metadata.pause, null);

    // The executor itself ends a task when the SDK still hands it an event bus.
    const published = [];
    let finished = 0;
    await runtime.leadAgent.executor.cancelTask('other-task', { publish: (event) => published.push(event), finished: () => { finished += 1; } });
    assert.equal(published[0].data.status.state, TaskState.TASK_STATE_CANCELED);
    assert.equal(published[0].data.metadata.pause, null);
    assert.equal(finished, 1);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the resume path follows the checkpoint pause, not stale task metadata', async () => {
  const human = { ...HUMAN_PAUSE };
  const resumes = [];
  const orchestrator = { async getPause() { return human; }, async resume(args) { resumes.push(args); return { status: 'completed', text: 'ok' }; } };

  const seen = [];
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-stale', { kind: 'restart' }, { parts: [{ text: '' }] }),
    { publish: (event) => seen.push(event) },
  );
  const final = lastStatus(seen);
  assert.equal(final.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.deepEqual(final.metadata.pause, human);
  assert.equal(resumes.length, 0);

  const seen2 = [];
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-stale', { kind: 'restart' }, { parts: [{ text: 'use a' }], metadata: { choice: 'a', decisionId: 'run:h1' } }),
    { publish: (event) => seen2.push(event) },
  );
  assert.deepEqual(resumes[0].input, { answer: 'use a', choice: 'a', decisionId: 'run:h1' });
  assert.equal(lastStatus(seen2).status.state, TaskState.TASK_STATE_COMPLETED);
});

test('a restart pause without a checkpoint starts a fresh run from the first user message', async () => {
  const runs = [];
  const orchestrator = {
    async getPause() { return null; },
    async resume() { throw Object.assign(new Error('No checkpoint'), { name: 'RunNotFoundError' }); },
    async run(args) { runs.push(args); return { status: 'completed', text: 'fresh' }; },
  };
  const history = [{ messageId: 'm1', role: 1, parts: [{ content: { $case: 'text', value: 'Original goal' } }] }];
  const seen = [];
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-crash', { kind: 'restart' }, { parts: [{ text: '' }] }, { history }),
    { publish: (event) => seen.push(event) },
  );
  assert.equal(runs[0].goal, 'Original goal');
  assert.equal(runs[0].runId, 't-crash');
  assert.equal(lastStatus(seen).status.state, TaskState.TASK_STATE_COMPLETED);

  const seen2 = [];
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-nogoal', { kind: 'restart' }, { parts: [{ text: '' }] }),
    { publish: (event) => seen2.push(event) },
  );
  const failed = lastStatus(seen2);
  assert.equal(failed.status.state, TaskState.TASK_STATE_FAILED);
  assert.match(statusText({ status: failed.status }), /original goal could not be recovered/);
});

test('a busy port rejects startup without reconciling or leaving a lock', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.sqlite');
  const seed = await openStateDatabase({ filePath: stateFile });
  const working = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() };
  await createTaskStore(seed, 'orchestrator').save({ id: 'lead-busy', contextId: 'c1', status: working, artifacts: [], history: [], metadata: {} }, CALL());
  await seed.close();
  try {
    await assert.rejects(startServer({
      port: 3000,
      stateFile,
      tokenFile: path.join(dir, 'token'),
      appServer: CHATGPT_APP_SERVER(),
      orchestratorFactory: () => ({ async run() {} }),
      listenImpl(_app, _port, _host, callback) {
        const server = { once() {} };
        const error = Object.assign(new Error('Port already in use'), { code: 'EADDRINUSE' });
        queueMicrotask(() => callback(error));
        return server;
      },
    }), (error) => error.code === 'EADDRINUSE');
    assert.equal(fs.existsSync(`${stateFile}.lock`), false);
    const probe = await openStateDatabase({ filePath: stateFile });
    assert.equal((await createTaskStore(probe, 'orchestrator').load('lead-busy', CALL())).status.state, TaskState.TASK_STATE_WORKING);
    await probe.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second server on a live state file is rejected and leaves the first untouched', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.sqlite');
  const options = { port: 0, listen: false, stateFile, tokenFile: path.join(dir, 'token'), appServer: CHATGPT_APP_SERVER(), orchestratorFactory: () => ({ async run() {} }) };
  const first = await startServer(options);
  try {
    const working = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() };
    await createTaskStore(first.state, 'orchestrator').save({ id: 'lead-live', contextId: 'c1', status: working, artifacts: [], history: [], metadata: {} }, CALL());
    await assert.rejects(startServer(options), /state file .* is in use \(lock held: .*\.lockdb\)/i);
    const task = await createTaskStore(first.state, 'orchestrator').load('lead-live', CALL());
    assert.equal(task.status.state, TaskState.TASK_STATE_WORKING);
    assert.equal(first.state.db.open, true);
  } finally {
    await first.close();
  }
  // The lock is kernel-held: released on close, and an old text lock file is ignored.
  fs.writeFileSync(`${stateFile}.lock`, '999999\n');
  const again = await startServer(options);
  await again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('close() waits for the stopped lead run so its stopped pause is persisted', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.sqlite');
  let markRunning;
  const running = new Promise((resolve) => { markRunning = resolve; });
  const runtime = await startLeadServer({
    run({ signal }) {
      return new Promise((resolve) => {
        markRunning();
        // Downstream cancellation takes a moment to confirm.
        signal.addEventListener('abort', () => setTimeout(() => resolve({ status: 'canceled', text: 'stopped' }), 50), { once: true });
      });
    },
  }, dir, { stateFile });
  const sent = runtime.leadAgent.requestHandler.sendMessage({ message: userMessage('Long job'), configuration: {} }, CALL());
  await running;
  await runtime.close();
  const done = await sent;
  assert.equal(done.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const reopened = await openStateDatabase({ filePath: stateFile });
  try {
    const stored = await createTaskStore(reopened, 'orchestrator').load(done.id, CALL());
    assert.equal(stored.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal(stored.metadata.pause.kind, 'stopped');
  } finally {
    await reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain TypeError from a graph step during resume becomes an error pause, not the old pause', async () => {
  const seen = [];
  const executor = makeLeadExecutor({
    orchestrator: {
      async getPause() { return HUMAN_PAUSE; },
      async resume() { throw new TypeError('graph step blew up'); },
      async isResumable() { return true; },
    },
  });
  await executor.execute(pausedContext('t-typeerr', HUMAN_PAUSE, { parts: [{ text: 'answer' }] }), { publish: (event) => seen.push(event) });
  const final = lastStatus(seen);
  assert.equal(final.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.equal(final.metadata.pause.kind, 'error');
  assert.equal(final.metadata.pause.errorName, 'TypeError');
});

test('a second server on the same workspace is rejected even with a different state file, and the lock is released', async () => {
  const dir = tmpDir();
  const workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  const options = (name) => ({
    port: 0, listen: false, workspace, stateFile: path.join(dir, `${name}.sqlite`), tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(), orchestratorFactory: () => ({ async run() {} }),
  });
  const first = await startServer(options('one'));
  try {
    await assert.rejects(startServer(options('two')), /workspace .* is in use \(lock held: /i);
  } finally {
    await first.close();
  }
  const again = await startServer(options('two'));
  await again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('startup reconciles an active writer left behind by a dead process and passes admission to the orchestrator', async () => {
  const dir = tmpDir();
  const workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  const stateFile = path.join(dir, 'state.sqlite');
  const seed = await openStateDatabase({ filePath: stateFile });
  const leftover = new WriterAdmission({ db: seed.db, workspace, snapshot: () => ({ kind: 'unavailable', reason: 'test' }) });
  await leftover.acquire({ role: 'orch-builder', taskId: 'old-task', contextId: 'old-ctx' });
  await seed.close();

  let seenAdmission;
  const server = await startServer({
    port: 0, listen: false, workspace, stateFile, tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory: (options) => { seenAdmission = options.admission; return { async run() {} }; },
  });
  try {
    assert.ok(seenAdmission instanceof WriterAdmission);
    // No turn/start was recorded, so nothing could still run: the row reconciles at startup.
    assert.equal(seenAdmission.holder(), null);
    assert.equal(seenAdmission.get('orch-builder:old-task').state, 'reconciled');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- acceptance

const validAcceptance = { requiredChecks: [{ id: 'unit', argv: ['npm', 'test'] }] };

test('acceptance metadata on a new run is validated and passed as the contract', async () => {
  const runs = [];
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator: { async run(args) { runs.push(args); return { status: 'completed', text: 'Done' }; } } });
  await executor.execute({
    taskId: 't-acc', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }], metadata: { acceptance: validAcceptance } },
  }, { publish: (event) => seen.push(event) });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].contract, { id: 'acceptance-contract/v1', requiredChecks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 600000 }] });
  assert.equal(lastStatus(seen).status.state, TaskState.TASK_STATE_COMPLETED);
});

test('an invalid acceptance contract fails the task and the run never starts', async () => {
  let started = false;
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator: { async run() { started = true; return { status: 'completed', text: 'x' }; } } });
  await executor.execute({
    taskId: 't-bad', contextId: 'ctx',
    userMessage: { parts: [{ text: 'goal' }], metadata: { acceptance: { requiredChecks: [{ id: 'a', argv: [] }] } } },
  }, { publish: (event) => seen.push(event) });
  assert.equal(started, false);
  const final = lastStatus(seen);
  assert.equal(final.status.state, TaskState.TASK_STATE_FAILED);
  assert.match(final.status.message.parts[0].content.value, /^Invalid acceptance contract: .*argv/);
});

test('the result artifact carries the acceptance record and starts with its disposition', async () => {
  const acceptance = {
    disposition: 'rejected', reasons: [{ code: 'check_failed', detail: 'Required check "unit" failed (exit 1).' }], issues: [],
    candidate: { head: 'abc', fingerprint: 'f' }, checks: [],
  };
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator: { async run() { return { status: 'completed', text: 'All good', rounds: 1, assignments: [], acceptance }; } } });
  await executor.execute({ taskId: 't-art', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, { publish: (event) => seen.push(event) });
  const artifact = seen.find((event) => event.kind === 'artifactUpdate').data.artifact;
  assert.deepEqual(artifact.metadata.acceptance, acceptance);
  assert.equal(artifact.parts[0].content.value, 'Acceptance: rejected\n- check_failed: Required check "unit" failed (exit 1).\n\nAll good');
  assert.equal(lastStatus(seen).status.state, TaskState.TASK_STATE_COMPLETED);

  const accepted = [];
  const ok = makeLeadExecutor({ orchestrator: { async run() { return { status: 'completed', text: 'Fine', acceptance: { disposition: 'accepted', reasons: [] } }; } } });
  await ok.execute({ taskId: 't-ok', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }] } }, { publish: (event) => accepted.push(event) });
  assert.equal(accepted.find((event) => event.kind === 'artifactUpdate').data.artifact.parts[0].content.value, 'Acceptance: accepted\n\nFine');
});

test('a resume ignores acceptance metadata and says so', async () => {
  const seen = [];
  const resumes = [];
  const executor = makeLeadExecutor({
    orchestrator: { async getPause() { return { kind: 'writer_unresolved', attempts: [] }; }, async resume(args) { resumes.push(args); return { status: 'completed', text: 'back' }; } },
  });
  await executor.execute(pausedContext('t-res', { kind: 'writer_unresolved' }, {
    parts: [{ text: 'retry' }], metadata: { acceptance: { requiredChecks: [{ id: 'evil', argv: ['true'] }] } },
  }), { publish: (event) => seen.push(event) });
  assert.equal(resumes.length, 1);
  assert.equal('contract' in resumes[0], false);
  const working = seen.filter((event) => event.kind === 'statusUpdate').find((event) => event.data.status.state === TaskState.TASK_STATE_WORKING);
  assert.match(working.data.status.message.parts[0].content.value, /Acceptance metadata on a resume message is ignored/);
});

test('a restart fallback that starts over recovers the contract from the first user message', async () => {
  const runs = [];
  const executor = makeLeadExecutor({
    orchestrator: {
      async getPause() { return null; },
      async resume() { throw Object.assign(new Error('none'), { name: 'RunNotFoundError' }); },
      async run(args) { runs.push(args); return { status: 'completed', text: 'again' }; },
    },
  });
  await executor.execute(pausedContext('t-fresh', { kind: 'restart' }, { parts: [{ text: '' }] }, {
    history: [{ role: 1, parts: [{ text: 'original goal' }], metadata: { acceptance: validAcceptance } }],
  }), { publish() {} });
  assert.equal(runs[0].goal, 'original goal');
  assert.equal(runs[0].contract.requiredChecks[0].id, 'unit');
});

test('a restart fallback with an invalid stored contract carries an invalid marker, never no checks', async () => {
  const runs = [];
  const executor = makeLeadExecutor({
    orchestrator: {
      async getPause() { return null; },
      async resume() { throw Object.assign(new Error('none'), { name: 'RunNotFoundError' }); },
      async run(args) { runs.push(args); return { status: 'completed', text: 'again' }; },
    },
  });
  await executor.execute(pausedContext('t-badc', { kind: 'restart' }, { parts: [{ text: '' }] }, {
    history: [{ role: 1, parts: [{ text: 'original goal' }], metadata: { acceptance: { requiredChecks: [{ id: 'a', argv: [] }] } } }],
  }), { publish() {} });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].contract.invalid.code, 'contract_invalid');
  assert.match(runs[0].contract.invalid.detail, /Stored acceptance contract is invalid/);
  // The orchestrator validates the contract again; the marker must survive that.
  assert.equal(validateAcceptanceContract(runs[0].contract).invalid.code, 'contract_invalid');
});

// Submit a lead task whose run hangs, then replay the stored task into a fresh state DB as a
// restarted server would find it (no checkpoint), resume it, and return the contract the restart run got.
async function restartBeforeFirstCheckpoint({ requestMetadata, messageMetadata, mutateStored, onFirstRun }) {
  const dir = tmpDir();
  const hung = [];
  const first = await startLeadServer({
    run(args) {
      onFirstRun?.(args);
      return new Promise((_, reject) => { hung.push(args); args.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    },
    async getPause() { return null; },
  }, dir);
  let stored;
  try {
    const handler = first.leadAgent.requestHandler;
    const message = userMessage('Build it', messageMetadata ? { metadata: messageMetadata } : {});
    const submitted = await handler.sendMessage({ message, configuration: { returnImmediately: true }, metadata: requestMetadata }, CALL());
    for (let i = 0; i < 100 && hung.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hung.length, 1);
    const expectPinned = Boolean(requestMetadata?.acceptance || messageMetadata?.acceptance || onFirstRun);
    for (let i = 0; i < 100; i += 1) {
      stored = JSON.parse(JSON.stringify(await handler.getTask({ id: submitted.id }, CALL())));
      if (!expectPinned || stored.metadata?.acceptanceContract) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    hung[0].signal.dispatchEvent?.(new Event('abort'));
  } finally {
    await first.close();
  }
  stored.status = { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() };
  if (mutateStored) mutateStored(stored);
  const stateFile = path.join(dir, 'restart.sqlite');
  const seed = await openStateDatabase({ filePath: stateFile });
  await createTaskStore(seed, 'orchestrator').save(stored, CALL());
  await seed.close();
  const runs = [];
  const second = await startServer({
    listen: false,
    stateFile,
    tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory: () => ({
      async getPause() { return null; },
      async resume() { throw Object.assign(new Error('none'), { name: 'RunNotFoundError' }); },
      async run(args) { runs.push(args); return { status: 'completed', text: 'again' }; },
    }),
  });
  try {
    const handler = second.leadAgent.requestHandler;
    const paused = await handler.getTask({ id: stored.id }, CALL());
    assert.equal(paused.metadata.pause.kind, 'restart');
    await handler.sendMessage({ message: userMessage('', { taskId: paused.id, contextId: paused.contextId }), configuration: {} }, CALL());
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(runs.length, 1);
  return { contract: runs[0].contract, stored };
}

const pinnedContract = { id: 'acceptance-contract/v1', requiredChecks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 600000 }] };

test('a request-level contract survives a restart before the first checkpoint', async () => {
  const { contract, stored } = await restartBeforeFirstCheckpoint({ requestMetadata: { acceptance: validAcceptance } });
  assert.deepEqual(stored.metadata.acceptanceContract, pinnedContract);
  assert.deepEqual(contract, pinnedContract);
});

test('a message-level contract survives a restart before the first checkpoint', async () => {
  const { contract, stored } = await restartBeforeFirstCheckpoint({ messageMetadata: { acceptance: validAcceptance } });
  assert.deepEqual(stored.metadata.acceptanceContract, pinnedContract);
  assert.deepEqual(contract, pinnedContract);
});

test('checks the lead pins are recorded in the task with source agent and survive a restart', async () => {
  const agentContract = { id: 'acceptance-contract/v1', requiredChecks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 600000 }], source: 'agent' };
  const { contract, stored } = await restartBeforeFirstCheckpoint({
    onFirstRun(args) { args.onEvent({ type: 'acceptance_contract', round: 1, contract: agentContract }); },
  });
  assert.deepEqual(stored.metadata.acceptanceContract, agentContract);
  // The restart run gets the agent contract with its source, so the checks stay sandboxed.
  assert.deepEqual(contract, agentContract);
});

test('a run without any contract restarts with no required checks', async () => {
  const { contract, stored } = await restartBeforeFirstCheckpoint({});
  assert.equal('acceptanceContract' in stored.metadata, false);
  assert.deepEqual(contract.requiredChecks, []);
  assert.equal(contract.invalid, undefined);
});

test('a legacy run without the persisted field still recovers the contract from message metadata', async () => {
  const { contract } = await restartBeforeFirstCheckpoint({
    messageMetadata: { acceptance: validAcceptance },
    mutateStored(task) { delete task.metadata.acceptanceContract; },
  });
  assert.equal(contract.requiredChecks[0].id, 'unit');
  assert.equal(contract.invalid, undefined);
});

test('an unrecoverable persisted contract yields the invalid marker, never no checks', async () => {
  const { contract } = await restartBeforeFirstCheckpoint({
    requestMetadata: { acceptance: validAcceptance },
    mutateStored(task) { task.metadata.acceptanceContract = { requiredChecks: [{ id: 'a', argv: [] }] }; },
  });
  assert.equal(contract.invalid.code, 'contract_invalid');
  assert.match(contract.invalid.detail, /Stored acceptance contract is invalid/);
});

test('the run starts only after the pinned contract is readable from the store', async () => {
  const log = [];
  let reads = 0;
  const executor = makeLeadExecutor({
    orchestrator: { async run() { log.push('run'); return { status: 'completed', text: 'x' }; } },
    loadTask: async () => { reads += 1; log.push('load'); return reads >= 3 ? { metadata: { acceptanceContract: { requiredChecks: [] } } } : { metadata: {} }; },
  });
  await executor.execute({ taskId: 't-dur', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }], metadata: { acceptance: validAcceptance } } }, { publish() {} });
  assert.deepEqual(log, ['load', 'load', 'load', 'run']);
});

test('a run is not started when the pinned contract cannot be confirmed stored', async () => {
  let started = false;
  const seen = [];
  const executor = makeLeadExecutor({
    orchestrator: { async run() { started = true; return { status: 'completed', text: 'x' }; } },
    loadTask: async () => ({ metadata: {} }),
    durabilityTimeoutMs: 50,
  });
  await executor.execute({ taskId: 't-nodur', contextId: 'ctx', userMessage: { parts: [{ text: 'goal' }], metadata: { acceptance: validAcceptance } } }, { publish: (event) => seen.push(event) });
  assert.equal(started, false);
  const final = lastStatus(seen);
  assert.equal(final.status.state, TaskState.TASK_STATE_FAILED);
  assert.match(final.status.message.parts[0].content.value, /could not be confirmed as stored/);
});

test('a user-supplied invalid marker in new-run metadata is rejected', async () => {
  let started = false;
  const executor = makeLeadExecutor({ orchestrator: { async run() { started = true; return { status: 'completed', text: 'x' }; } } });
  await executor.execute({
    taskId: 't-mark', contextId: 'ctx',
    userMessage: { parts: [{ text: 'goal' }], metadata: { acceptance: { requiredChecks: [], invalid: { code: 'contract_invalid', detail: 'x' } } } },
  }, { publish() {} });
  assert.equal(started, false);
});

function textMessage(text, extra = {}) {
  return { messageId: 'm-new', role: 1, parts: [{ content: { $case: 'text', value: text } }], ...extra };
}

function refTask(overrides = {}) {
  return {
    id: 'old-1',
    contextId: 'ctx',
    status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [{ artifactId: 'a', parts: [{ content: { $case: 'text', value: 'Old result' } }], metadata: { acceptance: { disposition: 'accepted' } } }],
    history: [textMessage('History goal')],
    ...overrides,
  };
}

async function runFollowUp({ orchestrator, referenceTaskIds = ['old-1'], referenceTasks, message = 'Now do more' }) {
  const seen = [];
  await makeLeadExecutor({ orchestrator }).execute({
    taskId: 'new-1',
    contextId: 'ctx',
    userMessage: textMessage(message, { referenceTaskIds }),
    referenceTasks,
  }, { publish: (event) => seen.push(event) });
  return seen;
}

test('a follow-up run composes the goal from the referenced task and prefers the checkpoint goal', async () => {
  const runs = [];
  const orchestrator = {
    async getRunGoal(id) { return id === 'old-1' ? 'Checkpoint goal' : null; },
    async run(args) { runs.push(args); return { status: 'completed', text: 'ok' }; },
  };
  await runFollowUp({ orchestrator, referenceTasks: [refTask()] });
  const goal = runs[0].goal;
  assert.match(goal, /Earlier task old-1 ended as TASK_STATE_COMPLETED \(acceptance: accepted\)/);
  assert.match(goal, /Earlier goal:\nCheckpoint goal\nEarlier result:\nOld result\n/);
  assert.doesNotMatch(goal, /History goal/);
  assert.match(goal, /New request \(authoritative; the earlier context is background only\):\nNow do more$/);

  runs.length = 0;
  await runFollowUp({ orchestrator: { async getRunGoal() { return null; }, async run(args) { runs.push(args); return { status: 'completed', text: 'ok' }; } }, referenceTasks: [refTask()] });
  assert.match(runs[0].goal, /Earlier goal:\nHistory goal\n/);
});

test('a follow-up truncates the oldest earlier context and never the new request', async () => {
  const runs = [];
  const orchestrator = { async getRunGoal() { return `HEAD-${'g'.repeat(30000)}`; }, async run(args) { runs.push(args); return { status: 'completed', text: 'ok' }; } };
  const task = refTask({ artifacts: [{ artifactId: 'a', parts: [{ content: { $case: 'text', value: 'TAIL-result' } }] }] });
  await runFollowUp({ orchestrator, referenceTasks: [task], message: 'N'.repeat(100) });
  const goal = runs[0].goal;
  assert.match(goal, /\[earlier context truncated\]\n/);
  assert.doesNotMatch(goal, /HEAD-/);
  assert.match(goal, /TAIL-result\nNew request/);
  assert.match(goal, /acceptance: n\/a/);
  assert.ok(goal.endsWith('N'.repeat(100)));
});

test('a follow-up fails for several, missing, or still-active references', async () => {
  const orchestrator = { async run() { throw new Error('must not run'); } };
  const cases = [
    [{ referenceTaskIds: ['a', 'b'], referenceTasks: [] }, /Only one reference task is supported\./],
    [{ referenceTasks: [] }, /Reference task old-1 was not found\./],
    [{ referenceTasks: [refTask({ status: { state: TaskState.TASK_STATE_WORKING } })] }, /Reference task old-1 is still active; answer or cancel it instead of continuing it\./],
    [{ referenceTasks: [refTask({ status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } })] }, /still active/],
  ];
  for (const [args, pattern] of cases) {
    const seen = await runFollowUp({ orchestrator, ...args });
    const failed = lastStatus(seen);
    assert.equal(failed.status.state, TaskState.TASK_STATE_FAILED);
    assert.match(statusText({ status: failed.status }), pattern);
  }
});

test('a restart pause recomposes the follow-up goal through the task loader', async () => {
  const runs = [];
  const orchestrator = {
    async getPause() { return null; },
    async getRunGoal() { return 'Checkpoint goal'; },
    async resume() { throw Object.assign(new Error('No checkpoint'), { name: 'RunNotFoundError' }); },
    async run(args) { runs.push(args); return { status: 'completed', text: 'fresh' }; },
  };
  const history = [textMessage('Now do more', { referenceTaskIds: ['old-1'] })];
  const loaded = [];
  const loadTask = async (id) => { loaded.push(id); return refTask(); };
  const seen = [];
  await makeLeadExecutor({ orchestrator, loadTask }).execute(
    pausedContext('t-crash', { kind: 'restart' }, { parts: [{ text: '' }] }, { history }),
    { publish: (event) => seen.push(event) },
  );
  assert.deepEqual(loaded, ['old-1']);
  assert.match(runs[0].goal, /Earlier goal:\nCheckpoint goal\nEarlier result:\nOld result\n/);
  assert.match(runs[0].goal, /Now do more$/);
  assert.equal(lastStatus(seen).status.state, TaskState.TASK_STATE_COMPLETED);
});

test('JSON-RPC calls get 503 starting with Retry-After until startup completes', async () => {
  const tokenDirectory = `/tmp/codex-a2a-starting-test-${process.pid}`;
  let during;
  const runtime = await startServer({
    port: 0,
    stateFile: ':memory:',
    tokenFile: `${tokenDirectory}/a2a-token`,
    appServer: {
      async start() {},
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async run() {},
      async close() {},
    },
    listenImpl(application, listenPort, host, callback) {
      // Hold startup open (reconciliation has not started) while a request arrives.
      const server = application.listen(listenPort, host, async (error) => {
        if (!error) {
          const response = await fetch(`http://${host}:${server.address().port}/agents/orch-builder`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          });
          during = { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
        }
        callback(error);
      });
      return server;
    },
    orchestratorFactory: () => ({ async run() { return { status: 'completed', text: 'ok' }; } }),
  });
  try {
    assert.equal(during.status, 503);
    assert.equal(during.retryAfter, '1');
    assert.equal(during.body.error, 'starting');
    const after = await fetch(`http://${runtime.host}:${runtime.port}/agents/orch-builder`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.notEqual(after.status, 503);
  } finally {
    await runtime.close();
    require('node:fs').rmSync(tokenDirectory, { recursive: true, force: true });
  }
});

const BUDGET_PAUSE = { kind: 'waiting_for_budget', source: 'lead', message: 'usage limit', resetsAt: null };
const RATE_LIMITS_OK = { ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null }, rateLimitsByLimitId: null };

test('describePause explains automatic resume for a budget pause and keeps the old text when it is off', () => {
  const off = describePause('t1', BUDGET_PAUSE);
  assert.match(off, /Send a message to this task to retry once quota is available\./);
  assert.doesNotMatch(off, /automatically/);
  const nextCheckAt = Date.parse('2027-01-01T00:00:00.000Z');
  const on = describePause('t1', BUDGET_PAUSE, { autoResume: true, nextCheckAt });
  assert.match(on, /resumes this task automatically once Codex budget is available/);
  assert.match(on, /Next budget check: 2027-01-01T00:00:00\.000Z/);
  assert.match(on, /Send a message to this task to resume it immediately\./);
});

test('a budget pause registers with the watcher and the loopback resume reaches the lead resume path', async () => {
  const dir = tmpDir();
  const resumes = [];
  let paused = true;
  const orchestrator = {
    async run(args) { return { runId: args.runId, status: 'waiting_for_budget', text: '', rounds: 0, assignments: [], pause: BUDGET_PAUSE }; },
    async getPause() { return paused ? BUDGET_PAUSE : null; },
    async resume(args) { paused = false; resumes.push(args); return { runId: args.runId, status: 'completed', text: 'ok', rounds: 1, assignments: [] }; },
  };
  const runtime = await startLeadServer(orchestrator, dir, {
    listen: true,
    port: 0,
    appServer: { ...CHATGPT_APP_SERVER(), async readRateLimits() { return RATE_LIMITS_OK; } },
    budgetWatcherOptions: { intervalMs: 40, marginMs: 0 },
  });
  try {
    const handler = runtime.leadAgent.requestHandler;
    const first = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    assert.equal(first.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.match(statusText(first), /resumes this task automatically/);
    assert.equal(runtime.budgetWatcher.status(first.id).state, 'waiting');
    for (let i = 0; i < 100 && resumes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resumes.length, 1);
    assert.match(resumes[0].input.answer, /Automatic resume: Codex usage budget is available again\./);
    assert.equal(resumes[0].runId, first.id);
    for (let i = 0; i < 100; i++) {
      const task = await handler.getTask({ id: first.id }, CALL());
      if (task.status.state === TaskState.TASK_STATE_COMPLETED) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await handler.getTask({ id: first.id }, CALL())).status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(runtime.budgetWatcher.status(first.id), null);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a human resume forgets the run and auto-resume off leaves no watcher and the old pause text', async () => {
  const dir = tmpDir();
  const resumes = [];
  const orchestrator = {
    async run(args) { return { runId: args.runId, status: 'waiting_for_budget', text: '', rounds: 0, assignments: [], pause: BUDGET_PAUSE }; },
    async getPause() { return BUDGET_PAUSE; },
    async resume(args) { resumes.push(args); return { runId: args.runId, status: 'completed', text: 'ok', rounds: 1, assignments: [] }; },
  };
  const on = await startLeadServer(orchestrator, dir, { budgetWatcherOptions: { intervalMs: 600_000 } });
  try {
    const handler = on.leadAgent.requestHandler;
    const first = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    assert.equal(on.budgetWatcher.status(first.id).state, 'waiting');
    await handler.sendMessage({ message: userMessage('go', { taskId: first.id, contextId: first.contextId }), configuration: {} }, CALL());
    assert.equal(on.budgetWatcher.status(first.id), null);
  } finally {
    await on.close();
  }
  const off = await startLeadServer(orchestrator, dir, { autoResume: false });
  try {
    assert.equal(off.budgetWatcher, null);
    const first = await off.leadAgent.requestHandler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    assert.match(statusText(first), /Send a message to this task to retry once quota is available\./);
    assert.doesNotMatch(statusText(first), /automatically/);
  } finally {
    await off.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup registers INPUT_REQUIRED lead tasks paused for budget and skips other pauses', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.sqlite');
  const seed = await openStateDatabase({ filePath: stateFile });
  const waiting = { state: TaskState.TASK_STATE_INPUT_REQUIRED, timestamp: new Date().toISOString() };
  const store = createTaskStore(seed, 'orchestrator');
  for (const id of ['lead-budget', 'lead-human']) {
    await store.save({ id, contextId: `c-${id}`, status: waiting, artifacts: [], history: [], metadata: {} }, CALL());
  }
  await seed.close();
  const runtime = await startServer({
    listen: false,
    stateFile,
    tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory: () => ({ async getPause(id) { return id === 'lead-budget' ? BUDGET_PAUSE : HUMAN_PAUSE; } }),
    budgetWatcherOptions: { intervalMs: 600_000 },
  });
  try {
    for (let i = 0; i < 50 && !runtime.budgetWatcher.status('lead-budget'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.budgetWatcher.status('lead-budget').state, 'waiting');
    assert.equal(runtime.budgetWatcher.status('lead-human'), null);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- writer isolation (parallel writers)

async function withIsolationEnv(value, fn) {
  const prior = process.env.CODEX_A2A_WRITER_ISOLATION;
  if (value === undefined) delete process.env.CODEX_A2A_WRITER_ISOLATION;
  else process.env.CODEX_A2A_WRITER_ISOLATION = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.CODEX_A2A_WRITER_ISOLATION;
    else process.env.CODEX_A2A_WRITER_ISOLATION = prior;
  }
}

function isolationServer(repo, dir, exec, captured) {
  return startServer({
    listen: false,
    workspace: repo,
    stateFile: path.join(dir, 'state.sqlite'),
    tokenFile: path.join(dir, 'token'),
    appServer: { ...CHATGPT_APP_SERVER(), getVersion: () => 'v-test', execCommand: exec.execCommand },
    orchestratorFactory: (options) => { captured.options = options; return { async run() {} }; },
  });
}

test('worktree mode: a passing startup probe turns on lanes and parallel writers; the stored probe is reused', async () => {
  const { makeRepo, probeExec } = require('./helpers/lane-fixtures');
  const repo = makeRepo();
  const dir = tmpDir();
  const exec = probeExec();
  try {
    await withIsolationEnv(undefined, async () => {
      const first = {};
      let runtime = await isolationServer(repo, dir, exec, first);
      try {
        assert.deepEqual([runtime.writerIsolation.mode, runtime.writerIsolation.reason], ['worktree', null]);
        assert.equal(runtime.writerIsolation.lanesRoot, path.join(fs.realpathSync(dir), 'lanes'));
        assert.equal(runtime.writerIsolation.probe.version, 'v-test');
        assert.equal(first.options.parallelWriters, true);
      } finally {
        await runtime.close();
      }
      const calls = exec.calls.length;
      assert.ok(calls > 0);
      const second = {};
      runtime = await isolationServer(repo, dir, exec, second);
      try {
        assert.equal(runtime.writerIsolation.mode, 'worktree');
        assert.equal(exec.calls.length, calls);
        assert.equal(second.options.parallelWriters, true);
      } finally {
        await runtime.close();
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('shared mode by setting or after a failing probe: no parallel writers', async () => {
  const { makeRepo, probeExec } = require('./helpers/lane-fixtures');
  const repo = makeRepo();
  const dir = tmpDir();
  try {
    const exec = probeExec();
    await withIsolationEnv('shared', async () => {
      const captured = {};
      const runtime = await isolationServer(repo, dir, exec, captured);
      try {
        assert.deepEqual([runtime.writerIsolation.mode, runtime.writerIsolation.reason], ['shared', 'isolation_shared']);
        assert.equal(captured.options.parallelWriters, false);
        assert.equal(exec.calls.length, 0);
      } finally {
        await runtime.close();
      }
    });
    const leaky = probeExec({ leak: true });
    await withIsolationEnv('worktree', async () => {
      const captured = {};
      const runtime = await isolationServer(repo, dir, leaky, captured);
      try {
        assert.equal(runtime.writerIsolation.mode, 'shared');
        assert.match(runtime.writerIsolation.reason, /^probe_failed: escaped: /);
        assert.equal(captured.options.parallelWriters, false);
      } finally {
        await runtime.close();
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('startup recovery orphans a lane row left running by a previous process', async () => {
  const { makeRepo, probeExec } = require('./helpers/lane-fixtures');
  const { createLaneStore } = require('../src/writer-lanes');
  const repo = makeRepo();
  const dir = tmpDir();
  try {
    const seed = await openStateDatabase({ filePath: path.join(dir, 'state.sqlite') });
    const store = createLaneStore(seed.db);
    store.insert({ laneId: 'L-old', contextId: 'c', taskId: 't', workspace: repo, path: path.join(dir, 'lanes', 'L-old') });
    store.update('L-old', { state: 'running', turnStart: { processIdentity: null, threadId: 'thr' } });
    await seed.close();
    await withIsolationEnv('shared', async () => {
      const runtime = await isolationServer(repo, dir, probeExec(), {});
      try {
        assert.deepEqual(runtime.writerIsolation.recovery.orphaned, ['L-old']);
        assert.equal(runtime.lanes.store.get('L-old').state, 'orphaned');
      } finally {
        await runtime.close();
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('server wiring follows the active account profile and works without a profiles file', async () => {
  const dir = tmpDir();
  const made = [];
  const factory = (home) => {
    const inst = { home, closed: false, async start() {}, async getAccount() { return { account: { type: 'chatgpt' } }; }, async run() {}, getVersion() { return 'fake'; }, async execCommand() { return {}; }, async close() { this.closed = true; } };
    made.push(inst);
    return inst;
  };
  const common = { listen: false, stateFile: ':memory:', orchestratorFactory: () => ({ async run() {} }), appServerFactory: factory };
  const accountsDir = path.join(dir, 'accounts');
  const plain = await startServer({ ...common, accountsDir, tokenFile: path.join(dir, 'token1'), workspaceLockDir: path.join(dir, 'l1') });
  try {
    assert.equal(made.length, 1);
    assert.equal(made[0].home, null);
    assert.equal(typeof plain.accountProfiles.read, 'function');
    assert.equal(plain.appServer, plain.switchingAppServer);
  } finally {
    await plain.close();
  }
  const { createAccountProfiles } = require('../src/account-profiles');
  const profiles = createAccountProfiles({ accountsDir, codexDefaultHome: path.join(dir, 'nohome') });
  const profile = profiles.addProfile({ name: 'second' });
  profiles.setActive('second');
  const homed = await startServer({ ...common, accountsDir, tokenFile: path.join(dir, 'token2'), workspaceLockDir: path.join(dir, 'l2') });
  try {
    assert.equal(made.length, 2);
    assert.equal(made[1].home, profile.home);
    assert.equal(homed.appServer.getCodexHome(), profile.home);
  } finally {
    await homed.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(made[1].closed, true);
});

test('describePause adds the auto-switch line only for a budget pause with auto-switch on', () => {
  const line = /Auto-switch is on: the server switches to another account with available budget\./;
  assert.match(describePause('t1', BUDGET_PAUSE, { autoResume: true, autoSwitch: true }), line);
  assert.doesNotMatch(describePause('t1', BUDGET_PAUSE, { autoResume: true }), line);
  assert.doesNotMatch(describePause('t1', BUDGET_PAUSE), line);
});

test('a budget pause with auto-switch on switches to another account and resumes at once', async () => {
  const dir = tmpDir();
  const accountsDir = path.join(dir, 'accounts');
  fs.mkdirSync(accountsDir);
  const homeA = path.join(accountsDir, 'a');
  const homeB = path.join(accountsDir, 'b');
  fs.writeFileSync(path.join(accountsDir, 'profiles.json'), JSON.stringify({
    version: 1,
    active: 'a',
    autoSwitch: true,
    profiles: [{ name: 'a', home: homeA }, { name: 'b', home: homeB }],
  }));
  const created = [];
  const appServerFactory = (home) => {
    created.push(home);
    return {
      async start() {},
      async getAccount() { return { account: { type: 'chatgpt' } }; },
      async readRateLimits() { return { ordinaryUsageAllowed: false, rateLimits: { rateLimitReachedType: 'rate_limit_reached' }, rateLimitsByLimitId: null }; },
      async run() {},
      async close() {},
      async getVersion() { return null; },
      async supervisorState() { return null; },
      async processIdentity() { return null; },
      async listHooks() { return []; },
      async hookInventory() { return []; },
      async listMcpServerNames() { return []; },
      async mcpInventory() { return []; },
    };
  };
  const limitReads = [];
  const resumes = [];
  let paused = true;
  const orchestrator = {
    async run(args) { return { runId: args.runId, status: 'waiting_for_budget', text: '', rounds: 0, assignments: [], pause: BUDGET_PAUSE }; },
    async getPause() { return paused ? BUDGET_PAUSE : null; },
    async resume(args) { paused = false; resumes.push(args); return { runId: args.runId, status: 'completed', text: 'ok', rounds: 1, assignments: [] }; },
  };
  const runtime = await startServer({
    listen: true,
    port: 0,
    stateFile: ':memory:',
    tokenFile: path.join(dir, 'token'),
    accountsDir,
    workspace: dir,
    appServerFactory,
    readProfileLimits: async (home) => { limitReads.push(home); return RATE_LIMITS_OK; },
    orchestratorFactory: () => orchestrator,
    budgetWatcherOptions: { intervalMs: 40, marginMs: 0 },
  });
  try {
    const handler = runtime.leadAgent.requestHandler;
    const first = await handler.sendMessage({ message: userMessage('Build it'), configuration: {} }, CALL());
    assert.equal(first.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.match(statusText(first), /Auto-switch is on: the server switches to another account with available budget\./);
    for (let i = 0; i < 100 && resumes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resumes.length, 1);
    assert.deepEqual(limitReads, [homeB]);
    assert.equal(runtime.accountProfiles.read().active, 'b');
    assert.equal(runtime.switchingAppServer.getCodexHome(), homeB);
    assert.deepEqual(created, [homeA, homeB]);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server wires a watch on the profiles file and closes it with the server', async () => {
  const dir = tmpDir();
  const accountsDir = path.join(dir, 'accounts');
  fs.mkdirSync(accountsDir);
  const profilesFile = path.join(accountsDir, 'profiles.json');
  fs.writeFileSync(profilesFile, JSON.stringify({ version: 1, active: null, autoSwitch: true, profiles: [] }));
  const realWatch = fs.watchFile;
  const realUnwatch = fs.unwatchFile;
  const watched = [];
  const unwatched = [];
  fs.watchFile = (file, options, listener) => { if (file === profilesFile) watched.push({ options, listener }); return realWatch.call(fs, file, options, listener); };
  fs.unwatchFile = (file, listener) => { if (file === profilesFile) unwatched.push(listener); return realUnwatch.call(fs, file, listener); };
  let runtime;
  try {
    runtime = await startServer({
      listen: true,
      port: 0,
      stateFile: ':memory:',
      tokenFile: path.join(dir, 'token'),
      accountsDir,
      workspace: dir,
      appServerFactory: () => ({
        async start() {},
        async getAccount() { return { account: { type: 'chatgpt' } }; },
        async readRateLimits() { return null; },
        async run() {},
        async close() {},
        async getVersion() { return null; },
        async supervisorState() { return null; },
        async processIdentity() { return null; },
        async listHooks() { return []; },
        async hookInventory() { return []; },
        async listMcpServerNames() { return []; },
        async mcpInventory() { return []; },
      }),
      readProfileLimits: async () => null,
      orchestratorFactory: () => ({ async run() {}, async getPause() { return null; }, async resume() {} }),
    });
    for (let i = 0; i < 50 && watched.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(watched.length, 1);
    assert.deepEqual(watched[0].options, { interval: 2000, persistent: false });
    assert.deepEqual(unwatched, []);
  } finally {
    await runtime?.close();
    fs.watchFile = realWatch;
    fs.unwatchFile = realUnwatch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(unwatched, [watched[0].listener]);
});

test('a follow-up goal carries the previous run digest and works without one', async () => {
  const runs = [];
  const digest = { goal: 'Old', text: 'Done', rounds: 3, status: 'completed', outcomes: [], openDecisions: [], changedFiles: ['src/a.js'], inspectedDocs: [], nextWork: '' };
  const withDigest = {
    async getRunGoal() { return 'Checkpoint goal'; },
    async getRunDigest(id) { return id === 'old-1' ? digest : null; },
    async run(args) { runs.push(args); return { status: 'completed', text: 'ok' }; },
  };
  await runFollowUp({ orchestrator: withDigest, referenceTasks: [refTask()] });
  assert.match(runs[0].goal, /Previous run in this session \(digest; do not re-explore what it established, dispatch explorers only for gaps it names\):\nRun status: completed; dispatch rounds: 3/);
  assert.match(runs[0].goal, /Changed files: src\/a\.js/);
  assert.match(runs[0].goal, /Now do more$/);
  runs.length = 0;
  await runFollowUp({ orchestrator: { ...withDigest, async getRunDigest() { throw new Error('boom'); } }, referenceTasks: [refTask()] });
  assert.doesNotMatch(runs[0].goal, /Previous run in this session/);
  assert.match(runs[0].goal, /Earlier goal:\nCheckpoint goal/);
  runs.length = 0;
  await runFollowUp({ orchestrator: { async getRunGoal() { return null; }, async run(args) { runs.push(args); return { status: 'completed', text: 'ok' }; } }, referenceTasks: [refTask()] });
  assert.doesNotMatch(runs[0].goal, /Previous run in this session/);
});

test('the session contextId and the raw new request reach the orchestrator run', async () => {
  const runs = [];
  const orchestrator = {
    async getRunGoal() { return null; },
    async run(args) { runs.push(args); return { status: 'completed', text: 'ok' }; },
  };
  await runFollowUp({ orchestrator, referenceTasks: [refTask()], message: 'Now do more' });
  assert.equal(runs[0].contextId, 'ctx');
  assert.equal(runs[0].newRequest, 'Now do more');
  assert.match(runs[0].goal, /Earlier task old-1/);

  runs.length = 0;
  await makeLeadExecutor({ orchestrator }).execute({
    taskId: 'plain-1', contextId: 'ctx-2', userMessage: textMessage('Fresh goal'),
  }, { publish() {} });
  assert.equal(runs[0].contextId, 'ctx-2');
  assert.equal('newRequest' in runs[0], false);
  assert.equal(runs[0].goal, 'Fresh goal');
});

test('a resume passes the session contextId to the orchestrator', async () => {
  const resumes = [];
  const orchestrator = {
    async getPause() { return HUMAN_PAUSE; },
    async resume(args) { resumes.push(args); return { status: 'completed', text: 'ok' }; },
  };
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-resume', HUMAN_PAUSE, { parts: [{ content: { $case: 'text', value: 'use a' } }] }),
    { publish() {} },
  );
  assert.equal(resumes[0].runId, 't-resume');
  assert.equal(typeof resumes[0].contextId, 'string');
});

test('startup gives the orchestrator a session thread store on the state database', async () => {
  const dir = tmpDir();
  let options = null;
  const runtime = await startLeadServer({ async run() {} }, dir, { orchestratorFactory: (o) => { options = o; return { async run() {} }; } });
  try {
    assert.equal(typeof options.sessionThreads.upsert, 'function');
    options.sessionThreads.upsert({ contextId: 'ctx-s', threadId: 'th-1', codexHome: '/h', lastInputTokens: 42, runId: 'r1' });
    const row = runtime.state.db.prepare('SELECT thread_id, codex_home, last_input_tokens FROM session_threads WHERE context_id = ?').get('ctx-s');
    assert.deepEqual({ ...row }, { thread_id: 'th-1', codex_home: '/h', last_input_tokens: 42 });
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('role overrides from the project file reach the orchestrator and the roles; an invalid file never blocks startup', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-role-overrides-'));
  const file = path.join(dir, 'role-overrides.json');
  const start = async (extra = {}) => {
    let options;
    const runtime = await startServer({
      port: 0,
      stateFile: ':memory:',
      tokenFile: path.join(dir, 'a2a-token'),
      appServer: CHATGPT_APP_SERVER(),
      listen: false,
      orchestratorFactory(received) {
        options = received;
        return { async run() { return { status: 'completed', text: 'ok' }; } };
      },
      ...extra,
    });
    return { runtime, options };
  };
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, roles: { coordinator: { model: 'gpt-6-luna', effort: 'high' }, architect: { effort: 'low' } } }));
    const ok = await start({ roleOverridesFile: file });
    try {
      assert.equal(ok.options.leadRole.model, 'gpt-6-luna');
      assert.equal(ok.options.roles.get('architect').effort, 'low');
      assert.equal(ok.options.leadRole.effort, 'high');
      // The file is read once at start: a later edit changes nothing until the server restarts.
      fs.writeFileSync(file, JSON.stringify({ version: 1, roles: { architect: { effort: 'medium' } } }));
      assert.equal(ok.options.roles.get('architect').effort, 'low');
      assert.equal(ok.options.leadRole.model, 'gpt-6-luna');
      assert.equal(ok.runtime.roles.get('architect').effort, 'low');
    } finally {
      await ok.runtime.close();
    }

    fs.writeFileSync(file, '{ nope');
    const bad = await start({ roleOverridesFile: file });
    try {
      assert.equal(bad.options.leadRole.model, require('../src/role-catalog').createLeadRole().model);
      assert.ok(warnings.some((message) => /\[roles\] Role overrides ignored/.test(message)));
    } finally {
      await bad.runtime.close();
    }

    const previous = process.env.CODEX_A2A_ROLE_OVERRIDES;
    process.env.CODEX_A2A_ROLE_OVERRIDES = file;
    fs.writeFileSync(file, JSON.stringify({ version: 1, roles: { coordinator: { effort: 'xhigh' } } }));
    try {
      const viaEnv = await start();
      try {
        assert.equal(viaEnv.options.leadRole.effort, 'xhigh');
      } finally {
        await viaEnv.runtime.close();
      }
    } finally {
      if (previous === undefined) delete process.env.CODEX_A2A_ROLE_OVERRIDES;
      else process.env.CODEX_A2A_ROLE_OVERRIDES = previous;
    }
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project settings enable the acceptance scratch opt-in once at start; a broken file enables nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-settings-'));
  const file = path.join(dir, 'projects', 'p1', 'project-settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = async (extra = {}) => {
    let options;
    const runtime = await startServer({
      port: 0,
      stateFile: ':memory:',
      tokenFile: path.join(dir, 'a2a-token'),
      appServer: CHATGPT_APP_SERVER(),
      listen: false,
      orchestratorFactory(received) {
        options = received;
        return { async run() { return { status: 'completed', text: 'ok' }; } };
      },
      ...extra,
    });
    return { runtime, options };
  };
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const none = await start({ projectSettingsFile: file });
    try {
      assert.equal('acceptanceScratch' in none.options, false);
    } finally {
      await none.runtime.close();
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, acceptanceScratch: { env: ['TEAMWORK_TEST_SCRATCH_ROOT'] } }));
    const on = await start({ projectSettingsFile: file });
    try {
      assert.deepEqual(on.options.acceptanceScratch, { env: ['TEAMWORK_TEST_SCRATCH_ROOT'], baseDir: path.join(path.dirname(file), 'acceptance-scratch') });
    } finally {
      await on.runtime.close();
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, acceptanceScratch: { env: ['PATH'] } }));
    const bad = await start({ projectSettingsFile: file });
    try {
      assert.equal('acceptanceScratch' in bad.options, false);
      assert.ok(warnings.some((message) => /\[settings\] Project settings ignored/.test(message)));
    } finally {
      await bad.runtime.close();
    }
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- PAUSE-01 owner pause

const OWNER_PAUSE = { kind: 'owner_pause', message: 'Paused by the owner' };

test('an owner pause parks the lead task as INPUT_REQUIRED with the pause metadata and resumes with an empty message', async () => {
  const resumes = [];
  const orchestrator = {
    async run(args) { return { runId: args.runId, status: 'input_required', text: 'Paused by the owner', rounds: 1, assignments: [], pause: OWNER_PAUSE }; },
    async getPause() { return OWNER_PAUSE; },
    async resume(args) { resumes.push(args); return { runId: args.runId, status: 'completed', text: 'ok', rounds: 2, assignments: [] }; },
  };
  const seen = [];
  await makeLeadExecutor({ orchestrator }).execute(
    { taskId: 't-own', contextId: 'ctx', userMessage: userMessage('Build it') },
    { publish: (event) => seen.push(event) },
  );
  const parked = lastStatus(seen);
  assert.equal(parked.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  assert.deepEqual(parked.metadata.pause, OWNER_PAUSE);
  assert.match(statusText({ status: parked.status }), /Paused by the owner\./);
  assert.match(statusText({ status: parked.status }), /continue/);

  const resumed = [];
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-own', OWNER_PAUSE, { ...userMessage(''), parts: [{ text: '' }] }),
    { publish: (event) => resumed.push(event) },
  );
  assert.equal(resumes.length, 1);
  assert.equal(lastStatus(resumed).status.state, TaskState.TASK_STATE_COMPLETED);
});

test('the control routes need the loopback token and drive the orchestrator pause flags', async () => {
  const dir = tmpDir();
  const calls = [];
  const flags = new Map([['run-1', false], ['run-2', false]]);
  const orchestrator = {
    activeRuns: () => [...flags].map(([runId, pauseRequested]) => ({ runId, pauseRequested })),
    requestPause: (id) => { calls.push(['request', id]); if (!flags.has(id)) return false; flags.set(id, true); return true; },
    cancelPauseRequest: (id) => { calls.push(['cancel', id]); if (flags.get(id) !== true) return false; flags.set(id, false); return true; },
    async getPause() { return null; },
  };
  const runtime = await startLeadServer(orchestrator, dir);
  const httpServer = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  const call = async (method, route, body, auth = true) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const [method, route] of [['GET', '/control/pause'], ['POST', '/control/pause'], ['POST', '/control/pause/cancel']]) {
      assert.equal((await call(method, route, method === 'POST' ? {} : undefined, false)).status, 401, route);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual((await call('GET', '/control/pause')).body.runs.map((r) => r.pauseRequested), [false, false]);
    assert.deepEqual((await call('POST', '/control/pause/cancel', {})).body, { runs: [] });
    const requested = await call('POST', '/control/pause', {});
    assert.deepEqual(requested.body, { runs: [{ taskId: 'run-1', pauseRequested: true }, { taskId: 'run-2', pauseRequested: true }] });
    // Idempotent, and a named run limits the scope.
    assert.equal((await call('POST', '/control/pause', {})).body.runs.length, 2);
    assert.deepEqual((await call('POST', '/control/pause/cancel', { taskId: 'run-2' })).body, { runs: [{ taskId: 'run-2', pauseRequested: false }] });
    assert.deepEqual((await call('GET', '/control/pause')).body.runs, [{ taskId: 'run-1', pauseRequested: true }, { taskId: 'run-2', pauseRequested: false }]);
    assert.deepEqual((await call('POST', '/control/pause', { taskId: 'nope' })).body, { runs: [] });
  } finally {
    httpServer.close();
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime control route requires bearer auth and returns the loaded identity snapshot', () => {
  const token = 'A'.repeat(43);
  const snapshot = Object.freeze({ schemaVersion: 1, pid: process.pid, sourceHashes: Object.freeze({ 'src/server.js': 'a'.repeat(64) }) });
  const routes = new Map();
  registerControl({
    get(route, ...handlers) { routes.set(route, handlers); },
    post() {},
  }, {
    authMiddleware: createAuthMiddleware(token),
    orchestrator: {},
    runtimeIdentity: { snapshot },
  });

  const invoke = (authorization) => {
    const [auth, handler] = routes.get('/control/runtime');
    const response = {
      statusCode: 200,
      headers: {},
      body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const request = { path: '/control/runtime', headers: { authorization }, get(name) { return this.headers[name.toLowerCase()]; } };
    auth(request, response, () => handler(request, response));
    return response;
  };

  const rejected = invoke(undefined);
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(rejected.body, { error: 'Unauthorized' });
  const accepted = invoke(`Bearer ${token}`);
  assert.equal(accepted.statusCode, 200);
  assert.strictEqual(accepted.body, snapshot);
});

test('runtime identity hashes loaded source and remains stable after the source file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-identity-test-'));
  const sourcePath = path.join(root, 'src', 'loaded.js');
  const source = 'module.exports = "loaded value";\n';
  fs.mkdirSync(path.dirname(sourcePath));
  fs.writeFileSync(sourcePath, source);
  const identity = createRuntimeIdentity({ root, sourceFiles: ['src/loaded.js'] });
  try {
    const loaded = require(sourcePath);
    const snapshot = identity.seal();
    const expectedHash = require('node:crypto').createHash('sha256').update(source).digest('hex');
    assert.equal(loaded, 'loaded value');
    assert.equal(snapshot.sourceHashes['src/loaded.js'], expectedHash);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.sourceHashes), true);

    fs.writeFileSync(sourcePath, 'module.exports = "changed on disk";\n');
    assert.strictEqual(identity.snapshot, snapshot);
    assert.equal(identity.snapshot.sourceHashes['src/loaded.js'], expectedHash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the budget watcher never registers or resumes an owner pause', async () => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'state.sqlite');
  const seed = await openStateDatabase({ filePath: stateFile });
  const store = createTaskStore(seed, 'orchestrator');
  await store.save({
    id: 'lead-owner', contextId: 'c-owner', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, timestamp: new Date().toISOString() },
    artifacts: [], history: [], metadata: { pause: OWNER_PAUSE },
  }, CALL());
  await seed.close();
  const runtime = await startServer({
    listen: false,
    stateFile,
    tokenFile: path.join(dir, 'token'),
    appServer: CHATGPT_APP_SERVER(),
    orchestratorFactory: () => ({ async getPause() { return OWNER_PAUSE; } }),
    budgetWatcherOptions: { intervalMs: 20, marginMs: 0 },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(runtime.budgetWatcher.status('lead-owner'), null);
    // The reconciler leaves a parked INPUT_REQUIRED task alone across a restart.
    const task = await runtime.leadAgent.requestHandler.getTask({ id: 'lead-owner' }, CALL());
    assert.equal(task.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- STOP-01 deterministic stop

const STOPPED = { kind: 'stopped', message: 'Stopped by the owner' };

// An orchestrator whose run waits for the abort and then answers like the lead graph does.
function stoppableOrchestrator(onAbort) {
  return {
    async run({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return onAbort(signal);
    },
    async getPause() { return null; },
  };
}

async function runUntilAborted(executor, trigger) {
  const seen = [];
  const running = executor.execute({ taskId: 't-stop', contextId: 'ctx', userMessage: userMessage('Build it') }, { publish: (event) => seen.push(event) });
  await new Promise((resolve) => setImmediate(resolve));
  trigger();
  await running;
  return lastStatus(seen);
}

test('a server shutdown parks the active lead run as a stopped pause instead of canceling it', async () => {
  for (const onAbort of [
    () => ({ status: 'canceled', text: 'Canceled', rounds: 1, assignments: [] }),
    () => ({ status: 'input_required', text: 'Stopped by the owner', rounds: 1, assignments: [], pause: STOPPED }),
    () => { throw Object.assign(new Error('cancel not confirmed'), { name: 'UnconfirmedCancellationError' }); },
  ]) {
    const executor = makeLeadExecutor({ orchestrator: stoppableOrchestrator(onAbort) });
    const last = await runUntilAborted(executor, () => executor.cancelAll());
    assert.equal(last.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.deepEqual(last.metadata.pause, STOPPED);
    assert.match(statusText({ status: last.status }), /Stopped by the owner\./);
  }
});

test('an explicit task cancel stays terminal CANCELED', async () => {
  const executor = makeLeadExecutor({ orchestrator: stoppableOrchestrator(() => ({ status: 'canceled', text: 'Canceled', rounds: 1, assignments: [] })) });
  const last = await runUntilAborted(executor, () => executor.cancelTask('t-stop', { publish() {}, finished() {} }));
  assert.equal(last.status.state, TaskState.TASK_STATE_CANCELED);
});

test('a stopped task resumes with a plain message and recreates a run that never reached a checkpoint', async () => {
  const resumes = [];
  const runs = [];
  const orchestrator = {
    async getPause() { return null; },
    async getRunGoal() { return null; },
    async resume(args) { resumes.push(args); throw Object.assign(new Error('No checkpoint'), { name: 'RunNotFoundError' }); },
    async run(args) { runs.push(args); return { status: 'completed', text: 'fresh' }; },
  };
  const seen = [];
  await makeLeadExecutor({ orchestrator }).execute(
    pausedContext('t-st', STOPPED, { ...userMessage(''), parts: [{ text: '' }] }, { history: [userMessage('Original goal')] }),
    { publish: (event) => seen.push(event) },
  );
  assert.equal(resumes.length, 1);
  assert.equal(runs.length, 1);
  assert.match(runs[0].goal, /Original goal/);
  assert.equal(lastStatus(seen).status.state, TaskState.TASK_STATE_COMPLETED);
});

test('the shutdown budget the launcher grace is built on is exported: settle plus close', () => {
  const { SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TOTAL_MS } = require('../src/server');
  assert.equal(SHUTDOWN_TIMEOUT_MS, 5000);
  assert.equal(SHUTDOWN_TOTAL_MS, 10000);
});

test('a shutdown stop that lands after the run completed publishes the real COMPLETED result', async () => {
  const orchestrator = stoppableOrchestrator(() => ({ status: 'completed', text: 'All done', rounds: 2, assignments: [] }));
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator });
  const running = executor.execute({ taskId: 't-race', contextId: 'ctx', userMessage: userMessage('Build it') }, { publish: (event) => seen.push(event) });
  await new Promise((resolve) => setImmediate(resolve));
  executor.cancelAll();
  await running;
  const last = lastStatus(seen);
  assert.equal(last.status.state, TaskState.TASK_STATE_COMPLETED);
  const artifact = seen.find((event) => event.kind === 'artifactUpdate');
  assert.match(artifact.data.artifact.parts[0].content.value, /All done/);
  assert.doesNotMatch(JSON.stringify(seen), /could not be confirmed/);
});

test('an explicit cancel after the run completed keeps the old unconfirmed-cancel failure', async () => {
  const orchestrator = stoppableOrchestrator(() => ({ status: 'completed', text: 'All done', rounds: 2, assignments: [] }));
  const seen = [];
  const executor = makeLeadExecutor({ orchestrator });
  const running = executor.execute({ taskId: 't-race2', contextId: 'ctx', userMessage: userMessage('Build it') }, { publish: (event) => seen.push(event) });
  await new Promise((resolve) => setImmediate(resolve));
  await executor.cancelTask('t-race2', { publish() {}, finished() {} });
  await running;
  assert.equal(lastStatus(seen).status.state, TaskState.TASK_STATE_FAILED);
});
