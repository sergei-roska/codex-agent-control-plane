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
const { ConcurrentDeliveryEngine } = require('../src/concurrent-delivery-engine');
const { WriterAdmission } = require('../src/writer-admission');
const { LaneManager } = require('../src/writer-lanes');
const { readProcessIdentity } = require('../src/process-quiescence');

const projectId = '0123456789';
const codexHome = '/tmp/concurrent-engine-codex-home';

function auth(req, res, next) {
  if (req.get('authorization') !== 'Bearer concurrent-test-token') return res.status(401).json({ error: 'unauthorized' });
  return next();
}

function report() {
  return JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass\nNo issues found.', filesChanged: [],
    filesInspected: ['source.txt'], checks: [], risks: [], scopeExpansion: [], decisionRequest: null });
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
  const appServer = {
    getVersion: () => 'fake-app-server/1',
    getCodexHome: () => codexHome,
    async prepareThread({ role }) {
      return { threadId: `${role.id}-thread`, codexHome };
    },
    async run(options) {
      calls.push(options.role.id);
      const threadId = options.threadId || `${options.role.id}-thread`;
      const turnId = `${options.role.id}-turn-${calls.length}`;
      const processIdentity = readProcessIdentity(process.pid);
      options.onTurnStart({ threadId, processIdentity });
      const text = options.role.id === 'lead'
        ? JSON.stringify({ expected: JSON.parse(options.input.slice(options.input.indexOf('\n') + 1)).pins,
          delta: null, dialogue: 'Review the current candidate.', recovery: null, ownerDecision: null }) : report();
      return { threadId, turnId, status: 'completed', text, usage: {}, permissionEvents: [],
        execution: { turnStartSent: true, turnStartRejected: false, turnTerminal: true, cleanupSucceeded: true,
          processIdentity, threadId, turnId } };
    },
  };
  const verifier = { id: 'verifier', name: 'Verifier', description: 'Reviews frozen candidate input.',
    sandbox: 'read-only', model: 'test-model', effort: 'low', fast: false };
  const lead = { id: 'lead', name: 'Lead', model: 'test-model', effort: 'low' };
  const engine = new ConcurrentDeliveryEngine({ db, workspace, projectId, stateFile: path.join(storageRoot, 'state.sqlite'),
    storageRoot, baseUrl, authMiddleware: auth, authToken: 'concurrent-test-token', appServer,
    providerIdentity: { accountId: 'fake-account', codexHome }, roles: new Map([['verifier', verifier]]), leadRole: lead,
    admission, lanes, writerIsolation: { mode: 'worktree' }, sleepMs: 10 });
  engine.register(app);

  t.after(async () => {
    await engine.shutdown().catch(() => {});
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const running = engine.run({ runId: 'engine-run-1', goal: 'Confirm the current source is acceptable.',
    contract: { requiredChecks: [] },
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'engine-objective-1', sessionId: 'engine-session-1' } });
  const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error(JSON.stringify({
    objective: engine.store.getObjective(projectId, 'engine-objective-1'), calls, controller: engine.controllers.get('engine-run-1')?.status(),
    roleExecutions: engine.roleService.projection(), }))), 8000))]);

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.disposition, 'accepted');
  assert.equal(engine.getRunDigest('engine-run-1').candidateId, result.candidateId);
  assert.deepEqual(calls, ['lead', 'verifier']);
  assert.equal(engine.getRunEngine('engine-run-1'), 'concurrent-v1');
  assert.equal(engine.getRunDigest('engine-run-1').disposition, 'accepted');
  const qualification = engine.reviewStore.finalizationProjection({ projectId, objectiveId: 'engine-objective-1',
    candidateId: result.candidateId, requiredRoles: ['verifier'] });
  assert.equal(qualification.complete, true, JSON.stringify(qualification));
});
