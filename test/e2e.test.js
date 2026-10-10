'use strict';

// End-to-end: real startServer + real LeadOrchestrator + real A2A HTTP on loopback +
// real SQLite state. Only the Codex app server is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { DECISION_SCHEMA } = require('../src/contracts');

// Test files run in parallel processes; keep workspace locks private to this process.
process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ws-lock-'));

const BUILDER_FILE = 'src/feature.txt';

function decision(overrides = {}) {
  return { action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...overrides };
}

function assignment(role, overrides = {}) {
  return {
    role,
    objective: `Do the ${role} work`,
    allowedFiles: [],
    inputs: ['goal text'],
    evidence: ['none yet'],
    acceptanceCriteria: ['done'],
    checks: ['none'],
    stopConditions: ['blocked'],
    ...overrides,
  };
}

function workerReport(summary = 'All good') {
  return {
    outcome: 'completed',
    summary,
    filesChanged: [],
    filesInspected: ['README.md'],
    checks: [],
    risks: [],
    scopeExpansion: [],
    decisionRequest: null,
  };
}

// LL-6: an owner-only question that cites the round-1 explorer the lead dispatched first.
function humanDecision(_call, input) {
  const investigation = /"assignmentId":"([^"]*:r1:a0)"/.exec(input)[1];
  return decision({
    action: 'request_human_input',
    humanInput: {
      reason: 'credentials_or_access',
      question: 'Which flavour?',
      options: [{ id: 'a', description: 'Option A' }, { id: 'b', description: 'Option B' }],
      recommendation: 'a',
      evidenceChecked: [`${investigation} checked README.md`],
      independentWork: '',
      relatedDecisionIds: [],
    },
  });
}
const investigateThenAsk = () => [decision({ action: 'dispatch', assignments: [assignment('orch-explorer')] }), humanDecision];

/**
 * Fake Codex app server. leadScript entries are decision objects or functions
 * (call, input) => decision | throws. workerImpl(call) handles specialists.
 */
function makeFakeAppServer({ leadScript = [], workerImpl } = {}) {
  const queue = [...leadScript];
  const fake = {
    leadCalls: [],
    workerCalls: [],
    async start() {},
    async getAccount() { return { account: { type: 'chatgpt' } }; },
    async close() {},
    async readRateLimits() { return null; },
    async run({ role, input, threadId, outputSchema, signal }) {
      const isLead = role?.name === 'orch-lead' || outputSchema === DECISION_SCHEMA;
      if (isLead) {
        fake.leadCalls.push({ input, threadId });
        const next = queue.shift();
        if (next === undefined) throw new Error('lead script exhausted');
        const value = typeof next === 'function' ? next(fake.leadCalls.length, input) : next;
        return { threadId: threadId || 'lead-thread', status: 'completed', text: JSON.stringify(value) };
      }
      fake.workerCalls.push({ role: role.name, input });
      if (workerImpl) return workerImpl({ role: role.name, input, signal });
      return { threadId: 'worker-thread', status: 'completed', text: JSON.stringify(workerReport()) };
    },
  };
  return fake;
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a2a-e2e-${prefix}-`));
}

async function boot(root, appServer, { stateFile = path.join(root, 'state.sqlite') } = {}) {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const tokenFile = path.join(root, 'token', 'a2a-token');
  const runtime = await startServer({
    port: 0,
    workspace,
    appServer,
    stateFile,
    tokenFile,
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 5 }),
  });
  const origin = `http://${runtime.host}:${runtime.port}`;
  const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return { runtime, client, origin, requestOptions: { serviceParameters: { Authorization: `Bearer ${token}` } } };
}

