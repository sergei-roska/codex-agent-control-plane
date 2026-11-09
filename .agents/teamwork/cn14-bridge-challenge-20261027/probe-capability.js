'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexAppServer } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/codex-app-server');
const Database = require('better-sqlite3');
const { BacklogStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/backlog-store');
const { CandidateStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-store');
const { CandidateReviewStore } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/candidate-review');
const { WriterAdmission } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/writer-admission');
const { execFileSync } = require('node:child_process');
const { stableDigest } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/backlog-store');
const { VERSION } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-contracts');
const { normalizeSpecialistRequest } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/contracts');
const { createDeliveryRoleCapabilities, deliveryRequestDigest, scopedExecutionDetails } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-role-capabilities');
const { TaskExecutor } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/task-executor');
const express = require('express');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { registerRoleAgents } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/a2a-role-service');

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        this.sent.push(message);
        if (message.method === 'initialize') this.respond(message, { userAgent: 'test' });
        if (message.method === 'config/read') this.respond(message, { config: { mcp_servers: {} } });
        if (message.method === 'thread/backgroundTerminals/clean') this.respond(message, {});
        if (message.method === 'thread/start') this.respond(message, { thread: { id: 'provider-thread-1' } });
        if (message.method === 'turn/start') {
          this.respond(message, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
          setImmediate(() => {
            this.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-1' } } })}\n`);
            this.stdout.write(`${JSON.stringify({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', text: 'report' } } })}\n`);
            this.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed' } } })}\n`);
          });
        }
      }
      callback();
    } });
  }
  respond(request, result) { this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`); }
  kill() { this.exitCode = 0; setImmediate(() => this.emit('exit', 0, 'SIGTERM')); return true; }
}
function scopedCapability(root) {
  const workspace = path.join(root, 'workspace');
  const scratchParent = path.join(root, 'private');
  fs.mkdirSync(workspace, { recursive: true });
  const db = new Database(':memory:');
  const store = new BacklogStore(db, { selectedSettingsResolver: () => ({ model: 'review-model' }),
    roleCapacities: { verifier: 1 }, maxActiveTurns: 2, plannerReservedSlots: 0 });
  store.createObjective({ schemaVersion: VERSION, projectId: 'p', objectiveId: 'o', sessionId: 's', engineVersion: 'delivery-v1',
    goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`,
    authorityRevision: 1, controlRevision: 1, disposition: 'executing' });
  const task = { schemaVersion: VERSION, projectId: 'p', objectiveId: 'o', taskId: 'review-task', revision: 1, role: 'verifier', kind: 'review',
    objective: 'Review the frozen candidate.', priority: 0, dependencies: [], productWritePaths: [],
    readScope: { kind: 'unknown', paths: null, reason: 'Review candidate.' }, scratchWriteRoots: ['review-scratch'], resourceClaims: [],
    publicationAuthority: { state: 'denied', reason: 'review_task', authorityRevision: 1 }, state: 'queued',
    checkpointId: 'checkpoint', baseCandidateId: 'candidate' };
  store.applyPlan('p', 'o', { schemaVersion: VERSION, expectedPlanRevision: 0, expectedGoalRevision: 1, expectedAuthorityRevision: 1,
    expectedControlRevision: 1, nextPlanRevision: 1, tasks: [{ task }], dependencies: [] });
  const [{ task: claimedTask, attempt: originalAttempt, claim }] = store.claimReady('p', 'o', 0, { controlRevision: 1 });
  store.pinSelectedSettings('p', 'o', originalAttempt.attemptId, claim.fencingToken, { model: 'review-model' });
  const attempt = store.listAttempts('p', 'o').find((row) => row.attemptId === originalAttempt.attemptId);
  let candidateContent = 'frozen';
  let boundThread = null;
  let receiptCommand = null;
  const review = {
    bindClaimedAttempt() { return true; },
    prepareReviewInput(taskId, destination) {
      assert.equal(taskId, claimedTask.taskId);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(destination, 'input.txt'), candidateContent, { mode: 0o444 });
      return { taskId, candidateId: 'candidate', contextId: 'review-context', inputManifestDigest: 'd'.repeat(64), destination };
    },
    verifyReviewInput(prepared) { return fs.readFileSync(path.join(prepared.destination, 'input.txt'), 'utf8') === candidateContent; },
    pinObservedThread(input) { boundThread = input.threadId; return boundThread; },
    settleReceipt(input) { receiptCommand = input; return { state: 'settled', receiptId: 'host-receipt' }; },
  };
  const request = normalizeSpecialistRequest({ objective: claimedTask.objective, allowedFiles: [] },
    { id: 'verifier', name: 'verifier', sandbox: 'workspace-write' });
  const requestDigest = deliveryRequestDigest({ request, settingsDigest: attempt.selectedSettingsDigest, taskDigest: attempt.contractDigest });
  const resolver = createDeliveryRoleCapabilities({ backlogStore: store, candidateReview: review, projectWorkspaceFor: () => workspace,
    scratchRootFor: ({ attemptId }) => path.join(scratchParent, attemptId) });
  const identity = { projectId: 'p', objectiveId: 'o', taskId: claimedTask.taskId,
    attemptId: attempt.attemptId, fencingToken: claim.fencingToken, providerContextId: attempt.providerContextId,
    requestDigest, request, role: 'verifier' };
  const capability = resolver.resolveVerifierCapability(identity, request);
  return { db, store, resolver, capability, workspace, request, identity, task: claimedTask, attempt, claim,
    details: scopedExecutionDetails(capability), get boundThread() { return boundThread; }, get receiptCommand() { return receiptCommand; } };

}

test('owner pause in onTurnStart prevents scoped verifier turn', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn14-scoped-revoke-'));
  const fx = scopedCapability(root);
  const child = new FakeProcess();
  const client = new CodexAppServer({ spawnImpl: () => child });
  client.resolveExecutionPermissions = async () => ({ mode: 'inherit', profileApi: true, readOnlyProfile: ':read-only',
    writerProfile: ':workspace', approvalPolicy: 'never', approvalsReviewer: 'auto' });
  t.after(async () => { await client.close(); fx.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const role = { id: 'verifier', name: 'Verifier', model: 'review-model', effort: 'low', sandbox: 'workspace-write',
    tools: { mcpServers: [], skills: false } };
  let invoked = false;
  let outcome;
  try {
    outcome = await client.run({ role, cwd: fx.details.scratchRoot, permissionWorkspace: fx.workspace, input: 'Review.',
      executionPermissions: 'inherit', deliveryCapability: fx.capability, onTurnStart: () => {
        invoked = true;
        fx.store.transitionLifecycleControl('p', 'o', { action: 'pause', expectedControlRevision: 1, expectedOwnerGeneration: 0 });
      } });
  } catch (error) { outcome = { error: error.code || error.message, execution: error.execution }; }
  const actual = { invoked, disposition: fx.store.getObjective('p','o').disposition,
    threadStarts: child.sent.filter((x) => x.method === 'thread/start').length,
    turnStarts: child.sent.filter((x) => x.method === 'turn/start').length,
    receipt: fx.receiptCommand, outcome };
  process.stdout.write(`CN14_CAPABILITY ${JSON.stringify(actual)}\n`);
  assert.equal(invoked, true);
  assert.equal(actual.turnStarts, 0, 'paused owner control must prevent model turn');
  assert.equal(actual.receipt, null, 'no passing receipt may settle');
});
