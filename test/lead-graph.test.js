'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator, RunNotFoundError } = require('../src/lead-orchestrator');
const { execFileSync } = require('node:child_process');
const { UsageLedger } = require('../src/usage-ledger');
const { loadSkillCatalog } = require('../src/skill-catalog');
const { invalidAcceptanceContract } = require('../src/acceptance');
const { createEvidenceStore } = require('../src/evidence-store');
const { createActivityStore } = require('../src/activity-store');
const { boundedOutcomes } = require('../src/lead-graph');
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
    fenceExisted: false,
    otherWorkspaceRows: new Map(),
    acquired: [],
    released: [],
    turnStarts: [],
    async acquire(args) { this.acquired.push(args); return { executionId: `${args.role}:${args.taskId}` }; },
    release(executionId) { this.released.push(executionId); },
    recordTurnStart(executionId, details) { this.turnStarts.push({ executionId, ...details }); },
    findByContextId(contextId) { return this.rows.get(contextId) || null; },
    findAnyByContextId(contextId) { return this.rows.get(contextId) || this.otherWorkspaceRows.get(contextId) || null; },
    get(executionId) { return [...this.rows.values(), ...this.otherWorkspaceRows.values()].find((row) => row.executionId === executionId) || null; },
    fence(contextId, reason) {
      this.fences.push({ contextId, reason });
      if (this.fenceRace && !this.rows.has(contextId)) this.rows.set(contextId, this.fenceRace(contextId));
      return { execution: this.rows.get(contextId) || null, inserted: !this.fenceExisted };
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
    dispatchInputs: [],
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
          world.dispatchInputs.push(JSON.parse(params.message.parts[0].content.value));
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
      ...(this.options.withEvidence ? { evidenceStore: this.evidenceStore = createEvidenceStore(this.state.db) } : {}),
      ...(this.options.withLedger ? { usageLedger: new UsageLedger({ db: this.state.db }) } : {}),
      ...(this.options.withActivity ? { activityStore: createActivityStore(this.state.db) } : {}),
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

test('lead advertises bounded skill metadata and pins selected skill hashes on dispatch', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, 'api-design');
  fs.mkdirSync(skillDir);
  const contents = '---\nname: api-design\ndescription: Design stable APIs.\nkeywords: ["api", "interface"]\n---\nUse stable interfaces.\n';
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), contents);
  const skillCatalog = loadSkillCatalog({ root });
  const world = makeWorld({ script: [dispatch({ ...brief('orch-builder'), skills: ['api-design'] }), finish('Built API')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build an API', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const prompt = world.prompts[0];
    assert.match(prompt, /Available skill candidates/);
    assert.match(prompt, /api-design/);
    assert.match(prompt, /0-5 relevant IDs/);
    assert.equal(world.dispatchInputs.length, 1);
    assert.deepEqual(world.dispatchInputs[0].skillPins, [{
      id: 'api-design', sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    }]);
    assert.deepEqual(result.assignments[0].skills, world.dispatchInputs[0].skillPins);
  }, { orchestrator: { skillCatalog } });
});

test('resuming a checkpoint rejects a changed pinned skill before A2A dispatch', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'catalog-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, 'api-design');
  fs.mkdirSync(skillDir);
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillFile, '---\nname: api-design\ndescription: Design stable APIs.\n---\nVersion one.\n');
  const skillCatalog = loadSkillCatalog({ root });
  const world = makeWorld({ script: [dispatch({ ...brief('orch-builder'), skills: ['api-design'] }), finish('Built API')] });
  await withSession(world, async (session) => {
    const interrupted = await session.orchestrator.run({ goal: 'Build an API', runId: RUN_ID, interruptAfter: ['decide'] });
    assert.equal(interrupted.status, 'interrupted_for_test');
    fs.writeFileSync(skillFile, '---\nname: api-design\ndescription: Design stable APIs.\n---\nVersion two.\n');
    await assert.rejects(session.orchestrator.resume({ runId: RUN_ID }), /Skill file changed since catalog load/);
    assert.equal(world.sends.length, 0);
  }, { orchestrator: { skillCatalog } });
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

test('pollItem returns the stored result of a finished attempt without polling', async () => {
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
    const id = attemptId(assignmentId(RUN_ID, 1, 0));
    const pollsBefore = [...world.polls.values()][0];
    session.journal.recordFinished(id, {
      taskId: `task-${deterministicContextId(id)}`, contextId: deterministicContextId(id), status: 'outcome_unknown',
      statusMessage: '', artifacts: [], history: [], text: 'stored',
    });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal([...world.polls.values()][0], pollsBefore);
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

  const unresolved = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Ignored it'), finish('Ignored it'), finish('Ignored it')], workerFinal });
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
    assert.equal(rows[0].role, 'coordinator');
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

test('the lead turn records live activity under lead:<runId> and ends it', async () => {
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const row = session.state.db.prepare('SELECT * FROM live_activity WHERE key = ?').get(`lead:${RUN_ID}`);
    assert.deepEqual([row.run_id, row.role, row.phase, row.ended_at !== null], [RUN_ID, 'coordinator', 'done', true]);
  }, { withActivity: true });
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

test('a finished writer outcome without an execution row but with a task is never_executed when this call inserted the fence', async () => {
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
    assert.equal(reconciliation.state, 'never_executed');
    assert.equal(reconciliation.deltaKnown, true);
    assert.deepEqual(reconciliation.changedPaths, []);
    assert.equal(reconciliation.reason, 'fenced_before_execution');
  });
});

