'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { CandidateStore } = require('../src/candidate-store');
const { runFrozenCandidateChecks, measureCandidateTree } = require('../src/delivery-acceptance');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('candidate measurement sorts complete paths after walking nested directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-path-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'file.txt'), 'nested');
  fs.writeFileSync(path.join(root, 'a.txt'), 'sibling');
  assert.deepEqual(measureCandidateTree(root, { head: null }).entries.map((entry) => entry.path), ['a.txt', 'a/file.txt']);
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-acceptance-test-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Acceptance Fixture');
  git('config', 'user.email', 'acceptance-fixture@invalid');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(workspace, name), content);
  git('add', '.');
  git('commit', '-q', '-m', 'candidate base');
  const db = new Database(path.join(root, 'state.sqlite'));
  const candidateStore = new CandidateStore({ db, workspace, storageDir });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-frozen', projectId: 'project-a', objectiveId: 'objective-a',
    integrationGeneration: 8, sourceAttemptId: 'attempt-source', environmentDigest: 'a'.repeat(64), checkIdentity: 'checks-v3' });
  return { root, workspace, storageDir, db, candidateStore, candidate };
}

function cleanup(fx) {
  fx.db.close();
  fs.rmSync(fx.root, { recursive: true, force: true });
}

function hostAdmission() {
  return {
    async acquire() { return { executionId: 'host-check' }; },
    recordTurnStart() {},
    async release() { return { state: 'released' }; },
  };
}

test('checks the exact materialized candidate through the real acceptance runner and keeps mirror HEAD separate', async (t) => {
  const fx = fixture({ 'verify.js': 'process.exit(0);\n', 'answer.txt': 'owner candidate\n' });
  t.after(() => cleanup(fx));
  const manifest = fx.candidateStore.readManifest(fx.candidate.manifestDigest);
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore,
    candidate: { projectId: fx.candidate.projectId, objectiveId: fx.candidate.objectiveId,
      candidateId: fx.candidate.candidateId, integrationGeneration: fx.candidate.integrationGeneration,
      manifestDigest: fx.candidate.manifestDigest, environmentDigest: fx.candidate.environmentDigest,
      checkIdentity: fx.candidate.checkIdentity },
    contract: { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] },
    runId: 'run-cn12-1', attempt: 1, executionPermissions: 'strict', admission: hostAdmission() });

  assert.equal(result.disposition, 'accepted');
  assert.deepEqual(result.requiredCheckIds, ['verify']);
  assert.equal(result.checkResults[0].result, 'passed', JSON.stringify(result.checkResults[0]));
  assert.equal(result.checkContract.source, 'owner');
  assert.equal(result.candidate.manifestDigest, manifest.digest);
  assert.equal(result.candidate.sourceHead, manifest.head);
  assert.notEqual(result.checkSnapshot.syntheticHead, result.candidate.sourceHead);
  assert.equal(result.checkSnapshot.beforeFingerprint, result.checkSnapshot.afterFingerprint);
});

