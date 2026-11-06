'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { DeliveryInbox } = require('../src/delivery-inbox');
const { LeadPlanner } = require('../src/lead-planner');
const { TaskExecutor } = require('../src/task-executor');
const { ProjectDeliveryController } = require('../src/project-delivery-controller');
const { VERSION } = require('../src/delivery-contracts');

const projectId = 'controller-project';
const objectiveId = 'controller-objective';
const sessionId = 'controller-session';
const digest = (letter) => `sha256:${letter.repeat(64)}`;

function task(taskId) {
  return { schemaVersion: VERSION, projectId, objectiveId, taskId, revision: 1, role: 'engineer', kind: 'implementation',
    objective: `Implement ${taskId}`, priority: 0, dependencies: [], productWritePaths: [`src/${taskId}.js`],
    readScope: { kind: 'known', paths: [] }, scratchWriteRoots: ['.scratch'], resourceClaims: [],
    publicationAuthority: { state: 'unknown' }, state: 'queued' };
}

function delta(current, tasks) {
  return { schemaVersion: VERSION, expectedPlanRevision: current.planRevision, expectedGoalRevision: current.goalRevision,
    expectedAuthorityRevision: current.authorityRevision, expectedControlRevision: current.controlRevision,
    nextPlanRevision: current.planRevision + 1, tasks: tasks.map((item) => ({ task: item })), dependencies: [] };
}

function plannerOutput(prompt, tasks = []) {
  const pins = prompt.pins;
  return { expected: { planRevision: pins.planRevision, goalRevision: pins.goalRevision, authorityRevision: pins.authorityRevision,
    controlRevision: pins.controlRevision, inboxVersion: pins.inboxVersion },
  delta: tasks.length ? { schemaVersion: VERSION, expectedPlanRevision: pins.planRevision, expectedGoalRevision: pins.goalRevision,
    expectedAuthorityRevision: pins.authorityRevision, expectedControlRevision: pins.controlRevision,
    nextPlanRevision: pins.planRevision + 1, tasks: tasks.map((item) => ({ task: item })), dependencies: [] } : null,
  dialogue: 'bounded response', recovery: null, ownerDecision: null };
}

function fixture({ tasks = [], runTurn = async ({ prompt }) => plannerOutput(prompt), sendMessage, cancelTask, authenticateOwner,
  ownerCorrectionAuthorized = () => false, inbox, file = ':memory:', plannerReservedSlots = 1, getTask,
  findByContext = async () => null, resultAdapter, recoveryProofAdapter, lifecycleOptions = {}, reconcilePriorTurn, authorizeRecovery, onOwnerCorrection, now = () => Date.now(),
  pollIntervalMs = 100000, providerThreadId = `test-thread:${projectId}:${sessionId}`,
  contextFor = () => ({}), projectId: configuredProjectId = projectId, objectiveId: configuredObjectiveId = objectiveId,
  sessionId: configuredSessionId = sessionId } = {}) {
  const db = new Database(file);
  db.pragma('busy_timeout = 3000');
  const store = new BacklogStore(db, { now, roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots,
    ownerCorrectionAuthorized });
  if (!store.getObjective(configuredProjectId, configuredObjectiveId)) store.createObjective({ projectId: configuredProjectId, objectiveId: configuredObjectiveId, sessionId: configuredSessionId, engineVersion: VERSION, goalRevision: 1,
    requirementDigest: digest('a'), checksDigest: digest('b'), authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  if (tasks.length) store.applyPlan(configuredProjectId, configuredObjectiveId, delta(store.getObjective(configuredProjectId, configuredObjectiveId), tasks));
  const durableInbox = inbox || new DeliveryInbox(db, { projectId: configuredProjectId, objectiveId: configuredObjectiveId, sessionId: configuredSessionId, authenticateOwner, now });
  const transport = {
    sendMessage: sendMessage || (async ({ message }) => ({ id: `remote-${message.metadata.attemptId}`, contextId: message.contextId,
      metadata: { attemptId: message.metadata.attemptId } })),
    findByContext,
    getTask: getTask || (async ({ id, contextId }) => ({ id, contextId, status: { state: 'TASK_STATE_WORKING' } })),
  };
  if (cancelTask) transport.cancel = cancelTask;
  const executor = new TaskExecutor({ backlogStore: store, db, transportFor: async () => transport,
    settingsFor: async () => ({ model: 'model-pinned', effort: 'high', fast: true }),
    roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: ({ task: value }) => ({ request: { objective: value.objective, allowedFiles: value.productWritePaths } }),
    recoveryProofAdapter,
    resultAdapter: resultAdapter || (async () => ({
      result: { state: 'succeeded', trusted: true, candidateId: 'candidate-test', output: 'test output' },
      evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true, evidenceRefs: ['test:controller'] },
    })), now });
  const plannerOptions = providerThreadId === null ? {} : { providerThreadId };
  const controller = new ProjectDeliveryController({ store, executor, projectId: configuredProjectId, objectiveId: configuredObjectiveId,
    sessionId: configuredSessionId, inbox: durableInbox, runTurn, contextFor, reconcilePriorTurn, authorizeRecovery, ...plannerOptions,
    authenticateOwner, onOwnerCorrection, lifecycleOptions, now, schedulerOptions: { roles: ['engineer'], writerMode: 'isolated', pollIntervalMs } });
  return { db, store, inbox: durableInbox, executor, controller };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, attempts = 500) {
  for (let tries = 0; tries < attempts; tries += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('timed out waiting for controller state');
}

test('unknown worker effects reconcile after dependency recovery without resending', { timeout: 7000 }, async (t) => {
  let available = false;
  let sends = 0;
  let remote;
  const f = fixture({ tasks: [task('recover-after-cancel')],
    async sendMessage({ message }) {
      sends += 1;
      remote = { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId,
        metadata: { attemptId: message.metadata.attemptId } };
      throw new Error('send acknowledgement lost');
    },
    findByContext: async () => available ? remote : null,
    getTask: async ({ id, contextId }) => ({ id, contextId, status: { state: 'TASK_STATE_COMPLETED' } }),
  });
  t.after(() => { f.controller.shutdown(); f.db.close(); });
  f.controller.start();
  await waitFor(() => f.executor.getAttempt(f.store.listAttempts(projectId, objectiveId)[0]?.attemptId)?.state === 'uncertain', 1000);
  const requested = await f.controller.cancelObjective();
  assert.equal(requested.objective.disposition, 'draining');
  const attemptId = f.store.listAttempts(projectId, objectiveId)[0].attemptId;
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'draining');
  assert.equal(sends, 1);

  available = true;
  await waitFor(() => f.executor.getAttempt(attemptId)?.state === 'settled', 1500);
  assert.equal(f.store.listAttempts(projectId, objectiveId)[0].state, 'canceled');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'draining');
  assert.equal(sends, 1);
});

