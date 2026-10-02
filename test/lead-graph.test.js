'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator, RunNotFoundError } = require('../src/lead-orchestrator');
const { execFileSync } = require('node:child_process');
const { UsageLedger } = require('../src/usage-ledger');
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

const releasedWriter = (changedPaths = []) => ({
  executionId: 'exec-released', state: 'released', delta: { known: true, headChanged: false, changedPaths }, reason: null,
});

// In-memory stand-in for WriterAdmission: rows by context id, scripted quiescence.
function makeFakeAdmission() {
  const admission = {
    rows: new Map(),
    fences: [],
    reconciles: [],
    canProve: true,
    fenceRace: null,
    acquired: [],
    released: [],
    turnStarts: [],
    async acquire(args) { this.acquired.push(args); return { executionId: `${args.role}:${args.taskId}` }; },
    release(executionId) { this.released.push(executionId); },
    recordTurnStart(executionId, details) { this.turnStarts.push({ executionId, ...details }); },
    findByContextId(contextId) { return this.rows.get(contextId) || null; },
    get(executionId) { return [...this.rows.values()].find((row) => row.executionId === executionId) || null; },
    fence(contextId, reason) {
      this.fences.push({ contextId, reason });
      if (this.fenceRace && !this.rows.has(contextId)) this.rows.set(contextId, this.fenceRace(contextId));
      return { execution: this.rows.get(contextId) || null };
    },
    async reconcile(executionId) {
      this.reconciles.push(executionId);
      const row = this.get(executionId);
      if (row.state === 'unresolved' && this.canProve) {
        row.state = 'reconciled';
        row.delta = { known: true, headChanged: false, changedPaths: ['src/example.js'] };
        row.reason = null;
      }
      return row.state === 'unresolved' ? { state: 'unresolved', reason: 'quiescence_unproven' } : { state: row.state, delta: row.delta };
    },
  };
  return admission;
}
const admissionRow = (contextId, state, extra = {}) => ({
  executionId: `exec-${contextId}`, contextId, state, delta: null, reason: null, ...extra,
});

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
      artifacts: [{ name: 'report', parts: textParts(report(`${roleName} done`)), metadata: { writerExecution: releasedWriter() } }],
    })),
    admission: makeFakeAdmission(),
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
      const extras = world.leadExtras ? world.leadExtras(world.leadTurns) : {};
      if (typeof next === 'function') return { threadId: 'lead-thread', status: 'completed', text: await next(args), ...extras };
      if (next instanceof Error) throw next;
      return { threadId: 'lead-thread', status: 'completed', text: next, ...extras };
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
  constructor(world, filePath = newDbPath(), options = {}) {
    this.world = world;
    this.filePath = filePath;
    this.options = options;
  }

  async open() {
    this.state = await openStateDatabase({ filePath: this.filePath });
    this.journal = new DispatchJournal(this.state);
    this.orchestrator = new LeadOrchestrator({
      appServer: this.world.appServer,
      roles: roles(),
      workspace: this.options.workspace || path.join(tmpRoot, 'workspace'),
      baseUrl: 'http://127.0.0.1:4040',
      clientFactory: this.world.clientFactory,
      pollIntervalMs: 0,
      checkpointer: this.state.checkpointer,
      journal: this.journal,
      admission: this.world.admission,
      reconcileWaitMs: 20,
      ...(this.options.withLedger ? { usageLedger: new UsageLedger({ db: this.state.db }) } : {}),
      ...(this.options.orchestrator || {}),
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

async function withSession(world, fn, options) {
  const session = await new Session(world, newDbPath(), options).open();
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

  const unresolved = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Ignored it'), finish('Ignored it')], workerFinal });
  await withSession(unresolved, async (session) => {
    const rejected = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(rejected.status, 'plan_violation');
    assert.match(rejected.text, /must be resolved/);
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

test('a resolution for a decision the human already closed is ignored', async () => {
  const workerFinal = () => ({
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{ name: 'report', parts: textParts(needsDecisionReport()) }],
  });
  const attempt = attemptId(assignmentId(RUN_ID, 1, 0));
  const stale = [{ decisionId: attempt, choice: 'keep', rationale: 'Already answered' }];
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), humanRequest([attempt]), finish('Done', stale)], workerFinal });
  await withSession(world, async (session) => {
    const events = [];
    const paused = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID, onEvent: (event) => events.push(event) });
    assert.equal(paused.status, 'input_required');
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Keep it', choice: 'a', decisionId: `${RUN_ID}:h1` }, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 3);
    assert.deepEqual(events.filter((event) => event.type === 'resolution_ignored').map((event) => event.decisionIds), [[attempt]]);
    assert.equal(events.some((event) => event.type === 'decision_rejected'), false);
  });
});

