'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { registerRoleAgents } = require('../src/a2a-role-service');
const { ConcurrentDeliveryEngine } = require('../src/concurrent-delivery-engine');
const { WriterAdmission } = require('../src/writer-admission');
const { LaneManager } = require('../src/writer-lanes');
const { readProcessIdentity, isProcessGroupGone } = require('../src/process-quiescence');
const { scopedExecutionDetails } = require('../src/delivery-role-capabilities');

const projectId = '0123456789';
const objectiveId = 'matched-objective';
const tasks = Object.freeze([
  Object.freeze({ id: 'fast', objective: 'Write the fast sibling output.', path: 'fast.txt', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'slow', objective: 'Inspect stable input while holding the slow sibling open.', path: 'slow.txt', dependencies: Object.freeze([]) }),
  Object.freeze({ id: 'dependent', objective: 'Read fast.txt and write the dependent output.', path: 'final.txt', dependencies: Object.freeze(['fast']) }),
]);
const files = Object.freeze({
  'source.txt': 'stable input\n',
  'verify-product.js': "'use strict';\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nassert.equal(fs.readFileSync('source.txt', 'utf8'), 'stable input\\n');\nassert.equal(fs.readFileSync('fast.txt', 'utf8'), 'fast sibling\\n');\nassert.equal(fs.readFileSync('final.txt', 'utf8'), 'fast sibling\\ndependent output\\n');\nassert.equal(fs.existsSync('slow.txt'), false);\nprocess.stdout.write('matched product passed\\n');\n",
});
const contract = Object.freeze({ requiredChecks: Object.freeze([
  Object.freeze({ id: 'matched-product', argv: Object.freeze([process.execPath, 'verify-product.js']), timeoutMs: 5000 }),
]) });
const review = Object.freeze({ kind: 'routine', checkpointId: 'matched-product', reason: 'Verify the implemented product.',
  paths: ['fast.txt', 'final.txt'], evidenceIds: ['matched-workload'], prerequisiteFor: [] });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, detail, timeoutMs = 12000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(typeof detail === 'function' ? detail() : detail)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate, detail) {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(typeof detail === 'function' ? detail() : detail);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function turnProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const identity = readProcessIdentity(child.pid);
  return { identity, async stop() {
    try { process.kill(-identity.pgid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await bounded(exited, 'Fake provider process did not exit.', 2000);
    await until(() => isProcessGroupGone(identity), 'Fake provider process group remains live.');
  } };
}

function report(summary, changed = [], inspected = ['source.txt']) {
  return JSON.stringify({ outcome: 'completed', summary, filesChanged: changed, filesInspected: inspected,
    checks: [{ command: 'inspect task input', result: 'passed', detail: 'Read the assigned predecessor input.' }],
    risks: [], scopeExpansion: [], decisionRequest: null });
}

function taskPayload(task) {
  return { objective: task.objective, allowedFiles: [task.path],
    inputs: [`Frozen candidate path: ${task.dependencies.length ? 'fast.txt' : 'source.txt'}`],
    evidence: ['source.txt'], acceptanceCriteria: ['The assigned output matches the frozen workload.'],
    checks: ['Host will execute pinned check: matched-product'],
    stopConditions: ['Do not publish, modify shared workspace state, or claim acceptance.'] };
}

function assignment(task, wave = null) {
  return { role: 'engineer', ...taskPayload(task), skills: [], mcpTools: [], wave,
    executionTarget: null, continueFrom: null, review: task.id === 'slow' ? null : review, repair: null };
}

function decision(action, assignments = []) {
  return JSON.stringify({ action, assignments, final: action === 'finish' ? 'Matched product completed.' : '',
    resolutions: [], humanInput: null });
}

async function harness(t, mode, schedule) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `engine-comparison-${mode}-`));
  const workspace = path.join(root, 'repo');
  const storageRoot = path.join(root, 'state');
  fs.mkdirSync(workspace);
  fs.mkdirSync(storageRoot);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Comparison Test');
  git('config', 'user.email', 'comparison@example.invalid');
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(workspace, file), contents);
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = new Database(path.join(storageRoot, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace });
  const app = express();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const roles = new Map(['engineer', 'verifier'].map((id) => [id, { id, name: id, description: `${id} fixture role`,
    sandbox: id === 'engineer' || mode === 'legacy' ? 'workspace-write' : 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' }]));
  const leadRole = { id: 'lead', name: 'coordinator', description: 'Fixture lead', model: 'test-model', effort: 'low', fastMode: 'off' };
  const codexHome = path.join(root, 'fake-codex-home');
  let engine;
  let plannerTurns = 0;
  let turnNumber = 0;
  const observedTasks = [];
  const reviewOutputs = [];
  const active = new Set();
  let peak = 0;
  const appServer = {
    getVersion: () => 'offline-comparison/1', getCodexHome: () => codexHome,
    async prepareThread({ role }) { return { threadId: `${mode}-${role.id}-thread`, codexHome }; },
    async run(options) {
      const proof = await turnProcess();
      const threadId = options.threadId || `${mode}-thread-${++turnNumber}`;
      const turnId = `${mode}-turn-${++turnNumber}`;
      let task;
      let text;
      try {
        options.onTurnStart?.({ threadId, processIdentity: proof.identity });
        if (options.role.id === 'lead' || options.role.name === 'coordinator') {
          plannerTurns += 1;
          if (mode === 'legacy') {
            if (plannerTurns === 1) text = decision('dispatch', tasks.slice(0, 2).map((item) => assignment(item, 1)));
            else if (plannerTurns === 2) text = decision('dispatch', [assignment(tasks[2])]);
            else if (plannerTurns === 3) text = decision('dispatch', [{ ...assignment(tasks[2]), role: 'verifier',
              objective: 'Verify the implemented product.', allowedFiles: ['fast.txt', 'final.txt'], review }]);
            else if (plannerTurns === 4) text = decision('finish');
            else throw new Error(`Unexpected legacy planner turn ${plannerTurns}`);
          } else {
            const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
            // Admit the frozen successor after its predecessor publishes so its base candidate includes that output.
            const plannedTasks = plannerTurns === 1 ? tasks.slice(0, 2) : plannerTurns === 2 ? tasks.slice(2) : [];
            const delta = plannedTasks.length ? {
              schemaVersion: 'delivery/v1', expectedPlanRevision: prompt.pins.planRevision,
              expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
              expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
              tasks: plannedTasks.map((item) => ({ task: { schemaVersion: 'delivery/v1', projectId, objectiveId,
                taskId: item.id, revision: 1, role: 'engineer', kind: 'implementation', objective: item.objective,
                priority: 1, dependencies: [], productWritePaths: [item.path],
                readScope: { kind: 'known', paths: item.dependencies.length ? ['fast.txt'] : ['source.txt'] },
                scratchWriteRoots: [`.scratch/${item.id}`], resourceClaims: [], evidenceRefs: ['source.txt'],
                acceptance: { criteria: taskPayload(item).acceptanceCriteria },
                publicationAuthority: { state: 'unknown' }, state: 'queued' } })),
              dependencies: plannedTasks.flatMap((item) => item.dependencies.map((predecessorId) => ({ schemaVersion: 'delivery/v1',
                projectId, objectiveId, predecessorType: 'task', predecessorId, successorTaskId: item.id, kind: 'requires_output' }))),
            } : null;
            text = JSON.stringify({ expected: prompt.pins, delta, dialogue: 'Execute and verify the frozen workload.', recovery: null, ownerDecision: null });
          }
        } else if (options.role.id === 'engineer') {
          // The legacy lane prepends execution guidance before the JSON request.
          const request = JSON.parse(options.input.slice(options.input.indexOf('{')));
          task = tasks.find((item) => item.objective === request.objective);
          assert.ok(task, `Unexpected task: ${request.objective}`);
          assert.notEqual(fs.realpathSync(options.cwd), fs.realpathSync(workspace));
          const payload = Object.fromEntries(Object.keys(taskPayload(task)).map((key) => [key, request[key]]));
          assert.deepEqual(payload, taskPayload(task));
          observedTasks.push({ id: task.id, payload });
          active.add(task.id);
          peak = Math.max(peak, active.size);
          schedule.record(mode, task.id, 'start', [...active]);
          if (task.id === 'fast' || task.id === 'slow') {
            schedule.initialStarts.add(`${mode}:${task.id}`);
            if (schedule.initialStarts.size === 4) schedule.initialReady.resolve();
          }
          const cwd = options.cwd;
          if (task.id === 'fast') {
            await schedule.initialReady.promise;
            assert.equal(fs.readFileSync(path.join(cwd, 'source.txt'), 'utf8'), files['source.txt']);
            fs.writeFileSync(path.join(cwd, task.path), 'fast sibling\n');
            text = report('Published the fast sibling output.', [task.path]);
          } else if (task.id === 'slow') {
            await schedule.releaseSlow.promise;
            assert.equal(fs.readFileSync(path.join(cwd, 'source.txt'), 'utf8'), files['source.txt']);
            text = report('Inspected stable input without changing source.');
          } else {
            const predecessor = fs.readFileSync(path.join(cwd, 'fast.txt'), 'utf8');
            assert.equal(predecessor, 'fast sibling\n');
            fs.writeFileSync(path.join(cwd, task.path), `${predecessor}dependent output\n`);
            text = report('Produced the dependent output.', [task.path], ['fast.txt']);
          }
        } else if (options.role.id === 'verifier') {
          const details = mode === 'concurrent' ? scopedExecutionDetails(options.deliveryCapability) : null;
          if (details) assert.equal(details.verifyCandidate(), true);
          const output = execFileSync(process.execPath, ['verify-product.js'], {
            cwd: details?.candidatePath || options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          });
          reviewOutputs.push(output);
          text = report('VERDICT: pass\nThe mandatory product check passed.', [], ['fast.txt', 'final.txt']);
        } else throw new Error(`Unexpected role: ${options.role.id}`);
      } finally {
        await proof.stop();
        if (task) {
          active.delete(task.id);
          schedule.record(mode, task.id, 'finish', [...active]);
        }
      }
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true,
          processIdentity: proof.identity, threadId, turnId } };
    },
  };
  const lanes = new LaneManager({ db, workspace, admission, appServer, mode: 'cooperative',
    lanesRoot: path.join(storageRoot, 'lanes'), links: [] });
  if (mode === 'legacy') {
    registerRoleAgents(app, { roles, appServer, workspace, baseUrl, admission, lanes });
    engine = new LeadOrchestrator({ roles, appServer, workspace, baseUrl, admission, leadRole,
      parallelWriters: true, pollIntervalMs: 5 });
  } else {
    const identity = { accountId: 'offline-account', codexHome };
    engine = new ConcurrentDeliveryEngine({ db, workspace, projectId, storageRoot,
      stateFile: path.join(storageRoot, 'state.sqlite'), baseUrl, authToken: 'offline-token',
      authMiddleware(req, res, next) { return req.get('authorization') === 'Bearer offline-token' ? next() : res.sendStatus(401); },
      appServer, providerIdentity: identity, providerIdentityFor: () => identity, roles, leadRole, admission, lanes,
      writerIsolation: { mode: 'cooperative', inherited: true, profile: ':danger-full-access', confinement: 'none' }, sleepMs: 5 });
    engine.register(app);
  }
  t.after(async () => {
    try { await engine.shutdown?.(); }
    finally {
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { engine, db, workspace, root, observedTasks, reviewOutputs, active, peak: () => peak };
}

test('V41 matched actual legacy and concurrent paths accept equal output with causal dependency progress', { timeout: 35000 }, async (t) => {
  const schedule = { initialStarts: new Set(), initialReady: deferred(), releaseSlow: deferred(), trace: [],
    record(mode, task, event, active) { this.trace.push({ sequence: this.trace.length, mode, task, event, active }); } };
  const abort = new AbortController();
  t.after(() => { schedule.initialReady.resolve(); schedule.releaseSlow.resolve(); abort.abort(); });
  const legacy = await harness(t, 'legacy', schedule);
  const concurrent = await harness(t, 'concurrent', schedule);
  const input = { runId: 'matched-run', goal: 'Execute the frozen matched workload and verify its product.', contract,
    signal: abort.signal };
  const running = [legacy.engine.run(input), concurrent.engine.run({ ...input,
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId, sessionId: 'matched-session' } })];
  // Attach rejection handlers immediately, including while waiting at the scheduling barrier.
  const resultsPromise = Promise.all(running);
  resultsPromise.catch(() => {});
  const settledResults = [];
  running.forEach((promise, index) => promise.then((result) => { settledResults[index] = result; },
    (error) => { settledResults[index] = { error: error.stack }; }));
  try {
    await bounded(Promise.race([schedule.initialReady.promise, resultsPromise.then(() => { throw new Error('Runs ended before initial workers started.'); })]), () => `Initial workers did not start: ${JSON.stringify(schedule.trace)}`);
    await until(() => concurrent.engine.store.getObjective(projectId, objectiveId).tasks
      .find((item) => item.taskId === 'dependent')?.state === 'succeeded'
      && fs.existsSync(path.join(legacy.workspace, 'fast.txt')),
    () => `Dependency publication did not progress: ${JSON.stringify({ trace: schedule.trace,
      objective: concurrent.engine.store.getObjective(projectId, objectiveId) })}`);
    assert.deepEqual([...legacy.active], ['slow']);
    assert.deepEqual([...concurrent.active], ['slow']);
    assert.equal(schedule.trace.some((entry) => entry.mode === 'legacy' && entry.task === 'dependent'), false);
    const dependentAttempt = concurrent.engine.store.listAttempts(projectId, objectiveId).find((item) => item.taskId === 'dependent');
    assert.equal(concurrent.engine.roleService.getExecution(dependentAttempt.attemptId).result.output.state, 'published');
    schedule.record('both', 'slow', 'release', []);
    schedule.releaseSlow.resolve();
    const [legacyResult, concurrentResult] = await bounded(resultsPromise, () => `Completion failed: ${JSON.stringify(schedule.trace)}`);
    assert.equal(legacyResult.status, 'completed', JSON.stringify(legacyResult));
    assert.equal(legacyResult.acceptance.disposition, 'accepted', JSON.stringify(legacyResult));
    assert.equal(concurrentResult.status, 'completed', JSON.stringify(concurrentResult));
    assert.equal(concurrentResult.disposition, 'accepted', JSON.stringify(concurrentResult));
    assert.equal(concurrentResult.acceptance.disposition, 'accepted');

    const accepted = concurrent.engine.store.listFinalizations(projectId, objectiveId).find((item) => item.state === 'accepted');
    assert.ok(accepted?.terminalRecord);
    assert.equal(accepted.terminalRecord.disposition, 'accepted');
    assert.equal(accepted.terminalRecord.pins.candidate.candidateId, concurrentResult.candidateId);
    const projection = concurrent.engine.reviewStore.finalizationProjection({ projectId, objectiveId,
      candidateId: concurrentResult.candidateId, requiredRoles: ['verifier'] });
    assert.equal(projection.complete, true, JSON.stringify(projection));
    assert.deepEqual(projection.receipts[0].receipt.checkPins, ['matched-product']);
    const legacyState = (await legacy.engine.graph.getState({ configurable: { thread_id: input.runId } })).values;
    assert.ok(legacyState.outcomes.some((item) => item.role === 'verifier' && item.reviewResult?.accepted === true),
      JSON.stringify(legacyState.outcomes));

    const candidatePath = path.join(concurrent.root, 'accepted-product');
    concurrent.engine.candidateStore.materialize(concurrentResult.candidateId, candidatePath);
    const readProduct = (cwd) => {
      const entries = fs.readdirSync(cwd).filter((file) => file !== '.git').sort();
      assert.deepEqual(entries, ['fast.txt', 'final.txt', 'source.txt', 'verify-product.js']);
      return Object.fromEntries(entries.map((file) => [file, fs.readFileSync(path.join(cwd, file), 'utf8')]));
    };
    assert.deepEqual(readProduct(candidatePath), readProduct(legacy.workspace));
    assert.equal(fs.existsSync(path.join(candidatePath, 'slow.txt')), false);
    assert.deepEqual(concurrent.reviewOutputs, legacy.reviewOutputs);
    assert.deepEqual(legacy.reviewOutputs, ['matched product passed\n']);
    const normalizeChecks = (checks) => checks.map(({ id, argv, result, exitCode, stdoutTail, stderrTail }) =>
      ({ id, argv, result, exitCode, stdoutTail, stderrTail }));
    assert.deepEqual(normalizeChecks(concurrentResult.acceptance.checkResults), normalizeChecks(legacyResult.acceptance.checks));
    assert.equal(legacyResult.acceptance.checks[0].result, 'passed');
    assert.equal(legacyResult.acceptance.checks[0].stdoutTail, 'matched product passed\n');
    const expectedTasks = tasks.map((item) => ({ id: item.id, payload: taskPayload(item) }));
    const objective = concurrent.engine.store.getObjective(projectId, objectiveId);
    assert.deepEqual(objective.dependencies.map(({ predecessorId, successorTaskId, kind }) =>
      ({ predecessorId, successorTaskId, kind })), [{ predecessorId: 'fast', successorTaskId: 'dependent', kind: 'requires_output' }]);
    assert.deepEqual(legacyState.contract.requiredChecks, concurrent.engine.checkContract.get(objectiveId).requiredChecks);
    const sorted = (items) => [...items].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(sorted(legacy.observedTasks), sorted(expectedTasks));
    assert.deepEqual(sorted(concurrent.observedTasks), sorted(expectedTasks));
    assert.equal(legacy.peak(), 2);
    assert.equal(concurrent.peak(), 2);
    const sequence = (mode, task, event) => {
      const entries = schedule.trace.filter((item) => item.mode === mode && item.task === task && item.event === event);
      assert.equal(entries.length, 1, JSON.stringify(schedule.trace));
      return entries[0].sequence;
    };
    const released = sequence('both', 'slow', 'release');
    for (const mode of ['legacy', 'concurrent']) {
      assert.ok(sequence(mode, 'slow', 'start') < sequence(mode, 'fast', 'finish'));
      assert.ok(sequence(mode, 'fast', 'finish') < sequence(mode, 'dependent', 'start'));
      assert.ok(released < sequence(mode, 'slow', 'finish'));
    }
    assert.ok(sequence('concurrent', 'dependent', 'finish') < released);
    assert.ok(sequence('legacy', 'slow', 'finish') < sequence('legacy', 'dependent', 'start'));
    assert.deepEqual([...schedule.trace.find((item) => item.mode === 'concurrent' && item.task === 'dependent' && item.event === 'start').active].sort(),
      ['dependent', 'slow']);
    assert.deepEqual(schedule.trace.find((item) => item.mode === 'legacy' && item.task === 'dependent' && item.event === 'start').active,
      ['dependent']);
    t.diagnostic(JSON.stringify({ peakWorkers: { legacy: legacy.peak(), concurrent: concurrent.peak() }, trace: schedule.trace,
      acceptedChecks: normalizeChecks(legacyResult.acceptance.checks) }));
  } catch (error) {
    const state = (await legacy.engine.graph.getState({ configurable: { thread_id: input.runId } })).values;
    t.diagnostic(JSON.stringify({ settledResults, legacyRejections: state.rejections, legacyOutcomes: state.outcomes }));
    throw error;
  } finally {
    schedule.initialReady.resolve();
    schedule.releaseSlow.resolve();
    abort.abort();
    await bounded(Promise.allSettled(running), 'Comparison cleanup did not settle.');
  }
});