test('no-intent cancellation recovery retries with the current generation until trusted proof is available', { timeout: 7000 }, async (t) => {
  let proofAvailable = false;
  let proofCalls = 0;
  let sends = 0;
  const f = fixture({ tasks: [task('recover-no-intent')],
    sendMessage: async () => { sends += 1; throw new Error('no work may be sent'); },
    recoveryProofAdapter: ({ identity, attempt, claim }) => {
      proofCalls += 1;
      if (!proofAvailable) return null;
      return { projectId: identity.projectId, objectiveId: identity.objectiveId, taskId: identity.taskId,
        attemptId: identity.attemptId, fencingToken: identity.fencingToken, claimOwnerGeneration: claim.ownerGeneration,
        recoveryGeneration: identity.recoveryGeneration, providerContextId: attempt.providerContextId, intentState: null,
        noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true,
        evidenceRefs: ['test:no-intent-no-effect'] };
    },
  });
  t.after(() => { f.controller.shutdown(); f.db.close(); });
  const objective = f.store.getObjective(projectId, objectiveId);
  const [claimed] = f.store.claimReady(projectId, objectiveId, objective.ownerGeneration, {
    controlRevision: objective.controlRevision, leaseMs: 1,
  });
  f.store.markExpired(projectId, objectiveId, claimed.claim.leaseUntil);
  const canceled = await f.controller.cancelObjective();
  assert.equal(canceled.objective.disposition, 'draining');
  f.controller.start();
  await waitFor(() => proofCalls >= 2, 1000);
  assert.equal(f.store.getObjective(projectId, objectiveId).ownerGeneration, objective.ownerGeneration);
  assert.equal(f.store.listAttempts(projectId, objectiveId)[0].state, 'unknown');
  assert.equal(sends, 0);

  proofAvailable = true;
  await waitFor(() => f.store.listAttempts(projectId, objectiveId)[0].state === 'canceled', 1500);
  const settled = f.store.listAttempts(projectId, objectiveId)[0];
  assert.equal(settled.outcome.failureKind, 'reconciled_no_effect');
  assert.equal(f.store.listClaims(projectId, objectiveId)[0].state, 'released');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'draining');
  assert.equal(sends, 0);
});

test('acknowledges steering during a slow actual execution and atomically applies it before another claim', async (t) => {
  const sendEntered = deferred();
  const releaseSend = deferred();
  const turnEntered = deferred();
  const releaseTurn = deferred();
  const { db, store, inbox, controller } = fixture({ tasks: [task('slow')],
    sendMessage: async ({ message }) => {
      sendEntered.resolve();
      await releaseSend.promise;
      return { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId, metadata: { attemptId: message.metadata.attemptId } };
    },
    runTurn: async ({ prompt }) => { turnEntered.resolve(prompt); await releaseTurn.promise; return plannerOutput(prompt, [task('successor')]); },
  });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  await sendEntered.promise;
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  const ack = controller.receive({ messageId: 'steering-1', kind: 'steering', payload: { instruction: 'Add one successor' } });
  assert.equal(ack.acknowledged, true);
  assert.equal(inbox.get('steering-1').state, 'received');
  const prompt = await turnEntered.promise;
  assert.equal(prompt.projection.claims.length, 1);
  assert.equal(store.getObjective(projectId, objectiveId).tasks.some((entry) => entry.taskId === 'successor'), false);
  releaseTurn.resolve();
  await waitFor(() => inbox.get('steering-1').state === 'applied');
  assert.equal(inbox.projection().wakeup, false);
  assert.equal(store.projectCapacity(projectId, objectiveId).active >= 1, true);
  assert.equal(store.getObjective(projectId, objectiveId).tasks.some((entry) => entry.taskId === 'successor'), true);
  releaseSend.resolve();
});

test('authenticated correction applies and acknowledges atomically before queued work can be claimed', async (t) => {
  const { db, store, inbox, controller } = fixture({ tasks: [task('queued')],
    authenticateOwner: ({ source }) => source === 'verified-adapter', ownerCorrectionAuthorized: () => true });
  t.after(() => { controller.stop(); db.close(); });
  const ack = controller.receive({ messageId: 'correction-1', kind: 'owner_correction', source: 'verified-adapter',
    payload: { correction: { expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: digest('c') } } });
  assert.equal(ack.state, 'received');
  controller.start();
  await waitFor(() => inbox.get('correction-1').state === 'applied');
  assert.equal(store.getObjective(projectId, objectiveId).goalRevision, 2);
  assert.equal(store.getObjective(projectId, objectiveId).tasks[0].state, 'blocked');
  assert.equal(store.listClaims(projectId, objectiveId).length, 0);
  assert.equal(controller.status().messages.find((message) => message.messageId === 'correction-1').state, 'applied');
  assert.equal(controller.status().lastPlanner.state, 'complete');
  assert.equal(inbox.projection().wakeup, false);
  assert.deepEqual(store.events.replay(projectId).filter((event) => event.eventType === 'objective.owner_correction')
    .map((event) => event.payload.sourceMessageId), ['correction-1']);
});

test('an authorized correction replans and claims replacement work at its new control revision', async (t) => {
  const sends = [];
  const { db, store, inbox, controller } = fixture({ tasks: [task('old-queued')], authenticateOwner: () => true,
    ownerCorrectionAuthorized: () => true, sendMessage: async ({ message }) => {
      sends.push(message.metadata.attemptId);
      return { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId, metadata: { attemptId: message.metadata.attemptId } };
    },
    runTurn: async ({ prompt }) => {
      assert.equal(prompt.pins.goalRevision, 2);
      assert.equal(prompt.pins.controlRevision, 2);
      return plannerOutput(prompt, [task('replacement')]);
    } });
  t.after(() => { controller.stop(); db.close(); });
  controller.receive({ messageId: 'correction-replan', kind: 'owner_correction', source: 'verified-adapter',
    payload: { correction: { expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: digest('c') } } });
  controller.start();
  await waitFor(() => store.getObjective(projectId, objectiveId).tasks.some((item) => item.taskId === 'replacement') && sends.length === 1);
  assert.equal(inbox.get('correction-replan').state, 'applied');
  assert.equal(store.getObjective(projectId, objectiveId).tasks.find((item) => item.taskId === 'replacement').state, 'running');
  assert.equal(store.listClaims(projectId, objectiveId).length, 1);
});