test('an invalid lead decision is discarded with an error note and the run continues', async () => {
  const bad = decision({ action: 'request_human_input', final: 'oops' });
  const world = makeWorld({ script: [bad, finish('Fixed')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 2);
    assert.match(world.prompts[1], /Your previous decision was rejected: .*must leave final empty/);
  });
});

test('two consecutive invalid lead decisions end the run as plan_violation and a valid one resets the counter', async () => {
  const bad = () => decision({ action: 'request_human_input', final: 'oops' });
  const ended = makeWorld({ script: [bad(), bad(), finish('never')] });
  await withSession(ended, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID });
    assert.equal(result.status, 'plan_violation');
    assert.equal(ended.leadTurns, 2);
    assert.match(result.text, /2 consecutive invalid decisions/);
  });

  const reset = makeWorld({ script: [bad(), dispatch(brief('orch-explorer', [])), bad(), finish('ok')] });
  await withSession(reset, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(reset.leadTurns, 4);
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
  assert.match(prompt, /For a read-only role, dispatch_error means the submission could not be matched to a task at lookup time/);
  assert.match(prompt, /reconciles every writable outcome whose effects were unknown/);
});

function uncertainSubmitWorld(script, sendResponse = null) {
  const world = makeWorld({ script });
  const base = world.clientFactory;
  world.clientFactory = {
    async createFromUrl(url) {
      const client = await base.createFromUrl(url);
      return {
        ...client,
        async sendMessage(params) {
          world.sends.push(params.message.contextId);
          if (sendResponse) return sendResponse;
          throw new Error('connection closed after submit');
        },
        async listTasks() {
          return { tasks: [], nextPageToken: '', pageSize: 100, totalSize: 0 };
        },
      };
    },
  };
  return world;
}

test('a failed writable submit with a successful empty lookup is unknown and stays unsent after restart', async () => {
  const world = uncertainSubmitWorld([dispatch(brief('orch-builder')), new Error('lead crashed after collection'), finish('Reviewed')]);
  await withSession(world, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'Build', runId: RUN_ID }), /lead crashed after collection/);
    assert.equal(world.sends.length, 1);
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].status, 'outcome_unknown');
    assert.equal(world.sends.length, 1);
    assert.match(world.prompts[2], /outcome_unknown/);
  });
});

test('a failed read-only submit with a successful empty lookup remains dispatch_error', async () => {
  const world = uncertainSubmitWorld([dispatch(brief('orch-explorer', [])), finish('Reviewed')]);
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.assignments[0].status, 'dispatch_error');
    assert.equal(world.sends.length, 1);
  });
});

test('a writable submit response without a task ID is outcome_unknown', async () => {
  const world = uncertainSubmitWorld([dispatch(brief('orch-builder')), finish('Reviewed')], {});
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.assignments[0].status, 'outcome_unknown');
    assert.match(result.assignments[0].text, /returned no task ID/);
    assert.equal(world.sends.length, 1);
  });
});