test('a finished writer outcome without an execution row but with a task and a pre-existing fence is legacy_unverified', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_FAILED,
      message: { messageId: 'm', role: 2, parts: textParts('old checkpoint'), metadata: { failureKind: 'interrupted' } },
    }),
  });
  world.admission.fenceExisted = true;
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.state, 'legacy_unverified');
    assert.equal(reconciliation.deltaKnown, false);
    assert.deepEqual(reconciliation.changedPaths, []);
    assert.equal(reconciliation.reason, 'no_execution_record');
  });
});

test('an execution row stored under another workspace is not proven never_executed', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_FAILED,
      message: { messageId: 'm', role: 2, parts: textParts('old checkpoint'), metadata: { failureKind: 'interrupted' } },
    }),
  });
  const id = attemptId(assignmentId(RUN_ID, 1, 0));
  world.admission.otherWorkspaceRows.set(deterministicContextId(id), admissionRow(deterministicContextId(id), 'active'));
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.notEqual(reconciliation?.state, 'never_executed');
    assert.equal(reconciliation.state, 'legacy_unverified');
    assert.equal(reconciliation.reason, 'execution_in_other_workspace');
  });
});

test('a bare dot in allowedFiles of a read-only role is normalized away and does not pause', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', ['.'])), finish('Explored')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 2);
    assert.deepEqual(world.dispatchInputs[0].allowedFiles, []);
  });
});

test('a rejected decision is fed back to the lead, keeps the thread for the retry, and is not an outcome', async () => {
  const threads = [];
  const lead = (text) => (args) => { threads.push(args.threadId); return text; };
  const world = makeWorld({
    script: [lead(dispatch(brief('orch-builder', ['src/*']))), lead(dispatch(brief('orch-builder'))), lead(finish('Fixed'))],
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.rounds, 1);
    assert.equal(world.sends.length, 1);
    assert.equal(world.dispatchInputs[0].allowedFiles[0], 'src/example.js');
    assert.equal(world.leadTurns, 3);
    assert.doesNotMatch(world.prompts[0], /Rejected decision:/);
    assert.match(world.prompts[1], /Rejected decision:/);
    assert.match(world.prompts[1], /assignment\.paths path_glob_unsupported/);
    assert.match(world.prompts[1], /without '\.', '\.\.', globs/);
    assert.doesNotMatch(world.prompts[2], /Rejected decision:/);
    assert.deepEqual(threads, [undefined, 'lead-thread', undefined]);
  });
});

test('a normal second round starts a fresh lead thread and a rejection emits decision_rejected', async () => {
  const threads = [];
  const events = [];
  const lead = (text) => (args) => { threads.push(args.threadId); return text; };
  const world = makeWorld({
    script: [lead(dispatch(brief('orch-builder', ['src/*']))), lead(dispatch(brief('orch-builder'))), lead(finish('Fixed'))],
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'completed');
    const rejected = events.filter((event) => event.type === 'decision_rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].round, 1);
    assert.ok(rejected[0].violations.some((violation) => violation.code === 'path_glob_unsupported'));
    assert.deepEqual(Object.keys(rejected[0].violations[0]).sort(), ['code', 'detail', 'predicate']);
  });
  const plain = [];
  const world2 = makeWorld({
    script: [(args) => { plain.push(args.threadId); return dispatch(brief('orch-builder')); }, (args) => { plain.push(args.threadId); return finish('Done'); }],
  });
  await withSession(world2, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(plain, [undefined, undefined]);
  });
});

test('a reconciliation with thousands of changed paths stores capped lists and still fails acceptance', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  const many = Array.from({ length: 5000 }, (_, index) => `other/file-${index}.js`);
  world.admission.reconcile = async function reconcile(executionId) {
    const row = this.get(executionId);
    row.state = 'reconciled';
    row.delta = { known: true, headChanged: false, changedPaths: many };
    return { state: row.state, delta: row.delta };
  };
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.changedPaths.length, 50);
    assert.equal(reconciliation.changedPathCount, 5000);
    assert.equal(reconciliation.attestedScopeViolations.length, 50);
    assert.equal(reconciliation.attestedScopeViolationCount, 5000);
    assert.ok(JSON.stringify(reconciliation).length < 20000);
    assert.equal(reconciliation.boundary.results[0].code, 'attested_scope_violation');
    assert.ok(result.acceptance.issues.some((issue) => issue.code === 'attested_scope_violation' && issue.result === 'FAIL' && issue.advisory === false));
  });
});

