'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { TaskState } = require('@a2a-js/sdk');

const brief = (role, allowedFiles = ['src/example.js']) => ({
  role,
  objective: 'Complete a bounded task',
  allowedFiles,
  inputs: ['User goal'],
  evidence: ['Existing project files'],
  acceptanceCriteria: ['The result meets the stated goal'],
  checks: ['Review the changed files'],
  stopConditions: ['Stop if another file is required'],
});

const decision = (action, assignments = [], final = '') => JSON.stringify({ action, assignments, final });

function makeHarness({ decisions, taskSequence = [], pollIntervalMs = 0, sendMessageImpl, getTaskImpl, cancelTaskImpl, listTasksImpl, authToken = 'test-token', cancelTimeoutMs = 500, cancelRetryIntervalMs = 1 } = {}) {
  const calls = [];
  const clients = new Map();
  let leadIndex = 0;
  const appServer = {
    async run(args) {
      calls.push({ type: 'lead', ...args });
      const text = decisions[leadIndex++];
      if (text instanceof Error) throw text;
      return { threadId: 'lead-thread', turnId: `turn-${leadIndex}`, status: 'completed', text };
    },
  };
  const clientFactory = {
    async createFromUrl(url, cardPath) {
      const parsedUrl = new URL(url);
      const role = decodeURIComponent(parsedUrl.pathname.split('/').at(-2));
      calls.push({ type: 'client', role, url, cardPath });
      if (!clients.has(role)) {
        const client = {
          async sendMessage(params, options) {
            calls.push({ type: 'send', role, params, options });
            if (sendMessageImpl) return sendMessageImpl({ role, params, options, calls });
            const next = taskSequence.shift() || completedTask(role);
            return { task: next };
          },
          async getTask(params, options) {
            calls.push({ type: 'get', role, params, options });
            if (getTaskImpl) return getTaskImpl({ role, params, options, calls });
            return completedTask(role);
          },
          async cancelTask(params, options) {
            calls.push({ type: 'cancel', role, params, options });
            if (cancelTaskImpl) return cancelTaskImpl({ role, params, options, calls });
            return { ...completedTask(role), id: params.id, status: { state: TaskState.TASK_STATE_CANCELED } };
          },
          async listTasks(params, options) {
            calls.push({ type: 'list', role, params, options });
            if (listTasksImpl) return listTasksImpl({ role, params, options, calls });
            return { tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 };
          },
        };
        clients.set(role, client);
      }
      return clients.get(role);
    },
  };
  const roles = new Map([
    ['orch-builder', role('orch-builder', 'workspace-write')],
    ['orch-explorer', role('orch-explorer', 'read-only')],
    ['orch-repair-xhigh', role('orch-repair-xhigh', 'workspace-write')],
    ['orch-repair-sol', role('orch-repair-sol', 'workspace-write')],
    ['orch-architect', role('orch-architect', 'read-only')],
  ]);
  return {
    calls,
    roles,
    appServer,
    orchestrator: new LeadOrchestrator({
      appServer,
      roles,
      workspace: '/tmp/a2a-project',
      baseUrl: 'http://127.0.0.1:4040/',
      clientFactory,
      pollIntervalMs,
      authToken,
      cancelTimeoutMs,
      cancelRetryIntervalMs,
    }),
  };
}

function role(name, sandbox) {
  return { name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: 'Test agent' };
}

function completedTask(roleName) {
  return {
    id: `${roleName}-task`,
    contextId: `${roleName}-context`,
    status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [{ name: 'result', parts: [{ content: { $case: 'text', value: `${roleName} done` } }] }],
    history: [],
  };
}

