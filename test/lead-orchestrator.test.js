'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LeadOrchestrator, renderRunDigest } = require('../src/lead-orchestrator');
const { TaskState } = require('@a2a-js/sdk');
const { Command, GraphRecursionError } = require('@langchain/langgraph');

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

const decision = (action, assignments = [], final = '') => JSON.stringify({
  action, assignments, final, resolutions: [], humanInput: null,
});

const workerReport = (summary, overrides = {}) => JSON.stringify({
  outcome: 'completed',
  summary,
  filesChanged: [],
  filesInspected: [],
  checks: [],
  risks: [],
  scopeExpansion: [],
  decisionRequest: null,
  ...overrides,
});

function makeHarness({ decisions, taskSequence = [], pollIntervalMs = 0, sendMessageImpl, getTaskImpl, cancelTaskImpl, listTasksImpl, authToken = 'test-token', cancelTimeoutMs = 500, cancelRetryIntervalMs = 1, stepLimit } = {}) {
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
      ...(stepLimit === undefined ? {} : { stepLimit }),
      ...(cancelTimeoutMs === 'default' ? {} : { cancelTimeoutMs }),
      cancelRetryIntervalMs,
    }),
  };
}

function role(name, sandbox) {
  return { name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: 'Test agent' };
}

function completedTask(roleName, reportText = workerReport(`${roleName} done`), changedPaths = []) {
  return {
    id: `${roleName}-task`,
    contextId: `${roleName}-context`,
    status: { state: TaskState.TASK_STATE_COMPLETED },
    artifacts: [{
      name: 'result',
      parts: [{ content: { $case: 'text', value: reportText } }],
      metadata: { writerExecution: { executionId: `${roleName}-exec`, state: 'released', delta: { known: true, headChanged: false, changedPaths }, reason: null } },
    }],
    history: [],
  };
}

test('dispatches an authenticated A2A assignment and finishes with a fresh read-only lead turn', async () => {
  const h = makeHarness({ decisions: [decision('dispatch', [brief('orch-builder')]), decision('finish', [], 'Implemented successfully')] });
  const result = await h.orchestrator.run({ goal: 'Implement feature' });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Implemented successfully');
  assert.equal(result.rounds, 1);
  assert.equal(result.assignments[0].status, 'TASK_STATE_COMPLETED');
  assert.equal(result.assignments[0].report.summary, 'orch-builder done');
  assert.equal(result.assignments[0].reportError, null);
  const leadCalls = h.calls.filter((call) => call.type === 'lead');
  assert.equal(leadCalls.length, 2);
  assert.equal(leadCalls[0].role.sandbox, 'read-only');
  assert.equal(leadCalls[1].threadId, undefined);
  assert.match(leadCalls[1].input, /orch-builder done/);
  const sent = h.calls.find((call) => call.type === 'send');
  assert.equal(sent.params.configuration.returnImmediately, true);
  assert.deepEqual(sent.options.serviceParameters, { authorization: 'Bearer test-token' });
  assert.equal(sent.params.message.contextId.length > 0, true);
  assert.equal(Object.hasOwn(sent.params.message, 'taskId'), false);
  const briefText = JSON.parse(sent.params.message.parts[0].content.value);
  assert.equal(briefText.allowedFiles[0], 'src/example.js');
  assert.equal(briefText.assignmentId, result.assignments[0].assignmentId);
  assert.equal(briefText.workspace, '/tmp/a2a-project');
  assert.match(briefText.reportContract, /worker-report\/v1/);
  const cardRequest = h.calls.find((call) => call.type === 'client');
  assert.equal(cardRequest.cardPath, '');
  assert.equal(new URL(cardRequest.cardPath, cardRequest.url).href, 'http://127.0.0.1:4040/agents/orch-builder/agent-card.json');
});

const thrice = (value) => [value, value, value];

async function assertLoopDetected(h, goal, details, expectedLeadCalls = 3) {
  const result = await h.orchestrator.run({ goal });
  assert.equal(result.status, 'input_required');
  assert.equal(result.pause.kind, 'human_decision');
  assert.equal(result.pause.reason, 'loop_detected');
  assert.match(result.pause.question, details);
  assert.equal(h.calls.filter((call) => call.type === 'lead').length, expectedLeadCalls);
  return result;
}