let seq = 0;
async function send(stack, { text, taskId = '', contextId = '', metadata }) {
  seq += 1;
  return stack.client.sendMessage({
    tenant: '',
    message: {
      messageId: `e2e-${process.pid}-${seq}`,
      contextId,
      taskId,
      role: 1,
      parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      metadata,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
    metadata: undefined,
  }, stack.requestOptions);
}

function artifactText(task) {
  return task.artifacts?.at(-1)?.parts?.map((part) => part?.content?.value).filter(Boolean).join('\n') || '';
}

async function canBind() {
  const net = require('node:net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function withStack(t, appServer, fn) {
  const root = tempDir('run');
  let stack;
  try {
    stack = await boot(root, appServer);
    await fn(stack, root);
  } finally {
    if (stack) await stack.runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('e2e real stack', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('happy path: dispatch explorer, then finish', async (t) => {
    const appServer = makeFakeAppServer({
      leadScript: [
        decision({ action: 'dispatch', assignments: [assignment('orch-explorer')] }),
        decision({ final: 'Feature explored and done.' }),
      ],
    });
    await withStack(t, appServer, async (stack) => {
      const task = await send(stack, { text: 'Explore the repo' });
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(artifactText(task), 'Acceptance: not_required\n\nFeature explored and done.');
      assert.equal(appServer.workerCalls.length, 1);
      assert.equal(appServer.workerCalls[0].role, 'explorer');
      assert.equal(appServer.leadCalls.length, 2);
      assert.match(appServer.leadCalls[1].input, /All good/);
    });
  });

  await suite.test('human decision: pause, answer, finish', async (t) => {
    const appServer = makeFakeAppServer({
      leadScript: [...investigateThenAsk(), decision({ final: 'Went with A.' })],
    });
    await withStack(t, appServer, async (stack) => {
      const paused = await send(stack, { text: 'Pick something' });
      assert.equal(paused.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      const pause = paused.metadata.pause;
      assert.equal(pause.kind, 'human_decision');
      assert.ok(pause.decisionId);

      const done = await send(stack, {
        text: 'Please use flavour A because of reasons',
        taskId: paused.id,
        contextId: paused.contextId,
        metadata: { decisionId: pause.decisionId, choice: 'a' },
      });
      assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(artifactText(done), 'Acceptance: not_required\n\nWent with A.');
      assert.equal(appServer.leadCalls.length, 3);
      assert.match(appServer.leadCalls[2].input, /Please use flavour A because of reasons/);
      assert.match(appServer.leadCalls[2].input, /"choice":"a"/);
    });
  });

  await suite.test('wrong decisionId keeps the task waiting without calling the lead', async (t) => {
    const appServer = makeFakeAppServer({
      leadScript: [...investigateThenAsk(), decision({ final: 'Went with B.' })],
    });
    await withStack(t, appServer, async (stack) => {
      const paused = await send(stack, { text: 'Pick something' });
      assert.equal(paused.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      const { decisionId } = paused.metadata.pause;

      const wrong = await send(stack, {
        text: 'B please',
        taskId: paused.id,
        contextId: paused.contextId,
        metadata: { decisionId: 'not-the-decision', choice: 'b' },
      });
      assert.equal(wrong.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      assert.equal(wrong.metadata.pause.decisionId, decisionId);
      assert.equal(appServer.leadCalls.length, 2);

      // The correct id still works afterwards.
      const done = await send(stack, {
        text: 'B please',
        taskId: paused.id,
        contextId: paused.contextId,
        metadata: { decisionId, choice: 'b' },
      });
      assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(appServer.leadCalls.length, 3);
    });
  });

  await suite.test('usage limit pauses for budget and resumes on the next message', async (t) => {
    const appServer = makeFakeAppServer({
      leadScript: [
        () => {
          const error = new Error('usage limit reached');
          error.codexError = { codexErrorInfo: 'usageLimitExceeded' };
          throw error;
        },
        decision({ final: 'Finished after budget returned.' }),
      ],
    });
    await withStack(t, appServer, async (stack) => {
      const paused = await send(stack, { text: 'Do the thing' });
      assert.equal(paused.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      assert.equal(paused.metadata.pause.kind, 'waiting_for_budget');
      assert.equal(appServer.leadCalls.length, 1);

      const done = await send(stack, { text: 'budget is back', taskId: paused.id, contextId: paused.contextId });
      assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(artifactText(done), 'Acceptance: not_required\n\nFinished after budget returned.');
      assert.equal(appServer.leadCalls.length, 2);
    });
  });

  await suite.test('restart: reconciliation, resume, and the writer is not re-sent', async (t) => {
    const rootA = tempDir('crashA');
    const rootB = tempDir('crashB');
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const serverA = makeFakeAppServer({
      leadScript: [decision({
        action: 'dispatch',
        assignments: [assignment('orch-builder', { allowedFiles: [BUILDER_FILE] })],
      })],
      workerImpl: async ({ signal }) => {
        await Promise.race([hold, new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))]);
        return { threadId: 'w', status: 'interrupted', text: '' };
      },
    });
    const serverB = makeFakeAppServer({
      leadScript: [decision({ final: 'Recovered after restart.' })],
    });
    let stackA;
    let stackB;
    try {
      stackA = await boot(rootA, serverA);
      const inflight = send(stackA, { text: 'Build the feature' }).catch(() => null);
      await waitFor(() => serverA.workerCalls.length === 1, 'builder to start');
      const rows = () => stackA.runtime.state.db.prepare(
        "SELECT id, status_state FROM tasks WHERE owner = 'orch-builder'").all();
      await waitFor(() => rows().length === 1, 'builder task row');

      // Crash-consistent snapshot of the durable state while everything is mid-flight.
      stackA.runtime.state.db.pragma('wal_checkpoint(FULL)');
      const stateB = path.join(rootB, 'state.sqlite');
      fs.copyFileSync(stackA.runtime.state.filePath, stateB);
      assert.equal(serverA.leadCalls.length, 1);

      stackB = await boot(rootB, serverB, { stateFile: stateB });
      const leadRow = stackB.runtime.state.db.prepare("SELECT id FROM tasks WHERE owner = 'orchestrator'").all();
      assert.equal(leadRow.length, 1);
      const leadTask = await stackB.client.getTask({ tenant: '', id: leadRow[0].id, historyLength: 0 }, stackB.requestOptions);
      assert.equal(leadTask.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
      assert.equal(leadTask.metadata.pause.kind, 'restart');
      const builderRows = stackB.runtime.state.db.prepare(
        "SELECT id, status_state FROM tasks WHERE owner = 'orch-builder'").all();
      assert.equal(builderRows.length, 1);
      assert.equal(builderRows[0].status_state, 'TASK_STATE_FAILED');

      const done = await send(stackB, { text: 'resume', taskId: leadTask.id, contextId: leadTask.contextId });
      assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
      // Stack B uses a different workspace (rootB/workspace), so builder execution row from stack A is not visible; acceptance resolves as unverified.
      assert.match(artifactText(done), /^Acceptance: unverified[\s\S]*Recovered after restart\.$/);

      assert.equal(serverB.leadCalls.length, 1);
      assert.match(serverB.leadCalls[0].input, /resumed after an interruption/);
      assert.match(serverB.leadCalls[0].input, /"failureKind":"interrupted"/);
      assert.match(serverB.leadCalls[0].input, /engineer/);
      assert.equal(serverA.workerCalls.length + serverB.workerCalls.length, 1);
      assert.equal(serverB.workerCalls.length, 0);

      release();
      await inflight;
    } finally {
      release();
      if (stackB) await stackB.runtime.close();
      if (stackA) await stackA.runtime.close();
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});