test('three consecutive rejected decisions pause the run with the violation codes', async () => {
  const bad = dispatch(brief('orch-builder', ['src/*']));
  const world = makeWorld({ script: [bad, bad, bad, finish('Never reached')] });
  await withSession(world, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'Build', runId: RUN_ID }), /rejected 3 times.*path_glob_unsupported/);
    assert.equal(world.leadTurns, 3);
    assert.equal(world.sends.length, 0);
  });
});

test('a resume after the rejection pause allows two automatic retries again', async () => {
  const bad = dispatch(brief('orch-builder', ['src/*']));
  const world = makeWorld({ script: [bad, bad, bad, bad, bad, finish('Done')] });
  await withSession(world, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'Build', runId: RUN_ID }), /rejected 3 times/);
    assert.equal(world.leadTurns, 3);
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 6);
  });
});

test('an accepted decision resets the consecutive rejection counter', async () => {
  const bad = dispatch(brief('orch-builder', ['src/*']));
  const world = makeWorld({ script: [bad, bad, dispatch(brief('orch-builder')), bad, bad, finish('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 6);
  });
});

test('a checkpoint written before the rejection state fields existed still resumes', async () => {
  const world = makeWorld({ script: [usageLimitError(), 'not json', finish('Resumed')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[2], /decision_not_json/);
  });
});

// ------------------------------------------------- boundary records (DBC-02b)

const recordCodes = (outcome) => outcome.boundary.results.map((entry) => `${entry.predicate}:${entry.result}:${entry.code}`);
const noReportWriter = (metadata) => () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts('not json'), metadata }],
});

test('each dispatched item pins a boundary contract that is copied to its outcome', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: okWriterFinal() });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const outcome = result.assignments[0];
    assert.equal(outcome.contract.id, 'boundary-contract/v1');
    assert.equal(outcome.contract.reportContract, 'worker-report/v1');
    assert.deepEqual(outcome.contract.allowedFiles, ['src/example.js']);
    assert.equal(outcome.contract.sandbox, 'workspace-write');
    assert.match(outcome.contract.roleProfileSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(outcome.contract.skillPins, []);
    assert.deepEqual(outcome.boundary, { contract: 'boundary-contract/v1', results: [] });
  });
});

test('settlement records an out-of-scope writer, an unknown delta, an invalid report and a failed self-report', async () => {
  const scope = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('a')], workerFinal: okWriterFinal(['lib/other.js']) });
  await withSession(scope, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.deepEqual(recordCodes(outcome), ['settle.attested_scope:FAIL:attested_scope_violation']);
    assert.equal(outcome.boundary.results[0].boundary, 'settlement');
    assert.equal(outcome.boundary.results[0].advisory, false);
  });

  const unknown = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('a')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('done')), metadata: { writerExecution: { executionId: 'exec-u', state: 'released', delta: { known: false }, reason: null } } }],
    }),
  });
  await withSession(unknown, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.deepEqual(recordCodes(outcome), ['settle.attested_scope:UNKNOWN:delta_unknown']);
  });

  const invalid = makeWorld({ script: [dispatch(brief('orch-builder')), finish('a')], workerFinal: noReportWriter({ writerExecution: releasedWriter() }) });
  await withSession(invalid, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.deepEqual(recordCodes(outcome), ['settle.report_valid:FAIL:report_invalid']);
    assert.equal(outcome.boundary.results[0].advisory, false);
  });

  const failed = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('a')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('nope', { outcome: 'failed', filesChanged: ['elsewhere.js'] })), metadata: { writerExecution: releasedWriter() } }],
    }),
  });
  await withSession(failed, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.deepEqual(recordCodes(outcome), ['settle.reported_scope:FAIL:reported_scope_violation', 'settle.report_outcome:FAIL:writer_reported_failure']);
    assert.deepEqual(outcome.boundary.results.map((entry) => entry.advisory), [false, true]);
  });
});

test('an unsettled writer outcome records writer_unresolved with its execution evidence', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('a')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('done')), metadata: { writerExecution: { executionId: 'exec-x', state: 'unresolved', delta: { known: true, changedPaths: [] }, reason: 'late' } } }],
    }),
  });
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    const entry = outcome.boundary.results.find((record) => record.predicate === 'settle.writer_settled');
    assert.equal(entry.result, 'UNKNOWN');
    assert.equal(entry.code, 'writer_unresolved');
    assert.deepEqual(entry.evidence, ['writer_executions:exec-x']);
  });
});

