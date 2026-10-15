'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { TaskState } = require('@a2a-js/sdk');
const { uuid6 } = require('@langchain/langgraph-checkpoint');
const { INTERRUPT } = require('@langchain/langgraph');
const { LeadOrchestrator, RunNotFoundError } = require('../src/lead-orchestrator');
const { execFileSync } = require('node:child_process');
const { UsageLedger } = require('../src/usage-ledger');
const { loadSkillCatalog } = require('../src/skill-catalog');
const { invalidAcceptanceContract } = require('../src/acceptance');
const { createEvidenceStore } = require('../src/evidence-store');
const { createActivityStore } = require('../src/activity-store');
const { SessionThreads } = require('../src/session-threads');
const { InMemoryStagingLog } = require('../src/staging-log');
const { boundedOutcomes } = require('../src/lead-graph');
const { computeReviewTarget } = require('../src/review-policy');
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
// LL-6: an owner-only reason and a cited investigation (by default the explorer of round 1).
const humanRequest = (relatedDecisionIds = [], evidenceChecked = [`${assignmentId(RUN_ID, 1, 0)} confirmed it`], reason = 'credentials_or_access') => decision({
  action: 'request_human_input',
  humanInput: {
    reason,
    question: 'Which variant?',
    options: [{ id: 'a', description: 'Variant A' }, { id: 'b', description: 'Variant B' }],
    recommendation: 'a',
    evidenceChecked,
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
  ['orch-verifier', role('orch-verifier', 'workspace-write')],
  ['orch-auditor', role('orch-auditor', 'read-only')],
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
    threadArgs: [],
    threadSeq: 0,
    prompts: [],
    dispatchInputs: [],
    sends: [],
    cancels: [],
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
  const attachReviewMetadata = (task, final) => {
    if (!task.input?.review || final.state !== TaskState.TASK_STATE_COMPLETED) return final;
    const review = task.input.review;
    const reportArtifact = (final.artifacts || []).find((artifact) => artifact.name === 'report');
    let parsed = null;
    const artifactText = (reportArtifact?.parts || []).map((part) => part?.content?.value || part?.text || '').join('\n');
    try { parsed = JSON.parse(artifactText); } catch (_) { /* report parsing is tested separately */ }
    const summary = parsed?.summary || '';
    const pinnedVerdict = /^VERDICT: (preserve|weaken)$/.exec(summary.split(/\r?\n/, 1)[0])?.[1] || null;
    const auditorVerdict = /^VERDICT: (pass|fail|inconclusive)$/.exec(summary.split(/\r?\n/, 1)[0])?.[1] || null;
    const isPinned = review.kind === 'pinned_check';
    const accepted = isPinned ? pinnedVerdict === 'preserve'
      : task.role === 'orch-auditor' ? auditorVerdict === 'pass' : true;
    const valid = isPinned ? Boolean(pinnedVerdict)
      : task.role === 'orch-auditor' ? Boolean(auditorVerdict)
        : parsed?.outcome === 'completed' && Array.isArray(parsed.checks) && parsed.checks.length > 0 && parsed.checks.every((check) => check.result === 'passed');
    const metadata = {
      reviewCoverage: { targetKnown: true, targetIdentity: 'direct-test-target', stable: true, reason: null },
      review: {
        policyId: 'auditor-routing/v1',
        kind: review.kind,
        checkpointId: review.checkpointId,
        status: valid ? (accepted ? 'accepted' : (pinnedVerdict || auditorVerdict || 'failed')) : 'inconclusive',
        accepted,
        valid,
        verdict: pinnedVerdict || auditorVerdict,
        reason: valid ? null : 'test_service_review_invalid',
      },
    };
    const message = final.message ? {
      ...final.message,
      metadata: {
        ...(final.message.metadata || {}),
        ...Object.fromEntries(Object.entries(metadata).filter(([key]) => !Object.hasOwn(final.message.metadata || {}, key))),
      },
    } : null;
    return {
      ...final,
      artifacts: (final.artifacts || []).map((artifact) => ({
        ...artifact,
        metadata: { ...(artifact.metadata || {}), ...Object.fromEntries(Object.entries(metadata).filter(([key]) => !Object.hasOwn(artifact.metadata || {}, key))) },
      })),
      ...(message ? { message } : {}),
    };
  };
  const view = (task, done) => {
    const final = done ? attachReviewMetadata(task, world.workerFinal(task.role, task.contextId, task.input)) : { state: TaskState.TASK_STATE_WORKING };
    return {
      id: task.id,
      contextId: task.contextId,
      status: { state: final.state, ...(final.message ? { message: final.message } : {}) },
      artifacts: done ? final.artifacts || [] : [],
      history: [],
    };
  };
  world.appServer = {
    getCodexHome() { return world.codexHome ?? null; },
    async run(args) {
      world.prompts.push(args.input);
      world.threadArgs.push(args.threadId);
      const next = world.script[world.leadTurns];
      world.leadTurns += 1;
      if (next === undefined) throw new Error('lead script exhausted');
      const extras = world.leadExtras ? world.leadExtras(world.leadTurns) : {};
      // SES-01 tests set freshThreads: a turn without a threadId opens thread-N, a resumed one keeps its id.
      const threadId = world.freshThreads ? (args.threadId || `thread-${world.threadSeq += 1}`) : 'lead-thread';
      if (typeof next === 'function') return { threadId, status: 'completed', text: await next(args), ...extras };
      if (next instanceof Error) throw next;
      return { threadId, status: 'completed', text: next, ...extras };
    },
  };
  world.clientFactory = {
    async createFromUrl(url) {
      const roleName = decodeURIComponent(new URL(url).pathname.split('/').at(-2));
      return {
        async sendMessage(params) {
          const contextId = params.message.contextId;
          world.sends.push(contextId);
          const input = JSON.parse(params.message.parts[0].content.value);
          world.dispatchInputs.push(input);
          const task = { id: `task-${contextId}`, contextId, role: roleName, input };
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
          world.cancels.push(id);
          const task = [...world.tasks.values()].find((entry) => entry.id === id);
          // A test may let the canceled turn leave a writer execution behind (world.onCancel -> status message).
          const message = world.onCancel?.(task);
          return { ...view(task, false), status: { state: TaskState.TASK_STATE_CANCELED, ...(message ? { message } : {}) } };
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
      ...(this.options.withSessions ? { sessionThreads: this.sessions = new SessionThreads({ db: this.state.db }) } : {}),
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

test('LeadOrchestrator uses the injected staging log for durable runtime records', async () => {
  const stagingLog = new InMemoryStagingLog();
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Implemented')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const events = stagingLog.list({ runId: RUN_ID });
    assert.ok(events.some((event) => event.type === 'assignment_selected'));
    assert.ok(events.some((event) => event.type === 'worker_result'));
  }, { orchestrator: { stagingLog } });
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
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), humanRequest(), finish('Went with A')] });
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
    assert.equal(world.leadTurns, 3);
    assert.match(world.prompts[2], /Use variant A/);
    assert.match(world.prompts[2], new RegExp(`${RUN_ID}:h1`));
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
    const paused = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(paused.pause.question, /must be resolved/);
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

test('a worker decision with a bad recommendation still reaches the lead, normalized', async () => {
  const bad = report('Need a call', {
    outcome: 'needs_decision',
    decisionRequest: {
      question: 'Keep the API?',
      options: [{ id: 'keep', description: 'Keep it' }, { id: 'drop', description: 'Drop it' }],
      evidenceChecked: ['src/api.js'],
      recommendation: 'maybe',
      consequenceIfWrong: 'Breaking change',
    },
  });
  const workerFinal = () => ({ state: TaskState.TASK_STATE_COMPLETED, artifacts: [{ name: 'report', parts: textParts(bad) }] });
  const attempt = attemptId(assignmentId(RUN_ID, 1, 0));
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Resolved', [{ decisionId: attempt, choice: 'keep', rationale: 'Evidence in src/api.js' }])],
    workerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.assignments[0].report.decisionRequest.recommendation, null);
    assert.deepEqual(result.assignments[0].normalizations, ['decisionRequest.recommendation: cleared']);
    assert.match(world.prompts[1], /Keep the API\?/);
    assert.match(world.prompts[1], /Open worker decisions/);
    assert.match(world.prompts[1], /decisionRequest\.recommendation: cleared/);
  });
});

test('an empty dispatch is rejected with a reminder to finish or ask', async () => {
  const world = makeWorld({ script: [dispatch(), finish('Nothing to do')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[1], /use finish or request_human_input instead of an empty dispatch/);
  });
});

test('a human answer closes the related worker decisions after a read-only investigation kept them open', async () => {
  const attempt = attemptId(assignmentId(RUN_ID, 1, 0));
  const asking = deterministicContextId(attempt);
  const workerFinal = (roleName, contextId) => ({
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{ name: 'report', parts: textParts(contextId === asking ? needsDecisionReport() : report('Traced it')) }],
  });
  const investigation = assignmentId(RUN_ID, 2, 0);
  const world = makeWorld({
    script: [
      dispatch(brief('orch-explorer', [])),
      // Asking at once is refused: the decision was raised in round 1 and nothing investigated it since.
      humanRequest([attempt], [`${assignmentId(RUN_ID, 1, 0)} asked`]),
      dispatch(brief('orch-explorer', [])),
      humanRequest([attempt], [`${investigation} traced the API owner`]),
      finish('Done'),
    ],
    workerFinal,
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.match(world.prompts[2], /decision\.investigate_first investigation_missing: request_human_input needs a finished read-only investigation of the blocker from a round after 1/);
    assert.match(world.prompts[3], /Open worker decisions[^\n]*\n\[\{"id":"run-1:r1:a0:t1"/);
    assert.equal(paused.pause.decisionId, `${RUN_ID}:h1`);
    assert.deepEqual(paused.pause.relatedDecisionIds, [attempt]);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Keep it', choice: 'a', decisionId: `${RUN_ID}:h1` } });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[1], /Keep the API\?/);
    assert.match(world.prompts[4], /Keep it/);
    assert.match(world.prompts[4], /Open worker decisions[^\n]*\n\[\]/);
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

test('the round limit pauses for the owner instead of ending with max_rounds, and accept_as_is runs acceptance', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), dispatch(brief('orch-explorer', []))] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID, contract: contractOf(nodeCheck('ok', 'process.exit(0)')) });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'human_decision');
    assert.equal(paused.pause.escalation, 'round_limit');
    assert.equal(world.admission.acquired.length, 0);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Good enough', choice: 'accept_as_is' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Stopped after reaching the caller-configured limit of 1 dispatch rounds.');
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(world.admission.acquired.length, 1);
    assert.equal(world.leadTurns, 2);
  }, { workspace: gitRepo(), orchestrator: { maxRounds: 1 } });
});

test('owner accept_as_is cannot make a pending critical review gate accepted', async (t) => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-1', reason: 'Change a trust boundary', paths: ['src/file.js'], evidenceIds: ['issue-1'] };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch(brief('orch-explorer', [])),
    ],
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({
      goal: 'Change a trust boundary', runId: RUN_ID,
      contract: contractOf(nodeCheck('ok', 'process.exit(0)')),
    });
    assert.equal(paused.status, 'input_required');
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Accept current result', choice: 'accept_as_is' } });
    assert.equal(result.status, 'completed');
    assert.notEqual(result.acceptance.disposition, 'accepted');
    assert.ok(result.acceptance.issues.some((issue) => issue.code === 'review_gate_pending'));
  }, {
    workspace,
    orchestrator: {
      maxRounds: 1,
      runCheckImpl: async (check) => ({ id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' }),
    },
  });
});

test('resumed finalization rechecks critical receipts against the current target', async (t) => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate one');
  const review = { kind: 'risk_change', checkpointId: 'critical-2', reason: 'Change a trust boundary', paths: ['src/file.js'], evidenceIds: ['issue-2'] };
  const world = makeWorld({
    script: [
      dispatch(
        { ...brief('orch-builder', ['src/file.js']), review },
        { ...brief('orch-verifier', ['test']), review },
        { ...brief('orch-auditor', []), review },
      ),
      finish('Implemented and reviewed'),
    ],
    workerFinal(roleName) {
      const auditor = roleName === 'orch-auditor';
      const writer = roleName === 'orch-builder';
      const summary = auditor ? 'VERDICT: pass\nThe scoped change preserves the trust boundary.' : 'Focused evidence is sufficient.';
      const inspected = writer ? [] : ['src/file.js'];
      const checks = writer ? [] : [{ command: 'node --test test/review.test.js', result: 'passed', detail: 'passed' }];
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        artifacts: [{ name: 'report', parts: textParts(report(summary, { filesInspected: inspected, checks })), metadata: { writerExecution: releasedWriter(writer ? ['src/file.js'] : []) } }],
      };
    },
  });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({
      goal: 'Change a trust boundary', runId: RUN_ID, interruptAfter: ['accept'],
      contract: contractOf(nodeCheck('ok', 'process.exit(0)')),
    });
    assert.equal(stopped.status, 'interrupted_for_test');
    const before = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(before.values.acceptance.disposition, 'accepted');
    fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate two');
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'unverifiable');
    assert.ok(result.acceptance.issues.some((issue) => issue.code === 'review_gate_pending'));
  }, {
    workspace,
    orchestrator: {
      runCheckImpl: async (check) => ({ id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' }),
    },
  });
});

const reviewWorkerFinal = (roleName) => {
  const writer = roleName === 'orch-builder';
  const auditor = roleName === 'orch-auditor';
  const summary = writer ? 'Implementation complete.'
    : auditor ? 'VERDICT: pass\nThe declared scope is safe.' : 'Focused verification passed.';
  return {
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{
      name: 'report',
      parts: textParts(report(summary, {
        filesChanged: writer ? ['src/file.js'] : [],
        filesInspected: writer ? [] : ['src/file.js'],
        checks: writer ? [] : [{ command: 'node --test test/review.test.js', result: 'passed', detail: 'passed' }],
      })),
      metadata: { writerExecution: releasedWriter(writer ? ['src/file.js'] : []) },
    }],
  };
};

test('matching verifier and auditor receipts are reused without another model call', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-reuse', reason: 'Review the boundary', paths: ['src/file.js'], evidenceIds: ['issue-reuse'] };
  const stagingLog = new InMemoryStagingLog();
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Review the boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-builder', 'orch-verifier', 'orch-auditor']);
    const reused = stagingLog.list({ runId: RUN_ID, type: 'review_evidence_reused' });
    assert.deepEqual(new Set(reused.map((event) => event.role)), new Set(['verifier', 'auditor']));
    const neutralReviewEvents = stagingLog.list({ runId: RUN_ID }).filter((event) => [
      'review_selected', 'review_target', 'review_result', 'review_evidence_reused',
    ].includes(event.type));
    assert.ok(neutralReviewEvents.length > 0);
    assert.ok(neutralReviewEvents.every((event) => event.problemId === null));
  }, { workspace, orchestrator: { stagingLog } });
});

