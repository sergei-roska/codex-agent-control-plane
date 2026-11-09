'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../../..');
const baselineCommit = 'cc0958edd54a5c7ddaab02e4844fa69b823af365';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aut02-legacy-reader-'));
const oldRoot = path.join(temp, 'old');
fs.mkdirSync(oldRoot);
const archive = path.join(temp, 'old.tar');
execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, baselineCommit], { cwd: projectRoot });
execFileSync('tar', ['-xf', archive, '-C', oldRoot]);
fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(oldRoot, 'node_modules'), 'dir');

const review = { kind: 'risk_change', checkpointId: 'legacy-checkpoint', reason: 'Review the scoped candidate.', paths: ['scope.txt'], evidenceIds: ['evidence-1'], prerequisiteFor: [] };
const role = (name, sandbox) => ({ name, description: name, model: 'gpt-test', effort: 'low', sandbox, instructions: 'Test role' });
const roles = new Map([['orch-verifier', role('orch-verifier', 'workspace-write')], ['orch-auditor', role('orch-auditor', 'read-only')]]);
const finishDecision = JSON.stringify({ action: 'finish', assignments: [], final: 'Done', resolutions: [], humanInput: null });
const output = { baselineCommit, cases: [] };

async function openReader(sourceRoot, dbPath, workspace) {
  const { LeadOrchestrator } = require(path.join(sourceRoot, 'src/lead-orchestrator.js'));
  const { openStateDatabase, DispatchJournal } = require(path.join(sourceRoot, 'src/durable-store.js'));
  const state = await openStateDatabase({ filePath: dbPath });
  let leadCalls = 0;
  let sends = 0;
  const appServer = {
    getCodexHome() { return null; },
    async run() { leadCalls += 1; return { status: 'completed', text: finishDecision, threadId: `lead-${leadCalls}` }; },
  };
  const clientFactory = { async createFromUrl() { return { async sendMessage() { sends += 1; throw new Error('Unexpected worker submission'); } }; } };
  const orchestrator = new LeadOrchestrator({ appServer, roles, workspace, baseUrl: 'http://127.0.0.1:4040', clientFactory, pollIntervalMs: 0, checkpointer: state.checkpointer, journal: new DispatchJournal(state) });
  return { orchestrator, close: () => state.close(), counts: () => ({ leadCalls, sends }) };
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

(async () => {
  try {
    await caseOne();
    await caseTwo();
    console.log(JSON.stringify(output, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