test('an invalid read-only report is an advisory settlement record', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('a')],
    workerFinal: () => ({ state: TaskState.TASK_STATE_COMPLETED, artifacts: [{ name: 'r', parts: textParts('plain text') }] }),
  });
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID })).assignments[0];
    assert.deepEqual(recordCodes(outcome), ['settle.report_valid:FAIL:report_invalid']);
    assert.equal(outcome.boundary.results[0].advisory, true);
    assert.ok(outcome.boundary.results[0].detail.length <= 500);
  });
});

test('a writer reporting failed with passing checks is accepted and the advisory record is present', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: () => ({
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('could not', { outcome: 'blocked' })), metadata: { writerExecution: releasedWriter() } }],
    }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.deepEqual(issueCodes(result), ['writer_reported_failure']);
    assert.equal(result.acceptance.issues[0].advisory, true);
    assert.equal(result.acceptance.issues[0].boundary, 'acceptance');
  }, { workspace });
});

test('a reconciled out-of-scope writer carries settlement records', async () => {
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
    assert.equal(reconciliation.boundary.contract, 'boundary-contract/v1');
    assert.deepEqual(recordCodes(reconciliation), ['settle.attested_scope:FAIL:attested_scope_violation']);
  }, { workspace });
});

test('an outcome from an old checkpoint without a pinned contract is legacy and still processes', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: okWriterFinal(['lib/other.js']) });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['collect'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    const config = { configurable: { thread_id: RUN_ID } };
    const { values } = await session.orchestrator.graph.getState(config);
    const items = values.batch.items.map(({ contract, ...rest }) => rest);
    await session.orchestrator.graph.updateState(config, { batch: { ...values.batch, items } }, 'collect');
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const outcome = result.assignments[0];
    assert.equal(Object.hasOwn(outcome, 'contract'), false);
    assert.equal(outcome.boundary.contract, 'legacy');
    assert.deepEqual(outcome.attestedScopeViolations, ['lib/other.js']);
    assert.deepEqual(recordCodes(outcome), ['settle.attested_scope:FAIL:attested_scope_violation']);
  });
});

test('an invalid acceptance contract marker yields unverifiable with contract_invalid', async () => {
  const world = makeWorld({ script: [finish('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID, contract: invalidAcceptanceContract('Stored acceptance contract is invalid: bad') });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'unverifiable');
    assert.deepEqual(issueCodes(result), ['contract_invalid']);
    assert.equal(result.acceptance.issues[0].predicate, 'accept.contract_valid');
    assert.equal(result.acceptance.issues[0].result, 'UNKNOWN');
  }, { workspace: gitRepo() });
});

// ------------------------------------------------- lead projection (PIP-03)

const sha256Of = (value) => crypto.createHash('sha256').update(value).digest('hex');
function readAll(store, ref, runId) {
  const parts = [];
  for (let offset = 0; offset < ref.storedBytes; offset += 1024 * 1024) {
    parts.push(store.read(ref.id, { runId, offset, length: 1024 * 1024 }).bytes);
  }
  return Buffer.concat(parts);
}
const writerFinalWith = (text) => () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts(text), metadata: { writerExecution: releasedWriter() } }],
});
const promptOutcomes = (prompt) => prompt.split('Prior worker outcomes (including failures):\n')[1].split('\n\n')[0];

test('a 300 KB valid report is parsed whole, projected with omissions, and retrievable as evidence', async () => {
  const files = Array.from({ length: 500 }, (_, i) => `lib/gen/${'d'.repeat(16)}/f-${i}.js`);
  const text = report('Big', {
    filesChanged: files, filesInspected: files.slice(0, 300), risks: Array.from({ length: 40 }, () => 'r'.repeat(8000)),
  });
  assert.ok(text.length > 300_000, `fixture is ${text.length} chars`);
  const world = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: writerFinalWith(text) });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const outcome = result.assignments[0];
    assert.equal(outcome.report.outcome, 'completed');
    assert.equal(outcome.reportError, null);
    assert.equal(outcome.report.filesChanged.length, 100);
    assert.equal(outcome.scopeViolations.length, 50);
    assert.equal(outcome.scopeViolationCount, 500);
    const omitted = Object.fromEntries(outcome.projection.omitted.map((entry) => [entry.field, entry]));
    assert.deepEqual(omitted.filesChanged, { field: 'filesChanged', kept: 100, total: 500 });
    assert.deepEqual(omitted.filesInspected, { field: 'filesInspected', kept: 20, total: 300 });
    assert.deepEqual(omitted.risks, { field: 'risks', kept: 20, total: 40 });
    assert.deepEqual(omitted.scopeViolations, { field: 'scopeViolations', kept: 50, total: 500 });
    assert.equal(outcome.evidence.length, 1);
    const ref = outcome.evidence[0];
    assert.equal(ref.kind, 'worker_result_text');
    assert.equal(ref.attemptId, outcome.attemptId);
    assert.equal(ref.originalSha256, sha256Of(text));
    assert.equal(sha256Of(readAll(session.evidenceStore, ref, RUN_ID)), sha256Of(text));
    assert.ok(outcome.report.decisionRequest === null);
    assert.equal(outcome.boundary.results.some((entry) => entry.code === 'reported_scope_violation'), true);
    const after = JSON.stringify(outcome).length;
    assert.ok(after < 20_000, `projected outcome is ${after} chars (before: ${text.length}+ chars of report text)`);
    assert.ok(promptOutcomes(world.prompts[1]).length < 20_000);
    // The journal result keeps the cut text and only bounded analysis.
    const stored = JSON.stringify(session.journal.get(outcome.attemptId).result);
    assert.ok(stored.length < 260_000, `journal result is ${stored.length} chars`);
  }, { workspace: gitRepo(), withEvidence: true });
});

