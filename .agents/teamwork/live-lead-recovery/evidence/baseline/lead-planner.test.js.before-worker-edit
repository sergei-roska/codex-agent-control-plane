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
const { VERSION } = require('../src/delivery-contracts');

function fixture(runTurn, { providerThreadId = 'planner-test-thread', contextFor, authorizeRecovery, reconcilePriorTurn, trustedPreDispatchError, file = ':memory:' } = {}) {
  const db = new Database(file);
  const store = new BacklogStore(db, { roleCapacities: { engineer: 3 }, maxActiveTurns: 4 });
  if (!store.getObjective('p', 'o')) store.createObjective({ projectId: 'p', objectiveId: 'o', sessionId: 's', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  const inbox = new DeliveryInbox(db, { projectId: 'p', sessionId: 's', objectiveId: 'o' });
  const planner = new LeadPlanner({ store, inbox, runTurn, providerThreadId, contextFor, authorizeRecovery, reconcilePriorTurn, trustedPreDispatchError });
  return { db, store, inbox, planner };
}

function task(taskId) {
  return { schemaVersion: VERSION, projectId: 'p', objectiveId: 'o', taskId, revision: 1, role: 'engineer', kind: 'implementation', objective: 'Implement the accepted feature', priority: 1, dependencies: [], productWritePaths: [`src/${taskId}.js`], readScope: { kind: 'known', paths: [] }, scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' };
}

function output(pins, delta = null) {
  return { expected: { planRevision: pins.planRevision, goalRevision: pins.goalRevision, authorityRevision: pins.authorityRevision, controlRevision: pins.controlRevision, inboxVersion: pins.inboxVersion }, delta, dialogue: 'bounded response', recovery: null, ownerDecision: null };
}

test('versioned delta adds a successor without waiting for worker records', async (t) => {
  let made;
  const { db, store, inbox, planner } = fixture(async ({ prompt }) => {
    made = prompt;
    return output(prompt.pins, { schemaVersion: VERSION, expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task: task('successor') }], dependencies: [] });
  });
  t.after(() => db.close());
  inbox.receive({ messageId: 'm1', kind: 'steering', payload: { instruction: 'Prepare one useful successor' } });
  const result = await planner.run('owner_message');
  assert.equal(result.state, 'complete');
  assert.equal(made.projection.inbox.pending[0].messageId, 'm1');
  assert.equal(store.getObjective('p', 'o').tasks[0].taskId, 'successor');
  assert.equal(result.changed, true);
});

test('new inbox receipt invalidates a running plan before it can mutate backlog', async (t) => {
  let release;
  let entered;
  const isEntered = new Promise((resolve) => { entered = resolve; });
  const turnBarrier = new Promise((resolve) => { release = resolve; });
  const { db, store, inbox, planner } = fixture(async ({ prompt }) => {
    entered(prompt);
    await turnBarrier;
    return output(prompt.pins, { schemaVersion: VERSION, expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task: task('stale') }], dependencies: [] });
  });
  t.after(() => db.close());
  inbox.receive({ messageId: 'm1', kind: 'steering', payload: { instruction: 'Start' } });
  const first = planner.run();
  const prompt = await isEntered;
  inbox.receive({ messageId: 'm2', kind: 'steering', payload: { instruction: 'Change priority' } });
  release();
  const result = await first;
  assert.equal(result.state, 'stale');
  assert.equal(result.reason, 'inbox_changed');
  assert.equal(result.messageIds.includes('m1'), true);
  assert.equal(store.getObjective('p', 'o').tasks.length, 0);
  assert.equal(planner.listEvidence()[0].state, 'stale');
  assert.equal(prompt.pins.inboxVersion < inbox.projection().version, true);
});

test('one provider thread cannot run overlapping planner turns and empty wake is idle', async (t) => {
  let release;
  let entered;
  const isEntered = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const { db, inbox, planner, store } = fixture(async ({ prompt }) => { entered(); await barrier; return output(prompt.pins); });
  t.after(() => db.close());
  assert.equal((await planner.run()).reason, 'no_trigger');
  inbox.receive({ messageId: 'm1', kind: 'steering', payload: { instruction: 'Review current state' } });
  const first = planner.run();
  await isEntered;
  const other = new LeadPlanner({ store, inbox, providerThreadId: 'planner-test-thread', runTurn: async () => output({}) });
  assert.deepEqual(await other.run(), { state: 'busy', reason: 'provider_thread_busy', turnId: planner.projection().lastTurn.turn_id });
  release();
  assert.equal((await first).state, 'complete');
});

