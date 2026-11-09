'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { ConcurrentDeliveryEngine } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/concurrent-delivery-engine');
const { WriterAdmission } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/writer-admission');
const { LaneManager } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/writer-lanes');
const { readProcessIdentity } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/process-quiescence');
const { scopedExecutionDetails } = require('/home/sr/Projects/Workspace/codex-agent-control-plane/src/delivery-role-capabilities');

const projectId = '0123456789';
const codexHome = '/tmp/concurrent-engine-codex-home';

function auth(req, res, next) {
  if (req.get('authorization') !== 'Bearer concurrent-test-token') return res.status(401).json({ error: 'unauthorized' });
  return next();
}

test('concurrent engine uses the real role service and finalization path to accept its pinned base candidate', { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-delivery-engine-'));
  const workspace = path.join(root, 'repo');
  const storageRoot = path.join(root, 'engine-state');
  fs.mkdirSync(workspace);
  fs.mkdirSync(storageRoot);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Concurrent Engine Test');
  git('config', 'user.email', 'concurrent-engine@example.invalid');
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'stable input\n');
  fs.writeFileSync(path.join(workspace, 'verify-source.js'), "'use strict';\nconst fs = require('node:fs');\nif (fs.readFileSync('source.txt', 'utf8') !== 'stable input\\n') process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = new Database(path.join(storageRoot, 'state.sqlite'));
  const admission = new WriterAdmission({ db, workspace });
  const lanes = new LaneManager({ db, workspace, admission, mode: 'worktree', lanesRoot: path.join(storageRoot, 'lanes'), links: [] });
  const app = express();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  const starts = [];
  const appServer = {
    getVersion: () => 'fake-app-server/1',
    getCodexHome: () => codexHome,
    async prepareThread({ role }) {
      if (role.id === 'lead') role.model = 'mutated-model';
      return { threadId: `${role.id}-thread`, codexHome };
    },
    async run(options) {
      calls.push(options.role.id);
      assert.equal(options.expectedCodexHome, codexHome);
      const threadId = options.threadId || `${options.role.id}-thread`;
      const turnId = `${options.role.id}-turn-${calls.length}`;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      starts.push({ role: options.role.id, threadId, processIdentity });
      let text;
      if (options.role.id === 'lead') {
        assert.equal(options.role.model, 'mutated-model');
        assert.equal(options.role.effort, 'low');
        assert.equal(options.role.fastMode, 'off');
        text = JSON.stringify({ expected: JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins,
          delta: null, dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null });
      } else {
        assert.equal(options.role.model, 'test-model');
        assert.equal(options.role.effort, 'low');
        assert.equal(options.role.fastMode, 'off');
        const details = scopedExecutionDetails(options.deliveryCapability);
        assert.equal(details.verifyCandidate(), true);
        execFileSync(process.execPath, ['verify-source.js'], { cwd: details.candidatePath, stdio: 'pipe' });
        text = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nSource check passed.', filesChanged: [],
          filesInspected: ['source.txt'], checks: [{ command: 'verify-source.js', result: 'passed', detail: 'Executed against the frozen candidate.' }],
          risks: [], scopeExpansion: [], decisionRequest: null });
      }
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true,
          processIdentity, threadId, turnId } };
    },
  };
  const verifier = { id: 'verifier', name: 'Verifier', description: 'Reviews frozen candidate input.',
    sandbox: 'read-only', model: 'test-model', effort: 'low', fastMode: 'off' };
  const lead = { id: 'lead', name: 'Lead', model: 'test-model', effort: 'low', fastMode: 'off' };
  const engine = new ConcurrentDeliveryEngine({ db, workspace, projectId, stateFile: path.join(storageRoot, 'state.sqlite'),
    storageRoot, baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer,
    providerIdentity: { accountId: 'fake-account', codexHome }, providerIdentityFor: () => ({ accountId: 'fake-account', codexHome }), roles: new Map([['verifier', verifier]]), leadRole: lead,
    admission, lanes, writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
  engine.register(app);

  t.after(async () => {
    await engine.shutdown().catch(() => {});
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const running = engine.run({ runId: 'engine-run-1', goal: 'Confirm the current source is acceptable.',
    contract: { requiredChecks: [{ id: 'source-content', argv: [process.execPath, 'verify-source.js'] }] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'engine-objective-1', sessionId: 'engine-session-1' } });
  let timeoutHandle;
  const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error(JSON.stringify({
    objective: engine.store.getObjective(projectId, 'engine-objective-1'), calls, controller: engine.controllers.get('engine-run-1')?.status(),
    roleExecutions: engine.roleService.projection(), plannerTurns: db.prepare('SELECT turn_id,status,result_json FROM delivery_planner_turns').all(),
    reviewProjection: engine.reviewStore.finalizationProjection({ projectId, objectiveId: 'engine-objective-1',
      candidateId: 'candidate-base-0e009a5814b9f480a213a382', requiredRoles: ['verifier'] }),
    receipts: db.prepare('SELECT receipt_json FROM review_receipts').all(), finalizations: db.prepare('SELECT state,record_json FROM backlog_finalizations').all(),
    executorEvidence: db.prepare('SELECT attempt_id,kind,detail_json FROM task_executor_evidence').all(),
    executions: engine.roleService.projection().map((item) => engine.roleService.getExecution(item.attemptId)), }))), 8000); });
  let result;
  try { result = await Promise.race([running, timeout]); }
  finally { clearTimeout(timeoutHandle); }

  assert.equal(result.status, 'completed', JSON.stringify(result));
  const plannerPins = JSON.parse(db.prepare('SELECT pins_json FROM delivery_planner_turns ORDER BY started_at LIMIT 1').get().pins_json);
  assert.equal(plannerPins.settings.model, 'test-model');
  assert.equal(lead.model, 'mutated-model');
  assert.equal(result.disposition, 'accepted');
  assert.equal(engine.getRunDigest('engine-run-1').candidateId, result.candidateId);
  assert.equal(calls[0], 'lead');
  assert.ok(calls.indexOf('verifier') > 0);
  assert.equal(calls.filter((role) => role === 'verifier').length, 1);
  assert.ok(calls.every((role) => ['lead', 'verifier'].includes(role)));
  assert.ok(starts.some(({ role, threadId }) => role === 'lead' && threadId === 'lead-thread'));
  assert.ok(starts.some(({ role, threadId }) => role === 'verifier' && threadId === 'verifier-thread'));
  assert.ok(starts.every(({ processIdentity }) => Number.isSafeInteger(processIdentity.pid)
    && Number.isSafeInteger(processIdentity.pgid) && typeof processIdentity.startTime === 'string'));
  assert.equal(engine.getRunEngine('engine-run-1'), 'concurrent-v1');
  assert.equal(engine.getRunDigest('engine-run-1').disposition, 'accepted');
  const qualification = engine.reviewStore.finalizationProjection({ projectId, objectiveId: 'engine-objective-1',
    candidateId: result.candidateId, requiredRoles: ['verifier'] });
  assert.equal(qualification.complete, true, JSON.stringify(qualification));
  assert.equal(qualification.receipts.length, 1);
  assert.equal(qualification.receipts[0].receipt.candidateId, result.candidateId);
  assert.equal(qualification.receipts[0].receipt.role, 'verifier');
  assert.equal(qualification.receipts[0].receipt.outcome, 'passed');
  assert.equal(result.acceptance.checkResults.find((check) => check.id === 'source-content')?.result, 'passed');
  const verifierExecution = engine.roleService.getExecution(engine.roleService.projection()[0].attemptId);
  assert.equal(verifierExecution.state, 'settled');
  assert.deepEqual(verifierExecution.providerIdentity, { accountId: 'fake-account', codexHome });
  assert.equal(verifierExecution.provenance.model, 'test-model');
  assert.equal(verifierExecution.provenance.effort, 'low');
  assert.equal(verifierExecution.provenance.fastMode, 'off');
  assert.equal(verifierExecution.execution.turnStartSent, true);
  assert.equal(verifierExecution.execution.turnStartRejected, false);
  assert.equal(verifierExecution.execution.turnTerminal, true);
  assert.ok(verifierExecution.checkEvidence.evidenceRefs.some((ref) => ref.startsWith('verifier-check-proof:')));
  const finalCheckProof = db.prepare('SELECT result_json FROM concurrent_finalization_check_proofs').get();
  assert.ok(finalCheckProof);
  assert.equal(JSON.parse(finalCheckProof.result_json).checkResults.find((check) => check.id === 'source-content')?.result, 'passed');
});