test('a 300 KB invalid text yields reportError, a head/marker/tail projection and evidence', async () => {
  const text = `${'H'.repeat(6000)}${'m'.repeat(288_000)}${'T'.repeat(6000)}`;
  const world = makeWorld({ script: [dispatch(brief('orch-explorer')), finish('Done')], workerFinal: writerFinalWith(text) });
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Look', runId: RUN_ID })).assignments[0];
    assert.equal(outcome.report, null);
    assert.match(outcome.reportError, /not valid JSON/);
    const ref = outcome.evidence[0];
    assert.equal(ref.originalSha256, sha256Of(text));
    assert.ok(outcome.text.startsWith('H'.repeat(6000)));
    assert.ok(outcome.text.endsWith('T'.repeat(2000)));
    assert.ok(outcome.text.includes(`[... ${text.length - 8000} chars omitted; evidence ${ref.id}]`));
    assert.ok(outcome.text.length < 8200);
    assert.deepEqual(outcome.projection.omitted, [{ field: 'text', kept: 8000, total: text.length }]);
    assert.equal(sha256Of(readAll(session.evidenceStore, ref, RUN_ID)), sha256Of(text));
  }, { workspace: gitRepo(), withEvidence: true });
});

test('a store failure sets evidenceError and the run still completes', async () => {
  const text = `${'x'.repeat(20_000)}`;
  const world = makeWorld({ script: [dispatch(brief('orch-explorer')), finish('Done')], workerFinal: writerFinalWith(text) });
  const failing = { put() { throw Object.assign(new Error('disk gone'), { code: 'evidence_boom' }); } };
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const outcome = result.assignments[0];
    assert.equal(outcome.evidenceError, 'evidence_boom');
    assert.equal(outcome.evidence, undefined);
    assert.ok(outcome.text.includes('chars omitted]'));
    assert.ok(!outcome.text.includes('evidence ev_'));
  }, { workspace: gitRepo(), orchestrator: { evidenceStore: failing } });
});

test('small outcomes are unchanged: no evidence, no projection, no counts', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Done')], workerFinal: okWriterFinal(['lib/other.js']) });
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    for (const key of ['evidence', 'projection', 'evidenceError', 'scopeViolationCount', 'attestedScopeViolationCount']) assert.equal(key in outcome, false, key);
    assert.deepEqual(outcome.attestedScopeViolations, ['lib/other.js']);
  }, { workspace: gitRepo(), withEvidence: true });
});

test('boundedOutcomes keeps newest outcomes whole, digests older ones with diagnostics, and stays under the bound', () => {
  const outcome = (index, extra = {}) => ({
    assignmentId: `a${index}`, attemptId: `run:r1:a${index}:t1`, role: 'engineer', status: 'TASK_STATE_COMPLETED',
    report: { outcome: 'completed', summary: `summary ${index} ${'s'.repeat(2000)}`, risks: ['x'.repeat(400)] },
    reportError: null, failureKind: null, scopeViolations: [`bad/${index}.js`], attestedScopeViolations: [], attestedDeltaKnown: true,
    writerExecution: { state: 'released', delta: { known: true, changedPaths: Array.from({ length: 50 }, (_, n) => `p/${n}`) } },
    effects: null, boundary: { contract: 'legacy', results: [{ predicate: 'settle.x', result: 'FAIL', code: 'c', detail: 'd'.repeat(500) }] },
    evidence: [{ id: `ev_${String(index).padStart(32, '0')}` }], ...extra,
  });
  const many = Array.from({ length: 80 }, (_, i) => outcome(i, { filler: 'f'.repeat(3000) }));
  many.splice(5, 0, { kind: 'reconciliation', attemptId: 'run:r1:a5:t1', assignmentId: 'rec', role: 'engineer', state: 'reconciled', changedPaths: [], deltaKnown: true });
  const bounded = boundedOutcomes(many);
  assert.ok(JSON.stringify(bounded).length <= 60_000, `${JSON.stringify(bounded).length}`);
  assert.equal(bounded.at(-1).digest, undefined);
  assert.equal(bounded.at(-1).assignmentId, 'a79');
  const digest = bounded.find((entry) => entry.digest && entry.assignmentId === 'a70');
  assert.ok(digest, 'older outcomes become digests');
  assert.equal(digest.summary.length, 300);
  assert.equal(digest.diagnostics.status, 'TASK_STATE_COMPLETED');
  assert.deepEqual(digest.diagnostics.scopeViolations, ['bad/70.js']);
  assert.equal(digest.diagnostics.changedPathCount, 50);
  assert.deepEqual(digest.evidence, [`ev_${'70'.padStart(32, '0')}`]);
  assert.deepEqual(digest.boundary, [{ predicate: 'settle.x', result: 'FAIL', code: 'c' }]);
  assert.ok(bounded.some((entry) => entry.kind === 'reconciliation'), 'reconciliation stays whole');
  // Under the bound (and for old outcomes without the new fields) nothing changes.
  const few = [outcome(1), outcome(2)];
  assert.equal(boundedOutcomes(few), few);
});