test('retains sandbox source, pins, selected permissions, and waits for durable check admission release', async (t) => {
  const fx = fixture({ 'verify.js': 'process.exit(0);\n' });
  t.after(() => cleanup(fx));
  const calls = [];
  const appServer = {
    async resolveExecutionPermissions(workspace, requested) {
      calls.push({ type: 'permissions', workspace, requested });
      return { mode: 'strict', profileApi: false };
    },
    async execCommand(request) {
      calls.push({ type: 'exec', request });
      assert.equal(fs.realpathSync(request.cwd), request.cwd);
      assert.ok(request.sandboxPolicy);
      const result = spawnSync(request.command[0], request.command.slice(1), { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
  let released = false;
  const admission = {
    async acquire(input) { assert.equal(input.role, 'acceptance'); return { executionId: 'execution-check-1' }; },
    recordTurnStart() { assert.fail('sandboxed acceptance checks do not start host processes'); },
    async release(executionId) {
      assert.equal(executionId, 'execution-check-1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      released = true;
      return { state: 'released' };
    },
  };
  const checkBytes = fs.readFileSync(path.join(fx.workspace, 'verify.js'));
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { id: 'acceptance-contract/v1', source: 'agent', requiredChecks: [{ id: 'verify',
      argv: ['node', 'verify.js'], timeoutMs: 5000, pins: [{ path: 'verify.js', sha256: hash(checkBytes) }] }] },
    runId: 'run-cn12-2', attempt: 2, executionPermissions: 'inherit', appServer, admission });

  assert.equal(result.disposition, 'accepted');
  assert.equal(result.checkContract.source, 'agent');
  assert.deepEqual(result.checkContract.pins, [{ checkId: 'verify', path: 'verify.js', sha256: hash(checkBytes) }]);
  assert.deepEqual(result.checkSettings, { executionPermissions: 'inherit', scratchEnabled: false });
  assert.equal(calls[0].type, 'permissions');
  assert.equal(calls[0].requested, 'inherit');
  assert.equal(calls[1].type, 'exec');
  assert.equal(calls[1].request.cwd, calls[0].workspace);
  assert.equal(released, true);
  assert.equal(result.admissionHeld, true);
});

test('a check that changes candidate bytes cannot produce accepted final-check evidence', async (t) => {
  const fx = fixture({ 'tamper.js': "const fs = require('node:fs'); fs.chmodSync('answer.txt', 0o644); fs.writeFileSync('answer.txt', 'tampered\\n');\n",
    'answer.txt': 'owner candidate\n' });
  t.after(() => cleanup(fx));
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { requiredChecks: [{ id: 'tamper', argv: ['node', 'tamper.js'], timeoutMs: 5000 }] },
    runId: 'run-cn12-3', attempt: 3, executionPermissions: 'strict', admission: hostAdmission() });

  assert.equal(result.disposition, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'candidate_changed'));
  assert.equal(result.checkResults[0].result, 'passed', JSON.stringify(result.checkResults[0]));
});

test('owner full-access final checks use the allowed profile and candidate mutation still rejects acceptance', async (t) => {
  const fx = fixture({
    'mutate.js': "const fs = require('node:fs'); fs.chmodSync('answer.txt', 0o644); fs.writeFileSync('answer.txt', 'changed by check\\n');\n",
    'answer.txt': 'owner candidate\n',
  });
  t.after(() => cleanup(fx));
  const calls = [];
  const appServer = {
    async resolveExecutionPermissions(workspace, requested, options) {
      assert.equal(workspace, fx.workspace);
      calls.push({ type: 'permissions', workspace, requested, options });
      return { mode: 'full-access', writerProfile: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
    },
    async execCommand(request) {
      calls.push({ type: 'exec', request });
      assert.equal(request.permissionProfile, ':danger-full-access');
      assert.equal(Object.hasOwn(request, 'sandboxPolicy'), false);
      assert.notEqual(request.cwd, fx.workspace);
      const result = spawnSync(request.command[0], request.command.slice(1), { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { source: 'agent', requiredChecks: [{ id: 'mutate', argv: ['node', 'mutate.js'], timeoutMs: 5000 }] },
    runId: 'run-full-access-mutation', attempt: 1, executionPermissions: 'full-access', admission: hostAdmission(), appServer });

  assert.equal(calls[0].type, 'permissions');
  assert.equal(calls[0].requested, 'full-access');
  assert.deepEqual(calls[0].options, { fresh: true });
  assert.equal(calls[1].type, 'exec');
  assert.equal(result.checkResults[0].result, 'passed', JSON.stringify(result.checkResults[0]));
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(result.checkSettings, { executionPermissions: 'full-access', scratchEnabled: false });
  assert.ok(result.issues.some((issue) => issue.code === 'candidate_changed'));
});

test('a pending full-access App Server check keeps its mirror for unknown-effect reconciliation', async (t) => {
  const fx = fixture({ 'verify.js': 'process.exit(0);\n' });
  let retainedWorkspace = null;
  let resolveCommand;
  const command = new Promise((resolve) => { resolveCommand = resolve; });
  t.after(() => {
    resolveCommand?.({ exitCode: 0, stdout: '', stderr: '' });
    if (retainedWorkspace) fs.rmSync(retainedWorkspace, { recursive: true, force: true });
    cleanup(fx);
  });
  const appServer = {
    async resolveExecutionPermissions() {
      return { mode: 'full-access', writerProfile: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
    },
    execCommand(request) {
      assert.equal(request.permissionProfile, ':danger-full-access');
      return command;
    },
  };
  await assert.rejects(runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { source: 'agent', requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 10 }] },
    runId: 'run-full-access-pending', attempt: 1, executionPermissions: 'full-access', admission: hostAdmission(), appServer }),
  (error) => {
    retainedWorkspace = error.workspace;
    assert.equal(error.code, 'accept_check_effect_unknown');
    assert.equal(error.pendingAppServerCommands, 1);
    assert.equal(fs.existsSync(error.workspace), true);
    return true;
  });
});

