'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const filename = path.join(root, 'test/concurrent-delivery-engine.test.js');
const helper = new Module(filename, module);
helper.filename = filename;
helper.paths = Module._nodeModulePaths(path.dirname(filename));
const prefix = fs.readFileSync(filename, 'utf8').split("test('cooperative writer mode")[0];
helper._compile(`${prefix}\nmodule.exports = { createHarness, waitFor, deferred, projectId, codexHome, Database, ConcurrentDeliveryEngine, WriterAdmission, LaneManager };`, filename);
const { createHarness, waitFor, deferred, projectId, Database, ConcurrentDeliveryEngine, WriterAdmission, LaneManager, codexHome } = helper.exports;
const { readProcessIdentity } = require(path.join(root, 'src/process-quiescence'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function intake(signal) {
  return { runId: 'facade-probe', goal: 'Probe durable facade.', contract: { requiredChecks: [] }, signal,
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'engine-objective-1', sessionId: 'facade-session' } };
}
function result(options) {
  const threadId = options.threadId;
  const processIdentity = readProcessIdentity(process.pid);
  options.onTurnStart({ threadId, processIdentity });
  return { threadId, turnId: 'lead-probe-turn', status: 'completed',
    text: JSON.stringify({ expected: JSON.parse(options.input.split('\n').slice(1).join('\n')).pins,
      delta: null, dialogue: null, recovery: null, ownerDecision: null }),
    execution: { threadId, turnId: 'lead-probe-turn', processIdentity,
      turnStartSent: true, turnStartRejected: false, turnTerminal: true } };
}
test('scratch pause and resume facade observation', async (t) => {
  const entered = deferred(); const release = deferred();
  const { engine } = await createHarness(t, { appServer: { async run(options) {
    entered.resolve(); await release.promise; return result(options);
  } } });
  const abort = new AbortController(); let settled = false;
  const pending = engine.run(intake(abort.signal)).finally(() => { settled = true; });
  await entered.promise;
  assert.equal(engine.requestPause('facade-probe'), true);
  release.resolve();
  await delay(150);
  const paused = engine.controlStatus('facade-probe');
  t.diagnostic(JSON.stringify({ phase: 'paused', disposition: paused.disposition, facadeSettled: settled,
    pause: engine.getPause('facade-probe') }));
  assert.equal(paused.disposition, 'paused_owner');
  assert.equal(settled, false, 'current facade remains pending instead of returning paused result');
  let resumedSettled = false;
  const resumed = engine.resume({ runId: 'facade-probe', signal: abort.signal }).finally(() => { resumedSettled = true; });
  await delay(150);
  t.diagnostic(JSON.stringify({ phase: 'resume', disposition: engine.controlStatus('facade-probe').disposition,
    resumedSettled }));
  assert.equal(engine.controlStatus('facade-probe').disposition, 'paused_owner', 'current resume does not transition existing controller');
  abort.abort(); await Promise.all([pending, resumed]);
});
test('scratch owner correction invalidates old planner output', async (t) => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  const { engine, db } = await createHarness(t, { appServer: { async run(options) {
    calls += 1;
    const output = result(options);
    if (calls === 1) { entered.resolve(); await release.promise; }
    return output;
  } } });
  engine.authenticateOwner = () => true;
  engine.ownerCorrectionAuthorized = () => true;
  const abort = new AbortController();
  const pending = engine.run(intake(abort.signal));
  await entered.promise;
  const controller = engine.controllers.get('facade-probe');
  const before = engine.controlStatus('facade-probe').revisions;
  const correctionDigest = `sha256:${'c'.repeat(64)}`;
  controller.receive({ messageId: 'correction-probe', kind: 'owner_correction', source: 'verified-adapter',
    payload: { correction: { expectedGoalRevision: before.goalRevision, expectedAuthorityRevision: 1,
      expectedControlRevision: before.controlRevision, requirementDigest: correctionDigest } } });
  release.resolve();
  await waitFor(() => controller.inbox.get('correction-probe').state !== 'received', 'correction not processed');
  engine.requestPause('facade-probe');
  const objective = engine.store.getObjective(projectId, 'engine-objective-1');
  const run = db.prepare('SELECT requirement_digest FROM concurrent_delivery_runs').get();
  const turns = db.prepare('SELECT status,result_json FROM delivery_planner_turns').all();
  t.diagnostic(JSON.stringify({ message: controller.inbox.get('correction-probe'), goalRevision: objective.goalRevision,
    objectiveDigest: objective.requirementDigest, runDigest: run.requirement_digest, turns }));
  assert.equal(objective.goalRevision, before.goalRevision + 1);
  assert.equal(objective.requirementDigest, correctionDigest);
  assert.ok(turns.some((turn) => turn.status === 'stale'));
  abort.abort(); await pending;
});
test('scratch database reopen retains unknown planner fence', async (t) => {
  let calls = 0;
  const fx = await createHarness(t, { appServer: { async run(options) {
    calls += 1; options.onTurnStart({ threadId: options.threadId, processIdentity: readProcessIdentity(process.pid) });
    throw new Error('provider outcome unknown');
  } } });
  const abort = new AbortController();
  const pending = fx.engine.run(intake(abort.signal));
  await waitFor(() => fx.engine.controllers.get('facade-probe')?.status().lastRecovery, 'missing held unknown turn');
  await assert.rejects(fx.engine.shutdown(), { code: 'concurrent_shutdown_unsafe' });
  abort.abort(); await pending;
  fx.db.close();
  const db = new Database(path.join(fx.storageRoot, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace: fx.workspace });
  const lanes = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree', lanesRoot: path.join(fx.storageRoot, 'lanes'), links: [] });
  const identity = { accountId: 'fake-account', codexHome };
  const reopened = new ConcurrentDeliveryEngine({ db, workspace: fx.workspace, projectId, storageRoot: fx.storageRoot,
    baseUrl: fx.baseUrl, authMiddleware: (req,res,next) => next(), authToken: 'concurrent-test-token', appServer: fx.appServer,
    providerIdentity: identity, providerIdentityFor: () => identity, roles: fx.roles, leadRole: fx.lead, admission, lanes,
    writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
  try {
    const recovered = await reopened.recoverStoredRuns();
    const row = db.prepare('SELECT status FROM delivery_planner_turns').get();
    t.diagnostic(JSON.stringify({ recovered, ledgerStatus: row.status, calls,
      objective: reopened.getRunDigest('facade-probe') }));
    assert.equal(row.status, 'unknown'); assert.equal(calls, 1);
    // Canceled runs are excluded by recoverStoredRuns; no controller is created.
    const closed = await reopened.shutdown();
    t.diagnostic(JSON.stringify({ reopenedShutdown: closed }));
    assert.equal(closed.safeToRelease, true);
    assert.deepEqual(closed.projections, []);
  } finally { for (const controller of reopened.controllers.values()) controller.stop(); db.close(); }
});