test('owner correction acknowledgement failure rolls back the correction and blocks the inbox message', async (t) => {
  const { db, store, inbox, controller } = fixture({ tasks: [task('queued')], authenticateOwner: () => true, ownerCorrectionAuthorized: () => true });
  t.after(() => { controller.stop(); db.close(); });
  controller.receive({ messageId: 'correction-rollback', kind: 'owner_correction', source: 'adapter',
    payload: { correction: { expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: digest('c') } } });
  const markApplied = inbox.markApplied.bind(inbox);
  inbox.markApplied = (...args) => { if (args[0] === 'correction-rollback') throw Object.assign(new Error('injected acknowledgement failure'), { code: 'ack_failure' }); return markApplied(...args); };
  await controller.runOnce();
  assert.equal(store.getObjective(projectId, objectiveId).goalRevision, 1);
  assert.equal(inbox.get('correction-rollback').state, 'blocked');
  assert.equal(controller.status().messages.find((message) => message.messageId === 'correction-rollback').state, 'blocked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backlog_owner_corrections').get().n, 0);
  await controller.scheduler.runOnce();
  assert.equal(store.listClaims(projectId, objectiveId).length, 0);
});

test('restart consumes durable inbox wakeup and idle runs do not call the model', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-controller-'));
  const file = path.join(directory, 'state.sqlite');
  let calls = 0;
  const first = fixture({ file, runTurn: async ({ prompt }) => { calls += 1; return plannerOutput(prompt); } });
  first.inbox.receive({ messageId: 'restart-message', kind: 'steering', payload: { instruction: 'Continue after restart' } });
  first.controller.stop();
  first.db.close();
  const second = fixture({ file, runTurn: async ({ prompt }) => { calls += 1; return plannerOutput(prompt); } });
  t.after(() => { second.controller.stop(); second.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  second.controller.start();
  await waitFor(() => second.inbox.get('restart-message').state === 'applied');
  assert.equal(second.controller.status().lastPlanner.state, 'complete');
  assert.equal(second.inbox.get('restart-message').state, 'applied');
  assert.equal(calls, 1);
  assert.deepEqual(await second.controller.runOnce(), { state: 'idle', reason: 'no_trigger' });
  assert.equal(calls, 1);
  assert.equal(second.controller.status().scheduler.idle.cause, 'no_ready_work');
});

test('shutdown fences a controller cycle suspended before planner admission', async (t) => {
  let calls = 0;
  const { db, inbox, controller } = fixture({
    runTurn: async ({ prompt }) => { calls += 1; return plannerOutput(prompt); },
    lifecycleOptions: { effectsSettledForShutdown: () => true },
  });
  t.after(() => { controller.stop(); db.close(); });

  inbox.signal('shutdown-race');
  const cycle = controller.runOnce();
  const pending = controller.shutdown();
  assert.equal(pending.safeToRelease, false);
  assert.ok(pending.reasons.includes('controller_cycle_in_flight'));

  assert.deepEqual(await cycle, { state: 'stale', reason: 'controller_shutdown' });
  assert.equal(calls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_planner_turns').get().n, 0);
  const drained = controller.lifecycle.shutdownProjection();
  assert.equal(drained.safeToRelease, true);
  assert.deepEqual(drained.reasons, []);
});

test('shutdown invalidates a held planner output and keeps its reservation until it settles', async (t) => {
  const turnEntered = deferred();
  const releaseTurn = deferred();
  const { db, store, inbox, controller } = fixture({
    runTurn: async ({ prompt }) => { turnEntered.resolve(); await releaseTurn.promise; return plannerOutput(prompt, [task('must-not-apply')]); },
    lifecycleOptions: { effectsSettledForShutdown: () => true },
  });
  t.after(() => { controller.stop(); db.close(); });

  inbox.receive({ messageId: 'held-planner-shutdown', kind: 'steering', payload: { instruction: 'Plan one task' } });
  controller.start();
  await turnEntered.promise;
  const pending = controller.shutdown();
  assert.equal(pending.safeToRelease, false);
  assert.ok(pending.reasons.includes('controller_cycle_in_flight'));
  assert.ok(pending.reasons.includes('live_or_unknown_planner_turn'));
  assert.deepEqual(pending.plannerTurns.map((turn) => turn.status), ['active']);

  releaseTurn.resolve();
  await waitFor(() => controller.status().lastPlanner?.state === 'stale');
  assert.equal(store.getObjective(projectId, objectiveId).tasks.some((item) => item.taskId === 'must-not-apply'), false);
  assert.equal(store.listClaims(projectId, objectiveId).length, 0);
  assert.equal(db.prepare("SELECT status FROM delivery_planner_turns WHERE status IN ('active','unknown')").all().length, 0);
  assert.equal(controller.lifecycle.shutdownProjection().safeToRelease, false);
});

test('shutdown blocks queued and direct planner and scheduler admissions', async (t) => {
  let calls = 0;
  const { db, store, controller } = fixture({
    runTurn: async ({ prompt }) => { calls += 1; return plannerOutput(prompt); },
    lifecycleOptions: { effectsSettledForShutdown: () => true },
  });
  t.after(() => { controller.stop(); db.close(); });

  controller.start();
  controller.wake();
  controller.shutdown();
  assert.deepEqual(await controller.runOnce(), { state: 'blocked', reason: 'controller_shutdown' });
  assert.deepEqual(await controller.planner.run('late-direct-call'), { state: 'blocked', reason: 'controller_shutdown' });
  assert.deepEqual(await controller.scheduler.runOnce(), { state: 'blocked', reason: 'controller_shutdown' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 0);
  assert.equal(store.listClaims(projectId, objectiveId).length, 0);
  assert.equal(store.listAttempts(projectId, objectiveId).length, 0);
  assert.equal(controller.lifecycle.shutdownProjection().safeToRelease, true);
});

test('pause before controller start preserves steering without starting a lead turn', async (t) => {
  let calls = 0;
  const { db, store, inbox, controller } = fixture({ runTurn: async ({ prompt }) => { calls += 1; return plannerOutput(prompt); } });
  t.after(() => { controller.stop(); db.close(); });
  store.requestControl(projectId, objectiveId, 'pause', 1);
  controller.receive({ messageId: 'paused-steering', kind: 'steering', payload: { instruction: 'Wait for resume' } });
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  assert.equal(controller.status().running, false);
  assert.equal(controller.status().lastRecovery.reason, 'control_revision_changed');
  assert.equal(inbox.get('paused-steering').state, 'received');
});

test('pause during a held lead turn makes output stale and suppresses a follow-up turn', async (t) => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const { db, store, inbox, controller } = fixture({ runTurn: async ({ prompt }) => {
    calls += 1;
    entered.resolve();
    await release.promise;
    return plannerOutput(prompt, [task('must-not-apply')]);
  } });
  t.after(() => { controller.stop(); db.close(); });
  controller.receive({ messageId: 'before-pause', kind: 'steering', payload: { instruction: 'Plan work' } });
  controller.start();
  await entered.promise;
  store.requestControl(projectId, objectiveId, 'pause', 1);
  release.resolve();
  await waitFor(() => controller.status().lastPlanner?.state === 'stale');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(store.getObjective(projectId, objectiveId).tasks.length, 0);
  assert.equal(inbox.get('before-pause').state, 'received');
  assert.equal(inbox.projection().wakeup, true);
});

test('owner pause drains a held worker send without requesting cancellation', async (t) => {
  const entered = deferred();
  const release = deferred();
  let cancels = 0;
  const { db, store, executor, controller } = fixture({ tasks: [task('drain-on-pause')],
    sendMessage: async ({ message }) => {
      entered.resolve();
      await release.promise;
      return { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId,
        metadata: { attemptId: message.metadata.attemptId } };
    }, cancelTask: async () => { cancels += 1; } });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  await entered.promise;
  const paused = controller.pauseObjective();
  assert.equal(paused.disposition, 'paused_owner');
  release.resolve();
  await waitFor(() => executor.getAttempt(store.listAttempts(projectId, objectiveId)[0].attemptId)?.state === 'submitted');
  assert.equal(cancels, 0);
  assert.equal(store.getLifecycleControl(projectId, objectiveId).cause, 'owner_pause');
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
});

test('emergency owner stop records a distinct cause, requests abort, and retains uncertain capacity', async (t) => {
  let cancels = 0;
  const { db, store, executor, controller } = fixture({ tasks: [task('stop-with-live-work')],
    cancelTask: async () => { cancels += 1; } });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  await waitFor(() => store.listAttempts(projectId, objectiveId).length === 1
    && executor.getAttempt(store.listAttempts(projectId, objectiveId)[0].attemptId)?.state === 'submitted');
  const stopped = await controller.emergencyStop();
  assert.equal(stopped.objective.disposition, 'paused_owner');
  assert.equal(store.getLifecycleControl(projectId, objectiveId).cause, 'owner_stop');
  assert.equal(cancels, 1);
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  assert.equal(stopped.lifecycle.shutdown.safeToRelease, false);
  assert.ok(stopped.lifecycle.shutdown.reasons.includes('live_or_uncertain_claims'));
});

test('restart polls a submitted intent under the new generation without resending', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-submitted-reopen-'));
  const file = path.join(directory, 'state.sqlite');
  const first = fixture({ file, tasks: [task('submitted-before-restart')] });
  let firstClosed = false;
  let reopenedDb;
  let reopenedController;
  t.after(() => {
    if (!firstClosed) { first.controller.stop(); first.db.close(); }
    if (reopenedController) reopenedController.stop();
    if (reopenedDb) reopenedDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  first.controller.start();
  await waitFor(() => first.store.listAttempts(projectId, objectiveId).length === 1
    && first.executor.getAttempt(first.store.listAttempts(projectId, objectiveId)[0].attemptId)?.state === 'submitted');
  const priorAttempt = first.store.listAttempts(projectId, objectiveId)[0];
  const priorIntent = first.executor.getAttempt(priorAttempt.attemptId);
  first.controller.stop();
  first.db.close();
  firstClosed = true;

  reopenedDb = new Database(file);
  reopenedDb.pragma('busy_timeout = 3000');
  const reopenedStore = new BacklogStore(reopenedDb, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 1 });
  reopenedStore.advanceOwnerGeneration(projectId, objectiveId, 0);
  const reopenedInbox = new DeliveryInbox(reopenedDb, { projectId, objectiveId, sessionId });
  let sends = 0;
  const transport = {
    async sendMessage() { sends += 1; throw new Error('restart must not resend'); },
    async findByContext() { return null; },
    async getTask({ id, contextId }) { return { id, contextId, status: { state: 'COMPLETED' } }; },
  };
  const reopenedExecutor = new TaskExecutor({ backlogStore: reopenedStore, db: reopenedDb, transportFor: async () => transport,
    settingsFor: async () => ({ model: 'model-pinned' }), roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: ({ task: value }) => ({ request: { objective: value.objective, allowedFiles: value.productWritePaths } }),
    resultAdapter: async () => ({ result: { state: 'succeeded', trusted: true, candidateId: 'candidate-after-restart' },
      evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true, evidenceRefs: ['test:restart-terminal'] } }) });
  reopenedController = new ProjectDeliveryController({ store: reopenedStore, executor: reopenedExecutor, projectId, objectiveId,
    sessionId, inbox: reopenedInbox, providerThreadId: `test-thread:${projectId}:${sessionId}`,
    runTurn: async ({ prompt }) => plannerOutput(prompt), schedulerOptions: { roles: ['engineer'], writerMode: 'isolated', pollIntervalMs: 100000 } });
  reopenedController.start();
  await waitFor(() => reopenedStore.listAttempts(projectId, objectiveId)[0].state === 'succeeded');
  assert.equal(sends, 0);
  assert.equal(reopenedStore.listAttempts(projectId, objectiveId)[0].externalTaskId, priorIntent.externalTaskId);
  assert.equal(reopenedStore.projectCapacity(projectId, objectiveId).active, 0);
  assert.equal(reopenedController.status().lastRecovery.attempts[0].reason, 'executor_submitted');
});

test('restart keeps an uncertain live process fenced when no trusted recovery proof exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-uncertain-reopen-'));
  const file = path.join(directory, 'state.sqlite');
  const first = fixture({ file, tasks: [task('uncertain-before-restart')],
    sendMessage: async () => { throw new Error('response lost after possible submission'); } });
  let firstClosed = false;
  let reopenedDb;
  let reopenedController;
  t.after(() => {
    if (!firstClosed) { first.controller.stop(); first.db.close(); }
    if (reopenedController) reopenedController.stop();
    if (reopenedDb?.open) reopenedDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  first.controller.start();
  await waitFor(() => first.store.listAttempts(projectId, objectiveId).length === 1
    && first.executor.getAttempt(first.store.listAttempts(projectId, objectiveId)[0].attemptId)?.state === 'uncertain');
  first.controller.stop();
  first.db.close();
  firstClosed = true;

  reopenedDb = new Database(file);
  reopenedDb.pragma('busy_timeout = 3000');
  const reopenedStore = new BacklogStore(reopenedDb, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 1 });
  reopenedStore.advanceOwnerGeneration(projectId, objectiveId, 0);
  const reopenedInbox = new DeliveryInbox(reopenedDb, { projectId, objectiveId, sessionId });
  let sends = 0;
  const transport = { async sendMessage() { sends += 1; throw new Error('must remain parked'); }, async findByContext() { return null; } };
  const reopenedExecutor = new TaskExecutor({ backlogStore: reopenedStore, db: reopenedDb, transportFor: async () => transport,
    settingsFor: async () => ({ model: 'model-pinned' }), roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: ({ task: value }) => ({ request: { objective: value.objective, allowedFiles: value.productWritePaths } }),
    resultAdapter: async () => ({ result: { state: 'failed' }, evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } }) });
  reopenedController = new ProjectDeliveryController({ store: reopenedStore, executor: reopenedExecutor, projectId, objectiveId,
    sessionId, inbox: reopenedInbox, providerThreadId: `test-thread:${projectId}:${sessionId}`,
    runTurn: async ({ prompt }) => plannerOutput(prompt), schedulerOptions: { roles: ['engineer'], writerMode: 'isolated', pollIntervalMs: 100000 } });
  reopenedController.start();
  await waitFor(() => reopenedController.status().scheduler.parked.length === 1);
  assert.equal(reopenedController.status().lastRecovery.attempts[0].state, 'unknown');
  assert.equal(reopenedController.status().lastRecovery.attempts[0].reason, 'trusted_recovery_adapter_unavailable');
  assert.equal(reopenedStore.getObjective(projectId, objectiveId).tasks[0].state, 'settling');
  assert.equal(reopenedStore.projectCapacity(projectId, objectiveId).active, 1);
  assert.equal(sends, 0);
  const shutdown = reopenedController.shutdown();
  assert.equal(shutdown.safeToRelease, false);
  assert.ok(shutdown.reasons.includes('live_or_uncertain_claims'));
});

