'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { BacklogStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/backlog-store');
const { CandidateStore, captureManifest } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-store');
const { WriterAdmission } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/writer-admission');
const { LaneManager } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/writer-lanes');
const { DeliveryOutputArtifacts } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-output-artifacts');
const { readProcessIdentity, isProcessGroupGone } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/process-quiescence');

const PROJECT = 'artifact-project';
const OBJECTIVE = 'artifact-objective';
const ENVIRONMENT = 'a'.repeat(64);

function fixture(t, { settle = true, producerIdentity = readProcessIdentity(process.pid) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-artifacts-'));
  const workspace = path.join(root, 'repo');
  const lanesRoot = path.join(root, 'lanes');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace); fs.mkdirSync(stateDir);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.name', 'Artifact Test'); git('config', 'user.email', 'artifact@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const dbPath = path.join(stateDir, 'state.sqlite');
  const db = new Database(dbPath);
  const admission = new WriterAdmission({ db, workspace, settleMs: 100 });
  const backlog = new BacklogStore(db, { roleCapacities: { engineer: 1 }, maxActiveTurns: 2, plannerReservedSlots: 1 });
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
    integrationGeneration: 1, sourceAttemptId: 'initial-attempt', environmentDigest: ENVIRONMENT, checkIdentity: 'checks-v1' });
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, lanesRoot, stateDir, dbPath, db, admission, backlog, laneManager, bridge, candidateStore, base, claim: claimed, authorization };
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
    declaredWritePaths: ['source.txt'], environmentDigest: ENVIRONMENT, checkIdentity: 'checks-v2' });
}


const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function waitQueued(admission) {
  for (let i = 0; i < 100; i += 1) { if (admission.queue.length) return; await tick(); }
  throw new Error('publication did not wait on real admission');
}

test('revoked publication while waiting on WriterAdmission has no effect', async (t) => {
  const fx = fixture(t);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId, producerEvidence: { source: 'host-receipt' } });
  const holder = await fx.admission.acquire({ role: 'engineer', taskId: 'prior', contextId: 'prior-context' });
  const before = captureManifest(fx.workspace).digest;
  const publication = fx.bridge.publish({ artifactId: artifact.artifactId, candidateId: 'revoked-candidate',
    intentId: 'revoked-await-intent', integrationGeneration: 2 });
  await waitQueued(fx.admission);
  fx.authorization.allowed = false;
  await fx.admission.release(holder.executionId);
  let outcome;
  try { outcome = await publication; } catch (error) { outcome = { error: error.code || error.message }; }
  const actual = { outcome, workspaceDigest: captureManifest(fx.workspace).digest,
    candidate: fx.candidateStore.get('revoked-candidate'), candidateIntent: fx.candidateStore.getIntent('revoked-await-intent'),
    bridgeRow: fx.db.prepare('SELECT state FROM delivery_output_publications WHERE intent_id=?').get('revoked-await-intent'),
    holder: fx.admission.holder() };
  process.stdout.write(`CN14_REVOKE ${JSON.stringify(actual)}\n`);
  assert.equal(actual.workspaceDigest, before);
  assert.equal(actual.candidate, null);
  assert.notEqual(actual.candidateIntent?.state, 'applied');
  assert.equal(actual.holder, null);
});

test('duplicate same-command publication while first waits has one real effect', async (t) => {
  const fx = fixture(t);
  const lane = await prepareLane(fx);
  const binding = bind(fx, lane);
  const artifact = fx.bridge.capture({ artifactId: binding.artifactId, producerEvidence: { source: 'host-receipt' } });
  const holder = await fx.admission.acquire({ role: 'engineer', taskId: 'prior', contextId: 'prior-context' });
  let applyCount = 0;
  const original = fx.candidateStore.applyEffect;
  fx.candidateStore.applyEffect = async (intent) => { applyCount += 1; return original(intent); };
  const command = { artifactId: artifact.artifactId, candidateId: 'same-candidate', intentId: 'same-intent', integrationGeneration: 2 };
  const first = fx.bridge.publish(command);
  await waitQueued(fx.admission);
  const second = await fx.bridge.publish(command);
  await fx.admission.release(holder.executionId);
  const terminal = await first;
  const actual = { second, terminal, applyCount, workspaceText: fs.readFileSync(path.join(fx.workspace, 'source.txt'), 'utf8'),
    intent: fx.candidateStore.getIntent(command.intentId) };
  process.stdout.write(`CN14_DUPLICATE ${JSON.stringify(actual)}\n`);
  assert.equal(second.state, 'unknown');
  assert.equal(terminal.state, 'applied');
  assert.equal(applyCount, 1);
  assert.equal(actual.intent.state, 'applied');
});