test('boundedOutcomes elides older outcomes into entries with identity and blocking violation codes', () => {
  const outcome = (index) => ({
    assignmentId: `a${index}`, attemptId: `run:r1:a${index}:t1`, role: 'engineer', status: 'TASK_STATE_FAILED',
    report: { outcome: 'failed', summary: 's'.repeat(2000) }, reportError: null, failureKind: null, scopeViolations: [],
    attestedScopeViolations: [], attestedDeltaKnown: true, writerExecution: null, effects: null, filler: 'f'.repeat(5000),
    boundary: { contract: 'legacy', results: [
      { predicate: 'p1', result: 'FAIL', code: `block_${index % 3}`, advisory: false },
      { predicate: 'p2', result: 'FAIL', code: `block_${index % 3}` },
      { predicate: 'p3', result: 'FAIL', code: 'only_advisory', advisory: true },
    ] },
    evidence: [{ id: `ev_${String(index).padStart(32, '0')}` }],
  });
  const many = Array.from({ length: 90 }, (_, i) => outcome(i));
  const limit = 20_000;
  const bounded = boundedOutcomes(many, limit);
  assert.ok(JSON.stringify(bounded).length <= limit, `${JSON.stringify(bounded).length}`);
  const elided = bounded.filter((entry) => entry.elided === true);
  assert.ok(elided.length >= 3, `${elided.length} elision entries`);
  for (const entry of elided) {
    const index = Number(entry.assignmentId.slice(1));
    assert.deepEqual(Object.keys(entry).sort(), ['assignmentId', 'attemptId', 'elided', 'role', 'status', 'violationCodes']);
    assert.equal(entry.attemptId, `run:r1:a${index}:t1`);
    assert.equal(entry.role, 'engineer');
    assert.equal(entry.status, 'TASK_STATE_FAILED');
    assert.deepEqual(entry.violationCodes, [`block_${index % 3}`]);
  }
  // Newest outcomes stay full or digested; the oldest are the ones elided.
  assert.equal(bounded.at(-1).assignmentId, 'a89');
  assert.equal(bounded.at(-1).elided, undefined);
  const elidedIndexes = elided.map((entry) => Number(entry.assignmentId.slice(1)));
  const detailed = bounded.filter((entry) => entry.elided !== true && entry.assignmentId).map((entry) => Number(entry.assignmentId.slice(1)));
  assert.ok(Math.max(...elidedIndexes) < Math.min(...detailed));
  // When even elision entries do not fit, a single count digest covers the remainder.
  const tiny = boundedOutcomes(many, 1500);
  assert.ok(JSON.stringify(tiny).length <= 1500, `${JSON.stringify(tiny).length}`);
  const counter = tiny.filter((entry) => entry.digest && typeof entry.elided === 'number');
  assert.equal(counter.length, 1);
  assert.ok(counter[0].elided > 0 && typeof counter[0].note === 'string');
});

// ----------------------------------------------------- wave groups (parallelWriters)

const waveBrief = (roleName, allowedFiles, wave) => ({ ...brief(roleName, allowedFiles), wave });
const withWriters = { orchestrator: { parallelWriters: true } };

test('parallelWriters submits a group together and the next group only after all of it finished', async () => {
  const seen = [];
  const world = makeWorld({
    script: [dispatch(
      waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 1), waveBrief('orch-builder', ['src/c.js'], 1),
      waveBrief('orch-explorer', [], null),
    ), finish('Done')],
    workerFinal: okWriterFinal(),
    pollsNeeded: 1,
  });
  world.getTaskFault = (id, count) => { if (count === 1) seen.push(world.sends.length); };
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 4);
    assert.deepEqual(seen, [3, 3, 3, 4]);
    assert.deepEqual(world.dispatchInputs.slice(0, 3).map((input) => input.wave), [1, 1, 1]);
    assert.equal(world.dispatchInputs[3].wave, null);
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.ok(snapshot);
  }, withWriters);
});