for (const control of ['active', 'owner_pause', 'takeover']) test(`terminal adapter errors remain fenced and visible with ${control} control`, async (t) => {
  let sends = 0;
  let plannerCalls = 0;
  const failureCode = 'delivery_role_terminal_identity_unavailable';
  const fx = fixture({ tasks: [task('terminal-error')], pollIntervalMs: 1,
    sendMessage: async ({ message }) => {
      sends += 1;
      return { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId,
        metadata: { attemptId: message.metadata.attemptId } };
    },
    getTask: async ({ id, contextId }) => ({ id, contextId, status: { state: 'TASK_STATE_COMPLETED' } }),
    resultAdapter: async () => {
      if (control === 'owner_pause') fx.controller.pauseObjective();
      if (control === 'takeover') fx.store.advanceOwnerGeneration(projectId, objectiveId, 0);
      throw Object.assign(new Error(failureCode), { code: failureCode });
    },
    runTurn: async ({ prompt }) => { plannerCalls += 1; return plannerOutput(prompt); },
  });
  const { db, store, controller, executor } = fx;
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  await waitFor(() => controller.status().scheduler.parked.length === 1);
  const attempt = store.listAttempts(projectId, objectiveId)[0];
  assert.equal(controller.status().lastAttemptFailure.failureCode, failureCode);
  assert.equal(controller.status().lastAttemptFailure.attemptId, attempt.attemptId);
  assert.equal(controller.status().scheduler.parked[0].reason, failureCode);
  assert.equal(store.getObjective(projectId, objectiveId).disposition,
    control === 'active' ? 'blocked_technical' : control === 'owner_pause' ? 'paused_owner' : 'executing');
  const intent = executor.getAttempt(attempt.attemptId);
  assert.notEqual(intent.state, 'settled');
  assert.equal(store.projectCapacity(projectId, objectiveId).active, 1);
  await controller.scheduler.runOnce();
  assert.equal(sends, 1);
  if (control === 'active') assert.equal(plannerCalls, 0);
  assert.equal(controller.shutdown().safeToRelease, false);
  assert.equal(executor.getAttempt(attempt.attemptId).state, intent.state);
});