test('a planner cannot authorize itself by returning a newer captured revision', async (t) => {
  let calls = 0;
  const { db, store, inbox, planner } = fixture(async ({ prompt }) => {
    calls += 1;
    const answer = output(prompt.pins, { schemaVersion: VERSION, expectedPlanRevision: prompt.pins.planRevision,
      expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
      expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
      tasks: [{ task: task('forged') }], dependencies: [] });
    answer.expected.goalRevision += 1;
    return answer;
  });
  t.after(() => db.close());
  inbox.receive({ messageId: 'revision-check', kind: 'steering', payload: { instruction: 'Plan' } });
  await assert.rejects(planner.run(), { code: 'planner_expected_revision_mismatch' });
  assert.equal(calls, 1);
  assert.equal(store.getObjective('p', 'o').tasks.length, 0);
});

test('recovery metadata is structurally bounded and never triggers a fallback turn', async (t) => {
  let calls = 0;
  const { db, store, inbox, planner } = fixture(async ({ prompt }) => {
    calls += 1;
    const answer = output(prompt.pins);
    answer.recovery = { hypotheses: Array.from({ length: 65 }, (_, index) => ({ id: `h${index}`, state: 'pending' })) };
    return answer;
  });
  t.after(() => db.close());
  inbox.receive({ messageId: 'bounded-recovery', kind: 'steering', payload: { instruction: 'Investigate one failure' } });
  await assert.rejects(planner.run(), { code: 'planner_metadata_invalid' });
  assert.equal(calls, 1);
  assert.equal(store.getObjective('p', 'o').tasks.length, 0);
  assert.equal(planner.projection().lastTurn.status, 'unknown');
});

test('active same-thread turns stay busy and never invoke opportunistic reconciliation', async (t) => {
  let release;
  let entered;
  let reconcileCalls = 0;
  const isEntered = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const { db, store, inbox, planner } = fixture(async ({ prompt }) => { entered(); await barrier; return output(prompt.pins); });
  t.after(() => db.close());
  inbox.receive({ messageId: 'live-active', kind: 'steering', payload: { instruction: 'Hold active turn' } });
  const active = planner.run();
  await isEntered;
  const other = new LeadPlanner({ store, inbox, providerThreadId: 'planner-test-thread',
    reconcilePriorTurn: async () => { reconcileCalls += 1; return { state: 'no_effect' }; },
    runTurn: async ({ prompt }) => output(prompt.pins) });
  assert.equal((await other.run()).state, 'busy');
  assert.equal(reconcileCalls, 0);
  assert.equal(db.prepare(`SELECT status FROM delivery_planner_turns WHERE provider_thread_id='planner-test-thread'`).get().status, 'active');
  release();
  assert.equal((await active).state, 'complete');
  inbox.receive({ messageId: 'after-active', kind: 'steering', payload: { instruction: 'Run after release' } });
  assert.equal((await other.run()).state, 'complete');
  assert.equal(reconcileCalls, 0);
});