test('a failed owner check remains rejected with its exact result', async (t) => {
  const fx = fixture({ 'verify.js': 'process.exit(7);\n' });
  t.after(() => cleanup(fx));
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] },
    runId: 'run-cn12-failure', attempt: 5, executionPermissions: 'strict', admission: hostAdmission() });

  assert.equal(result.disposition, 'rejected');
  assert.equal(result.checkResults[0].id, 'verify');
  assert.equal(result.checkResults[0].exitCode, 7);
  assert.equal(result.checkResults[0].result, 'failed');
  assert.ok(result.issues.some((issue) => issue.code === 'check_failed'));
});

test('an App Server execution with unknown effect keeps its materialized workspace for reconciliation', async (t) => {
  const fx = fixture({ 'verify.js': 'process.exit(0);\n' });
  let retainedWorkspace = null;
  t.after(() => {
    if (retainedWorkspace) fs.rmSync(retainedWorkspace, { recursive: true, force: true });
    cleanup(fx);
  });
  const bytes = fs.readFileSync(path.join(fx.workspace, 'verify.js'));
  await assert.rejects(runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { id: 'acceptance-contract/v1', source: 'agent', requiredChecks: [{ id: 'verify',
      argv: ['node', 'verify.js'], timeoutMs: 5000, pins: [{ path: 'verify.js', sha256: hash(bytes) }] }] },
    runId: 'run-cn12-4', attempt: 4, executionPermissions: 'strict', admission: hostAdmission(),
    appServer: { execCommand: async () => { throw Object.assign(new Error('request lost after send'), { outcomeUnknown: true }); } } }),
  (error) => {
    retainedWorkspace = error.workspace;
    assert.equal(error.code, 'accept_check_effect_unknown');
    assert.equal(error.candidateId, fx.candidate.candidateId);
    assert.equal(error.pendingAppServerCommands, 0);
    assert.deepEqual(error.appServerFailures, ['exec_command_rejected']);
    assert.equal(fs.existsSync(error.workspace), true);
    return true;
  });
});

test('candidate attributes and inherited Git configuration cannot execute filters while mirroring', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-acceptance-filter-test-'));
  const workspace = path.join(root, 'repo');
  const storageDir = path.join(root, 'state', 'candidates');
  const marker = path.join(root, 'filter-ran');
  fs.mkdirSync(workspace);
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Acceptance Fixture');
  git('config', 'user.email', 'acceptance-fixture@invalid');
  fs.writeFileSync(path.join(workspace, '.gitattributes'), 'payload.txt filter=owned\n');
  fs.writeFileSync(path.join(workspace, '.codex-acceptance-gitconfig'), `[filter "owned"]\n\tclean = sh -c 'printf invoked > ${marker}; cat'\n`);
  fs.writeFileSync(path.join(workspace, 'payload.txt'), 'candidate bytes\n');
  fs.writeFileSync(path.join(workspace, 'verify.js'), 'process.exit(0);\n');
  git('add', '.');
  git('commit', '-q', '-m', 'candidate base');
  const db = new Database(path.join(root, 'state.sqlite'));
  const candidateStore = new CandidateStore({ db, workspace, storageDir });
  const candidate = candidateStore.createCandidate({ candidateId: 'candidate-filter', projectId: 'project-filter', objectiveId: 'objective-filter',
    integrationGeneration: 1, sourceAttemptId: 'attempt-filter', environmentDigest: 'b'.repeat(64), checkIdentity: 'filters' });
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const prior = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^GIT_/i.test(name)));
  for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
  process.env.GIT_CONFIG_GLOBAL = path.join(workspace, '.codex-acceptance-gitconfig');
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'filter.owned.clean';
  process.env.GIT_CONFIG_VALUE_0 = `sh -c 'printf env-invoked > ${marker}; cat'`;
  try {
    const result = await runFrozenCandidateChecks({ candidateStore, candidate,
      contract: { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] },
      runId: 'run-filter-isolation', attempt: 1, executionPermissions: 'strict', admission: hostAdmission() });
    assert.equal(result.disposition, 'accepted');
    assert.equal(result.admissionReleaseState, 'released');
    assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  } finally {
    for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
    Object.assign(process.env, prior);
  }
});