test('a critical writable verifier receipt accepts a collected empty lane and unblocks the auditor', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-empty-verifier', reason: 'Review the boundary', paths: ['src/file.js'], evidenceIds: ['issue-empty'] };
  const stagingLog = new InMemoryStagingLog();
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed'),
    ],
    workerFinal(roleName) {
      if (roleName === 'orch-builder') return reviewWorkerFinal(roleName);
      const verifier = roleName === 'orch-verifier';
      const auditor = roleName === 'orch-auditor';
      const writerExecution = verifier ? {
        executionId: null,
        state: null,
        reason: null,
        effects: 'none',
        lane: { id: 'lane-empty-review', state: 'not_integrated', reason: 'no_changes' },
        delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
      } : undefined;
      const reviewResultMetadata = {
        policyId: 'auditor-routing/v1', kind: review.kind, checkpointId: review.checkpointId,
        status: 'accepted', accepted: true, valid: true, verdict: auditor ? 'pass' : null, reason: null,
      };
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        artifacts: [{
          name: 'report',
          parts: textParts(report(auditor ? 'VERDICT: pass\nThe declared scope is safe.' : 'Focused verification passed.', {
            filesInspected: ['src/file.js'],
            checks: [{ command: 'inspect', result: 'passed', detail: 'Scope checked.' }],
          })),
          metadata: {
            ...(writerExecution ? { writerExecution } : {}),
            reviewCoverage: { targetKnown: true, targetIdentity: 'stable-target', stable: true, status: 'accepted', reason: null },
            review: reviewResultMetadata,
          },
        }],
      };
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Review the boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.ok(world.dispatchInputs.some((input) => input.role === 'orch-auditor'));
    const receipts = stagingLog.list({ runId: RUN_ID, type: 'review_result' });
    assert.deepEqual(receipts.map((event) => [event.role, event.status]), [
      ['verifier', 'accepted'], ['auditor', 'accepted'],
    ]);
  }, { workspace, orchestrator: { stagingLog } });
});

test('routine material work gets a verifier without a periodic auditor', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'routine', checkpointId: 'routine-check', reason: 'Implement a bounded change', paths: ['src/file.js'], evidenceIds: ['issue-routine'] };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }),
      finish('Routine work verified'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Implement a bounded change', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-builder', 'orch-verifier']);
  }, { workspace });
});

test('structured problem and architecture records are written to the semantic event log', async () => {
  const problem = { id: 'problem-graph-1', kind: 'problem', status: 'open', summary: 'The review path was not logged.', evidenceIds: ['test/lead-graph.test.js'], relatedIds: [], adrPath: null };
  const architecture = { id: 'architecture-graph-1', kind: 'architecture', status: 'accepted', summary: 'Keep review receipts tied to current scoped content.', evidenceIds: ['test/lead-graph.test.js'], relatedIds: ['problem-graph-1'], adrPath: 'docs/adr/review-receipts.md' };
  const remedy = { id: 'remedy-graph-1', kind: 'remedy', status: 'implemented', summary: 'Persist the scope identity.', evidenceIds: ['test/lead-graph.test.js'], relatedIds: ['problem-graph-1'], adrPath: null };
  const verification = { id: 'verification-graph-1', kind: 'verification', status: 'tested', summary: 'Verify old IDs resolve across runs.', evidenceIds: ['test/lead-graph.test.js'], relatedIds: ['problem-graph-1'], adrPath: null };
  const stagingLog = new InMemoryStagingLog();
  const world = makeWorld({ script: [
    decision({ action: 'finish', final: 'Recorded the decision', records: [problem, architecture] }),
    decision({ action: 'finish', final: 'Recorded the remedy and verification', records: [remedy, verification] }),
  ] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Record a review decision', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const recorded = stagingLog.list({ runId: RUN_ID });
    assert.deepEqual(recorded.map((event) => event.type), ['problem_recorded', 'architecture_decision']);
    assert.equal(recorded[1].decisionId, architecture.id);
    assert.equal(recorded[1].payload.adrPath, architecture.adrPath);
    const followUp = await session.orchestrator.run({ goal: 'Verify the recorded review decision', runId: 'run-follow-up' });
    assert.equal(followUp.status, 'completed');
    const linked = stagingLog.list({ runId: 'run-follow-up' });
    assert.deepEqual(linked.map((event) => event.type), ['remedy_recorded', 'verification_recorded']);
    assert.ok(linked.every((event) => event.problemId === problem.id));
  }, { orchestrator: { stagingLog } });
});

test('malformed semantic records are rejected and reprompted before history lookup', async (t) => {
  const malformed = [
    ['object', {}],
    ['string', 'not an array'],
    ['null', null],
    ['null entry', [null]],
    ['invalid related ID type', [{ id: 'bad-ref', kind: 'remedy', status: 'implemented', summary: 'Bad reference', evidenceIds: [], relatedIds: [42], adrPath: null }]],
    ['credential-like record ID', [{ id: 'token=probe-secret', kind: 'problem', status: 'open', summary: 'Unsafe identity', evidenceIds: [], relatedIds: [], adrPath: null }]],
    ['credential-like related ID', [{ id: 'bad-related-ref', kind: 'remedy', status: 'implemented', summary: 'Unsafe related identity', evidenceIds: [], relatedIds: ['token=probe-secret'], adrPath: null }]],
    ['oversized related IDs', [{ id: 'too-many-refs', kind: 'remedy', status: 'implemented', summary: 'Too many references', evidenceIds: [], relatedIds: Array.from({ length: 21 }, (_, index) => `problem-${index}`), adrPath: null }]],
    ['oversized record list', Array.from({ length: 21 }, (_, index) => ({ id: `problem-${index}`, kind: 'problem', status: 'open', summary: 'Bounded problem record', evidenceIds: [], relatedIds: [], adrPath: null }))],
  ];
  for (const [label, records] of malformed) {
    await t.test(label, async () => {
      const storage = new InMemoryStagingLog();
      let historyQueries = 0;
      const stagingLog = {
        record: (event) => storage.record(event),
        list: (filter) => {
          if (filter?.type === 'problem_recorded') historyQueries += 1;
          return storage.list(filter);
        },
      };
      const world = makeWorld({ script: [decision({ records }), finish('Recovered after the invalid record proposal')] });
      await withSession(world, async (session) => {
        const result = await session.orchestrator.run({ goal: 'Record a decision', runId: RUN_ID });
        assert.equal(result.status, 'completed');
        assert.equal(world.leadTurns, 2);
        assert.match(world.prompts[1], /decision\.records records_invalid/);
        assert.equal(historyQueries, 0);
      }, { orchestrator: { stagingLog } });
    });
  }
});

test('a scoped content change invalidates matching receipts before reuse', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  const sourcePath = path.join(workspace, 'src', 'file.js');
  fs.writeFileSync(sourcePath, 'candidate one');
  const review = { kind: 'risk_change', checkpointId: 'critical-invalidate', reason: 'Review the boundary', paths: ['src/file.js'], evidenceIds: ['issue-invalidate'] };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      async () => {
        fs.writeFileSync(sourcePath, 'candidate two');
        return dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review });
      },
      finish('Reviewed the updated target'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Review the boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), [
      'orch-builder', 'orch-verifier', 'orch-auditor', 'orch-verifier', 'orch-auditor',
    ]);
  }, { workspace });
});

test('a same-checkpoint repair cannot let an unrelated writer pass a pending critical gate', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-3', reason: 'Change a trust boundary', paths: ['src/file.js'], evidenceIds: ['issue-3'] };
  const unrelated = { ...brief('orch-builder', ['src/other.js']), objective: 'Handle unrelated cleanup' };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }, unrelated),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Change a trust boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-builder', 'orch-verifier', 'orch-auditor']);
    assert.match(world.prompts[2], /Critical review checkpoint critical-3 remains pending/);
  }, { workspace });
});

test('scoped reviewers can complete separate critical checkpoints while both gates are pending', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  const firstPath = 'src/first.js';
  const secondPath = 'src/second.js';
  fs.writeFileSync(path.join(workspace, firstPath), 'first candidate');
  fs.writeFileSync(path.join(workspace, secondPath), 'second candidate');
  fs.writeFileSync(path.join(workspace, 'test/review.test.js'), '');
  const firstReview = {
    kind: 'risk_change', checkpointId: 'critical-first', reason: 'Review the first boundary',
    paths: [firstPath], evidenceIds: ['issue-first'],
  };
  const secondReview = {
    kind: 'risk_change', checkpointId: 'critical-second', reason: 'Review the second boundary',
    paths: [secondPath], evidenceIds: ['issue-second'],
  };
  const world = makeWorld({
    script: [
      dispatch(
        { ...brief('orch-builder', [firstPath]), review: firstReview },
        { ...brief('orch-verifier', ['test']), review: firstReview },
        { ...brief('orch-auditor', []), review: firstReview },
      ),
      dispatch({ ...brief('orch-builder', [secondPath]), review: secondReview }),
      async () => {
        fs.writeFileSync(path.join(workspace, firstPath), 'first candidate changed after review');
        return dispatch(
          { ...brief('orch-verifier', ['test']), review: firstReview },
          { ...brief('orch-verifier', ['test']), review: secondReview },
        );
      },
      dispatch(
        { ...brief('orch-auditor', []), review: firstReview },
        { ...brief('orch-auditor', []), review: secondReview },
      ),
      finish('Both critical checkpoints were reviewed'),
    ],
    workerFinal(roleName, _contextId, input) {
      const writer = roleName === 'orch-builder';
      const auditor = roleName === 'orch-auditor';
      const reviewedPath = input.review.paths[0];
      const summary = writer ? 'Implementation complete.'
        : auditor ? 'VERDICT: pass\nThe declared scope is safe.' : 'Focused verification passed.';
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        artifacts: [{
          name: 'report',
          parts: textParts(report(summary, {
            filesChanged: writer ? [reviewedPath] : [],
            filesInspected: writer ? [] : [reviewedPath],
            checks: writer ? [] : [{ command: 'node --test test/review.test.js', result: 'passed', detail: 'passed' }],
          })),
          metadata: { writerExecution: releasedWriter(writer ? [reviewedPath] : []) },
        }],
      };
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Review both trust boundaries', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), [
      'orch-builder', 'orch-verifier', 'orch-auditor', 'orch-builder',
      'orch-verifier', 'orch-verifier', 'orch-auditor', 'orch-auditor',
    ]);
  }, { workspace });
});

test('one linked prerequisite verifier is admitted and registered while critical gates are pending', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src/file.js'), 'candidate');
  const pending = { kind: 'risk_change', checkpointId: 'critical-pending', reason: 'Review the pending boundary', paths: ['src/file.js'], evidenceIds: ['issue-pending'] };
  const prerequisite = {
    kind: 'risk_change', checkpointId: 'critical-prerequisite', reason: 'Verify the prerequisite boundary',
    paths: ['src/file.js'], evidenceIds: ['issue-prerequisite'], prerequisiteFor: ['critical-pending'],
  };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review: pending }),
      dispatch(
        { ...brief('orch-verifier', ['test']), review: prerequisite, wave: 1 },
        { ...brief('orch-auditor', []), review: prerequisite, wave: 2 },
      ),
      dispatch({ ...brief('orch-verifier', ['test']), review: pending }),
      dispatch({ ...brief('orch-auditor', []), review: pending }),
      finish('Both critical checkpoints were reviewed'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Review a prerequisite boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), [
      'orch-builder', 'orch-verifier', 'orch-auditor', 'orch-verifier', 'orch-auditor',
    ]);
    assert.equal(world.dispatchInputs[1].review.prerequisiteFor[0], 'critical-pending');
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    const prerequisiteObligation = values.reviewObligations.find((entry) => entry.checkpointId === prerequisite.checkpointId);
    assert.deepEqual(prerequisiteObligation.receipts.map(({ role, status }) => [role, status]), [
      ['verifier', 'accepted'], ['auditor', 'accepted'],
    ]);
    const target = computeReviewTarget({
      workspace,
      review: prerequisite,
      runId: RUN_ID,
      goal: 'Review a prerequisite boundary',
      checks: [],
    });
    assert.equal(target.known, true);
    assert.ok(prerequisiteObligation.receipts.every((receipt) => receipt.targetIdentity === target.identity));
  }, { workspace });
});

test('prerequisite admission rejects an incomplete or over-broad link and a co-dispatched writer', async () => {
  const cases = [
    { name: 'missing', links: [] },
    { name: 'stale', links: ['critical-old'] },
    { name: 'partial', links: ['critical-a'] },
    { name: 'extra', links: ['critical-a', 'critical-extra'] },
    { name: 'unknown', links: ['critical-unknown'] },
    { name: 'multiple', links: ['critical-a'], duplicate: true },
    { name: 'writer', links: ['critical-a'], writer: true },
    { name: 'same-checkpoint-writer', links: ['critical-a'], sameCheckpointWriter: true },
    { name: 'existing', links: ['critical-a'], existing: true },
    { name: 'auditor', links: ['critical-a'], role: 'orch-auditor' },
  ];
  for (const entry of cases) {
    const workspace = gitRepo();
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'test'));
    fs.writeFileSync(path.join(workspace, 'src/file.js'), 'candidate');
    const first = { kind: 'risk_change', checkpointId: 'critical-a', reason: 'Review A', paths: ['src/file.js'], evidenceIds: ['issue-a'] };
    const linked = { ...first, checkpointId: entry.existing ? 'critical-a' : 'critical-new', reason: 'Verify a linked prerequisite', prerequisiteFor: entry.links };
    const invalid = [{ ...brief(entry.role || 'orch-verifier', entry.role === 'orch-auditor' ? [] : ['test']), review: linked }];
    if (entry.sameCheckpointWriter) {
      invalid.splice(0, 1,
        { ...brief('orch-builder', ['src/file.js']), review: first, wave: 1 },
        { ...invalid[0], wave: 2 });
    }
    if (entry.duplicate) invalid.push({ ...brief('orch-verifier', ['test']), review: { ...linked, checkpointId: 'critical-new-2' } });
    if (entry.writer) invalid.push({ ...brief('orch-builder', ['src/other.js']), objective: 'Unrelated writer' });
    const world = makeWorld({
      script: [
        dispatch({ ...brief('orch-builder', ['src/file.js']), review: first }),
        dispatch(...invalid),
        dispatch(
          { ...brief('orch-verifier', ['test']), review: first },
          ...(entry.name === 'partial' ? [{ ...brief('orch-verifier', ['test']), review: { ...first, checkpointId: 'critical-b', reason: 'Review B', evidenceIds: ['issue-b'] } }] : []),
          { ...brief('orch-auditor', []), review: first },
          ...(entry.name === 'partial' ? [{ ...brief('orch-auditor', []), review: { ...first, checkpointId: 'critical-b', reason: 'Review B', evidenceIds: ['issue-b'] } }] : []),
        ),
        finish('The original checkpoint was reviewed'),
      ],
      workerFinal: reviewWorkerFinal,
    });
    await withSession(world, async (session) => {
      let result;
      if (entry.name === 'partial') {
        const stopped = await session.orchestrator.run({ goal: `Reject prerequisite case ${entry.name}`, runId: RUN_ID, interruptAfter: ['dispatch'] });
        assert.equal(stopped.status, 'interrupted_for_test');
        const config = { configurable: { thread_id: RUN_ID } };
        const values = (await session.orchestrator.graph.getState(config)).values;
        const second = { ...first, checkpointId: 'critical-b', reason: 'Review B', evidenceIds: ['issue-b'] };
        await session.orchestrator.graph.updateState(config, {
          reviewObligations: [...values.reviewObligations, { checkpointId: second.checkpointId, review: second, pendingAssignmentIds: [], receipts: [] }],
        });
        await session.restart();
        result = await session.orchestrator.resume({ runId: RUN_ID });
      } else {
        result = await session.orchestrator.run({ goal: `Reject prerequisite case ${entry.name}`, runId: RUN_ID });
      }
      assert.equal(result.status, 'completed', entry.name);
      assert.deepEqual(world.dispatchInputs.map((input) => input.role), entry.name === 'partial'
        ? ['orch-builder', 'orch-verifier', 'orch-verifier', 'orch-auditor', 'orch-auditor']
        : ['orch-builder', 'orch-verifier', 'orch-auditor'], entry.name);
      assert.match(world.prompts[2], /Critical review checkpoint|prerequisite verifier|already has a pending/, entry.name);
    }, { workspace });
  }
});

