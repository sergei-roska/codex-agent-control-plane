'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require(process.cwd() + '/node_modules/better-sqlite3');
const { BacklogStore } = require(process.cwd() + '/src/backlog-store');
const { LeadPlanner } = require(process.cwd() + '/src/lead-planner');
const { DeliveryInbox } = require(process.cwd() + '/src/delivery-inbox');
const { DeliveryLifecycle } = require(process.cwd() + '/src/delivery-lifecycle');

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


test('failed receipt insert rolls back answer and permits exact retry', (t) => {
  const fx = fixture(t); const decision = fx.register(); const reply = fx.response(decision);
  const pins = fx.store.ownerDecisionPins('p', 'o');
  fx.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON backlog_owner_decision_messages BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', reply), /injected failure/);
  assert.deepEqual(fx.store.pendingOwnerDecision('p', 'o'), decision);
  assert.deepEqual(fx.store.ownerDecisionPins('p', 'o'), pins);
  assert.equal(fx.store.getLifecycleControl('p', 'o').cause, 'owner_decision');
  fx.db.exec('DROP TRIGGER fail_receipt');
  assert.equal(fx.store.controlOwnerDecision('p', 'o', reply).state, 'resolved');
  assert.equal(fx.store.controlOwnerDecision('p', 'o', reply).duplicate, true);
});

test('failed replacement receipt insert rolls back history and retries with paused control retained', (t) => {
  const fx = fixture(t); const original = fx.register();
  fx.store.transitionLifecycleControl('p', 'o', { action: 'stop', expectedControlRevision: 2, expectedOwnerGeneration: 0 });
  fx.store.applyOwnerCorrection('p', 'o', { sourceMessageId: 'correction', expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 3, requirementDigest: `sha256:${'c'.repeat(64)}` });
  fx.store.ownerDecisionEvidenceAuthorized = (facts) => ({ state: 'revalidated', originalRequestDigest: facts.originalRequestDigest, currentPins: facts.currentPins, attemptId: facts.attempt.attemptId, originalControls: facts.attempt.capturedControls });
  const { requestDigest, optionId, ...shared } = fx.response(original);
  const replacement = { ...shared, messageId: 'replace', oldRequestDigest: requestDigest, replacement: fx.request };
  const pins = fx.store.ownerDecisionPins('p', 'o');
  fx.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON backlog_owner_decision_messages BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', replacement, { replace: true }), /injected failure/);
  assert.deepEqual(fx.store.listOwnerDecisions('p', 'o'), [original]);
  assert.deepEqual(fx.store.ownerDecisionPins('p', 'o'), pins);
  assert.equal(fx.store.getLifecycleControl('p', 'o').cause, 'owner_stop');
  fx.db.exec('DROP TRIGGER fail_receipt');
  const result = fx.store.controlOwnerDecision('p', 'o', replacement, { replace: true });
  assert.equal(fx.store.controlOwnerDecision('p', 'o', replacement, { replace: true }).duplicate, true);
  assert.equal(fx.store.controlOwnerDecision('p', 'o', fx.response(result.decision)).resume, false);
  assert.equal(fx.store.getLifecycleControl('p', 'o').cause, 'owner_stop');
});

test('successive replacements keep investigator provenance and fence old replies', (t) => {
  const fx = fixture(t); const first = fx.register(); const attempt = fx.store.listAttempts('p', 'o')[0];
  const evidence = [];
  fx.store.ownerDecisionEvidenceAuthorized = (facts) => {
    evidence.push(facts);
    return { state: 'revalidated', originalRequestDigest: facts.originalRequestDigest, currentPins: facts.currentPins, attemptId: facts.attempt.attemptId, originalControls: facts.attempt.capturedControls };
  };
  const replacement = (old, id) => {
    const { requestDigest, optionId, ...shared } = fx.response(old);
    return { ...shared, messageId: id, oldRequestDigest: requestDigest, replacement: fx.request };
  };
  fx.store.applyOwnerCorrection('p', 'o', { sourceMessageId: 'correction1', expectedGoalRevision: 1, expectedAuthorityRevision: 1, expectedControlRevision: 2, requirementDigest: `sha256:${'c'.repeat(64)}` });
  const second = fx.store.controlOwnerDecision('p', 'o', replacement(first, 'replace1'), { replace: true }).decision;
  fx.store.applyOwnerCorrection('p', 'o', { sourceMessageId: 'correction2', expectedGoalRevision: fx.store.ownerDecisionPins('p', 'o').expectedGoalRevision, expectedAuthorityRevision: fx.store.ownerDecisionPins('p', 'o').expectedAuthorityRevision, expectedControlRevision: fx.store.ownerDecisionPins('p', 'o').expectedControlRevision, requirementDigest: `sha256:${'d'.repeat(64)}` });
  const third = fx.store.controlOwnerDecision('p', 'o', replacement(second, 'replace2'), { replace: true }).decision;
  assert.deepEqual(fx.store.listOwnerDecisions('p', 'o').map(d => d.state), ['superseded', 'superseded', 'pending']);
  assert.deepEqual(fx.store.listAttempts('p', 'o')[0], attempt);
  assert.deepEqual(evidence.map(f => f.attempt.capturedControls), [attempt.capturedControls, attempt.capturedControls]);
  assert.deepEqual(evidence.map(f => f.originalRequestDigest), [first.digest, second.digest]);
  assert.throws(() => fx.store.controlOwnerDecision('p', 'o', fx.response(second)), { code: 'owner_decision_request_stale' });
  assert.equal(fx.store.controlOwnerDecision('p', 'o', fx.response(third)).state, 'resolved');
});