test('a writable submit message without a task ID is not treated as a completed report', async () => {
  const world = uncertainSubmitWorld([dispatch(brief('orch-builder')), finish('Reviewed')], {
    message: { parts: textParts(report('Worker claims completion')) },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.assignments[0].status, 'outcome_unknown');
    assert.equal(result.assignments[0].report, null);
    assert.equal(world.sends.length, 1);
  });
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

// ------------------------------------------------ writer reconciliation

const unresolvedWriterTask = (roleName) => ({
  state: TaskState.TASK_STATE_FAILED,
  message: {
    messageId: 'm',
    role: 2,
    parts: textParts('turn timed out'),
    metadata: {
      failureKind: 'interrupted',
      writerExecution: { executionId: `exec-${roleName}`, state: 'unresolved', delta: null, reason: 'outcome_unknown' },
    },
  },
});

test('a timed-out writer is reconciled by the server before the lead decides, then a writer dispatch proceeds', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      if (world.sends.length === 1) {
        world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
        return unresolvedWriterTask(roleName);
      }
      return { state: TaskState.TASK_STATE_COMPLETED, artifacts: [{ name: 'report', parts: textParts(report('second')), metadata: { writerExecution: releasedWriter() } }] };
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.admission.reconciles.length, 1);
    assert.equal(world.sends.length, 2);
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.state, 'reconciled');
    assert.deepEqual(reconciliation.changedPaths, ['src/example.js']);
    assert.equal(reconciliation.deltaKnown, true);
    assert.match(world.prompts[1], /"kind":"reconciliation"/);
    assert.match(world.prompts[1], /src\/example\.js/);
    assert.equal(result.assignments.filter((entry) => entry.kind === 'reconciliation').length, 1);
  });
});

test('a lost submission response is fenced and resolved as never_executed with zero sends', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Reviewed')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['decide'] });
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    const contextId = deterministicContextId(id);
    session.journal.recordSubmitting({
      attemptId: id, runId: RUN_ID, assignmentId: assignmentId(RUN_ID, 1, 0), role: 'orch-builder', sandbox: 'workspace-write', contextId,
    });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 0);
    assert.deepEqual(world.admission.fences, [{ contextId, reason: 'lead_reconcile' }]);
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.state, 'never_executed');
    assert.deepEqual(reconciliation.changedPaths, []);
    assert.match(world.prompts[1], /never_executed/);
  });
});

test('a fence that finds an execution row reconciles it instead of declaring never_executed', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Reviewed')] });
  world.admission.fenceRace = (contextId) => admissionRow(contextId, 'unresolved');
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['decide'] });
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    session.journal.recordSubmitting({
      attemptId: id, runId: RUN_ID, assignmentId: assignmentId(RUN_ID, 1, 0), role: 'orch-builder', sandbox: 'workspace-write', contextId: deterministicContextId(id),
    });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.admission.fences.length, 1);
    assert.equal(world.admission.reconciles.length, 1);
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.state, 'reconciled');
    assert.deepEqual(reconciliation.changedPaths, ['src/example.js']);
  });
});

test('unresolvedWriters survive a restart after verify and reconcile runs on resume', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['verify'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    assert.equal(world.admission.reconciles.length, 0);
    await session.restart();
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(snapshot.values.unresolvedWriters.length, 1);
    assert.equal(snapshot.values.unresolvedWriters[0].role, 'orch-builder');
    assert.deepEqual(snapshot.next, ['reconcile']);
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.admission.reconciles.length, 1);
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 1);
  });
});

test('unproven quiescence pauses with writer_unresolved, pauses again on resume, and continues once proven', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  world.admission.canProve = false;
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'writer_unresolved');
    assert.equal(paused.pause.attempts[0].role, 'orch-builder');
    assert.equal(paused.pause.attempts[0].reason, 'quiescence_unproven');
    assert.match(paused.text, /proven stopped/);
    assert.equal(world.leadTurns, 1);
    assert.equal((await session.orchestrator.getPause(RUN_ID)).kind, 'writer_unresolved');
    assert.equal(await session.orchestrator.isResumable(RUN_ID), true);

    const again = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(again.status, 'input_required');
    assert.equal(again.pause.kind, 'writer_unresolved');
    assert.equal(world.leadTurns, 1);

    await session.restart();
    world.admission.canProve = true;
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 2);
    assert.equal(result.assignments.filter((entry) => entry.kind === 'reconciliation').length, 1);
  });
});