test('a pending critical checkpoint cannot be downgraded or narrowed during repair', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-4', reason: 'Change a trust boundary', paths: ['src/file.js'], evidenceIds: ['issue-4'] };
  const downgraded = { ...review, kind: 'routine', paths: ['src'] };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-builder', ['src']), review: downgraded }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Change a trust boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-builder', 'orch-verifier', 'orch-auditor']);
    assert.match(world.prompts[2], /already has a pending or completed review context/);
  }, { workspace });
});

test('a rejected role-service audit result cannot become a graph receipt', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-service', reason: 'Review the boundary', paths: ['src/file.js'], evidenceIds: ['issue-service'] };
  let auditorCalls = 0;
  const stagingLog = new InMemoryStagingLog();
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed'),
    ],
    workerFinal(roleName, contextId, input) {
      const final = reviewWorkerFinal(roleName, contextId, input);
      if (roleName !== 'orch-auditor' || auditorCalls++ > 0) return final;
      final.message = {
        messageId: 'review-result',
        role: 2,
        parts: textParts('Audit service metadata reported a stale reservation.'),
        metadata: {
          review: {
          policyId: 'auditor-routing/v1', kind: review.kind, checkpointId: review.checkpointId,
          status: 'failed', accepted: false, valid: false, verdict: 'pass', reason: 'review reservation failed',
          },
        },
      };
      return final;
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Review the boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const auditorResults = stagingLog.list({ runId: RUN_ID, type: 'review_result' }).filter((event) => event.role === 'auditor');
    assert.deepEqual(auditorResults.map((event) => event.status), ['failed', 'accepted']);
    assert.equal(auditorResults[0].payload.serviceReviewAccepted, false);
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-builder', 'orch-verifier', 'orch-auditor', 'orch-auditor']);
  }, { workspace, orchestrator: { stagingLog } });
});

test('a review receipt persistence failure fails the graph closed', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-log', reason: 'Review the boundary', paths: ['src/file.js'], evidenceIds: ['issue-log'] };
  const persisted = new InMemoryStagingLog();
  const stagingLog = {
    record(event) {
      if (event.type === 'review_result') throw new Error('review result persistence failed');
      return persisted.record(event);
    },
    list(options) { return persisted.list(options); },
  };
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Must not accept'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    await assert.rejects(session.orchestrator.run({ goal: 'Review the boundary', runId: RUN_ID }), /review result persistence failed/);
    assert.equal(persisted.list({ runId: RUN_ID, type: 'review_result' }).length, 0);
    const state = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(state.values.result, null);
  }, { workspace, orchestrator: { stagingLog } });
});

test('a legacy pending batch resumes without review metadata and its old report does not satisfy a new gate', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const review = { kind: 'risk_change', checkpointId: 'critical-5', reason: 'Change a trust boundary', paths: ['src/file.js'], evidenceIds: ['issue-5'] };
  const world = makeWorld({
    script: [
      dispatch(brief('orch-builder')),
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      finish('The old outcome is enough'),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed'),
    ],
    workerFinal: reviewWorkerFinal,
  });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Change a trust boundary', runId: RUN_ID, interruptAfter: ['dispatch'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    const config = { configurable: { thread_id: RUN_ID } };
    const { batch } = (await session.orchestrator.graph.getState(config)).values;
    const items = batch.items.map((item) => {
      const { review: _review, ...assignment } = item.assignment;
      return { ...item, assignment };
    });
    await session.orchestrator.graph.updateState(config, { batch: { ...batch, items }, reviewObligations: [] });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-builder', 'orch-builder', 'orch-verifier', 'orch-auditor']);
    assert.match(world.prompts[3], /review_receipt_missing/);
    assert.equal(result.acceptance.disposition, 'unverified');
  }, { workspace });
});

test('verifier test writes can settle a review, while product and unknown mutations cannot', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  const testPath = path.join(workspace, 'test', 'review.test.js');
  const colocatedTestPath = path.join(workspace, 'src', 'review.test.js');
  const review = {
    kind: 'risk_change', checkpointId: 'critical-6', reason: 'Change a trust boundary',
    paths: ['src/file.js', 'src/review.test.js', 'test/review.test.js'], evidenceIds: ['issue-6'],
  };
  const stagingLog = new InMemoryStagingLog();
  let verifierCalls = 0;
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test/review.test.js']), review }, { ...brief('orch-auditor', []), review }),
      finish('Try to finish'),
      dispatch({ ...brief('orch-verifier', ['src']), review }, { ...brief('orch-auditor', []), review }),
      finish('Try broad product scope'),
      dispatch({ ...brief('orch-verifier', ['test/review.test.js']), review }, { ...brief('orch-auditor', []), review }),
      finish('Try again'),
      dispatch({ ...brief('orch-verifier', ['src/review.test.js']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed with colocated verification'),
    ],
    workerFinal(roleName, _contextId, input) {
      const writer = roleName === 'orch-builder';
      if (roleName === 'orch-verifier') verifierCalls += 1;
      const auditor = roleName === 'orch-auditor';
      let changedPaths = [];
      let known = true;
      let summary = 'Focused verification passed.';
      let filesChanged = [];
      let coverage = { targetKnown: true, targetIdentity: 'direct-review-target', stable: true, status: 'accepted', reason: null };
      if (writer) {
        changedPaths = ['src/file.js'];
        filesChanged = changedPaths;
        summary = 'Implementation complete.';
        coverage = undefined;
      } else if (roleName === 'orch-verifier' && verifierCalls === 1) {
        changedPaths = ['src/product.js'];
        filesChanged = changedPaths;
        coverage = { targetKnown: true, targetIdentity: 'direct-review-target', stable: false, status: 'inconclusive', reason: 'product path changed' };
      } else if (roleName === 'orch-verifier' && verifierCalls === 2) {
        changedPaths = ['src/review.test.js'];
        filesChanged = changedPaths;
        coverage = { targetKnown: true, targetIdentity: 'direct-review-target', stable: false, status: 'inconclusive', reason: 'broad product scope' };
      } else if (roleName === 'orch-verifier' && verifierCalls === 3) {
        known = false;
        coverage = { targetKnown: true, targetIdentity: 'direct-review-target', stable: false, status: 'inconclusive', reason: 'delta unavailable' };
      } else if (roleName === 'orch-verifier') {
        const allowedTest = input.allowedFiles.includes('src/review.test.js') ? 'src/review.test.js' : 'test/review.test.js';
        fs.writeFileSync(allowedTest === 'src/review.test.js' ? colocatedTestPath : testPath, 'assert.equal(1, 1);\n');
        changedPaths = [allowedTest];
        filesChanged = changedPaths;
        coverage = { targetKnown: true, targetIdentity: 'direct-post-review-target', stable: false, status: 'accepted', reason: 'verifier test write' };
      } else if (auditor) {
        summary = 'VERDICT: pass\nThe final target is safe.';
      }
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        artifacts: [{
          name: 'report',
          parts: textParts(report(summary, {
            filesChanged,
            filesInspected: writer ? [] : ['src/file.js'],
            checks: writer ? [] : [{ command: 'node --test test/review.test.js', result: 'passed', detail: 'passed' }],
          })),
          metadata: {
            writerExecution: { ...releasedWriter(changedPaths), delta: { ...releasedWriter(changedPaths).delta, known } },
            ...(coverage ? { reviewCoverage: coverage } : {}),
          },
        }],
      };
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Change a trust boundary', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(verifierCalls, 4);
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), [
      'orch-builder', 'orch-verifier', 'orch-verifier', 'orch-verifier', 'orch-verifier', 'orch-auditor',
    ]);
    const verifierResults = stagingLog.list({ runId: RUN_ID, type: 'review_result' }).filter((event) => event.role === 'verifier');
    assert.deepEqual(verifierResults.map((event) => event.status), ['inconclusive', 'inconclusive', 'inconclusive', 'accepted']);
    assert.equal(verifierResults[3].payload.verifierTestWrite, true);
    assert.ok(world.prompts.some((prompt) => prompt.includes('needs a passing verifier receipt')));
    assert.ok(world.dispatchInputs.some((input) => input.allowedFiles.length === 1 && input.allowedFiles[0] === 'src/review.test.js'));
  }, { workspace, orchestrator: { stagingLog } });
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


// ------------------------------------------------------------- SES-01 session threads

const SESSION = 'ctx-1';
// A turn's summed input can far exceed the context; rollover looks at contextTokens only.
const tokenUsage = (contextTokens, contextWindow = null, summed = 5 * contextTokens) => ({
  model: 'gpt-lead', tokens: { inputTokens: summed, totalTokens: summed }, tokenSource: 'total_delta', contextTokens, contextWindow,
});
const sessionWorld = (script) => Object.assign(makeWorld({ script }), { freshThreads: true });

test('full and resumed delta prompts carry the complete stored review context', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate\n');
  vcs(workspace, 'add', '.');
  vcs(workspace, 'commit', '-q', '-m', 'candidate');
  const review = {
    kind: 'risk_change',
    checkpointId: 'critical-context-transfer',
    reason: 'Review the trust boundary',
    paths: ['src/file.js'],
    evidenceIds: ['incident-17', 'decision-23'],
    prerequisiteFor: [],
  };
  const world = sessionWorld([
    dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
    dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
    finish('Reviewed'),
  ]);
  world.leadExtras = (turn) => ({ usage: tokenUsage(turn === 1 ? 200000 : 1000) });
  world.workerFinal = reviewWorkerFinal;

  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Review the boundary', runId: RUN_ID, contextId: SESSION, interruptAfter: ['verify'] });
    assert.equal(stopped.status, 'interrupted_for_test');

    const config = { configurable: { thread_id: RUN_ID } };
    const values = (await session.orchestrator.graph.getState(config)).values;
    assert.equal(values.reviewObligations.length, 1);
    const legacyObligation = {
      ...values.reviewObligations[0],
      review: { ...values.reviewObligations[0].review },
    };
    delete legacyObligation.review.prerequisiteFor;
    await session.orchestrator.graph.updateState(config, {
      reviewObligations: [legacyObligation],
    });

    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.threadArgs, [undefined, undefined, 'thread-2']);

    const extract = (prompt) => {
      const match = /Checkpoint review obligations[^\n]*\n(\[[^\n]*\])/.exec(prompt);
      assert.ok(match, 'prompt contains serialized checkpoint review obligations');
      return JSON.parse(match[1])[0].review;
    };
    const expected = { ...review, prerequisiteFor: [] };
    assert.deepEqual(extract(world.prompts[1]), expected);
    assert.deepEqual(extract(world.prompts[2]), expected);
    assert.match(world.prompts[1], /reuse each review object exactly as stored/i);
    assert.match(world.prompts[2], /reuse each review object exactly as stored/i);
    assert.doesNotMatch(world.prompts[2], /Available roles:|User goal:/);
  }, { withSessions: true, workspace });
});

test('the second round of a session resumes the same thread with a delta prompt that carries the new outcomes', async () => {
  const world = sessionWorld([dispatch(brief('orch-explorer', [])), finish('Done')]);
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look around', runId: RUN_ID, contextId: SESSION });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1']);
    assert.match(world.prompts[0], /Available roles:/);
    assert.match(world.prompts[0], /exact file paths with line ranges and the facts already established/);
    assert.match(world.prompts[0], /User goal:\nLook around/);
    assert.doesNotMatch(world.prompts[1], /Available roles:|Available skill IDs|User goal:/);
    assert.match(world.prompts[1], /Worker outcomes since your last turn/);
    assert.match(world.prompts[1], /orch-explorer done/);
    assert.match(world.prompts[1], /Dispatch rounds already used: 1\. Dispatch rounds are unlimited/);
    assert.match(world.prompts[1], /Open worker decisions/);
    assert.match(world.prompts[1], /still apply\. Return only one JSON object/);
    assert.match(world.prompts[1], /exact paths with line ranges.*dispatch an explorer for broad reading/);
    assert.ok(world.prompts[1].length < world.prompts[0].length / 2);
    const row = session.sessions.get(SESSION);
    assert.equal(row.threadId, 'thread-1');
    assert.deepEqual(row.runIds, [RUN_ID]);
    assert.equal(row.rollovers, 0);
  }, { withSessions: true });
});

test('a follow-up run in the same session resumes the thread and shows the new owner message verbatim', async () => {
  const world = sessionWorld([finish('First answer'), finish('Second answer')]);
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'First task', runId: RUN_ID, contextId: SESSION });
    const result = await session.orchestrator.run({
      goal: 'This is a follow-up ... composed goal text ... New request: Now do X',
      newRequest: 'Now do X, exactly',
      runId: 'run-2',
      contextId: SESSION,
    });
    assert.equal(result.text, 'Second answer');
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1']);
    assert.match(world.prompts[1], /New message from the owner[^\n]*\nNow do X, exactly/);
    assert.doesNotMatch(world.prompts[1], /composed goal text|Available roles:/);
    assert.match(world.prompts[1], /Available skill candidates/);
    assert.deepEqual(session.sessions.get(SESSION).runIds, [RUN_ID, 'run-2']);
  }, { withSessions: true });
});

test('a lead thread above the input-token threshold rolls over to a new thread with the full prompt and a session digest', async () => {
  const world = sessionWorld([finish('First answer'), dispatch(brief('orch-explorer', [])), finish('Second answer')]);
  world.leadExtras = (n) => ({ usage: tokenUsage(n === 1 ? 200000 : 1000) });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'First task', runId: RUN_ID, contextId: SESSION });
    assert.equal(session.sessions.get(SESSION).lastInputTokens, 200000);
    const result = await session.orchestrator.run({ goal: 'Second task', runId: 'run-2', contextId: SESSION });
    assert.equal(result.text, 'Second answer');
    assert.deepEqual(world.threadArgs.slice(0, 2), [undefined, undefined]);
    assert.match(world.prompts[1], /Available roles:/);
    assert.match(world.prompts[1], /Session so far/);
    assert.match(world.prompts[1], /Earlier runs in this session[^]*run-1[^]*final: First answer/);
    assert.match(world.prompts[1], /Current run so far/);
    // The new thread is small, so the next turn resumes it with a delta prompt and no digest.
    assert.equal(world.threadArgs[2], 'thread-2');
    assert.doesNotMatch(world.prompts[2], /Session so far|Available roles:/);
    const row = session.sessions.get(SESSION);
    assert.equal(row.threadId, 'thread-2');
    assert.equal(row.rollovers, 1);
  }, { withSessions: true });
  // At exactly the threshold the thread is kept.
  const keep = sessionWorld([finish('A'), finish('B')]);
  keep.leadExtras = () => ({ usage: tokenUsage(150000) });
  await withSession(keep, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(keep.threadArgs, [undefined, 'thread-1']);
  }, { withSessions: true });
});

