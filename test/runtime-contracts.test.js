'use strict';

// DBC-04: boundary violations never become accepted results, and their diagnostics survive a
// restart. Graph-level cases use a real SQLite checkpointer, real git repos and real acceptance
// checks; the direct specialist cases run over real A2A HTTP on loopback. Only the App Server
// and the A2A worker side are faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { DispatchJournal, openStateDatabase } = require('../src/durable-store');
const { makeFakeAppServer, canBind, withStack, sendToAgent } = require('./helpers/runtime-stack');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-contracts-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let dbCounter = 0;
const newDbPath = () => path.join(tmpRoot, `state-${dbCounter += 1}.sqlite`);
const RUN_ID = 'run-1';

const brief = (roleName, allowedFiles = ['src/example.js']) => ({
  role: roleName,
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
const finish = (final = 'All done') => decision({ action: 'finish', final });
const report = (summary, overrides = {}) => JSON.stringify({
  outcome: 'completed', summary, filesChanged: [], filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null, ...overrides,
});
const textParts = (value) => [{ content: { $case: 'text', value } }];
const role = (name, sandbox) => ({ name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: 'Test agent' });
const roles = () => new Map([
  ['orch-builder', role('orch-builder', 'workspace-write')],
  ['orch-explorer', role('orch-explorer', 'read-only')],
  ['orch-architect', role('orch-architect', 'read-only')],
]);
const releasedWriter = (changedPaths = []) => ({
  executionId: 'exec-released', state: 'released', delta: { known: true, headChanged: false, changedPaths }, reason: null,
});
const okWriterFinal = (changedPaths = []) => () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts(report('done')), metadata: { writerExecution: releasedWriter(changedPaths) } }],
});
const invalidReportWriter = () => ({
  state: TaskState.TASK_STATE_COMPLETED,
  artifacts: [{ name: 'report', parts: textParts('not json'), metadata: { writerExecution: releasedWriter() } }],
});
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
const admissionRow = (contextId, state, extra = {}) => ({
  executionId: `exec-${contextId}`, contextId, state, delta: null, reason: null, ...extra,
});

