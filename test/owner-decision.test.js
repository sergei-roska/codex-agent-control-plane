'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { LeadPlanner } = require('../src/lead-planner');
const { DeliveryInbox } = require('../src/delivery-inbox');
const { DeliveryLifecycle } = require('../src/delivery-lifecycle');

function fixture(t, { file = ':memory:', authorized = true } = {}) {
  const db = new Database(file);
  t.after(() => { if (db.open) db.close(); });
  const store = new BacklogStore(db, { ownerDecisionAuthorized: () => authorized,
    ownerCorrectionAuthorized: () => true, selectedSettingsResolver: () => ({}), roleCapacities: { explorer: 2, engineer: 2 } });
  if (!store.getObjective('p', 'o')) {
    store.createObjective({ projectId: 'p', objectiveId: 'o', sessionId: 's', legacyRunId: 'run', engineVersion: 'delivery/v1',
      goalRevision: 1, authorityRevision: 1, controlRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`,
      checksDigest: `sha256:${'b'.repeat(64)}`, disposition: 'executing' });
    store.applyPlan('p', 'o', { schemaVersion: 'delivery/v1', expectedPlanRevision: 0, nextPlanRevision: 1,
      expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 1, dependencies: [],
      tasks: [{ task: { schemaVersion: 'delivery/v1', projectId: 'p', objectiveId: 'o', taskId: 'investigate', revision: 1,
        role: 'explorer', kind: 'investigation', objective: 'Investigate owner-only requirement options.', priority: 1, dependencies: [],
        productWritePaths: [], scratchWriteRoots: [], readScope: { kind: 'known', paths: [] }, resourceClaims: [],
        publicationAuthority: { state: 'denied', reason: 'Read-only investigation.' }, state: 'queued' } }] });
    const claimed = store.claimReady('p', 'o', 0, { controlRevision: 1 })[0];
    store.settleAttempt('p', 'o', claimed.attempt.attemptId, claimed.claim.fencingToken,
      { state: 'succeeded', trusted: true, summary: 'Requirements need an owner choice.' },
      { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true, evidenceRefs: ['private:investigation-report'] });
  }
  const attempt = store.listAttempts('p', 'o')[0];
  const request = { decisionId: 'requirement-choice', reason: 'prd_requirement_change', question: 'Which requirement should apply?',
    options: [{ id: 'keep', description: 'Keep the current requirement.' }, { id: 'change', description: 'Request an explicit requirement correction.' }],
    recommendation: 'keep', evidenceRefs: [`attempt:${attempt.attemptId}`], obligations: [{ kind: 'objective_acceptance', id: 'o' }] };
  const register = () => store.registerOwnerDecision('p', 'o', request, { sourceTurnId: 'planner-turn', expected: store.ownerDecisionPins('p', 'o') });
  const response = (decision, extra = {}) => ({ runId: 'run', projectId: 'p', sessionId: 's', objectiveId: 'o', messageId: 'reply',
    decisionId: request.decisionId, requestDigest: decision.digest, optionId: 'keep', ...store.ownerDecisionPins('p', 'o'), ...extra });
  return { db, store, request, register, response };
}

for (const defect of ['routine', 'no-investigation', 'unknown-evidence', 'untrusted', 'writable', 'stale-investigation', 'obligation', 'option', 'extra']) {
  test(`owner decision rejects ${defect} without creating a wait`, (t) => {
    const fx = fixture(t); const input = structuredClone(fx.request);
    if (defect === 'routine') input.reason = 'implementation';
    if (defect === 'no-investigation') input.evidenceRefs = [];
    if (defect === 'unknown-evidence') input.evidenceRefs = ['attempt:invented'];
    if (defect === 'obligation') input.obligations[0].id = 'other-objective';
    if (defect === 'option') input.recommendation = 'invented';
    if (defect === 'extra') input.authorized = true;
    if (['untrusted', 'writable', 'stale-investigation'].includes(defect)) {
      const row = fx.db.prepare('SELECT record_json,contract_json FROM backlog_attempts').get();
      const attempt = JSON.parse(row.record_json); const contract = JSON.parse(row.contract_json);
      if (defect === 'untrusted') attempt.outcome.trusted = false;
      if (defect === 'stale-investigation') attempt.capturedControls.goalRevision += 1;
      if (defect === 'writable') contract.productWritePaths = ['source.txt'];
      fx.db.prepare('UPDATE backlog_attempts SET record_json=?,contract_json=?').run(JSON.stringify(attempt), JSON.stringify(contract));
    }
    assert.throws(() => fx.store.registerOwnerDecision('p', 'o', input, { sourceTurnId: 'turn', expected: fx.store.ownerDecisionPins('p', 'o') }));
    assert.equal(fx.store.pendingOwnerDecision('p', 'o'), null);
    assert.equal(fx.store.getObjective('p', 'o').disposition, 'executing');
  });
}

test('owner request fences direct claims and finalization even if disposition is corrupted', (t) => {
  const fx = fixture(t); const decision = fx.register();
  assert.equal(decision.pins.expectedControlRevision, 2);
  assert.equal(fx.store.getLifecycleControl('p', 'o').cause, 'owner_decision');
  const row = JSON.parse(fx.db.prepare('SELECT record_json FROM backlog_objectives').get().record_json);
  row.disposition = 'executing'; fx.db.prepare('UPDATE backlog_objectives SET record_json=?').run(JSON.stringify(row));
  assert.deepEqual(fx.store.claimReady('p', 'o', 0, { controlRevision: 2 }), []);
  assert.throws(() => fx.store.applyPlan('p', 'o', {}), { code: 'owner_decision_pending' });
  fx.store.finalizationAuthorized = () => true;
  const adapters = { candidateStore: { db: fx.db, get() {}, readManifest() {}, addReference() {}, removeReference() {} },
    reviewStore: { db: fx.db, finalizationProjection() {} },
    lifecycle: { db: fx.db, store: fx.store, projectId: 'p', objectiveId: 'o', shutdownProjection() {} } };
  const finalization = { finalizationId: 'blocked-finalization', kind: 'accepted', expectedOwnerGeneration: 0,
    expectedControlRevision: 2, expectedGoalRevision: 1, expectedPlanRevision: 1, expectedAuthorityRevision: 1,
    requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`, candidateId: 'candidate',
    integrationGeneration: 1, manifestDigest: `sha256:${'c'.repeat(64)}`, sourceHead: null,
    environmentDigest: `sha256:${'d'.repeat(64)}`, checkIdentity: 'check', checkContractDigest: `sha256:${'e'.repeat(64)}`,
    checkSource: 'owner', requiredCheckIds: [], requiredRoles: ['verifier'], executionPermissions: 'inherit', scratchEnabled: false,
    partialLedger: null };
  assert.throws(() => fx.store.beginFinalization('p', 'o', finalization, adapters), { code: 'owner_decision_pending' });
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM backlog_finalizations').get().n, 0);
});

test('owner replies require exact authorization, scope, option, request and current pins', (t) => {
  const fx = fixture(t); const decision = fx.register(); const original = fx.response(decision);
  for (const patch of [{ projectId: 'other' }, { sessionId: 'other' }, { optionId: 'invented' }, { requestDigest: `sha256:${'0'.repeat(64)}` },
    { expectedPlanRevision: 99 }, { expectedGoalRevision: 99 }, { expectedAuthorityRevision: 99 }, { expectedControlRevision: 99 }, { expectedOwnerGeneration: 99 }, { extra: true }]) {
    assert.throws(() => fx.store.controlOwnerDecision('p', 'o', { ...original, ...patch }));
    assert.equal(fx.store.pendingOwnerDecision('p', 'o').digest, decision.digest);
  }
  fx.store.ownerDecisionAuthorized = () => false;
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', original), { code: 'owner_decision_unauthorized' });
  fx.store.ownerDecisionAuthorized = () => true;
  const result = fx.store.controlOwnerDecision('p', 'o', original);
  assert.equal(result.resume, true); assert.equal(fx.store.getObjective('p', 'o').disposition, 'executing');
  fx.store.transitionLifecycleControl('p', 'o', { action: 'cancel', expectedControlRevision: result.pins.expectedControlRevision, expectedOwnerGeneration: 0 });
  assert.equal(fx.store.controlOwnerDecision('p', 'o', original).duplicate, true);
  assert.equal(fx.store.getObjective('p', 'o').disposition, 'canceled');
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', { ...original, optionId: 'change' }), { code: 'message_id_conflict' });
});

test('legacy requestControl cannot resume through a pending owner decision', (t) => {
  const fx = fixture(t); fx.register();
  const paused = fx.store.requestControl('p', 'o', 'pause', 2);
  assert.equal(paused.disposition, 'paused_owner');
  assert.throws(() => fx.store.requestControl('p', 'o', 'resume', paused.controlRevision), { code: 'owner_decision_pending' });
  assert.equal(fx.store.getObjective('p', 'o').disposition, 'paused_owner');
  assert.equal(fx.store.getLifecycleControl('p', 'o').cause, 'owner_pause');
  assert.ok(fx.store.pendingOwnerDecision('p', 'o'));
});

for (const action of ['pause', 'stop', 'cancel']) test(`owner reply preserves later ${action}`, (t) => {
  const fx = fixture(t); const decision = fx.register();
  fx.store.transitionLifecycleControl('p', 'o', { action, expectedControlRevision: 2, expectedOwnerGeneration: 0 });
  if (action === 'cancel') {
    assert.throws(() => fx.store.controlOwnerDecision('p', 'o', fx.response(decision)), { code: 'owner_decision_controlled' });
    assert.equal(fx.store.getObjective('p', 'o').disposition, 'canceled');
  } else {
    assert.throws(() => fx.store.transitionLifecycleControl('p', 'o', { action: 'resume', expectedControlRevision: 3, expectedOwnerGeneration: 0 }), { code: 'owner_decision_pending' });
    const resolved = fx.store.controlOwnerDecision('p', 'o', fx.response(decision));
    assert.equal(resolved.resume, false);
    assert.equal(fx.store.getObjective('p', 'o').disposition, 'paused_owner');
    assert.equal(fx.store.getLifecycleControl('p', 'o').cause, action === 'stop' ? 'owner_stop' : 'owner_pause');
    fx.store.transitionLifecycleControl('p', 'o', { action: 'resume', expectedControlRevision: resolved.pins.expectedControlRevision, expectedOwnerGeneration: 0 });
    assert.equal(fx.store.getObjective('p', 'o').disposition, 'executing');
  }
});

test('changed goal requires authenticated replacement with revalidated investigation and retained history', (t) => {
  const fx = fixture(t); const decision = fx.register(); const oldResponse = fx.response(decision);
  fx.store.applyOwnerCorrection('p', 'o', { sourceMessageId: 'correction', expectedGoalRevision: 1, expectedAuthorityRevision: 1,
    expectedControlRevision: 2, requirementDigest: `sha256:${'c'.repeat(64)}` });
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', fx.response(decision)), { code: 'owner_decision_request_stale' });
  const { requestDigest, optionId, ...shared } = fx.response(decision);
  const replacement = { ...shared, messageId: 'replace', oldRequestDigest: requestDigest, replacement: fx.request };
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', replacement, { replace: true }), { code: 'owner_decision_investigation_required' });
  assert.equal(fx.store.listOwnerDecisions('p', 'o').length, 1);
  const originalAttempt = fx.store.listAttempts('p', 'o')[0];
  fx.store.ownerDecisionEvidenceAuthorized = (facts) => ({ state: 'revalidated', originalRequestDigest: facts.originalRequestDigest,
    currentPins: facts.currentPins, attemptId: facts.attempt.attemptId, originalControls: facts.attempt.capturedControls });
  const result = fx.store.controlOwnerDecision('p', 'o', replacement, { replace: true });
  assert.notEqual(result.decision.digest, decision.digest); assert.equal(result.resume, false);
  assert.deepEqual(fx.store.listAttempts('p', 'o')[0], originalAttempt);
  assert.equal(result.decision.revalidations[0].originalControls.goalRevision, 1);
  assert.deepEqual(fx.store.listOwnerDecisions('p', 'o').map((item) => item.state), ['superseded', 'pending']);
  assert.equal(fx.store.controlOwnerDecision('p', 'o', replacement, { replace: true }).duplicate, true);
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', { ...oldResponse, ...fx.store.ownerDecisionPins('p', 'o') }), { code: 'owner_decision_request_stale' });
  assert.equal(fx.store.controlOwnerDecision('p', 'o', fx.response(result.decision)).state, 'resolved');
});

test('planner request registration is atomic, consumes trigger and makes no owner wait model loop', async (t) => {
  const fx = fixture(t); const inbox = new DeliveryInbox(fx.db, { projectId: 'p', objectiveId: 'o', sessionId: 's' });
  let calls = 0;
  const planner = new LeadPlanner({ store: fx.store, inbox, providerThreadId: 'lead', runTurn: async ({ prompt }) => {
    calls += 1;
    return { expected: prompt.pins, delta: null, dialogue: null, recovery: null, ownerDecision: fx.request };
  } });
  inbox.signal('investigation.complete');
  assert.equal((await planner.run()).decision.request.decisionId, fx.request.decisionId);
  assert.equal(inbox.projection().wakeup, false);
  inbox.signal('unrelated.event');
  assert.equal((await planner.run()).state, 'blocked'); assert.equal(calls, 1);
  const lifecycle = new DeliveryLifecycle({ store: fx.store, executor: { db: fx.db, recover() {}, getAttempt() {} }, projectId: 'p', objectiveId: 'o',
    effectsSettledForShutdown: () => true, getAdmissionState: () => ({ admissionStopped: true }) });
  t.after(() => lifecycle.close());
  assert.equal(lifecycle.projection().ownerDecisions[0].state, 'pending');
  assert.equal(lifecycle.shutdownProjection().safeToRelease, true);
});

test('planner answer cannot register a decision after owner control changes during its await', async (t) => {
  const fx = fixture(t); const inbox = new DeliveryInbox(fx.db, { projectId: 'p', objectiveId: 'o', sessionId: 's' });
  let startTurn; let returnTurn;
  const started = new Promise((resolve) => { startTurn = resolve; });
  const output = new Promise((resolve) => { returnTurn = resolve; });
  const planner = new LeadPlanner({ store: fx.store, inbox, providerThreadId: 'lead', runTurn: async ({ prompt }) => {
    startTurn(prompt);
    await output;
    return { expected: prompt.pins, delta: null, dialogue: null, recovery: null, ownerDecision: fx.request };
  } });
  inbox.signal('investigation.complete');
  const running = planner.run();
  await started;
  fx.store.transitionLifecycleControl('p', 'o', { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
  returnTurn();
  const result = await running;
  assert.equal(result.state, 'stale'); assert.equal(result.reason, 'revision_changed');
  assert.equal(fx.store.pendingOwnerDecision('p', 'o'), null);
  assert.equal(fx.store.getObjective('p', 'o').disposition, 'paused_owner');
});

test('owner wait survives SQLite reopen with immutable digest and exact reply pins', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-decision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.sqlite'); const first = fixture(t, { file });
  const decision = first.register(); first.db.close();
  const reopened = fixture(t, { file });
  assert.deepEqual(reopened.store.pendingOwnerDecision('p', 'o'), decision);
  assert.equal(reopened.store.controlOwnerDecision('p', 'o', reopened.response(decision)).state, 'resolved');
});
