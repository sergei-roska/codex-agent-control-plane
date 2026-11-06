'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { ConcurrentDeliveryEngine } = require('../src/concurrent-delivery-engine');
const { DeliveryEngineRouter } = require('../src/delivery-engine-router');
const { createSwitchingAppServer } = require('../src/app-server-switch');
const { WriterAdmission } = require('../src/writer-admission');
const { LaneManager } = require('../src/writer-lanes');
const { readProcessIdentity, isProcessGroupGone } = require('../src/process-quiescence');
const { scopedExecutionDetails } = require('../src/delivery-role-capabilities');

const projectId = '0123456789';
const codexHome = '/tmp/concurrent-engine-codex-home';

function auth(req, res, next) {
  if (req.get('authorization') !== 'Bearer concurrent-test-token') return res.status(401).json({ error: 'unauthorized' });
  return next();
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fakeTurnProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const identity = readProcessIdentity(child.pid);
  return { identity, async stop() {
    try { process.kill(-identity.pgid, 'SIGTERM'); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
    let timeoutHandle;
    const didExit = await Promise.race([exited.then(() => true), new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), 1000);
    })]);
    clearTimeout(timeoutHandle);
    assert.equal(didExit, true, `fake provider process did not exit: ${identity.pid}`);
    for (let attempt = 0; attempt < 100 && !isProcessGroupGone(identity); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(isProcessGroupGone(identity), true);
  } };
}

function engineerTask(objectiveId, taskId, writePath, detail) {
  return { schemaVersion: 'delivery/v1', projectId, objectiveId, taskId, revision: 1, role: 'engineer', kind: 'implementation',
    objective: `Implement ${taskId}: ${detail}`, priority: 1, dependencies: [], productWritePaths: [writePath],
    readScope: { kind: 'known', paths: ['source.txt'] }, scratchWriteRoots: [`.scratch/${taskId}`], resourceClaims: [],
    publicationAuthority: { state: 'unknown' }, state: 'queued' };
}

function planDelta(pins, tasks, dependencies = []) {
  return { schemaVersion: 'delivery/v1', expectedPlanRevision: pins.planRevision, expectedGoalRevision: pins.goalRevision,
    expectedAuthorityRevision: pins.authorityRevision, expectedControlRevision: pins.controlRevision,
    nextPlanRevision: pins.planRevision + 1, tasks: tasks.map((task) => ({ task })), dependencies };
}

async function waitFor(predicate, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function createHarness(t, { appServer = {}, providerIdentity, providerIdentityFor, roles, leadRole, objectiveId = 'engine-objective-1', files,
  writerMode = 'worktree' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-delivery-engine-'));
  const workspace = path.join(root, 'repo');
  const storageRoot = path.join(root, 'engine-state');
  fs.mkdirSync(workspace);
  fs.mkdirSync(storageRoot);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Concurrent Engine Test');
  git('config', 'user.email', 'concurrent-engine@example.invalid');
  const initialFiles = files || { 'source.txt': 'stable input\n', 'verify-source.js': "'use strict';\nconst fs = require('node:fs');\nif (fs.readFileSync('source.txt', 'utf8') !== 'stable input\\n') process.exit(1);\n" };
  for (const [file, contents] of Object.entries(initialFiles)) {
    const target = path.join(workspace, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = new Database(path.join(storageRoot, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace });
  const lanes = new LaneManager({ db, workspace, admission, mode: writerMode, lanesRoot: path.join(storageRoot, 'lanes'), links: [] });
  const app = express();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const verifier = { id: 'verifier', name: 'Verifier', description: 'Reviews frozen candidate input.',
    sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' };
  const configuredRoles = roles || new Map([['verifier', verifier]]);
  const lead = leadRole || { id: 'lead', name: 'Lead', model: 'test-model', effort: 'low', fastMode: 'off' };
  const appServerApi = { getVersion: () => 'fake-app-server/1', getCodexHome: () => codexHome,
    async prepareThread({ role }) { return { threadId: `${role.id}-thread`, codexHome }; }, ...appServer };
  const identity = providerIdentity || { accountId: 'fake-account', codexHome };
  const engine = new ConcurrentDeliveryEngine({ db, workspace, projectId, stateFile: path.join(storageRoot, 'state.sqlite'),
    storageRoot, baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer: appServerApi,
    providerIdentity: identity, providerIdentityFor: providerIdentityFor || (() => identity), roles: configuredRoles, leadRole: lead,
    admission, lanes, writerIsolation: { mode: writerMode, ...(writerMode === 'cooperative'
      ? { inherited: true, profile: ':danger-full-access', confinement: 'none' } : {}) }, sleepMs: 10 });
  engine.register(app);
  const fx = { root, workspace, storageRoot, db, admission, lanes, app, server, baseUrl, appServer: appServerApi,
    engine, lead, roles: configuredRoles };
  t.after(async () => {
    await engine.shutdown().catch(() => {});
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return fx;
}

test('cooperative writer mode keeps private lanes and its unconfined inherited provenance', async (t) => {
  const { engine, lanes } = await createHarness(t, { writerMode: 'cooperative', appServer: {
    async run() { throw new Error('no provider turn expected'); },
  } });
  assert.equal(lanes.mode, 'cooperative');
  assert.equal(engine.executionPermissions, 'inherit');
  assert.deepEqual(engine.runtimeProjection().writerIsolation, {
    mode: 'cooperative', reason: null, lanesRoot: lanes.lanesRoot, links: [], networkAccess: false,
    confinement: 'none', inherited: true, probe: null,
  });
});

for (const mode of ['required', 'empty', 'planner-recovery', 'default-profile', 'large-review']) test(`concurrent engine accepts its pinned base candidate with ${mode} owner checks`, { timeout: 15000 }, async (t) => {
  const emptyChecks = mode === 'empty';
  const calls = [];
  const starts = [];
  let expectedHome = codexHome;
  const appServer = {
    async run(options) {
      calls.push(options.role.id);
      assert.equal(options.expectedCodexHome, mode === 'default-profile' ? undefined : expectedHome);
      const threadId = options.threadId || `${options.role.id}-thread`;
      const turnId = `${options.role.id}-turn-${calls.length}`;
      const invalidTurn = mode === 'planner-recovery' && calls.length === 1;
      const child = invalidTurn ? await fakeTurnProcess() : null;
      const processIdentity = child?.identity || readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      starts.push({ role: options.role.id, threadId, processIdentity });
      let text;
      if (options.role.id === 'lead') {
        assert.equal(options.role.model, 'test-model');
        assert.equal(options.role.effort, 'low');
        assert.equal(options.role.fastMode, 'off');
        text = JSON.stringify({ expected: JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins,
          delta: null, dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null });
      } else {
        assert.equal(options.role.model, 'test-model');
        assert.equal(options.role.effort, 'low');
        assert.equal(options.role.fastMode, 'off');
        const details = scopedExecutionDetails(options.deliveryCapability);
        assert.equal(details.verifyCandidate(), true);
        if (mode === 'large-review') {
          for (let index = 0; index < 210; index += 1) {
            assert.equal(fs.readFileSync(path.join(details.candidatePath, `scope-${index}.txt`), 'utf8'), `input ${index}\n`);
          }
        }
        execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
        text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nSource check passed.', filesChanged: [],
          filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against the frozen candidate.' }],
          risks: [], scopeExpansion: [], decisionRequest: null });
      }
      if (child) await child.stop();
      if (invalidTurn) text = '{invalid JSON';
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true,
          processIdentity, threadId, turnId } };
    },
  };
  let composedAppServer = appServer;
  let pinnedIdentity = null;
  if (mode === 'default-profile') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-default-profile-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    expectedHome = home;
    pinnedIdentity = { accountId: 'fake-account', codexHome: home };
    composedAppServer = createSwitchingAppServer({
      profiles: { activeHome: () => null }, baseOptions: { codexHome: home },
      create: () => ({
        getVersion: () => 'fake-app-server/1', processIdentity: () => null,
        getCodexHome: () => null,
        async prepareThread({ role }) { return { threadId: `${role.id}-thread` }; },
        ...appServer,
      }),
    });
  }
  const fx = await createHarness(t, { appServer: composedAppServer,
    ...(mode === 'large-review' ? { files: {
      'source.txt': 'stable input\n',
      'verify-source.js': "'use strict';\nif (require('node:fs').readFileSync('source.txt', 'utf8') !== 'stable input\\n') process.exit(1);\n",
      ...Object.fromEntries(Array.from({ length: 210 }, (_, index) => [`scope-${index}.txt`, `input ${index}\n`])),
    } } : {}),
    ...(pinnedIdentity ? { providerIdentity: pinnedIdentity, providerIdentityFor: () => pinnedIdentity } : {}) });
  const { db, engine, lead } = fx;

  const running = engine.run({ runId: 'engine-run-1', goal: 'Confirm the current source is acceptable.',
    contract: { requiredChecks: emptyChecks ? [] : [{ id: 'source-content', argv: [process.execPath, 'verify-source.js'] }] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'engine-objective-1', sessionId: 'engine-session-1' } });
  let timeoutHandle;
  const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    objective: engine.store.getObjective(projectId, 'engine-objective-1'), calls, controller: engine.controllers.get('engine-run-1')?.status(),
    roleExecutions: engine.roleService.projection(), plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    reviewProjection: engine.reviewStore.finalizationProjection({ projectId, objectiveId: 'engine-objective-1',
      candidateId: 'candidate-base-0e009a5814b9f480a213a382', requiredRoles: ['verifier'] }),
    receipts: db.prepare('SELECT receipt_json FROM review_receipts').all(), finalizations: db.prepare('SELECT state,record_json FROM backlog_finalizations').all(),
    executorEvidence: db.prepare('SELECT attempt_id,kind,detail_json FROM task_executor_evidence').all(),
    executions: engine.roleService.projection().map((item) => engine.roleService.getExecution(item.attemptId)), }))), 8000); });
  let result;
  try { result = await Promise.race([running, timeout]); }
  finally { clearTimeout(timeoutHandle); }

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.disposition, 'accepted');
  if (mode === 'large-review') {
    const reviewTask = engine.store.getObjective(projectId, 'engine-objective-1').tasks.find((task) => task.role === 'verifier');
    assert.equal(reviewTask.readScope.paths.length, 212);
  }
  assert.equal(engine.getRunDigest('engine-run-1').candidateId, result.candidateId);
  if (mode === 'default-profile') {
    const firstPlannerFact = db.prepare('SELECT start_json,terminal_json FROM concurrent_planner_execution_facts ORDER BY rowid LIMIT 1').get();
    assert.ok(firstPlannerFact?.start_json);
    assert.ok(firstPlannerFact?.terminal_json);
  }
  assert.equal(calls[0], 'lead');
  if (mode === 'planner-recovery') {
    assert.ok(calls.filter((role) => role === 'lead').length >= 2);
    const prior = db.prepare("SELECT status,result_json FROM delivery_planner_turns WHERE status='reconciled_no_effect'").get();
    assert.ok(prior);
    assert.equal(JSON.parse(prior.result_json).processQuiescent, true);
    assert.equal(db.prepare("SELECT state FROM delivery_lifecycle_planner_recoveries").get().state, 'reconciled');
    const facts = db.prepare('SELECT start_json,terminal_json FROM concurrent_planner_execution_facts LIMIT 1').get();
    assert.deepEqual(JSON.parse(facts.start_json).processIdentity, JSON.parse(facts.terminal_json).execution.processIdentity);
    assert.equal(Object.hasOwn(JSON.parse(facts.terminal_json).execution, 'cleanupSucceeded'), false);
  }
  assert.ok(calls.indexOf('verifier') > 0);
  assert.equal(calls.filter((role) => role === 'verifier').length, 1);
  assert.ok(calls.every((role) => ['lead', 'verifier'].includes(role)));
  assert.ok(starts.some(({ role, threadId }) => role === 'lead' && threadId === 'lead-thread'));
  assert.ok(starts.some(({ role, threadId }) => role === 'verifier' && threadId === 'verifier-thread'));
  assert.ok(starts.every(({ processIdentity }) => Number.isSafeInteger(processIdentity.pid)
    && Number.isSafeInteger(processIdentity.pgid) && typeof processIdentity.startTime === 'string'));
  assert.equal(engine.getRunEngine('engine-run-1'), 'concurrent-v1');
  assert.equal(engine.getRunDigest('engine-run-1').disposition, 'accepted');
  const qualification = engine.reviewStore.finalizationProjection({ projectId, objectiveId: 'engine-objective-1',
    candidateId: result.candidateId, requiredRoles: ['verifier'] });
  assert.equal(qualification.complete, true, JSON.stringify(qualification));
  assert.equal(qualification.receipts.length, 1);
  assert.equal(qualification.receipts[0].receipt.candidateId, result.candidateId);
  assert.equal(qualification.receipts[0].receipt.role, 'verifier');
  assert.equal(qualification.receipts[0].receipt.outcome, 'passed');
  assert.equal(result.acceptance.checkResults.length, emptyChecks ? 0 : 1);
  if (!emptyChecks) assert.equal(result.acceptance.checkResults[0].result, 'passed');
  const verifierExecution = engine.roleService.getExecution(engine.roleService.projection()[0].attemptId);
  assert.equal(verifierExecution.state, 'settled');
  assert.deepEqual(verifierExecution.providerIdentity, { accountId: 'fake-account', codexHome: expectedHome });
  assert.equal(verifierExecution.provenance.model, 'test-model');
  assert.equal(verifierExecution.provenance.effort, 'low');
  assert.equal(verifierExecution.provenance.fastMode, 'off');
  assert.equal(verifierExecution.execution.turnStartSent, true);
  assert.equal(verifierExecution.execution.turnStartRejected, false);
  assert.equal(verifierExecution.execution.turnTerminal, true);
  assert.ok(verifierExecution.checkEvidence.evidenceRefs.length > 0);
  const finalCheckProof = db.prepare('SELECT result_json FROM concurrent_finalization_check_proofs').get();
  assert.ok(finalCheckProof);
  assert.equal(JSON.parse(finalCheckProof.result_json).checkResults.length, emptyChecks ? 0 : 1);
  if (mode === 'required') {
    const objectiveId = 'engine-objective-1';
    const terminalBefore = engine.store.listFinalizations(projectId, objectiveId).find((entry) => entry.state === 'accepted').terminalRecord;
    const finalizationBefore = engine.store.getFinalization(projectId, objectiveId, terminalBefore.finalizationId);
    const candidateId = terminalBefore.pins.candidate.candidateId;
    const terminalStatus = engine.controlStatus('engine-run-1');
    assert.equal(terminalStatus.phase, 'terminal');
    assert.equal(terminalStatus.finalization.state, 'accepted');
    assert.equal(terminalStatus.finalization.qualified, true);
    assert.equal(terminalStatus.finalization.fingerprint, finalizationBefore.terminalDigest);
    assert.equal(terminalStatus.disposition, 'accepted');
    await engine.shutdown();
    db.close();
    const reopened = await reopenWithProvider(t, fx, { accountId: 'fake-account', codexHome: expectedHome }, fx.appServer);
    const qualification = reopened.engine.store.currentFinalizationQualification(projectId, objectiveId,
      { candidateStore: reopened.engine.candidateStore, reviewStore: reopened.engine.reviewStore });
    assert.equal(qualification.current, true, JSON.stringify(qualification));
    assert.equal(qualification.historical.pins.candidate.candidateId, candidateId);
    assert.deepEqual(reopened.engine.store.getFinalization(projectId, objectiveId, terminalBefore.finalizationId), finalizationBefore);
    assert.deepEqual(await reopened.engine.resume({ runId: 'engine-run-1' }), result);
    assert.deepEqual(reopened.engine.controlStatus('engine-run-1').finalization, terminalStatus.finalization);
    assert.equal(reopened.engine.getRunDigest('engine-run-1').candidateId, candidateId);
    assert.deepEqual(reopened.engine.store.listFinalizations(projectId, objectiveId).find((entry) => entry.state === 'accepted').terminalRecord,
      terminalBefore);
  }
});

test('lead preparation settings mutation is rejected before any provider turn', async (t) => {
  const calls = [];
  const { engine, lead } = await createHarness(t, { appServer: {
    async prepareThread({ role }) { role.model = 'mutated-model'; return { threadId: 'lead-thread', codexHome }; },
    async run(options) { calls.push(options.role.id); throw new Error('provider turn must not start'); },
  } });
  await assert.rejects(engine.run({ runId: 'mutated-settings-run', goal: 'Verify pinned preparation settings.',
    contract: { requiredChecks: [] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'mutated-settings-objective', sessionId: 'mutated-settings-session' } }),
  { code: 'concurrent_lead_settings_changed_during_prepare' });
  assert.deepEqual(calls, []);
  assert.equal(lead.model, 'test-model');
});

