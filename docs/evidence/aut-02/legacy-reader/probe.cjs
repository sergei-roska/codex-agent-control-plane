'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../../../..');
const baselineCommit = 'cc0958edd54a5c7ddaab02e4844fa69b823af365';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aut02-legacy-reader-'));
const oldRoot = path.join(temp, 'old');
fs.mkdirSync(oldRoot);
const archive = path.join(temp, 'old.tar');
execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, baselineCommit], { cwd: projectRoot });
execFileSync('tar', ['-xf', archive, '-C', oldRoot]);
fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(oldRoot, 'node_modules'), 'dir');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const review = { kind: 'risk_change', checkpointId: 'legacy-checkpoint', reason: 'Review the scoped candidate.', paths: ['scope.txt'], evidenceIds: ['evidence-1'], prerequisiteFor: [] };
const role = (name, sandbox) => ({ name, description: name, model: 'gpt-test', effort: 'low', sandbox, instructions: 'Test role' });
const roles = new Map([['orch-verifier', role('orch-verifier', 'workspace-write')], ['orch-auditor', role('orch-auditor', 'read-only')]]);
const finishDecision = JSON.stringify({ action: 'finish', assignments: [], final: 'Done', resolutions: [], humanInput: null });
const output = { baselineCommit, currentGraphSha256: sha256File(path.join(projectRoot, 'src/lead-graph.js')), baselineGraphSha256: sha256File(path.join(oldRoot, 'src/lead-graph.js')), baselineContractSha256: sha256File(path.join(oldRoot, 'src/contracts.js')), cases: [] };

async function openReader(sourceRoot, dbPath, workspace, { decision = finishDecision, boundary = false, usageLimit = false } = {}) {
  const { LeadOrchestrator } = require(path.join(sourceRoot, 'src/lead-orchestrator.js'));
  const { openStateDatabase, DispatchJournal } = require(path.join(sourceRoot, 'src/durable-store.js'));
  const state = await openStateDatabase({ filePath: dbPath });
  let leadCalls = 0;
  let sends = 0;
  let workerModelCalls = 0;
  const observedRequests = [];
  const boundaryCodes = [];
  const appServer = {
    getCodexHome() { return null; },
    async run() { leadCalls += 1; return { status: 'completed', text: decision, threadId: `lead-${leadCalls}` }; },
  };
  const clientFactory = { async createFromUrl() { return { async sendMessage(request) {
    sends += 1;
    if (!boundary && !usageLimit) throw new Error('Unexpected worker submission');
    const { checkSpecialistRequest } = require(path.join(sourceRoot, 'src/contracts.js'));
    const { TaskState } = require('@a2a-js/sdk');
    const payload = JSON.parse(request.message.parts[0].content.value);
    observedRequests.push(payload);
    if (usageLimit) {
      checkSpecialistRequest(payload, { id: 'orch-verifier', name: 'orch-verifier', sandbox: 'workspace-write' }, { workspace });
      workerModelCalls += 1;
      return { task: {
        id: `limited-${sends}`, contextId: request.message.contextId,
        status: { state: TaskState.TASK_STATE_FAILED, message: {
          messageId: `limited-${sends}`, role: 2,
          parts: [{ content: { $case: 'text', value: 'usage limit reached' } }],
          metadata: { failureKind: 'usage_limit', effects: 'none', continuation: { threadId: `thread-${sends}`, laneId: null, codexHome: null } },
        } }, artifacts: [],
      } };
    }
    let boundaryCode = null;
    let boundaryResults = null;
    try {
      checkSpecialistRequest(payload, { id: 'orch-verifier', name: 'orch-verifier', sandbox: 'workspace-write' }, { workspace });
      workerModelCalls += 1;
      throw new Error('The archived contract unexpectedly admitted the recovered assignment');
    } catch (error) {
      if (workerModelCalls > 0) throw error;
      boundaryCode = error.violations?.[0]?.code || null;
      assert.equal(boundaryCode, 'request_invalid');
      boundaryResults = error.violations;
      boundaryCodes.push(boundaryCode);
    }
    return { task: {
      id: `boundary-${sends}`, contextId: request.message.contextId,
      status: { state: TaskState.TASK_STATE_FAILED, message: {
        parts: [{ content: { $case: 'text', value: `Rejected by archived specialist contract: ${boundaryCode}` } }],
        metadata: { failureKind: 'request_invalid', effects: 'none', boundary: { contract: 'boundary-contract/v1', results: boundaryResults } },
      } },
      artifacts: [],
    } };
  } }; } };
  const orchestrator = new LeadOrchestrator({ appServer, roles, workspace, baseUrl: 'http://127.0.0.1:4040', clientFactory, pollIntervalMs: 0, checkpointer: state.checkpointer, journal: new DispatchJournal(state) });
  return { orchestrator, close: () => state.close(), counts: () => ({ leadCalls, sends, workerModelCalls }), observedRequests, boundaryCodes };
}