test('ordinary candidate attributes remain available to owner checks', async (t) => {
  const fx = fixture({ '.gitattributes': '*.txt text eol=lf\n', 'payload.txt': 'candidate text\n' });
  t.after(() => cleanup(fx));
  const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
    contract: { requiredChecks: [{ id: 'attributes', argv: ['git', 'check-attr', 'text', 'eol', '--', 'payload.txt'], timeoutMs: 5000 }] },
    runId: 'run-legitimate-attributes', attempt: 1, executionPermissions: 'strict', admission: hostAdmission() });

  assert.equal(result.disposition, 'accepted');
  assert.equal(result.checkResults[0].result, 'passed');
  assert.match(result.checkResults[0].stdoutTail, /payload\.txt: text: set/);
  assert.match(result.checkResults[0].stdoutTail, /payload\.txt: eol: lf/);
});

for (const [name, release] of [
  ['undefined', async () => undefined],
  ['rejected', async () => { throw new Error('release request lost'); }],
]) {
  test(`an unproven ${name} admission release rejects and retains reconciliation context`, async (t) => {
    const fx = fixture({ 'verify.js': 'process.exit(0);\n' });
    let retained = null;
    t.after(() => {
      if (retained) {
        fs.rmSync(retained.workspace, { recursive: true, force: true });
        fs.rmSync(retained.gitControlRoot, { recursive: true, force: true });
      }
      cleanup(fx);
    });
    const admission = {
      async acquire() { return { executionId: `release-${name}` }; },
      recordTurnStart() {},
      release,
    };
    await assert.rejects(runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
      contract: { requiredChecks: [{ id: 'verify', argv: ['node', 'verify.js'], timeoutMs: 5000 }] },
      runId: `run-release-${name}`, attempt: 1, executionPermissions: 'strict', admission }), (error) => {
      retained = { workspace: error.workspace, gitControlRoot: error.gitControlRoot };
      assert.equal(error.code, 'accept_check_admission_unresolved');
      assert.equal(error.candidateId, fx.candidate.candidateId);
      assert.equal(fs.existsSync(retained.workspace), true);
      assert.equal(fs.existsSync(retained.gitControlRoot), true);
      return true;
    });
  });
}

for (const variant of ['real', 'required', 'checks', 'issues', 'reasons', 'mutation']) {
  test(`empty owner checks require exact frozen integrity and clean results: ${variant}`, async (t) => {
    const fx = fixture({ 'answer.txt': 'owner candidate\n' });
    t.after(() => cleanup(fx));
    const injected = async ({ workspace }) => {
      if (variant === 'mutation') {
        fs.chmodSync(path.join(workspace, 'answer.txt'), 0o644);
        fs.writeFileSync(path.join(workspace, 'answer.txt'), 'changed\n');
      }
      return { disposition: 'not_required', checks: variant === 'checks' ? [{ id: 'unexpected', result: 'passed' }] : [],
        issues: variant === 'issues' ? [{ code: 'failure' }] : [],
        reasons: variant === 'reasons' ? [{ code: 'failure' }] : [] };
    };
    const result = await runFrozenCandidateChecks({ candidateStore: fx.candidateStore, candidate: fx.candidate,
      contract: { requiredChecks: variant === 'required' ? [{ id: 'required', argv: ['node', '-e', 'process.exit(0)'] }] : [] },
      runId: 'empty-check-test', attempt: 1, executionPermissions: 'strict', admission: hostAdmission(),
      ...(variant === 'real' ? {} : { runAcceptanceImpl: injected }) });
    assert.equal(result.disposition, variant === 'real' ? 'accepted' : 'rejected');
    if (variant === 'real') {
      assert.deepEqual(result.checkResults, []);
      assert.deepEqual(result.requiredCheckIds, []);
      assert.deepEqual(result.checkSettings, { executionPermissions: 'strict', scratchEnabled: false });
      assert.equal(result.candidate.manifestDigest, fx.candidate.manifestDigest);
    }
  });
}