test('same-home provider account replacement is rejected before the lead provider turn', async (t) => {
  let currentIdentity = { accountId: 'fake-account', codexHome };
  const calls = [];
  const { engine } = await createHarness(t, { providerIdentityFor: () => currentIdentity, appServer: {
    async prepareThread() {
      currentIdentity = { accountId: 'replacement-account', codexHome };
      return { threadId: 'lead-thread', codexHome };
    },
    async run(options) { calls.push(options.role.id); throw new Error('provider turn must not start'); },
  } });
  await assert.rejects(engine.run({ runId: 'replacement-account-run', goal: 'Verify the startup account pin.',
    contract: { requiredChecks: [] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'replacement-account-objective', sessionId: 'replacement-account-session' } }),
  { code: 'concurrent_provider_identity_changed' });
  assert.deepEqual(calls, []);
  assert.equal(currentIdentity.codexHome, codexHome);
});

test('steering replays its durable acknowledgement after revisions advance and conflicts on changed body', { timeout: 15000 }, async (t) => {
  const calls = [];
  const leadEntered = deferred();
  const releaseLead = deferred();
  let turnNumber = 0;
  const { engine } = await createHarness(t, { appServer: {
    async run(options) {
      calls.push(options.role.id);
      const turnId = `steer-turn-${++turnNumber}`;
      const threadId = options.threadId || `${options.role.id}-thread`;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      let text;
      if (options.role.id === 'lead') {
        leadEntered.resolve();
        await releaseLead.promise;
        const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
        text = JSON.stringify({ expected: prompt.pins, delta: null, dialogue: 'Continue with frozen review.', recovery: null, ownerDecision: null });
      } else {
        const details = scopedExecutionDetails(options.deliveryCapability);
        assert.equal(details.verifyCandidate(), true);
        execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
        text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nCandidate is acceptable.', filesChanged: [],
          filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against the frozen candidate.' }],
          risks: [], scopeExpansion: [], decisionRequest: null });
      }
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true,
          processIdentity, threadId, turnId } };
    },
  } });
  const running = engine.run({ runId: 'steer-replay-run', goal: 'Test durable steering replay.',
    contract: { requiredChecks: [{ id: 'source-content', argv: [process.execPath, 'verify-source.js'] }] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'steer-replay-objective', sessionId: 'steer-replay-session' } });
  await leadEntered.promise;
  const status = engine.controlStatus('steer-replay-run');
  const body = { runId: 'steer-replay-run', projectId, sessionId: 'steer-replay-session', objectiveId: 'steer-replay-objective',
    messageId: 'steer-message-1', text: 'Please continue with the current review.',
    expectedPlanRevision: status.revisions.planRevision, expectedGoalRevision: status.revisions.goalRevision,
    expectedControlRevision: status.revisions.controlRevision };
  const first = await engine.steer(body);
  assert.equal(first.state, 'received');
  assert.equal(first.acknowledged, true);
  assert.ok(engine.controlStatus('steer-replay-run').messages.some((message) => message.messageId === body.messageId && message.state === 'received'));

  releaseLead.resolve();
  let timeoutHandle;
  const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    calls, objective: engine.store.getObjective(projectId, 'steer-replay-objective'),
    controller: engine.controllers.get('steer-replay-run')?.status(), roleExecutions: engine.roleService.projection(),
    plannerTurns: engine.db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    receipts: engine.db.prepare('SELECT receipt_json FROM review_receipts').all(),
    finalizations: engine.db.prepare('SELECT state,record_json FROM backlog_finalizations').all(),
  }))), 8000); });
  let result;
  try { result = await Promise.race([running, timeout]); }
  finally { clearTimeout(timeoutHandle); }
  assert.equal(result.disposition, 'accepted');
  const current = engine.controlStatus('steer-replay-run');
  assert.ok(current.revisions.planRevision > body.expectedPlanRevision);
  const persisted = current.messages.find((message) => message.messageId === body.messageId);
  assert.ok(persisted);
  assert.ok(['applied', 'blocked'].includes(persisted.state));
  const callCount = calls.length;
  const duplicate = await engine.steer(body);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state, persisted.state);
  assert.equal(calls.length, callCount);
  await assert.rejects(engine.steer({ ...body, text: 'Changed body under the same identifier.' }), { code: 'message_id_conflict' });
  assert.equal(calls.length, callCount);
});

test('steering revision changes during controller setup roll back the appended message', async (t) => {
  const leadEntered = deferred();
  const releaseLead = deferred();
  let turnNumber = 0;
  const { engine } = await createHarness(t, { appServer: {
    async run(options) {
      const turnId = `steer-race-turn-${++turnNumber}`;
      const threadId = options.threadId || `${options.role.id}-thread`;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      leadEntered.resolve();
      await releaseLead.promise;
      const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      const text = JSON.stringify({ expected: prompt.pins, delta: null, dialogue: 'Stop after the control changed.', recovery: null, ownerDecision: null });
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true,
          processIdentity, threadId, turnId } };
    },
  } });
  const running = engine.run({ runId: 'steer-race-run', goal: 'Test atomic stale control admission.',
    contract: { requiredChecks: [] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'steer-race-objective', sessionId: 'steer-race-session' } });
  await leadEntered.promise;
  const oldController = engine.controllers.get('steer-race-run');
  engine.controllers.delete('steer-race-run');
  const status = engine.controlStatus('steer-race-run');
  const body = { runId: 'steer-race-run', projectId, sessionId: 'steer-race-session', objectiveId: 'steer-race-objective',
    messageId: 'steer-race-message', text: 'Do not accept stale control pins.',
    expectedPlanRevision: status.revisions.planRevision, expectedGoalRevision: status.revisions.goalRevision,
    expectedControlRevision: status.revisions.controlRevision };
  const steering = engine.steer(body);
  engine.store.requestControl(projectId, 'steer-race-objective', 'pause', status.revisions.controlRevision);
  await assert.rejects(steering, { code: 'steer_revision_stale' });
  const replacementController = engine.controllers.get('steer-race-run');
  assert.ok(replacementController);
  assert.equal(replacementController.inbox.get(body.messageId), null);

  const paused = engine.store.getObjective(projectId, 'steer-race-objective');
  engine.store.requestControl(projectId, 'steer-race-objective', 'cancel', paused.controlRevision);
  engine.controllers.set('steer-race-run', oldController);
  releaseLead.resolve();
  const result = await running;
  assert.equal(result.status, 'canceled');
  assert.equal(engine.store.getObjective(projectId, 'steer-race-objective').disposition, 'canceled');
  assert.equal(oldController.inbox.get(body.messageId), null);
});