test('without an admission the run pauses honestly instead of assuming the writer stopped', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName) => unresolvedWriterTask(roleName),
  });
  world.admission = undefined;
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'writer_unresolved');
    assert.equal(paused.pause.attempts[0].reason, 'no_admission');
  });
});

test('reconcile precedes decide and a scripted lead cannot dispatch a writer while writers are unresolved', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  world.admission.canProve = false;
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.kind, 'writer_unresolved');
    // The second (writer) dispatch is never requested from the lead, and nothing else is sent.
    assert.equal(world.leadTurns, 1);
    assert.equal(world.sends.length, 1);
  });
});

test('read-only interrupted outcomes do not trigger reconcile', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Done')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_FAILED,
      message: { messageId: 'm', role: 2, parts: textParts('timed out'), metadata: { failureKind: 'interrupted' } },
    }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.admission.reconciles.length, 0);
    assert.equal(world.admission.fences.length, 0);
    assert.equal(result.assignments.some((entry) => entry.kind === 'reconciliation'), false);
  });
});

test('attested changed paths outside allowedFiles are reported as attestedScopeViolations', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('done')), metadata: { writerExecution: releasedWriter(['src/example.js', 'lib/other.js']) } }],
    }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.deepEqual(result.assignments[0].attestedScopeViolations, ['lib/other.js']);
    assert.equal(result.assignments[0].attestedDeltaKnown, true);
    assert.equal(result.assignments[0].writerExecution.state, 'released');
  });
});

// ------------------------------------------------------------ acceptance

