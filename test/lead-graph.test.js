'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator, RunNotFoundError } = require('../src/lead-orchestrator');
const {
  DispatchJournal, openStateDatabase, assignmentId, attemptId, deterministicContextId,
} = require('../src/durable-store');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-graph-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let dbCounter = 0;
const newDbPath = () => path.join(tmpRoot, `state-${dbCounter += 1}.sqlite`);

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

const decision = (fields) => JSON.stringify({
  action: 'finish', assignments: [], final: '', resolutions: [], humanInput: null, ...fields,
});
const dispatch = (...assignments) => decision({ action: 'dispatch', assignments });
const finish = (final = 'All done', resolutions = []) => decision({ action: 'finish', final, resolutions });
const humanRequest = (relatedDecisionIds = []) => decision({
  action: 'request_human_input',
  humanInput: {
    reason: 'product_choice',
    question: 'Which variant?',
    options: [{ id: 'a', description: 'Variant A' }, { id: 'b', description: 'Variant B' }],
    recommendation: 'a',
    evidenceChecked: ['README.md'],
    independentWork: 'none',
    relatedDecisionIds,
  },
});

const report = (summary, overrides = {}) => JSON.stringify({
  outcome: 'completed', summary, filesChanged: [], filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null, ...overrides,
});
const needsDecisionReport = () => report('Need a call', {
  outcome: 'needs_decision',
  decisionRequest: {
    question: 'Keep the API?',
    options: [{ id: 'keep', description: 'Keep it' }, { id: 'drop', description: 'Drop it' }],
    evidenceChecked: ['src/api.js'],
    recommendation: 'keep',
    consequenceIfWrong: 'Breaking change',
  },
});

const usageLimitError = () => Object.assign(new Error('You hit your usage limit'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } });

const role = (name, sandbox) => ({ name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: 'Test agent' });
const roles = () => new Map([
  ['orch-builder', role('orch-builder', 'workspace-write')],
  ['orch-explorer', role('orch-explorer', 'read-only')],
  ['orch-architect', role('orch-architect', 'read-only')],
]);

const textParts = (value) => [{ content: { $case: 'text', value } }];

// A2A + lead world shared across orchestrator "restarts": recorded tasks, sends, lead turns.
function makeWorld({ script, workerFinal, pollsNeeded = 0, getTaskFault }) {
  const world = {
    script,
    leadTurns: 0,
    prompts: [],
    sends: [],
    polls: new Map(),
    tasks: new Map(),
    pollsNeeded,
    getTaskFault,
    workerFinal: workerFinal || ((roleName) => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report(`${roleName} done`)) }],
    })),
  };
  const view = (task, done) => {
    const final = done ? world.workerFinal(task.role, task.contextId) : { state: TaskState.TASK_STATE_WORKING };
    return {
      id: task.id,
      contextId: task.contextId,
      status: { state: final.state, ...(final.message ? { message: final.message } : {}) },
      artifacts: done ? final.artifacts || [] : [],
      history: [],
    };
  };
  world.appServer = {
    async run(args) {
      world.prompts.push(args.input);
      const next = world.script[world.leadTurns];
      world.leadTurns += 1;
      if (next === undefined) throw new Error('lead script exhausted');
      if (typeof next === 'function') return { threadId: 'lead-thread', status: 'completed', text: await next(args) };
      if (next instanceof Error) throw next;
      return { threadId: 'lead-thread', status: 'completed', text: next };
    },
  };
  world.clientFactory = {
    async createFromUrl(url) {
      const roleName = decodeURIComponent(new URL(url).pathname.split('/').at(-2));
      return {
        async sendMessage(params) {
          const contextId = params.message.contextId;
          world.sends.push(contextId);
          const task = { id: `task-${contextId}`, contextId, role: roleName };
          world.tasks.set(contextId, task);
          return { task: view(task, false) };
        },
        async getTask({ id }) {
          const task = [...world.tasks.values()].find((entry) => entry.id === id);
          if (!task) throw Object.assign(new Error('Task not found'), { name: 'TaskNotFoundError' });
          const count = (world.polls.get(id) || 0) + 1;
          world.polls.set(id, count);
          world.getTaskFault?.(id, count);
          return view(task, count > world.pollsNeeded);
        },
        async cancelTask({ id }) {
          const task = [...world.tasks.values()].find((entry) => entry.id === id);
          return { ...view(task, false), status: { state: TaskState.TASK_STATE_CANCELED } };
        },
        async listTasks({ contextId }) {
          const task = world.tasks.get(contextId);
          return { tasks: task ? [view(task, false)] : [], nextPageToken: '', pageSize: 100, totalSize: 0 };
        },
      };
    },
  };
  return world;
}

