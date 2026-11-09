'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { DeliveryInbox } = require('../src/delivery-inbox');
const { DeliveryLifecycle } = require('../src/delivery-lifecycle');
const { LeadPlanner } = require('../src/lead-planner');
const { TaskExecutor } = require('../src/task-executor');

const projectId = 'lifecycle-project';
const objectiveId = 'lifecycle-objective';
const sessionId = 'lifecycle-session';

function makeExecutor(db, store) {
  return new TaskExecutor({ backlogStore: store, db,
    transportFor: async () => ({ async sendMessage() { throw new Error('unused'); }, async findByContext() { return null; } }),
    settingsFor: async () => ({ model: 'test-model' }), roleFor: (id) => ({ id, sandbox: 'writable' }),
    requestAdapter: ({ task }) => ({ request: { objective: task.objective, allowedFiles: task.productWritePaths } }),
    resultAdapter: async () => ({ result: { state: 'failed' }, evidence: { remoteQuiescent: true,
      processQuiescent: true, effectsSettled: true, evidenceRefs: ['test:unused'] } }) });
}

function fixture({ file = ':memory:', now = () => 100, maxLifecycleStrategies = 2, lifecycleOptions = {} } = {}) {
  const db = new Database(file);
  const store = new BacklogStore(db, { now, roleCapacities: { engineer: 2 }, maxActiveTurns: 3, plannerReservedSlots: 1, maxLifecycleStrategies });
  store.createObjective({ projectId, objectiveId, sessionId, engineVersion: 'delivery-v1', goalRevision: 1,
    requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const executor = makeExecutor(db, store);
  const lifecycle = new DeliveryLifecycle({ store, executor, projectId, objectiveId, now,
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {}, ...lifecycleOptions });
  return { db, store, executor, lifecycle };
}

test('budget wake requires due time, literal true eligibility, and unchanged control pins', (t) => {
  let clock = 100;
  let eligible = 1;
  let wakes = 0;
  let checks = 0;
  const f = fixture({ now: () => clock, lifecycleOptions: {
    budgetWakeEligibility: () => { checks += 1; return eligible; }, onWake: () => { wakes += 1; },
  } });
  t.after(() => { f.lifecycle.close(); f.db.close(); });

  const wait = f.lifecycle.recordBudgetWait({ waitId: 'budget-one', source: 'planner', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 50 });
  assert.equal(wait.nextWakeAt, 150);
  assert.equal(f.lifecycle.tick().woke, 0);
  assert.equal(checks, 0);

  clock = 150;
  assert.equal(f.lifecycle.tick().woke, 0);
  assert.equal(checks, 1);
  assert.equal(f.store.listBudgetWaits(projectId, objectiveId)[0].state, 'waiting');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'waiting_budget');
  assert.equal(wakes, 0);

  eligible = true;
  assert.equal(f.lifecycle.wakeBudget('budget-one').state, 'woken');
  assert.equal(f.store.listBudgetWaits(projectId, objectiveId)[0].state, 'woken');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'executing');
  assert.equal(wakes, 1);
});

test('a due timestamp without authoritative eligibility cannot wake a budget wait', (t) => {
  let clock = 100;
  const f = fixture({ now: () => clock });
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  const wait = f.lifecycle.recordBudgetWait({ waitId: 'hint-only', source: 'planner', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 50 });
  assert.equal(Object.hasOwn(wait, 'blockers'), false);
  clock = wait.nextWakeAt;
  assert.equal(f.lifecycle.tick().woke, 0);
  assert.equal(f.store.listBudgetWaits(projectId, objectiveId)[0].state, 'waiting');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'waiting_budget');
});

test('explicit blocker windows survive projections and a second wait after wake', (t) => {
  let clock = 100;
  let eligible = true;
  const f = fixture({ now: () => clock, lifecycleOptions: { budgetWakeEligibility: () => eligible } });
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  const accountIdHash = `sha256:${'a'.repeat(64)}`;
  const firstWindows = [
    { accountIdHash, provider: 'provider-a', model: 'model-a', windowId: 'short', reasonCode: 'rate_limit', resetsAt: 150 },
    { accountIdHash, provider: 'provider-a', model: 'model-a', windowId: 'weekly', reasonCode: 'quota.exhausted', resetsAt: null },
  ];
  const first = f.lifecycle.recordBudgetWait({ waitId: 'wait-first', source: 'executor', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 10, blockers: firstWindows });
  assert.deepEqual(first.blockers, firstWindows);
  assert.deepEqual(f.lifecycle.projection().budgetWaits[0].blockers, firstWindows);

  clock = first.nextWakeAt;
  assert.equal(f.lifecycle.wakeBudget('wait-first').state, 'woken');
  eligible = false;
  const remainingWindow = [firstWindows[1]];
  const second = f.lifecycle.recordBudgetWait({ waitId: 'wait-second', source: 'executor', provider: 'provider-a',
    model: 'model-a', reasonCode: 'quota.exhausted', delayMs: 20, blockers: remainingWindow });
  assert.deepEqual(second.blockers, remainingWindow);
  assert.deepEqual(f.lifecycle.projection().budgetWaits.map((wait) => ({ waitId: wait.waitId, state: wait.state, blockers: wait.blockers })), [
    { waitId: 'wait-first', state: 'woken', blockers: firstWindows },
    { waitId: 'wait-second', state: 'waiting', blockers: remainingWindow },
  ]);
  clock = second.nextWakeAt;
  assert.equal(f.lifecycle.tick().woke, 0);
  assert.equal(f.store.listBudgetWaits(projectId, objectiveId)[1].state, 'waiting');
});