test('rejects unknown roles and traversal paths before contacting A2A', async (t) => {
  for (const assignment of [brief('orch-missing'), brief('orch-builder', ['../secret.txt']), brief('orch-builder', ['/etc/passwd'])]) {
    await t.test(assignment.role + ':' + assignment.allowedFiles[0], async () => {
      const h = makeHarness({ decisions: thrice(decision('dispatch', [assignment])) });
      const code = assignment.role === 'orch-missing' ? 'role_unknown' : 'path_unsafe';
      await assertLoopDetected(h, 'Implement feature', new RegExp(`3 times.*${code}.*(Unknown role|Unsafe allowedFiles path)`));
      assert.equal(h.calls.some((call) => call.type === 'send'), false);
    });
  }
});

test('enforces repair escalation order', async () => {
  const h = makeHarness({ decisions: thrice(decision('dispatch', [brief('orch-repair-xhigh')])) });
  await assertLoopDetected(h, 'Repair defect', /3 times.*role_ladder_violation.*only be dispatched after an engineer attempt/);
  assert.equal(h.calls.some((call) => call.type === 'send'), false);

  const sameBatch = makeHarness({ decisions: thrice(decision('dispatch', [brief('orch-builder'), brief('orch-repair-xhigh')])) });
  await assertLoopDetected(sameBatch, 'Repair defect', /3 times.*role_ladder_violation.*only be dispatched after an engineer attempt/);
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
  const noEvidence = makeHarness({ decisions: thrice(decision('dispatch', [brief('orch-architect')])) });
  await assertLoopDetected(noEvidence, 'Review design', /3 times.*architect_constraint.*requires inspected prior evidence/);
  assert.equal(noEvidence.calls.some((call) => call.type === 'send'), false);

  const h = makeHarness({ decisions: [
    decision('dispatch', [brief('orch-explorer')]),
    ...thrice(decision('dispatch', [brief('orch-architect'), brief('orch-explorer')])),
  ] });
  await assertLoopDetected(h, 'Review design', /3 times.*architect_constraint.*one narrowly framed decision/, 4);
  assert.equal(h.calls.filter((call) => call.type === 'send').length, 1);
});