test('overlapping private engineer lanes unlock dependent work and review the changed candidate', { timeout: 25000 }, async (t) => {
  const objectiveId = 'engineering-overlap-objective';
  const calls = [];
  const laneStarts = [];
  const fastStarted = deferred();
  const slowStarted = deferred();
  const dependentStarted = deferred();
  const secondPlannerEntered = deferred();
  const slowRelease = deferred();
  let slowReleased = false;
  let releaseTimer;
  const slowProgress = [];
  slowRelease.promise.then(() => slowProgress.push('release_signal_resolved'));
  const releaseSlow = () => {
    if (slowReleased) return;
    slowReleased = true;
    slowProgress.push('release_called');
    clearTimeout(releaseTimer);
    slowRelease.resolve();
  };
  let engine;
  let plannerCalls = 0;
  let turnNumber = 0;
  let secondPlannerState = null;
  const verifySource = "'use strict';\nconst fs = require('node:fs');\nif (fs.readFileSync('source.txt', 'utf8') !== 'stable input\\n') process.exit(1);\nif (fs.readFileSync('fast.txt', 'utf8') !== 'fast sibling\\n') process.exit(1);\nif (fs.readFileSync('final.txt', 'utf8') !== 'dependent output\\n') process.exit(1);\nif (fs.existsSync('slow.txt')) process.exit(1);\n";
  const engineer = { id: 'engineer', name: 'Engineer', description: 'Implements isolated source changes.',
    sandbox: 'workspace-write', model: 'test-model', effort: 'low', fastMode: 'off' };
  const verifier = { id: 'verifier', name: 'Verifier', description: 'Checks the final frozen candidate.',
    sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' };
  const fastTask = engineerTask(objectiveId, 'fast-sibling', 'fast.txt', 'publish the fast sibling result');
  const slowTask = engineerTask(objectiveId, 'slow-sibling', 'slow.txt', 'hold a live sibling lane without changing files');
  const dependentTask = engineerTask(objectiveId, 'dependent-work', 'final.txt', 'write after the fast sibling publishes');
  const appServer = {
    async run(options) {
      calls.push(options.role.id);
      const turnId = `engineering-turn-${++turnNumber}`;
      const threadId = options.threadId || `${options.role.id}-thread-${turnNumber}`;
      const processProof = await fakeTurnProcess();
      const processIdentity = processProof.identity;
      let slowTurn = false;
      let text;
      try {
        options.onTurnStart({ threadId, processIdentity });
        if (options.role.id === 'lead') {
          plannerCalls += 1;
          const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
          if (plannerCalls === 1) {
            text = JSON.stringify({ expected: prompt.pins, delta: planDelta(prompt.pins, [fastTask, slowTask]),
              dialogue: 'Run independent engineering tasks.', recovery: null, ownerDecision: null });
          } else if (plannerCalls === 2) {
            const objective = engine.store.getObjective(projectId, objectiveId);
            const fast = objective.tasks.find((task) => task.taskId === 'fast-sibling');
            const slow = objective.tasks.find((task) => task.taskId === 'slow-sibling');
            const slowClaim = engine.store.listClaims(projectId, objectiveId).find((claim) => claim.taskId === 'slow-sibling');
            secondPlannerState = { fastState: fast?.state, slowState: slow?.state, slowClaimState: slowClaim?.state,
              slowReleased, planRevision: prompt.pins.planRevision };
            secondPlannerEntered.resolve(secondPlannerState);
            const dependency = { schemaVersion: 'delivery/v1', projectId, objectiveId, predecessorType: 'task', predecessorId: 'fast-sibling',
              successorTaskId: 'dependent-work', kind: 'requires_output' };
            text = JSON.stringify({ expected: prompt.pins, delta: planDelta(prompt.pins, [dependentTask], [dependency]),
              dialogue: 'Unlock dependent work from the trusted fast sibling output.', recovery: null, ownerDecision: null });
          } else {
            text = JSON.stringify({ expected: prompt.pins, delta: null, dialogue: 'Review the current candidate.',
              recovery: null, ownerDecision: null });
          }
        } else if (options.role.id === 'engineer') {
          const request = JSON.parse(options.input);
          const cwd = fs.realpathSync(options.cwd);
          const workspace = fs.realpathSync(engine.workspace);
          assert.notEqual(cwd, workspace);
          laneStarts.push({ objective: request.objective, cwd });
          if (request.objective.includes('fast-sibling')) {
            fastStarted.resolve({ cwd });
            await slowStarted.promise;
            fs.writeFileSync(path.join(cwd, 'fast.txt'), 'fast sibling\n');
            text = JSON.stringify({ outcome: 'completed', summary: 'Published the fast sibling result.', filesChanged: ['fast.txt'],
              filesInspected: ['source.txt'], checks: [{ command: 'inspect source.txt', result: 'passed', detail: 'Checked the frozen input.' }],
              risks: [], scopeExpansion: [], decisionRequest: null });
          } else if (request.objective.includes('slow-sibling')) {
            slowTurn = true;
            slowStarted.resolve({ cwd });
            slowProgress.push('waiting_at_barrier');
            await slowRelease.promise;
            slowProgress.push('released');
            text = JSON.stringify({ outcome: 'completed', summary: 'The slow sibling made no source changes.', filesChanged: [],
              filesInspected: ['source.txt'], checks: [{ command: 'inspect source.txt', result: 'passed', detail: 'Checked the frozen input.' }],
              risks: [], scopeExpansion: [], decisionRequest: null });
            slowProgress.push('result_ready');
          } else if (request.objective.includes('dependent-work')) {
            dependentStarted.resolve({ cwd, slowReleased, fastFile: fs.readFileSync(path.join(cwd, 'fast.txt'), 'utf8') });
            fs.writeFileSync(path.join(cwd, 'final.txt'), 'dependent output\n');
            text = JSON.stringify({ outcome: 'completed', summary: 'Wrote the dependent result after fast sibling output.', filesChanged: ['final.txt'],
              filesInspected: ['fast.txt'], checks: [{ command: 'inspect fast.txt', result: 'passed', detail: 'Confirmed predecessor output.' }],
              risks: [], scopeExpansion: [], decisionRequest: null });
          } else throw new Error(`Unexpected engineer task: ${request.objective}`);
        } else if (options.role.id === 'verifier') {
          const details = scopedExecutionDetails(options.deliveryCapability);
          assert.equal(details.verifyCandidate(), true);
          execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
          text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nThe published candidate passed its required check.',
            filesChanged: [], filesInspected: ['fast.txt', 'final.txt'],
            checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against the frozen changed candidate.' }],
            risks: [], scopeExpansion: [], decisionRequest: null });
        } else throw new Error(`Unexpected provider role: ${options.role.id}`);
      } finally {
        await processProof.stop();
      }
      if (slowTurn) slowProgress.push('provider_returned');
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true,
          processIdentity, threadId, turnId } };
    },
  };
  t.after(() => releaseSlow());
  releaseTimer = setTimeout(releaseSlow, 12000);
  const { engine: configuredEngine, db } = await createHarness(t, { objectiveId,
    files: { 'source.txt': 'stable input\n', 'verify-source.js': verifySource },
    roles: new Map([['engineer', engineer], ['verifier', verifier]]), appServer });
  engine = configuredEngine;
  let finalizationAuthorization = null;
  const authorizeFinalization = engine.store.finalizationAuthorized;
  engine.store.finalizationAuthorized = (facts) => {
    finalizationAuthorization = facts;
    return authorizeFinalization(facts);
  };
  t.after(async () => {
    releaseSlow();
    await running?.catch(() => {});
  });
  t.diagnostic('engineering harness ready');

  const running = engine.run({ runId: 'engineering-overlap-run', goal: 'Implement independent changes with a fast dependency.',
    contract: { requiredChecks: [{ id: 'final-worktree', argv: [process.execPath, 'verify-source.js'] }] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId, sessionId: 'engineering-overlap-session' } });
  t.diagnostic('engine run promise returned');

  let laneStartTimeoutHandle;
  const laneStartTimeout = new Promise((_, reject) => { laneStartTimeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    stage: 'lane-start', calls, objective: engine.store.getObjective(projectId, objectiveId),
    plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    roleExecutions: engine.roleService.projection(), controller: engine.controllers.get('engineering-overlap-run')?.status(),
  }))), 7000); });
  let startedLanes;
  try { startedLanes = await Promise.race([Promise.all([fastStarted.promise, slowStarted.promise]), laneStartTimeout]); }
  finally { clearTimeout(laneStartTimeoutHandle); }
  const [fastLane, slowLane] = startedLanes;
  t.diagnostic('both private lane turns started');
  assert.notEqual(fastLane.cwd, slowLane.cwd);
  let plannerTimeoutHandle;
  const plannerTimeout = new Promise((_, reject) => { plannerTimeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    stage: 'second-planner', calls, objective: engine.store.getObjective(projectId, objectiveId),
    plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    executorAttempts: db.prepare('SELECT attempt_id,state,external_task_id,record_json FROM task_executor_attempts').all(),
    executorEvidence: db.prepare('SELECT attempt_id,kind,detail_json FROM task_executor_evidence').all(),
    roleExecutions: engine.roleService.projection().map((row) => engine.roleService.getExecution(row.attemptId)),
    controller: engine.controllers.get('engineering-overlap-run')?.status(),
  }))), 7000); });
  let plannerState;
  try { plannerState = await Promise.race([secondPlannerEntered.promise, plannerTimeout]); }
  finally { clearTimeout(plannerTimeoutHandle); }
  t.diagnostic('second lead turn inspected live sibling state');
  assert.deepEqual({ fastState: plannerState.fastState, slowState: plannerState.slowState,
    slowClaimState: plannerState.slowClaimState, slowReleased: plannerState.slowReleased },
  { fastState: 'succeeded', slowState: 'running', slowClaimState: 'active', slowReleased: false });
  let dependentTimeoutHandle;
  const dependentTimeout = new Promise((_, reject) => { dependentTimeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    stage: 'dependent-start', calls, objective: engine.store.getObjective(projectId, objectiveId),
    plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    roleExecutions: engine.roleService.projection().map((row) => engine.roleService.getExecution(row.attemptId)),
  }))), 7000); });
  let dependent;
  try { dependent = await Promise.race([dependentStarted.promise, dependentTimeout]); }
  finally { clearTimeout(dependentTimeoutHandle); }
  t.diagnostic('dependent provider turn started');
  assert.equal(dependent.slowReleased, false);
  assert.equal(dependent.fastFile, 'fast sibling\n');
  const atDependentStart = db.prepare(`SELECT candidate_id,integration_generation,manifest_digest FROM concurrent_candidates
    WHERE project_id=? AND objective_id=? AND status='known' ORDER BY integration_generation DESC LIMIT 1`).get(projectId, objectiveId);
  assert.equal(atDependentStart.integration_generation, 2);
  assert.notEqual(dependent.cwd, fastLane.cwd);

  await waitFor(() => {
    const latest = db.prepare(`SELECT integration_generation FROM concurrent_candidates WHERE project_id=? AND objective_id=?
      AND status='known' ORDER BY integration_generation DESC LIMIT 1`).get(projectId, objectiveId);
    return latest?.integration_generation === 3
      && engine.store.getObjective(projectId, objectiveId).tasks.find((task) => task.taskId === 'dependent-work')?.state === 'succeeded';
  }, 'dependent work did not publish candidate generation 3');
  const dependentExecution = engine.roleService.getExecution(engine.store.listAttempts(projectId, objectiveId)
    .find((attempt) => attempt.taskId === 'dependent-work').attemptId);
  assert.equal(dependentExecution.baseCandidateId, atDependentStart.candidate_id);
  assert.equal(dependentExecution.result.output.state, 'published');
  releaseSlow();
  assert.equal(slowReleased, true);
  await waitFor(() => slowProgress.includes('released'), `slow barrier did not resolve: ${JSON.stringify(slowProgress)}`, 500);
  const slowAttemptId = engine.store.listAttempts(projectId, objectiveId).find((attempt) => attempt.taskId === 'slow-sibling').attemptId;
  await waitFor(() => slowProgress.includes('provider_returned'), `slow provider did not return: ${JSON.stringify(slowProgress)}`, 2000);
  await waitFor(() => engine.roleService.getExecution(slowAttemptId)?.state === 'terminal', 'slow role did not publish terminal task state', 2000);
  await waitFor(() => engine.store.getObjective(projectId, objectiveId).tasks
    .find((task) => task.taskId === 'slow-sibling')?.state === 'succeeded', JSON.stringify({
      message: 'slow sibling did not settle', slowReleased, slowProgress,
      attempt: engine.store.listAttempts(projectId, objectiveId).find((row) => row.attemptId === slowAttemptId),
      executorAttempt: (() => { const row = db.prepare('SELECT attempt_id,state,external_task_id FROM task_executor_attempts WHERE attempt_id=?').get(slowAttemptId); return row; })(),
      evidence: db.prepare('SELECT kind,detail_json FROM task_executor_evidence WHERE attempt_id=?').all(slowAttemptId),
      execution: (() => { const row = engine.roleService.getExecution(slowAttemptId); return row && { state: row.state, externalState: row.externalState,
        terminalStatus: row.terminalStatus, failureCode: row.failureCode, result: row.result, reportError: row.reportError, effectsSettled: row.effectsSettled }; })(),
      task: engine.store.getObjective(projectId, objectiveId).tasks.find((task) => task.taskId === 'slow-sibling')?.state,
      idle: engine.controllers.get('engineering-overlap-run')?.status().scheduler,
    }));

  let timeoutHandle;
  const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    calls, objective: engine.store.getObjective(projectId, objectiveId), candidates: db.prepare(`SELECT candidate_id,integration_generation,manifest_digest
      FROM concurrent_candidates WHERE project_id=? AND objective_id=? ORDER BY integration_generation`).all(projectId, objectiveId),
    plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    roleExecutions: engine.roleService.projection().map((row) => engine.roleService.getExecution(row.attemptId)),
    receipts: db.prepare('SELECT receipt_json FROM review_receipts').all(), finalizations: db.prepare('SELECT state,record_json FROM backlog_finalizations').all(),
  }))), 8000); });
  let result;
  try { result = await Promise.race([running, timeout]); }
  catch (cause) {
    t.diagnostic(JSON.stringify({ cause: cause.code || cause.message, authorization: finalizationAuthorization,
      objective: engine.store.getObjective(projectId, objectiveId), latestCandidate: db.prepare(`SELECT candidate_id,integration_generation,manifest_digest,environment_digest,check_identity
        FROM concurrent_candidates WHERE project_id=? AND objective_id=? AND status='known' ORDER BY integration_generation DESC LIMIT 1`).get(projectId, objectiveId),
      checkpoint: engine.reviewStore.checkpointHistory({ projectId, objectiveId }),
      review: engine.reviewStore.finalizationProjection({ projectId, objectiveId,
        candidateId: engine.candidateStore.getIntent(`publication-${engine.store.listAttempts(projectId, objectiveId).find((attempt) => attempt.taskId === 'dependent-work').attemptId}`)?.candidateId,
        requiredRoles: ['verifier'] }), fence: db.prepare('SELECT status,owner_generation,control_revision,projection_json FROM concurrent_controller_fences WHERE project_id=? AND objective_id=?').get(projectId, objectiveId),
      finalizations: db.prepare('SELECT state,record_json FROM backlog_finalizations').all() }));
    throw cause;
  }
  finally { clearTimeout(timeoutHandle); releaseSlow(); }
  assert.equal(result.disposition, 'accepted', JSON.stringify(result));
  const finalCandidate = engine.candidateStore.get(result.candidateId);
  assert.equal(finalCandidate.integrationGeneration, 3);
  const finalManifest = engine.candidateStore.readManifest(finalCandidate.manifestDigest);
  assert.ok(finalManifest.entries.some((entry) => entry.path === 'fast.txt'));
  assert.ok(finalManifest.entries.some((entry) => entry.path === 'final.txt'));
  assert.equal(finalManifest.entries.some((entry) => entry.path === 'slow.txt'), false);
  assert.equal(laneStarts.length, 3);
  assert.equal(laneStarts.filter((entry) => /fast-sibling|slow-sibling|dependent-work/.test(entry.objective)).length, 3);
  assert.ok(new Set(laneStarts.filter((entry) => /fast-sibling|slow-sibling/.test(entry.objective)).map((entry) => entry.cwd)).size === 2);

  const objective = engine.store.getObjective(projectId, objectiveId);
  const verifierTask = objective.tasks.find((task) => task.role === 'verifier');
  assert.equal(verifierTask.baseCandidateId, finalCandidate.candidateId);
  const qualification = engine.reviewStore.finalizationProjection({ projectId, objectiveId,
    candidateId: finalCandidate.candidateId, requiredRoles: ['verifier'] });
  assert.equal(qualification.complete, true, JSON.stringify(qualification));
  assert.deepEqual(qualification.candidatePins, { candidateId: finalCandidate.candidateId,
    integrationGeneration: finalCandidate.integrationGeneration, manifestDigest: finalCandidate.manifestDigest,
    environmentDigest: finalCandidate.environmentDigest, checkIdentity: finalCandidate.checkIdentity });
  assert.equal(qualification.receipts.length, 1);
  assert.equal(qualification.receipts[0].receipt.candidateId, finalCandidate.candidateId);
  assert.equal(qualification.receipts[0].receipt.inputManifestDigest, finalCandidate.manifestDigest);
  assert.deepEqual(qualification.receipts[0].receipt.checkPins, ['final-worktree']);
  const checkpoint = engine.reviewStore.checkpointHistory({ projectId, objectiveId })
    .find((entry) => entry.checkpoint.checkpointId === qualification.receipts[0].receipt.checkpointId)?.checkpoint;
  assert.ok(checkpoint);
  assert.equal(checkpoint.kind, 'owner_request');
  assert.equal(checkpoint.goalRevision, objective.goalRevision);
  assert.equal(checkpoint.requirementDigest, objective.requirementDigest);
  assert.equal(checkpoint.checksDigest, objective.checksDigest);
  assert.equal(checkpoint.checkIdentity, finalCandidate.checkIdentity);
  assert.equal(checkpoint.environmentDigest, finalCandidate.environmentDigest);
  assert.deepEqual(checkpoint.checkPins, ['final-worktree']);
  const verifierExecution = engine.roleService.projection().map((row) => engine.roleService.getExecution(row.attemptId))
    .find((execution) => execution.roleId === 'verifier');
  assert.ok(verifierExecution);
  assert.equal(verifierExecution.baseCandidateId, finalCandidate.candidateId);
  assert.equal(verifierExecution.checkEvidence.candidateId, finalCandidate.candidateId);
  assert.ok(verifierExecution.checkEvidence.evidenceRefs.some((ref) => ref.startsWith('verifier-check-proof:')));
  assert.equal(result.acceptance.checkResults.find((check) => check.id === 'final-worktree')?.result, 'passed');
  const durableFinalization = engine.store.listFinalizations(projectId, objectiveId)
    .find((entry) => entry.state === 'accepted')?.terminalRecord;
  assert.ok(durableFinalization);
  const finalization = durableFinalization;
  assert.equal(finalization.disposition, 'accepted');
  assert.equal(finalization.projectId, projectId);
  assert.equal(finalization.objectiveId, objectiveId);
  assert.equal(finalization.pins.ownerGeneration, objective.ownerGeneration);
  assert.equal(finalization.pins.controlRevision, objective.controlRevision);
  assert.equal(finalization.pins.goalRevision, objective.goalRevision);
  assert.equal(finalization.pins.planRevision, objective.planRevision);
  assert.equal(finalization.pins.authorityRevision, objective.authorityRevision);
  assert.equal(finalization.pins.requirementDigest, objective.requirementDigest);
  assert.equal(finalization.pins.checksDigest, objective.checksDigest);
  assert.deepEqual(finalization.pins.candidate, { candidateId: finalCandidate.candidateId,
    integrationGeneration: finalCandidate.integrationGeneration, manifestDigest: finalCandidate.manifestDigest,
    sourceHead: finalManifest.head ?? null, environmentDigest: finalCandidate.environmentDigest,
    checkIdentity: finalCandidate.checkIdentity });
  const finalCheckProof = db.prepare('SELECT pins_json,result_json FROM concurrent_finalization_check_proofs').get();
  assert.ok(finalCheckProof);
  assert.equal(JSON.parse(finalCheckProof.pins_json).candidate.candidateId, finalCandidate.candidateId);
  assert.equal(JSON.parse(finalCheckProof.result_json).checkResults.find((check) => check.id === 'final-worktree')?.result, 'passed');
});