test('rescheduling refreshes blockers and timer without waking a budget wait', (t) => {
  let clock = 100;
  const accountIdHash = `sha256:${'a'.repeat(64)}`;
  const oldBlocker = { accountIdHash, provider: 'provider-a', model: 'model-a', windowId: 'short', reasonCode: 'rate_limit', resetsAt: 150 };
  const freshBlocker = { ...oldBlocker, windowId: 'weekly', reasonCode: 'quota.exhausted', resetsAt: 500 };
  const f = fixture({ now: () => clock });
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  f.lifecycle.recordBudgetWait({ waitId: 'refresh-me', source: 'planner', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 50, blockers: [oldBlocker] });

  clock = 150;
  assert.equal(f.lifecycle.wakeBudget('refresh-me').reason, 'trusted_eligibility_not_true');
  assert.equal(f.lifecycle.disabledBudgetWaits.has('refresh-me'), true);
  const updated = f.lifecycle.rescheduleBudgetWait('refresh-me', { delayMs: 200, blockers: [freshBlocker] });
  assert.equal(updated.nextWakeAt, 350);
  assert.deepEqual(updated.blockers, [freshBlocker]);
  assert.equal(updated.state, 'waiting');
  assert.equal(f.lifecycle.disabledBudgetWaits.has('refresh-me'), false);
  assert.ok(f.lifecycle.timer);
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'waiting_budget');
  assert.equal(f.store.events.replay(projectId).filter((event) => event.eventType === 'objective.budget_woken').length, 0);

  const before = f.store.listBudgetWaits(projectId, objectiveId)[0];
  assert.throws(() => f.lifecycle.rescheduleBudgetWait('refresh-me', { delayMs: 0, blockers: [oldBlocker] }),
    { code: 'budget_wait_delay_invalid' });
  assert.throws(() => f.lifecycle.rescheduleBudgetWait('refresh-me', { delayMs: 10, blockers: [] }),
    { code: 'budget_wait_blockers_invalid' });
  assert.deepEqual(f.store.listBudgetWaits(projectId, objectiveId)[0], before);

  f.lifecycle.budgetWakeEligibility = () => true;
  clock = 350;
  assert.equal(f.lifecycle.wakeBudget('refresh-me').state, 'woken');
  assert.throws(() => f.lifecycle.rescheduleBudgetWait('refresh-me', { delayMs: 200, blockers: [freshBlocker] }),
    { code: 'budget_wait_not_pending' });
});

test('a later owner pause pins out an earlier budget wake and leaves the wait durable', (t) => {
  let clock = 100;
  let wakes = 0;
  const f = fixture({ now: () => clock, lifecycleOptions: {
    budgetWakeEligibility: () => true, onWake: () => { wakes += 1; },
  } });
  t.after(() => { f.lifecycle.close(); f.db.close(); });

  f.lifecycle.recordBudgetWait({ waitId: 'budget-before-pause', source: 'executor', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 0 });
  f.lifecycle.pause();
  clock += 1;
  assert.equal(f.lifecycle.tick().woke, 0);
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'paused_owner');
  assert.equal(f.store.getLifecycleControl(projectId, objectiveId).cause, 'owner_pause');
  assert.equal(f.store.listBudgetWaits(projectId, objectiveId)[0].state, 'waiting');
  assert.equal(wakes, 0);
});