// Owns the file database; restart() closes it, reopens it, and builds a fresh orchestrator.
class Session {
  constructor(world, filePath = newDbPath()) {
    this.world = world;
    this.filePath = filePath;
  }

  async open() {
    this.state = await openStateDatabase({ filePath: this.filePath });
    this.journal = new DispatchJournal(this.state);
    this.orchestrator = new LeadOrchestrator({
      appServer: this.world.appServer,
      roles: roles(),
      workspace: path.join(tmpRoot, 'workspace'),
      baseUrl: 'http://127.0.0.1:4040',
      clientFactory: this.world.clientFactory,
      pollIntervalMs: 0,
      checkpointer: this.state.checkpointer,
      journal: this.journal,
    });
    return this;
  }

  async restart() {
    await this.state.close();
    return this.open();
  }

  async close() {
    await this.state.close();
  }
}

async function withSession(world, fn) {
  const session = await new Session(world).open();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

const summarize = (result) => ({
  status: result.status,
  text: result.text,
  rounds: result.rounds,
  assignments: result.assignments.map((entry) => [entry.assignmentId, entry.status, entry.report?.summary ?? null]),
});

function assertAtMostOneSendPerContext(world) {
  const counts = new Map();
  for (const contextId of world.sends) counts.set(contextId, (counts.get(contextId) || 0) + 1);
  for (const [contextId, count] of counts) assert.ok(count <= 1, `contextId ${contextId} was sent ${count} times`);
}

const RUN_ID = 'run-1';

test('restart after each dispatch-path node boundary yields the same result with one send', async (t) => {
  const script = () => [dispatch(brief('orch-builder')), finish('Implemented')];
  const baselineWorld = makeWorld({ script: script() });
  const baseline = await withSession(baselineWorld, (s) => s.orchestrator.run({ goal: 'Build', runId: RUN_ID }));
  assert.equal(baseline.status, 'completed');
  assert.equal(baseline.assignments.length, 1);

  for (const node of ['intake', 'decide', 'dispatch', 'collect', 'verify']) {
    await t.test(node, async () => {
      const world = makeWorld({ script: script() });
      await withSession(world, async (session) => {
        const stopped = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: [node] });
        assert.equal(stopped.status, 'interrupted_for_test');
        await session.restart();
        const result = await session.orchestrator.resume({ runId: RUN_ID });
        assert.deepEqual(summarize(result), summarize(baseline));
        assert.equal(world.leadTurns, 2);
        assert.equal(world.sends.length, 1);
        assertAtMostOneSendPerContext(world);
        assert.equal(world.sends[0], deterministicContextId(attemptId(assignmentId(RUN_ID, 1, 0))));
        // A finished run returns its stored result, also after another restart.
        await session.restart();
        assert.deepEqual(summarize(await session.orchestrator.resume({ runId: RUN_ID })), summarize(baseline));
        assert.equal(world.leadTurns, 2);
      });
    });
  }
});

test('restart across the human_input boundary', async () => {
  const world = makeWorld({ script: [humanRequest(), finish('Went with A')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Choose', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'human_decision');
    assert.equal(paused.pause.decisionId, `${RUN_ID}:h1`);
    assert.match(paused.pause.message, /Which variant\?/);

    await session.restart();
    const pending = await session.orchestrator.getPause(RUN_ID);
    assert.equal(pending.kind, 'human_decision');
    assert.equal(pending.decisionId, `${RUN_ID}:h1`);

    await assert.rejects(session.orchestrator.resume({ runId: RUN_ID }), TypeError);
    await assert.rejects(session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'x', decisionId: 'other' } }), /does not match/);

    const stopped = await session.orchestrator.resume({
      runId: RUN_ID, input: { answer: 'Use variant A', choice: 'a', decisionId: `${RUN_ID}:h1` }, interruptAfter: ['human_input'],
    });
    assert.equal(stopped.status, 'interrupted_for_test');
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Went with A');
    assert.equal(world.leadTurns, 2);
    assert.match(world.prompts[1], /Use variant A/);
    assert.match(world.prompts[1], new RegExp(`${RUN_ID}:h1`));
    assert.equal(await session.orchestrator.getPause(RUN_ID), null);
  });
});