for (const failure of ['live-process', 'missing-terminal', 'wrong-thread', 'provider-error']) {
  test(`planner recovery holds uncertain host facts: ${failure}`, async (t) => {
    let calls = 0;
    const { engine, db } = await createHarness(t, { appServer: { async run(options) {
      calls += 1;
      const threadId = options.threadId;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      if (failure === 'provider-error') throw new Error('completed and quiescent');
      const turnId = 'uncertain-turn';
      return { threadId, turnId, status: 'completed', text: '{invalid',
        execution: { threadId: failure === 'wrong-thread' ? 'other-thread' : threadId, turnId, processIdentity,
          turnStartSent: true, turnStartRejected: false, turnTerminal: failure !== 'missing-terminal', cleanupSucceeded: true } };
    } } });
    const abort = new AbortController();
    const pending = engine.run({ runId: 'uncertain-run', goal: 'Hold unknown effects.', contract: { requiredChecks: [] },
      signal: abort.signal, engineMapping: { engine: 'concurrent-v1', projectId,
        objectiveId: 'engine-objective-1', sessionId: 'uncertain-session' } });
    await waitFor(() => engine.controllers.get('uncertain-run')?.status().lastRecovery, 'missing held recovery');
    assert.equal(engine.controllers.get('uncertain-run').status().lastRecovery.state, 'held');
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM delivery_lifecycle_planner_recoveries').get().count, 0);
    await assert.rejects(engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
    assert.equal(db.prepare('SELECT status FROM delivery_planner_turns').get().status, 'unknown');
    abort.abort();
    assert.equal((await pending).status, 'input_required');
    assert.equal(engine.store.getObjective(projectId, 'engine-objective-1').disposition, 'draining');
  });
}

test('database reopen cannot release a canceled run with an unknown durable planner turn', async (t) => {
  let calls = 0;
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    options.onTurnStart({ threadId: options.threadId, processIdentity: readProcessIdentity(process.pid) });
    throw new Error('provider outcome unknown');
  } } });
  const abort = new AbortController();
  const pending = fx.engine.run({ runId: 'reopen-run', goal: 'Retain durable unknown effects.', contract: { requiredChecks: [] },
    signal: abort.signal, engineMapping: { engine: 'concurrent-v1', projectId,
      objectiveId: 'engine-objective-1', sessionId: 'reopen-session' } });
  await waitFor(() => fx.engine.controllers.get('reopen-run')?.status().lastRecovery, 'missing unknown planner recovery');
  await assert.rejects(fx.engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
  abort.abort();
  assert.equal((await pending).status, 'input_required');
  assert.equal(fx.engine.store.getObjective(projectId, 'engine-objective-1').disposition, 'draining');
  fx.db.close();
  const db = new Database(path.join(fx.storageRoot, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace: fx.workspace });
  const lanes = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree',
    lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
  const identity = { accountId: 'fake-account', codexHome };
  const reopened = new ConcurrentDeliveryEngine({ db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
    baseUrl: fx.baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer: fx.appServer,
    providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead, admission, lanes,
    writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
  try {
    assert.deepEqual(await reopened.recoverStoredRuns(), [{ runId: 'reopen-run', state: 'checked' }]);
    assert.equal(calls, 1);
    await assert.rejects(reopened.shutdown(), (cause) => {
      assert.equal(cause.code, 'concurrent_shutdown_unsafe');
      assert.equal(cause.projections[0].disposition, 'draining');
      assert.ok(cause.projections[0].reasons.includes('live_or_unknown_planner_turn'));
      assert.equal(cause.projections[0].plannerTurns[0].status, 'unknown');
      return true;
    });
    assert.equal(db.prepare('SELECT status FROM delivery_planner_turns').get().status, 'unknown');
  } finally { db.close(); }
});

for (const attestation of ['missing', 'false']) {
  test(`shutdown refuses a persisted terminal role record with ${attestation} settlement attestation`, async (t) => {
    const fx = await createHarness(t, { appServer: { async prepareThread({ role }) {
      return { threadId: `${role.id}-thread`, codexHome };
    }, async run() { throw new Error('not invoked'); } } });
    const abort = new AbortController();
    abort.abort();
    await fx.engine.run({ runId: 'settlement-run', goal: 'Require explicit effect settlement.', contract: { requiredChecks: [] },
      signal: abort.signal, engineMapping: { engine: 'concurrent-v1', projectId,
        objectiveId: 'engine-objective-1', sessionId: 'settlement-session' } });
    for (const controller of fx.engine.controllers.values()) controller.shutdown({ pause: false });
    fx.engine.controllers.clear();
    const record = { state: 'terminal', ...(attestation === 'false' ? { effectsSettled: false } : {}) };
    fx.db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,
      provider_context_id,external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at)
      VALUES('missing-proof',?,?,'test-task',1,'ctx','external','verifier','request','settings','terminal',?,'now','now')`)
      .run(projectId, 'engine-objective-1', JSON.stringify(record));
    await assert.rejects(fx.engine.shutdown(), (cause) => {
      assert.equal(cause.code, 'concurrent_shutdown_unsafe');
      assert.ok(cause.projections[0].reasons.includes('publication_effect_settlement_unproven'));
      return true;
    });
  });
}

for (const mode of ['owned', 'cooperative', 'unknown', 'publication', 'pending-inbox', 'reopen']) {
  test(`shutdown no-publication recovery integrates ${mode} lost acknowledgement`, { timeout: 30000 }, async (t) => {
    const objectiveId = `shutdown-${mode}-objective`;
    const runId = `shutdown-${mode}-run`;
    const workerEntered = deferred();
    const releaseWorker = deferred();
    t.after(() => releaseWorker.resolve());
    const abort = new AbortController();
    let calls = 0;
    let plannerCalls = 0;
    const roles = new Map([
      ['engineer', { id: 'engineer', name: 'Engineer', description: 'Writes in its assigned lane.', sandbox: 'workspace-write',
        model: 'test-model', effort: 'low', fastMode: 'off' }],
      ['verifier', { id: 'verifier', name: 'Verifier', description: 'Reviews candidates.', sandbox: 'read-only',
        model: 'test-model', effort: 'low', fastMode: 'off' }],
    ]);
    const fx = await createHarness(t, { roles, writerMode: mode === 'cooperative' ? 'cooperative' : 'worktree', appServer: {
      async run(options) {
        calls += 1;
        const roleId = options.role.id;
        const threadId = options.threadId || `${roleId}-shutdown-thread`;
        const turnId = `${roleId}-shutdown-turn-${calls}`;
        const processIdentity = readProcessIdentity(process.pid);
        options.onTurnStart({ threadId, processIdentity });
        let text;
        if (roleId === 'lead') {
          plannerCalls += 1;
          const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
          text = JSON.stringify({ expected: prompt.pins,
            delta: plannerCalls === 1 ? planDelta(prompt.pins, [engineerTask(objectiveId, 'held-worker', 'held.txt', 'retain private evidence')]) : null,
            dialogue: 'Run the worker.', recovery: null, ownerDecision: null });
        } else {
          assert.equal(roleId, 'engineer');
          fs.writeFileSync(path.join(options.cwd, 'held.txt'), 'retained private evidence\n');
          workerEntered.resolve();
          await releaseWorker.promise;
          if (mode === 'unknown') throw new Error('provider terminal outcome unknown');
          text = JSON.stringify({ outcome: 'completed', summary: 'Private work completed.', filesChanged: ['held.txt'],
            filesInspected: ['source.txt'], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
        }
        return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
          execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity, threadId, turnId } };
      },
    } });
    const running = fx.engine.run({ runId, goal: 'Preserve private work through a lost acknowledgement.', contract: { requiredChecks: [] },
      signal: abort.signal, engineMapping: { engine: 'concurrent-v1', projectId, objectiveId, sessionId: `shutdown-${mode}-session` } });
    await workerEntered.promise;
    const attempt = fx.engine.store.listAttempts(projectId, objectiveId).find((row) => row.taskId === 'held-worker');
    assert.ok(attempt);
    abort.abort();
    assert.equal((await running).status, 'input_required');
    assert.equal(fx.engine.store.getObjective(projectId, objectiveId).disposition, 'draining');
    assert.equal(fx.engine.executor.getAttempt(attempt.attemptId).externalTaskId, null);
    await assert.rejects(fx.engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
    assert.equal(fx.engine.roleService.getExecution(attempt.attemptId).state, 'running');
    releaseWorker.resolve();
    await waitFor(() => !fx.engine.roleService.active.size, 'role call did not drain');
    const record = fx.engine.roleService.getExecution(attempt.attemptId);
    const lane = fx.lanes.store.get(record.laneId);
    assert.equal(fs.existsSync(path.join(fx.workspace, 'held.txt')), false);
    if (mode === 'publication') {
      fx.db.prepare(`INSERT INTO delivery_output_publications
        (intent_id,artifact_id,request_json,state,created_at,updated_at) VALUES(?,?,'{}','unknown','now','now')`)
        .run('unknown-shutdown-publication', record.artifactId);
    }
    if (mode === 'pending-inbox') {
      fx.engine.controllers.get(runId).inbox.receive({ messageId: 'shutdown-pending-message', kind: 'steering',
        source: 'authenticated-control', payload: { text: 'Retain this pending owner message.' } });
    }
    const beforeCalls = calls;
    let engine = fx.engine;
    let reopenedDb;
    if (mode === 'reopen') {
      fx.db.close();
      reopenedDb = new Database(path.join(fx.storageRoot, 'state.sqlite'));
      const admission = new WriterAdmission({ db: reopenedDb, workspace: fx.workspace });
      const lanes = new LaneManager({ db: reopenedDb, workspace: fx.workspace, admission, mode: 'worktree',
        lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
      const identity = { accountId: 'fake-account', codexHome };
      engine = new ConcurrentDeliveryEngine({ db: reopenedDb, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
        baseUrl: fx.baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer: fx.appServer,
        providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead, admission, lanes,
        writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
      assert.deepEqual(await engine.recoverStoredRuns(), [{ runId, state: 'checked' }]);
    }
    try {
      if (['owned', 'reopen'].includes(mode)) {
        const closed = await engine.shutdown();
        assert.equal(closed.safeToRelease, true);
        assert.deepEqual(await engine.shutdown(), closed);
        assert.equal(engine.store.listClaims(projectId, objectiveId)[0].state, 'released');
        assert.equal(engine.store.listAttempts(projectId, objectiveId)[0].state, 'canceled');
        assert.equal(engine.executor.getAttempt(attempt.attemptId).state, 'settled');
        assert.equal(engine.roleService.getExecution(attempt.attemptId).result.failureCode, 'recovery_no_publication');
        assert.equal(engine.lanes.store.get(record.laneId).state, 'not_integrated');
        assert.equal(fs.readFileSync(path.join(lane.path, 'held.txt'), 'utf8'), 'retained private evidence\n');
      } else if (mode === 'pending-inbox') {
        await assert.rejects(engine.shutdown(), (cause) => {
          assert.equal(cause.code, 'concurrent_shutdown_unsafe');
          assert.equal(cause.projections[0].inboxPending, 1);
          return true;
        });
        assert.equal(engine.store.listClaims(projectId, objectiveId)[0].state, 'released');
        assert.equal(engine.controllers.get(runId).inbox.pending().length, 1);
      } else {
        let drainWaits = 0;
        const originalTimeout = global.setTimeout;
        const timer = mode === 'unknown' ? t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
          if (delay === 20) {
            drainWaits += 1;
            throw new Error('Durable unknown effects cannot drain through an in-process wait.');
          }
          return originalTimeout(callback, delay, ...args);
        }) : null;
        try {
          assert.equal(engine.roleService.active.size, 0);
          await assert.rejects(engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
        } finally { timer?.mock.restore(); }
        assert.equal(drainWaits, 0);
        assert.notEqual(engine.store.listClaims(projectId, objectiveId)[0].state, 'released');
        assert.notEqual(engine.executor.getAttempt(attempt.attemptId).state, 'settled');
        assert.equal(engine.roleService.getExecution(attempt.attemptId).noPublicationRecovery, undefined);
      }
      assert.equal(calls, beforeCalls);
      assert.equal(fs.existsSync(path.join(fx.workspace, 'held.txt')), false);
      assert.equal(engine.db.prepare('SELECT count(*) AS count FROM delivery_output_publications').get().count, mode === 'publication' ? 1 : 0);
    } finally { reopenedDb?.close(); }
  });
}

function facadeIntake(signal) {
  return { runId: 'pause-facade-run', goal: 'Preserve admitted work across owner pause.', contract: { requiredChecks: [] }, signal,
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'engine-objective-1', sessionId: 'pause-facade-session' } };
}

function facadePlannerResult(options, turnId) {
  const threadId = options.threadId;
  const processIdentity = readProcessIdentity(process.pid);
  options.onTurnStart({ threadId, processIdentity });
  return { threadId, turnId, status: 'completed',
    text: JSON.stringify({ expected: JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins,
      delta: null, dialogue: null, recovery: null, ownerDecision: null }),
    execution: { threadId, turnId, processIdentity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
}

test('revision-pinned owner cancel stays draining until the admitted planner turn settles', { timeout: 10000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    const result = facadePlannerResult(options, `cancel-turn-${calls}`);
    if (calls === 1) { entered.resolve(); await release.promise; }
    return result;
  } } });
  const pending = fx.engine.run(facadeIntake(new AbortController().signal));
  await entered.promise;
  const before = fx.engine.controlStatus('pause-facade-run');
  const acknowledgement = await fx.engine.requestCancel('pause-facade-run', before.revisions.controlRevision);
  assert.deepEqual([acknowledgement.action, acknowledgement.state, acknowledgement.disposition,
    acknowledgement.revisions.controlRevision], ['cancel', 'requested', 'draining', before.revisions.controlRevision + 1]);
  assert.equal(fx.engine.store.getObjective(projectId, before.objectiveId).disposition, 'draining');
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 'canceled');
  assert.equal(fx.engine.store.getObjective(projectId, before.objectiveId).disposition, 'canceled');
  assert.equal(calls, 1);
});

async function createPausedFacadeHarness(t, { appServer = {} } = {}) {
  const fx = await createHarness(t, { appServer: { async run(options) { return facadePlannerResult(options, 'initial-pause-turn'); }, ...appServer } });
  const abort = new AbortController();
  const pending = fx.engine.run(facadeIntake(abort.signal));
  await waitFor(() => fx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get()
    && fx.db.prepare("SELECT status FROM delivery_planner_turns WHERE status='complete'").get(), 'initial planner did not complete');
  assert.equal(fx.engine.requestPause('pause-facade-run'), true);
  assert.equal((await pending).pause.kind, 'owner_pause');
  await fx.engine.shutdown();
  return fx;
}

test('concurrent status uses persisted phase, wait, task, and provider binding facts', { timeout: 15000 }, async (t) => {
  const fx = await createPausedFacadeHarness(t);
  let status = fx.engine.controlStatus('pause-facade-run');
  assert.equal(status.phase, 'paused');
  assert.equal(status.disposition, 'paused_owner');
  assert.deepEqual(status.nextAction, { kind: 'owner_action', state: 'required', reason: 'paused_owner' });
  assert.equal(status.providerBinding.state, 'bound');
  assert.equal(status.providerBinding.account, 'durably_bound');
  assert.equal(JSON.stringify(status).includes('fake-account'), false);
  assert.equal(status.candidate.state, 'known');
  assert.deepEqual(status.waits, []);

  let objective = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  objective = fx.engine.store.transitionLifecycleControl(projectId, 'engine-objective-1', { action: 'resume',
    expectedOwnerGeneration: objective.ownerGeneration, expectedControlRevision: objective.controlRevision });
  const queued = engineerTask('engine-objective-1', 'status-pending-worker', 'status-pending.txt', 'remain queued for status');
  fx.engine.store.applyPlan(projectId, 'engine-objective-1', planDelta(objective, [queued]));
  status = fx.engine.controlStatus('pause-facade-run');
  assert.equal(status.phase, 'active');
  assert.equal(status.nextAction.kind, 'dispatch_tasks');
  assert.ok(status.blockers.some((blocker) => blocker.kind === 'task_pending' && blocker.taskId === queued.taskId));
  assert.deepEqual(status.checks, []);

  objective = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const wait = fx.engine.store.recordBudgetWait(projectId, 'engine-objective-1', { waitId: 'status-budget-wait', source: 'test',
    provider: 'app-server', model: 'test-model', reasonCode: 'quota', nextWakeAt: 123456,
    expectedControlRevision: objective.controlRevision, expectedOwnerGeneration: objective.ownerGeneration });
  status = fx.engine.controlStatus('pause-facade-run');
  assert.equal(status.phase, 'waiting');
  assert.equal(status.disposition, 'waiting_budget');
  assert.deepEqual(status.nextAction, { kind: 'wait_for_budget', state: 'scheduled', at: wait.nextWakeAt, reason: null });
  assert.deepEqual(status.waits, [{ waitId: wait.waitId, state: 'waiting', source: 'test', provider: 'app-server', model: 'test-model',
    reasonCode: 'quota', nextWakeAt: wait.nextWakeAt }]);
  assert.ok(status.blockers.some((blocker) => blocker.kind === 'budget_wait'));
});

test('concurrent status marks blocked and missing durable evidence as unknown', { timeout: 15000 }, async (t) => {
  const fx = await createPausedFacadeHarness(t);
  let objective = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  objective = fx.engine.store.transitionLifecycleControl(projectId, 'engine-objective-1', { action: 'resume',
    expectedOwnerGeneration: objective.ownerGeneration, expectedControlRevision: objective.controlRevision });
  objective = fx.engine.store.blockTechnical(projectId, 'engine-objective-1', { failureCode: 'status_test_blocked',
    expectedControlRevision: objective.controlRevision, expectedOwnerGeneration: objective.ownerGeneration });
  let status = fx.engine.controlStatus('pause-facade-run');
  assert.equal(status.phase, 'blocked');
  assert.equal(status.disposition, 'blocked_technical');
  assert.deepEqual(status.nextAction, { kind: 'technical_recovery', state: 'required', reason: 'blocked_technical' });

  fx.db.prepare(`UPDATE concurrent_delivery_runs SET lead_thread_id=NULL,lead_codex_home=NULL,lead_settings_json=NULL
    WHERE project_id=? AND run_id=?`).run(projectId, 'pause-facade-run');
  fx.engine.controllers.delete('pause-facade-run');
  status = fx.engine.controlStatus('pause-facade-run');
  assert.deepEqual(status.providerBinding, { state: 'unknown', account: 'unknown', codexHome: 'unknown',
    reason: 'durable_lead_binding_unavailable' });
  assert.deepEqual(status.controller, { state: 'unknown', reason: 'controller_not_loaded' });
  assert.deepEqual(status.finalization, { state: 'none', qualified: false, reason: 'finalization_not_recorded', candidateId: null });
  assert.equal(status.checks.every((check) => check.state === 'unknown'), true);
  assert.equal(JSON.stringify(status).includes('fake-account'), false);
});

async function reopenWithProvider(t, fx, identity, appServer) {
  const db = new Database(path.join(fx.storageRoot, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace: fx.workspace });
  const lanes = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree',
    lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
  const app = express();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const engine = new ConcurrentDeliveryEngine({ db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
    baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer,
    providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead, admission, lanes,
    writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
  engine.register(app);
  t.after(async () => { await engine.shutdown().catch(() => {}); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close(); });
  return { db, engine };
}

test('composed router and engine reopen the same concurrent objective with checkpoint and attempt lineage', { timeout: 15000 }, async (t) => {
  const runId = 'composed-restart-task';
  const goal = 'Keep the original objective and execute only its required source check.';
  const contract = { requiredChecks: [{ id: 'source-check', argv: [process.execPath, 'verify-source.js'] }] };
  const contextId = 'composed-provider-context';
  const calls = [];
  const roles = new Map([
    ['verifier', { id: 'verifier', name: 'Verifier', description: 'Checks frozen inputs.', sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' }],
    ['engineer', { id: 'engineer', name: 'Engineer', description: 'Writes assigned changes.', sandbox: 'workspace-write', model: 'test-model', effort: 'low', fastMode: 'off' }],
  ]);
  const fx = await createHarness(t, { roles, appServer: { async run(options) {
    calls.push(options.role.id);
    return facadePlannerResult(options, `composed-turn-${calls.length}`);
  } } });
  const legacyEngine = { async run() { throw new Error('Unexpected legacy dispatch'); }, async resume() { throw new Error('Unexpected legacy resume'); } };
  const router = new DeliveryEngineRouter({ db: fx.db, projectId, defaultEngine: 'concurrent-v1',
    legacyEngine, concurrentEngine: fx.engine });
  const initial = router.run({ runId, goal, contract, contextId });
  await waitFor(() => fx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get()
    && fx.db.prepare("SELECT status FROM delivery_planner_turns WHERE status='complete'").get(), 'initial composed planner did not complete');
  const mapping = router.mapping(runId);
  assert.equal(mapping.objectiveId, router.objectiveIdFor(runId));
  assert.equal(mapping.sessionId, router.sessionIdFor(runId, contextId));
  assert.equal(fx.engine.requestPause(runId), true);
  assert.equal((await initial).pause.kind, 'owner_pause');

  const objectiveId = mapping.objectiveId;
  const checkpointBefore = fx.engine.reviewStore.checkpointHistory({ projectId, objectiveId });
  assert.equal(checkpointBefore.length, 1);
  assert.equal(checkpointBefore[0].checkpoint.checkIdentity, fx.engine.db.prepare(`SELECT check_identity FROM concurrent_delivery_runs
    WHERE project_id=? AND run_id=?`).get(projectId, runId).check_identity);
  assert.deepEqual(checkpointBefore[0].checkpoint.checkPins, ['source-check']);
  const originalRun = fx.engine.db.prepare('SELECT * FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(projectId, runId);
  assert.equal(originalRun.goal, goal);
  const persistedContract = { id: 'acceptance-contract/v1', requiredChecks: [{ ...contract.requiredChecks[0], timeoutMs: 600000 }] };
  assert.deepEqual(JSON.parse(originalRun.contract_json), persistedContract);

  let objective = fx.engine.store.getObjective(projectId, objectiveId);
  objective = fx.engine.store.transitionLifecycleControl(projectId, objectiveId, { action: 'resume',
    expectedOwnerGeneration: objective.ownerGeneration, expectedControlRevision: objective.controlRevision });
  const task = engineerTask(objectiveId, 'lineage-worker', 'never-written.txt', 'retain historical attempt lineage');
  const queuedTask = engineerTask(objectiveId, 'queued-worker', 'queued-output.txt', 'remain pending behind the prior worker');
  const dependency = { schemaVersion: 'delivery/v1', projectId, objectiveId, predecessorType: 'task', predecessorId: task.taskId,
    successorTaskId: queuedTask.taskId, kind: 'requires_output' };
  fx.engine.store.applyPlan(projectId, objectiveId, planDelta(objective, [task, queuedTask], [dependency]));
  objective = fx.engine.store.getObjective(projectId, objectiveId);
  const [claim] = fx.engine.store.claimReady(projectId, objectiveId, objective.ownerGeneration, { controlRevision: objective.controlRevision });
  assert.ok(claim);
  const settled = fx.engine.store.settleAttempt(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken,
    { state: 'canceled', failureKind: 'test_no_dispatch' }, { remoteQuiescent: true, processQuiescent: true,
      effectsSettled: true, evidenceRefs: ['test:no-dispatch'] });
  assert.equal(settled.attempt.state, 'canceled');
  objective = fx.engine.store.getObjective(projectId, objectiveId);
  fx.engine.store.transitionLifecycleControl(projectId, objectiveId, { action: 'pause',
    expectedOwnerGeneration: objective.ownerGeneration, expectedControlRevision: objective.controlRevision });
  const attemptBefore = fx.engine.store.listAttempts(projectId, objectiveId);
  assert.equal(attemptBefore.length, 1);
  const queuedBefore = fx.engine.store.getObjective(projectId, objectiveId).tasks.find((entry) => entry.taskId === queuedTask.taskId);
  assert.equal(queuedBefore.state, 'queued');

  await fx.engine.shutdown();
  fx.db.close();
  const identity = { accountId: 'fake-account', codexHome };
  const reopened = await reopenWithProvider(t, fx, identity, fx.appServer);
  const resumedRouter = new DeliveryEngineRouter({ db: reopened.db, projectId, defaultEngine: 'legacy',
    legacyEngine, concurrentEngine: reopened.engine });
  const resumed = resumedRouter.resume({ runId });
  await waitFor(() => calls.length === 2, 'reopened composed planner did not resume');
  assert.equal(reopened.engine.requestPause(runId), true);
  assert.equal((await resumed).pause.kind, 'owner_pause');

  assert.deepEqual(resumedRouter.mapping(runId), mapping);
  const reopenedRun = reopened.db.prepare('SELECT * FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(projectId, runId);
  assert.equal(reopenedRun.objective_id, objectiveId);
  assert.equal(reopenedRun.session_id, mapping.sessionId);
  assert.equal(reopenedRun.goal, goal);
  assert.deepEqual(JSON.parse(reopenedRun.contract_json), persistedContract);
  assert.equal(reopenedRun.check_identity, originalRun.check_identity);
  assert.deepEqual(reopened.engine.reviewStore.checkpointHistory({ projectId, objectiveId }), checkpointBefore);
  assert.deepEqual(reopened.engine.store.listAttempts(projectId, objectiveId), attemptBefore);
  assert.equal(reopened.engine.store.listAttempts(projectId, objectiveId)[0].attemptId, claim.attempt.attemptId);
  assert.deepEqual(reopened.engine.store.getObjective(projectId, objectiveId).tasks.find((entry) => entry.taskId === queuedTask.taskId), queuedBefore);
  assert.deepEqual(calls, ['lead', 'lead']);
  await assert.rejects(resumedRouter.run({ runId, goal: 'A similar but different goal must not replace the owner objective.' }),
    { code: 'run_intake_conflict' });
  await assert.rejects(resumedRouter.run({ runId, contract: { requiredChecks: [] } }), { code: 'run_intake_conflict' });
  assert.deepEqual(calls, ['lead', 'lead']);
  assert.equal(reopened.engine.store.getObjective(projectId, objectiveId).disposition, 'paused_owner');
  assert.equal(fs.existsSync(path.join(fx.workspace, 'never-written.txt')), false);
});

async function createBlockedFrozenReviewHarness(t) {
  const fx = await createPausedFacadeHarness(t);
  const objectiveId = 'engine-objective-1';
  const checkpoint = fx.engine.reviewStore.checkpointHistory({ projectId, objectiveId })
    .find((entry) => entry.checkpoint.kind === 'owner_request').checkpoint;
  const candidateId = fx.db.prepare(`SELECT candidate_id FROM concurrent_candidates
    WHERE project_id=? AND objective_id=? AND status='known' ORDER BY integration_generation LIMIT 1`).get(projectId, objectiveId).candidate_id;
  const candidate = fx.engine.candidateStore.get(candidateId);
  const proposal = fx.engine.reviewStore.proposeReviews({ projectId, objectiveId, checkpointId: checkpoint.checkpointId,
    candidateId: candidate.candidateId, reviewers: [{ role: 'verifier', taskId: 'resume-frozen-verifier' }] }, { source: 'concurrent-engine' })[0];
  let current = fx.engine.store.getObjective(projectId, objectiveId);
  fx.engine.store.applyPlan(projectId, objectiveId, planDelta(current, [proposal.task]));
  fx.engine.controllers.clear();
  current = fx.engine.store.getObjective(projectId, objectiveId);
  current = fx.engine.store.transitionLifecycleControl(projectId, objectiveId, { action: 'resume',
    expectedOwnerGeneration: current.ownerGeneration, expectedControlRevision: current.controlRevision });
  const [claim] = fx.engine.store.claimReady(projectId, objectiveId, current.ownerGeneration, { controlRevision: current.controlRevision });
  assert.ok(claim);
  fx.engine.store.requestControl(projectId, objectiveId, 'pause', current.controlRevision);
  fx.engine.store.markExpired(projectId, objectiveId, Number.MAX_SAFE_INTEGER);
  const evidenceRef = `concurrent-shutdown:undispatched-review:${claim.attempt.attemptId}:${claim.attempt.contractDigest}`;
  fx.engine.store.settleRecoveredNoEffect(projectId, objectiveId, claim.attempt.attemptId, claim.claim.fencingToken, {
    projectId, objectiveId, taskId: claim.task.taskId, attemptId: claim.attempt.attemptId,
    fencingToken: claim.claim.fencingToken, claimOwnerGeneration: claim.claim.ownerGeneration, recoveryGeneration: current.ownerGeneration,
    providerContextId: claim.attempt.providerContextId, intentState: null, noEffect: true, remoteQuiescent: true,
    processQuiescent: true, effectsSettled: true, evidenceRefs: [evidenceRef],
  });
  const blocked = fx.db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, objectiveId);
  const blockedRecord = JSON.parse(blocked.record_json);
  blockedRecord.disposition = 'blocked_technical';
  fx.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(JSON.stringify(blockedRecord), projectId, objectiveId);
  fx.db.prepare(`UPDATE backlog_lifecycle_controls SET cause='blocked_technical' WHERE project_id=? AND objective_id=?`).run(projectId, objectiveId);
  await fx.engine.shutdown();
  return { fx, objectiveId, checkpoint, candidate, proposal, claim };
}

test('provider drift stays dormant until explicit resume prepares and durably binds a fresh planner thread', { timeout: 15000 }, async (t) => {
  const fx = await createPausedFacadeHarness(t);
  const priorObjective = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const priorCheckpoints = fx.engine.reviewStore.checkpointHistory({ projectId, objectiveId: 'engine-objective-1' });
  const currentIdentity = { accountId: 'replacement-account', codexHome: '/tmp/concurrent-engine-replacement-home' };
  const preparedThreads = [];
  const plannerThreads = [];
  const appServer = { ...fx.appServer, getCodexHome: () => currentIdentity.codexHome,
    async prepareThread({ role }) {
      const threadId = `${role.id}-replacement-${preparedThreads.length + 1}`;
      preparedThreads.push(threadId);
      return { threadId, codexHome: currentIdentity.codexHome };
    },
    async run(options) {
      plannerThreads.push(options.threadId);
      return facadePlannerResult(options, `replacement-turn-${plannerThreads.length}`);
    } };
  const reopened = await reopenWithProvider(t, fx, currentIdentity, appServer);

  assert.deepEqual(await reopened.engine.recoverStoredRuns(), [
    { runId: 'pause-facade-run', state: 'dormant', reason: 'provider_identity_changed' },
  ]);
  assert.equal(preparedThreads.length, 0, 'startup recovery must not prepare or bind a replacement thread');
  assert.equal(reopened.engine.controllers.has('pause-facade-run'), false);
  const resumed = reopened.engine.resume({ runId: 'pause-facade-run' });
  await waitFor(() => plannerThreads.length === 1, 'fresh provider planner did not start');
  await waitFor(() => reopened.db.prepare("SELECT status FROM delivery_planner_turns WHERE provider_thread_id=? AND status='complete'")
    .get(preparedThreads[0]), 'fresh provider planner did not complete');
  assert.deepEqual(preparedThreads, ['lead-replacement-1']);
  assert.deepEqual(plannerThreads, ['lead-replacement-1']);
  const turns = reopened.db.prepare(`SELECT provider_thread_id,provider_scope,status FROM delivery_planner_turns
    WHERE project_id=? AND session_id=? ORDER BY started_at,turn_id`).all(projectId, 'pause-facade-session');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].provider_thread_id, 'lead-thread');
  assert.match(turns[0].provider_scope, /fake-account/);
  assert.equal(turns[1].provider_thread_id, 'lead-replacement-1');
  assert.match(turns[1].provider_scope, /replacement-account/);
  const rebound = reopened.engine.store.events.replay(projectId).find((event) => event.eventType === 'planner.provider_rebound');
  assert.ok(rebound);
  assert.equal(rebound.payload.priorBinding.accountId, 'fake-account');
  assert.equal(rebound.payload.priorBinding.codexHome, codexHome);
  assert.equal(rebound.payload.currentBinding.accountId, 'replacement-account');
  assert.equal(rebound.payload.priorBinding.settings.codexHome, codexHome);
  const afterObjective = reopened.engine.store.getObjective(projectId, 'engine-objective-1');
  assert.equal(afterObjective.ownerGeneration, priorObjective.ownerGeneration);
  assert.equal(afterObjective.planRevision, priorObjective.planRevision);
  assert.equal(afterObjective.requirementDigest, priorObjective.requirementDigest);
  assert.deepEqual(reopened.engine.reviewStore.checkpointHistory({ projectId, objectiveId: 'engine-objective-1' }), priorCheckpoints);
  assert.equal(reopened.engine.requestPause('pause-facade-run'), true);
  assert.equal((await resumed).pause.kind, 'owner_pause');
});

for (const changedState of ['control', 'binding']) test(`provider rebind refuses ${changedState} drift during delayed thread preparation without writing history`, { timeout: 15000 }, async (t) => {
  const fx = await createPausedFacadeHarness(t);
  const currentIdentity = { accountId: 'replacement-account', codexHome: '/tmp/concurrent-engine-replacement-home' };
  const prepareEntered = deferred();
  const releasePrepare = deferred();
  t.after(() => releasePrepare.resolve());
  let prepared = 0;
  const appServer = { ...fx.appServer, getCodexHome: () => currentIdentity.codexHome,
    async prepareThread({ role }) {
      prepared += 1;
      prepareEntered.resolve();
      await releasePrepare.promise;
      return { threadId: `${role.id}-replacement-${prepared}`, codexHome: currentIdentity.codexHome };
    },
    async run(options) { return facadePlannerResult(options, 'unexpected-resume-turn'); } };
  const reopened = await reopenWithProvider(t, fx, currentIdentity, appServer);
  const beforeRun = reopened.db.prepare(`SELECT lead_thread_id,lead_codex_home,lead_settings_json FROM concurrent_delivery_runs
    WHERE project_id=? AND run_id=?`).get(projectId, 'pause-facade-run');
  const beforeObjective = reopened.engine.store.getObjective(projectId, 'engine-objective-1');
  const resume = reopened.engine.resume({ runId: 'pause-facade-run' });
  await prepareEntered.promise;
  if (changedState === 'control') {
    reopened.engine.store.requestControl(projectId, 'engine-objective-1', 'pause', beforeObjective.controlRevision);
  } else {
    const changed = JSON.parse(beforeRun.lead_settings_json);
    changed.settings.effort = 'medium';
    reopened.db.prepare(`UPDATE concurrent_delivery_runs SET lead_settings_json=? WHERE project_id=? AND run_id=?`)
      .run(JSON.stringify(changed), projectId, 'pause-facade-run');
  }
  releasePrepare.resolve();
  await assert.rejects(resume, { code: changedState === 'control' ? 'concurrent_resume_control_changed' : 'concurrent_resume_binding_changed' });
  const afterRun = reopened.db.prepare(`SELECT lead_thread_id,lead_codex_home,lead_settings_json FROM concurrent_delivery_runs
    WHERE project_id=? AND run_id=?`).get(projectId, 'pause-facade-run');
  assert.equal(afterRun.lead_thread_id, beforeRun.lead_thread_id);
  assert.equal(afterRun.lead_codex_home, beforeRun.lead_codex_home);
  if (changedState === 'binding') assert.notEqual(afterRun.lead_settings_json, beforeRun.lead_settings_json);
  assert.equal(reopened.engine.store.events.replay(projectId).some((event) => event.eventType === 'planner.provider_rebound'), false);
  const afterObjective = reopened.engine.store.getObjective(projectId, 'engine-objective-1');
  assert.equal(afterObjective.ownerGeneration, beforeObjective.ownerGeneration);
  assert.equal(afterObjective.controlRevision, beforeObjective.controlRevision + (changedState === 'control' ? 1 : 0));
  assert.equal(prepared, 1);
});

test('provider drift resumes a blocked objective through its exact frozen verifier and keeps unknown siblings fenced', { timeout: 20000 }, async (t) => {
  const { fx, objectiveId, proposal, claim } = await createBlockedFrozenReviewHarness(t);

  const currentIdentity = { accountId: 'replacement-account', codexHome: '/tmp/concurrent-engine-replacement-home' };
  const prepared = [];
  const plannerThreads = [];
  let verifierCalls = 0;
  const appServer = { ...fx.appServer, getCodexHome: () => currentIdentity.codexHome,
    async prepareThread({ role }) {
      const threadId = `${role.id}-replacement-${prepared.length + 1}`;
      prepared.push(threadId);
      return { threadId, codexHome: currentIdentity.codexHome };
    },
    async run(options) {
      const threadId = options.threadId || `${options.role.id}-replacement-worker`;
      const turnId = `resume-${options.role.id}-${plannerThreads.length + verifierCalls}`;
      if (options.role.id === 'lead') {
        plannerThreads.push(threadId);
        return facadePlannerResult(options, turnId);
      }
      assert.equal(options.role.id, 'verifier');
      verifierCalls += 1;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      return { threadId, turnId, status: 'completed', text: JSON.stringify({ outcome: 'completed',
        summary: 'VERDICT: pass\nFrozen candidate checked.', filesChanged: [], filesInspected: ['source.txt', 'verify-source.js'],
        checks: [{ command: 'frozen-candidate-inspection', result: 'passed', detail: 'Inspected the frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null }),
      execution: { threadId, turnId, processIdentity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
    } };
  const reopened = await reopenWithProvider(t, fx, currentIdentity, appServer);
  const recovery = await reopened.engine.recoverStoredRuns();
  assert.deepEqual(recovery, [{ runId: 'pause-facade-run', state: 'dormant', reason: 'provider_identity_changed' }]);
  const resume = reopened.engine.resume({ runId: 'pause-facade-run' });
  await waitFor(() => verifierCalls === 1, 'frozen verifier did not run after blocked recovery');
  await waitFor(() => reopened.engine.store.listAttempts(projectId, objectiveId).some((attempt) => attempt.taskId === proposal.task.taskId
    && attempt.attemptNo === 2 && ['succeeded', 'failed', 'canceled'].includes(attempt.state)), 'frozen verifier did not settle');
  const verifierAttempt = reopened.engine.store.listAttempts(projectId, objectiveId).find((attempt) => attempt.taskId === proposal.task.taskId
    && attempt.attemptNo === 2);
  assert.equal(verifierAttempt?.state, 'succeeded', JSON.stringify({ verifierAttempt,
    execution: verifierAttempt && reopened.engine.roleService.getExecution(verifierAttempt.attemptId),
    objective: reopened.engine.store.getObjective(projectId, objectiveId), controller: reopened.engine.controllers.get('pause-facade-run')?.status() }));
  assert.equal(reopened.engine.store.getObjective(projectId, objectiveId).ownerGeneration, 0);
  assert.equal(reopened.engine.store.getObjective(projectId, objectiveId).tasks.find((task) => task.taskId === proposal.task.taskId).state, 'succeeded');
  assert.deepEqual(prepared, ['lead-replacement-1']);
  assert.ok(plannerThreads.includes('lead-replacement-1'));
  assert.equal(reopened.engine.store.listAttempts(projectId, objectiveId).find((attempt) => attempt.attemptId === claim.attempt.attemptId).state, 'canceled');
  assert.equal(reopened.engine.store.events.replay(projectId).some((event) => event.eventType === 'planner.provider_rebound'), true);
  try {
    await waitFor(() => ['accepted', 'partial'].includes(reopened.engine.store.getObjective(projectId, objectiveId).disposition),
      'resumed run did not reach host acceptance');
  } catch (cause) {
    t.diagnostic(JSON.stringify({ objective: reopened.engine.store.getObjective(projectId, objectiveId),
      finalizations: reopened.engine.store.listFinalizations(projectId, objectiveId).map((entry) => ({ state: entry.state, reason: entry.reason })),
      pause: reopened.engine.getPause('pause-facade-run') }));
    throw cause;
  }
  const accepted = await resume;
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.disposition, 'accepted');
  assert.equal(reopened.engine.store.getObjective(projectId, objectiveId).disposition, 'accepted');

  const unknownFixture = await createPausedFacadeHarness(t);
  unknownFixture.db.prepare(`UPDATE delivery_planner_turns SET status='unknown' WHERE project_id=? AND session_id=?`)
    .run(projectId, 'pause-facade-session');
  const unknownIdentity = { accountId: 'another-account', codexHome: '/tmp/concurrent-engine-another-home' };
  let unknownPrepares = 0;
  const unknownServer = { ...unknownFixture.appServer, getCodexHome: () => unknownIdentity.codexHome,
    async prepareThread({ role }) { unknownPrepares += 1; return { threadId: `${role.id}-must-not-prepare`, codexHome: unknownIdentity.codexHome }; } };
  const unknownReopen = await reopenWithProvider(t, unknownFixture, unknownIdentity, unknownServer);
  assert.deepEqual(await unknownReopen.engine.recoverStoredRuns(), [{ runId: 'pause-facade-run', state: 'unknown',
    reason: 'concurrent_provider_identity_changed_unresolved' }]);
  assert.equal(unknownPrepares, 0);
  assert.equal(unknownReopen.engine.controllers.has('pause-facade-run'), false);
});

for (const scenario of ['verifier settings drift', 'tampered rebound lineage', 'unrelated rebound lineage']) {
  test(`provider rebound finalization rejects ${scenario}`, { timeout: 20000 }, async (t) => {
    const { fx, objectiveId, checkpoint } = await createBlockedFrozenReviewHarness(t);
    const originalCheckpoint = JSON.stringify(checkpoint);
    if (scenario === 'verifier settings drift') {
      fx.roles.set('verifier', { ...fx.roles.get('verifier'), effort: 'high' });
    }
    const currentIdentity = { accountId: 'replacement-account', codexHome: '/tmp/concurrent-engine-replacement-home' };
    const verifierEntered = deferred();
    const releaseVerifier = deferred();
    t.after(() => releaseVerifier.resolve());
    const appServer = { ...fx.appServer, getCodexHome: () => currentIdentity.codexHome,
      async prepareThread({ role }) { return { threadId: `${role.id}-replacement-negative`, codexHome: currentIdentity.codexHome }; },
      async run(options) {
        const turnId = `negative-${options.role.id}-turn`;
        if (options.role.id === 'lead') return facadePlannerResult(options, turnId);
        assert.equal(options.role.id, 'verifier');
        const threadId = options.threadId || 'verifier-replacement-worker';
        const processIdentity = readProcessIdentity(process.pid);
        options.onTurnStart({ threadId, processIdentity });
        assert.equal(scopedExecutionDetails(options.deliveryCapability).verifyCandidate(), true);
        verifierEntered.resolve();
        await releaseVerifier.promise;
        return { threadId, turnId, status: 'completed', text: JSON.stringify({ outcome: 'completed',
          summary: 'VERDICT: pass\nFrozen candidate checked.', filesChanged: [], filesInspected: ['source.txt', 'verify-source.js'],
          checks: [{ command: 'frozen-candidate-inspection', result: 'passed', detail: 'Inspected the frozen candidate.' }],
          risks: [], scopeExpansion: [], decisionRequest: null }),
        execution: { threadId, turnId, processIdentity,
          turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
      } };
    const reopened = await reopenWithProvider(t, fx, currentIdentity, appServer);
    assert.deepEqual(await reopened.engine.recoverStoredRuns(), [{ runId: 'pause-facade-run', state: 'dormant', reason: 'provider_identity_changed' }]);
    let finalizationDenied = false;
    const beginFinalization = reopened.engine.store.beginFinalization.bind(reopened.engine.store);
    reopened.engine.store.beginFinalization = (...args) => {
      try { return beginFinalization(...args); }
      catch (cause) { if (cause.code === 'finalization_unauthorized') finalizationDenied = true; throw cause; }
    };
    const resume = reopened.engine.resume({ runId: 'pause-facade-run' });
    const resumeOutcome = resume.then((value) => ({ value }), (cause) => ({ cause }));
    await verifierEntered.promise;
    const rebound = reopened.engine.store.events.replay(projectId).find((event) => event.eventType === 'planner.provider_rebound');
    assert.ok(rebound);
    if (scenario === 'tampered rebound lineage' || scenario === 'unrelated rebound lineage') {
      const row = reopened.db.prepare('SELECT event_json FROM delivery_events WHERE project_id=? AND event_id=?')
        .get(projectId, rebound.eventId);
      const event = JSON.parse(row.event_json);
      if (scenario === 'tampered rebound lineage') event.payload.currentBinding.settingsDigest = `sha256:${'0'.repeat(64)}`;
      else event.payload.objectiveId = 'unrelated-objective';
      reopened.db.prepare('UPDATE delivery_events SET event_json=? WHERE project_id=? AND event_id=?')
        .run(JSON.stringify(event), projectId, rebound.eventId);
    }
    releaseVerifier.resolve();
    try {
      await waitFor(() => reopened.engine.store.listAttempts(projectId, objectiveId)
        .some((attempt) => attempt.taskId === 'resume-frozen-verifier' && attempt.attemptNo === 2 && attempt.state === 'succeeded'),
      'frozen verifier did not settle in negative finalization case');
    } catch (cause) {
      t.diagnostic(JSON.stringify({ scenario, attempts: reopened.engine.store.listAttempts(projectId, objectiveId).map((attempt) => ({ state: attempt.state, attemptNo: attempt.attemptNo })),
        execution: reopened.engine.roleService.projection().map((entry) => {
          const record = reopened.engine.roleService.getExecution(entry.attemptId);
          return { state: record.state, failureCode: record.failureCode, reportError: record.reportError, result: record.result };
        }), executorEvidence: reopened.db.prepare('SELECT kind,detail_json FROM task_executor_evidence').all(),
        objective: reopened.engine.store.getObjective(projectId, objectiveId).disposition }));
      throw cause;
    }
    const resumeResult = await resumeOutcome;
    assert.equal(resumeResult.cause?.code, 'finalization_unauthorized');
    assert.equal(finalizationDenied, true);
    assert.notEqual(reopened.engine.store.getObjective(projectId, objectiveId).disposition, 'accepted');
    assert.equal(reopened.engine.store.listFinalizations(projectId, objectiveId).some((entry) => entry.state === 'accepted'), false);
    assert.equal(JSON.stringify(reopened.engine.reviewStore.checkpointHistory({ projectId, objectiveId })
      .find((entry) => entry.checkpoint.checkpointId === checkpoint.checkpointId).checkpoint), originalCheckpoint);
  });
}

for (const reopen of [false, true]) test(`owner pause facade resumes ${reopen ? 'reopened SQLite' : 'reused controller'} without overlapping planner calls`, { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  t.after(() => release.resolve());
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const result = facadePlannerResult(options, `pause-turn-${calls}`);
    if (calls === 1) { entered.resolve(); await release.promise; }
    active -= 1;
    return result;
  } } });
  const abort = new AbortController();
  const pending = fx.engine.run(facadeIntake(abort.signal));
  await entered.promise;
  assert.equal(fx.engine.requestPause('pause-facade-run'), true);
  let paused;
  pending.then((value) => { paused = value; });
  await waitFor(() => paused, 'owner pause did not return from the facade', 700);
  assert.equal(paused.status, 'input_required');
  assert.equal(paused.pause.kind, 'owner_pause');
  assert.equal(active, 1, 'pause must retain the admitted planner call');
  let engine = fx.engine;
  const prior = engine.controllers.get('pause-facade-run');
  if (reopen) {
    release.resolve();
    await waitFor(() => !prior.cycle, 'paused planner did not drain');
    await engine.shutdown().catch(() => {});
    const db = new Database(path.join(fx.storageRoot, 'state.sqlite'));
    const identity = { accountId: 'fake-account', codexHome };
    const admission = new WriterAdmission({ db, workspace: fx.workspace });
    const lanes = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree', lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
    engine = new ConcurrentDeliveryEngine({ db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
      baseUrl: fx.baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer: fx.appServer,
      providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead, admission, lanes,
      writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
    t.after(async () => { await engine.shutdown().catch(() => {}); db.close(); });
    await engine.recoverStoredRuns();
    assert.equal(engine.getRunDigest('pause-facade-run').disposition, 'paused_owner');
  }
  const resumed = engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  assert.equal(engine.getRunDigest('pause-facade-run').disposition, 'executing');
  const revision = engine.controlStatus('pause-facade-run').revisions.controlRevision;
  const duplicate = engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  assert.equal(engine.controlStatus('pause-facade-run').revisions.controlRevision, revision);
  assert.equal(engine.getPause('pause-facade-run'), null);
  release.resolve();
  await waitFor(() => calls >= 2 && active === 0
    && fx.db.prepare("SELECT status FROM delivery_planner_turns WHERE status='complete'").get(), 'resumed planner did not complete');
  assert.equal(maxActive, 1);
  if (!reopen) assert.equal(engine.controllers.get('pause-facade-run'), prior);
  assert.equal(engine.requestPause('pause-facade-run'), true);
  const results = await Promise.all([resumed, duplicate]);
  assert.ok(results.every((value) => value.pause.kind === 'owner_pause'));
  assert.ok(fx.db.prepare("SELECT status FROM delivery_planner_turns WHERE status='stale'").get(), 'old planner result is retained as stale');
  assert.ok(fx.db.prepare("SELECT status FROM delivery_planner_turns WHERE status='complete'").get(), 'resumed completion is retained');
});

for (const unknown of [false, true]) test(`owner pause facade retains admitted worker ${unknown ? 'unknown effects' : 'completion'}`, { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let workerCalls = 0;
  let plannerCalls = 0;
  const roles = new Map([
    ['engineer', { id: 'engineer', name: 'Engineer', description: 'Writes private work.', sandbox: 'workspace-write', model: 'test-model', effort: 'low', fastMode: 'off' }],
    ['verifier', { id: 'verifier', name: 'Verifier', description: 'Reviews candidates.', sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' }],
  ]);
  const fx = await createHarness(t, { roles, appServer: { async run(options) {
    const threadId = options.threadId || 'pause-worker-thread';
    const turnId = `${options.role.id}-pause-${plannerCalls + workerCalls}`;
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    let text;
    if (options.role.id === 'lead') {
      plannerCalls += 1;
      const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
      text = JSON.stringify({ expected: pins, delta: plannerCalls === 1
        ? planDelta(pins, [engineerTask('engine-objective-1', 'paused-worker', 'private.txt', 'complete after pause')]) : null,
      dialogue: null, recovery: null, ownerDecision: null });
    } else if (options.role.id === 'verifier') {
      text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass', filesChanged: [], filesInspected: ['source.txt'],
        checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
    } else {
      workerCalls += 1;
      fs.writeFileSync(path.join(options.cwd, 'private.txt'), 'retained\n');
      entered.resolve();
      await release.promise;
      if (unknown) throw new Error('unknown worker outcome');
      text = JSON.stringify({ outcome: 'completed', summary: 'Completed private work.', filesChanged: ['private.txt'],
        filesInspected: ['source.txt'], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
    }
    return { threadId, turnId, status: 'completed', text,
      execution: { threadId, turnId, processIdentity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
  } } });
  const abort = new AbortController();
  const pending = fx.engine.run(facadeIntake(abort.signal));
  await entered.promise;
  const attempt = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.taskId === 'paused-worker');
  assert.equal(fx.engine.requestPause('pause-facade-run'), true);
  assert.equal((await pending).pause.kind, 'owner_pause');
  assert.equal(fx.engine.roleService.getExecution(attempt.attemptId).state, 'running');
  const resumed = fx.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  assert.equal(fx.engine.requestPause('pause-facade-run'), true);
  assert.equal((await resumed).pause.kind, 'owner_pause');
  release.resolve();
  await waitFor(() => !fx.engine.roleService.active.size, 'worker call did not finish');
  const execution = fx.engine.roleService.getExecution(attempt.attemptId);
  assert.equal(workerCalls, 1);
  assert.equal(fs.existsSync(path.join(fx.workspace, 'private.txt')), false);
  assert.equal(fs.readFileSync(path.join(fx.lanes.store.get(execution.laneId).path, 'private.txt'), 'utf8'), 'retained\n');
  if (unknown) {
    await assert.rejects(fx.engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
    assert.ok(fx.engine.store.listClaims(projectId, 'engine-objective-1').some((claim) => ['active', 'expired', 'fenced'].includes(claim.state)));
  } else {
    const completing = fx.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
    await waitFor(() => fx.engine.executor.getAttempt(attempt.attemptId).state === 'settled', 'worker completion was lost');
    const completed = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
    assert.equal(completed.state, 'failed');
    assert.equal(completed.outcome.failureKind, 'publication_authorization_changed');
    assert.equal(completed.outcome.publicationState, 'not_published');
    assert.equal(fx.engine.requestPause('pause-facade-run'), true);
    assert.equal((await completing).pause.kind, 'owner_pause');
    assert.equal(workerCalls, 1);
  }
});

for (const boundary of ['owner-stop-unknown', 'technical', 'budget']) test(`owner pause facade resume preserves ${boundary} boundary`, { timeout: 15000 }, async (t) => {
  let calls = 0;
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    options.onTurnStart({ threadId: options.threadId, processIdentity: readProcessIdentity(process.pid) });
    throw new Error('planner outcome unknown');
  } } });
  const abort = new AbortController();
  const pending = fx.engine.run(facadeIntake(abort.signal));
  const controller = () => fx.engine.controllers.get('pause-facade-run');
  await waitFor(() => controller()?.status().lastRecovery, 'unknown planner was not held');
  const objective = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  if (boundary === 'owner-stop-unknown') await controller().emergencyStop();
  else if (boundary === 'technical') fx.engine.store.blockTechnical(projectId, objective.objectiveId, {
    failureCode: 'held_effect', expectedControlRevision: objective.controlRevision, expectedOwnerGeneration: objective.ownerGeneration });
  else controller().lifecycle.recordBudgetWait({ waitId: 'pause-budget', source: 'test', provider: 'app-server', model: 'test-model', reasonCode: 'quota', delayMs: 60000 });
  const expectedDisposition = boundary === 'owner-stop-unknown' ? 'executing' : boundary === 'technical' ? 'blocked_technical' : 'waiting_budget';
  const resumed = fx.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fx.engine.getRunDigest('pause-facade-run').disposition, expectedDisposition);
  assert.equal(calls, 1);
  assert.equal(fx.db.prepare('SELECT status FROM delivery_planner_turns').get().status, 'unknown');
  await assert.rejects(fx.engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
  abort.abort();
  await Promise.all([pending, resumed]);
});

function ownerCorrectionMessage(objective, messageId, requirementDigest) {
  return { messageId, kind: 'owner_correction', source: 'verified-owner-adapter', payload: { correction: {
    expectedGoalRevision: objective.goalRevision, expectedAuthorityRevision: objective.authorityRevision,
    expectedControlRevision: objective.controlRevision, requirementDigest } } };
}

async function reopenCorrectionHarness(t, fx) {
  const db = new Database(path.join(fx.storageRoot, 'state.sqlite'));
  const app = express();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const admission = new WriterAdmission({ db, workspace: fx.workspace });
  const lanes = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree', lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
  const identity = { accountId: 'fake-account', codexHome };
  const engine = new ConcurrentDeliveryEngine({ db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
    baseUrl: `http://127.0.0.1:${server.address().port}`, authMiddleware: auth, authToken: 'concurrent-test-token',
    appServer: fx.appServer, providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead,
    admission, lanes, writerIsolation: { mode: 'worktree' }, sleepMs: 10,
    authenticateOwner: ({ source }) => source === 'verified-owner-adapter', ownerCorrectionAuthorized: () => true });
  engine.register(app);
  t.after(async () => {
    await engine.shutdown().catch(() => {});
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    db.close();
  });
  return { engine, db };
}