test('retry and budget writes reject stale lifecycle owner or control pins', (t) => {
  const f = fixture();
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  f.store.transitionLifecycleControl(projectId, objectiveId,
    { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  assert.deepEqual(f.lifecycle.recover(), { state: 'stale', reason: 'control_revision_changed', controlRevision: 2 });
  assert.equal(f.lifecycle.controlRevision, 1);
  assert.throws(() => f.lifecycle.pause({ expectedControlRevision: 2, expectedOwnerGeneration: 0 }), { code: 'control_revision_stale' });
  assert.throws(() => f.lifecycle.recordTransientFailure({ retryId: 'retry-one', kind: 'transient', scopeType: 'objective', scopeId: objectiveId, source: 'planner',
    provider: 'provider-a', model: 'model-a', hypothesisId: 'hyp-one', strategyId: 'strategy-one',
    failureCode: 'rate_limit', attempt: 1 }), { code: 'control_revision_stale' });
  assert.equal(f.store.listLifecycleRetries(projectId, objectiveId).length, 0);

  const resumed = f.store.transitionLifecycleControl(projectId, objectiveId,
    { action: 'resume', expectedControlRevision: 2, expectedOwnerGeneration: 0 });
  const replacement = new DeliveryLifecycle({ store: f.store, executor: f.executor, projectId, objectiveId,
    ownerGeneration: 0, controlRevision: resumed.controlRevision, now: () => 100,
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });
  t.after(() => replacement.close());
  replacement.recordBudgetWait({ waitId: 'new-lifecycle-budget', source: 'planner', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 0 });
  assert.throws(() => f.lifecycle.wakeBudget('new-lifecycle-budget'), { code: 'control_revision_stale' });
  assert.equal(f.store.listBudgetWaits(projectId, objectiveId)[0].state, 'waiting');

  const second = fixture();
  t.after(() => { second.lifecycle.close(); second.db.close(); });
  second.store.advanceOwnerGeneration(projectId, objectiveId, 0);
  assert.throws(() => second.lifecycle.recordBudgetWait({ waitId: 'stale-budget', source: 'planner', provider: 'provider-a',
    model: 'model-a', reasonCode: 'rate_limit', delayMs: 10 }), { code: 'owner_generation_stale' });
  assert.equal(second.store.listBudgetWaits(projectId, objectiveId).length, 0);
});

test('non-planner retry wakeups stay out of lead-model admission', (t) => {
  let clock = 100;
  let plannerWakes = 0;
  const dueRecords = [];
  const f = fixture({ now: () => clock, lifecycleOptions: {
    onWake: () => { plannerWakes += 1; }, onRetryDue: (retry) => dueRecords.push(retry),
  } });
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  f.lifecycle.recordTransientFailure({ retryId: 'transient-objective', kind: 'transient', scopeType: 'objective',
    scopeId: objectiveId, source: 'executor', provider: 'provider-a', model: 'model-a', hypothesisId: 'hyp-one',
    strategyId: 'retry-one', failureCode: 'rate_limit', attempt: 1 });
  clock += 250;
  assert.equal(f.lifecycle.tick().woke, 1);
  assert.equal(plannerWakes, 0);
  assert.equal(dueRecords.length, 1);
  assert.equal(dueRecords[0].state, 'due');
});

test('shutdown projection defaults unknown admission and publication effects to unsafe', (t) => {
  const f = fixture();
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  const projection = f.lifecycle.shutdownProjection();
  assert.equal(projection.admissionStopped, false);
  assert.equal(projection.effectsSettled, false);
  assert.equal(projection.safeToRelease, false);
  assert.ok(projection.reasons.includes('admission_not_stopped_or_unknown'));
  assert.ok(projection.reasons.includes('publication_effect_settlement_unproven'));
});

test('planner validation retry requires exact prior-turn proof while thrown turn errors stay held', async (t) => {
  let clock = 100;
  let proofCalls = 0;
  let wakeReasons = [];
  const f = fixture({ now: () => clock, lifecycleOptions: {
    planner: { markPriorTurnRecoveryEligible() { assert.fail('validation recovery must use exact reconciliation proof'); } },
    plannerRecoveryProofAdapter: (input) => {
      proofCalls += 1;
      return { projectId: input.projectId, sessionId: input.sessionId, turnId: input.turnId,
        providerThreadId: input.providerThreadId, providerScope: input.providerScope, ownerGeneration: input.ownerGeneration,
        remoteQuiescent: true, processQuiescent: true };
    },
    plannerRetryIdentity: () => ({ source: 'planner', provider: 'provider-a', model: 'model-a', kind: 'planner_invalid' }),
    onWake: (reason) => wakeReasons.push(reason), baseRetryDelayMs: 10, maxRetryDelayMs: 10,
  } });
  t.after(() => { f.lifecycle.close(); f.db.close(); });

  const thrown = f.lifecycle.handlePlannerFailure({ failureCode: 'planner_output_invalid', turn: {
    turnId: 'turn-thrown', providerThreadId: 'thread-one', providerScope: 'transport-one',
    ownerGeneration: 0, outputReturned: false,
  } });
  assert.equal(thrown.state, 'held');
  assert.equal(proofCalls, 0);
  assert.equal(f.store.listLifecycleRetries(projectId, objectiveId).length, 0);

  const first = f.lifecycle.handlePlannerFailure({ failureCode: 'planner_output_invalid', turn: {
    turnId: 'turn-validation-one', providerThreadId: 'thread-one', providerScope: 'transport-one',
    ownerGeneration: 0, outputReturned: true, recoveryProposal: { hypothesisId: 'hyp-one', strategyId: 'correct-one' },
  } });
  assert.equal(first.state, 'scheduled');
  assert.equal(proofCalls, 1);
  const prior = { projectId, sessionId, turnId: 'turn-validation-one', providerThreadId: 'thread-one',
    providerScope: 'transport-one', ownerGeneration: 0 };
  const reconciled = await f.lifecycle.reconcilePriorTurn(prior, async (identity) => {
    assert.deepEqual(identity.recoveryEligibility, { projectId, sessionId, turnId: prior.turnId,
      providerThreadId: 'thread-one', providerScope: 'transport-one', ownerGeneration: 0,
      remoteQuiescent: true, processQuiescent: true, state: 'recovery_eligible' });
    return { state: 'no_effect', ...prior, remoteQuiescent: true, processQuiescent: true };
  });
  assert.equal(reconciled.state, 'no_effect');

  clock = 110;
  assert.equal(f.lifecycle.tick().woke, 1);
  assert.deepEqual(wakeReasons, ['lifecycle.retry.due']);
  assert.equal(f.store.listLifecycleRetries(projectId, objectiveId)[0].state, 'due');
});

test('two failed corrections of one strategy block technical recovery durably', (t) => {
  let clock = 100;
  const f = fixture({ now: () => clock, maxLifecycleStrategies: 1, lifecycleOptions: {
    planner: { markPriorTurnRecoveryEligible() {} },
    plannerRecoveryProofAdapter: (input) => ({ projectId: input.projectId, sessionId: input.sessionId,
      turnId: input.turnId, providerThreadId: input.providerThreadId, providerScope: input.providerScope,
      ownerGeneration: input.ownerGeneration, remoteQuiescent: true, processQuiescent: true }),
    plannerRetryIdentity: () => ({ source: 'planner', provider: 'provider-a', model: 'model-a', kind: 'planner_invalid' }),
    baseRetryDelayMs: 10, maxRetryDelayMs: 10,
  } });
  t.after(() => { f.lifecycle.close(); f.db.close(); });
  const failedTurn = (turnId) => f.lifecycle.handlePlannerFailure({ failureCode: 'planner_output_invalid', turn: {
    turnId, providerThreadId: 'thread-one', providerScope: 'transport-one', ownerGeneration: 0,
    outputReturned: true, recoveryProposal: { hypothesisId: 'hyp-one', strategyId: 'correct-one' },
  } });

  assert.equal(failedTurn('validation-one').state, 'scheduled');
  clock = 110;
  assert.equal(f.lifecycle.tick().woke, 1);
  const second = failedTurn('validation-two');
  assert.equal(second.state, 'blocked_technical');
  assert.equal(f.store.getObjective(projectId, objectiveId).disposition, 'blocked_technical');
  assert.equal(f.store.listLifecycleRetries(projectId, objectiveId)[0].state, 'blocked');
});

test('restart during retry backoff restores the persisted wake time', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-backoff-reopen-'));
  const file = path.join(directory, 'state.sqlite');
  let clock = 100;
  const first = fixture({ file, now: () => clock });
  let reopenedDb;
  let reopenedLifecycle;
  t.after(() => {
    first.lifecycle.close();
    if (first.db.open) first.db.close();
    if (reopenedLifecycle) reopenedLifecycle.close();
    if (reopenedDb?.open) reopenedDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const recorded = first.lifecycle.recordTransientFailure({ retryId: 'persisted-retry', kind: 'transient', scopeType: 'objective', scopeId: objectiveId, source: 'executor',
    provider: 'provider-a', model: 'model-a', hypothesisId: 'hypothesis-a', strategyId: 'strategy-a',
    failureCode: 'rate_limit', attempt: 1 });
  assert.equal(recorded.nextWakeAt, 350);
  first.lifecycle.close();
  first.db.close();

  clock = 350;
  reopenedDb = new Database(file);
  const reopenedStore = new BacklogStore(reopenedDb, { now: () => clock, roleCapacities: { engineer: 2 },
    maxActiveTurns: 3, plannerReservedSlots: 1, maxLifecycleStrategies: 2 });
  const reopenedExecutor = makeExecutor(reopenedDb, reopenedStore);
  const wakes = [];
  reopenedLifecycle = new DeliveryLifecycle({ store: reopenedStore, executor: reopenedExecutor, projectId, objectiveId,
    now: () => clock, onRetryDue: (retry) => wakes.push(retry.state), setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });
  assert.equal(reopenedLifecycle.tick().woke, 1);
  assert.equal(reopenedStore.listLifecycleRetries(projectId, objectiveId)[0].state, 'due');
  assert.deepEqual(wakes, ['due']);
});