test('restart across the budget_pause boundary', async () => {
  const world = makeWorld({ script: [usageLimitError(), finish('Recovered')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    await session.restart();
    const stopped = await session.orchestrator.resume({ runId: RUN_ID, interruptAfter: ['budget_pause'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Recovered');
    assert.equal(world.leadTurns, 2);
  });
});

test('usage limit on the lead turn pauses for budget and resumes', async () => {
  const world = makeWorld({ script: [usageLimitError(), finish('Done after budget')] });
  const events = [];
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID, onEvent: (event) => events.push(event) });
    assert.equal(paused.status, 'waiting_for_budget');
    assert.equal(paused.pause.kind, 'waiting_for_budget');
    assert.equal(paused.pause.source, 'lead');
    assert.ok(paused.pause.message);
    assert.equal(paused.text, paused.pause.message);
    assert.equal(events.at(-1).type, 'pause');
    assert.deepEqual(await session.orchestrator.getPause(RUN_ID), paused.pause);

    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { note: 'budget is back' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Done after budget');
    assert.match(world.prompts[1], /resumed after an interruption/);
    assert.equal(await session.orchestrator.getPause(RUN_ID), null);
  });
});

test('usage limit on a worker turn pauses for budget and the lead sees it', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Handled')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_FAILED,
      message: { messageId: 'm', role: 2, parts: textParts('usage limit reached'), metadata: { failureKind: 'usage_limit' } },
    }),
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    assert.equal(paused.pause.source, 'worker');
    assert.equal(paused.assignments[0].failureKind, 'usage_limit');
    assert.equal(world.leadTurns, 1);
    assert.deepEqual(await session.orchestrator.getPause(RUN_ID), paused.pause);

    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[1], /usage_limit/);
    assert.equal(world.sends.length, 1);
  });
});

test('a delayed A2A result is collected after a restart and never re-sent', async () => {
  let crash = true;
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Collected')],
    pollsNeeded: 5,
    getTaskFault: (id, count) => {
      if (crash && count === 3) {
        crash = false;
        throw new Error('connection lost');
      }
    },
  });
  await withSession(world, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'Build', runId: RUN_ID }), /connection lost/);
    assert.equal(world.sends.length, 1);
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].report.summary, 'orch-builder done');
    assert.equal(world.sends.length, 1);
    assertAtMostOneSendPerContext(world);
    assert.ok([...world.polls.values()][0] > 5);
  });
});

test('an uncertain writable submission becomes outcome_unknown and is not re-sent', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Reviewed')] });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['decide'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    session.journal.recordSubmitting({
      attemptId: id, runId: RUN_ID, assignmentId: assignmentId(RUN_ID, 1, 0), role: 'orch-builder', sandbox: 'workspace-write', contextId: deterministicContextId(id),
    });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].status, 'outcome_unknown');
    assert.equal(world.sends.length, 0);
    assert.match(world.prompts[1], /outcome_unknown/);
    assert.equal(session.journal.get(id).state, 'finished');
  });
});

test('an uncertain read-only submission is re-sent once with the same context', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Explored')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID, interruptAfter: ['decide'] });
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    const contextId = deterministicContextId(id);
    session.journal.recordSubmitting({
      attemptId: id, runId: RUN_ID, assignmentId: assignmentId(RUN_ID, 1, 0), role: 'orch-explorer', sandbox: 'read-only', contextId,
    });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.sends, [contextId]);
    assert.equal(result.assignments[0].report.summary, 'orch-explorer done');
  });
});

test('a submitting row whose task exists on the server is adopted, not re-sent', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Adopted')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['decide'] });
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    const contextId = deterministicContextId(id);
    session.journal.recordSubmitting({
      attemptId: id, runId: RUN_ID, assignmentId: assignmentId(RUN_ID, 1, 0), role: 'orch-builder', sandbox: 'workspace-write', contextId,
    });
    world.tasks.set(contextId, { id: 'existing-task', contextId, role: 'orch-builder' });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 0);
    assert.equal(result.assignments[0].taskId, 'existing-task');
  });
});

test('worker needs_decision must be resolved by the lead', async () => {
  const workerFinal = () => ({
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{ name: 'report', parts: textParts(needsDecisionReport()) }],
  });
  const attempt = attemptId(assignmentId(RUN_ID, 1, 0));

  const unresolved = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Ignored it')], workerFinal });
  await withSession(unresolved, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'Explore', runId: RUN_ID }), /must be resolved/);
    assert.match(unresolved.prompts[1], new RegExp(attempt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(unresolved.prompts[1], /Keep the API\?/);
  });

  const resolved = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Resolved', [{ decisionId: attempt, choice: 'keep', rationale: 'Evidence in src/api.js' }])],
    workerFinal,
  });
  await withSession(resolved, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].report.outcome, 'needs_decision');
  });
});