test('returns failed task evidence to the lead for its next decision', async () => {
  const failed = {
    id: 'builder-task', contextId: 'context',
    status: { state: TaskState.TASK_STATE_FAILED, message: { parts: [{ content: { $case: 'text', value: 'compile failed' } }], metadata: { writerExecution: { executionId: 'e1', state: 'released', delta: null, reason: null } } } },
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
    stepLimit: 2,
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

test('defaults the cancel-confirmation deadline to 30 seconds and keeps it overridable', () => {
  assert.equal(makeHarness({ decisions: [], cancelTimeoutMs: 'default' }).orchestrator.cancelTimeoutMs, 30_000);
  assert.equal(makeHarness({ decisions: [], cancelTimeoutMs: 1234 }).orchestrator.cancelTimeoutMs, 1234);
});

test('defaults maxRounds to 80 and validates explicit round and step limits', () => {
  const h = makeHarness({ decisions: [] });
  assert.equal(h.orchestrator.maxRounds, 80);
  assert.equal(h.orchestrator.stepLimit, 100_000);

  for (const maxRounds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new (h.orchestrator.constructor)({
      appServer: h.appServer,
      roles: h.roles,
      workspace: '/tmp/a2a-project',
      baseUrl: 'http://127.0.0.1:4040/',
      maxRounds,
    }), { name: 'TypeError', message: 'maxRounds must be null or a positive safe integer' });
  }
  for (const maxRounds of [null, 1, Number.MAX_SAFE_INTEGER]) {
    const configured = new (h.orchestrator.constructor)({
      appServer: h.appServer,
      roles: h.roles,
      workspace: '/tmp/a2a-project',
      baseUrl: 'http://127.0.0.1:4040/',
      maxRounds,
    });
    assert.equal(configured.maxRounds, maxRounds);
  }
  for (const stepLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new (h.orchestrator.constructor)({
      appServer: h.appServer,
      roles: h.roles,
      workspace: '/tmp/a2a-project',
      baseUrl: 'http://127.0.0.1:4040/',
      stepLimit,
    }), { name: 'TypeError', message: 'stepLimit must be a positive safe integer' });
  }
});

test('resumes an advanced LangGraph checkpoint across per-invoke recursion limits', async () => {
  const h = makeHarness({
    stepLimit: 2,
    decisions: [decision('dispatch', [brief('orch-explorer', [])]), decision('finish', [], 'Done after rollover')],
    sendMessageImpl: ({ role: roleName }) => ({
      task: { ...completedTask(roleName), id: 'rollover-task', status: { state: TaskState.TASK_STATE_WORKING } },
    }),
  });
  const result = await h.orchestrator.run({ goal: 'Inspect one bounded topic' });

  assert.equal(result.status, 'completed');
  assert.equal(result.rounds, 1);
  assert.equal(result.assignments.length, 1);
  assert.equal(h.calls.filter((call) => call.type === 'lead').length, 2);
  assert.equal(h.calls.filter((call) => call.type === 'send').length, 1);
  assert.equal(h.calls.filter((call) => call.type === 'get').length, 1);
});

test('does not retry recursion errors when the checkpoint did not advance', async () => {
  const h = makeHarness({ decisions: [] });
  let invokes = 0;
  const checkpoint = {
    values: { round: 0, outcomes: [] },
    next: ['decide'],
    tasks: [],
    metadata: { step: 4 },
    config: { configurable: { checkpoint_id: 'same-checkpoint' } },
  };
  h.orchestrator.graph = {
    async getState() { return checkpoint; },
    async invoke() {
      invokes += 1;
      throw new GraphRecursionError('Recursion limit reached');
    },
  };

  await assert.rejects(h.orchestrator._drive('no-advance', { goal: 'test' }, {
    signal: undefined,
    onEvent: undefined,
    interruptAfter: undefined,
    resumed: false,
    contextId: undefined,
  }), { name: 'GraphRecursionError' });
  assert.equal(invokes, 1);
});

test('does not treat missing checkpoint identity or step as advancement', async () => {
  const h = makeHarness({ decisions: [] });
  let reads = 0;
  let invokes = 0;
  const snapshots = [
    { values: { round: 0, outcomes: [] }, next: ['decide'], tasks: [], metadata: { step: 4 }, config: { configurable: { checkpoint_id: 'before' } } },
    { values: { round: 0, outcomes: [] }, next: ['decide'], tasks: [] },
  ];
  h.orchestrator.graph = {
    async getState() { return snapshots[Math.min(reads++, snapshots.length - 1)]; },
    async invoke() {
      invokes += 1;
      throw new GraphRecursionError('Recursion limit reached');
    },
  };

  await assert.rejects(h.orchestrator._drive('unknown-advance', { goal: 'test' }, {
    signal: undefined,
    onEvent: undefined,
    interruptAfter: undefined,
    resumed: false,
    contextId: undefined,
  }), { name: 'GraphRecursionError' });
  assert.equal(invokes, 1);
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

test('dispatches writable batches serially and read-only batches in parallel', async () => {
  const order = [];
  const pendingSends = [];
  const serial = makeHarness({
    decisions: [decision('dispatch', [brief('orch-builder', ['a.js']), brief('orch-builder', ['b.js'])]), decision('finish', [], 'Done')],
    sendMessageImpl: ({ role: roleName, params }) => {
      order.push(`send:${roleName}:${JSON.parse(params.message.parts[0].content.value).allowedFiles[0]}`);
      return { task: { ...completedTask(roleName), id: `t${order.length}`, status: { state: TaskState.TASK_STATE_WORKING } } };
    },
    getTaskImpl: ({ params }) => { order.push(`get:${params.id}`); return { ...completedTask('orch-builder'), id: params.id }; },
  });
  await serial.orchestrator.run({ goal: 'Serial' });
  assert.deepEqual(order, ['send:orch-builder:a.js', 'get:t1', 'send:orch-builder:b.js', 'get:t3']);

  const parallel = makeHarness({
    decisions: [decision('dispatch', [brief('orch-explorer', []), brief('orch-explorer', [])]), decision('finish', [], 'Done')],
    sendMessageImpl: ({ role: roleName }) => {
      pendingSends.push(roleName);
      return { task: { ...completedTask(roleName), id: `p${pendingSends.length}`, status: { state: TaskState.TASK_STATE_WORKING } } };
    },
    getTaskImpl: ({ params }) => {
      assert.equal(pendingSends.length, 2, 'all read-only sends happen before any poll');
      return { ...completedTask('orch-explorer'), id: params.id };
    },
  });
  const result = await parallel.orchestrator.run({ goal: 'Parallel' });
  assert.equal(result.status, 'completed');
  assert.equal(result.assignments.length, 2);
});

test('rejects a human choice outside pending options and preserves free-text resume', async () => {
  const request = {
    reason: 'irreversible_operation',
    question: 'Which implementation should be used?',
    options: [
      { id: 'minimal', description: 'Use the minimal implementation' },
      { id: 'extended', description: 'Use the extended implementation' },
    ],
    recommendation: 'minimal',
    evidenceChecked: ['human-choice-run:r1:a0 inspected the existing project structure'],
    independentWork: '',
    relatedDecisionIds: [],
  };
  const h = makeHarness({
    stepLimit: 2,
    decisions: [
      decision('dispatch', [brief('orch-explorer', [])]),
      JSON.stringify({ action: 'request_human_input', assignments: [], final: '', resolutions: [], humanInput: request }),
      decision('finish', [], 'Decision received'),
    ],
  });
  const invokeInputs = [];
  const invoke = h.orchestrator.graph.invoke.bind(h.orchestrator.graph);
  h.orchestrator.graph.invoke = (input, config) => {
    invokeInputs.push(input);
    return invoke(input, config);
  };
  const paused = await h.orchestrator.run({ goal: 'Choose implementation', runId: 'human-choice-run' });
  assert.equal(paused.status, 'input_required');
  // The launcher decision card renders metadata.pause, which is this result's pause unchanged.
  assert.equal(paused.pause.kind, 'human_decision');
  assert.equal(paused.pause.reason, 'irreversible_operation');
  assert.equal(paused.pause.question, request.question);
  assert.deepEqual(paused.pause.options, request.options);
  assert.equal(paused.pause.recommendation, 'minimal');
  assert.deepEqual(paused.pause.evidenceChecked, request.evidenceChecked);
  assert.equal(paused.pause.independentWork, '');
  const pending = await h.orchestrator.getPause(paused.runId);

  for (const choice of ['guess', '', null, 12]) {
    await assert.rejects(
      h.orchestrator.resume({ runId: paused.runId, input: { answer: 'Use the recommended approach', choice } }),
      { name: 'ResumeInputError', message: 'choice must match one of the pending human decision option ids' },
    );
    assert.deepEqual(await h.orchestrator.getPause(paused.runId), pending);
  }
  assert.equal(h.calls.filter((call) => call.type === 'lead').length, 2);

  const result = await h.orchestrator.resume({ runId: paused.runId, input: { answer: 'Proceed with a text-only answer' } });
  assert.equal(result.status, 'completed');
  assert.equal(invokeInputs.filter((input) => input instanceof Command).length, 1);
  assert.ok(invokeInputs.filter((input) => input === null).length > 0);
  const resumedLead = h.calls.filter((call) => call.type === 'lead')[2];
  assert.match(resumedLead.input, /"answer":"Proceed with a text-only answer"/);
  assert.equal(resumedLead.input.includes('"choice"'), false);
  assert.equal(h.calls.filter((call) => call.type === 'lead').length, 3);
});

test('getRunDigest summarizes a finished run checkpoint and is null without one', async () => {
  const report = workerReport('S'.repeat(600), { filesInspected: ['docs/a.md', 'docs/b.md', 'docs/a.md'], filesChanged: ['src/example.js'] });
  const h = makeHarness({
    decisions: [decision('dispatch', [brief('orch-builder')]), decision('finish', [], `Done.\n\nNext work: fix the matrix ${'x'.repeat(2000)}`)],
    taskSequence: [completedTask('orch-builder', report, ['src/z.js', 'src/example.js'])],
  });
  const result = await h.orchestrator.run({ goal: 'G'.repeat(3000), runId: 'run-digest' });
  const digest = await h.orchestrator.getRunDigest(result.runId || 'run-digest');
  assert.equal(digest.status, 'completed');
  assert.equal(digest.rounds, 1);
  assert.equal(digest.goal.length, 2000);
  assert.equal(digest.outcomes.length, 1);
  assert.equal(digest.outcomes[0].summary.length, 400);
  assert.ok(digest.text.length <= 4000);
  assert.ok(digest.nextWork.startsWith('Next work: fix the matrix'));
  assert.ok(digest.nextWork.length <= 1500);
  assert.deepEqual(digest.inspectedDocs, [{ file: 'docs/a.md', count: 2 }, { file: 'docs/b.md', count: 1 }]);
  assert.deepEqual(digest.changedFiles, ['src/example.js', 'src/z.js']);
  assert.equal(await h.orchestrator.getRunDigest('no-such-run'), null);
  assert.equal(await h.orchestrator.getRunDigest(''), null);
});

test('renderRunDigest trims summaries, then inspected docs, then changed files within 12000 chars', () => {
  const outcomes = Array.from({ length: 60 }, (_, i) => ({ role: `r${i}`, objective: 'o', status: 'TASK_STATE_COMPLETED', outcome: 'completed', summary: 'x'.repeat(400) }));
  const base = {
    goal: 'goal', text: 'final', rounds: 2, status: 'completed', outcomes, openDecisions: [], nextWork: '',
    inspectedDocs: Array.from({ length: 30 }, (_, i) => ({ file: `docs/${'d'.repeat(60)}${i}.md`, count: 30 - i })),
    changedFiles: Array.from({ length: 100 }, (_, i) => `src/${'f'.repeat(50)}${i}.js`),
  };
  const full = renderRunDigest({ ...base, outcomes: outcomes.slice(0, 2), inspectedDocs: [], changedFiles: ['src/a.js'] });
  assert.match(full, /summary: x{400}/);
  assert.match(full, /Changed files: src\/a\.js/);
  const trimmed = renderRunDigest(base);
  assert.ok(trimmed.length <= 12000);
  assert.doesNotMatch(trimmed, /summary: /);
  assert.match(trimmed, /Most inspected files/);
  assert.match(trimmed, /Changed files/);
  const heavy = { ...base, outcomes: Array.from({ length: 25 }, (_, i) => ({ role: `r${i}`, objective: 'o'.repeat(200), status: 'x', summary: 's' })) };
  const noDocs = renderRunDigest(heavy);
  assert.ok(noDocs.length <= 12000);
  assert.doesNotMatch(noDocs, /Most inspected files/);
  assert.match(noDocs, /Changed files/);
  const huge = renderRunDigest({ ...heavy, outcomes: Array.from({ length: 200 }, (_, i) => ({ role: `r${i}`, objective: 'o'.repeat(300), status: 'x' })) });
  assert.ok(huge.length <= 12000);
  assert.doesNotMatch(huge, /Changed files/);
  assert.equal(renderRunDigest(null), '');
});

test('outcomes carry the bounded assignment objective and the run digest shows it', async () => {
  const long = { ...brief('orch-explorer', []), objective: 'O'.repeat(3000) };
  const h = makeHarness({ decisions: [decision('dispatch', [brief('orch-builder'), long]), decision('finish', [], 'Done.')] });
  const result = await h.orchestrator.run({ goal: 'Objectives', runId: 'run-objective' });
  assert.equal(result.assignments[0].objective, 'Complete a bounded task');
  assert.equal(result.assignments[1].objective.length, 300);
  const digest = await h.orchestrator.getRunDigest('run-objective');
  assert.equal(digest.outcomes[0].objective, 'Complete a bounded task');
  assert.match(renderRunDigest(digest), /- engineer \[completed\] Complete a bounded task/);
  // The lead prompt keeps its previous outcome projection.
  const secondLead = h.calls.filter((call) => call.type === 'lead')[1];
  assert.equal(secondLead.input.includes('"objective"'), false);
});

test('renderRunDigest does not double the Next work label', () => {
  const base = { goal: 'g', text: 't', rounds: 1, status: 'completed', outcomes: [], openDecisions: [], inspectedDocs: [], changedFiles: [] };
  const labelled = renderRunDigest({ ...base, nextWork: 'Next work: fix the matrix' });
  assert.match(labelled, /^Next work: fix the matrix$/m);
  assert.doesNotMatch(labelled, /Next work: Next work/);
  assert.doesNotMatch(renderRunDigest({ ...base, nextWork: '**Next work**: rerun the gate' }), /Next work: \*\*Next work/);
  assert.match(renderRunDigest({ ...base, nextWork: 'Remaining work: rerun the gate' }), /^Next work: Remaining work: rerun the gate$/m);
});
