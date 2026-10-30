'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { BacklogStore } = require('../src/backlog-store');
const { CandidateStore, captureManifest } = require('../src/candidate-store');
const { WriterAdmission } = require('../src/writer-admission');
const { LaneManager } = require('../src/writer-lanes');
const { DeliveryOutputArtifacts } = require('../src/delivery-output-artifacts');
const { readProcessIdentity, isProcessGroupGone } = require('../src/process-quiescence');

const PROJECT = 'artifact-project';
const OBJECTIVE = 'artifact-objective';
const ENVIRONMENT = 'a'.repeat(64);

function fixture(t, { settle = true, producerIdentity = readProcessIdentity(process.pid), ownerCorrectionAuthorized = () => false,
  environmentDigest = ENVIRONMENT } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-artifacts-'));
  const workspace = path.join(root, 'repo');
  const lanesRoot = path.join(root, 'lanes');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(stateDir);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Artifact Test'); git('config', 'user.email', 'artifact@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'base\n');
  // Locale collation differs from the manifest's canonical path order.
  for (const name of ['README.md', 'a.txt', 'Z.txt', '_metadata.txt']) {
    fs.writeFileSync(path.join(workspace, name), 'stable\n');
  }
  git('add', '.'); git('commit', '-qm', 'base');
  const dbPath = path.join(stateDir, 'state.sqlite');
  const db = new Database(dbPath);
  const admission = new WriterAdmission({ db, workspace, settleMs: 100 });
  const backlog = new BacklogStore(db, { roleCapacities: { engineer: 1 }, maxActiveTurns: 2, plannerReservedSlots: 1,
    ownerCorrectionAuthorized });
  backlog.createObjective({ projectId: PROJECT, objectiveId: OBJECTIVE, sessionId: 'session', engineVersion: 'delivery-v1',
    goalRevision: 1, requirementDigest: `sha256:${'b'.repeat(64)}`, checksDigest: `sha256:${'c'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const task = { schemaVersion: 'delivery/v1', projectId: PROJECT, objectiveId: OBJECTIVE, taskId: 'task-1', revision: 1,
    role: 'engineer', kind: 'implementation', objective: 'Edit source.', priority: 0, dependencies: [],
    productWritePaths: ['source.txt'], readScope: { kind: 'unknown', paths: null, reason: 'Not established.' },
    scratchWriteRoots: ['.scratch'], resourceClaims: [], publicationAuthority: { state: 'unknown' }, state: 'queued' };
  backlog.applyPlan(PROJECT, OBJECTIVE, { schemaVersion: 'delivery/v1', expectedPlanRevision: 0, expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, nextPlanRevision: 1, tasks: [{ task }], dependencies: [] });
  const claimed = backlog.claimReady(PROJECT, OBJECTIVE, 0, { controlRevision: 1 })[0];
  backlog.pinSelectedSettings(PROJECT, OBJECTIVE, claimed.attempt.attemptId, claimed.claim.fencingToken, { model: 'test-model', effort: 'high' });
  if (settle) {
    backlog.recordSubmitted(PROJECT, OBJECTIVE, claimed.attempt.attemptId, claimed.claim.fencingToken, 'remote-task');
    backlog.settleAttempt(PROJECT, OBJECTIVE, claimed.attempt.attemptId, claimed.claim.fencingToken,
      { state: 'succeeded', trusted: true, outputContract: 'output:v1' },
      { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true });
  }
  const laneManager = new LaneManager({ db, workspace, admission, mode: 'worktree', lanesRoot, links: [] });
  let candidateStore;
  const authorization = { allowed: true, calls: 0 };
  const bridge = new DeliveryOutputArtifacts({ db, backlogStore: backlog, laneManager, admission, workspace,
    storageDir: path.join(stateDir, 'artifacts'), authorizeBinding: () => { authorization.calls += 1; return authorization.allowed; },
    producerEvidenceFor: (binding) => ({ projectId: binding.projectId, objectiveId: binding.objectiveId, taskId: binding.taskId,
      attemptId: binding.attemptId, fencingToken: binding.fencingToken, providerContextId: binding.providerContextId,
      providerThreadId: 'provider-thread-1', providerTurnId: 'provider-turn-1', terminalStatus: 'completed',
      providerThreadReceipt: { processIdentity: producerIdentity, threadId: 'provider-thread-1', turnId: 'provider-turn-1',
        turnStartSent: true, turnStartRejected: false, turnTerminal: true },
      remoteQuiescent: true, processQuiescent: true, effectsSettled: true, evidenceDigest: `sha256:${'d'.repeat(64)}` }) });
  candidateStore = new CandidateStore({ db, workspace, storageDir: path.join(stateDir, 'candidates'), ...bridge.candidateStoreOptions() });
  bridge.attachCandidateStore(candidateStore);
  const base = candidateStore.createCandidate({ candidateId: 'base-candidate', projectId: PROJECT, objectiveId: OBJECTIVE,
    integrationGeneration: 1, sourceAttemptId: 'initial-attempt', environmentDigest, checkIdentity: 'checks-v1' });
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, lanesRoot, stateDir, dbPath, db, admission, backlog, laneManager, bridge, candidateStore, base,
    claim: claimed, authorization, environmentDigest };
}

async function prepareLane(fx) {
  const { attempt, claim } = fx.claim;
  const prepared = await fx.laneManager.prepare({ contextId: attempt.providerContextId, taskId: attempt.attemptId });
  assert.ok(prepared.lane);
  fx.laneManager.markRunning(prepared.lane);
  fs.writeFileSync(path.join(prepared.lane.path, 'source.txt'), 'private output\n');
  return prepared.lane;
}

function bind(fx, lane) {
  const { attempt, claim } = fx.claim;
  return fx.bridge.bind({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: attempt.taskId, attemptId: attempt.attemptId,
    fencingToken: claim.fencingToken, laneId: lane.id, baseCandidateId: fx.base.candidateId,
    declaredWritePaths: ['source.txt'], environmentDigest: fx.environmentDigest, checkIdentity: 'checks-v2' });
}

test('captures a private immutable artifact and publishes it through real admission and detached Git apply', async (t) => {
  const fx = fixture(t);
  const before = captureManifest(fx.workspace);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId, producerEvidence: { source: 'host-receipt' } });
  assert.equal(captureManifest(fx.workspace).digest, before.digest);
  assert.equal(artifact.state, 'captured');
  fs.writeFileSync(path.join(lane.path, 'source.txt'), 'mutated after capture\n');
  const result = await fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'published-candidate', intentId: 'publish-intent', integrationGeneration: 2 });
  assert.equal(result.state, 'applied');
  assert.equal(fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'), 'private output\n');
  assert.equal(result.candidate.parentCandidateId, fx.base.candidateId);
  assert.equal(result.candidate.manifestDigest, artifact.expectedManifest.digest);
  const intent = fx.candidateStore.getIntent('publish-intent');
  assert.equal(intent.state, 'applied');
  assert.ok(intent.processIdentity?.pid > 1);
  assert.equal(isProcessGroupGone(intent.processIdentity), true);
  assert.equal(fx.admission.get(`integration:${fx.claim.attempt.attemptId}`).state, 'released');
  assert.deepEqual(await fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'published-candidate', intentId: 'publish-intent', integrationGeneration: 2 }),
    { ...result, replay: true });
  await assert.rejects(() => fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'other-candidate', intentId: 'publish-intent', integrationGeneration: 2 }),
    { code: 'publication_identity_conflict' });
});

test('preserves bare and prefixed environment digest pins through changed candidate publication', async (t) => {
  for (const environmentDigest of [ENVIRONMENT, `sha256:${'f'.repeat(64)}`]) {
    await t.test(environmentDigest.startsWith('sha256:') ? 'prefixed' : 'bare', async (subtest) => {
      const fx = fixture(subtest, { environmentDigest });
      const lane = await prepareLane(fx);
      const binding = bind(fx, lane);
      assert.equal(binding.binding.environmentDigest, environmentDigest);
      const artifact = fx.bridge.capture({ artifactId: binding.artifactId });
      const published = await fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'digest-pinned-candidate',
        intentId: 'digest-pinned-intent', integrationGeneration: 2 });
      assert.equal(published.candidate.environmentDigest, environmentDigest);
      assert.equal(fx.candidateStore.getIntent('digest-pinned-intent').candidateId, published.candidate.candidateId);
      assert.equal(published.candidate.parentCandidateId, fx.base.candidateId);
      assert.equal(published.candidate.sourceAttemptId, fx.claim.attempt.attemptId);
      assert.equal(published.candidate.integrationGeneration, 2);
    });
  }
});

test('captures a terminal provider thread while its shared provider process remains alive', async (t) => {
  const provider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (provider.exitCode === null) provider.kill('SIGTERM'); });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const providerIdentity = readProcessIdentity(provider.pid);
  assert.equal(typeof providerIdentity.startTime, 'string');
  assert.equal(isProcessGroupGone(providerIdentity), false);
  const fx = fixture(t, { producerIdentity: providerIdentity });
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId, producerEvidence: { terminalEvent: 'turn/completed' } });
  assert.equal(artifact.producerEvidence.providerThreadReceipt.processIdentity.pid, provider.pid);
  assert.equal(isProcessGroupGone(providerIdentity), false);
});

test('syncs content-addressed blob directories before committing the artifact row', async (t) => {
  const fx = fixture(t);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const blobRoot = path.join(fx.stateDir, 'artifacts', 'blobs');
  const synced = [];
  const syncDirectory = fx.bridge.syncDirectory;
  fx.bridge.syncDirectory = (directory) => {
    syncDirectory(directory);
    if (directory.startsWith(`${blobRoot}${path.sep}`)) {
      assert.equal(fx.db.prepare('SELECT state FROM delivery_output_bindings WHERE artifact_id=?').get(binding.artifactId).state, 'bound');
      synced.push(directory);
    }
  };
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId });
  const patchDirectory = path.join(blobRoot, artifact.patch.digest.slice(0, 2));
  assert.ok(synced.includes(patchDirectory));
  assert.ok(synced.filter((directory) => directory === patchDirectory).length >= 2);
  assert.equal(fx.db.prepare('SELECT state FROM delivery_output_bindings WHERE artifact_id=?').get(binding.artifactId).state, 'captured');
});

test('allows exact active-claim lane enrollment before remote submission, then requires running proof to capture', async (t) => {
  const fx = fixture(t, { settle: false });
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  assert.equal(binding.state, 'bound');
  assert.equal(fx.backlog.listAttempts(PROJECT, OBJECTIVE)[0].state, 'claimed');
  assert.throws(() => fx.bridge.capture({ artifactId: binding.artifactId }), { code: 'backlog_attempt_stale' });
  fx.backlog.recordSubmitted(PROJECT, OBJECTIVE, fx.claim.attempt.attemptId, fx.claim.claim.fencingToken, 'remote-task');
  fx.backlog.settleAttempt(PROJECT, OBJECTIVE, fx.claim.attempt.attemptId, fx.claim.claim.fencingToken,
    { state: 'succeeded', trusted: true, outputContract: 'output:v1' },
    { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true });
  assert.equal(fx.bridge.capture({ artifactId: binding.artifactId }).state, 'captured');
});

test('allows an unrelated lookahead plan while the bound producer stays live and unchanged', async (t) => {
  const fx = fixture(t, { settle: false });
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const { attempt, claim } = fx.claim;
  fx.backlog.recordSubmitted(PROJECT, OBJECTIVE, attempt.attemptId, claim.fencingToken, 'remote-task');
  const before = fx.backlog.getObjective(PROJECT, OBJECTIVE);
  const nextTask = { ...before.tasks[0], taskId: 'task-lookahead', objective: 'Implement independent lookahead work.',
    productWritePaths: ['lookahead.txt'], scratchWriteRoots: ['.scratch/lookahead'], state: 'queued' };
  fx.backlog.applyPlan(PROJECT, OBJECTIVE, { schemaVersion: 'delivery/v1', expectedPlanRevision: before.planRevision,
    expectedGoalRevision: before.goalRevision, expectedAuthorityRevision: before.authorityRevision,
    expectedControlRevision: before.controlRevision, nextPlanRevision: before.planRevision + 1,
    tasks: [{ task: nextTask }], dependencies: [] });

  const currentTask = fx.backlog.getObjective(PROJECT, OBJECTIVE).tasks.find((item) => item.taskId === attempt.taskId);
  assert.equal(currentTask.state, 'running');
  assert.equal(currentTask.revision, binding.binding.taskRevision);
  assert.equal(fx.backlog.getObjective(PROJECT, OBJECTIVE).planRevision, binding.binding.planRevision + 1);
  assert.equal(fx.db.prepare('SELECT state FROM delivery_output_bindings WHERE artifact_id=?').get(binding.artifactId).state, 'bound');
  assert.equal(fx.bridge.capture({ artifactId: binding.artifactId }).state, 'captured');
});

test('still rejects bound output after owner correction, takeover, or actual task contract drift', async (t) => {
  const corrected = fixture(t, { settle: false, ownerCorrectionAuthorized: () => true });
  const correctedLane = await prepareLane(corrected);
  const correctedBinding = bind(corrected, correctedLane);
  corrected.backlog.recordSubmitted(PROJECT, OBJECTIVE, corrected.claim.attempt.attemptId, corrected.claim.claim.fencingToken, 'remote-task');
  corrected.backlog.applyOwnerCorrection(PROJECT, OBJECTIVE, { sourceMessageId: 'owner-correction', expectedGoalRevision: 1,
    expectedAuthorityRevision: 1, expectedControlRevision: 1, requirementDigest: `sha256:${'e'.repeat(64)}` });
  assert.throws(() => corrected.bridge.capture({ artifactId: correctedBinding.artifactId }), { code: 'binding_pins_stale' });

  const takeover = fixture(t, { settle: false });
  const takeoverLane = await prepareLane(takeover);
  const takeoverBinding = bind(takeover, takeoverLane);
  takeover.backlog.recordSubmitted(PROJECT, OBJECTIVE, takeover.claim.attempt.attemptId, takeover.claim.claim.fencingToken, 'remote-task');
  takeover.backlog.advanceOwnerGeneration(PROJECT, OBJECTIVE, 0);
  assert.throws(() => takeover.bridge.capture({ artifactId: takeoverBinding.artifactId }), { code: 'binding_pins_stale' });

  const drift = fixture(t, { settle: false });
  const driftLane = await prepareLane(drift);
  const driftBinding = bind(drift, driftLane);
  drift.backlog.recordSubmitted(PROJECT, OBJECTIVE, drift.claim.attempt.attemptId, drift.claim.claim.fencingToken, 'remote-task');
  const task = drift.backlog.getObjective(PROJECT, OBJECTIVE).tasks[0];
  const changed = { ...task, revision: task.revision + 1, objective: 'Changed after private lane binding.' };
  drift.db.prepare('UPDATE backlog_tasks SET revision=?,contract_json=? WHERE project_id=? AND objective_id=? AND task_id=?')
    .run(changed.revision, JSON.stringify(changed), PROJECT, OBJECTIVE, task.taskId);
  assert.throws(() => drift.bridge.capture({ artifactId: driftBinding.artifactId }), { code: 'binding_pins_stale' });
});

test('rechecks host authorization for exact capture replay and publication', async (t) => {
  const fx = fixture(t);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId });
  fx.authorization.allowed = false;
  assert.throws(() => fx.bridge.capture({ artifactId: artifact.artifactId }), { code: 'binding_authorization_denied' });
  await assert.rejects(() => fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'revoked-candidate',
    intentId: 'revoked-intent', integrationGeneration: 2 }), { code: 'binding_authorization_denied' });
  assert.equal(fx.db.prepare('SELECT state FROM delivery_output_publications WHERE intent_id=?').get('revoked-intent'), undefined);
  assert.equal(fx.admission.holder(), null);
});

test('denies forged producer proof and undeclared output without publication effects', async (t) => {
  const fx = fixture(t);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const denied = new DeliveryOutputArtifacts({ db: fx.db, backlogStore: fx.backlog, laneManager: fx.laneManager,
    admission: fx.admission, workspace: fx.workspace, storageDir: path.join(fx.stateDir, 'denied') });
  assert.throws(() => denied.bind({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: 'task-1', attemptId: fx.claim.attempt.attemptId,
    fencingToken: fx.claim.claim.fencingToken, laneId: lane.id, baseCandidateId: fx.base.candidateId,
    declaredWritePaths: ['source.txt'], environmentDigest: ENVIRONMENT, checkIdentity: 'checks-v2' }), { code: 'binding_authorization_denied' });
  const defaultDeny = new DeliveryOutputArtifacts({ db: fx.db, backlogStore: fx.backlog, laneManager: fx.laneManager,
    admission: fx.admission, workspace: fx.workspace, storageDir: path.join(fx.stateDir, 'default-deny'), authorizeBinding: () => true });
  const defaultBound = defaultDeny.bind({ projectId: PROJECT, objectiveId: OBJECTIVE, taskId: 'task-1', attemptId: fx.claim.attempt.attemptId,
    fencingToken: fx.claim.claim.fencingToken, laneId: lane.id, baseCandidateId: fx.base.candidateId,
    declaredWritePaths: ['source.txt'], environmentDigest: ENVIRONMENT, checkIdentity: 'checks-v2' });
  assert.throws(() => defaultDeny.capture({ artifactId: defaultBound.artifactId,
    producerEvidence: { trusted: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true } }), { code: 'producer_quiescence_unproven' });
  fs.writeFileSync(path.join(lane.path, 'extra.txt'), 'outside scope\n');
  assert.throws(() => fx.bridge.capture({ artifactId: binding.artifactId }), { code: 'output_scope_violation' });
  assert.equal(captureManifest(fx.workspace).digest, fx.base.manifestDigest);
  assert.equal(fx.admission.holder(), null);
});

test('refuses a lane whose frozen tree differs from the base candidate and stale owner controls', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.workspace, 'source.txt'), 'changed shared base\n');
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  assert.throws(() => fx.bridge.capture({ artifactId: binding.artifactId }), { code: 'lane_base_candidate_mismatch' });
  assert.equal(fx.admission.holder(), null);

  const second = fixture(t);
  const secondLane = await prepareLane(second);
  const secondBinding = bind(second, secondLane);
  const artifact = second.bridge.capture({ artifactId: secondBinding.artifactId });
  second.backlog.requestControl(PROJECT, OBJECTIVE, 'pause', 1);
  await assert.rejects(() => second.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'stale-candidate',
    intentId: 'stale-intent', integrationGeneration: 2 }), { code: 'objective_not_active' });
  assert.equal(second.admission.holder(), null);
});

test('keeps publication unknown and artifact intact when detached process identity cannot be proven quiet', async (t) => {
  const fx = fixture(t);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId });
  fx.bridge.quiescenceResolver = (identity) => identity?.pid === 999999;
  const applyCount = { value: 0 };
  const realApply = fx.bridge.applyArtifact.bind(fx.bridge);
  fx.bridge.applyArtifact = async (intent) => { applyCount.value += 1; return realApply(intent); };
  const result = await fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'unknown-candidate', intentId: 'unknown-intent', integrationGeneration: 2 });
  assert.equal(result.state, 'unknown');
  assert.equal(applyCount.value, 1);
  assert.equal(fx.bridge.get(artifact.artifactId).patch.digest, artifact.patch.digest);
  assert.equal(fx.admission.get(`integration:${fx.claim.attempt.attemptId}`).state, 'unresolved');
  const unresolvedReplay = await fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'unknown-candidate',
    intentId: 'unknown-intent', integrationGeneration: 2 });
  assert.equal(unresolvedReplay.state, 'unknown');
  assert.equal(applyCount.value, 1);
  const originalRequest = fx.db.prepare('SELECT request_json FROM delivery_output_publications WHERE intent_id=?').get('unknown-intent').request_json;
  const originalCandidateIntent = fx.db.prepare(`SELECT project_id,objective_id,candidate_id,base_candidate_id,attempt_id,
    integration_generation,environment_digest,check_identity,content_manifest_digest,expected_manifest_json,delta_paths_json
    FROM candidate_intents WHERE intent_id=?`).get('unknown-intent');
  fx.db.prepare('UPDATE candidate_intents SET admission_json=? WHERE intent_id=?').run(JSON.stringify({
    contextId: 'unknown-intent', projectId: PROJECT, objectiveId: OBJECTIVE, attemptId: fx.claim.attempt.attemptId,
    fencingToken: fx.claim.claim.fencingToken, controlRevision: 1,
  }), 'unknown-intent');
  fx.db.close();
  const db = new Database(fx.dbPath);
  t.after(() => { if (db.open) db.close(); });
  const admission = new WriterAdmission({ db, workspace: fx.workspace, settleMs: 100 });
  const backlog = new BacklogStore(db, { roleCapacities: { engineer: 1 }, maxActiveTurns: 2, plannerReservedSlots: 1 });
  const laneManager = new LaneManager({ db, workspace: fx.workspace, admission, mode: 'worktree', lanesRoot: fx.lanesRoot, links: [] });
  const bridge = new DeliveryOutputArtifacts({ db, backlogStore: backlog, laneManager, admission, workspace: fx.workspace,
    storageDir: path.join(fx.stateDir, 'artifacts'), authorizeBinding: () => true,
    producerEvidenceFor: (binding) => ({ ...artifact.producerEvidence, ...binding }) });
  const candidateStore = new CandidateStore({ db, workspace: fx.workspace, storageDir: path.join(fx.stateDir, 'candidates'), ...bridge.candidateStoreOptions() });
  bridge.attachCandidateStore(candidateStore);
  const reopenedRealApply = bridge.applyArtifact.bind(bridge);
  bridge.applyArtifact = async (intent) => { applyCount.value += 1; return reopenedRealApply(intent); };
  assert.equal(bridge.get(artifact.artifactId).patch.digest, artifact.patch.digest);
  assert.equal(candidateStore.getIntent('unknown-intent').state, 'unknown');
  assert.equal(admission.get(`integration:${fx.claim.attempt.attemptId}`).state, 'unresolved');
  const reconciled = await bridge.reconcilePublication({ intentId: 'unknown-intent', candidateId: 'unknown-candidate', integrationGeneration: 2 });
  assert.equal(reconciled.state, 'applied');
  assert.equal(reconciled.candidate.candidateId, 'unknown-candidate');
  assert.equal(admission.get(`integration:${fx.claim.attempt.attemptId}`).state, 'reconciled');
  const replay = await bridge.publish({ artifactId: artifact.artifactId, candidateId: 'unknown-candidate', intentId: 'unknown-intent', integrationGeneration: 2 });
  assert.equal(replay.state, 'applied');
  assert.equal(replay.replay, true);
  assert.equal(applyCount.value, 1);
  assert.equal(bridge.get(artifact.artifactId).patch.digest, artifact.patch.digest);
  assert.equal(db.prepare('SELECT request_json FROM delivery_output_publications WHERE intent_id=?').get('unknown-intent').request_json, originalRequest);
  assert.deepEqual(db.prepare(`SELECT project_id,objective_id,candidate_id,base_candidate_id,attempt_id,
    integration_generation,environment_digest,check_identity,content_manifest_digest,expected_manifest_json,delta_paths_json
    FROM candidate_intents WHERE intent_id=?`).get('unknown-intent'), originalCandidateIntent);
});