test('a human answer closes the related worker decisions', async () => {
  const workerFinal = () => ({
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{ name: 'report', parts: textParts(needsDecisionReport()) }],
  });
  const attempt = attemptId(assignmentId(RUN_ID, 1, 0));
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), humanRequest([attempt]), finish('Done')], workerFinal });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.decisionId, `${RUN_ID}:h1`);
    assert.deepEqual(paused.pause.relatedDecisionIds, [attempt]);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Keep it', choice: 'a', decisionId: `${RUN_ID}:h1` } });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[1], /Keep the API\?/);
    assert.match(world.prompts[2], /Keep it/);
    assert.match(world.prompts[2], /Open worker decisions[^\n]*\n\[\]/);
  });
});

test('reports scope violations and a bad worker report to the lead', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Noted')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('Changed things', { filesChanged: ['src/example.js', 'src/other.js'] })) }],
    }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.deepEqual(result.assignments[0].scopeViolations, ['src/other.js']);
    assert.equal(Object.hasOwn(result.assignments[0], 'text'), false);
  });

  const bad = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Noted')],
    workerFinal: () => ({ state: TaskState.TASK_STATE_COMPLETED, artifacts: [{ name: 'r', parts: textParts('plain text') }] }),
  });
  await withSession(bad, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.match(result.assignments[0].reportError, /not valid JSON/);
    assert.equal(result.assignments[0].text, 'plain text');
  });
});

test('run rejects an existing checkpoint and resume rejects an unknown run', async () => {
  const world = makeWorld({ script: [finish('One'), finish('Two')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Go', runId: RUN_ID });
    await assert.rejects(session.orchestrator.run({ goal: 'Go', runId: RUN_ID }), /checkpoint already exists/);
    await assert.rejects(session.orchestrator.resume({ runId: 'missing' }), RunNotFoundError);
    assert.equal(await session.orchestrator.getPause('missing'), null);
  });
});

function failingSubmitWorld(script) {
  const world = makeWorld({ script });
  const base = world.clientFactory;
  world.clientFactory = {
    async createFromUrl(url) {
      const client = await base.createFromUrl(url);
      return {
        ...client,
        async sendMessage() { throw new Error('send failed'); },
        async listTasks() { throw new Error('lookup failed'); },
      };
    },
  };
  return world;
}

test('a failed submit whose reconcile lookup also fails is outcome_unknown for writers and dispatch_error for readers', async () => {
  const writer = failingSubmitWorld([dispatch(brief('orch-builder')), finish('Done')]);
  await withSession(writer, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].status, 'outcome_unknown');
    assert.match(result.assignments[0].text, /workspace effects are unknown/);
  });
  const reader = failingSubmitWorld([dispatch(brief('orch-explorer', [])), finish('Done')]);
  await withSession(reader, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.assignments[0].status, 'dispatch_error');
  });
  const prompt = writer.prompts[1];
  assert.match(prompt, /dispatch_error means the submission failed and no A2A task was found for it/);
});

test('an AbortError from the submitting-path task lookup does not reject dispatch', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Explored')] });
  const base = world.clientFactory;
  let lookups = 0;
  world.clientFactory = {
    async createFromUrl(url) {
      const client = await base.createFromUrl(url);
      return {
        ...client,
        async listTasks(params) {
          lookups += 1;
          if (lookups === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          return client.listTasks(params);
        },
      };
    },
  };
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID, interruptAfter: ['decide'] });
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    const contextId = deterministicContextId(id);
    session.journal.recordSubmitting({
      attemptId: id, runId: RUN_ID, assignmentId: assignmentId(RUN_ID, 1, 0), role: 'orch-explorer', sandbox: 'read-only', contextId,
    });
    world.tasks.set(contextId, { id: 'existing-task', contextId, role: 'orch-explorer' });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].taskId, 'existing-task');
    assert.ok(lookups >= 2);
  });
});

test('a crashed run is resumable and resume re-invokes from the checkpoint', async () => {
  const world = makeWorld({ script: [new Error('lead crashed'), finish('Recovered')] });
  await withSession(world, async (session) => {
    assert.equal(await session.orchestrator.isResumable(RUN_ID), false);
    await assert.rejects(session.orchestrator.run({ goal: 'Go', runId: RUN_ID }), /lead crashed/);
    assert.equal(await session.orchestrator.isResumable(RUN_ID), true);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(result.status, 'completed');
    assert.equal(await session.orchestrator.isResumable(RUN_ID), false);
  });
});