for (const recoverFirst of [true, false]) test(`owner correction facade carries pending correction through SQLite reopen with ${recoverFirst ? 'recovered controller' : 'direct resume'}`, { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  const releaseSecond = deferred();
  t.after(() => releaseSecond.resolve());
  t.after(() => release.resolve());
  const prompts = [];
  let calls = 0;
  const correctedDigest = `sha256:${'c'.repeat(64)}`;
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    const threadId = options.threadId || `${options.role.id}-correction-thread`;
    const turnId = `correction-turn-${calls}`;
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    let text;
    if (options.role.id === 'lead') {
      const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      prompts.push(prompt);
      if (prompts.length === 1) { entered.resolve(); await release.promise; }
      if (recoverFirst && prompts.length === 2) await releaseSecond.promise;
      text = JSON.stringify({ expected: prompt.pins, delta: null, dialogue: null, recovery: null, ownerDecision: null });
    } else {
      assert.equal(options.role.id, 'verifier');
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nFrozen source checked.', filesChanged: [], filesInspected: ['source.txt', 'verify-source.js'],
        checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed in frozen candidate.' }], risks: [], scopeExpansion: [], decisionRequest: null });
    }
    return { threadId, turnId, status: 'completed', text,
      execution: { threadId, turnId, processIdentity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
  } } });
  fx.engine.authenticateOwner = ({ source }) => source === 'verified-owner-adapter';
  fx.engine.ownerCorrectionAuthorized = () => true;
  const abort = new AbortController();
  const pending = fx.engine.run({ ...facadeIntake(abort.signal),
    contract: { requiredChecks: [{ id: 'source-check', argv: [process.execPath, 'verify-source.js'] }] } });
  await entered.promise;
  const originalIntake = fx.db.prepare('SELECT * FROM concurrent_delivery_runs').get();
  const originalCheckpoint = fx.db.prepare('SELECT * FROM review_checkpoints').get();
  assert.equal(fx.engine.requestPause('pause-facade-run'), true);
  assert.equal((await pending).pause.kind, 'owner_pause');
  const controller = fx.engine.controllers.get('pause-facade-run');
  const paused = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const correction = ownerCorrectionMessage(paused, 'correction-reopen', correctedDigest);
  assert.equal(controller.receive(correction).state, 'received');
  const shuttingDown = fx.engine.shutdown();
  release.resolve();
  await shuttingDown.catch(() => {});
  assert.equal(controller.inbox.get(correction.messageId).state, 'received');
  assert.ok(fx.db.prepare("SELECT status FROM delivery_planner_turns WHERE status='stale'").get());
  let reopened = await reopenCorrectionHarness(t, fx);
  if (recoverFirst) await reopened.engine.recoverStoredRuns();
  let running = reopened.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  t.after(async () => { abort.abort(); await running; });
  await waitFor(() => reopened.engine.controllers.get('pause-facade-run')?.inbox.get(correction.messageId).state === 'applied', 'pending correction not applied by facade');
  let recovered = reopened.engine.controllers.get('pause-facade-run');
  let corrected = reopened.engine.store.getObjective(projectId, 'engine-objective-1');
  assert.equal(corrected.goalRevision, paused.goalRevision + 1);
  assert.equal(corrected.requirementDigest, correctedDigest);
  assert.equal(corrected.controlRevision, paused.controlRevision + 2);
  assert.equal(recovered.receive(correction).duplicate, true);
  await waitFor(() => prompts.length >= 2, 'corrected planner did not run');
  assert.equal(prompts[1].ownerContext.requirementDigest, correctedDigest);
  assert.equal(prompts[1].pins.goalRevision, corrected.goalRevision);
  assert.equal(prompts[1].pins.controlRevision, corrected.controlRevision);
  if (recoverFirst) {
    assert.equal(reopened.engine.requestPause('pause-facade-run'), true);
    assert.equal((await running).pause.kind, 'owner_pause');
    const secondPaused = reopened.engine.store.getObjective(projectId, 'engine-objective-1');
    const second = ownerCorrectionMessage(secondPaused, 'correction-reopen-again', `sha256:${'d'.repeat(64)}`);
    recovered.receive(second);
    const shutdown = reopened.engine.shutdown();
    releaseSecond.resolve();
    await shutdown.catch(() => {});
    const historyBeforeReopen = reopened.db.prepare('SELECT * FROM review_checkpoints ORDER BY checkpoint_id').all();
    reopened = await reopenCorrectionHarness(t, fx);
    running = reopened.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
    await waitFor(() => prompts.length >= 3, 'repeated correction did not reach planner');
    recovered = reopened.engine.controllers.get('pause-facade-run');
    corrected = reopened.engine.store.getObjective(projectId, 'engine-objective-1');
    assert.equal(corrected.goalRevision, secondPaused.goalRevision + 1);
    assert.equal(prompts[2].pins.goalRevision, corrected.goalRevision);
    assert.equal(prompts[2].pins.controlRevision, corrected.controlRevision);
    assert.equal(prompts[2].ownerContext.requirementDigest, second.payload.correction.requirementDigest);
    for (const row of historyBeforeReopen) assert.deepEqual(reopened.db.prepare('SELECT * FROM review_checkpoints WHERE checkpoint_id=?').get(row.checkpoint_id), row);
    assert.equal(recovered.receive(correction).duplicate, true);
    assert.equal(recovered.receive(second).duplicate, true);
  }
  let result;
  running.then((value) => { result = value; });
  try { await waitFor(() => result, 'corrected objective did not reach honest acceptance', 7000); }
  catch (cause) {
    t.diagnostic(JSON.stringify({ objective: reopened.engine.store.getObjective(projectId, 'engine-objective-1'),
      controller: recovered.status(), checkpoints: reopened.engine.reviewStore.checkpointHistory({ projectId, objectiveId: 'engine-objective-1' }),
      review: reopened.engine.reviewStore.finalizationProjection({ projectId, objectiveId: 'engine-objective-1',
        candidateId: reopened.db.prepare("SELECT candidate_id FROM concurrent_candidates WHERE status='known' ORDER BY integration_generation DESC LIMIT 1").get().candidate_id, requiredRoles: ['verifier'] }),
      pause: reopened.engine.getPause('pause-facade-run'),
      finalizations: reopened.engine.store.listFinalizations(projectId, 'engine-objective-1'),
      plannerTurns: reopened.db.prepare('SELECT status,result_json FROM delivery_planner_turns').all() }));
    throw cause;
  }
  assert.equal(result.disposition, 'accepted');
  const terminal = reopened.engine.store.listFinalizations(projectId, 'engine-objective-1').find((row) => row.state === 'accepted').terminalRecord;
  assert.equal(terminal.pins.requirementDigest, corrected.requirementDigest);
  assert.equal(terminal.pins.goalRevision, corrected.goalRevision);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM review_checkpoints WHERE checkpoint_id=?').get(originalCheckpoint.checkpoint_id), originalCheckpoint);
  const supersessions = reopened.engine.reviewStore.checkpointSupersessions({ projectId, objectiveId: 'engine-objective-1' });
  assert.equal(supersessions.length, recoverFirst ? 2 : 1);
  assert.equal(supersessions[0].sourceMessageId, correction.messageId);
  const currentCheckpoint = reopened.engine.reviewStore.checkpointHistory({ projectId, objectiveId: 'engine-objective-1' })
    .find((entry) => entry.checkpoint.goalRevision === corrected.goalRevision).checkpoint;
  assert.deepEqual(currentCheckpoint.checkPins, ['source-check']);
  assert.deepEqual(currentCheckpoint.profilePins, JSON.parse(originalCheckpoint.checkpoint_json).profilePins);
  assert.equal(result.acceptance.checkResults.find((check) => check.id === 'source-check').result, 'passed');
  const finalIntake = reopened.db.prepare('SELECT * FROM concurrent_delivery_runs').get();
  for (const field of ['goal', 'contract_json', 'contract_digest', 'requirement_digest', 'checks_digest', 'check_identity', 'objective_id', 'session_id']) {
    assert.equal(finalIntake[field], originalIntake[field], `immutable intake changed: ${field}`);
  }
});