test('parallelWriters persists item groups in the checkpoint batch', async () => {
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 1), waveBrief('orch-explorer', [], null)), finish('Done')],
    workerFinal: okWriterFinal(),
  });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['dispatch'] });
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(snapshot.values.batch.items.map((item) => item.group), [0, 0, 1]);
    assert.equal(snapshot.values.batch.parallel, false);
  }, withWriters);
});

test('an unsettled writer in group 1 skips the writers of group 2', async () => {
  const world = makeWorld({
    script: [dispatch(
      waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 1), waveBrief('orch-builder', ['src/c.js'], 2),
    ), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 2);
    const third = result.assignments.find((entry) => entry.assignmentId === assignmentId(RUN_ID, 1, 2) && entry.kind !== 'reconciliation');
    assert.equal(third.status, 'skipped_unresolved_writer');
    assert.equal(third.effects, 'none');
  }, withWriters);
});

test('without parallelWriters waved writers still run one at a time in array order', async () => {
  const order = [];
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 1)), finish('Done')],
    workerFinal: okWriterFinal(),
    pollsNeeded: 1,
  });
  world.getTaskFault = (id, count) => { if (count === 1) order.push(world.sends.length); };
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(world.sends.length, 2);
    assert.deepEqual(order, [1, 2]);
  });
});

test('a checkpointed batch without item groups keeps serial behavior under parallelWriters', async () => {
  const order = [];
  const world = makeWorld({
    script: [dispatch(
      waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 2), waveBrief('orch-builder', ['src/c.js'], 2),
    ), finish('Done')],
    workerFinal: okWriterFinal(),
    pollsNeeded: 1,
  });
  world.getTaskFault = (id, count) => { if (count === 1) order.push(world.sends.length); };
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, interruptAfter: ['dispatch'] });
    // Strip groups as a checkpoint written before this change would have.
    const config = { configurable: { thread_id: RUN_ID } };
    const { batch } = (await session.orchestrator.graph.getState(config)).values;
    await session.orchestrator.graph.updateState(config, { batch: { ...batch, items: batch.items.map(({ group, ...rest }) => rest) } });
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(order, [1, 2, 3]);
  }, withWriters);
});

test('the decision prompt describes waves according to parallelWriters', async () => {
  for (const [options, pattern] of [[withWriters, /isolated copy of the workspace/], [undefined, /writers always run one at a time|Writers always run one at a time/]]) {
    const world = makeWorld({ script: [finish('Done')] });
    await withSession(world, async (session) => {
      await session.orchestrator.run({ goal: 'Plan', runId: RUN_ID });
      assert.match(world.prompts[0], pattern);
      assert.match(world.prompts[0], /Waves: assignment\.wave/);
      assert.match(world.prompts[0], /skills, and wave/);
    }, options);
  }
});

// ----------------------------------------------------- writer lanes (parallelWriters)

const laneOf = (overrides = {}) => ({
  id: 'lane-1', path: '/lanes/lane-1', workspacePath: '/lanes/lane-1/ws', base: 'abc123', state: 'not_integrated', reason: 'no_changes', ...overrides,
});
const lanePlain = { executionId: null, state: null, delta: null, reason: null, effects: 'none' };
const laneFinal = (writerExecution, { state = TaskState.TASK_STATE_COMPLETED, text = report('done'), status } = {}) => () => ({
  state,
  ...(status ? { message: status } : {}),
  artifacts: [{ name: 'report', parts: textParts(text), metadata: { writerExecution } }],
});
const laneCodes = (outcome) => outcome.boundary.results.map((entry) => `${entry.predicate}:${entry.result}:${entry.code}`);

test('a not_integrated COMPLETED writer of wave 1 settles and wave 2 runs without reconcile or fence', async () => {
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 2)), finish('Done')],
    workerFinal: (roleName, contextId) => (world.sends.length === 1
      ? laneFinal({ ...lanePlain, lane: laneOf() })()
      : okWriterFinal()(roleName, contextId)),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 2);
    assert.deepEqual(world.admission.fences, []);
    assert.deepEqual(world.admission.reconciles, []);
    assert.equal(result.assignments.filter((entry) => entry.kind === 'reconciliation').length, 0);
    const first = result.assignments[0];
    assert.equal(first.status, 'TASK_STATE_COMPLETED');
    assert.equal(first.lane.reason, 'no_changes');
    assert.ok(!laneCodes(first).includes('settle.writer_settled:UNKNOWN:writer_unresolved'));
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(snapshot.values.unresolvedWriters, []);
  }, withWriters);
});

test('a not_integrated FAILED writer without effects metadata is settled and not reconciled', async () => {
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 2)), finish('Done')],
    workerFinal: (roleName, contextId) => (world.sends.length === 1
      ? laneFinal({ ...lanePlain, lane: laneOf({ reason: 'turn_failed' }) }, { state: TaskState.TASK_STATE_FAILED, text: 'turn failed' })()
      : okWriterFinal()(roleName, contextId)),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(world.sends.length, 2);
    assert.deepEqual(world.admission.reconciles, []);
    assert.equal(result.assignments[0].lane.reason, 'turn_failed');
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(snapshot.values.unresolvedWriters, []);
  }, withWriters);
});