// In-memory stand-in for WriterAdmission: rows by context id, scripted quiescence.
function makeFakeAdmission() {
  return {
    rows: new Map(),
    fences: [],
    reconciles: [],
    canProve: true,
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
}

// A2A + lead world shared across orchestrator "restarts": recorded tasks, sends, lead turns.
function makeWorld({ script, workerFinal }) {
  const world = {
    script,
    leadTurns: 0,
    prompts: [],
    dispatchInputs: [],
    sends: [],
    tasks: new Map(),
    workerFinal: workerFinal || ((roleName) => okWriterFinal()(roleName)),
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
      const text = typeof next === 'function' ? await next(args) : next;
      return { threadId: 'lead-thread', status: 'completed', text };
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
          return view(task, true);
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
  constructor(world, options = {}) {
    this.world = world;
    this.filePath = newDbPath();
    this.options = options;
  }

  async open() {
    this.state = await openStateDatabase({ filePath: this.filePath });
    this.journal = new DispatchJournal(this.state);
    this.orchestrator = new LeadOrchestrator({
      appServer: this.world.appServer,
      roles: roles(),
      workspace: this.options.workspace,
      baseUrl: 'http://127.0.0.1:4040',
      clientFactory: this.world.clientFactory,
      pollIntervalMs: 0,
      checkpointer: this.state.checkpointer,
      journal: this.journal,
      admission: this.world.admission,
      reconcileWaitMs: 20,
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
  const session = await new Session(world, options).open();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

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
function plainDir() {
  const dir = path.join(tmpRoot, `plain-${repoCounter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  return dir;
}
const nodeCheck = (id, code) => ({ id, argv: [process.execPath, '-e', code] });
const contractOf = (...requiredChecks) => ({ requiredChecks });
const issueCodes = (result) => result.acceptance.issues.map((issue) => issue.code);
const recordKey = (record) => `${record.predicate}:${record.result}:${record.code}`;
const outcomeKeys = (outcome) => outcome.boundary.results.map(recordKey);
const PASS = nodeCheck('ok', 'process.exit(0)');
const FAIL = nodeCheck('unit', 'process.exit(3)');
const threadConfig = { configurable: { thread_id: RUN_ID } };

// --------------------------------------------------------------- (a)

test('a writer with an invalid report is rejected even though every required check passes', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), finish('first, ACCEPTED'), finish('second, ACCEPTED')],
    workerFinal: invalidReportWriter,
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(PASS) });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.notEqual(result.acceptance.disposition, 'accepted');
    assert.ok(issueCodes(result).includes('report_invalid'));
    assert.deepEqual(result.acceptance.checks.map((check) => check.result), ['passed']);
    assert.ok(outcomeKeys(result.assignments[0]).includes('settle.report_valid:FAIL:report_invalid'));
    assert.equal(result.assignments[0].boundary.results[0].advisory, false);
    // Exactly one rework round: the first rejection returns to decide, the second finishes.
    assert.equal(world.leadTurns, 3);
    assert.match(world.prompts[2], /Acceptance note/);
  }, { workspace });
});

// --------------------------------------------------------------- (b)

test('a writer changing a file outside allowedFiles is rejected and its change is not deleted', async () => {
  const workspace = gitRepo();
  const stray = path.join(workspace, 'lib', 'other.js');
  const world = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('first'), finish('second')],
    workerFinal: () => {
      fs.mkdirSync(path.dirname(stray), { recursive: true });
      fs.writeFileSync(stray, 'stray change\n');
      return okWriterFinal(['lib/other.js'])();
    },
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(PASS) });
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.ok(issueCodes(result).includes('attested_scope_violation'));
    const outcome = result.assignments[0];
    assert.deepEqual(outcome.attestedScopeViolations, ['lib/other.js']);
    assert.ok(outcomeKeys(outcome).includes('settle.attested_scope:FAIL:attested_scope_violation'));
    assert.equal(fs.readFileSync(stray, 'utf8'), 'stray change\n');
  }, { workspace });
});

// --------------------------------------------------------------- (c)

test('an unresolved writer pauses the run, blocks writable dispatch, and its diagnostics survive restart and reconciliation', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [dispatch(brief('orch-builder')), dispatch(brief('orch-builder')), finish('Done')],
    workerFinal: (roleName, contextId) => {
      world.admission.rows.set(contextId, admissionRow(contextId, 'unresolved'));
      return unresolvedWriterTask(roleName);
    },
  });
  world.admission.canProve = false;
  await withSession(world, async (session) => {
    const paused = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(PASS) });
    assert.equal(paused.status, 'input_required');
    assert.equal(paused.pause.kind, 'writer_unresolved');
    assert.equal(paused.acceptance, undefined);
    // Writable dispatch is refused meanwhile: the lead is not asked again and nothing else is sent.
    assert.equal(world.leadTurns, 1);
    assert.equal(world.sends.length, 1);
    const again = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(again.pause.kind, 'writer_unresolved');
    assert.equal(world.leadTurns, 1);
    assert.equal(world.sends.length, 1);

    await session.restart();
    const stillPaused = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(stillPaused.pause.kind, 'writer_unresolved');
    assert.equal(world.sends.length, 1);

    world.admission.canProve = true;
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID, input: { answer: 'retry' } });
    assert.equal(result.status, 'completed');
    const unsettled = result.assignments
      .flatMap((outcome) => outcome.boundary.results)
      .filter((record) => record.predicate === 'settle.writer_settled');
    assert.ok(unsettled.length >= 1, 'writer_unresolved diagnostics must survive restart and reconciliation');
    for (const record of unsettled) {
      assert.equal(record.result, 'UNKNOWN');
      assert.equal(record.code, 'writer_unresolved');
      assert.deepEqual(record.evidence, ['writer_executions:exec-orch-builder']);
    }
    // The unresolved outcome keeps its record in the persisted checkpoint as well.
    const { values } = await session.orchestrator.graph.getState(threadConfig);
    const persisted = JSON.stringify(values);
    assert.match(persisted, /writer_executions:exec-orch-builder/);
    assert.match(persisted, /settle\.writer_settled/);
    assert.ok(result.assignments.filter((outcome) => outcome.kind === 'reconciliation').length >= 1);
  }, { workspace });
});

// --------------------------------------------------------------- (d)

test('an unavailable snapshot does not hide a failing required check', async () => {
  const world = makeWorld({ script: [finish('first, ACCEPTED'), finish('second, ACCEPTED')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Check', runId: RUN_ID, contract: contractOf(FAIL) });
    assert.equal(result.acceptance.disposition, 'rejected');
    const keys = result.acceptance.issues.map(recordKey);
    assert.ok(keys.includes('accept.checks:FAIL:check_failed'), keys.join(','));
    assert.ok(keys.includes('accept.snapshot:UNKNOWN:snapshot_unavailable'), keys.join(','));
  }, { workspace: plainDir() });
});

test('an unavailable snapshot with passing checks is unverifiable, never accepted', async () => {
  const world = makeWorld({ script: [finish('Done, ACCEPTED')] });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Check', runId: RUN_ID, contract: contractOf(PASS) });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'unverifiable');
    assert.deepEqual(result.acceptance.issues.map(recordKey), ['accept.snapshot:UNKNOWN:snapshot_unavailable']);
  }, { workspace: plainDir() });
});

// --------------------------------------------------------------- (e)

test('a rejected lead decision submits nothing and the valid follow-up completes the run', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [
      dispatch(brief('orch-builder', ['src/*'])),
      () => {
        assert.equal(world.sends.length, 0, 'nothing may be submitted for the rejected decision');
        assert.equal(world.admission.acquired.length, 0);
        return dispatch(brief('orch-builder', ['src']));
      },
      finish('Fixed'),
    ],
  });
  await withSession(world, async (session) => {
    const result = await session.orchestrator.run({ goal: 'Build', runId: RUN_ID, contract: contractOf(PASS) });
    assert.equal(result.status, 'completed');
    assert.equal(world.sends.length, 1);
    assert.deepEqual(world.dispatchInputs[0].allowedFiles, ['src']);
    assert.equal(result.rounds, 1);
    assert.equal(result.assignments.length, 1);
    assert.match(world.prompts[1], /Rejected decision:/);
    assert.match(world.prompts[1], /assignment\.paths path_glob_unsupported/);
    assert.equal(result.acceptance.disposition, 'accepted');
  }, { workspace });
});

// --------------------------------------------------------------- (f)

test('violation records and per-attempt pinned contracts survive a restart mid-run', async () => {
  const workspace = gitRepo();
  const world = makeWorld({
    script: [
      dispatch(brief('orch-builder', ['src/*'])),
      dispatch(brief('orch-builder', ['src/example.js'])),
      finish('first'),
      dispatch(brief('orch-builder', ['docs/x.md'])),
      finish('second'),
    ],
    workerFinal: okWriterFinal(['lib/other.js']),
  });
  await withSession(world, async (session) => {
    const stopped = await session.orchestrator.run({
      goal: 'Build', runId: RUN_ID, contract: contractOf(PASS), interruptAfter: ['collect'],
    });
    assert.equal(stopped.status, 'interrupted_for_test');
    await session.restart();
    const before = (await session.orchestrator.graph.getState(threadConfig)).values;
    assert.equal(before.rejections.length, 1);
    assert.ok(before.rejections[0].violations.some((entry) => entry.code === 'path_glob_unsupported'));
    assert.equal(before.batch.items[0].contract.id, 'boundary-contract/v1');
    assert.deepEqual(before.batch.items[0].contract.allowedFiles, ['src/example.js']);

    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.equal(result.assignments.length, 2);
    assert.deepEqual(result.assignments.map((outcome) => outcome.contract.allowedFiles), [['src/example.js'], ['docs/x.md']]);
    for (const outcome of result.assignments) {
      assert.equal(outcome.boundary.contract, 'boundary-contract/v1');
      assert.deepEqual(outcomeKeys(outcome), ['settle.attested_scope:FAIL:attested_scope_violation']);
    }
    await session.restart();
    const after = (await session.orchestrator.graph.getState(threadConfig)).values;
    assert.ok(after.rejections.some((entry) => entry.violations.some((violation) => violation.code === 'path_glob_unsupported')));
    const stored = JSON.stringify(after);
    assert.match(stored, /attested_scope_violation/);
    assert.match(stored, /boundary-contract\/v1/);
    assert.match(stored, /docs\/x\.md/);
    assert.match(world.prompts[1], /path_glob_unsupported/);
  }, { workspace });
});

// --------------------------------------------------------------- (g)

function legacyStrip(session) {
  return async () => {
    const { values } = await session.orchestrator.graph.getState(threadConfig);
    const items = values.batch.items.map(({ contract, ...rest }) => rest);
    await session.orchestrator.graph.updateState(threadConfig, { batch: { ...values.batch, items } }, 'collect');
  };
}

test('a legacy outcome without a pinned contract is labeled legacy and keeps today\'s disposition rules', async () => {
  const workspace = gitRepo();
  const violating = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('a'), finish('b')],
    workerFinal: okWriterFinal(['lib/other.js']),
  });
  await withSession(violating, async (session) => {
    const stopped = await session.orchestrator.run({
      goal: 'Build', runId: RUN_ID, contract: contractOf(PASS), interruptAfter: ['collect'],
    });
    assert.equal(stopped.status, 'interrupted_for_test');
    await legacyStrip(session)();
    await session.restart();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    const outcome = result.assignments[0];
    assert.equal(Object.hasOwn(outcome, 'contract'), false);
    assert.equal(outcome.boundary.contract, 'legacy');
    assert.deepEqual(outcome.attestedScopeViolations, ['lib/other.js']);
    assert.equal(result.acceptance.disposition, 'rejected');
    assert.ok(issueCodes(result).includes('attested_scope_violation'));
  }, { workspace });

  const clean = makeWorld({
    script: [dispatch(brief('orch-builder', ['src/example.js'])), finish('Done')],
    workerFinal: okWriterFinal(['src/example.js']),
  });
  await withSession(clean, async (session) => {
    const stopped = await session.orchestrator.run({
      goal: 'Build', runId: RUN_ID, contract: contractOf(PASS), interruptAfter: ['collect'],
    });
    assert.equal(stopped.status, 'interrupted_for_test');
    await legacyStrip(session)();
    const result = await session.orchestrator.resume({ runId: RUN_ID });
    assert.equal(result.assignments[0].boundary.contract, 'legacy');
    assert.deepEqual(result.assignments[0].boundary.results, []);
    assert.equal(result.acceptance.disposition, 'accepted');
  }, { workspace: gitRepo() });
});

// --------------------------------------------------------------- (h)

test('direct specialist endpoint over real A2A HTTP', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }
  const metaOf = (task) => task.status?.message?.metadata || {};
  const structuredRequest = (overrides = {}) => JSON.stringify({
    role: 'engineer',
    objective: 'Do a bounded task',
    allowedFiles: ['src/feature.txt'],
    inputs: ['goal'],
    evidence: ['none'],
    acceptanceCriteria: ['done'],
    checks: ['none'],
    stopConditions: ['blocked'],
    ...overrides,
  });

  await suite.test('a structured request with an unsafe path fails before any App Server run', async () => {
    const appServer = makeFakeAppServer();
    await withStack(appServer, async (stack) => {
      const task = await sendToAgent(stack, 'engineer', structuredRequest({ allowedFiles: ['../outside.txt'] }));
      assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
      const meta = metaOf(task);
      assert.equal(meta.failureKind, 'request_invalid');
      assert.equal(meta.effects, 'none');
      assert.equal(meta.boundary.contract, 'boundary-contract/v1');
      assert.ok(meta.boundary.results.some((entry) => entry.predicate === 'assignment.paths' && entry.code === 'path_unsafe' && entry.result === 'FAIL'));
      assert.equal(appServer.workerCalls.length, 0);
    });
  });

  await suite.test('a request for an acceptance guarantee fails with guarantee_unavailable before any run', async () => {
    const appServer = makeFakeAppServer();
    await withStack(appServer, async (stack) => {
      const task = await sendToAgent(stack, 'explorer', structuredRequest({ role: 'explorer', allowedFiles: [], requireAcceptance: true }));
      assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
      assert.equal(metaOf(task).failureKind, 'guarantee_unavailable');
      assert.equal(appServer.workerCalls.length, 0);
    });
  });

  await suite.test('a legacy plain-text request completes with boundary legacy and no certification', async () => {
    const appServer = makeFakeAppServer();
    await withStack(appServer, async (stack) => {
      const task = await sendToAgent(stack, 'explorer', 'Look around the repository and tell me what you see');
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(appServer.workerCalls.length, 1);
      const artifact = task.artifacts.at(-1);
      assert.deepEqual(artifact.metadata.boundary, { contract: 'legacy' });
      assert.equal(artifact.metadata.contract, null);
      assert.ok(artifact.metadata.reportError);
      assert.equal(task.metadata?.acceptance, undefined);
    });
  });
});