test('owner correction facade refuses unauthenticated unauthorized and stale messages without rewriting intake', { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const fx = await createHarness(t, { appServer: { async run(options) {
    const result = facadePlannerResult(options, 'correction-negative-turn');
    entered.resolve();
    await release.promise;
    return result;
  } } });
  const abort = new AbortController();
  const pending = fx.engine.run(facadeIntake(abort.signal));
  t.after(async () => { abort.abort(); await pending; });
  await entered.promise;
  assert.equal(fx.engine.requestPause('pause-facade-run'), true);
  await pending;
  const controller = fx.engine.controllers.get('pause-facade-run');
  const original = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const intake = fx.db.prepare('SELECT goal,contract_json,requirement_digest FROM concurrent_delivery_runs').get();
  const message = ownerCorrectionMessage(original, 'denied-correction', `sha256:${'d'.repeat(64)}`);
  assert.throws(() => controller.receive(message), { code: 'owner_authentication_required' });
  assert.equal(controller.inbox.get(message.messageId), null);
  fx.engine.authenticateOwner = ({ source }) => source === 'verified-owner-adapter';
  controller.receive(message);
  release.resolve();
  await waitFor(() => controller.inbox.get(message.messageId).state === 'blocked', 'unauthorized correction was not blocked');
  assert.equal(controller.inbox.get(message.messageId).result.code, 'owner_correction_unauthorized');
  assert.equal(fx.engine.store.getObjective(projectId, 'engine-objective-1').goalRevision, original.goalRevision);
  fx.engine.ownerCorrectionAuthorized = () => true;
  const stale = ownerCorrectionMessage({ ...original, controlRevision: original.controlRevision - 1 }, 'stale-correction', `sha256:${'e'.repeat(64)}`);
  controller.receive(stale);
  await waitFor(() => controller.inbox.get(stale.messageId).state === 'blocked', 'stale correction was not blocked');
  assert.equal(controller.inbox.get(stale.messageId).result.code, 'owner_correction_revision_stale');
  const valid = ownerCorrectionMessage(original, 'valid-correction', `sha256:${'f'.repeat(64)}`);
  controller.receive(valid);
  await waitFor(() => controller.inbox.get(valid.messageId).state === 'applied', 'authorized correction was not applied');
  const corrected = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  assert.equal(corrected.goalRevision, original.goalRevision + 1);
  assert.equal(corrected.controlRevision, original.controlRevision + 1);
  assert.equal(corrected.requirementDigest, valid.payload.correction.requirementDigest);
  assert.equal(controller.receive(valid).duplicate, true);
  assert.throws(() => controller.receive({ ...valid, payload: { correction: { ...valid.payload.correction, requirementDigest: `sha256:${'a'.repeat(64)}` } } }), { code: 'message_id_conflict' });
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM backlog_owner_corrections').get().n, 1);
  assert.equal(fx.engine.store.events.replay(projectId).filter((event) => event.eventType === 'objective.owner_correction').length, 1);
  assert.deepEqual(fx.db.prepare('SELECT goal,contract_json,requirement_digest FROM concurrent_delivery_runs').get(), intake);
});