test('unknown turns require exact no-effect and remote/process quiescence proof before fence release', async (t) => {
  const { db, inbox, planner } = fixture(async () => { throw Object.assign(new Error('turn outcome unknown'), { code: 'test_unknown' }); });
  t.after(() => db.close());
  inbox.receive({ messageId: 'unknown-turn', kind: 'steering', payload: { instruction: 'Recover carefully' } });
  await assert.rejects(planner.run(), { code: 'test_unknown' });
  const oldTurn = planner.projection().lastTurn;
  assert.equal(oldTurn.status, 'unknown');
  assert.equal(JSON.parse(db.prepare('SELECT result_json FROM delivery_planner_turns WHERE turn_id=?').get(oldTurn.turn_id).result_json).preDispatchSource, null);
  let calls = 0;
  let proof = { state: 'no_effect' };
  const recovery = new LeadPlanner({ store: planner.store, inbox, providerThreadId: 'planner-test-thread',
    reconcilePriorTurn: async (prior) => ({ state: proof.state, projectId: prior.projectId, sessionId: prior.sessionId,
      turnId: prior.turnId, providerThreadId: prior.providerThreadId, providerScope: prior.providerScope,
      ownerGeneration: prior.ownerGeneration,
      remoteQuiescent: proof.remoteQuiescent, processQuiescent: proof.processQuiescent }),
    runTurn: async ({ prompt }) => { calls += 1; return output(prompt.pins); } });
  for (const invalid of [
    { state: 'no_effect' },
    { state: 'no_effect', remoteQuiescent: true },
    { state: 'no_effect', remoteQuiescent: true, processQuiescent: false },
  ]) {
    proof = invalid;
    assert.equal((await recovery.run()).reason, 'prior_turn_effect_unknown');
    assert.equal(db.prepare(`SELECT status FROM delivery_planner_turns WHERE turn_id=?`).get(oldTurn.turn_id).status, 'unknown');
  }
  proof = { state: 'no_effect', remoteQuiescent: true, processQuiescent: true };
  assert.equal((await recovery.run()).state, 'complete');
  assert.equal(calls, 1);
});

test('only a trusted local pre-dispatch rejection is labeled as such in the planner ledger', async (t) => {
  const cause = Object.assign(new Error('Expected home changed before dispatch.'), { code: 'provider_home_changed' });
  const { db, inbox, planner } = fixture(async () => { throw cause; }, {
    trustedPreDispatchError: (candidate) => candidate === cause,
  });
  t.after(() => db.close());
  inbox.receive({ messageId: 'pre-dispatch-error', kind: 'steering', payload: { instruction: 'Plan carefully' } });
  await assert.rejects(planner.run(), { code: 'provider_home_changed' });
  const result = JSON.parse(db.prepare('SELECT result_json FROM delivery_planner_turns').get().result_json);
  assert.deepEqual(result, { errorCode: 'provider_home_changed', preDispatchSource: 'switching_app_server.expected_home_preflight' });
});

test('reopened active turns require authorized lifecycle quiescence before reconciliation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-recovery-'));
  const file = path.join(directory, 'state.sqlite');
  let release;
  let entered;
  const isEntered = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const first = fixture(async ({ prompt }) => { entered(); await barrier; return output(prompt.pins); }, { file });
  first.inbox.receive({ messageId: 'crash-active-turn', kind: 'steering', payload: { instruction: 'Run before simulated restart' } });
  const active = first.planner.run();
  await isEntered;
  const prior = first.planner.projection().lastTurn;
  first.db.close();
  const handledOldTurn = active.catch(() => null);

  const reopened = fixture(async ({ prompt }) => output(prompt.pins), {
    file,
    authorizeRecovery: (proof) => proof.projectId === 'p' && proof.sessionId === 's' && proof.turnId === prior.turn_id
      && proof.providerThreadId === 'planner-test-thread' && proof.providerScope === 'default'
      && proof.ownerGeneration === 0
      && proof.remoteQuiescent === true && proof.processQuiescent === true,
    reconcilePriorTurn: async (identity) => ({ state: 'no_effect', projectId: identity.projectId, sessionId: identity.sessionId,
      turnId: identity.turnId, providerThreadId: identity.providerThreadId, providerScope: identity.providerScope,
      ownerGeneration: identity.ownerGeneration,
      remoteQuiescent: true, processQuiescent: true }),
  });
  t.after(() => { if (reopened.db.open) reopened.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const proof = { projectId: 'p', sessionId: 's', turnId: prior.turn_id, providerThreadId: 'planner-test-thread',
    providerScope: 'default', ownerGeneration: 0, remoteQuiescent: true, processQuiescent: true };
  assert.throws(() => reopened.planner.markPriorTurnRecoveryEligible({ ...proof, remoteQuiescent: false }), { code: 'planner_recovery_quiescence_required' });
  const { processQuiescent, ...missingProof } = proof;
  assert.equal(processQuiescent, true);
  assert.throws(() => reopened.planner.markPriorTurnRecoveryEligible(missingProof), { code: 'planner_recovery_proof_invalid' });
  const defaultDenied = new LeadPlanner({ store: reopened.store, inbox: reopened.inbox, providerThreadId: 'planner-test-thread', runTurn: async ({ prompt }) => output(prompt.pins) });
  assert.throws(() => defaultDenied.markPriorTurnRecoveryEligible(proof), { code: 'planner_recovery_unauthorized' });
  assert.equal(reopened.db.prepare(`SELECT status FROM delivery_planner_turns WHERE turn_id=?`).get(prior.turn_id).status, 'active');
  assert.equal(reopened.planner.markPriorTurnRecoveryEligible(proof).state, 'recovery_eligible');
  assert.equal(reopened.db.prepare(`SELECT status FROM delivery_planner_turns WHERE turn_id=?`).get(prior.turn_id).status, 'unknown');
  assert.equal((await reopened.planner.run()).state, 'complete');
  release();
  await handledOldTurn;
});

