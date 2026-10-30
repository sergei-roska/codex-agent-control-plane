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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

test('owner decision survives real host and SQLite reopen and resumes mandatory acceptance', { timeout: 35000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-decision-restart-'));
  const workspace = path.join(root, 'repo');
  const codexHome = path.join(root, 'fake-home');
  fs.mkdirSync(workspace); fs.mkdirSync(codexHome);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'accepted input\n');
  fs.writeFileSync(path.join(workspace, 'verify-product.js'), "const assert = require('node:assert/strict'); assert.equal(require('node:fs').readFileSync('source.txt', 'utf8'), 'accepted input\\n'); console.log('verified');\n");
  git('add', '.'); git('commit', '-qm', 'base');
  const settingsFile = path.join(root, 'settings.json'); const roleOverridesFile = path.join(root, 'roles.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: Object.fromEntries(
    ['coordinator', 'explorer', 'verifier'].map((id) => [id, { model: 'test-model', effort: 'low', fastMode: 'off' }])) }));
  const calls = []; let prepared = 0; let runtime; let runId; let coordinatorBarrier = null;
  const identity = { accountId: 'offline-owner-account', codexHome };
  const appServer = {
    async start() {}, async close() {}, async getAccount() { return { account: { type: 'chatgpt' } }; },
    getVersion: () => 'offline-owner/1', getCodexHome: () => codexHome,
    resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
    async prepareThread({ role }) { prepared += 1; return { threadId: `${role.id || role.name}-prepared-thread`, codexHome }; },
    async execCommand({ command, cwd }) {
      try { return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8' }), stderr: '' }; }
      catch (error) { return { exitCode: error.status || 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }; }
    },
    async run(options) {
      const role = options.role.id || options.role.name; const threadId = options.threadId || `${role}-${calls.length}`;
      const turnId = `turn-${calls.length}`; calls.push(role); const proof = await turnProcess(); let text;
      try {
        options.onTurnStart({ threadId, processIdentity: proof.identity });
        if (role === 'coordinator') {
          if (coordinatorBarrier) {
            const barrier = coordinatorBarrier; coordinatorBarrier = null;
            barrier.started.resolve(); await barrier.release.promise;
          }
          const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
          const investigated = prompt.projection.investigationEvidence[0];
          const resolved = prompt.projection.ownerDecisions.find((item) => item.state === 'resolved');
          if (resolved) assert.equal(resolved.response.optionId, 'keep');
          const initialPlan = prompt.pins.planRevision === 0;
          const correctedTaskId = 'investigate-corrected-choice';
          const correctedPlan = prompt.pins.goalRevision > 1 && !prompt.projection.queue.some((item) => item.taskId === correctedTaskId);
          const task = { schemaVersion: 'delivery/v1', projectId: runtime.projectId, objectiveId: prompt.projection.objectiveId,
            taskId: initialPlan ? 'investigate-choice' : correctedTaskId, revision: 1, role: 'explorer', kind: 'investigation', objective: 'Investigate the requirement.',
            priority: 1, dependencies: [], productWritePaths: [], readScope: { kind: 'known', paths: ['source.txt'] },
            scratchWriteRoots: ['.scratch/investigate'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' };
          const delta = initialPlan || correctedPlan ? { schemaVersion: 'delivery/v1', expectedPlanRevision: prompt.pins.planRevision,
            expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
            expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
            tasks: [{ task }], dependencies: [] } : null;
          const ownerDecision = investigated && !resolved ? { decisionId: 'required-choice', reason: 'prd_requirement_change',
            question: 'Which requirement should apply?', options: [{ id: 'keep', description: 'Keep current behavior.' },
              { id: 'change', description: 'Use a later requirement correction.' }], recommendation: 'keep',
            evidenceRefs: [`attempt:${investigated.attemptId}`], obligations: [{ kind: 'objective_acceptance', id: prompt.projection.objectiveId }] } : null;
          text = JSON.stringify({ expected: prompt.pins, delta, dialogue: 'Follow the owner boundary.', recovery: null, ownerDecision });
        } else if (role === 'explorer' || role === 'verifier') {
          if (role === 'verifier') {
            const details = scopedExecutionDetails(options.deliveryCapability); assert.equal(details.verifyCandidate(), true);
            assert.equal(execFileSync(process.execPath, ['verify-product.js'], { cwd: details.candidatePath, encoding: 'utf8' }), 'verified\n');
          } else assert.equal(fs.readFileSync(path.join(options.cwd, 'source.txt'), 'utf8'), 'accepted input\n');
          text = workerReport('completed', role === 'verifier' ? 'VERDICT: pass\nVerified current candidate.' : 'Investigated requirement and source.');
        } else throw new Error(`Unexpected role ${role}`);
      } finally { await proof.stop(); }
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [], execution: {
        threadId, turnId, processIdentity: proof.identity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
    },
  };
  const options = { port: 0, workspace, stateFile: path.join(root, 'state.sqlite'), tokenFile: path.join(root, 'token'),
    workspaceLockDir: path.join(root, 'locks'), deliveryStorageRoot: path.join(root, 'delivery-storage'),
    projectSettingsFile: settingsFile, roleOverridesFile, autoResume: false, appServer,
    providerIdentityPinFactory: () => ({ providerIdentity: identity, providerIdentityFor: () => identity }) };
  t.after(async () => { try { if (runtime) { for (const controller of runtime.concurrentEngine.controllers.values()) controller.stop(); await runtime.close(); } } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  runtime = await startServer(options);
  const contract = { requiredChecks: [{ id: 'product', argv: [process.execPath, 'verify-product.js'], timeoutMs: 5000 }] };
  const waiting = await bounded(runtime.orchestrator.run({ runId: 'owner-restart-run', goal: 'Investigate and resolve the owner requirement.', contract }), () => `Owner wait did not arrive: ${JSON.stringify({ calls, runs: runtime.concurrentEngine.activeRuns(), roles: runtime.concurrentEngine.roleService.projection(), controller: runtime.concurrentEngine.controllers.get('owner-restart-run')?.status() })}`);
  runId = waiting.runId; assert.equal(waiting.status, 'input_required', JSON.stringify(waiting)); assert.equal(waiting.pause.kind, 'owner_decision');
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
  const status = async (auth = token) => fetch(`http://127.0.0.1:${runtime.port}/control/delivery/${runId}`, { headers: { authorization: `Bearer ${auth}` } });
  assert.equal((await status('wrong')).status, 401);
  const before = await (await status()).json(); const pending = before.ownerDecisions.find((item) => item.state === 'pending');
  assert.ok(pending); assert.equal(calls.filter((role) => role === 'explorer').length, 1); assert.equal(calls.includes('verifier'), false);
  const callsAtWait = calls.length; const preparedAtWait = prepared; const oldDb = runtime.state.db;
  await runtime.close(); assert.equal(oldDb.open, false); runtime = null;
  runtime = await startServer(options); assert.notEqual(runtime.state.db, oldDb);
  const reopened = await (await status()).json();
  assert.deepEqual(reopened.ownerDecisions.find((item) => item.state === 'pending'), pending);
  assert.deepEqual(reopened.decisionReplyPins, before.decisionReplyPins);
  const resumedWait = await runtime.orchestrator.resume({ runId }); assert.equal(resumedWait.status, 'input_required');
  assert.equal(resumedWait.pause.decision.digest, pending.digest); assert.equal(calls.length, callsAtWait); assert.equal(prepared, preparedAtWait);
  const post = async (body, auth = token) => { const response = await fetch(`http://127.0.0.1:${runtime.port}/control/delivery/${runId}/decision`,
    { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() }; };
  const postReplacement = async (body, auth = token) => { const response = await fetch(`http://127.0.0.1:${runtime.port}/control/delivery/${runId}/decision/replace`,
    { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() }; };
  const reply = { runId, projectId: reopened.projectId, sessionId: reopened.sessionId, objectiveId: reopened.objectiveId,
    messageId: 'owner-reply', decisionId: pending.request.decisionId, requestDigest: pending.digest, optionId: 'keep', ...reopened.decisionReplyPins };
  assert.equal((await post(reply, 'wrong')).status, 401);
  assert.equal((await post({ ...reply, expectedOwnerGeneration: reply.expectedOwnerGeneration + 1 })).status, 409);
  assert.equal((await post({ ...reply, requestDigest: `sha256:${'0'.repeat(64)}` })).status, 409);
  assert.equal(calls.length, callsAtWait); assert.equal(prepared, preparedAtWait);

  const objective = runtime.concurrentEngine.store.getObjective(reopened.projectId, reopened.objectiveId);
  runtime.concurrentEngine.store.ownerCorrectionAuthorized = () => true;
  runtime.concurrentEngine.store.applyOwnerCorrection(reopened.projectId, reopened.objectiveId, {
    sourceMessageId: 'authenticated-correction', expectedGoalRevision: objective.goalRevision,
    expectedAuthorityRevision: objective.authorityRevision, expectedControlRevision: objective.controlRevision,
    requirementDigest: `sha256:${'c'.repeat(64)}` });
  assert.equal((await post(reply)).status, 409);
  const replacement = { runId, projectId: reopened.projectId, sessionId: reopened.sessionId, objectiveId: reopened.objectiveId,
    messageId: 'owner-replacement', decisionId: pending.request.decisionId, oldRequestDigest: pending.digest,
    replacement: pending.request, ...runtime.concurrentEngine.store.ownerDecisionPins(reopened.projectId, reopened.objectiveId) };
  assert.equal((await postReplacement(replacement, 'wrong')).status, 401);
  assert.equal((await postReplacement({ ...replacement, expectedGoalRevision: replacement.expectedGoalRevision - 1 })).status, 409);
  assert.equal((await postReplacement({ ...replacement, replacement: { ...pending.request, evidenceRefs: ['attempt:invented'] } })).status, 400);
  const sourcePath = path.join(workspace, 'source.txt'); const originalSource = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(sourcePath, 'drifted input\n');
  assert.equal((await postReplacement(replacement)).status, 400);
  fs.writeFileSync(sourcePath, originalSource);
  const readManifest = runtime.concurrentEngine.candidateStore.readManifest.bind(runtime.concurrentEngine.candidateStore);
  runtime.concurrentEngine.candidateStore.readManifest = () => null;
  assert.equal((await postReplacement(replacement)).status, 400);
  runtime.concurrentEngine.candidateStore.readManifest = readManifest;
  const replacementResult = await postReplacement(replacement);
  assert.equal(replacementResult.status, 200, JSON.stringify(replacementResult));
  const adopted = replacementResult.body.decision;
  assert.notEqual(adopted.digest, pending.digest);
  assert.deepEqual(adopted.request.evidenceRefs, pending.request.evidenceRefs);
  const originalAttempt = runtime.concurrentEngine.store.listAttempts(reopened.projectId, reopened.objectiveId)[0];
  assert.equal(adopted.revalidations[0].originalOwnerGeneration, originalAttempt.executionGeneration);
  assert.deepEqual(adopted.revalidations[0].originalControls, originalAttempt.capturedControls);
  assert.deepEqual(runtime.concurrentEngine.store.listOwnerDecisions(reopened.projectId, reopened.objectiveId).map((item) => item.state), ['superseded', 'pending']);
  const staleReply = { ...reply, messageId: 'stale-owner-reply' };
  assert.equal((await post(staleReply)).status, 409);
  const adoptedPins = runtime.concurrentEngine.store.ownerDecisionPins(reopened.projectId, reopened.objectiveId);
  const adoptedReply = { ...reply, messageId: 'owner-reply-after-replacement', requestDigest: adopted.digest, ...adoptedPins };
  const heldPlanner = { started: deferred(), release: deferred() };
  coordinatorBarrier = heldPlanner;
  const acceptedReply = await post(adoptedReply); assert.equal(acceptedReply.status, 200, JSON.stringify(acceptedReply));
  assert.equal((await post(adoptedReply)).status, 200);
  await bounded(heldPlanner.started.promise, 'Corrected objective planner did not reserve its project slot.');
  assert.equal(runtime.concurrentEngine.store.pendingOwnerDecision(reopened.projectId, reopened.objectiveId), null);
  assert.equal(runtime.concurrentEngine.store.getLifecycleControl(reopened.projectId, reopened.objectiveId).cause, 'active');

  runId = 'owner-restart-acceptance-run';
  const acceptancePromise = runtime.orchestrator.run({ runId, goal: 'Investigate and resolve the owner requirement.', contract });
  await until(() => runtime.concurrentEngine.controllers.get(runId)?.lastPlanner?.state === 'busy',
    () => `Fresh planner did not report project-capacity busy: ${JSON.stringify({ calls, status: runtime.concurrentEngine.controlStatus(runId) })}`);
  const acceptanceObjective = runtime.orchestrator.mapping(runId).objectiveId;
  await until(() => runtime.concurrentEngine.controllers.get(runId)?.inbox.projection().wakeup === true,
    'Busy planner consumed its initial trigger unexpectedly.');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const busyObjective = runtime.concurrentEngine.store.getObjective(runtime.projectId, acceptanceObjective);
  const busyInbox = runtime.concurrentEngine.controllers.get(runId).inbox.projection();
  heldPlanner.release.resolve();
  const acceptanceRun = await bounded(acceptancePromise,
    () => `Second owner wait did not arrive: ${JSON.stringify({ calls, status: runtime.concurrentEngine.controlStatus(runId) })}`);
  assert.equal(busyObjective.planRevision, 0, JSON.stringify({ busyObjective, busyInbox }));
  assert.deepEqual(busyObjective.tasks, [], JSON.stringify({ busyObjective, busyInbox }));
  assert.equal(busyInbox.wakeup, true, JSON.stringify({ busyObjective, busyInbox }));
  const acceptanceDiagnostic = { result: acceptanceRun,
    objective: runtime.concurrentEngine.store.getObjective(runtime.projectId, acceptanceObjective),
    ownerDecisions: runtime.concurrentEngine.store.listOwnerDecisions(runtime.projectId, acceptanceObjective),
    attempts: runtime.concurrentEngine.store.listAttempts(runtime.projectId, acceptanceObjective),
    claims: runtime.concurrentEngine.store.listClaims(runtime.projectId, acceptanceObjective),
    finalizations: runtime.concurrentEngine.store.listFinalizations(runtime.projectId, acceptanceObjective),
    controller: runtime.concurrentEngine.controllers.get(runId)?.status() };
  assert.equal(acceptanceRun.status, 'input_required', JSON.stringify(acceptanceDiagnostic));
  assert.equal(acceptanceRun.pause.kind, 'owner_decision', JSON.stringify(acceptanceDiagnostic));
  let acceptanceStatus = await (await status()).json();
  const acceptancePending = acceptanceStatus.ownerDecisions.find((item) => item.state === 'pending');
  assert.ok(acceptancePending);
  const acceptanceReplyPins = acceptanceStatus.decisionReplyPins;
  const callsAtAcceptanceWait = calls.length; const preparedAtAcceptanceWait = prepared; const acceptanceDb = runtime.state.db;
  await runtime.close(); assert.equal(acceptanceDb.open, false); runtime = null;
  runtime = await startServer(options); assert.notEqual(runtime.state.db, acceptanceDb);
  acceptanceStatus = await (await status()).json();
  assert.deepEqual(acceptanceStatus.ownerDecisions.find((item) => item.state === 'pending'), acceptancePending);
  assert.deepEqual(acceptanceStatus.decisionReplyPins, acceptanceReplyPins);
  const resumedAcceptanceWait = await runtime.orchestrator.resume({ runId });
  assert.equal(resumedAcceptanceWait.status, 'input_required');
  assert.equal(resumedAcceptanceWait.pause.decision.digest, acceptancePending.digest);
  assert.equal(calls.length, callsAtAcceptanceWait); assert.equal(prepared, preparedAtAcceptanceWait);
  const acceptanceReply = { runId, projectId: acceptanceStatus.projectId, sessionId: acceptanceStatus.sessionId,
    objectiveId: acceptanceStatus.objectiveId, messageId: 'owner-acceptance-reply',
    decisionId: acceptancePending.request.decisionId, requestDigest: acceptancePending.digest, optionId: 'keep',
    ...acceptanceStatus.decisionReplyPins };
  assert.equal((await post(acceptanceReply)).status, 200);
  assert.equal((await post(acceptanceReply)).body.duplicate, true);
  const accepted = await bounded(runtime.orchestrator.resume({ runId }), 'Acceptance did not complete.');
  assert.equal(accepted.disposition, 'accepted', JSON.stringify(accepted));
  assert.equal(calls.filter((role) => role === 'explorer').length, 3); assert.equal(calls.filter((role) => role === 'verifier').length, 1);
  const stored = JSON.parse(runtime.state.db.prepare('SELECT result_json FROM concurrent_delivery_runs WHERE run_id=?').get(runId).result_json);
  assert.equal(stored.acceptance.disposition, 'accepted'); assert.equal(stored.acceptance.checkResults[0].result, 'passed');
  assert.deepEqual(stored.acceptance.requiredCheckIds, ['product']);
  const finalization = runtime.concurrentEngine.store.listFinalizations(acceptanceStatus.projectId, acceptanceStatus.objectiveId).find((item) => item.state === 'accepted');
  assert.equal(finalization.terminalRecord.pins.candidate.candidateId, stored.candidateId);
});