for (const failure of ['register', 'supersede', 'ack']) test(`owner correction facade rolls back checkpoint inventory history and acknowledgement on ${failure}`, { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const fx = await createHarness(t, { appServer: { async run(options) {
    const result = facadePlannerResult(options, 'correction-rollback-turn');
    entered.resolve(); await release.promise; return result;
  } } });
  fx.engine.authenticateOwner = () => true;
  fx.engine.ownerCorrectionAuthorized = () => true;
  const pending = fx.engine.run(facadeIntake());
  await entered.promise;
  fx.engine.requestPause('pause-facade-run');
  await pending;
  const controller = fx.engine.controllers.get('pause-facade-run');
  release.resolve();
  await waitFor(() => !controller.cycle, 'planner did not drain');
  const before = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const inventory = fx.db.prepare('SELECT checkpoint_ids_json FROM concurrent_delivery_runs').get();
  const history = fx.db.prepare('SELECT * FROM review_checkpoints ORDER BY checkpoint_id').all();
  const target = failure === 'ack' ? controller.inbox : fx.engine.reviewStore;
  const method = failure === 'register' ? 'registerCheckpoint' : failure === 'supersede' ? 'supersedeCheckpoints' : 'markApplied';
  const original = target[method].bind(target);
  target[method] = (...args) => {
    original(...args);
    throw Object.assign(new Error('injected composition rollback'), { code: 'composition_rollback' });
  };
  const message = ownerCorrectionMessage(before, 'atomic-correction', `sha256:${'b'.repeat(64)}`);
  controller.receive(message);
  await waitFor(() => controller.inbox.get(message.messageId).state === 'blocked', 'failed correction not blocked');
  assert.equal(controller.inbox.get(message.messageId).result.code, 'composition_rollback');
  assert.deepEqual(fx.engine.store.getObjective(projectId, 'engine-objective-1'), before);
  assert.deepEqual(fx.db.prepare('SELECT checkpoint_ids_json FROM concurrent_delivery_runs').get(), inventory);
  assert.deepEqual(fx.db.prepare('SELECT * FROM review_checkpoints ORDER BY checkpoint_id').all(), history);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM review_checkpoint_supersessions').get().n, 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM backlog_owner_corrections').get().n, 0);
  assert.equal(fx.engine.store.events.replay(projectId).filter((event) => ['objective.owner_correction', 'review.checkpoints_superseded'].includes(event.eventType)).length, 0);
});