test('a large summed input with a small context keeps the thread; an unknown context never rolls over', async () => {
  const world = sessionWorld([finish('A'), finish('B'), finish('C')]);
  world.leadExtras = (n) => ({ usage: n === 2 ? { model: 'gpt-lead', tokens: { inputTokens: 900000 }, tokenSource: 'total_delta' } : tokenUsage(20000, null, 400000) });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    assert.equal(session.sessions.get(SESSION).lastInputTokens, 20000);
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.equal(session.sessions.get(SESSION).lastInputTokens, null);
    await session.orchestrator.run({ goal: 'C', runId: 'run-3', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1', 'thread-1']);
    assert.equal(session.sessions.get(SESSION).rollovers, 0);
  }, { withSessions: true });
});

test('a context above 60% of the model window rolls over, below it does not', async () => {
  const over = sessionWorld([finish('A'), finish('B')]);
  over.leadExtras = () => ({ usage: tokenUsage(61000, 100000) });
  await withSession(over, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    assert.equal(session.sessions.get(SESSION).contextWindow, 100000);
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(over.threadArgs, [undefined, undefined]);
    assert.equal(session.sessions.get(SESSION).rollovers, 1);
  }, { withSessions: true });
  const under = sessionWorld([finish('A'), finish('B')]);
  under.leadExtras = () => ({ usage: tokenUsage(60000, 100000) });
  await withSession(under, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(under.threadArgs, [undefined, 'thread-1']);
  }, { withSessions: true });
});

test('the explicit rollover setting wins over the window fraction', async () => {
  const world = sessionWorld([finish('A'), finish('B')]);
  world.leadExtras = () => ({ usage: tokenUsage(30000, 1000000) });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, undefined]);
  }, { withSessions: true, orchestrator: { rolloverTokens: 20000 } });
});

test('the rollover threshold comes from CODEX_A2A_LEAD_ROLLOVER_TOKENS through the orchestrator option', async () => {
  const world = sessionWorld([finish('A'), finish('B')]);
  world.leadExtras = () => ({ usage: tokenUsage(600) });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, undefined]);
    assert.equal(session.sessions.get(SESSION).rollovers, 1);
  }, { withSessions: true, orchestrator: { rolloverTokens: 500 } });
});

test('a different Codex home starts a new thread with the full prompt and records the new home', async () => {
  const world = sessionWorld([finish('A'), finish('B')]);
  world.codexHome = '/homes/a';
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    assert.equal(session.sessions.get(SESSION).codexHome, '/homes/a');
    world.codexHome = '/homes/b';
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, undefined]);
    assert.match(world.prompts[1], /Available roles:/);
    assert.match(world.prompts[1], /Session so far/);
    const row = session.sessions.get(SESSION);
    assert.equal(row.codexHome, '/homes/b');
    assert.equal(row.threadId, 'thread-2');
    assert.equal(row.rollovers, 1);
  }, { withSessions: true });
});

test('a rejected resume retries once on a new thread with the full prompt and counts a rollover', async () => {
  const rejected = (args) => { throw Object.assign(new Error('thread not found'), { failureClass: 'request_rejected', args }); };
  const world = sessionWorld([finish('A'), rejected, finish('B')]);
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    const result = await session.orchestrator.run({ goal: 'B task', runId: 'run-2', contextId: SESSION });
    assert.equal(result.text, 'B');
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1', undefined]);
    assert.doesNotMatch(world.prompts[1], /Available roles:/);
    assert.match(world.prompts[2], /Available roles:/);
    assert.match(world.prompts[2], /Session so far/);
    const row = session.sessions.get(SESSION);
    assert.equal(row.threadId, 'thread-2');
    assert.equal(row.rollovers, 1);
  }, { withSessions: true });

  // An unknown outcome or another failure class is not retried.
  const unknown = sessionWorld([finish('A'), (args) => { throw Object.assign(new Error('lost'), { failureClass: 'request_rejected', outcomeUnknown: true, args }); }]);
  await withSession(unknown, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    await assert.rejects(session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION }), /lost/);
    assert.equal(unknown.leadTurns, 2);
  }, { withSessions: true });
});

test('a rejection retry keeps the current thread and feeds the violations in a delta prompt', async () => {
  const world = sessionWorld([dispatch(brief('orch-builder', ['src/*'])), dispatch(brief('orch-builder')), finish('Fixed')]);
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contextId: SESSION });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1', 'thread-1']);
    assert.match(world.prompts[1], /Rejected decision:/);
    assert.match(world.prompts[1], /assignment\.paths path_glob_unsupported/);
    assert.doesNotMatch(world.prompts[1], /Available roles:/);
    assert.doesNotMatch(world.prompts[2], /Rejected decision:/);
    // The outcome of the dispatched worker is shown once, in the turn after it finished.
    assert.doesNotMatch(world.prompts[1], /Worker outcomes since your last turn/);
    assert.match(world.prompts[2], /Worker outcomes since your last turn/);
    assert.equal(session.sessions.get(SESSION).rollovers, 0);
  }, { withSessions: true });
});

test('verifier scope rejection explains recovery and accepts an explicit existing test path', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
  fs.writeFileSync(path.join(workspace, 'test', 'review.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\ntest('source file exists', () => assert.ok(fs.existsSync('src/file.js')));\n");
  const review = {
    kind: 'routine',
    checkpointId: 'verifier-scope-recovery',
    reason: 'Verify the changed source',
    paths: ['src/file.js'],
    evidenceIds: ['issue-verifier-scope'],
  };
  const world = sessionWorld([
    dispatch({ ...brief('orch-verifier', []), review }),
    dispatch({ ...brief('orch-verifier', ['test/review.test.js']), review }),
    finish('Verified the scoped change'),
  ]);
  world.workerFinal = reviewWorkerFinal;
  const stagingLog = new InMemoryStagingLog();
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({
      goal: 'Verify the changed source', runId: RUN_ID, contextId: SESSION,
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'unverified');
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1', 'thread-1']);
    assert.equal(world.leadTurns, 3);
    assert.equal(world.sends.length, 1);
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-verifier']);
    assert.deepEqual(world.dispatchInputs[0].allowedFiles, ['test/review.test.js']);

    assert.match(world.prompts[0], /Available roles:/);
    assert.match(world.prompts[0], /Use exact role IDs shown in Available roles, not display labels/);
    assert.match(world.prompts[0], /Every writable role, including orch-verifier, requires explicit allowedFiles/);
    assert.match(world.prompts[0], /writable roles need 1-20 entries/);
    assert.match(world.prompts[0], /without '\.', '\.\.', globs/);

    assert.match(world.prompts[1], /Rejected decision:/);
    assert.match(world.prompts[1], /assignment\.writer_scope writer_scope_missing/);
    assert.match(world.prompts[1], /Writable role orch-verifier requires explicit allowedFiles/);
    assert.match(world.prompts[1], /choose 1-20 bounded existing test\/check paths/);
    assert.match(world.prompts[1], /allowedFiles grants write permission but does not require edits/);
    assert.match(world.prompts[1], /Do not use \[\] or guess\/expand paths/);
    assert.match(world.prompts[1], /dispatch a read-only explorer first if those paths are unknown/);

    assert.match(world.prompts[2], /Every writable role, including orch-verifier, requires explicit allowedFiles/);
    assert.match(world.prompts[2], /writable roles need 1-20 entries/);
    const reviewResults = stagingLog.list({ runId: RUN_ID, type: 'review_result' });
    assert.equal(reviewResults.length, 1);
    assert.equal(reviewResults[0].role, 'verifier');
    assert.equal(reviewResults[0].status, 'accepted');
  }, { workspace, withSessions: true, orchestrator: { stagingLog } });
});

test('resuming a rejected verifier decision reuses or rolls over the session thread by profile', async (t) => {
  const runCase = async (profileChanged) => {
    const workspace = gitRepo();
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'test'));
    fs.writeFileSync(path.join(workspace, 'src', 'file.js'), 'candidate');
    fs.writeFileSync(path.join(workspace, 'test', 'review.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\ntest('source file exists', () => assert.ok(fs.existsSync('src/file.js')));\n");
    const review = {
      kind: 'routine',
      checkpointId: `resumed-verifier-scope-${profileChanged ? 'changed' : 'same'}`,
      reason: 'Verify the changed source',
      paths: ['src/file.js'],
      evidenceIds: ['issue-resumed-verifier-scope'],
    };
    const world = sessionWorld([
      dispatch({ ...brief('orch-verifier', []), review }),
      dispatch({ ...brief('orch-verifier', ['test/review.test.js']), review }),
      finish('Verified the scoped change'),
    ]);
    world.workerFinal = reviewWorkerFinal;
    const stagingLog = new InMemoryStagingLog();
    const baseLead = createLeadRole();
    const options = {
      withSessions: true,
      orchestrator: { leadRole: baseLead, stagingLog },
    };
    await withSession(world, async (session) => {
      const stopped = await session.orchestrator.run({
        goal: 'Verify the changed source', runId: RUN_ID, contextId: SESSION, interruptAfter: ['decide'],
      });
      assert.equal(stopped.status, 'interrupted_for_test');
      assert.equal(world.leadTurns, 1);
      const checkpoint = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
      assert.equal(checkpoint.values.retryDecide, true);

      if (profileChanged) {
        options.orchestrator.leadRole = {
          ...baseLead,
          instructions: `${baseLead.instructions}\nChanged lead profile for resume test.`,
        };
      }
      await session.restart();
      const result = await session.orchestrator.resume({ runId: RUN_ID, contextId: SESSION });
      assert.equal(result.status, 'completed');
      assert.equal(result.acceptance.disposition, 'unverified');
      assert.deepEqual(world.dispatchInputs.map((input) => input.role), ['orch-verifier']);
      assert.deepEqual(world.dispatchInputs[0].allowedFiles, ['test/review.test.js']);
      const reviewResults = stagingLog.list({ runId: RUN_ID, type: 'review_result' });
      assert.equal(reviewResults.length, 1);
      assert.equal(reviewResults[0].role, 'verifier');
      assert.equal(reviewResults[0].status, 'accepted');

      if (profileChanged) {
        assert.deepEqual(world.threadArgs, [undefined, undefined, 'thread-2']);
        assert.match(world.prompts[1], /Available roles:/);
      } else {
        assert.deepEqual(world.threadArgs, [undefined, 'thread-1', 'thread-1']);
        assert.doesNotMatch(world.prompts[1], /Available roles:/);
      }
      assert.match(world.prompts[1], /Rejected decision:/);
      assert.match(world.prompts[1], /assignment\.writer_scope writer_scope_missing/);
      assert.match(world.prompts[1], /Every writable role, including orch-verifier, requires explicit allowedFiles/);
      assert.match(world.prompts[1], /writable roles need 1-20 entries/);
    }, { workspace, ...options });
  };

  await t.test('unchanged profile resumes the rejected decision on its existing thread', () => runCase(false));
  await t.test('changed profile gets a new thread and the full rejected decision guidance', () => runCase(true));
});

test('without a contextId the lead behaves as before: no session row, a fresh thread per round', async () => {
  const world = sessionWorld([dispatch(brief('orch-explorer', [])), finish('Done')]);
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.threadArgs, [undefined, undefined]);
    assert.match(world.prompts[1], /Available roles:/);
    assert.match(world.prompts[1], /Prior worker outcomes/);
    assert.equal(session.sessions.get(SESSION), null);
  }, { withSessions: true });
});

test('a run resumed after a restart still uses the session thread, and an old checkpoint without session channels works', async () => {
  const world = sessionWorld([dispatch(brief('orch-explorer', [])), finish('Done')]);
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID, contextId: SESSION, interruptAfter: ['decide'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID, contextId: SESSION });
    assert.equal(result.status, 'completed');
    assert.equal(world.threadArgs[1], 'thread-1');
    assert.doesNotMatch(world.prompts[1], /Available roles:/);
  }, { withSessions: true });
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
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(paused.pause.question, /failed validation 3 times.*path_glob_unsupported/);
    assert.equal(world.leadTurns, 3);
    assert.equal(world.sends.length, 0);
  });
});

test('a resume after the rejection pause allows two automatic retries again', async () => {
  const bad = dispatch(brief('orch-builder', ['src/*']));
  const world = makeWorld({ script: [bad, bad, bad, bad, bad, finish('Done')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(paused.pause.question, /failed validation 3 times/);
    assert.equal(world.leadTurns, 3);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Retry the decision', choice: 'continue' } });
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
      assert.match(world.prompts[0], /skills, wave, continueFrom, review, and repair/);
      assert.match(world.prompts[0], /directory prefixes that cover the module and its tests/);
      assert.match(world.prompts[0], /scopeExpansion[^\n]*continueFrom[^\n]*expanded allowedFiles/);
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

// ----------------------------------------------------- continuation of limited attempts (BUD-2)

const limitedTask = (n, { continuation = true } = {}) => ({
  state: TaskState.TASK_STATE_FAILED,
  message: {
    messageId: `m-${n}`,
    role: 2,
    parts: textParts('usage limit reached'),
    metadata: {
      failureKind: 'usage_limit',
      effects: 'none',
      ...(continuation ? { continuation: { threadId: `th-${n}`, laneId: null, codexHome: null } } : {}),
    },
  },
});
const contextOfAssignment = (id) => deterministicContextId(attemptId(id));

test('a usage-limited writer is continued after the budget resume without a lead turn', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => (contextId === contextOfAssignment(assignmentId(RUN_ID, 1, 0))
      ? limitedTask(1) : okWriterFinal()(roleName, contextId)),
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    assert.equal(world.sends.length, 1);
    assert.equal(world.dispatchInputs[0].continuation, undefined);

    const stopped = await session.orchestrator.resume({ runId: RUN_ID, interruptAfter: ['continue_limited'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(snapshot.values.round, 1);
    assert.equal(world.leadTurns, 1);
    assert.equal(snapshot.values.batch.items[0].assignmentId, `${assignmentId(RUN_ID, 1, 0)}:c1`);

    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.rounds, 1);
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 2);
    const sent = world.dispatchInputs[1];
    assert.equal(sent.assignmentId, `${assignmentId(RUN_ID, 1, 0)}:c1`);
    assert.deepEqual(sent.continuation, { ofAttemptId: attemptId(assignmentId(RUN_ID, 1, 0)), threadId: 'th-1', laneId: null, codexHome: null });
    assert.equal(sent.objective, world.dispatchInputs[0].objective);
    assert.deepEqual(sent.allowedFiles, world.dispatchInputs[0].allowedFiles);
    const continuedAttempt = attemptId(`${assignmentId(RUN_ID, 1, 0)}:c1`);
    assert.equal(world.sends[1], deterministicContextId(continuedAttempt));
    assert.equal(session.journal.get(continuedAttempt).state, 'finished');
    assert.match(world.prompts[1], /usage_limit/);
    assertAtMostOneSendPerContext(world);
  });
});

test('a usage-limited auditor cannot continue across a changed target and a fresh audit is dispatched', async () => {
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  const sourcePath = path.join(workspace, 'src', 'file.js');
  fs.writeFileSync(sourcePath, 'candidate one');
  const review = { kind: 'risk_change', checkpointId: 'critical-usage', reason: 'Review a trust boundary', paths: ['src/file.js'], evidenceIds: ['issue-usage'] };
  let auditorCalls = 0;
  const world = makeWorld({
    script: [
      dispatch({ ...brief('orch-builder', ['src/file.js']), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      dispatch({ ...brief('orch-verifier', ['test']), review }, { ...brief('orch-auditor', []), review }),
      finish('Reviewed the current target'),
    ],
    workerFinal(roleName, contextId, input) {
      if (roleName === 'orch-auditor' && auditorCalls++ === 0) return limitedTask(1);
      return reviewWorkerFinal(roleName, contextId, input);
    },
  });
  const stagingLog = new InMemoryStagingLog();
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Review a trust boundary', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    fs.writeFileSync(sourcePath, 'candidate two');
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(world.dispatchInputs.map((input) => input.role), [
      'orch-builder', 'orch-verifier', 'orch-auditor', 'orch-verifier', 'orch-auditor',
    ]);
    assert.equal(world.sends.length, 5, 'the stale limited continuation was skipped before submission');
    assert.ok(stagingLog.list({ runId: RUN_ID, type: 'review_gate_skipped' })
      .some((event) => event.status === 'stale_review_continuation'));
    assert.ok(stagingLog.list({ runId: RUN_ID, type: 'review_target' })
      .some((event) => event.status === 'stale' && event.payload.phase === 'before_continuation'));
  }, { workspace, orchestrator: { stagingLog } });
});

test('limited items of one wave are continued concurrently under parallelWriters', async () => {
  const seen = [];
  const limitedContexts = new Set([0, 1].map((index) => contextOfAssignment(assignmentId(RUN_ID, 1, index))));
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 1)), finish('Done')],
    workerFinal: (roleName, contextId) => (limitedContexts.has(contextId) ? limitedTask(contextId.slice(0, 4)) : okWriterFinal()(roleName, contextId)),
    pollsNeeded: 1,
  });
  world.getTaskFault = (id, count) => { if (count === 1) seen.push(world.sends.length); };
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 4);
    assert.deepEqual(seen, [2, 2, 4, 4]);
    assert.deepEqual(world.dispatchInputs.slice(2).map((input) => input.assignmentId).sort(),
      [0, 1].map((index) => `${assignmentId(RUN_ID, 1, index)}:c1`));
    assert.equal(result.rounds, 1);
  }, withWriters);
});