test('an existing controller never adopts a newer owner generation after takeover', async (t) => {
  const { db, store, controller } = fixture({ tasks: [task('stale-controller-task')] });
  t.after(() => { controller.stop(); db.close(); });
  store.advanceOwnerGeneration(projectId, objectiveId, 0);
  await controller.scheduler.runOnce();
  assert.equal(controller.scheduler.projection().idle.detail, 'owner_generation_changed');
  assert.equal(store.listClaims(projectId, objectiveId).length, 0);
});

test('a receipt during a lead turn invalidates it and the coalesced wakeup gets a fresh turn', async (t) => {
  const entered = deferred();
  const release = deferred();
  let turns = 0;
  const { db, inbox, controller } = fixture({ runTurn: async ({ prompt }) => {
    turns += 1;
    if (turns === 1) { entered.resolve(); await release.promise; }
    return plannerOutput(prompt);
  } });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  controller.receive({ messageId: 'first-steering', kind: 'steering', payload: { instruction: 'Start planning' } });
  await entered.promise;
  const secondAck = controller.receive({ messageId: 'second-steering', kind: 'steering', payload: { instruction: 'Update the plan' } });
  assert.equal(secondAck.state, 'received');
  release.resolve();
  await waitFor(() => inbox.get('first-steering').state === 'applied' && inbox.get('second-steering').state === 'applied');
  assert.equal(turns, 2);
  assert.equal(controller.status().lastPlanner.state, 'complete');
});

