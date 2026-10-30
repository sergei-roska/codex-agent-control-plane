'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ServerCallContext } = require('@a2a-js/sdk/server');
const { TaskState } = require('@a2a-js/sdk');
const { startServer } = require('../src/server');
const { readProcessIdentity, isProcessGroupGone } = require('../src/process-quiescence');
const { scopedExecutionDetails } = require('../src/delivery-role-capabilities');

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

function workerReport(outcome, summary, changed = [], checkResult = 'passed') {
  return JSON.stringify({ outcome, summary, filesChanged: changed, filesInspected: ['source.txt'],
    checks: [{ command: 'inspect source.txt', result: checkResult, detail: 'Inspected the frozen source input.' }],
    risks: [], scopeExpansion: [], decisionRequest: null });
}

function message(text, contract) {
  return { messageId: 'recovery-intake', contextId: '', taskId: '', role: 1,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: { acceptance: contract }, extensions: [], referenceTaskIds: [] };
}

test('V43 composed server recovers a known worker failure through investigation and distinct repair to accepted checks', { timeout: 35000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-recovery-acceptance-'));
  const workspace = path.join(root, 'repo');
  const codexHome = path.join(root, 'fake-home');
  const settingsFile = path.join(root, 'settings.json');
  const roleOverridesFile = path.join(root, 'roles.json');
  fs.mkdirSync(workspace);
  fs.mkdirSync(codexHome);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Recovery Test');
  git('config', 'user.email', 'recovery@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'broken input\n');
  const checkSource = "'use strict';\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nassert.equal(fs.readFileSync('source.txt', 'utf8'), 'repaired input\\n');\nprocess.stdout.write('recovered product passed\\n');\n";
  fs.writeFileSync(path.join(workspace, 'verify-product.js'), checkSource);
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: Object.fromEntries(
    ['coordinator', 'engineer', 'explorer', 'verifier'].map((id) => [id, { model: 'test-model', effort: 'low', fastMode: 'off' }])) }));
  const contract = { requiredChecks: [{ id: 'repaired-product', argv: [process.execPath, 'verify-product.js'], timeoutMs: 5000 }] };
  const originalContract = JSON.stringify(contract);
  const investigationEntered = deferred();
  const releaseInvestigation = deferred();
  const activeThreads = new Set();
  const calls = [];
  const plannerOutputs = [];
  let plannerCalls = 0;
  let runtime;
  let runId;
  let failureSnapshot;
  let failedExecutionSnapshot;
  let pending;
  const identity = { accountId: 'offline-recovery-account', codexHome };
  const objective = () => {
    const mapping = runtime.orchestrator.mapping(runId);
    return runtime.concurrentEngine.store.getObjective(runtime.projectId, mapping.objectiveId);
  };
  const task = (id, role, paths, objectiveText, extra = {}) => ({
    schemaVersion: 'delivery/v1', projectId: runtime.projectId, objectiveId: objective().objectiveId,
    taskId: id, revision: 1, role, kind: role === 'explorer' ? 'investigation' : 'implementation',
    objective: objectiveText, priority: 1, dependencies: [], productWritePaths: paths,
    readScope: { kind: 'known', paths: ['source.txt'] }, scratchWriteRoots: [`.scratch/${id}`],
    resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued', ...extra,
  });
  const appServer = {
    async start() {}, async close() {}, async getAccount() { return { account: { type: 'chatgpt' } }; },
    getVersion: () => 'offline-recovery/1', getCodexHome: () => codexHome,
    resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
    async prepareThread({ role }) { return { threadId: `${role.id || role.name}-prepared-thread`, codexHome }; },
    async execCommand({ command, cwd }) {
      try {
        return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (error) { return { exitCode: error.status || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }; }
    },
    async run(options) {
      const role = options.role.id || options.role.name;
      const threadId = options.threadId || `${role}-thread-${calls.length}`;
      assert.equal(activeThreads.has(threadId), false, `Provider thread overlapped: ${threadId}`);
      activeThreads.add(threadId);
      const turnId = `recovery-turn-${calls.length}`;
      calls.push({ role, threadId, turnId });
      const proof = await turnProcess();
      let text;
      try {
        assert.equal(options.role.model, 'test-model');
        options.onTurnStart({ threadId, processIdentity: proof.identity });
        if (role === 'coordinator') {
          plannerCalls += 1;
          const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
          runId ||= runtime.concurrentEngine.activeRuns()[0].runId;
          const current = objective();
          const byId = new Map(current.tasks.map((item) => [item.taskId, item]));
          let nextTask = null;
          let recovery = null;
          if (!byId.has('initial-write')) nextTask = task('initial-write', 'engineer', ['source.txt'], 'Try the original bounded source repair.');
          else if (byId.get('initial-write').state === 'failed' && !byId.has('diagnose')) {
            assert.ok(prompt.projection.blockers.some((item) => item.state === 'failed'));
            const attempt = runtime.concurrentEngine.store.listAttempts(runtime.projectId, current.objectiveId)
              .find((item) => item.taskId === 'initial-write');
            assert.equal(attempt.state, 'failed');
            assert.equal(attempt.outcome.publicationState, 'not_published');
            failureSnapshot = structuredClone(attempt);
            failedExecutionSnapshot = structuredClone(runtime.concurrentEngine.roleService.getExecution(attempt.attemptId));
            nextTask = task('diagnose', 'explorer', [], 'Investigate the failed repair using the retained failure evidence.');
            nextTask.evidenceRefs = [`delivery-role-execution:${attempt.attemptId}`];
            recovery = { mode: 'investigate', hypothesisId: 'source-value-mismatch', attemptsRemaining: 1 };
          } else if (byId.get('diagnose')?.state === 'succeeded' && !byId.has('repair-write')) {
            nextTask = task('repair-write', 'engineer', ['source.txt'], 'Repair the source value after the completed investigation.',
              { supersedesTaskId: 'initial-write' });
            recovery = { mode: 'repair', hypothesisId: 'source-value-mismatch', attemptsRemaining: 0 };
          }
          const delta = nextTask ? { schemaVersion: 'delivery/v1', expectedPlanRevision: prompt.pins.planRevision,
            expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
            expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
            tasks: [{ ...(nextTask.supersedesTaskId ? { expectedRevision: 1 } : {}), task: nextTask }], dependencies: [] } : null;
          const output = { expected: prompt.pins, delta, dialogue: 'Continue bounded internal recovery and preserve the mandatory checks.',
            recovery, ownerDecision: null };
          plannerOutputs.push(structuredClone(output));
          text = JSON.stringify(output);
        } else if (role === 'engineer') {
          const request = JSON.parse(options.input);
          assert.notEqual(fs.realpathSync(options.cwd), fs.realpathSync(workspace));
          assert.equal(fs.readFileSync(path.join(options.cwd, 'source.txt'), 'utf8'), 'broken input\n');
          if (request.objective === 'Try the original bounded source repair.') {
            text = workerReport('failed', 'The source value does not meet the mandatory product check. No edits were made.', [], 'failed');
          } else {
            assert.equal(request.objective, 'Repair the source value after the completed investigation.');
            assert.equal(objective().tasks.find((item) => item.taskId === 'diagnose').state, 'succeeded');
            fs.writeFileSync(path.join(options.cwd, 'source.txt'), 'repaired input\n');
            text = workerReport('completed', 'Repaired the investigated source value.', ['source.txt']);
          }
        } else if (role === 'explorer') {
          assert.equal(fs.readFileSync(path.join(options.cwd, 'source.txt'), 'utf8'), 'broken input\n');
          assert.equal(runtime.concurrentEngine.roleService.getExecution(failureSnapshot.attemptId).report.outcome, 'failed');
          investigationEntered.resolve();
          await releaseInvestigation.promise;
          text = workerReport('completed', 'Investigation: source.txt contains broken input; the bounded repair is to write repaired input.');
        } else if (role === 'verifier') {
          const details = scopedExecutionDetails(options.deliveryCapability);
          assert.equal(details.verifyCandidate(), true);
          const stdout = execFileSync(process.execPath, ['verify-product.js'], { cwd: details.candidatePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          assert.equal(stdout, 'recovered product passed\n');
          text = workerReport('completed', 'VERDICT: pass\nThe independently inspected repaired candidate passed its product check.');
        } else throw new Error(`Unexpected role ${role}`);
      } finally {
        await proof.stop();
        activeThreads.delete(threadId);
      }
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { threadId, turnId, processIdentity: proof.identity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
    },
  };
  t.after(async () => {
    releaseInvestigation.resolve();
    try {
      if (runtime) {
        try { await runtime.close(); }
        finally {
          runtime.httpServer?.closeAllConnections?.();
          if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
          if (runtime.state.db.open) await runtime.state.close();
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  try {
    runtime = await startServer({ port: 0, workspace, stateFile: path.join(root, 'state.sqlite'),
      tokenFile: path.join(root, 'token'), workspaceLockDir: path.join(root, 'locks'),
      deliveryStorageRoot: path.join(root, 'delivery-storage'), projectSettingsFile: settingsFile, roleOverridesFile,
      autoResume: false, appServer, providerIdentityPinFactory: () => ({ providerIdentity: identity, providerIdentityFor: () => identity }) });
    assert.equal(runtime.deliveryEngine, 'concurrent-v1');
    assert.equal(runtime.writerIsolation.mode, 'cooperative');
    pending = runtime.leadAgent.requestHandler.sendMessage({
      message: message('Repair source.txt through a bounded investigation if the first attempt fails.', contract), configuration: {},
    }, new ServerCallContext({ tenant: '' }));
    pending.catch(() => {});
    await bounded(Promise.race([investigationEntered.promise, pending.then((result) => {
      throw new Error(`Run ended before investigation: ${JSON.stringify(result)}`);
    })]), () => `Investigation did not start: ${JSON.stringify({ calls, objective: runId && objective() })}`);
    const engine = runtime.concurrentEngine;
    const db = runtime.state.db;
    const controller = engine.controllers.get(runId);
    const token = fs.readFileSync(path.join(root, 'token'), 'utf8').trim();
    const url = `http://127.0.0.1:${runtime.port}/control/delivery/${encodeURIComponent(runId)}`;
    const headers = { authorization: `Bearer ${token}` };
    const denied = await fetch(url, { headers: { authorization: 'Bearer invalid-token' } });
    assert.equal(denied.status, 401);
    await denied.text();
    const statusResponse = await fetch(url, { headers });
    assert.equal(statusResponse.status, 200);
    const held = await statusResponse.json();
    assert.equal(held.projectId, runtime.projectId);
    assert.equal(held.objectiveId, objective().objectiveId);
    assert.equal(held.revisions.planRevision, 2);
    assert.equal(held.revisions.goalRevision, 1);
    assert.equal(held.revisions.controlRevision, 1);
    const steer = { runId, projectId: runtime.projectId, sessionId: held.sessionId, objectiveId: held.objectiveId,
      messageId: 'recovery-steer', text: 'Keep the original goal and mandatory checks while investigating.',
      expectedPlanRevision: held.revisions.planRevision, expectedGoalRevision: held.revisions.goalRevision,
      expectedControlRevision: held.revisions.controlRevision };
    const post = (body, auth = token) => fetch(`${url}/steer`, { method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const unauthorized = await post(steer, 'invalid-token');
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    assert.equal(controller.inbox.get(steer.messageId), null);
    const stale = await post({ ...steer, expectedPlanRevision: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'steer_revision_stale');
    const response = await post(steer);
    assert.equal(response.status, 200);
    const ack = await response.json();
    assert.equal(ack.acknowledged, true);
    assert.equal(ack.state, 'received');
    assert.equal(ack.messageId, steer.messageId);
    await until(() => controller.inbox.get(steer.messageId)?.state === 'applied', 'Authenticated steering was not applied.');
    const storedSteer = db.prepare('SELECT state,result_json FROM delivery_inbox_messages WHERE message_id=?').get(steer.messageId);
    assert.equal(storedSteer.state, 'applied');
    assert.equal(JSON.parse(storedSteer.result_json).turnApplied, true);
    assert.equal(controller.inbox.get(steer.messageId).kind, 'steering');
    assert.equal(controller.inbox.get(steer.messageId).authenticatedOwner, false);
    assert.equal(controller.inbox.projection().wakeup, false);
    const idlePlannerCalls = plannerCalls;
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(plannerCalls, idlePlannerCalls, 'No model turn is eligible while investigation remains held.');
    assert.equal(objective().planRevision, held.revisions.planRevision);
    assert.equal(objective().goalRevision, held.revisions.goalRevision);
    assert.equal(objective().controlRevision, held.revisions.controlRevision);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_planner_turns WHERE status IN ('active','unknown')").get().n, 0);
    releaseInvestigation.resolve();
    const result = await bounded(pending, () => `Recovery did not accept: ${JSON.stringify({ calls, tasks: objective().tasks.map(({ taskId, state }) => ({ taskId, state })),
      scheduler: controller.status().scheduler, lastPlanner: controller.status().lastPlanner })}`);
    assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(result));
    const acceptedRun = db.prepare('SELECT contract_json,result_json FROM concurrent_delivery_runs WHERE run_id=?').get(runId);
    const acceptedResult = JSON.parse(acceptedRun.result_json);
    assert.equal(acceptedResult.status, 'completed');
    assert.equal(acceptedResult.disposition, 'accepted');
    assert.equal(acceptedResult.acceptance.disposition, 'accepted');
    assert.deepEqual(acceptedResult.acceptance.requiredCheckIds, ['repaired-product']);
    assert.equal(acceptedResult.acceptance.checkResults[0].result, 'passed');
    const stdoutRef = acceptedResult.acceptance.checkResults[0].stdoutEvidence;
    assert.equal(stdoutRef.stored, true);
    assert.equal(engine.evidenceStore.read(stdoutRef.id, { runId: stdoutRef.runId }).bytes.toString('utf8'), 'recovered product passed\n');
    assert.deepEqual(JSON.parse(acceptedRun.contract_json).requiredChecks, contract.requiredChecks);
    assert.equal(JSON.stringify(contract), originalContract);
    assert.equal(objective().goalRevision, 1);
    assert.equal(objective().controlRevision, 1);
    assert.equal(objective().planRevision, 4);
    assert.equal(objective().tasks.find((item) => item.taskId === 'initial-write').state, 'superseded');
    const attempts = engine.store.listAttempts(runtime.projectId, held.objectiveId);
    assert.equal(attempts.filter((item) => item.state === 'failed').length, 1);
    assert.equal(attempts.filter((item) => item.taskId === 'initial-write').length, 1);
    assert.deepEqual(attempts.find((item) => item.attemptId === failureSnapshot.attemptId), failureSnapshot);
    assert.deepEqual(engine.roleService.getExecution(failureSnapshot.attemptId), failedExecutionSnapshot);
    assert.equal(failedExecutionSnapshot.report.outcome, 'failed');
    assert.equal(failedExecutionSnapshot.report.checks[0].result, 'failed');
    assert.equal(failedExecutionSnapshot.result.output.state, 'not_published');
    assert.equal(failedExecutionSnapshot.effectsSettled, true);
    assert.equal(isProcessGroupGone(failedExecutionSnapshot.execution.processIdentity), true);
    const repairAttempt = attempts.find((item) => item.taskId === 'repair-write');
    assert.equal(repairAttempt.state, 'succeeded');
    assert.notEqual(repairAttempt.attemptId, failureSnapshot.attemptId);
    assert.notEqual(repairAttempt.providerContextId, failureSnapshot.providerContextId);
    assert.equal(engine.roleService.getExecution(repairAttempt.attemptId).result.output.state, 'published');
    const receipts = engine.reviewStore.finalizationProjection({ projectId: runtime.projectId,
      objectiveId: held.objectiveId, candidateId: acceptedResult.candidateId, requiredRoles: ['verifier'] });
    assert.equal(receipts.complete, true, JSON.stringify(receipts));
    assert.equal(receipts.receipts.length, 1);
    assert.deepEqual(receipts.receipts[0].receipt.checkPins, ['repaired-product']);
    assert.equal(receipts.receipts[0].receipt.candidateId, acceptedResult.candidateId);
    const verifierProof = JSON.parse(db.prepare('SELECT proof_json FROM concurrent_verifier_check_proofs').get().proof_json);
    assert.equal(verifierProof.evidenceRefs.every((ref) => typeof ref === 'string'), true);
    const storedCheckRefs = verifierProof.evidenceRefs.filter((ref) => /^ev_[0-9a-f]{32}$/.test(ref));
    assert.equal(storedCheckRefs.length, 2);
    for (const id of storedCheckRefs) {
      const evidence = engine.evidenceStore.read(id, { runId: verifierProof.attemptId });
      assert.equal(evidence.ref.checkId, 'repaired-product');
      assert.ok(['check_stdout', 'check_stderr'].includes(evidence.ref.kind));
    }
    const finalization = engine.store.listFinalizations(runtime.projectId, held.objectiveId).find((item) => item.state === 'accepted');
    assert.equal(finalization.terminalRecord.pins.candidate.candidateId, acceptedResult.candidateId);
    assert.equal(finalization.terminalRecord.disposition, 'accepted');
    const acceptedPath = path.join(root, 'accepted-product');
    engine.candidateStore.materialize(acceptedResult.candidateId, acceptedPath);
    assert.equal(fs.readFileSync(path.join(acceptedPath, 'source.txt'), 'utf8'), 'repaired input\n');
    assert.equal(fs.readFileSync(path.join(acceptedPath, 'verify-product.js'), 'utf8'), checkSource);
    assert.deepEqual(calls.filter((item) => item.role !== 'coordinator').map((item) => item.role), ['engineer', 'explorer', 'engineer', 'verifier']);
    assert.equal(plannerOutputs.every((item) => item.ownerDecision === null), true);
    assert.equal(plannerOutputs.filter((item) => item.recovery?.mode === 'investigate').length, 1);
    assert.equal(plannerOutputs.filter((item) => item.recovery?.mode === 'repair').length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_inbox_messages WHERE json_extract(message_json,'$.kind')='owner_correction'").get().n, 0);
    assert.equal(activeThreads.size, 0);
    t.diagnostic(JSON.stringify({ calls, failedAttempt: failureSnapshot.attemptId, repairAttempt: repairAttempt.attemptId,
      candidateId: acceptedResult.candidateId, planRevision: objective().planRevision, steerState: storedSteer.state,
      acceptedStdout: engine.evidenceStore.read(stdoutRef.id, { runId: stdoutRef.runId }).bytes.toString('utf8'),
      acceptedChecks: acceptedResult.acceptance.checkResults.map(({ id, result: checkResult, stdoutTail }) => ({ id, result: checkResult, stdoutTail })) }));
  } catch (error) {
    if (runtime) t.diagnostic(JSON.stringify({ error: error.stack, calls, plannerOutputs,
      objective: runId && objective(), roles: runtime.concurrentEngine.roleService.projection(),
      parked: runId && runtime.concurrentEngine.controllers.get(runId)?.status().scheduler.parked }));
    throw error;
  } finally {
    releaseInvestigation.resolve();
  }
});