test('owner correction facade preserves admitted worker contract fences and private terminal report', { timeout: 15000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let plannerCalls = 0;
  let workerCalls = 0;
  const roles = new Map([
    ['engineer', { id: 'engineer', name: 'Engineer', description: 'Writes private work.', sandbox: 'workspace-write', model: 'test-model', effort: 'low', fastMode: 'off' }],
    ['verifier', { id: 'verifier', name: 'Verifier', description: 'Reviews candidates.', sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' }],
  ]);
  const fx = await createHarness(t, { roles, appServer: { async run(options) {
    const threadId = options.threadId || `${options.role.id}-correction-thread`;
    const turnId = `${options.role.id}-correction-${plannerCalls + workerCalls}`;
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    let text;
    if (options.role.id === 'lead') {
      plannerCalls += 1;
      const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      text = JSON.stringify({ expected: prompt.pins, delta: plannerCalls === 1
        ? planDelta(prompt.pins, [engineerTask('engine-objective-1', 'old-contract-worker', 'old-private.txt', 'retain admitted contract')]) : null,
      dialogue: null, recovery: null, ownerDecision: null });
    } else if (options.role.id === 'engineer') {
      workerCalls += 1;
      fs.writeFileSync(path.join(options.cwd, 'old-private.txt'), 'retained old contract output\n');
      entered.resolve(); await release.promise;
      text = JSON.stringify({ outcome: 'completed', summary: 'Old contract completed privately.', filesChanged: ['old-private.txt'],
        filesInspected: ['source.txt'], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
    } else {
      const details = scopedExecutionDetails(options.deliveryCapability);
      assert.equal(details.verifyCandidate(), true);
      execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
      text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nFrozen source checked.', filesChanged: [],
        filesInspected: ['source.txt', 'verify-source.js'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Checked frozen candidate.' }],
        risks: [], scopeExpansion: [], decisionRequest: null });
    }
    return { threadId, turnId, status: 'completed', text,
      execution: { threadId, turnId, processIdentity, turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
  } } });
  fx.engine.authenticateOwner = () => true;
  fx.engine.ownerCorrectionAuthorized = () => true;
  const abort = new AbortController();
  const running = fx.engine.run(facadeIntake(abort.signal));
  t.after(async () => { abort.abort(); await running; });
  await entered.promise;
  const attempt = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.taskId === 'old-contract-worker');
  const claim = fx.engine.store.listClaims(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
  const controller = fx.engine.controllers.get('pause-facade-run');
  const before = fx.engine.store.getObjective(projectId, 'engine-objective-1');
  const message = ownerCorrectionMessage(before, 'worker-correction', `sha256:${'a'.repeat(64)}`);
  controller.receive(message);
  await waitFor(() => controller.inbox.get(message.messageId).state === 'applied', 'worker correction did not apply');
  const held = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
  assert.deepEqual(held.contractSnapshot, attempt.contractSnapshot);
  assert.deepEqual(held.capturedControls, attempt.capturedControls);
  assert.equal(held.fencingToken, attempt.fencingToken);
  assert.deepEqual(fx.engine.store.listClaims(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId), claim);
  fx.engine.requestPause('pause-facade-run');
  assert.equal((await running).pause.kind, 'owner_pause');
  assert.equal(controller.lifecycle.shutdownProjection().safeToRelease, false);
  assert.ok(fx.engine.store.listClaims(projectId, 'engine-objective-1').some((row) => row.attemptId === attempt.attemptId && row.state === 'active'));
  release.resolve();
  await waitFor(() => !fx.engine.roleService.active.size, 'old worker did not drain');
  const resumed = fx.engine.resume({ runId: 'pause-facade-run', signal: abort.signal });
  t.after(async () => { abort.abort(); await resumed; });
  await waitFor(() => fx.engine.executor.getAttempt(attempt.attemptId).state === 'settled', 'old worker result did not settle');
  const settled = fx.engine.store.listAttempts(projectId, 'engine-objective-1').find((row) => row.attemptId === attempt.attemptId);
  assert.equal(settled.outcome.failureKind, 'publication_authorization_changed');
  assert.equal(settled.outcome.publicationState, 'not_published');
  assert.deepEqual(settled.contractSnapshot, attempt.contractSnapshot);
  const execution = fx.engine.roleService.getExecution(attempt.attemptId);
  assert.equal(execution.report.summary, 'Old contract completed privately.');
  assert.equal(fs.readFileSync(path.join(fx.lanes.store.get(execution.laneId).path, 'old-private.txt'), 'utf8'), 'retained old contract output\n');
  assert.equal(fs.existsSync(path.join(fx.workspace, 'old-private.txt')), false);
  assert.equal(workerCalls, 1);
});

test('staged shutdown retains older and newly started provider groups across preparation reopen', async (t) => {
  const older = await fakeTurnProcess(); const newer = await fakeTurnProcess();
  t.after(async () => { await older.stop(); await newer.stop(); });
  const fx = await createHarness(t, { appServer: { processIdentity: () => older.identity, async run() { throw new Error('No provider invocation expected'); } } });
  const first = await fx.engine.prepareShutdown();
  assert.deepEqual(first.identities, [older.identity]); fx.engine.beginProviderShutdown();
  const db = new Database(path.join(fx.storageRoot, 'state.sqlite'));
  const identity = { accountId: 'fake-account', codexHome };
  const admission = new WriterAdmission({ db, workspace: fx.workspace });
  const lanes = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree', lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
  let wrapperClosed = false; let observations = 0;
  const engine = new ConcurrentDeliveryEngine({ db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
    baseUrl: fx.baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token',
    appServer: { ...fx.appServer, processIdentity() { observations += 1; assert.equal(wrapperClosed, false, 'closed wrapper must not be queried'); return newer.identity; } },
    providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead, admission, lanes,
    writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
  t.after(() => db.close());
  await assert.rejects(engine.run({ runId: 'must-remain-fenced', goal: 'Do not resend.' }), { code: 'concurrent_shutdown_admission_closed' });
  const phase = await engine.prepareShutdown();
  assert.deepEqual(phase.identities, [older.identity, newer.identity]);
  engine.beginProviderShutdown(); wrapperClosed = true;
  await engine.prepareShutdown();
  assert.equal(observations, 1, 'only constructor observes the newly reopened provider');
  await older.stop();
  await assert.rejects(engine.finishShutdown(), { code: 'concurrent_shutdown_process_alive' });
  await newer.stop();
  assert.equal((await engine.finishShutdown()).safeToRelease, true);
  assert.equal(JSON.parse(db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'released');
});

for (const blocker of ['none', 'thread-reservation', 'owner-changed']) test(`staged shutdown recovers undispatched review with ${blocker}`, async (t) => {
  let calls = 0;
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    assert.equal(options.role.id, 'lead');
    const threadId = options.threadId;
    const turnId = 'undispatched-review-plan';
    const processIdentity = readProcessIdentity(process.pid);
    options.onTurnStart({ threadId, processIdentity });
    const pins = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins;
    return { threadId, turnId, status: 'completed', text: JSON.stringify({ expected: pins, delta: null,
      dialogue: 'Review the base candidate.', recovery: null, ownerDecision: null }), usage: {}, permissionEvents: [],
      execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, processIdentity, threadId, turnId } };
  } } });
  fx.engine.executor.requestAdapter = () => { throw new Error('Request for Verifier: inputs exceeds the size limit'); };
  const result = await fx.engine.run({ runId: 'undispatched-review-run', goal: 'Review the frozen candidate.',
    contract: { requiredChecks: [] }, engineMapping: { engine: 'concurrent-v1', projectId,
      objectiveId: 'engine-objective-1', sessionId: 'undispatched-review-session' } });
  assert.equal(result.status, 'input_required');
  const before = fx.engine.store.listAttempts(projectId, 'engine-objective-1')[0];
  assert.equal(before.state, 'claimed');
  assert.equal(fx.engine.executor.getAttempt(before.attemptId), null);
  assert.equal(fx.engine.roleService.getExecution(before.attemptId), null);
  const callsBeforeShutdown = calls;
  if (blocker === 'thread-reservation') fx.db.prepare('INSERT INTO task_executor_thread_reservations(transport_key,thread_id,attempt_id) VALUES(?,?,?)')
    .run('unexpected-transport', 'unexpected-thread', before.attemptId);
  if (blocker === 'owner-changed') fx.engine.store.advanceOwnerGeneration(projectId, 'engine-objective-1', 0);
  await fx.engine.prepareShutdown();
  fx.engine.beginProviderShutdown();
  if (blocker === 'none') {
    assert.equal((await fx.engine.finishShutdown()).safeToRelease, true);
    const after = fx.engine.store.listAttempts(projectId, 'engine-objective-1')[0];
    assert.equal(after.state, 'canceled');
    assert.equal(after.outcome.failureKind, 'reconciled_no_effect');
    assert.equal(fx.engine.store.listClaims(projectId, 'engine-objective-1')[0].state, 'released');
    assert.equal(fx.engine.store.getObjective(projectId, 'engine-objective-1').disposition, 'blocked_technical');
    assert.equal((await fx.engine.shutdown({ prepared: true })).safeToRelease, true);
  } else {
    await assert.rejects(fx.engine.finishShutdown(), { code: 'concurrent_shutdown_unsafe' });
    assert.equal(fx.engine.store.listAttempts(projectId, 'engine-objective-1')[0].state, 'claimed');
    assert.equal(fx.engine.store.listClaims(projectId, 'engine-objective-1')[0].state, 'active');
  }
  assert.equal(calls, callsBeforeShutdown);
});

test('staged shutdown drains executor callback promises after scheduler scan has returned', async (t) => {
  const fx = await createHarness(t, { appServer: { async run() { throw new Error('No provider invocation expected'); } } });
  const callback = deferred(); let drained = false;
  const inFlight = new Map([['held-publication-callback', callback.promise]]);
  fx.engine.controllers.set('drain-only-controller', { cycle: null, shutdown() {}, scheduler: { runPromise: null, inFlight } });
  const pending = fx.engine.prepareShutdown().then((result) => { drained = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false);
  assert.equal(JSON.parse(fx.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases').get().phase_json).phase, 'draining');
  inFlight.clear(); callback.resolve(); await pending;
  assert.equal(drained, true);
  fx.engine.controllers.delete('drain-only-controller');
});

for (const mode of ['answer', 'replace', 'replace-drift', 'reopen']) test(`owner decision real engine ${mode} preserves scoped control and authenticated response`, { timeout: 15000 }, async (t) => {
  const { registerDeliveryHostControls } = require('../src/delivery-host-controls');
  const { DeliveryEngineRouter } = require('../src/delivery-engine-router');
  let plannerCalls = 0; let investigationCalls = 0; let verifierCalls = 0; let prepared = 0;
  const abort = new AbortController(); t.after(() => abort.abort());
  const runId = 'owner-run';
  const roles = new Map(['explorer', 'verifier'].map((id) => [id, { id, name: id, description: `Read-only ${id} role.`, model: 'test-model', effort: 'low', fastMode: 'off', sandbox: 'read-only' }]));
  const provider = {
    async prepareThread({ role }) { prepared += 1; return { threadId: `${role.id}-thread`, codexHome }; },
    async execCommand({ command, cwd }) { return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8' }), stderr: '' }; },
    async run(options) {
      const threadId = options.threadId || `${options.role.id}-thread`; const turnId = `${options.role.id}-${plannerCalls}-${verifierCalls}`;
      const processIdentity = readProcessIdentity(process.pid); options.onTurnStart({ threadId, processIdentity });
      let text;
      if (options.role.id === 'lead') {
        plannerCalls += 1;
        const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
        const investigated = prompt.projection.investigationEvidence[0];
        const resolved = prompt.projection.ownerDecisions.some((decision) => decision.state === 'resolved');
        const task = { ...engineerTask(prompt.projection.objectiveId, 'investigate-choice', 'unused', 'Investigate the requirement conflict.'),
          role: 'explorer', kind: 'investigation', productWritePaths: [], scratchWriteRoots: ['.scratch/investigate'] };
        const ownerDecision = investigated && !resolved ? { decisionId: 'required-choice', reason: 'prd_requirement_change',
          question: 'Which requirement should apply?', options: [{ id: 'keep', description: 'Keep current behavior.' }, { id: 'change', description: 'Use an explicit later requirement correction.' }],
          recommendation: 'keep', evidenceRefs: [`attempt:${investigated.attemptId}`], obligations: [{ kind: 'objective_acceptance', id: prompt.projection.objectiveId }] } : null;
        if (resolved) assert.equal(prompt.projection.ownerDecisions.find((decision) => decision.state === 'resolved').response.optionId, 'keep');
        text = JSON.stringify({ expected: prompt.pins, delta: prompt.pins.planRevision === 0 ? planDelta(prompt.pins, [task]) : null,
          dialogue: 'Follow the required owner boundary.', recovery: null, ownerDecision });
      } else {
        if (options.role.id === 'explorer') {
          investigationCalls += 1;
          assert.equal(fs.readFileSync(path.join(options.cwd, 'source.txt'), 'utf8'), 'stable input\n');
        } else {
          verifierCalls += 1;
          const details = scopedExecutionDetails(options.deliveryCapability);
          assert.equal(details.verifyCandidate(), true);
          execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath });
        }
        text = JSON.stringify({ outcome: 'completed', summary: options.role.id === 'verifier' ? 'VERDICT: pass\nRequired check passed.' : 'Investigated requirement conflict; owner must choose.',
          filesChanged: [], filesInspected: ['source.txt'], checks: options.role.id === 'verifier' ? [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against frozen candidate.' }] : [],
          risks: [], scopeExpansion: [], decisionRequest: null });
      }
      return { threadId, turnId, status: 'completed', text, execution: { threadId, turnId, processIdentity,
        turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
    },
  };
  const fx = await createHarness(t, { roles, appServer: provider }); let engine = fx.engine;
  const router = new DeliveryEngineRouter({ db: fx.db, projectId, defaultEngine: 'concurrent-v1',
    concurrentEngine: engine, legacyEngine: { run() { throw new Error('Unexpected legacy invocation'); }, resume() { throw new Error('Unexpected legacy resume'); } } });
  registerDeliveryHostControls(fx.app, { authMiddleware: auth, router });
  let waitTimer;
  const waiting = await Promise.race([router.run({ runId, signal: abort.signal, goal: 'Investigate and respect a mandatory owner decision.',
    contract: { requiredChecks: [{ id: 'source-content', argv: [process.execPath, 'verify-source.js'] }] } }),
    new Promise((_, reject) => { waitTimer = setTimeout(() => reject(new Error(JSON.stringify({ calls: { plannerCalls, investigationCalls, verifierCalls },
      runs: engine.activeRuns(), controllers: [...engine.controllers.values()].map((controller) => controller.status()) }))), 7000); })]).finally(() => clearTimeout(waitTimer));
  // Router derives its own immutable objective/session identities.
  const mapping = router.mapping(runId);
  assert.equal(waiting.status, 'input_required', JSON.stringify(waiting)); assert.equal(waiting.pause.kind, 'owner_decision');
  const realObjectiveId = mapping.objectiveId;
  const status = engine.controlStatus(runId); const pending = status.ownerDecisions.find((decision) => decision.state === 'pending');
  assert.ok(pending); assert.equal(investigationCalls, 1); assert.equal(verifierCalls, 0);
  const callsAtWait = plannerCalls; const preparedAtWait = prepared;
  assert.equal((await engine.resume({ runId })).pause.decision.digest, pending.digest);
  assert.equal(plannerCalls, callsAtWait); assert.equal(prepared, preparedAtWait);
  assert.deepEqual(engine.store.claimReady(projectId, realObjectiveId, 0, { controlRevision: status.decisionReplyPins.expectedControlRevision }), []);
  const request = { runId, projectId, sessionId: mapping.sessionId, objectiveId: realObjectiveId, messageId: 'reply-choice',
    decisionId: pending.request.decisionId, requestDigest: pending.digest, optionId: 'keep', ...status.decisionReplyPins };
  const post = async (suffix, body, token = 'concurrent-test-token') => {
    const response = await fetch(`${fx.baseUrl}/control/delivery/${runId}/${suffix}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post('decision', request, 'wrong')).status, 401);
  assert.equal((await post('decision', { ...request, expectedOwnerGeneration: 99 })).status, 409);
  assert.equal((await post('decision', { ...request, optionId: 'invented' })).status, 400);
  if (mode.startsWith('replace')) {
    const attemptBefore = engine.store.listAttempts(projectId, realObjectiveId)[0];
    engine.store.ownerCorrectionAuthorized = () => true;
    engine.store.applyOwnerCorrection(projectId, realObjectiveId, { sourceMessageId: 'changed-requirement', expectedGoalRevision: 1,
      expectedAuthorityRevision: 1, expectedControlRevision: request.expectedControlRevision, requirementDigest: `sha256:${'c'.repeat(64)}` });
    const currentPins = engine.store.ownerDecisionPins(projectId, realObjectiveId);
    assert.equal((await post('decision', { ...request, ...currentPins })).status, 409);
    const { requestDigest, optionId, ...scope } = request;
    const replacement = { ...scope, ...currentPins, messageId: 'replace-choice', oldRequestDigest: requestDigest,
      replacement: { ...pending.request, question: 'Revalidated requirement choice under corrected requirements.' } };
    if (mode === 'replace-drift') {
      fs.writeFileSync(path.join(fx.workspace, 'source.txt'), 'unaccepted drift\n');
      assert.equal((await post('decision/replace', replacement)).status, 400);
      assert.equal(engine.store.pendingOwnerDecision(projectId, realObjectiveId).digest, pending.digest);
      assert.equal(plannerCalls, callsAtWait); assert.equal(verifierCalls, 0); return;
    }
    const changed = await post('decision/replace', replacement);
    assert.equal(changed.status, 200, JSON.stringify(changed));
    assert.equal(changed.body.decision.revalidations[0].originalControls.goalRevision, 1);
    assert.deepEqual(engine.store.listAttempts(projectId, realObjectiveId)[0], attemptBefore);
    assert.equal((await post('decision/replace', replacement)).body.duplicate, true);
    assert.equal((await post('decision', { ...request, ...changed.body.pins })).status, 409);
    request.requestDigest = changed.body.decision.digest; Object.assign(request, changed.body.pins);
  }
  if (mode === 'reopen') {
    await engine.shutdown();
    const reopened = new ConcurrentDeliveryEngine({ db: fx.db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
      baseUrl: fx.baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer: fx.appServer,
      providerIdentity: { accountId: 'fake-account', codexHome }, providerIdentityFor: () => ({ accountId: 'fake-account', codexHome }),
      roles: fx.roles, leadRole: fx.lead, admission: fx.admission, lanes: fx.lanes, writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
    engine = reopened; router.concurrentEngine = reopened;
    assert.equal((await reopened.resume({ runId })).pause.decision.digest, pending.digest);
    assert.equal(plannerCalls, callsAtWait); assert.equal(prepared, preparedAtWait);
  }
  const answer = await post('decision', request); assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal((await post('decision', request)).body.duplicate, true);
  assert.equal((await post('decision', { ...request, optionId: 'change' })).status, 409);
  if (mode === 'replace' || mode === 'reopen') {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(engine.store.pendingOwnerDecision(projectId, realObjectiveId), null);
    assert.equal(engine.store.getObjective(projectId, realObjectiveId).disposition, 'executing');
    assert.equal(engine.store.listFinalizations(projectId, realObjectiveId).length, 0);
    assert.equal(verifierCalls, 0);
    await engine.shutdown();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const accepted = await engine.resume({ runId });
  assert.equal(accepted.disposition, 'accepted', JSON.stringify(accepted));
  assert.equal(investigationCalls, 1); assert.ok(verifierCalls > 0);
  const proof = fx.db.prepare('SELECT result_json FROM concurrent_finalization_check_proofs').get();
  assert.equal(JSON.parse(proof.result_json).checkResults[0].result, 'passed');
  await engine.shutdown();
});