test('failed work prompts one bounded internal investigation turn without owner reply or model fallback', async (t) => {
  let plannerCalls = 0;
  const { db, store, executor, controller } = fixture({ tasks: [task('fails')], pollIntervalMs: 5,
    getTask: async ({ id, contextId }) => ({ id, contextId, status: { state: 'TASK_STATE_FAILED' } }),
    resultAdapter: async () => ({ result: { state: 'failed', failureKind: 'test_failure' },
      evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceRefs: ['test:failed-task'] } }),
    runTurn: async ({ prompt }) => {
      plannerCalls += 1;
      assert.equal(prompt.projection.blockers.some((blocker) => blocker.state === 'failed'), true);
      const answer = plannerOutput(prompt);
      answer.recovery = { mode: 'investigate', hypothesisId: 'failure-hypothesis-1', attemptsRemaining: 1 };
      return answer;
    } });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  await waitFor(() => store.getObjective(projectId, objectiveId).tasks[0].state === 'failed'
    && controller.status().lastPlanner?.state === 'complete');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(executor.getAttempt(store.listAttempts(projectId, objectiveId)[0].attemptId).state, 'settled');
  assert.equal(plannerCalls, 1);
  assert.equal(controller.status().inbox.wakeup, false);
});

test('failed planner corrections drain workers and stop model calls after bounded recovery exhaustion', async (t) => {
  let clock = 100;
  let turns = 0;
  let reconciliations = 0;
  const { db, store, controller } = fixture({ now: () => clock,
    providerThreadId: 'bounded-recovery-thread', runTurn: async () => { turns += 1; return {}; },
    reconcilePriorTurn: async (identity) => {
      reconciliations += 1;
      assert.deepEqual(identity.recoveryEligibility, { projectId: identity.projectId, sessionId: identity.sessionId,
        turnId: identity.turnId, providerThreadId: identity.providerThreadId, providerScope: identity.providerScope,
        ownerGeneration: identity.ownerGeneration, remoteQuiescent: true, processQuiescent: true, state: 'recovery_eligible' });
      return { state: 'no_effect', projectId: identity.projectId, sessionId: identity.sessionId, turnId: identity.turnId,
        providerThreadId: identity.providerThreadId, providerScope: identity.providerScope, ownerGeneration: identity.ownerGeneration,
        remoteQuiescent: true, processQuiescent: true };
    },
    lifecycleOptions: { baseRetryDelayMs: 10, maxRetryDelayMs: 10, setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {},
      plannerRecoveryProofAdapter: (input) => ({ projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId,
        providerThreadId: input.providerThreadId, providerScope: input.providerScope, ownerGeneration: input.ownerGeneration,
        remoteQuiescent: true, processQuiescent: true }),
      plannerRetryIdentity: () => ({ source: 'planner', provider: 'provider-a', model: 'model-a', kind: 'planner_invalid' }) },
  });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  controller.receive({ messageId: 'invalid-planner-output', kind: 'steering', payload: { instruction: 'Plan a small task' } });
  await waitFor(() => turns === 1 && controller.status().lastRecovery?.state === 'scheduled');
  assert.equal(store.listLifecycleRetries(projectId, objectiveId)[0].state, 'waiting');

  clock += 10;
  assert.equal(controller.lifecycle.tick().woke, 1);
  await waitFor(() => turns === 2 && controller.status().lastRecovery?.state === 'scheduled');
  clock += 10;
  assert.equal(controller.lifecycle.tick().woke, 1);
  await waitFor(() => store.getObjective(projectId, objectiveId).disposition === 'blocked_technical');
  assert.equal(turns, 3);
  assert.equal(reconciliations, 2);
  assert.equal(store.listLifecycleRetries(projectId, objectiveId)[0].state, 'blocked');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(turns, 3);
  assert.deepEqual(await controller.runOnce(), { state: 'blocked', reason: 'planner_recovery_exhausted' });
  assert.equal(turns, 3);
});