test('an integrated lane with a released row behaves like a released writer', async () => {
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 2)), finish('Done')],
    workerFinal: laneFinal({ ...releasedWriter(['src/a.js']), lane: laneOf({ state: 'integrated', reason: null }) }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(world.sends.length, 2);
    const first = result.assignments[0];
    assert.deepEqual(laneCodes(first), []);
    assert.equal(first.lane.state, 'integrated');
    assert.deepEqual(first.attestedScopeViolations, []);
  }, withWriters);
});

test('lane workspace paths are stripped from reported files and not_integrated makes reported scope advisory', async () => {
  const lane = laneOf({ workspacePath: '/lanes/lane-1/ws' });
  const inScope = report('done', { filesChanged: ['/lanes/lane-1/ws/src/example.js'] });
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('a')], workerFinal: laneFinal({ ...releasedWriter(), lane: { ...lane, state: 'integrated', reason: null } }, { text: inScope }) });
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.deepEqual(outcome.scopeViolations, []);
  });
  const outside = report('done', { filesChanged: ['/lanes/lane-1/ws/src/other.js'] });
  const live = makeWorld({ script: [dispatch(brief('orch-builder')), finish('a')], workerFinal: laneFinal({ ...releasedWriter(), lane: { ...lane, state: 'integrated', reason: null } }, { text: outside }) });
  await withSession(live, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.deepEqual(outcome.scopeViolations, ['/lanes/lane-1/ws/src/other.js']);
    const record = outcome.boundary.results.find((entry) => entry.predicate === 'settle.reported_scope');
    assert.equal(record.advisory, false);
  });
  const refused = makeWorld({ script: [dispatch(brief('orch-builder')), finish('a')], workerFinal: laneFinal({ ...lanePlain, lane: lane }, { text: outside }) });
  await withSession(refused, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    const record = outcome.boundary.results.find((entry) => entry.predicate === 'settle.reported_scope');
    assert.equal(record.advisory, true);
  });
});

test('a refused lane adds settle.lane_scope and the lane field reaches the decision prompt', async () => {
  const lane = laneOf({ reason: 'lane_scope_refused', scopeViolations: ['docs/x.md'], path: '/lanes/kept' });
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), dispatch(brief('orch-builder')), finish('a')],
    workerFinal: laneFinal({ ...lanePlain, lane }),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const outcome = result.assignments[0];
    assert.deepEqual(laneCodes(outcome), ['settle.lane_scope:FAIL:lane_scope_refused']);
    assert.deepEqual(outcome.lane, {
      state: 'not_integrated', reason: 'lane_scope_refused', conflicts: [], scopeViolations: ['docs/x.md'], unsafePaths: [], path: '/lanes/kept',
    });
    assert.match(promptOutcomes(world.prompts[1]), /"lane":\{"state":"not_integrated","reason":"lane_scope_refused"/);
    assert.match(world.prompts[1], /not_integrated/);
    assert.match(world.prompts[1], /corrected allowedFiles/);
  }, withWriters);
  const plain = makeWorld({ script: [finish('Done')] });
  await withSession(plain, async (session) => {
    await session.orchestrator.run({ goal: 'Plan', runId: RUN_ID });
    assert.doesNotMatch(plain.prompts[0], /not_integrated/);
  });
});

test('the lane field survives a digest in boundedOutcomes', () => {
  const lane = { state: 'not_integrated', reason: 'integration_conflict', conflicts: Array.from({ length: 9 }, (_, n) => `c/${n}`), scopeViolations: [], unsafePaths: [], path: '/lanes/x' };
  const many = Array.from({ length: 30 }, (_, n) => ({
    assignmentId: `a${n}`, attemptId: `t${n}`, role: 'r', status: 'TASK_STATE_COMPLETED', report: null, scopeViolations: [],
    attestedScopeViolations: [], attestedDeltaKnown: true, writerExecution: null, effects: null, lane, filler: 'f'.repeat(2000),
  }));
  const bounded = boundedOutcomes(many);
  const digest = bounded.find((entry) => entry.digest && entry.diagnostics);
  assert.ok(digest);
  assert.equal(digest.diagnostics.lane.reason, 'integration_conflict');
  assert.equal(digest.diagnostics.lane.path, '/lanes/x');
});

test('a refused lane followed by a successful writer does not poison acceptance', async () => {
  const workspace = gitRepo();
  const refused = laneOf({ reason: 'lane_scope_refused', scopeViolations: ['elsewhere.js'] });
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => (world.sends.length === 1
      ? laneFinal({ ...lanePlain, lane: refused }, { text: report('refused', { filesChanged: ['elsewhere.js'] }) })()
      : okWriterFinal()(roleName, contextId)),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.deepEqual(issueCodes(result), []);
  }, { workspace });
});