test('dispatches an authenticated A2A assignment and finishes on the same read-only lead thread', async () => {
  const h = makeHarness({ decisions: [decision('dispatch', [brief('orch-builder')]), decision('finish', [], 'Implemented successfully')] });
  const result = await h.orchestrator.run({ goal: 'Implement feature' });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Implemented successfully');
  assert.equal(result.rounds, 1);
  assert.equal(result.assignments[0].status, 'TASK_STATE_COMPLETED');
  assert.equal(result.assignments[0].text, 'orch-builder done');
  const leadCalls = h.calls.filter((call) => call.type === 'lead');
  assert.equal(leadCalls.length, 2);
  assert.equal(leadCalls[0].role.sandbox, 'read-only');
  assert.equal(leadCalls[1].threadId, 'lead-thread');
  assert.match(leadCalls[1].input, /orch-builder done/);
  const sent = h.calls.find((call) => call.type === 'send');
  assert.equal(sent.params.configuration.returnImmediately, true);
  assert.deepEqual(sent.options.serviceParameters, { authorization: 'Bearer test-token' });
  assert.equal(sent.params.message.contextId.length > 0, true);
  assert.equal(Object.hasOwn(sent.params.message, 'taskId'), false);
  assert.equal(JSON.parse(sent.params.message.parts[0].content.value).allowedFiles[0], 'src/example.js');
  const cardRequest = h.calls.find((call) => call.type === 'client');
  assert.equal(cardRequest.cardPath, '');
  assert.equal(new URL(cardRequest.cardPath, cardRequest.url).href, 'http://127.0.0.1:4040/agents/orch-builder/agent-card.json');
});

test('rejects unknown roles and traversal paths before contacting A2A', async (t) => {
  for (const assignment of [brief('orch-missing'), brief('orch-builder', ['../secret.txt']), brief('orch-builder', ['/etc/passwd'])]) {
    await t.test(assignment.role + ':' + assignment.allowedFiles[0], async () => {
      const h = makeHarness({ decisions: [decision('dispatch', [assignment])] });
      await assert.rejects(h.orchestrator.run({ goal: 'Implement feature' }), /Unknown role|Unsafe allowedFiles path/);
      assert.equal(h.calls.some((call) => call.type === 'send'), false);
    });
  }
});

test('enforces repair escalation order', async () => {
  const h = makeHarness({ decisions: [decision('dispatch', [brief('orch-repair-xhigh')])] });
  await assert.rejects(h.orchestrator.run({ goal: 'Repair defect' }), /only be dispatched after an orch-builder attempt/);
  assert.equal(h.calls.some((call) => call.type === 'send'), false);

  const sameBatch = makeHarness({ decisions: [decision('dispatch', [brief('orch-builder'), brief('orch-repair-xhigh')])] });
  await assert.rejects(sameBatch.orchestrator.run({ goal: 'Repair defect' }), /only be dispatched after an orch-builder attempt/);
  assert.equal(sameBatch.calls.some((call) => call.type === 'send'), false);

  const sequential = makeHarness({ decisions: [
    decision('dispatch', [brief('orch-builder')]),
    decision('dispatch', [brief('orch-repair-xhigh')]),
    decision('dispatch', [brief('orch-repair-sol')]),
    decision('finish', [], 'Recovered'),
  ] });
  const result = await sequential.orchestrator.run({ goal: 'Repair defect' });
  assert.equal(result.status, 'completed');
  assert.equal(result.rounds, 3);
});

test('requires prior evidence and one narrow decision for the architect', async (t) => {
  const noEvidence = makeHarness({ decisions: [decision('dispatch', [brief('orch-architect')])] });
  await assert.rejects(noEvidence.orchestrator.run({ goal: 'Review design' }), /requires inspected prior evidence/);

  const h = makeHarness({ decisions: [
    decision('dispatch', [brief('orch-explorer')]),
    decision('dispatch', [brief('orch-architect'), brief('orch-explorer')]),
  ] });
  await assert.rejects(h.orchestrator.run({ goal: 'Review design' }), /one narrowly framed decision/);
  assert.equal(h.calls.filter((call) => call.type === 'send').length, 1);
});