test('a thrown planner call cannot receive validation recovery proof or a retry', async (t) => {
  let proofCalls = 0;
  let turns = 0;
  const { db, store, controller } = fixture({ runTurn: async () => {
    turns += 1;
    throw Object.assign(new Error('transport failed'), { code: 'planner_output_invalid' });
  }, lifecycleOptions: { plannerRecoveryProofAdapter: () => {
    proofCalls += 1;
    return { projectId, sessionId, turnId: 'forbidden', providerThreadId: 'thread', providerScope: 'default',
      ownerGeneration: 0, remoteQuiescent: true, processQuiescent: true };
  }, plannerRetryIdentity: () => ({ source: 'planner', provider: 'provider-a', model: 'model-a', kind: 'planner_invalid' }) } });
  t.after(() => { controller.stop(); db.close(); });
  controller.start();
  controller.receive({ messageId: 'thrown-planner-call', kind: 'steering', payload: { instruction: 'Plan' } });
  await waitFor(() => controller.status().lastRecovery?.state === 'held');
  assert.equal(turns, 1);
  assert.equal(proofCalls, 0);
  assert.equal(store.listLifecycleRetries(projectId, objectiveId).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(turns, 1);
});

test('planner reservations are project-wide across objectives and sessions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-reservation-'));
  const file = path.join(directory, 'state.sqlite');
  const entered = deferred();
  const release = deferred();
  const first = fixture({ file, runTurn: async ({ prompt }) => { entered.resolve(); await release.promise; return plannerOutput(prompt); } });
  const secondDb = new Database(file);
  secondDb.pragma('busy_timeout = 3000');
  const secondStore = new BacklogStore(secondDb, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 1 });
  t.after(() => { first.controller.stop(); first.db.close(); secondDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  secondStore.createObjective({ projectId, objectiveId: 'second-objective', sessionId: 'second-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: digest('d'), checksDigest: digest('e'), authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  const secondInbox = new DeliveryInbox(secondDb, { projectId, objectiveId: 'second-objective', sessionId: 'second-session' });
  const secondPlanner = new LeadPlanner({ store: secondStore, inbox: secondInbox, providerThreadId: 'other-provider-thread',
    runTurn: async ({ prompt }) => plannerOutput(prompt) });
  first.inbox.receive({ messageId: 'one', kind: 'steering', payload: { instruction: 'Inspect project' } });
  secondInbox.receive({ messageId: 'two', kind: 'steering', payload: { instruction: 'Inspect another objective' } });
  const active = first.controller.planner.run();
  await entered.promise;
  assert.deepEqual(await secondPlanner.run(), { state: 'busy', reason: 'provider_thread_busy' });
  release.resolve();
  assert.equal((await active).state, 'complete');
  assert.equal((await secondPlanner.run()).state, 'complete');
});

test('a busy controller retries its durable message after project capacity is released', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-busy-retry-'));
  const file = path.join(directory, 'state.sqlite');
  const entered = deferred();
  const release = deferred();
  let secondCalls = 0;
  const first = fixture({ file, runTurn: async ({ prompt }) => { entered.resolve(); await release.promise; return plannerOutput(prompt); } });
  first.store.createObjective({ projectId, objectiveId: 'second-objective', sessionId: 'second-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: digest('d'), checksDigest: digest('e'), authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  const second = fixture({ file, objectiveId: 'second-objective', sessionId: 'second-session', providerThreadId: 'second-thread',
    runTurn: async ({ prompt }) => { secondCalls += 1; return plannerOutput(prompt); } });
  t.after(() => { first.controller.stop(); second.controller.stop(); first.db.close(); second.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  first.controller.receive({ messageId: 'first-message', kind: 'steering', payload: { instruction: 'Use the lead slot' } });
  first.controller.start();
  await entered.promise;
  second.controller.start();
  const received = second.controller.receive({ messageId: 'second-message', kind: 'steering', payload: { instruction: 'Wait for the lead slot' } });
  assert.equal(received.state, 'received');
  await waitFor(() => second.controller.status().lastPlanner?.state === 'busy');
  assert.equal(secondCalls, 0);
  release.resolve();
  await waitFor(() => second.inbox.get('second-message').state === 'applied');
  assert.equal(secondCalls, 1);
  assert.equal(second.controller.status().lastPlanner.state, 'complete');
});

test('a stopped busy controller clears retry timers and recovers its wakeup after reopen', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-busy-reopen-'));
  const file = path.join(directory, 'state.sqlite');
  const entered = deferred();
  const release = deferred();
  const first = fixture({ file, runTurn: async ({ prompt }) => { entered.resolve(); await release.promise; return plannerOutput(prompt); } });
  first.store.createObjective({ projectId, objectiveId: 'second-objective', sessionId: 'second-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: digest('d'), checksDigest: digest('e'), authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  let stoppedCalls = 0;
  let second = fixture({ file, objectiveId: 'second-objective', sessionId: 'second-session', providerThreadId: 'second-thread',
    runTurn: async ({ prompt }) => { stoppedCalls += 1; return plannerOutput(prompt); } });
  t.after(() => { first.controller.stop(); if (second) { second.controller.stop(); second.db.close(); } first.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  first.controller.receive({ messageId: 'first-message', kind: 'steering', payload: { instruction: 'Hold the slot' } });
  first.controller.start();
  await entered.promise;
  second.controller.start();
  second.controller.receive({ messageId: 'restart-message', kind: 'steering', payload: { instruction: 'Resume after restart' } });
  await waitFor(() => second.controller.status().lastPlanner?.state === 'busy');
  second.controller.stop();
  second.db.close();
  second = null;
  release.resolve();
  await waitFor(() => first.controller.status().lastPlanner?.state === 'complete');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(stoppedCalls, 0);
  const reopenedDb = new Database(file);
  reopenedDb.pragma('busy_timeout = 3000');
  const reopenedStore = new BacklogStore(reopenedDb, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 1 });
  const reopenedInbox = new DeliveryInbox(reopenedDb, { projectId, objectiveId: 'second-objective', sessionId: 'second-session' });
  const { TaskExecutor } = require('../src/task-executor');
  const executor = new TaskExecutor({ backlogStore: reopenedStore, db: reopenedDb, transportFor: async () => ({
    async sendMessage({ message }) { return { id: `remote-${message.metadata.attemptId}`, contextId: message.contextId, metadata: { attemptId: message.metadata.attemptId } }; },
    async findByContext() { return null; },
  }), settingsFor: async () => ({ model: 'pinned' }), roleFor: (id) => ({ id, sandbox: 'writable' }),
  requestAdapter: ({ task: value }) => ({ request: { objective: value.objective, allowedFiles: value.productWritePaths } }),
  resultAdapter: async () => ({ result: { state: 'failed' }, evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true } }) });
  const { ProjectDeliveryController } = require('../src/project-delivery-controller');
  let resumedCalls = 0;
  const reopened = new ProjectDeliveryController({ store: reopenedStore, executor, projectId, objectiveId: 'second-objective', sessionId: 'second-session',
    inbox: reopenedInbox, providerThreadId: 'second-thread', runTurn: async ({ prompt }) => { resumedCalls += 1; return plannerOutput(prompt); },
    schedulerOptions: { roles: ['engineer'], writerMode: 'isolated', pollIntervalMs: 100000 } });
  t.after(() => { reopened.stop(); reopenedDb.close(); });
  reopened.start();
  await waitFor(() => reopenedInbox.get('restart-message').state === 'applied');
  assert.equal(resumedCalls, 1);
  assert.equal(reopened.status().lastPlanner.state, 'complete');
});

test('an actual context thread stays fenced across sessions even when another planner slot is free', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-thread-fence-'));
  const file = path.join(directory, 'state.sqlite');
  const entered = deferred();
  const release = deferred();
  const first = fixture({ file, plannerReservedSlots: 2, providerThreadId: null,
    contextFor: () => ({ threadId: 'actual-shared-thread', transportKey: 'shared-test-transport' }),
    runTurn: async ({ prompt }) => { entered.resolve(); await release.promise; return plannerOutput(prompt); } });
  const secondDb = new Database(file);
  secondDb.pragma('busy_timeout = 3000');
  const secondStore = new BacklogStore(secondDb, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 2 });
  t.after(() => { first.controller.stop(); first.db.close(); secondDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  secondStore.createObjective({ projectId, objectiveId: 'second-objective', sessionId: 'second-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: digest('d'), checksDigest: digest('e'), authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  const secondInbox = new DeliveryInbox(secondDb, { projectId, objectiveId: 'second-objective', sessionId: 'second-session' });
  const secondPlanner = new LeadPlanner({ store: secondStore, inbox: secondInbox,
    contextFor: () => ({ threadId: 'actual-shared-thread', transportKey: 'shared-test-transport' }),
    reconcilePriorTurn: async () => { assert.fail('active turns must never be reconciled by ordinary admission'); },
    runTurn: async ({ prompt }) => plannerOutput(prompt) });
  first.inbox.receive({ messageId: 'one', kind: 'steering', payload: { instruction: 'Use provider thread' } });
  secondInbox.receive({ messageId: 'two', kind: 'steering', payload: { instruction: 'Reuse provider thread' } });
  const active = first.controller.planner.run();
  await entered.promise;
  assert.deepEqual(await secondPlanner.run(), { state: 'busy', reason: 'provider_thread_busy', turnId: first.controller.planner.projection().lastTurn.turn_id });
  release.resolve();
  assert.equal((await active).state, 'complete');
  assert.equal((await secondPlanner.run()).state, 'complete');
});

test('planner fails closed on missing or mismatched actual provider thread identity', async (t) => {
  const missing = fixture({ providerThreadId: null, contextFor: () => ({}), runTurn: async () => { assert.fail('runTurn must not run'); } });
  t.after(() => { missing.controller.stop(); missing.db.close(); });
  missing.inbox.receive({ messageId: 'missing-thread', kind: 'steering', payload: { instruction: 'Plan' } });
  await assert.rejects(missing.controller.planner.run(), { code: 'provider_thread_identity_required' });

  const mismatch = fixture({ providerThreadId: 'configured-thread', contextFor: () => ({ threadId: 'observed-thread' }),
    runTurn: async () => { assert.fail('runTurn must not run'); } });
  t.after(() => { mismatch.controller.stop(); mismatch.db.close(); });
  mismatch.inbox.receive({ messageId: 'mismatched-thread', kind: 'steering', payload: { instruction: 'Plan' } });
  await assert.rejects(mismatch.controller.planner.run(), { code: 'provider_thread_identity_mismatch' });

  const ambiguous = fixture({ providerThreadId: null, contextFor: () => ({ threadId: 'actual-thread', providerThreadId: 'alias-thread' }),
    runTurn: async () => { assert.fail('runTurn must not run'); } });
  t.after(() => { ambiguous.controller.stop(); ambiguous.db.close(); });
  ambiguous.inbox.receive({ messageId: 'ambiguous-thread', kind: 'steering', payload: { instruction: 'Plan' } });
  await assert.rejects(ambiguous.controller.planner.run(), { code: 'provider_context_identity_alias_invalid' });
});

test('equal thread IDs on distinct transports do not share a planner fence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-transport-scope-'));
  const file = path.join(directory, 'state.sqlite');
  const entered = [deferred(), deferred()];
  const release = deferred();
  let starts = 0;
  const first = fixture({ file, plannerReservedSlots: 2, providerThreadId: null,
    contextFor: () => ({ threadId: 'transport-local-thread', transportKey: 'transport-a' }),
    runTurn: async ({ prompt }) => { entered[starts++].resolve(); await release.promise; return plannerOutput(prompt); } });
  const secondDb = new Database(file);
  secondDb.pragma('busy_timeout = 3000');
  const secondStore = new BacklogStore(secondDb, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4, plannerReservedSlots: 2 });
  secondStore.createObjective({ projectId, objectiveId: 'second-objective', sessionId: 'second-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: digest('d'), checksDigest: digest('e'), authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  const secondInbox = new DeliveryInbox(secondDb, { projectId, objectiveId: 'second-objective', sessionId: 'second-session' });
  const secondPlanner = new LeadPlanner({ store: secondStore, inbox: secondInbox,
    contextFor: () => ({ threadId: 'transport-local-thread', transportKey: 'transport-b' }),
    runTurn: async ({ prompt }) => { entered[starts++].resolve(); await release.promise; return plannerOutput(prompt); } });
  t.after(() => { first.controller.stop(); first.db.close(); secondDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  first.inbox.receive({ messageId: 'transport-a-message', kind: 'steering', payload: { instruction: 'Use transport a' } });
  secondInbox.receive({ messageId: 'transport-b-message', kind: 'steering', payload: { instruction: 'Use transport b' } });
  const runs = [first.controller.planner.run(), secondPlanner.run()];
  await Promise.all(entered.map((item) => item.promise));
  release.resolve();
  assert.deepEqual((await Promise.all(runs)).map((result) => result.state), ['complete', 'complete']);
});

for (const failure of ['throw', 'async', 'ack']) test(`owner correction trusted hook rolls back atomically on ${failure}`, async (t) => {
  const fx = fixture({ authenticateOwner: () => true, ownerCorrectionAuthorized: () => true,
    onOwnerCorrection: ({ current }) => {
      assert.equal(fx.db.inTransaction, true);
      assert.equal(current.goalRevision, 2);
      fx.db.prepare('INSERT INTO correction_hook_probe(value) VALUES(?)').run(current.goalRevision);
      if (failure === 'throw') throw Object.assign(new Error('hook failure'), { code: 'hook_failure' });
      if (failure === 'async') return Promise.resolve();
    } });
  t.after(() => { fx.controller.stop(); fx.db.close(); });
  fx.db.exec('CREATE TABLE correction_hook_probe(value INTEGER)');
  if (failure === 'ack') fx.inbox.markApplied = () => { throw Object.assign(new Error('ack failure'), { code: 'ack_failure' }); };
  fx.controller.receive({ messageId: 'hook-rollback', kind: 'owner_correction', source: 'trusted-adapter', payload: {
    correction: { expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: digest('c') } } });
  fx.controller.applyPendingOwnerCorrections();
  assert.equal(fx.store.getObjective(projectId, objectiveId).goalRevision, 1);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM correction_hook_probe').get().n, 0);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM backlog_owner_corrections').get().n, 0);
  assert.equal(fx.inbox.get('hook-rollback').state, 'blocked');
  assert.equal(fx.inbox.get('hook-rollback').result.code, failure === 'async' ? 'owner_correction_hook_async' : failure === 'throw' ? 'hook_failure' : 'ack_failure');
});

test('correction-only drain refuses stale controller owner without consuming pending correction', (t) => {
  const { db, store, inbox, controller } = fixture({ authenticateOwner: () => true, ownerCorrectionAuthorized: () => true });
  t.after(() => { controller.stop(); db.close(); });
  controller.receive({ messageId: 'takeover-correction', kind: 'owner_correction', source: 'trusted-adapter', payload: {
    correction: { expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: digest('c') } } });
  store.advanceOwnerGeneration(projectId, objectiveId, 0);
  assert.throws(() => controller.applyPendingOwnerCorrections(), { code: 'owner_generation_stale' });
  assert.equal(inbox.get('takeover-correction').state, 'received');
  assert.equal(store.getObjective(projectId, objectiveId).goalRevision, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backlog_owner_corrections').get().n, 0);
});
