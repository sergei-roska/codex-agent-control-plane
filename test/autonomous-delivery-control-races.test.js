'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { readProcessIdentity } = require('../src/process-quiescence');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function waitFor(predicate, message, timeoutMs = 10000) {
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

test('authenticated pause and cancel win against concurrent automatic budget eligibility', { timeout: 40000 }, async (t) => {
  for (const action of ['pause', 'cancel']) {
    await t.test(`${action} remains durable while the budget transition eligibility read is held`, { timeout: 18000 }, async (st) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `delivery-control-race-${action}-`));
      const workspace = path.join(root, 'workspace');
      const homeA = path.join(root, 'account-a');
      const homeB = path.join(root, 'account-b');
      const accountsDir = path.join(root, 'accounts');
      const settingsFile = path.join(root, 'settings.json');
      const roleOverridesFile = path.join(root, 'roles.json');
      const tokenFile = path.join(root, 'token');
      const limits = new Map([[homeA, false], [homeB, true]]);
      const eligibilityEntered = deferred();
      const releaseEligibility = deferred();
      const workerCalls = [];
      const coordinatorCalls = [];
      const switchCalls = [];
      const previousCodexHome = process.env.CODEX_HOME;
      let holdEligibility = false;
      let eligibilityInFlight = 0;
      let runtime;
      let runPromise;
      const runId = `control-race-${action}`;
      let objectiveId;

      fs.mkdirSync(workspace, { recursive: true });
      for (const [home, account] of [[homeA, 'control-race-account-a'], [homeB, 'control-race-account-b']]) {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: account, access_token: 'fixture-only' } }));
      }
      const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.name', 'Control Race Fixture');
      git('config', 'user.email', 'control-race@example.invalid');
      fs.writeFileSync(path.join(workspace, 'source.txt'), 'fixture input\n');
      git('add', '.');
      git('commit', '-qm', 'fixture');
      fs.mkdirSync(accountsDir, { recursive: true });
      fs.writeFileSync(path.join(accountsDir, 'profiles.json'), JSON.stringify({ version: 1, active: 'a', selectionRevision: 1,
        autoSwitch: true, profiles: [{ name: 'a', home: homeA }, { name: 'b', home: homeB }] }));
      fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit', deliveryEngine: 'concurrent-v1' }));
      fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: Object.fromEntries(
        ['coordinator', 'engineer', 'verifier'].map((id) => [id, { model: 'control-race-model', effort: 'low', fastMode: 'off' }])) }));

      const appServerFactory = (home) => {
        const codexHome = home || homeA;
        return {
          async start() {}, async close() {}, getCodexHome: () => codexHome,
          getVersion: () => 'control-race-offline/1',
          processIdentity() { return null; },
          async getAccount() { return { account: { type: 'chatgpt' }, requiresOpenaiAuth: false }; },
          async readRateLimits() { return { ordinaryUsageAllowed: limits.get(codexHome) === true }; },
          resolveExecutionPermissions: async () => ({ mode: 'inherit', writerProfile: ':danger-full-access', sandboxMode: 'danger-full-access' }),
          async prepareThread({ role }) { return { threadId: `${role.id || role.name}-${path.basename(codexHome)}-thread`, codexHome }; },
          async prepareThreadForTransition(_token, { role }) {
            return { threadId: `${role.id || role.name}-${path.basename(codexHome)}-transition-thread`, codexHome };
          },
          async run(options) {
            const role = options.role.id || options.role.name;
            const threadId = options.threadId || `${role}-${path.basename(codexHome)}-thread`;
            const turnId = `control-race-${role}-${workerCalls.length + coordinatorCalls.length + 1}`;
            const processIdentity = readProcessIdentity(process.pid);
            options.onTurnStart({ threadId, processIdentity });
            if (role === 'coordinator') {
              coordinatorCalls.push({ account: path.basename(codexHome), threadId });
              const prompt = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
              const task = { schemaVersion: 'delivery/v1', projectId: runtime.projectId, objectiveId,
                taskId: 'control-race-worker', revision: 1, role: 'engineer', kind: 'implementation',
                objective: 'Reach a trusted usage-limit wait for the owner-control race.', priority: 1, dependencies: [],
                productWritePaths: ['source.txt'], readScope: { kind: 'known', paths: ['source.txt'] },
                scratchWriteRoots: ['.scratch/control-race'], resourceClaims: [],
                publicationAuthority: { state: 'unknown' }, state: 'queued' };
              const delta = coordinatorCalls.length === 1 ? { schemaVersion: 'delivery/v1',
                expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision,
                expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision,
                nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task }], dependencies: [] } : null;
              return { threadId, turnId, status: 'completed',
                text: JSON.stringify({ expected: prompt.pins, delta, dialogue: 'Keep the existing scoped objective.', recovery: null, ownerDecision: null }),
                usage: {}, permissionEvents: [], execution: { threadId, turnId, processIdentity,
                  turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true } };
            }
            if (role === 'engineer') {
              workerCalls.push({ account: path.basename(codexHome), threadId });
              const cause = Object.assign(new Error('fixture typed usage limit'), {
                code: 'provider_error', threadId, turnId,
                codexError: { codexErrorInfo: { usageLimitExceeded: { httpStatusCode: 429 } } },
                execution: { threadId, turnId, processIdentity, turnStartSent: true,
                  turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true },
              });
              throw cause;
            }
            throw new Error(`Unexpected fake provider role ${role}`);
          },
        };
      };

      const options = { listen: true, port: 0, workspace, accountsDir, stateFile: path.join(root, 'state.sqlite'),
        tokenFile, workspaceLockDir: path.join(root, 'workspace-locks'), deliveryStorageRoot: path.join(root, 'delivery-storage'),
        projectSettingsFile: settingsFile, roleOverridesFile, autoResume: false, appServerFactory,
        readProfileState: async (home) => {
          if (home === homeB && holdEligibility) {
            eligibilityInFlight += 1;
            eligibilityEntered.resolve();
            try { await releaseEligibility.promise; }
            finally { eligibilityInFlight -= 1; }
          }
          return { requiresOpenaiAuth: false, limits: { ordinaryUsageAllowed: limits.get(home) === true } };
        },
      };

      st.after(async () => {
        releaseEligibility.resolve();
        if (runtime) {
          try { await runtime.close(); }
          catch (_) {
            runtime.httpServer?.closeAllConnections?.();
            if (runtime.httpServer?.listening) await new Promise((resolve) => runtime.httpServer.close(resolve));
            await runtime.appServer.close?.();
            if (runtime.state.db.open) await runtime.state.close();
          }
        }
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        fs.rmSync(root, { recursive: true, force: true });
      });

      process.env.CODEX_HOME = homeA;
      runtime = await startServer(options);
      objectiveId = runtime.orchestrator.objectiveIdFor(runId);
      runtime.concurrentEngine.budgetWaitBackoffMs = 2000;
      const originalSwitchTo = runtime.switchingAppServer.switchTo.bind(runtime.switchingAppServer);
      runtime.switchingAppServer.switchTo = async (...args) => {
        switchCalls.push(args[0]);
        return originalSwitchTo(...args);
      };
      runPromise = runtime.orchestrator.run({ runId, goal: 'Preserve the owner control if budget eligibility completes late.',
        contract: { requiredChecks: [] } });
      runPromise.catch(() => {});
      await waitFor(() => runtime.concurrentEngine.store.listBudgetWaits(runtime.projectId, objectiveId)
        .some((wait) => wait.state === 'waiting'), 'typed A usage limit did not create a durable budget wait');

      holdEligibility = true;
      await waitFor(() => eligibilityInFlight > 0, 'automatic budget processing did not enter the deferred B availability read');
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      const baseUrl = `http://127.0.0.1:${runtime.port}`;
      const headers = { authorization: `Bearer ${token}` };
      const unauthorized = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}`);
      assert.equal(unauthorized.status, 401);
      await unauthorized.text();
      const statusResponse = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}`, { headers });
      assert.equal(statusResponse.status, 200);
      const before = await statusResponse.json();
      assert.equal(before.projectId, runtime.projectId);
      assert.equal(before.objectiveId, objectiveId);
      assert.equal(before.disposition, 'waiting_budget');

      const body = { runId, projectId: before.projectId, sessionId: before.sessionId, objectiveId: before.objectiveId,
        expectedControlRevision: before.revisions.controlRevision };
      const controlResponse = await fetch(`${baseUrl}/control/delivery/${encodeURIComponent(runId)}/${action}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(controlResponse.status, 200);
      const acknowledgement = await controlResponse.json();
      assert.equal(acknowledgement.action, action);
      assert.equal(acknowledgement.acknowledged, true);
      assert.equal(acknowledgement.runId, runId);
      assert.equal(acknowledgement.objectiveId, objectiveId);
      assert.ok(acknowledgement.revisions.controlRevision > before.revisions.controlRevision);
      assert.equal(acknowledgement.disposition, action === 'pause' ? 'paused_owner' : acknowledgement.disposition);
      if (action === 'cancel') assert.ok(['draining', 'canceled'].includes(acknowledgement.disposition));

      holdEligibility = false;
      releaseEligibility.resolve();
      await waitFor(() => eligibilityInFlight === 0, 'deferred budget eligibility did not settle');
      if (action === 'cancel') await waitFor(() => runtime.concurrentEngine.getRunDigest(runId)?.disposition === 'canceled',
        () => JSON.stringify({ action, acknowledgement, status: runtime.concurrentEngine.controlStatus(runId),
          attempts: runtime.concurrentEngine.store.listAttempts(runtime.projectId, objectiveId) }));
      else await waitFor(() => runtime.concurrentEngine.controlStatus(runId)?.disposition === 'paused_owner',
        'owner pause was not retained');

      const after = runtime.concurrentEngine.controlStatus(runId);
      const objective = runtime.concurrentEngine.store.getObjective(runtime.projectId, objectiveId);
      const waits = runtime.concurrentEngine.store.listBudgetWaits(runtime.projectId, objectiveId);
      const attempts = runtime.concurrentEngine.store.listAttempts(runtime.projectId, objectiveId);
      assert.equal(after.disposition, action === 'pause' ? 'paused_owner' : 'canceled');
      assert.equal(after.revisions.controlRevision, acknowledgement.revisions.controlRevision);
      assert.equal(objective.disposition, after.disposition);
      assert.equal(waits.length, 1);
      assert.equal(waits[0].state, 'waiting');
      assert.equal(runtime.accountProfiles.read().active, 'a');
      assert.deepEqual(switchCalls, []);
      assert.equal(workerCalls.length, 1);
      assert.deepEqual(workerCalls.map((call) => call.account), ['account-a']);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].state, 'failed');
      assert.equal(attempts[0].outcome.failureKind, 'usage_limit');
      assert.equal(attempts[0].effect.effectsSettled, true);
      assert.equal(runtime.concurrentEngine.providerTransitions.get(runtime.projectId), null);
      const events = runtime.concurrentEngine.store.events.replay(runtime.projectId, { after: 0, limit: 500 });
      assert.equal(events.filter((event) => event.eventType === 'objective.budget_woken').length, 0);
      assert.equal(coordinatorCalls.length, 1);
    });
  }
});