test('without parallelWriters the continuations run one at a time', async () => {
  const seen = [];
  const limitedContexts = new Set([0, 1].map((index) => contextOfAssignment(assignmentId(RUN_ID, 1, index))));
  const world = makeWorld({
    script: [dispatch(waveBrief('orch-builder', ['src/a.js'], 1), waveBrief('orch-builder', ['src/b.js'], 1)), finish('Done')],
    workerFinal: (roleName, contextId) => (limitedContexts.has(contextId) ? limitedTask(contextId.slice(0, 4)) : okWriterFinal()(roleName, contextId)),
    pollsNeeded: 1,
  });
  world.getTaskFault = (id, count) => { if (count === 1) seen.push(world.sends.length); };
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.deepEqual(seen.slice(2), [3, 4]);
  });
});

test('a third usage limit on the same assignment is not continued', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Gave up')], workerFinal: () => limitedTask(world.sends.length) });
  await withSession(world, async (session) => {
    let result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'waiting_for_budget');
    result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'waiting_for_budget');
    assert.equal(world.sends.length, 2);
    result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'waiting_for_budget');
    assert.equal(world.sends.length, 3);
    assert.equal(world.leadTurns, 1);
    result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 3);
    assert.equal(world.leadTurns, 2);
    const base = assignmentId(RUN_ID, 1, 0);
    assert.deepEqual(world.dispatchInputs.map((input) => input.assignmentId), [base, `${base}:c1`, `${base}:c2`]);
    assert.equal(world.dispatchInputs[2].continuation.ofAttemptId, attemptId(`${base}:c1`));
    assert.equal(result.rounds, 1);
  });
});

test('no continuation for a non-limit failure or a limit without a continuation', async () => {
  const failed = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Handled')],
    workerFinal: () => ({ state: TaskState.TASK_STATE_FAILED, message: { messageId: 'm', role: 2, parts: textParts('boom'), metadata: { failureKind: 'other', effects: 'none' } } }),
  });
  await withSession(failed, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(failed.sends.length, 1);
  });
  const bare = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Handled')], workerFinal: () => limitedTask(1, { continuation: false }) });
  await withSession(bare, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(bare.sends.length, 1);
    assert.equal(bare.leadTurns, 2);
  });
});

test('a checkpoint without the continuable channel resumes to decide as before', async () => {
  const world = makeWorld({ script: [usageLimitError(), finish('Recovered')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Work', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    const snapshot = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(snapshot.values.continuable, []);
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 0);
  });
});

// ------------------------------------------------- LL-1: escalation instead of looping

const notMet = (final) => decision({ action: 'finish', final, goalAchieved: false });
const met = (final, extra = {}) => decision({ action: 'finish', final, goalAchieved: true, ...extra });
const ESCALATION_IDS = ['continue', 'accept_as_is', 'change_goal'];

// LL-6: the first unmet-goal finish only buys an investigation; the second one, citing it, pauses.
const INVESTIGATION_ID = assignmentId(RUN_ID, 1, 0);
const toGoalPause = (secondFinal) => [notMet('Blocked: the gate needs live runtime qualification.'), dispatch(brief('orch-explorer', [])), notMet(secondFinal)];
const cited = (text) => `${text} Evidence: ${INVESTIGATION_ID}.`;

test('the first unmet-goal finish requests investigation without an owner pause', async () => {
  const world = makeWorld({ script: [notMet('Blocked: the matrix has hard-coded counts.'), dispatch(brief('orch-explorer', [])), met('Fixed the counts')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Close M3', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Fixed the counts');
    assert.equal(world.leadTurns, 3);
    assert.match(world.prompts[1], /Dispatch rounds already used: 0\. Dispatch rounds are unlimited; the count is for ordering only\./);
    assert.match(world.prompts[1], /Goal investigation \(requested in round 0\): your finish with goalAchieved false named these blockers:\nBlocked: the matrix has hard-coded counts\./);
    assert.match(world.prompts[1], /cites the assignmentId of a read-only investigation finished after round 0 and states why each remaining blocker is owner-only/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.extraRounds, 0);
    assert.deepEqual(values.goalInvestigation, { round: 0, final: 'Blocked: the matrix has hard-coded counts.' });
  });
});

test('a second unmet-goal finish pauses only with a cited investigation from after the first one', async () => {
  const world = makeWorld({ script: [...toGoalPause('Still blocked.'), notMet(cited('x'.repeat(5000))), notMet(cited('The gate needs a paid device farm.'))] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Close M3', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.match(world.prompts[3], /decision\.investigate_first investigation_missing: A repeated finish with goalAchieved false needs a finished read-only investigation from a round after 0/);
    assert.match(world.prompts[3], /Investigate first: dispatch a read-only explorer first; use auditor only for a concrete risk-boundary question/);
    const { pause } = paused;
    assert.equal(pause.kind, 'human_decision');
    assert.equal(pause.escalation, 'goal_not_achieved');
    assert.equal(pause.question.length, 3000);
    assert.deepEqual(pause.options.map((option) => option.id), ESCALATION_IDS);
    assert.equal(pause.recommendation, 'continue');
    assert.equal(pause.decisionId, `${RUN_ID}:h1`);
    assert.equal('final' in pause, false);
    assert.match(pause.message, /Human decision needed \(goal_not_achieved\)/);
    await assert.rejects(session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'x', choice: 'retry' } }), /choice must match/);
    const again = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Go on', choice: 'continue' } });
    assert.equal(again.pause.escalation, 'goal_not_achieved');
    assert.match(again.pause.question, /paid device farm/);
  });
});

test('continue grants another maxRounds budget and passes the note to the lead', async () => {
  const world = makeWorld({ script: [...toGoalPause(cited('Blocked on B.')), finish('Done')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Do A', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'goal_not_achieved');
    assert.match(world.prompts[2], /Dispatch rounds already used: 1\. Dispatch rounds are unlimited/);
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Try the other path', choice: 'continue' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Done');
    assert.match(world.prompts[3], /Dispatch rounds already used: 1\. Dispatch rounds are unlimited/);
    assert.match(world.prompts[3], /"answer":"Try the other path","choice":"continue"/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.extraRounds, 0);
  });
});

test('an answer without a choice on an escalation is the recommended continue', async () => {
  const world = makeWorld({ script: [...toGoalPause(cited('Blocked.')), finish('Done')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Do A', runId: RUN_ID });
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Keep going' } });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[3], /Dispatch rounds already used: 1\. Dispatch rounds are unlimited/);
  });
});

test('accept_as_is finishes with the lead final text and acceptance still runs', async () => {
  const workspace = gitRepo();
  let runs = 0;
  const runCheckImpl = async (check) => {
    runs += 1;
    return { id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' };
  };
  const final = cited('Partial: 50 of 52 rows need a paid qualification run.');
  const world = makeWorld({ script: toGoalPause(final) });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Close M3', runId: RUN_ID, contract: contractOf(nodeCheck('unit', 'process.exit(0)')) });
    assert.equal(paused.pause.escalation, 'goal_not_achieved');
    assert.equal(runs, 0);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Ship what we have', choice: 'accept_as_is', decisionId: `${RUN_ID}:h1` } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, final);
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(runs, 1);
    assert.equal(world.leadTurns, 3);
  }, { workspace, orchestrator: { runCheckImpl } });
});

test('change_goal replaces the goal for the rest of the run with a fresh budget; state.goal stays', async () => {
  const world = makeWorld({ script: [...toGoalPause(cited('Cannot do X without a paid vendor license.')), finish('Did Y')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Do X', runId: RUN_ID });
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Only do Y', choice: 'change_goal' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Did Y');
    assert.match(world.prompts[3], /Goal \(changed by the owner during this run; authoritative, it replaces the original goal\):\nOnly do Y/);
    assert.match(world.prompts[3], /Original goal \(background only\):\nDo X/);
    assert.doesNotMatch(world.prompts[3], /User goal:/);
    assert.match(world.prompts[3], /Dispatch rounds already used: 1\. Dispatch rounds are unlimited/);
    assert.match(world.prompts[3], /"answer":"Only do Y","choice":"change_goal"/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.goal, 'Do X');
    assert.equal(values.goalOverride, 'Only do Y');
    assert.equal(await session.orchestrator.getRunGoal(RUN_ID), 'Do X');
  });
});

test('the round limit pauses with round_limit and continue grants another budget', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), dispatch(brief('orch-explorer', [])), dispatch(brief('orch-explorer', [])), finish('Done')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'human_decision');
    assert.equal(paused.pause.escalation, 'round_limit');
    assert.match(paused.pause.question, /1 of 1 rounds used/);
    assert.deepEqual(paused.pause.options.map((option) => option.id), ESCALATION_IDS);
    assert.equal(world.sends.length, 1);
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'One more', choice: 'continue' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.rounds, 2);
    assert.equal(world.sends.length, 2);
    assert.match(world.prompts[2], /Dispatch rounds already used: 1\/2\./);
    assert.match(world.prompts[3], /Dispatch rounds already used: 2\/2\./);
  }, { orchestrator: { maxRounds: 1 } });
});

test('a finish with goalAchieved null is rejected with a reminder', async () => {
  const world = makeWorld({ script: [decision({ action: 'finish', final: 'Done?', goalAchieved: null }), met('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Do A', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[1], /decision\.goal goal_unstated: finish requires goalAchieved true or false/);
    assert.match(world.prompts[1], /finish requires goalAchieved true or false: true only when the goal is met/);
  });
});

test('the decision prompt carries the investigate-first, owner-only, goalAchieved, round, and acceptanceChecks rules', async () => {
  const world = makeWorld({ script: [met('Done')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Do A', runId: RUN_ID });
    const [prompt] = world.prompts;
    assert.match(prompt, /Investigate first: never ask the owner what investigation can answer/);
    assert.match(prompt, /Owner-only decisions are a closed list \(humanInput\.reason\): paid_resources \(spending money or paid resources beyond the run\), credentials_or_access \(credentials and access grants\), external_write \(publishing or writing to external systems\), irreversible_operation, prd_requirement_change \(removing or weakening a requirement the PRD states\), and infeasible_requirement \(an investigation proved that a requirement cannot be met because a dependency or the environment lacks a capability; cite the exact version or setting and the evidence; options must include substitute evidence, changing the dependency or environment, and deferring the requirement\)\. Interpreting the PRD, choosing an implementation, and expanding file scope are your decisions after investigation\. Fixing evidence tooling means collecting or presenting evidence the platform already provides; building a substitute for a capability the platform lacks is scope expansion that needs the owner\./);
    assert.match(prompt, /request_human_input is accepted only for an owner-only decision and only after an investigation of that blocker: An investigation is a finished read-only outcome/);
    assert.match(prompt, /A blocker that persists needs its root cause located \(an explorer first; use an auditor only for a concrete risk-boundary question, or scout\/architect when appropriate\)\. Once an investigation locates it outside what the team may change \(a missing capability of a dependency or the environment, or the requirement itself\), stop investigating that blocker and escalate it\./);
    assert.match(prompt, /Worker decision requests are open decisions: resolve each one yourself .*investigating first.*Never leave one unanswered\./);
    assert.match(prompt, /The first finish with false does not end the run: investigate the root cause of each blocker or fix it while dispatch rounds remain unlimited/);
    assert.match(prompt, /Dispatch rounds are unlimited by default\. A round number is for ordering only, not a spending authorization\./);
    assert.match(prompt, /acceptanceChecks: while no checks are pinned, propose 1-10 deterministic checks/);
    assert.match(prompt, /Acceptance checks: none are pinned yet/);
    assert.match(prompt, /Dispatch rounds already used: 0\. Dispatch rounds are unlimited; the count is for ordering only/);
    assert.doesNotMatch(prompt, /request more rounds|Round budget:/i);
    // The rejected LL-1 escalation triggers are gone.
    assert.doesNotMatch(prompt, /survived two rounds/);
    assert.doesNotMatch(prompt, /change of scope or acceptance criteria/);
    assert.doesNotMatch(prompt, /product_choice|missing_authority/);
  });
});

// ------------------------------------------------- LL-4: acceptance checks proposed by the agent

const EXACT_POLICY = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const npmTest = { id: 'unit', argv: ['npm', 'test'], timeoutMs: null };
const pinnedNpmTest = { id: 'acceptance-contract/v1', requiredChecks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 600000 }], source: 'agent' };
const proposing = (acceptanceChecks) => decision({ action: 'dispatch', assignments: [brief('orch-explorer', [])], acceptanceChecks });
const hostRunRefused = async () => { throw new Error('an agent check must never run on the host'); };
function withExec(world, reply) {
  const calls = [];
  world.appServer.execCommand = async (args) => {
    calls.push(args);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(args) : reply;
  };
  return calls;
}

