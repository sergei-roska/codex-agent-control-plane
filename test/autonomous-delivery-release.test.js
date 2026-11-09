'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { readProcessIdentity } = require('../src/process-quiescence');
const { createProviderIdentityPin } = require('../src/delivery-provider-identity');

function waitFor(predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(typeof message === 'function' ? message() : message));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('AD-08 deterministic release fails over, waits across reopen, and accepts the same objective', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-delivery-release-'));
  const workspace = path.join(root, 'workspace');
  const homeA = path.join(root, 'account-a');
  const homeB = path.join(root, 'account-b');
  const accountsDir = path.join(root, 'accounts');
  const settingsFile = path.join(root, 'settings.json');
  const roleOverridesFile = path.join(root, 'roles.json');
  const stateFile = path.join(root, 'state.sqlite');
  const limits = new Map([[homeA, false], [homeB, true]]);
  const previousCodexHome = process.env.CODEX_HOME;
  const runtimes = [];
  let runtime;
  let runPromise;
  let runSettled = false;
  let runId = 'ad08-release-run';
  let expectedObjectiveId;
  let taskSequence = 0;
  let failedTaskId = null;
  const workerCalls = [];
  const coordinatorCalls = [];
  const verifierCalls = [];
  const plannerOutputs = [];
  const plannerFailures = [];
  const identityAt = (home) => ({ accountId: JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens.account_id, codexHome: home });
  const accountHashAt = (home) => createProviderIdentityPin(home).providerIdentity.accountId;
  const currentObjective = () => {
    const mapping = runtime.orchestrator.mapping(runId);
    return mapping && runtime.concurrentEngine.store.getObjective(runtime.projectId, mapping.objectiveId);
  };
  const currentCheckIdentity = () => runtime.concurrentEngine.db.prepare(
    'SELECT check_identity FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(runtime.projectId, runId)?.check_identity;
  fs.mkdirSync(workspace, { recursive: true });
  for (const [home, account] of [[homeA, 'ad08-account-a'], [homeB, 'ad08-account-b']]) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: account, access_token: 'fixture-only' } }));
  }
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Release Fixture');
  git('config', 'user.email', 'release@example.invalid');
  fs.writeFileSync(path.join(workspace, 'release.txt'), 'pending\n');
  fs.writeFileSync(path.join(workspace, 'verify-release.js'), "'use strict';\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nassert.equal(fs.readFileSync('release.txt', 'utf8'), 'released\\n');\n");
  git('add', '.');
  git('commit', '-qm', 'fixture');
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(path.join(accountsDir, 'profiles.json'), JSON.stringify({ version: 1, active: 'a', selectionRevision: 1,
    autoSwitch: true, profiles: [{ name: 'a', home: homeA }, { name: 'b', home: homeB }] }));
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
  fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: Object.fromEntries(
    ['coordinator', 'engineer', 'verifier'].map((id) => [id, { model: 'test-model', effort: 'low', fastMode: 'off' }])) }));

  const appServerFactory = (home) => {
    const codexHome = home || homeA;
    let threadCount = 0;
    return {
      async start() {}, async close() {}, getCodexHome: () => codexHome,
      async getAccount() { return { account: { type: 'chatgpt' }, requiresOpenaiAuth: false }; },
      async readRateLimits() { return { ordinaryUsageAllowed: limits.get(codexHome) === true }; },
      getVersion: () => 'ad08-offline/1', processIdentity: () => null,
      resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
      async prepareThread({ role }) { threadCount += 1; return { threadId: `${role.id}-${path.basename(codexHome)}-${threadCount}`, codexHome }; },
      async prepareThreadForTransition(_token, options) { return this.prepareThread(options); },
      async execCommand({ command, cwd }) {
        try { return { exitCode: 0, stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }; }
        catch (cause) { return { exitCode: cause.status || 1, stdout: String(cause.stdout || ''), stderr: String(cause.stderr || '') }; }
      },
      async run(options) {
        const role = options.role.id || options.role.name;
        const threadId = options.threadId || `${role}-${path.basename(codexHome)}-thread`;
        const turnId = `ad08-${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        if (role === 'verifier') verifierCalls.push({ account: identityAt(codexHome).accountId, threadId });
        const processIdentity = readProcessIdentity(process.pid);
        options.onTurnStart({ threadId, processIdentity });
        if (role === 'coordinator') {
          try {
          coordinatorCalls.push({ account: identityAt(codexHome).accountId, threadId });
          const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
          const failedTask = failedTaskId ? { taskId: failedTaskId, revision: 1 } : null;
          const delta = taskSequence > 0 && !failedTask ? null : {
            schemaVersion: 'delivery/v1', expectedPlanRevision: prompt.pins.planRevision,
            expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
            expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
            tasks: [{ ...(failedTask ? { expectedRevision: failedTask.revision } : {}), task: { schemaVersion: 'delivery/v1', projectId: runtime.projectId, objectiveId: expectedObjectiveId,
              taskId: `release-${++taskSequence}`, revision: 1, role: 'engineer', kind: 'implementation', ...(failedTask ? { supersedesTaskId: failedTask.taskId } : {}),
              objective: 'Complete the release artifact.', priority: 1, dependencies: [], productWritePaths: ['release.txt'],
              readScope: { kind: 'known', paths: ['release.txt'] }, scratchWriteRoots: ['.scratch/release'], resourceClaims: [],
              publicationAuthority: { state: 'unknown' }, state: 'queued' } }], dependencies: [],
          };
          const text = JSON.stringify({ expected: prompt.pins, delta, dialogue: 'Continue the pinned release objective.', recovery: null, ownerDecision: null });
          plannerOutputs.push({ account: identityAt(codexHome).accountId, planRevision: prompt.pins.planRevision, delta });
          return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
            execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
          } catch (cause) {
            plannerFailures.push({ message: String(cause.message || cause), stack: String(cause.stack || '') });
            throw cause;
          }
        }
        if (role === 'engineer') {
          workerCalls.push({ account: identityAt(codexHome).accountId, objectiveId: expectedObjectiveId, threadId });
          if (codexHome === homeB && workerCalls.filter((call) => call.account === 'ad08-account-b').length === 1) limits.set(homeB, false);
          if (limits.get(codexHome) === false) {
            failedTaskId = `release-${taskSequence}`;
            const cause = Object.assign(new Error(`typed usage limit at ${path.basename(codexHome)}`), {
              code: 'provider_error', threadId, turnId,
              codexError: { codexErrorInfo: { usageLimitExceeded: { httpStatusCode: 429 } } },
              execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId },
            });
            throw cause;
          }
          failedTaskId = null;
          fs.writeFileSync(path.join(options.cwd, 'release.txt'), 'released\n');
          const text = JSON.stringify({ outcome: 'completed', summary: 'Published the release artifact.', filesChanged: ['release.txt'],
            filesInspected: ['release.txt'], checks: [{ command: 'write release artifact', result: 'passed', detail: 'Wrote the required artifact.' }],
            risks: [], scopeExpansion: [], decisionRequest: null });
          return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
            execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
        }
        if (role === 'verifier') {
          const text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nThe current release candidate passed the required check.',
            filesChanged: [], filesInspected: ['release.txt'], checks: [{ command: 'verify-release.js', result: 'passed', detail: 'Verified the current candidate.' }],
            risks: [], scopeExpansion: [], decisionRequest: null });
          return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
            execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true, processIdentity, threadId, turnId } };
        }
        throw new Error(`Unexpected fake provider role ${role}`);
      },
    };
  };
  const options = { listen: true, port: 0, workspace, accountsDir, stateFile, tokenFile: path.join(root, 'token'),
    workspaceLockDir: path.join(root, 'workspace-locks'), deliveryStorageRoot: path.join(root, 'delivery-storage'),
    projectSettingsFile: settingsFile, roleOverridesFile, autoResume: false, appServerFactory,
    readProfileState: async (home) => ({ requiresOpenaiAuth: false, limits: { ordinaryUsageAllowed: limits.get(home) === true } }),
  };
  t.after(async () => {
    for (const active of runtimes.reverse()) {
      try { active.concurrentEngine?.controllers.get(runId)?.shutdown({ pause: false }); } catch (_) {}
      try { await active.close(); } catch (_) {
        active.httpServer?.closeAllConnections?.();
        if (active.httpServer?.listening) await new Promise((resolve) => active.httpServer.close(resolve));
        await active.appServer.close?.();
        if (active.state.db.open) await active.state.close();
      }
    }
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = homeA;

  runtime = await startServer(options);
  runtimes.push(runtime);
  expectedObjectiveId = runtime.orchestrator.objectiveIdFor(runId);
  const contract = { requiredChecks: [{ id: 'release-artifact', argv: [process.execPath, 'verify-release.js'], timeoutMs: 5000 }] };
  runPromise = runtime.orchestrator.run({ runId, goal: 'Release the verified artifact using the same objective across account recovery.', contract });
  runPromise.then(() => { runSettled = true; }, () => { runSettled = true; });
  const mappingBefore = await waitFor(() => runtime.orchestrator.mapping(runId), 'router did not create the stable run mapping').then(() => runtime.orchestrator.mapping(runId));
  const objectiveId = mappingBefore.objectiveId;
  const sessionId = mappingBefore.sessionId;
  await waitFor(() => workerCalls.some((call) => call.account === 'ad08-account-b'),
    () => JSON.stringify({ message: 'account A exhaustion did not rebind to B', coordinatorCalls, workerCalls,
      objective: currentObjective(), profiles: runtime.accountProfiles.read(), controller: runtime.concurrentEngine.controllers.get(runId)?.status() }));
  assert.equal(runtime.accountProfiles.read().active, 'b');
  const checkIdentity = currentCheckIdentity();
  assert.ok(coordinatorCalls.some((call) => call.account === 'ad08-account-b' && call.threadId));
  await waitFor(() => runtime.concurrentEngine.store.listBudgetWaits(runtime.projectId, objectiveId).some((wait) => wait.state === 'waiting'),
    () => JSON.stringify({ message: 'account B exhaustion did not create a durable wait', workerCalls, objective: currentObjective() }));
  assert.deepEqual(workerCalls.slice(0, 2).map((call) => call.account), ['ad08-account-a', 'ad08-account-b']);
  assert.notEqual(workerCalls[0].threadId, workerCalls[1].threadId);
  assert.equal(runSettled, false, 'budget waits must not request owner continuation');
  assert.equal(runtime.concurrentEngine.store.pendingOwnerDecision(runtime.projectId, objectiveId), null);
  const waitingObjective = runtime.concurrentEngine.store.getObjective(runtime.projectId, objectiveId);
  assert.equal(waitingObjective.disposition, 'waiting_budget');
  assert.equal(currentCheckIdentity(), checkIdentity);
  let waits = runtime.concurrentEngine.store.listBudgetWaits(runtime.projectId, objectiveId);
  assert.equal(waits.length, 2);
  assert.deepEqual(waits.map((wait) => wait.state).sort(), ['waiting', 'woken']);
  assert.ok(waits.find((wait) => wait.state === 'waiting').blockers
    .some((blocker) => blocker.accountIdHash === `sha256:${accountHashAt(homeB)}`));
  let attempts = runtime.concurrentEngine.store.listAttempts(runtime.projectId, objectiveId);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.outcome.failureKind), ['usage_limit', 'usage_limit']);
  const executionA = runtime.concurrentEngine.roleService.getExecution(attempts.find((attempt) => attempt.taskId === 'release-1').attemptId);
  const executionB = runtime.concurrentEngine.roleService.getExecution(attempts.find((attempt) => attempt.taskId === 'release-2').attemptId);
  assert.equal(executionA.providerIdentity.accountId, accountHashAt(homeA));
  assert.equal(executionB.providerIdentity.accountId, accountHashAt(homeB));
  assert.equal(executionA.providerThreadId, workerCalls[0].threadId);
  assert.equal(executionB.providerThreadId, workerCalls[1].threadId);
  assert.equal(executionA.effectsSettled, true);
  assert.equal(executionB.effectsSettled, true);
  const bWait = waits.find((wait) => wait.state === 'waiting');
  await runtime.close();
  runtimes.pop();
  await waitFor(() => Date.now() >= bWait.nextWakeAt, 'B wait did not become due before restart', 3000);
  limits.set(homeB, true);

  runtime = await startServer(options);
  runtimes.push(runtime);
  await waitFor(() => runtime.concurrentEngine.store.getObjective(runtime.projectId, objectiveId)?.disposition === 'accepted',
    () => JSON.stringify({ message: 'reopened server did not accept the same objective', workerCalls, coordinatorCalls,
      objective: runtime.concurrentEngine.store.getObjective(runtime.projectId, objectiveId), waits: runtime.concurrentEngine.store.listBudgetWaits(runtime.projectId, objectiveId),
      mapping: runtime.orchestrator.mapping(runId), plannerOutputs, plannerFailures, verifierCalls,
      finalizations: runtime.concurrentEngine.store.listFinalizations(runtime.projectId, objectiveId),
      candidates: runtime.state.db.prepare('SELECT candidate_id,integration_generation,status FROM concurrent_candidates WHERE project_id=? AND objective_id=?').all(runtime.projectId, objectiveId),
      finalizationProjection: (() => {
        const candidate = runtime.state.db.prepare(`SELECT candidate_id FROM concurrent_candidates
          WHERE project_id=? AND objective_id=? AND status='known' ORDER BY integration_generation DESC,candidate_id DESC LIMIT 1`)
          .get(runtime.projectId, objectiveId);
        return candidate ? runtime.concurrentEngine.reviewStore.finalizationProjection({ projectId: runtime.projectId,
          objectiveId, candidateId: candidate.candidate_id, requiredRoles: ['verifier'] }) : null;
      })(),
      runDigest: runtime.concurrentEngine.getRunDigest(runId),
      pause: runtime.concurrentEngine.getPause(runId),
      activeDrivers: [...runtime.concurrentEngine.runDrivers.entries()].map(([id, driver]) => ({ id, background: driver.background })),
      controller: runtime.concurrentEngine.controllers.get(runId)?.status() }), 10000);
  const mappingAfter = runtime.orchestrator.mapping(runId);
  const acceptedObjective = runtime.concurrentEngine.store.getObjective(runtime.projectId, objectiveId);
  assert.equal(mappingAfter.engine, 'concurrent-v1');
  assert.equal(mappingAfter.objectiveId, objectiveId);
  assert.equal(mappingAfter.sessionId, sessionId);
  assert.equal(acceptedObjective.disposition, 'accepted');
  assert.equal(currentCheckIdentity(), checkIdentity);
  assert.equal(runtime.concurrentEngine.store.pendingOwnerDecision(runtime.projectId, objectiveId), null);
  assert.deepEqual(workerCalls.map((call) => call.account), ['ad08-account-a', 'ad08-account-b', 'ad08-account-b']);
  assert.equal(new Set(workerCalls.map((call) => call.threadId)).size, 2);
  assert.notEqual(workerCalls[0].threadId, workerCalls[1].threadId, 'the A-to-B transfer uses a fresh provider thread');
  assert.equal(workerCalls[1].threadId, workerCalls[2].threadId, 'the same B-bound role thread is traceable across its budget wait');

  attempts = runtime.concurrentEngine.store.listAttempts(runtime.projectId, objectiveId);
  assert.equal(attempts.length, 4, 'three implementation attempts and one verifier attempt are durably recorded');
  assert.equal(new Set(attempts.map((attempt) => attempt.attemptId)).size, 4);
  const releaseAttempts = attempts.filter((attempt) => /^release-\d+$/.test(attempt.taskId));
  const verifierAttempts = attempts.filter((attempt) => attempt.taskId.startsWith('review-'));
  assert.equal(releaseAttempts.length, 3);
  assert.equal(verifierAttempts.length, 1);
  assert.deepEqual(releaseAttempts.map((attempt) => attempt.state), ['failed', 'failed', 'succeeded']);
  assert.deepEqual(releaseAttempts.map((attempt) => attempt.outcome.failureKind), ['usage_limit', 'usage_limit', undefined]);
  const executions = attempts.map((attempt) => runtime.concurrentEngine.roleService.getExecution(attempt.attemptId));
  const releaseExecutions = releaseAttempts.map((attempt) => runtime.concurrentEngine.roleService.getExecution(attempt.attemptId));
  assert.deepEqual(releaseExecutions.map((execution) => execution.providerIdentity.accountId),
    [accountHashAt(homeA), accountHashAt(homeB), accountHashAt(homeB)]);
  assert.deepEqual(releaseExecutions.map((execution) => execution.providerThreadId), workerCalls.map((call) => call.threadId));
  assert.ok(executions.every((execution) => execution.effectsSettled === true));
  const candidateIntents = runtime.state.db.prepare('SELECT attempt_id,state FROM candidate_intents WHERE project_id=? AND objective_id=?')
    .all(runtime.projectId, objectiveId);
  assert.equal(candidateIntents.length, 1, 'only the successful attempt publishes a candidate');
  assert.equal(candidateIntents[0].attempt_id, releaseAttempts[2].attemptId);
  assert.equal(candidateIntents[0].state, 'applied');
  const finalizations = runtime.concurrentEngine.store.listFinalizations(runtime.projectId, objectiveId);
  assert.equal(finalizations.length, 1);
  assert.equal(finalizations[0].state, 'accepted');
  assert.equal(finalizations[0].pins.candidate.checkIdentity, checkIdentity);
  assert.equal(finalizations[0].checkResult.checkResults.find((check) => check.id === 'release-artifact').result, 'passed');

  waits = runtime.concurrentEngine.store.listBudgetWaits(runtime.projectId, objectiveId);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((wait) => wait.state === 'woken'));
  const events = runtime.concurrentEngine.store.events.replay(runtime.projectId, { after: 0, limit: 500 });
  assert.equal(events.filter((event) => event.eventType === 'objective.waiting_budget').length, 2);
  assert.equal(events.filter((event) => event.eventType === 'objective.budget_woken').length, 2);
  assert.equal(events.filter((event) => event.eventType === 'attempt.failed').length, 2);
  const succeededEvents = events.filter((event) => event.eventType === 'attempt.succeeded');
  assert.equal(succeededEvents.length, 2);
  assert.deepEqual(succeededEvents.map((event) => event.taskId).sort(),
    [releaseAttempts[2].taskId, verifierAttempts[0].taskId].sort());
  assert.equal(events.filter((event) => event.eventType === 'objective.accepted').length, 1);
  const providerRebinds = events.filter((event) => event.eventType === 'planner.provider_rebound'
    && event.payload?.objectiveId === objectiveId && event.payload?.runId === runId);
  assert.ok(providerRebinds.length >= 1);
  assert.ok(providerRebinds.every((event) => event.objectRevision === event.payload.controlRevision + 1),
    'provider rebind lineage must carry the accepted control revision successor');
  assert.equal(runtime.concurrentEngine.getRunDigest(runId).disposition, 'accepted');
});