test('returns failed task evidence to the lead for its next decision', async () => {
  const failed = {
    id: 'builder-task', contextId: 'context',
    status: { state: TaskState.TASK_STATE_FAILED, message: { parts: [{ content: { $case: 'text', value: 'compile failed' } }] } },
    artifacts: [], history: [],
  };
  const h = makeHarness({
    decisions: [decision('dispatch', [brief('orch-builder')]), decision('finish', [], 'Failure reviewed')],
    taskSequence: [failed],
  });
  const result = await h.orchestrator.run({ goal: 'Build feature' });
  assert.equal(result.assignments[0].status, 'TASK_STATE_FAILED');
  assert.match(h.calls.filter((call) => call.type === 'lead')[1].input, /compile failed/);
});

test('cancels an in-flight A2A task when the caller aborts', async () => {
  let submitted;
  let finishSend;
  const h = makeHarness({
    decisions: [decision('dispatch', [brief('orch-builder')])],
    sendMessageImpl: async ({ role: roleName }) => {
      submitted = { task: { id: 'known-task', contextId: 'context', status: { state: TaskState.TASK_STATE_WORKING }, artifacts: [], history: [] } };
      return new Promise((resolve) => { finishSend = () => resolve(submitted); });
    },
    getTaskImpl: async () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = h.orchestrator.run({ goal: 'Build feature', signal: controller.signal });
  while (!finishSend) await new Promise((resolve) => setImmediate(resolve));
  finishSend();
  while (!h.calls.some((call) => call.type === 'get')) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'canceled');
  assert.equal(h.calls.filter((call) => call.type === 'cancel').length, 1);
  assert.equal(h.calls.find((call) => call.type === 'cancel').params.id, 'known-task');
  assert.deepEqual(h.calls.find((call) => call.type === 'cancel').options.serviceParameters, { authorization: 'Bearer test-token' });
  assert.deepEqual(h.calls.find((call) => call.type === 'get').options.serviceParameters, { authorization: 'Bearer test-token' });
});

test('discovers and cancels a task created after sendMessage is aborted', async () => {
  let listAttempts = 0;
  let cancelAttempts = 0;
  let sendMessage;
  const h = makeHarness({
    decisions: [decision('dispatch', [brief('orch-builder')])],
    sendMessageImpl: ({ params }) => {
      sendMessage = params;
      return new Promise(() => {});
    },
    listTasksImpl: ({ params }) => {
      listAttempts += 1;
      if (listAttempts < 3) return { tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 };
      return { tasks: [{ id: 'late-task', contextId: params.contextId, status: { state: TaskState.TASK_STATE_WORKING }, artifacts: [], history: [] }] };
    },
    cancelTaskImpl: ({ params }) => {
      cancelAttempts += 1;
      return {
        id: params.id,
        contextId: sendMessage.message.contextId,
        status: { state: cancelAttempts < 2 ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_CANCELED },
        artifacts: [], history: [],
      };
    },
    getTaskImpl: async ({ params }) => ({
      id: params.id,
      contextId: sendMessage.message.contextId,
      status: { state: TaskState.TASK_STATE_WORKING },
      artifacts: [], history: [],
    }),
  });
  const controller = new AbortController();
  const pending = h.orchestrator.run({ goal: 'Build feature', signal: controller.signal });
  while (!sendMessage) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;

  assert.equal(result.status, 'canceled');
  assert.equal(Object.hasOwn(sendMessage.message, 'taskId'), false);
  assert.ok(sendMessage.message.contextId);
  assert.ok(listAttempts >= 3);
  assert.ok(cancelAttempts >= 2);
  assert.equal(result.assignments[0].taskId, 'late-task');
  assert.equal(h.calls.filter((call) => call.type === 'list').every((call) => call.options.serviceParameters.authorization === 'Bearer test-token'), true);
});

test('throws an explicit error when abort cancellation cannot be confirmed', async () => {
  const h = makeHarness({
    decisions: [decision('dispatch', [brief('orch-builder')])],
    sendMessageImpl: () => new Promise(() => {}),
    listTasksImpl: async () => ({ tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 }),
    cancelTimeoutMs: 5,
    cancelRetryIntervalMs: 1,
  });
  const controller = new AbortController();
  const pending = h.orchestrator.run({ goal: 'Build feature', signal: controller.signal });
  while (!h.calls.some((call) => call.type === 'send')) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'UnconfirmedCancellationError' });
});