test('the first valid proposal is pinned, published, ignored later, and run through execCommand only', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [proposing([npmTest]), proposing([{ id: 'other', argv: ['make', 'check'], timeoutMs: null }]), met('Done')] });
  const calls = withExec(world, { exitCode: 0, stdout: 'ok', stderr: '' });
  const events = [];
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.deepEqual(result.acceptance.requiredCheckIds, ['unit']);
    assert.equal(result.acceptance.checks[0].sandboxed, true);
    const pinned = events.filter((event) => event.type === 'acceptance_contract');
    assert.equal(pinned.length, 1);
    assert.deepEqual(pinned[0].contract, pinnedNpmTest);
    assert.match(world.prompts[1], /Pinned acceptance checks \(source agent;/);
    assert.match(world.prompts[2], /acceptanceChecks proposal was ignored: the acceptance checks of this run are already pinned/);
    assert.deepEqual(calls, [{ command: ['npm', 'test'], cwd: workspace, sandboxPolicy: EXACT_POLICY, timeoutMs: 600000 }]);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.contract, pinnedNpmTest);
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('a pinned agent contract survives a restart and still runs sandboxed', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [proposing([npmTest]), met('Done')] });
  const calls = withExec(world, { exitCode: 0, stdout: '', stderr: '' });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID, interruptAfter: ['decide'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    await session.restart();
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.contract, pinnedNpmTest);
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(calls.length, 1);
    assert.match(world.prompts[1], /Pinned acceptance checks \(source agent;/);
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('a failing pinned agent check feeds the acceptance loop', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [met('Done', { acceptanceChecks: [npmTest] }), met('Still done')] });
  const calls = withExec(world, { exitCode: 1, stdout: '', stderr: '2 failed' });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['check_failed']);
    assert.equal(calls.length, 2);
    assert.match(world.prompts[1], /Acceptance note/);
    assert.match(world.prompts[1], /check_failed: Required check "unit" failed \(exit 1\)/);
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('the owner-side acceptanceScratch option reaches the sandboxed check; a proposal field cannot enable it', { skip: !fs.existsSync('/var/tmp') }, async () => {
  const baseDir = fs.mkdtempSync('/var/tmp/lead-scratch-');
  try {
    const workspace = gitRepo();
    const world = makeWorld({ script: [met('Done', { acceptanceChecks: [npmTest] })] });
    const calls = withExec(world, { exitCode: 0, stdout: '', stderr: '' });
    await withSession(world, async (session) => {
      const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
      assert.equal(result.acceptance.disposition, 'accepted');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sandboxPolicy.excludeSlashTmp, true);
      assert.equal(path.dirname(calls[0].sandboxPolicy.writableRoots[0]), fs.realpathSync(baseDir));
      assert.deepEqual(Object.keys(calls[0].env).sort(), ['SCRATCH_VAR', 'TMPDIR']);
      assert.equal(result.acceptance.scratch.cleaned, true);
    }, { workspace, orchestrator: { runCheckImpl: hostRunRefused, acceptanceScratch: { env: ['SCRATCH_VAR'], baseDir } } });

    const refused = makeWorld({ script: [met('Done', { acceptanceChecks: [{ ...npmTest, acceptanceScratch: { env: ['SCRATCH_VAR'], baseDir } }] }), met('Done')] });
    const plain = withExec(refused, { exitCode: 0, stdout: '', stderr: '' });
    await withSession(refused, async (session) => {
      const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
      // The proposal with a scratch field is refused as invalid: nothing is pinned and nothing runs.
      assert.equal(result.acceptance.disposition, 'not_required');
      assert.equal('scratch' in result.acceptance, false);
      assert.equal(plain.length, 0);
          }, { workspace: gitRepo(), orchestrator: { runCheckImpl: hostRunRefused } });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('an agent check whose execCommand throws is unverifiable, never accepted', async () => {
  const workspace = gitRepo();
  const world = makeWorld({ script: [met('Done', { acceptanceChecks: [npmTest] })] });
  withExec(world, new Error('command/exec is not supported'));
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
    assert.equal(result.acceptance.disposition, 'unverifiable');
    assert.deepEqual(issueCodes(result), ['check_error']);
    assert.equal(result.acceptance.checks[0].result, 'error');
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('owner checks keep running through runCheck and agent proposals are ignored', async () => {
  const workspace = gitRepo();
  const hostRuns = [];
  const runCheckImpl = async (check) => {
    hostRuns.push(check.id);
    return { id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' };
  };
  const world = makeWorld({ script: [proposing([npmTest]), met('Done', { acceptanceChecks: [npmTest] })] });
  const calls = withExec(world, { exitCode: 0, stdout: '', stderr: '' });
  const events = [];
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID, contract: contractOf(nodeCheck('owner', 'process.exit(0)')), onEvent: (event) => events.push(event) });
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.deepEqual(hostRuns, ['owner']);
    assert.equal(calls.length, 0);
    assert.equal(events.some((event) => event.type === 'acceptance_contract'), false);
    assert.match(world.prompts[0], /Pinned acceptance checks \(source owner;/);
    assert.match(world.prompts[1], /acceptanceChecks proposal was ignored/);
  }, { workspace, orchestrator: { runCheckImpl } });
});

test('a vacuous or unsafe proposal is a rejected decision with a reminder and nothing is pinned', async () => {
  const world = makeWorld({ script: [proposing([{ id: 'x', argv: ['echo', 'ok'], timeoutMs: null }]), proposing([{ id: 'y', argv: ['python3', '-c', 'pass'], timeoutMs: null }]), met('Done')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 0);
    assert.match(world.prompts[1], /decision\.acceptance_checks acceptance_checks_invalid: acceptanceChecks "x": echo proves nothing/);
    assert.match(world.prompts[1], /bash and sh need a workspace script as argv\[1\]/);
    assert.match(world.prompts[2], /inline code \(-c\) after python3 is refused/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.contract.requiredChecks, []);
    assert.equal(result.acceptance.disposition, 'not_required');
  });
});

// ------------------------------------------------- LL-5: continue a worker with expanded scope

const threadedWriterFinal = () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{
    name: 'report',
    parts: textParts(report('need more scope', { scopeExpansion: ['lib/other.js'] })),
    metadata: { writerExecution: releasedWriter([]), continuation: { threadId: 'th-1', laneId: 'lane-1', codexHome: '/homes/a' } },
  }],
});

test('continueFrom dispatches a scope continuation built from the referenced outcome', async () => {
  const first = assignmentId(RUN_ID, 1, 0);
  const world = makeWorld({
    script: [
      dispatch(brief('orch-builder')),
      dispatch({ ...brief('orch-builder', ['src', 'lib']), continueFrom: first }),
      finish('Done'),
    ],
    workerFinal: threadedWriterFinal,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.dispatchInputs[0].continuation, undefined);
    const sent = world.dispatchInputs[1];
    assert.equal(sent.assignmentId, assignmentId(RUN_ID, 2, 0));
    assert.deepEqual(sent.continuation, { ofAttemptId: attemptId(first), threadId: 'th-1', laneId: 'lane-1', codexHome: '/homes/a', reason: 'scope' });
    assert.deepEqual(sent.allowedFiles, ['src', 'lib']);
    assert.equal(Object.hasOwn(sent, 'continueFrom'), false);
    assert.doesNotMatch(world.prompts[1], /th-1/);
  });
});

test('a legacy assignment without continueFrom gets null and sends no continuation', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-builder')), finish('Done')], workerFinal: threadedWriterFinal });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(Object.hasOwn(world.dispatchInputs[0], 'continuation'), false);
    assert.equal(Object.hasOwn(world.dispatchInputs[0], 'continueFrom'), false);
  });
});

test('an unknown continueFrom is rejected with the rule reminder', async () => {
  const world = makeWorld({ script: [dispatch({ ...brief('orch-builder'), continueFrom: 'no-such-assignment' }), finish('Done')] });
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(world.sends.length, 0);
    assert.match(world.prompts[1], /assignment\.continue_from continue_from_unknown/);
    assert.match(world.prompts[1], /continueFrom is null or the assignmentId of a finished outcome/);
  });
});

// ------------------------------------------------- LL-6: round budget grows with progress

const writerRound = () => dispatch(brief('orch-builder'));

test('default runs complete more than 24 distinct research rounds without a round or elapsed-time cap', async () => {
  const script = Array.from({ length: 26 }, (_, index) => dispatch({
    ...brief('orch-explorer', []),
    objective: `Inspect src/research-${index + 1}.js`,
  }));
  script.push(finish('Research complete'));
  const world = makeWorld({ script });
  const originalNow = Date.now;
  Date.now = () => originalNow() + (10 * 60 * 60 * 1000);
  try {
    await withSession(world, async (session) => {
      const result = await session.orchestrator.run({ goal: 'Research the project', runId: RUN_ID });
      assert.equal(result.status, 'completed');
      assert.equal(result.rounds, 26);
      assert.equal(world.sends.length, 26);
      const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
      assert.equal(values.loopGuard.observations.length, 24);
      assert.ok(values.loopGuard.episodes.length <= 24);
    });
  } finally {
    Date.now = originalNow;
  }
});

test('novel inspected paths after the projected report cap still prevent a false loop pause', async () => {
  const commonPaths = Array.from({ length: 20 }, (_, index) => `src/a${String(index).padStart(2, '0')}.js`);
  let reportIndex = 0;
  const workerFinal = () => {
    reportIndex += 1;
    return {
      state: TaskState.TASK_STATE_COMPLETED,
      artifacts: [{ name: 'report', parts: textParts(report('Inspected repository modules', {
        filesInspected: [...commonPaths, `src/z${reportIndex}.js`],
      })) }],
    };
  };
  const repeated = dispatch(brief('orch-explorer', []));
  const world = makeWorld({ script: [repeated, repeated, repeated, repeated, finish('Research complete')], workerFinal });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Inspect repository modules', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.loopGuard.warning, null);
    assert.equal(values.loopGuard.episodes.length, 4);
    assert.equal(result.assignments[0].report.filesInspected.length, 20);
    assert.doesNotMatch(world.prompts[1], /loopEvidenceIdentity/);
  });
});

test('default runs complete more than 24 productive writer rounds', async () => {
  const script = Array.from({ length: 26 }, (_, index) => dispatch(brief('orch-builder', [`src/output-${index + 1}.js`])));
  script.push(finish('Changes complete'));
  const world = makeWorld({
    script,
    workerFinal: (_roleName, _contextId, input) => okWriterFinal(input.allowedFiles)("orch-builder"),
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build the outputs', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.rounds, 26);
    assert.equal(world.sends.length, 26);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.progress.filter((entry) => entry.kind === 'integrated_change').length, 26);
    assert.equal(values.loopGuard.observations.length, 24);
  });
});

const repeatedResearch = (roleName) => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts(report('src/target.js exports parseTarget', { filesInspected: ['src/target.js'] })) }],
});

test('three repeated research rounds warn the lead, then an unchanged fourth result pauses', async () => {
  const unrelated = brief('orch-explorer', []);
  unrelated.objective = 'Inspect docs/other.md';
  const world = makeWorld({
    script: Array.from({ length: 4 }, () => dispatch(brief('orch-explorer', []), unrelated)),
    workerFinal(roleName, contextId, input) {
      if (input.objective.includes('docs/other.md')) {
        return { state: TaskState.TASK_STATE_COMPLETED, artifacts: [{ name: 'report', parts: textParts(report('docs/other.md describes setup', { filesInspected: ['docs/other.md'] })) }] };
      }
      return repeatedResearch(roleName);
    },
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(paused.pause.question, /Repeated work paused after 4 completed rounds/);
    assert.equal(world.sends.length, 8);
    assert.match(world.prompts[3], /Loop warning: the same scoped work repeated 3 times/);
  });
});

test('precomputed full-report evidence uses the final rejected review state', async () => {
  let calls = 0;
  const workspace = gitRepo();
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.mkdirSync(path.join(workspace, 'test'));
  fs.writeFileSync(path.join(workspace, 'src', 'target.js'), 'module.exports = {}');
  const checks = [
    'Inspect authority persistence and stale writes.',
    'Verify restart behavior for stored authority and stale writes.',
    'Check persistence after restart, including stale authority.',
    'Confirm saved authority survives restart without stale writes.',
  ];
  const review = {
    kind: 'risk_change',
    checkpointId: 'm4-r20-integrated-authority-persistence',
    reason: 'Review persisted authority',
    paths: ['src/target.js'],
    evidenceIds: ['issue-authority-persistence'],
  };
  const auditAssignment = (index) => ({
    ...brief('orch-auditor', []),
    objective: `Inspect checkpoint attempt ${index + 31}`,
    checks: [checks[index]],
    review,
  });
  const world = makeWorld({
    script: [
      () => dispatch({ ...brief('orch-verifier', ['test']), review }, auditAssignment(0)),
      ...checks.slice(1).map((_, index) => () => dispatch(auditAssignment(index + 1))),
    ],
    workerFinal(roleName) {
      if (roleName === 'orch-verifier') {
        return {
          state: TaskState.TASK_STATE_COMPLETED,
          artifacts: [{ name: 'report', parts: textParts(report('Focused verification passed.', {
            filesInspected: ['src/target.js'], checks: [{ command: 'inspect src/target.js', detail: 'Inspected the candidate file.', result: 'passed' }],
          })), metadata: { writerExecution: releasedWriter() } }],
        };
      }
      const risk = `Review detail changed in attempt ${++calls}`;
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        artifacts: [{
          name: 'report',
          parts: textParts(report('VERDICT: fail\nsrc/target.js exports parseTarget', {
            filesInspected: ['src/target.js'],
            checks: [{ command: 'inspect src/target.js', detail: 'Inspected the candidate file.', result: 'passed' }],
            risks: [risk],
          })),
          metadata: { review: { status: 'rejected', accepted: false, valid: false, verdict: 'fail', reason: 'Review failed' } },
        }],
      };
    },
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(world.prompts[3], /Loop warning: the same scoped work repeated 3 times/);
    assert.equal(world.sends.length, 5);
    const auditorContract = world.dispatchInputs.find((input) => input.role === 'orch-auditor').reportContract;
    assert.match(auditorContract, /summary first line must be exactly VERDICT: pass, VERDICT: fail, or VERDICT: inconclusive/);
    assert.match(auditorContract, /Never describe reused tests as freshly executed/);
    assert.match(auditorContract, /Do not invent runs/);
  }, { workspace });
});

test('a later target warning is shown to the lead before that target pauses', async () => {
  const targetA = dispatch({ ...brief('orch-explorer', []), objective: 'Inspect src/a.js' });
  const targetB = dispatch({ ...brief('orch-explorer', []), objective: 'Inspect src/b.js' });
  const script = [targetA, targetA, targetA, targetB, targetB, targetB, targetB];
  const world = makeWorld({
    script,
    workerFinal(_roleName, _contextId, input) {
      const target = input.objective.includes('src/b.js') ? 'src/b.js' : 'src/a.js';
      return {
        state: TaskState.TASK_STATE_COMPLETED,
        artifacts: [{ name: 'report', parts: textParts(report(`${target} exports parseTarget`, { filesInspected: [target] })) }],
      };
    },
  });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Investigate both targets', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(paused.pause.question, /explorer: inspect src\/b\.js/);
    assert.match(world.prompts[3], /explorer: inspect src\/a\.js/);
    assert.match(world.prompts[6], /explorer: inspect src\/a\.js/);
    assert.match(world.prompts[6], /explorer: inspect src\/b\.js/);
    assert.equal(world.sends.length, 7);
  });
});

test('relevant new research evidence clears the warning and lets a replanned run finish', async () => {
  let researchCalls = 0;
  const evolvedResearch = (roleName, contextId, input) => ({
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{ name: 'report', parts: textParts(report(
      ++researchCalls === 4 ? 'src/target.js calls parseHeader before decode' : 'src/target.js exports parseTarget',
      { filesInspected: ['src/target.js'] },
    )) }],
  });
  const repeated = dispatch(brief('orch-explorer', []));
  const world = makeWorld({ script: [repeated, repeated, repeated, repeated, finish('Research complete')], workerFinal: evolvedResearch });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.match(world.prompts[3], /Loop warning:/);
    assert.doesNotMatch(world.prompts[4], /Loop warning:/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.loopGuard.warning, null);
  });
});