test('owner takeover stales held and subsequent old-planner turns while the new owner can proceed', async (t) => {
  let release;
  let entered;
  let oldCalls = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const { db, store, inbox, planner } = fixture(async ({ prompt }) => {
    oldCalls += 1;
    entered();
    await barrier;
    return output(prompt.pins, { schemaVersion: VERSION, expectedPlanRevision: prompt.pins.planRevision,
      expectedGoalRevision: prompt.pins.goalRevision, expectedAuthorityRevision: prompt.pins.authorityRevision,
      expectedControlRevision: prompt.pins.controlRevision, nextPlanRevision: prompt.pins.planRevision + 1,
      tasks: [{ task: task('old-owner') }], dependencies: [] });
  });
  t.after(() => db.close());
  inbox.receive({ messageId: 'takeover-steering', kind: 'steering', payload: { instruction: 'Plan under current owner' } });
  const held = planner.run();
  await started;
  store.advanceOwnerGeneration('p', 'o', 0);
  release();
  assert.equal((await held).state, 'stale');
  assert.equal(inbox.get('takeover-steering').state, 'received');
  assert.equal(store.getObjective('p', 'o').tasks.length, 0);
  assert.equal((await planner.run()).reason, 'owner_generation_changed');
  assert.equal(oldCalls, 1);

  const newOwner = new LeadPlanner({ store, inbox, providerThreadId: 'planner-test-thread',
    runTurn: async ({ prompt }) => output(prompt.pins, { schemaVersion: VERSION,
      expectedPlanRevision: prompt.pins.planRevision, expectedGoalRevision: prompt.pins.goalRevision,
      expectedAuthorityRevision: prompt.pins.authorityRevision, expectedControlRevision: prompt.pins.controlRevision,
      nextPlanRevision: prompt.pins.planRevision + 1, tasks: [{ task: task('new-owner') }], dependencies: [] }) });
  assert.equal(newOwner.ownerGeneration, 1);
  assert.equal((await newOwner.run()).state, 'complete');
  assert.deepEqual(store.getObjective('p', 'o').tasks.map((item) => item.taskId), ['new-owner']);
  assert.equal(inbox.get('takeover-steering').state, 'applied');
});

test('owner generation is scoped to its objective on the same project', async (t) => {
  const { db, store, planner } = fixture(async ({ prompt }) => output(prompt.pins));
  t.after(() => db.close());
  store.createObjective({ projectId: 'p', objectiveId: 'other-objective', sessionId: 'other-session', engineVersion: VERSION,
    goalRevision: 1, requirementDigest: `sha256:${'c'.repeat(64)}`, checksDigest: `sha256:${'d'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'planning' });
  const otherInbox = new DeliveryInbox(db, { projectId: 'p', objectiveId: 'other-objective', sessionId: 'other-session' });
  const otherPlanner = new LeadPlanner({ store, inbox: otherInbox, providerThreadId: 'other-objective-thread', runTurn: async ({ prompt }) => output(prompt.pins) });
  planner.inbox.receive({ messageId: 'stale-owner-work', kind: 'steering', payload: { instruction: 'Wait for a new owner' } });
  otherInbox.receive({ messageId: 'other-owner-work', kind: 'steering', payload: { instruction: 'Continue other objective' } });
  store.advanceOwnerGeneration('p', 'o', 0);
  assert.equal((await planner.run()).reason, 'owner_generation_changed');
  assert.equal((await otherPlanner.run()).state, 'complete');
});