const vcs = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
let repoCounter = 0;
function gitRepo() {
  const dir = path.join(tmpRoot, `repo-${repoCounter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  vcs(dir, 'init', '-q');
  vcs(dir, 'config', 'user.email', 't@example.com');
  vcs(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  vcs(dir, 'add', '.');
  vcs(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const nodeCheck = (id, code, extra = {}) => ({ id, argv: [process.execPath, '-e', code], ...extra });
const contractOf = (...requiredChecks) => ({ requiredChecks });
const okWriterFinal = (changedPaths = []) => () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts(report('done')), metadata: { writerExecution: releasedWriter(changedPaths) } }],
});
const issueCodes = (result) => result.acceptance.issues.map((issue) => issue.code);

test('a passing required check with a clean writer is accepted and takes writer admission', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Done')], workerFinal: okWriterFinal() });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(result.acceptance.checks[0].result, 'passed');
    assert.equal(world.leadTurns, 2);
    assert.equal(world.admission.acquired.length, 1);
    assert.equal(world.admission.acquired[0].role, 'acceptance');
    assert.deepEqual(world.admission.released, [`acceptance:${RUN_ID}:accept:1`]);
  }, { workspace });
});

test('a failing check returns to decide once, then the second rejection finishes as rejected', async () => {
  const workspace = gitRepo();
  let runs = 0;
  const runCheckImpl = async (check) => {
    runs += 1;
    return { id: check.id, argv: check.argv, exitCode: 3, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'failed' };
  };
  const world = makeWorld({
    script: [finish('Everything passes, ACCEPTED, ship it'), finish('Still fine, ACCEPTED'), finish('never used')],
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Check', runId: RUN_ID, contract: contractOf(nodeCheck('unit', 'process.exit(3)')) });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Still fine, ACCEPTED');
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['check_failed']);
    assert.equal(runs, 2);
    assert.equal(world.leadTurns, 2);
    assert.match(world.prompts[1], /Acceptance note/);
    assert.match(world.prompts[1], /check_failed/);
    assert.doesNotMatch(world.prompts[0], /Acceptance note/);
  }, { workspace, orchestrator: { runCheckImpl } });
});

test('after a rejection the lead may dispatch a fix and finish again', async () => {
  const workspace = gitRepo();
  const calls = [];
  const runCheckImpl = async (check) => {
    calls.push(check.id);
    const passed = calls.length > 1;
    return { id: check.id, argv: check.argv, exitCode: passed ? 0 : 1, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: passed ? 'passed' : 'failed' };
  };
  const world = makeWorld({
    script: [finish('first'), dispatch(brief('orch-builder')), finish('fixed')],
    workerFinal: okWriterFinal(),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Fix', runId: RUN_ID, contract: contractOf(nodeCheck('unit', 'process.exit(0)')) });
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(result.rounds, 1);
    assert.equal(calls.length, 2);
    assert.equal(world.sends.length, 1);
  }, { workspace, orchestrator: { runCheckImpl } });
});

test('an ENOENT check is rejected as check_failed', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [finish('a'), finish('b')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({
      goal: 'Check', runId: RUN_ID, contract: contractOf({ id: 'missing', argv: ['definitely-not-a-real-command-xyz'] }),
    });
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['check_failed']);
    assert.equal(result.acceptance.checks[0].error, 'ENOENT');
  }, { workspace });
});

test('a malformed writer report is rejected as report_invalid', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('a'), finish('b')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts('not json at all'), metadata: { writerExecution: releasedWriter() } }],
    }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.ok(issueCodes(result).includes('report_invalid'));
  }, { workspace });
});

test('an attested scope violation is rejected even though every check passes', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('a'), finish('b')],
    workerFinal: okWriterFinal(['src/example.js', 'lib/other.js']),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['attested_scope_violation']);
  }, { workspace });
});

test('a check that mutates the workspace is rejected as candidate_changed', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [finish('a'), finish('b')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({
      goal: 'Check', runId: RUN_ID, contract: contractOf(nodeCheck('mutator', "require('fs').appendFileSync('a.txt', String(Date.now()))")),
    });
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['candidate_changed']);
  }, { workspace });
});

test('a reconciled writer whose changedPaths leave allowedFiles is an attested_scope_violation', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['docs/x.md'])), finish('a'), finish('b')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.deepEqual(reconciliation.attestedScopeViolations, ['src/example.js']);
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['attested_scope_violation']);
  }, { workspace });
});

test('a plain read-only run is not_required and a writer run without a contract is unverified', async () => {
  const readOnly = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Looked')] });
  await withSession(readOnly, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Looked');
    assert.equal(result.acceptance.disposition, 'not_required');
    assert.deepEqual(result.acceptance.checks, []);
    assert.equal(readOnly.admission.acquired.length, 0);
  }, { workspace: gitRepo() });

  const writer = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Built')], workerFinal: okWriterFinal(['src/example.js']) });
  await withSession(writer, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'unverified');
    assert.deepEqual(result.acceptance.issues, []);
    assert.equal(writer.admission.acquired.length, 0);
    assert.equal(writer.leadTurns, 2);
  }, { workspace: gitRepo() });
});

test('canceled, max_rounds and failed finishes skip acceptance and still carry a record', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), dispatch(brief('orch-explorer', []))] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(result.status, 'max_rounds');
    assert.equal(result.acceptance.disposition, 'unverifiable');
    assert.deepEqual(issueCodes(result), ['acceptance_not_run']);
    assert.equal(world.admission.acquired.length, 0);
  }, { workspace: gitRepo(), orchestrator: { maxRounds: 1 } });
});

test('finish decision restart: accept runs once, the contract survives, and resume input cannot change it', async () => {
  const workspace = gitRepo();
  let runs = 0;
  const runCheckImpl = async (check) => {
    runs += 1;
    return { id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' };
  };
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const contract = contractOf(nodeCheck('pinned', 'process.exit(0)'));
    const stopped = await session.orchestrator.run({ goal: 'Check', runId: RUN_ID, contract, interruptAfter: ['decide'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    assert.equal(runs, 0);
    await session.restart();
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(snapshot.next, ['accept']);
    assert.equal(snapshot.values.contract.requiredChecks[0].id, 'pinned');
    const result = await session.orchestrator.resume({
      runId: RUN_ID, input: { acceptance: { requiredChecks: [{ id: 'other', argv: ['false'] }] } }, contract: contractOf(),
    });
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.deepEqual(result.acceptance.requiredCheckIds, ['pinned']);
    assert.equal(runs, 1);
    assert.equal(world.leadTurns, 1);
    await session.restart();
    assert.equal((await session.orchestrator.resume({ runId: RUN_ID })).acceptance.disposition, 'accepted');
    assert.equal(runs, 1);
  }, { workspace, orchestrator: { runCheckImpl } });
});

test('an invalid contract is rejected before any run starts', async () => {
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'x', runId: RUN_ID, contract: { requiredChecks: [{ id: 'a', argv: [] }] } }), TypeError);
    assert.equal(world.leadTurns, 0);
  });
});

test('each check process identity is recorded on the acceptance admission for crash quiescence', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({
      goal: 'Check', runId: RUN_ID, contract: contractOf(nodeCheck('one', 'process.exit(0)'), nodeCheck('two', 'process.exit(0)')),
    });
    assert.equal(result.acceptance.disposition, 'accepted');
    const real = world.admission.turnStarts.filter((start) => start.processIdentity);
    assert.equal(world.admission.turnStarts.length, 4);
    for (const start of real) {
      assert.equal(start.executionId, `acceptance:${RUN_ID}:accept:1`);
      assert.equal(start.threadId, null);
      assert.ok(Number.isInteger(start.processIdentity.pid));
      assert.equal(start.processIdentity.pgid, start.processIdentity.pid);
    }
    assert.notEqual(real[0].processIdentity.pid, real[1].processIdentity.pid);
  }, { workspace });
});

// ------------------------------------------------------------- lead usage

test('one lead_turn ledger row per lead turn, not duplicated across a resume', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Done')] });
  world.leadExtras = (n) => ({
    turnId: `turn-${n}`,
    usage: {
      model: 'gpt-lead', effort: 'high', startedAt: `2026-01-01T00:00:0${n}Z`, elapsedMs: 10, turns: 1, modelRequests: null,
      tokens: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 3 }, tokenSource: 'total_delta',
      cumulativeTotal: null, appServerVersion: '1',
    },
  });
  await withSession(world, async (session) => {
    let ledger = new UsageLedger({ db: session.state.db });
    const stopped = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID, interruptAfter: ['decide'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    assert.equal(ledger.listByRun(RUN_ID).length, 1);
    await session.restart();
    ledger = new UsageLedger({ db: session.state.db });
    await session.orchestrator.resume({ runId: RUN_ID });
    const rows = ledger.listByRun(RUN_ID).filter((row) => row.kind === 'lead_turn');
    assert.equal(world.leadTurns, 2);
    assert.deepEqual(rows.map((row) => row.entryId), ['lead:lead-thread:turn-1', 'lead:lead-thread:turn-2']);
    assert.equal(rows[0].runId, RUN_ID);
    assert.equal(rows[0].role, 'orch-lead');
    assert.equal(rows[0].model, 'gpt-lead');
    assert.equal(rows[0].tokens.totalTokens, 3);
    assert.equal(rows[0].outcome, 'completed');
    // Re-recording the same turn is ignored.
    assert.equal(ledger.record({ ...rows[0], kind: 'lead_turn' }), false);
  }, { withLedger: true });
});

test('a lead turn that throws with usage is recorded and a ledger failure never breaks the run', async () => {
  const failing = Object.assign(new Error('boom'), { usage: { model: 'gpt-lead', startedAt: 's1' }, execution: { threadId: 'th', turnId: 'tx' } });
  const world = makeWorld({ script: [failing] });
  await withSession(world, async (session) => {
    const ledger = new UsageLedger({ db: session.state.db });
    await assert.rejects(session.orchestrator.run({ goal: 'Look', runId: RUN_ID }), /boom/);
    const [row] = ledger.listByRun(RUN_ID);
    assert.equal(row.entryId, 'lead:th:tx');
    assert.equal(row.outcome, 'error');
    assert.equal(row.tokens, null);
  }, { withLedger: true });

  const healthy = makeWorld({ script: [finish('Done')] });
  const broken = { record() { throw new Error('ledger down'); } };
  await withSession(healthy, async (session) => {
    assert.equal((await session.orchestrator.run({ goal: 'Look', runId: RUN_ID })).status, 'completed');
  }, { orchestrator: { usageLedger: broken } });
});

// ----------------------------------------------------- serial batch gap

test('an unsettled writer in a serial batch skips the remaining writers and reconcile runs', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/a.js']), brief('orch-builder', ['src/b.js'])), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 1);
    const first = result.assignments.find((entry) => entry.assignmentId === assignmentId(RUN_ID, 1, 0));
    const second = result.assignments.find((entry) => entry.assignmentId === assignmentId(RUN_ID, 1, 1) && entry.kind !== 'reconciliation');
    assert.equal(first.status, 'TASK_STATE_FAILED');
    assert.equal(second.status, 'skipped_unresolved_writer');
    assert.equal(second.effects, 'none');
    assert.match(second.text, /unresolved outcome/);
    assert.equal(world.admission.reconciles.length, 1);
    const reconciled = result.assignments.filter((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].assignmentId, assignmentId(RUN_ID, 1, 0));
    assert.equal(session.journal.get(attemptId(assignmentId(RUN_ID, 1, 1))).state, 'finished');
    assert.match(world.prompts[1], /skipped_unresolved_writer/);
  });
});

test('a settled first writer lets the second writer of a serial batch run', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/a.js']), brief('orch-builder', ['src/b.js'])), finish('Done')],
    workerFinal: okWriterFinal(),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(world.sends.length, 2);
    assert.equal(result.assignments.some((entry) => entry.status === 'skipped_unresolved_writer'), false);
  });
});

test('reconciliation entries keep allowedFiles and the journal records the objective hash', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['docs/x.md'])), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['verify'] });
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(snapshot.values.unresolvedWriters[0].allowedFiles, ['docs/x.md']);
    const expected = require('node:crypto').createHash('sha256').update('Complete a bounded task', 'utf8').digest('hex');
    assert.equal(session.journal.get(attemptId(assignmentId(RUN_ID, 1, 0))).objectiveSha256, expected);
  });
});

test('a finished writer outcome without an execution row but with a task is legacy_unverified, not never_executed', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_FAILED,
      message: { messageId: 'm', role: 2, parts: textParts('old checkpoint'), metadata: { failureKind: 'interrupted' } },
    }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.state, 'legacy_unverified');
    assert.equal(reconciliation.deltaKnown, false);
    assert.deepEqual(reconciliation.changedPaths, []);
    assert.equal(reconciliation.reason, 'no_execution_record');
  });
});

// ----------------------------------------------------- operator control

const holdControl = (initial = null) => {
  const control = { value: initial };
  control.fn = (runId) => (runId === RUN_ID ? control.value : null);
  return control;
};

test('operator pause before decide parks without a lead turn, and resume continues the same plan', async () => {
  const control = holdControl('pause');
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Done')], workerFinal: okWriterFinal() });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'operator_pause');
    assert.match(paused.text, /Paused by the operator/);
    assert.equal(world.leadTurns, 0);
    assert.equal(world.sends.length, 0);
    assert.equal((await session.orchestrator.getPause(RUN_ID)).kind, 'operator_pause');

    control.value = null;
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'go' } });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 1);
  }, { orchestrator: { operatorControl: control.fn } });
});

test('resuming while operator pause remains set parks again without a lead turn', async () => {
  const control = holdControl('pause');
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const first = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(first.status, 'input_required');

    const stillPaused = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'go' } });
    assert.equal(stillPaused.status, 'input_required');
    assert.equal(stillPaused.pause.kind, 'operator_pause');
    assert.equal(world.leadTurns, 0);
    assert.equal(world.sends.length, 0);

    control.value = null;
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'go' } });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 1);
  }, { orchestrator: { operatorControl: control.fn } });
});

test('operator stop arriving during a finish decision cancels before acceptance', async () => {
  const control = holdControl(null);
  const world = makeWorld({ script: [finish('Done')] });
  world.leadExtras = () => {
    control.value = 'stop';
    return {};
  };
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'canceled');
    assert.equal(result.reason, 'operator_stop');
    assert.notEqual(result.acceptance?.disposition, 'accepted');
    assert.equal(world.leadTurns, 1);
  }, { orchestrator: { operatorControl: control.fn } });
});

test('operator control lookup failures park the run fail-closed', async () => {
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'input_required');
    assert.equal(result.pause.kind, 'operator_pause');
    assert.equal(world.leadTurns, 0);
    assert.equal(world.sends.length, 0);
  }, { orchestrator: { operatorControl: () => { throw new Error('control store unavailable'); } } });
});

test('operator pause while a worker runs lets it finish, dispatches nothing new, then parks', async () => {
  const control = holdControl(null);
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), dispatch(brief('orch-builder', ['src/b.js'])), finish('Done')],
    workerFinal: okWriterFinal(),
    pollsNeeded: 1,
    getTaskFault: (id, count) => { if (count === 1 && world.sends.length === 1) control.value = 'pause'; },
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.kind, 'operator_pause');
    assert.equal(world.leadTurns, 1);
    assert.equal(world.sends.length, 1);
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(snapshot.values.outcomes.length, 1);
    assert.equal(snapshot.values.outcomes[0].status, 'TASK_STATE_COMPLETED');

    control.value = null;
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'go' } });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 2);
    assert.equal(world.leadTurns, 3);
  }, { orchestrator: { operatorControl: control.fn } });
});

test('operator stop while parked at operator_pause finishes canceled with reason operator_stop', async () => {
  const control = holdControl('pause');
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.kind, 'operator_pause');
    control.value = 'stop';
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'go' } });
    assert.equal(result.status, 'canceled');
    assert.equal(result.reason, 'operator_stop');
    assert.equal(world.leadTurns, 0);
    assert.notEqual(result.acceptance?.disposition, 'accepted');
  }, { orchestrator: { operatorControl: control.fn } });
});

test('operator stop at a writer_unresolved resume reconciles first and then stops', async () => {
  const control = holdControl(null);
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  world.admission.canProve = false;
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.kind, 'writer_unresolved');
    control.value = 'stop';
    // Still unproven: the stop cannot take effect while the writer outcome is unknown.
    const still = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(still.pause.kind, 'writer_unresolved');

    world.admission.canProve = true;
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(result.status, 'canceled');
    assert.equal(result.reason, 'operator_stop');
    assert.equal(result.assignments.filter((entry) => entry.kind === 'reconciliation').length, 1);
    assert.equal(world.leadTurns, 1);
  }, { orchestrator: { operatorControl: control.fn } });
});

test('resuming into a mid-batch dispatch with a pause still set submits nothing', async () => {
  const control = holdControl(null);
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/a.js']), brief('orch-builder', ['src/b.js'])), finish('Done')],
    workerFinal: okWriterFinal(),
  });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['collect'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    assert.equal(world.sends.length, 1);
    control.value = 'pause';
    const paused = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(paused.pause.kind, 'operator_pause');
    assert.equal(world.sends.length, 1);

    control.value = null;
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'go' } });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 2);
    assert.equal(world.leadTurns, 2);
  }, { orchestrator: { operatorControl: control.fn } });
});