test('owner continuation resets loop history before the same work is retried', async () => {
  const same = dispatch(brief('orch-explorer', []));
  const world = makeWorld({ script: [same, same, same, same, same, finish('Done')], workerFinal: repeatedResearch });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Try once more', choice: 'continue' } });
    assert.equal(result.status, 'completed');
    assert.doesNotMatch(world.prompts[4], /Loop warning:/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.loopGuard.observations.length, 1);
  });
});

test('loop observations survive a process restart and an old checkpoint without guard state starts clean', async () => {
  const same = dispatch(brief('orch-explorer', []));
  const world = makeWorld({ script: [same, same, same, same, finish('Done')], workerFinal: repeatedResearch });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID, interruptAfter: ['verify'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    const before = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(before.values.loopGuard.lastRound, 1);
    await session.restart();
    const paused = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(world.prompts[3], /Loop warning: the same scoped work repeated 3 times/);
  });
  const legacyWorld = makeWorld({ script: [same, same, finish('Legacy checkpoint resumed')], workerFinal: repeatedResearch });
  await withSession(legacyWorld, async (session) => {
    const stopped = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID, interruptAfter: ['verify'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    const config = { configurable: { thread_id: RUN_ID } };
    await session.orchestrator.graph.updateState(config, { loopGuard: null });
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    const { values } = await session.orchestrator.graph.getState(config);
    assert.equal(values.loopGuard.observations.length, 1);
  });
});

test('a budget pause preserves detector progress for the resumed research round', async () => {
  const same = dispatch(brief('orch-explorer', []));
  const world = makeWorld({ script: [same, same, usageLimitError(), same, finish('Done')], workerFinal: repeatedResearch });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Investigate target behavior', runId: RUN_ID });
    assert.equal(paused.status, 'waiting_for_budget');
    let state = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(state.values.loopGuard.lastRound, 2);
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { note: 'Budget restored' } });
    assert.equal(result.status, 'completed');
    state = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(state.values.loopGuard.warning.attempts, 3);
  });
});

test('A-B work oscillation warns on the first repeated target and pauses on its recurrence', async () => {
  const script = Array.from({ length: 7 }, (_, index) => {
    const target = index % 2 === 0 ? 'src/a.js' : 'src/b.js';
    return dispatch({ ...brief('orch-builder', [target]), objective: `Repair ${target}` });
  });
  const world = makeWorld({ script, workerFinal: (roleName, contextId, input) => okWriterFinal(input.allowedFiles)(roleName) });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Repair both targets', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'loop_detected');
    assert.match(world.prompts[5], /Loop warning: the same scoped work repeated 3 times/);
    assert.equal(world.sends.length, 7);
  });
});

test('an explicit round cap pauses even when recent work made progress', async () => {
  const world = makeWorld({ script: [writerRound(), writerRound(), writerRound(), finish('Done')], workerFinal: okWriterFinal(['src/example.js']) });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'round_limit');
    assert.match(paused.pause.question, /2 of 2 rounds used/);
    assert.equal(world.sends.length, 2);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.roundExtensions, []);
    assert.deepEqual(values.progress.map((entry) => [entry.round, entry.kind]), [[1, 'integrated_change'], [2, 'integrated_change']]);
  }, { orchestrator: { maxRounds: 2 } });
});

test('an explicit round cap pauses without automatic extensions after a resolved worker decision', async () => {
  const asking = deterministicContextId(attemptId(assignmentId(RUN_ID, 1, 0)));
  const workerFinal = (roleName, contextId) => ({
    state: TaskState.TASK_STATE_COMPLETED,
    artifacts: [{ name: 'report', parts: textParts(contextId === asking ? needsDecisionReport() : report('ok')) }],
  });
  const resolve = [{ decisionId: attemptId(assignmentId(RUN_ID, 1, 0)), choice: 'keep', rationale: 'src/api.js has callers' }];
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), decision({ action: 'dispatch', assignments: [brief('orch-explorer', [])], resolutions: resolve }), dispatch(brief('orch-explorer', [])), dispatch(brief('orch-explorer', []))], workerFinal });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Look', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'round_limit');
    assert.match(paused.pause.question, /1 of 1 rounds used/);
    assert.equal(world.sends.length, 1);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.roundExtensions, []);
  }, { orchestrator: { maxRounds: 1 } });
});

test('an explicit cap above 18 rounds is honored when each round advances scoped content', async () => {
  const script = Array.from({ length: 21 }, (_, index) => dispatch(brief('orch-builder', [`src/example-${index + 1}.js`])));
  script.push(finish('Done'));
  const world = makeWorld({ script, workerFinal: (roleName, contextId, input) => okWriterFinal(input.allowedFiles)(roleName) });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID });
    assert.equal(paused.pause.escalation, 'round_limit');
    assert.match(paused.pause.question, /20 of 20 rounds used/);
    assert.equal(world.sends.length, 20);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.roundExtensions, []);
    assert.match(world.prompts[20], /Dispatch rounds already used: 20\/20\./);
  }, { orchestrator: { maxRounds: 20 } });
});

// ------------------------------------------------- LL-6: a changed pinned check is reviewed

const GATE_PINNED = 'test "$(wc -l < rows.txt)" -eq 52\n';
const GATE_CHANGED = 'test "$(wc -l < rows.txt)" -eq "$(./scripts/prd-rows.sh)"\n';
const gateCheck = { id: 'gate', argv: ['bash', 'scripts/gate.sh'], timeoutMs: null };
const REVIEW_ID = `${RUN_ID}:r1:review1`;
function gateRepo() {
  const dir = gitRepo();
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'gate.sh'), GATE_PINNED);
  vcs(dir, 'add', '.');
  vcs(dir, 'commit', '-q', '-m', 'gate');
  return dir;
}
const reviewerSays = (summary) => (roleName) => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts(report(roleName === 'orch-auditor' ? summary : 'explored')) }],
});
// Pin the gate check, then change its script before the lead finishes.
const changeGateThenFinish = (workspace) => async () => {
  fs.writeFileSync(path.join(workspace, 'scripts', 'gate.sh'), GATE_CHANGED);
  return met('Done');
};
const gateScript = (workspace, ...rest) => [proposing([gateCheck]), changeGateThenFinish(workspace), ...rest];

test('check_changed: a preserving change is reviewed, re-pinned with the approver, and accepted without a lead round', async () => {
  const workspace = gateRepo();
  const world = makeWorld({ script: gateScript(workspace), workerFinal: reviewerSays('VERDICT: preserve\nThe PRD requires all 52 rows; the count now comes from the PRD table.') });
  const calls = withExec(world, { exitCode: 0, stdout: 'ok', stderr: '' });
  const events = [];
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(result.rounds, 1);
    assert.equal(world.leadTurns, 2);
    assert.equal(calls.length, 1);
    const sent = world.dispatchInputs[1];
    assert.equal(sent.role, 'orch-auditor');
    assert.equal(sent.assignmentId, REVIEW_ID);
    assert.deepEqual(sent.allowedFiles, []);
    assert.match(sent.objective, /"VERDICT: preserve" or "VERDICT: weaken"/);
    assert.match(sent.objective, /PRD_CHANGE_REQUIRED/);
    const inputs = sent.inputs.join('\n');
    assert.match(inputs, /Pinned acceptance check "gate": argv \["bash","scripts\/gate.sh"\]/);
    assert.match(inputs, /Diff of the pinned content \(committed at HEAD\) against the current file\./);
    assert.match(inputs, /-test "\$\(wc -l < rows.txt\)" -eq 52/);
    assert.match(inputs, /\+test "\$\(wc -l < rows.txt\)" -eq "\$\(\.\/scripts\/prd-rows.sh\)"/);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.contract.requiredChecks[0].pins, [{ path: 'scripts/gate.sh', sha256: sha256Of(GATE_CHANGED) }]);
    assert.equal(values.checkReviews.length, 1);
    assert.equal(values.checkReviews[0].verdict, 'preserve');
    assert.equal(values.checkReviews[0].by, `auditor review ${REVIEW_ID}`);
    assert.ok(values.progress.some((entry) => entry.kind === 'check_passed' && entry.detail === 'gate'));
    const pinned = events.filter((event) => event.type === 'acceptance_contract');
    assert.equal(pinned.length, 2);
    assert.equal(pinned[1].approvedBy, `auditor review ${REVIEW_ID}`);
    assert.deepEqual(pinned[1].contract, values.contract);
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('check_changed: a weakening change keeps failing, the lead is told, and the same content is not reviewed again', async () => {
  const workspace = gateRepo();
  const world = makeWorld({ script: gateScript(workspace, met('Done again')), workerFinal: reviewerSays('VERDICT: weaken\nThe PRD fixes 52 rows; the new script compares against a moving value.') });
  const calls = withExec(world, { exitCode: 0, stdout: '', stderr: '' });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['check_weakened']);
    assert.equal(calls.length, 0);
    assert.equal(world.leadTurns, 3);
    assert.equal(world.dispatchInputs.filter((input) => input.role === 'orch-auditor').length, 1);
    assert.match(world.prompts[2], /Acceptance note/);
    assert.match(world.prompts[2], new RegExp(`check_weakened: Pinned acceptance check "gate" fails: the change to scripts/gate.sh weakens its requirement \\(auditor review ${REVIEW_ID}\\)`));
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.deepEqual(values.contract.requiredChecks[0].pins, [{ path: 'scripts/gate.sh', sha256: sha256Of(GATE_PINNED) }]);
    assert.equal(values.checkReviews[0].verdict, 'weaken');
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('check_changed: an unparseable verdict counts as weaken', async () => {
  const workspace = gateRepo();
  const world = makeWorld({ script: gateScript(workspace, met('Done again')), workerFinal: reviewerSays('Looks fine to me.\nVERDICT: maybe') });
  withExec(world, { exitCode: 0, stdout: '', stderr: '' });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.deepEqual(issueCodes(result), ['check_weakened']);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.checkReviews[0].by, `auditor review ${REVIEW_ID} (no parseable verdict)`);
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

test('check_changed: only an explicit PRD change reaches the owner, who may approve the re-pin', async () => {
  const workspace = gateRepo();
  const world = makeWorld({ script: gateScript(workspace), workerFinal: reviewerSays('VERDICT: weaken\nPRD_CHANGE_REQUIRED: the PRD still says 52 rows but the product now ships 60.') });
  const calls = withExec(world, { exitCode: 0, stdout: '', stderr: '' });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Ship', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    const { pause } = paused;
    assert.equal(pause.kind, 'human_decision');
    assert.equal(pause.escalation, 'check_changed');
    assert.equal(pause.reason, 'prd_requirement_change');
    assert.deepEqual(pause.options.map((option) => option.id), ['approve_change', 'keep_requirement']);
    assert.equal(pause.recommendation, 'keep_requirement');
    assert.match(pause.question, /the PRD still says 52 rows but the product now ships 60/);
    assert.equal('review' in pause, false);
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'The PRD moves to 60 rows', choice: 'approve_change' } });
    assert.equal(result.acceptance.disposition, 'accepted');
    assert.equal(calls.length, 1);
    assert.equal(world.leadTurns, 2);
    const { values } = await session.orchestrator.graph.getState({ configurable: { thread_id: RUN_ID } });
    assert.equal(values.checkReviews[0].verdict, 'preserve');
    assert.equal(values.checkReviews[0].by, `owner (decision ${RUN_ID}:h1)`);
    assert.deepEqual(values.contract.requiredChecks[0].pins, [{ path: 'scripts/gate.sh', sha256: sha256Of(GATE_CHANGED) }]);
  }, { workspace, orchestrator: { runCheckImpl: hostRunRefused } });
});

// ------------------------------------------------- per-project role overrides (ROLE-01)

const { createLeadRole } = require('../src/role-catalog');
const { loadEffectiveRoles, writeOverridesFile, RULES_HEADING } = require('../src/role-overrides');

const profileHash = (r) => crypto.createHash('sha256').update(JSON.stringify([r.name, r.sandbox, r.model, r.effort, r.instructions || '']), 'utf8').digest('hex');
// What the project server does at start: the effective roles for the orchestrator options.
const loadEffective = (file) => {
  const { roles: effective, leadRole } = loadEffectiveRoles({ file, roles: roles(), leadRole: createLeadRole() });
  return { roles: effective, leadRole };
};
const overridesPath = () => path.join(tmpRoot, `overrides-${dbCounter += 1}`, 'role-overrides.json');

test('a worker override changes the effective role and the pinned roleProfileSha256 describes it', async () => {
  const file = overridesPath();
  const base = roles().get('orch-builder');
  const effective = { ...base, model: 'gpt-6-luna', effort: 'low', instructions: `${base.instructions}\n\n${RULES_HEADING}\nKeep diffs small.` };
  const plain = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: okWriterFinal() });
  await withSession(plain, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.equal(outcome.contract.roleProfileSha256, profileHash(base));
  }, { orchestrator: loadEffective(file) });
  writeOverridesFile(file, { engineer: { model: 'gpt-6-luna', effort: 'low', extraRules: 'Keep diffs small.' } });
  const world = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: okWriterFinal() });
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.equal(outcome.contract.roleProfileSha256, profileHash(effective));
    assert.notEqual(outcome.contract.roleProfileSha256, profileHash(base));
    // The lead is told the effective model and effort of the role.
    assert.match(world.prompts[0], /"id":"engineer"[^\n]*"model":"gpt-6-luna","effort":"low"/);
  }, { orchestrator: loadEffective(file) });
});

test('a lead override reaches the lead turn with the rules block and the read-only sandbox', async () => {
  const file = overridesPath();
  writeOverridesFile(file, { coordinator: { model: 'gpt-6-luna', effort: 'high', extraRules: 'Be terse.' } });
  const world = sessionWorld([finish('A')]);
  const seen = [];
  const run = world.appServer.run;
  world.appServer.run = async (args) => { seen.push(args.role); return run(args); };
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
  }, { withSessions: true, orchestrator: loadEffective(file) });
  assert.equal(seen[0].model, 'gpt-6-luna');
  assert.equal(seen[0].effort, 'high');
  assert.ok(seen[0].instructions.endsWith(`${RULES_HEADING}\nBe terse.`));
  assert.equal(seen[0].sandbox, 'read-only');
});