function historicalObligation(sourceRoot, workspace, runId, goal) {
  const { computeReviewTarget } = require(path.join(sourceRoot, 'src/review-policy.js'));
  const target = computeReviewTarget({ workspace, review, runId, goal, checks: [] });
  assert.equal(target.known, true);
  return { checkpointId: review.checkpointId, review, targetIdentity: target.identity, pendingAssignmentIds: [], receipts: [
    { role: 'verifier', assignmentId: `${runId}:old-v`, attemptId: `${runId}:old-v:t1`, status: 'accepted', targetIdentity: target.identity, verdict: null, reason: null },
    { role: 'auditor', assignmentId: `${runId}:old-a`, attemptId: `${runId}:old-a:t1`, status: 'accepted', targetIdentity: target.identity, verdict: 'pass', reason: null },
  ] };
}

async function caseOne() {
  const workspace = path.join(temp, 'legacy-workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'scope.txt'), 'candidate A');
  const dbPath = path.join(temp, 'legacy.sqlite');
  const runId = 'legacy-reader-case';
  const goal = 'Review the candidate';
  const old = await openReader(oldRoot, dbPath, workspace);
  const parked = await old.orchestrator.run({ goal, runId, interruptAfter: ['intake'] });
  assert.equal(parked.status, 'interrupted_for_test');
  const obligation = historicalObligation(oldRoot, workspace, runId, goal);
  await old.orchestrator.graph.updateState({ configurable: { thread_id: runId } }, { reviewObligations: [obligation] }, 'intake');
  const oldSnapshot = await old.orchestrator._snapshot(runId);
  assert.equal(Object.hasOwn(oldSnapshot.values, 'reviewRecovery'), false);
  await old.close();
  fs.writeFileSync(path.join(workspace, 'scope.txt'), 'candidate B');
  const current = await openReader(projectRoot, dbPath, workspace);
  try {
    const result = await current.orchestrator.resume({ runId, interruptAfter: ['decide'] });
    const snapshot = await current.orchestrator._snapshot(runId);
    assert.equal(result.status, 'interrupted_for_test');
    assert.equal(snapshot.values.reviewRecovery.version, 1);
    assert.equal(snapshot.values.reviewRecovery.checkpoints.length, 0);
    assert.equal(snapshot.values.reviewObligations.length, 1);
    assert.equal(snapshot.values.reviewObligations[0].receipts.length, 2);
    assert.notEqual(snapshot.values.reviewObligations[0].receipts[0].targetIdentity, require(path.join(projectRoot, 'src/review-policy.js')).computeReviewTarget({ workspace, review, runId, goal, checks: [] }).identity);
    assert.notEqual(snapshot.values.status, 'completed');
    assert.equal(snapshot.values.rejections.at(-1).violations[0].code, 'review_receipt_missing');
    assert.equal(current.counts().sends, 0);
    output.cases.push({ id: 'legacy-to-current', next: snapshot.next, status: snapshot.values.status, rejectionCode: snapshot.values.rejections.at(-1).violations[0].code, reviewRecovery: snapshot.values.reviewRecovery, historicalReceipts: snapshot.values.reviewObligations[0].receipts.length, ...current.counts() });
  } finally { await current.close(); }
}

async function caseTwo() {
  const workspace = path.join(temp, 'rollback-workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'scope.txt'), 'candidate A');
  const dbPath = path.join(temp, 'rollback.sqlite');
  const runId = 'rollback-reader-case';
  const goal = 'Review the candidate';
  const current = await openReader(projectRoot, dbPath, workspace);
  const parked = await current.orchestrator.run({ goal, runId, interruptAfter: ['intake'] });
  assert.equal(parked.status, 'interrupted_for_test');
  const obligation = historicalObligation(projectRoot, workspace, runId, goal);
  const contextHash = crypto.createHash('sha256').update(JSON.stringify({ kind: review.kind, checkpointId: review.checkpointId, reason: review.reason, paths: [...review.paths].sort(), evidenceIds: [...review.evidenceIds].sort(), prerequisiteFor: [] })).digest('hex');
  const recovery = { version: 1, checkpoints: [{ version: 1, checkpointId: review.checkpointId, contextHash, generation: 1, lastRecoveryTarget: 'review-target/v1:old', phase: 'verifier_pending', sourceAssignmentId: `${runId}:old-a`, sourceAttemptId: `${runId}:old-a:t1`, templates: {} }] };
  await current.orchestrator.graph.updateState({ configurable: { thread_id: runId } }, { reviewObligations: [obligation], reviewRecovery: recovery }, 'intake');
  const currentSnapshot = await current.orchestrator._snapshot(runId);
  assert.equal(currentSnapshot.values.reviewRecovery.version, 1);
  await current.close();
  fs.writeFileSync(path.join(workspace, 'scope.txt'), 'candidate B');
  const old = await openReader(oldRoot, dbPath, workspace);
  try {
    const result = await old.orchestrator.resume({ runId, interruptAfter: ['decide'] });
    const snapshot = await old.orchestrator._snapshot(runId);
    assert.equal(result.status, 'interrupted_for_test');
    assert.equal(snapshot.values.reviewObligations.length, 1);
    assert.equal(snapshot.values.reviewObligations[0].receipts.length, 2);
    assert.notEqual(snapshot.values.status, 'completed');
    assert.equal(snapshot.values.rejections.at(-1).violations[0].code, 'review_receipt_missing');
    assert.equal(old.counts().sends, 0);
    output.cases.push({ id: 'current-to-baseline', next: snapshot.next, status: snapshot.values.status, rejectionCode: snapshot.values.rejections.at(-1).violations[0].code, historicalReceipts: snapshot.values.reviewObligations[0].receipts.length, recoveryVisible: Object.hasOwn(snapshot.values, 'reviewRecovery'), ...old.counts() });
  } finally { await old.close(); }
}

async function caseThree() {
  const workspace = path.join(temp, 'active-rollback-workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'tests'));
  fs.writeFileSync(path.join(workspace, 'scope.txt'), 'candidate A');
  fs.writeFileSync(path.join(workspace, 'tests/check.test.js'), 'test placeholder');
  const dbPath = path.join(temp, 'active-rollback.sqlite');
  const runId = 'active-rollback-reader-case';
  const goal = 'Review the candidate';
  const assignment = {
    role: 'orch-verifier', objective: 'Review candidate A', allowedFiles: ['tests/check.test.js'],
    inputs: ['Current candidate'], evidence: ['evidence-1'], acceptanceCriteria: ['Verify the scoped change'],
    checks: ['Check scope.txt'], stopConditions: ['Stop if scope changes'], skills: [], review,
  };
  const dispatchDecision = JSON.stringify({ action: 'dispatch', assignments: [assignment], final: '', resolutions: [], humanInput: null });
  const current = await openReader(projectRoot, dbPath, workspace, { decision: dispatchDecision, usageLimit: true });
  let currentSnapshot;
  try {
    const parked = await current.orchestrator.run({ goal, runId });
    assert.equal(parked.status, 'waiting_for_budget');
    let snapshot = await current.orchestrator._snapshot(runId);
    assert.equal(current.counts().sends, 1);
    fs.writeFileSync(path.join(workspace, 'scope.txt'), 'candidate B');
    const stopped = await current.orchestrator.resume({ runId, interruptAfter: ['verify'] });
    assert.equal(stopped.status, 'interrupted_for_test');
    snapshot = await current.orchestrator._snapshot(runId);
    assert.equal(snapshot.values.reviewRecovery.checkpoints[0].phase, 'verifier_pending');
    assert.equal(snapshot.values.reviewRecovery.checkpoints[0].generation, 1);
    assert.equal(snapshot.values.pendingAssignments?.[0]?._reviewRecovery?.version, 1);
    assert.equal(snapshot.values.reviewObligations.length, 1);
    assert.equal(current.counts().sends, 1, 'current graph must skip A continuation before worker send');
    currentSnapshot = snapshot;
  } finally { await current.close(); }
  const old = await openReader(oldRoot, dbPath, workspace, { boundary: true });
  try {
    const result = await old.orchestrator.resume({ runId, interruptAfter: ['verify'] });
    const snapshot = await old.orchestrator._snapshot(runId);
    assert.equal(result.status, 'interrupted_for_test');
    assert.equal(old.counts().sends, 1);
    assert.equal(old.counts().workerModelCalls, 0);
    assert.deepEqual(old.boundaryCodes, ['request_invalid']);
    assert.equal(old.observedRequests[0]._reviewRecovery.version, 1);
    assert.equal(snapshot.values.reviewObligations.length, 1);
    assert.notEqual(snapshot.values.status, 'completed');
    assert.equal(snapshot.values.reviewObligations[0].receipts.some((receipt) => receipt.status === 'accepted'), false);
    const targetB = require(path.join(projectRoot, 'src/review-policy.js')).computeReviewTarget({ workspace, review, runId, goal, checks: [] });
    assert.equal(snapshot.values.reviewObligations[0].targetIdentity, targetB.identity);
    const gate = await old.orchestrator.resume({ runId, interruptAfter: ['decide'] });
    const gatedSnapshot = await old.orchestrator._snapshot(runId);
    assert.equal(gate.status, 'interrupted_for_test');
    assert.equal(gatedSnapshot.values.rejections.at(-1).violations[0].code, 'review_receipt_missing');
    assert.notEqual(gatedSnapshot.values.status, 'completed');
    assert.equal(old.counts().workerModelCalls, 0);
    output.cases.push({
      id: 'active-current-to-baseline', pendingBefore: currentSnapshot.values.pendingAssignments[0]._reviewRecovery,
      phaseBefore: currentSnapshot.values.reviewRecovery.checkpoints[0].phase,
      statusAfter: snapshot.values.status, nextAfter: snapshot.next,
      outboundPrivateMarker: Object.hasOwn(old.observedRequests[0], '_reviewRecovery'),
      acceptedReceiptsAfter: snapshot.values.reviewObligations[0].receipts.filter((receipt) => receipt.status === 'accepted').length,
      boundaryCode: old.boundaryCodes[0], finalGateRejection: gatedSnapshot.values.rejections.at(-1).violations[0].code,
      ...old.counts(),
    });
  } finally { await old.close(); }
}

(async () => {
  try {
    await caseOne();
    await caseTwo();
    await caseThree();
    console.log(JSON.stringify(output, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