test('a changed lead profile after a server restart rolls the session over to a new thread; an unchanged one resumes', async () => {
  const file = overridesPath();
  const world = sessionWorld([finish('A'), finish('B'), finish('C'), finish('D')]);
  const options = { withSessions: true, orchestrator: loadEffective(file) };
  await withSession(world, async (session) => {
    await session.orchestrator.run({ goal: 'A', runId: RUN_ID, contextId: SESSION });
    const first = session.sessions.get(SESSION);
    assert.equal(first.profileSha256, profileHash(createLeadRole()));
    // Restart with the same profile: the persisted thread is resumed.
    await session.restart();
    await session.orchestrator.run({ goal: 'B', runId: 'run-2', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1']);
    assert.equal(session.sessions.get(SESSION).rollovers, 0);
    // Restart with a changed lead profile: a new thread with the full prompt, recorded under the new hash.
    writeOverridesFile(file, { coordinator: { extraRules: 'Be terse.' } });
    Object.assign(options.orchestrator, loadEffective(file));
    await session.restart();
    await session.orchestrator.run({ goal: 'C', runId: 'run-3', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1', undefined]);
    assert.match(world.prompts[2], /Available roles:/);
    const rolled = session.sessions.get(SESSION);
    assert.equal(rolled.threadId, 'thread-2');
    assert.equal(rolled.rollovers, 1);
    assert.notEqual(rolled.profileSha256, first.profileSha256);
    // The same changed profile keeps the new thread.
    await session.restart();
    await session.orchestrator.run({ goal: 'D', runId: 'run-4', contextId: SESSION });
    assert.deepEqual(world.threadArgs, [undefined, 'thread-1', undefined, 'thread-2']);
    assert.equal(session.sessions.get(SESSION).rollovers, 1);
  }, options);
});

test('an invalid overrides file falls back to the profile defaults for the lead and the workers', async () => {
  const file = overridesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ nope');
  const world = makeWorld({ script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')], workerFinal: okWriterFinal() });
  const seen = [];
  const run = world.appServer.run;
  world.appServer.run = async (args) => { seen.push(args.role); return run(args); };
  await withSession(world, async (session) => {
    const outcome = (await session.orchestrator.run({ goal: 'Build', runId: RUN_ID })).assignments[0];
    assert.equal(outcome.contract.roleProfileSha256, profileHash(roles().get('orch-builder')));
  }, { orchestrator: loadEffective(file) });
  assert.equal(seen[0].model, createLeadRole().model);
  assert.equal(seen[0].effort, createLeadRole().effort);
});

// ---- PAUSE-01: owner pause (soft stop)

test('owner pause requested during collect parks after every worker is terminal and cancels nothing', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Done after pause')],
    pollsNeeded: 2,
    getTaskFault: (_id, count) => { if (count === 1) assert.equal(session.orchestrator.requestPause(RUN_ID), true); },
  });
  let session;
  await withSession(world, async (s) => {
    session = s;
    const events = [];
    const paused = await s.orchestrator.run({ goal: 'Explore', runId: RUN_ID, onEvent: (event) => events.push(event) });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'owner_pause');
    assert.equal(paused.pause.message, 'Paused by the owner');
    assert.equal(events.at(-1).type, 'pause');
    assert.deepEqual(await s.orchestrator.getPause(RUN_ID), paused.pause);
    // Parked at the gate between collect and verify: the outcomes are not settled yet.
    assert.deepEqual((await s.orchestrator._snapshot(RUN_ID)).next, ['owner_pause']);
    // The worker ran to its terminal state (3 polls); no cancel was sent; the lead did not run again.
    assert.equal(world.polls.get(`task-${world.sends[0]}`), 3);
    assert.deepEqual(world.cancels, []);
    assert.equal(world.leadTurns, 1);
    assert.deepEqual(s.orchestrator.activeRuns(), []);
    assert.equal(s.orchestrator.isPauseRequested(RUN_ID), false);

    const result = await s.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Done after pause');
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 1);
    assert.match(world.prompts[1], /orch-explorer done/);
    assert.deepEqual(world.cancels, []);
  });
});

test('owner pause requested before decide parks before the next dispatch and resume continues to the next round', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), dispatch(brief('orch-builder')), finish('Built')],
  });
  await withSession(world, async (s) => {
    let requested = false;
    // The round event fires in verify, after the first batch; the next boundary is the start of decide.
    const onEvent = (event) => { if (event.type === 'round' && !requested) { requested = true; s.orchestrator.requestPause(RUN_ID); } };
    const paused = await s.orchestrator.run({ goal: 'Work', runId: RUN_ID, onEvent });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'owner_pause');
    assert.equal(world.leadTurns, 1);
    assert.equal(world.sends.length, 1);
    assert.deepEqual(world.cancels, []);
    assert.equal((await s.orchestrator.getPause(RUN_ID)).kind, 'owner_pause');
    assert.deepEqual((await s.orchestrator._snapshot(RUN_ID)).next, ['decide']);

    // Resume with the same input a human message gives (an empty answer): the run continues.
    const result = await s.orchestrator.resume({ runId: RUN_ID, input: { answer: '' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Built');
    assert.equal(world.leadTurns, 3);
    assert.equal(world.sends.length, 2);
    assert.equal(result.rounds, 2);
  });
});

test('owner pause parks again on a second request after resume', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), dispatch(brief('orch-explorer', [])), finish('End')],
  });
  await withSession(world, async (s) => {
    const request = (event) => { if (event.type === 'round') s.orchestrator.requestPause(RUN_ID); };
    const first = await s.orchestrator.run({ goal: 'Work', runId: RUN_ID, onEvent: request });
    assert.equal(first.pause.kind, 'owner_pause');
    const second = await s.orchestrator.resume({ runId: RUN_ID, onEvent: request });
    assert.equal(second.pause.kind, 'owner_pause');
    assert.equal(world.leadTurns, 2);
    const done = await s.orchestrator.resume({ runId: RUN_ID });
    assert.equal(done.status, 'completed');
  });
});

test('a pause request withdrawn before the boundary leaves the run going', async () => {
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Ran through')],
    pollsNeeded: 2,
    getTaskFault: (_id, count) => {
      if (count === 1) {
        assert.equal(session.orchestrator.requestPause(RUN_ID), true);
        assert.equal(session.orchestrator.isPauseRequested(RUN_ID), true);
        assert.deepEqual(session.orchestrator.activeRuns(), [{ runId: RUN_ID, pauseRequested: true }]);
      }
      if (count === 2) assert.equal(session.orchestrator.cancelPauseRequest(RUN_ID), true);
    },
  });
  let session;
  await withSession(world, async (s) => {
    session = s;
    const result = await s.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Ran through');
    assert.equal(s.orchestrator.cancelPauseRequest(RUN_ID), false);
    assert.equal(s.orchestrator.requestPause(RUN_ID), false);
  });
});

test('an owner pause survives a restart while parked', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), finish('Resumed after restart')] });
  await withSession(world, async (s) => {
    const paused = await s.orchestrator.run({
      goal: 'Work', runId: RUN_ID, onEvent: (event) => { if (event.type === 'round') s.orchestrator.requestPause(RUN_ID); },
    });
    assert.equal(paused.pause.kind, 'owner_pause');
    await s.restart();
    assert.equal((await s.orchestrator.getPause(RUN_ID)).kind, 'owner_pause');
    const result = await s.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 1);
  });
});

// ---- STOP-01: a shutdown stop parks the run as a resumable stopped pause

const ownerStop = () => Object.assign(new Error('Stopped by the owner'), { name: 'AbortError', ownerStop: true });

test('a shutdown stop during collect cancels the worker and parks the run; resume re-plans', async () => {
  const controller = new AbortController();
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('Re-planned and done')],
    pollsNeeded: 5,
    getTaskFault: (_id, count) => { if (count === 1) controller.abort(ownerStop()); },
  });
  await withSession(world, async (s) => {
    const events = [];
    const paused = await s.orchestrator.run({ goal: 'Explore', runId: RUN_ID, signal: controller.signal, onEvent: (event) => events.push(event) });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'stopped');
    assert.equal(paused.pause.message, 'Stopped by the owner');
    assert.equal(events.at(-1).type, 'pause');
    assert.equal(world.cancels.length, 1, 'the running worker turn was cancelled');
    assert.equal(world.leadTurns, 1);
    assert.equal((await s.orchestrator.getPause(RUN_ID)).kind, 'stopped');

    await s.restart();
    const result = await s.orchestrator.resume({ runId: RUN_ID, input: { answer: '' } });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Re-planned and done');
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 1, 'nothing was dispatched again');
    assert.match(world.prompts[1], /TASK_STATE_CANCELED/);
    assert.match(world.prompts[1], /resumed after an interruption/);
    assert.equal(await s.orchestrator.getPause(RUN_ID), null);
  });
});

test('an explicit cancel (no stop reason) still ends the run as canceled', async () => {
  const controller = new AbortController();
  const world = makeWorld({
    script: [dispatch(brief('orch-explorer', [])), finish('never')],
    pollsNeeded: 5,
    getTaskFault: (_id, count) => { if (count === 1) controller.abort(); },
  });
  await withSession(world, async (s) => {
    const result = await s.orchestrator.run({ goal: 'Explore', runId: RUN_ID, signal: controller.signal });
    assert.equal(result.status, 'canceled');
    assert.equal(world.cancels.length, 1);
    assert.equal(await s.orchestrator.getPause(RUN_ID), null);
    assert.equal(world.leadTurns, 1);
  });
});

test('a shutdown stop during a lead turn parks the run and resume runs the turn again', async () => {
  const controller = new AbortController();
  const world = makeWorld({
    script: [async () => { controller.abort(ownerStop()); throw ownerStop(); }, finish('Second try')],
  });
  await withSession(world, async (s) => {
    const paused = await s.orchestrator.run({ goal: 'Work', runId: RUN_ID, signal: controller.signal });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'stopped');
    const result = await s.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Second try');
    assert.equal(world.leadTurns, 2);
  });
});

test('owner pause requested during a lead decide turn parks before anything is submitted and keeps the plan', async () => {
  let session;
  const world = makeWorld({
    script: [async () => { session.orchestrator.requestPause(RUN_ID); return dispatch(brief('orch-explorer', [])); }, finish('Dispatched after resume')],
  });
  await withSession(world, async (s) => {
    session = s;
    const paused = await s.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'owner_pause');
    assert.equal(world.sends.length, 0, 'nothing was submitted');
    assert.equal(world.leadTurns, 1);
    assert.deepEqual((await s.orchestrator._snapshot(RUN_ID)).next, ['pause_before_dispatch']);
    await s.restart();
    const result = await s.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 1, 'the kept plan was dispatched once');
    assert.equal(world.leadTurns, 2, 'the lead did not plan again');
  });
});

test('a pause request withdrawn during a lead decide turn still dispatches', async () => {
  let session;
  const world = makeWorld({
    script: [async () => {
      session.orchestrator.requestPause(RUN_ID);
      session.orchestrator.cancelPauseRequest(RUN_ID);
      return dispatch(brief('orch-explorer', []));
    }, finish('Ran through')],
  });
  await withSession(world, async (s) => {
    session = s;
    const result = await s.orchestrator.run({ goal: 'Explore', runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 1);
  });
});

test('Stop cancels a running writer; resume reconciles it before the lead plans again', async () => {
  const controller = new AbortController();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('Done after stop')],
    pollsNeeded: 5,
    getTaskFault: (_id, count) => { if (count === 1) controller.abort(ownerStop()); },
  });
  // The canceled writer turn leaves an unresolved execution behind, as a turn killed mid-write does.
  world.onCancel = (task) => {
    world.admission.rows.set(task.contextId, admissionRow(task.contextId, 'unresolved'));
    return {
      messageId: 'm', role: 2, parts: textParts('canceled'),
      metadata: { writerExecution: { executionId: `exec-${task.contextId}`, state: 'unresolved', delta: null, reason: 'outcome_unknown' } },
    };
  };
  await withSession(world, async (s) => {
    const paused = await s.orchestrator.run({ goal: 'Build', runId: RUN_ID, signal: controller.signal });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'stopped');
    assert.equal(world.cancels.length, 1);
    assert.equal(world.admission.reconciles.length, 0, 'nothing is reconciled while stopping');
    const snapshot = await s.orchestrator._snapshot(RUN_ID);
    assert.equal(snapshot.values.unresolvedWriters.length, 1);

    await s.restart();
    const result = await s.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Done after stop');
    // Reconcile ran before the second lead turn, and the writer row ended consistent.
    assert.equal(world.admission.reconciles.length, 1);
    const row = [...world.admission.rows.values()][0];
    assert.equal(row.state, 'reconciled');
    const reconciliation = result.assignments.find((entry) => entry.kind === 'reconciliation');
    assert.equal(reconciliation.state, 'reconciled');
    assert.equal((await s.orchestrator._snapshot(RUN_ID)).values.unresolvedWriters.length, 0);
    assert.equal(world.leadTurns, 2);
    assert.equal(world.sends.length, 1);
    assert.match(world.prompts[1], /"kind":"reconciliation"/);
  });
});

// Legacy resume only: the system repair route was removed, but a session parked at the old
// system_pause node (with its legacy channels and pending interrupt) must still load and resume.
test('a session parked at the legacy system_pause node resumes as an ordinary lead turn', async () => {
  const world = makeWorld({ script: [dispatch(brief('orch-explorer', [])), humanRequest(), finish('Continued after removal')] });
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Choose', runId: RUN_ID });
    assert.equal(paused.status, 'input_required');
    const config = { configurable: { thread_id: RUN_ID } };
    const saver = session.state.checkpointer;
    const tuple = await saver.getTuple(config);
    const base = tuple.checkpoint;
    const version = Math.max(...Object.values(base.channel_versions).map(Number)) + 1;
    const channelVersions = Object.fromEntries(Object.entries(base.channel_versions).filter(([key]) => !key.startsWith('branch:to:')));
    channelVersions['branch:to:system_repair'] = version;
    channelVersions['branch:to:system_pause'] = version + 1;
    const systemRequest = {
      requestId: `${RUN_ID}:system:1`, incidentId: 'control-plane-incident', status: 'unavailable', attempts: 1,
      lastResult: { status: 'unavailable', reason: 'system_repair_service_unavailable' },
      request: { incidentId: 'control-plane-incident', question: 'Why?', evidence: ['e1'], relatedDecisionIds: [] },
    };
    const legacy = {
      ...base,
      id: uuid6(-2),
      ts: new Date(Date.parse(base.ts) + 1000).toISOString(),
      channel_values: {
        ...Object.fromEntries(Object.entries(base.channel_values).filter(([key]) => !key.startsWith('branch:to:'))),
        'branch:to:system_repair': 'decide',
        'branch:to:system_pause': 'system_repair',
        humanRequest: null,
        systemRequest,
        systemCount: 1,
        systemResults: [{ requestId: systemRequest.requestId, incidentId: systemRequest.incidentId, status: 'unavailable' }],
        systemCompletedIncidents: [],
        systemStopPending: false,
      },
      channel_versions: channelVersions,
      versions_seen: Object.fromEntries(Object.entries(base.versions_seen).filter(([node]) => node !== 'human_input')),
    };
    await saver.put({ configurable: { ...config.configurable, checkpoint_ns: '', checkpoint_id: base.id } }, legacy, { source: 'loop', step: (tuple.metadata?.step ?? 0) + 1, parents: {} }, channelVersions);
    const parked = await session.orchestrator._snapshot(RUN_ID);
    assert.deepEqual(parked.next, ['system_pause']);
    // The old node parked through interrupt(); store that pending interrupt for its task.
    await saver.putWrites(parked.config, [[INTERRUPT, {
      value: { kind: 'system_repair', requestId: systemRequest.requestId, incidentId: systemRequest.incidentId, status: 'unavailable', message: 'waiting' },
      id: 'legacy-system-pause',
    }]], parked.tasks[0].id);
    const snapshot = await session.orchestrator._snapshot(RUN_ID);
    assert.deepEqual(snapshot.next, ['system_pause']);
    assert.equal(snapshot.values.systemRequest.incidentId, 'control-plane-incident');
    assert.equal((await session.orchestrator.getPause(RUN_ID)).kind, 'system_repair');

    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'Continued after removal');
    assert.equal(world.leadTurns, 3);
    const after = await session.orchestrator._snapshot(RUN_ID);
    assert.equal(after.values.systemRequest, null);
    assert.ok(after.values.progress.some((entry) => entry.kind === 'route_removed' && /removed/.test(entry.detail)));
    assert.equal(await session.orchestrator.getPause(RUN_ID), null);
  });
});
