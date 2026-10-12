'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { runAcceptance, validateAcceptanceContract, validateAgentChecks, AGENT_CHECK_SANDBOX_POLICY } = require('../src/acceptance');
const { provisionScratch, ScratchError } = require('../src/acceptance-scratch');

const vcs = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-ws-')));
  vcs(dir, 'init', '-q');
  vcs(dir, 'config', 'user.email', 't@example.com');
  vcs(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  vcs(dir, 'add', '.');
  vcs(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const base = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-base-')));
const agentContract = (...requiredChecks) => ({ id: 'acceptance-contract/v1', source: 'agent', requiredChecks });
const unitCheck = { id: 'unit', argv: ['pytest'] };
const noHostRun = async () => { throw new Error('an agent check must never run on the host'); };
const CONFIG = (baseDir) => ({ env: ['TEAMWORK_TEST_SCRATCH_ROOT'], baseDir });
// The base of these tests lives in the OS temp dir, which the production default refuses.
const OPEN = { scratchForbiddenRoots: [] };
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingExec(onCall, reply = { exitCode: 0, stdout: '', stderr: '' }) {
  const calls = [];
  return {
    calls,
    execCommand: async (args) => {
      calls.push(args);
      if (onCall) await onCall(args);
      return reply;
    },
  };
}

test('disabled by default: the policy and exec request are exactly the agent check defaults and no scratch is recorded', async () => {
  const ws = repo();
  const exec = recordingExec();
  const result = await runAcceptance({ workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: exec, runCheckImpl: noHostRun });
  assert.equal(result.disposition, 'accepted');
  assert.deepEqual(exec.calls, [{
    command: ['pytest'],
    cwd: ws,
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    timeoutMs: 600000,
  }]);
  assert.deepEqual(Object.keys(exec.calls[0]), ['command', 'cwd', 'sandboxPolicy', 'timeoutMs']);
  assert.equal('env' in exec.calls[0], false);
  assert.equal('scratch' in result, false);
  assert.deepEqual(AGENT_CHECK_SANDBOX_POLICY.writableRoots, []);
});

test('enabled: policy, env, and a fresh directory that is removed after a pass', async () => {
  const ws = repo();
  const root = base();
  const seen = [];
  const exec = recordingExec((args) => {
    const [dir] = args.sandboxPolicy.writableRoots;
    const stat = fs.statSync(dir);
    seen.push({ dir, mode: stat.mode & 0o777, real: fs.realpathSync(dir), exists: fs.existsSync(args.env.TEAMWORK_TEST_SCRATCH_ROOT) });
  });
  const result = await runAcceptance({
    workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: exec, runCheckImpl: noHostRun, acceptanceScratch: CONFIG(root), ...OPEN,
  });
  assert.equal(result.disposition, 'accepted');
  const [call] = exec.calls;
  const [dir] = call.sandboxPolicy.writableRoots;
  assert.deepEqual(call.sandboxPolicy, {
    type: 'workspaceWrite', writableRoots: [dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  });
  assert.equal(path.dirname(dir), root);
  assert.equal(call.cwd, ws);
  assert.deepEqual(Object.keys(call.env).sort(), ['TEAMWORK_TEST_SCRATCH_ROOT', 'TMPDIR']);
  assert.equal(seen[0].mode, 0o700);
  assert.equal(seen[0].real, dir);
  assert.equal(seen[0].exists, true);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(result.scratch, { dir, cleaned: true, error: null });
  assert.deepEqual(result.issues, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('TMPDIR and the scratch variables are distinct, non-nested siblings inside the single writable root', async () => {
  const ws = repo();
  const root = base();
  const exec = recordingExec();
  await runAcceptance({
    workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: exec, runCheckImpl: noHostRun,
    acceptanceScratch: { env: ['TEAMWORK_TEST_SCRATCH_ROOT', 'OTHER_SCRATCH'], baseDir: root }, ...OPEN,
  });
  const { env, sandboxPolicy } = exec.calls[0];
  assert.equal(sandboxPolicy.writableRoots.length, 1);
  const [dir] = sandboxPolicy.writableRoots;
  assert.equal(env.TEAMWORK_TEST_SCRATCH_ROOT, env.OTHER_SCRATCH);
  assert.notEqual(env.TMPDIR, env.TEAMWORK_TEST_SCRATCH_ROOT);
  assert.equal(path.dirname(env.TMPDIR), dir);
  assert.equal(path.dirname(env.TEAMWORK_TEST_SCRATCH_ROOT), dir);
  for (const [a, b] of [[env.TMPDIR, env.TEAMWORK_TEST_SCRATCH_ROOT], [env.TEAMWORK_TEST_SCRATCH_ROOT, env.TMPDIR]]) {
    assert.ok(path.relative(a, b).startsWith('..'), `${b} is nested in ${a}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('each run gets a fresh directory outside the workspace', async () => {
  const ws = repo();
  const root = base();
  const dirs = [];
  const exec = recordingExec((args) => { dirs.push(args.sandboxPolicy.writableRoots[0]); fs.writeFileSync(path.join(args.env.TEAMWORK_TEST_SCRATCH_ROOT, 'leftover'), 'x'); });
  for (const attempt of [1, 2]) {
    await runAcceptance({
      workspace: ws, runId: 'r', attempt, contract: agentContract(unitCheck), appServer: exec, runCheckImpl: noHostRun, acceptanceScratch: CONFIG(root), ...OPEN,
    });
  }
  assert.notEqual(dirs[0], dirs[1]);
  for (const dir of dirs) {
    assert.ok(path.relative(ws, dir).startsWith('..'));
    assert.equal(fs.existsSync(dir), false);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the directory is removed after a failing check, a throwing exec, a timeout, and a cancel', async () => {
  const ws = repo();
  const root = base();
  const run = (appServer, extra = {}) => runAcceptance({
    workspace: ws, runId: 'r', attempt: 1, contract: agentContract({ ...unitCheck, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) }), appServer, runCheckImpl: noHostRun,
    acceptanceScratch: CONFIG(root), ...OPEN, ...(extra.signal ? { signal: extra.signal } : {}),
  });
  const failed = await run(recordingExec(null, { exitCode: 1, stdout: '', stderr: 'boom' }));
  assert.equal(failed.disposition, 'rejected');
  const thrown = await run({ execCommand: async () => { throw new Error('sandbox unavailable'); } });
  assert.equal(thrown.disposition, 'unverifiable');
  const timedOut = await run({ execCommand: () => new Promise(() => {}) }, { timeoutMs: 20 });
  assert.equal(timedOut.checks[0].timedOut, true);
  const controller = new AbortController();
  const canceled = await run({ execCommand: async () => { setTimeout(() => controller.abort(), 10); await tick(500); return { exitCode: 0 }; } }, { signal: controller.signal });
  assert.equal(canceled.checks[0].canceled, true);
  for (const result of [failed, thrown, timedOut, canceled]) {
    assert.equal(result.scratch.cleaned, true);
    assert.equal(fs.existsSync(result.scratch.dir), false);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// Removal is forced to fail by making fs.rmSync throw for run directories.
test('a cleanup failure is recorded as an advisory issue and never turns a failure into a pass', async () => {
  const ws = repo();
  const root = base();
  const sticky = recordingExec(null, { exitCode: 3, stdout: '', stderr: '' });
  const realRm = fs.rmSync;
  fs.rmSync = (target, options) => { if (String(target).includes('run-')) throw new Error('EBUSY'); return realRm(target, options); };
  let result;
  try {
    result = await runAcceptance({
      workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: sticky, runCheckImpl: noHostRun, acceptanceScratch: CONFIG(root), ...OPEN,
    });
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(result.disposition, 'rejected');
  assert.equal(result.scratch.cleaned, false);
  assert.match(result.scratch.error, /EBUSY|still exists/);
  const issue = result.issues.find((item) => item.code === 'scratch_cleanup_failed');
  assert.equal(issue.advisory, true);
  assert.ok(result.reasons.some((item) => item.code === 'scratch_cleanup_failed'));
  realRm(root, { recursive: true, force: true });
});

test('a passing run with a cleanup failure stays accepted but records the failure', async () => {
  const ws = repo();
  const root = base();
  const realRm = fs.rmSync;
  fs.rmSync = (target, options) => { if (String(target).includes('run-')) throw new Error('EBUSY'); return realRm(target, options); };
  let result;
  try {
    result = await runAcceptance({
      workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: recordingExec(), runCheckImpl: noHostRun, acceptanceScratch: CONFIG(root), ...OPEN,
    });
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(result.disposition, 'accepted');
  assert.equal(result.scratch.cleaned, false);
  assert.equal(result.issues[0].code, 'scratch_cleanup_failed');
  realRm(root, { recursive: true, force: true });
});

test('a directory that cannot be provisioned is an error, never a run without scratch', async () => {
  const ws = repo();
  await assert.rejects(runAcceptance({
    workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: recordingExec(), runCheckImpl: noHostRun,
    acceptanceScratch: CONFIG(path.join(ws, 'scratch-inside')), ...OPEN,
  }), (error) => error instanceof ScratchError && /overlaps the workspace/.test(error.message));
});

test('the default refuses a base inside /tmp or the temp dir, and the workspace', () => {
  const ws = repo();
  const inTmp = base();
  assert.throws(() => provisionScratch(CONFIG(inTmp), { workspace: ws }), (error) => error instanceof ScratchError && /overlaps/.test(error.message));
  // A base that contains the workspace overlaps it too.
  const outer = base();
  const inner = path.join(outer, 'ws');
  fs.mkdirSync(inner);
  assert.throws(() => provisionScratch(CONFIG(outer), { workspace: inner, forbiddenRoots: [] }), /overlaps the workspace/);
  fs.rmSync(outer, { recursive: true, force: true });
  fs.rmSync(inTmp, { recursive: true, force: true });
});

test('the default accepts a base outside /tmp and the workspace (real path, 0700)', { skip: !fs.existsSync('/var/tmp') }, () => {
  const ws = repo();
  const root = fs.realpathSync(fs.mkdtempSync('/var/tmp/scratch-default-'));
  try {
    const scratch = provisionScratch(CONFIG(root), { workspace: ws });
    assert.equal(fs.realpathSync(scratch.dir), scratch.dir);
    assert.equal(fs.statSync(scratch.dir).mode & 0o777, 0o700);
    assert.equal(scratch.cleanup().cleaned, true);
    assert.equal(fs.existsSync(scratch.dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked base or a base below a symlinked ancestor is refused', () => {
  const ws = repo();
  const root = base();
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(real, 'inner'), { recursive: true, mode: 0o700 });
  fs.chmodSync(real, 0o700);
  const link = path.join(root, 'link');
  fs.symlinkSync(real, link);
  assert.throws(() => provisionScratch(CONFIG(link), { workspace: ws, forbiddenRoots: [] }), (error) => error instanceof ScratchError && /symlink/.test(error.message));
  assert.throws(() => provisionScratch(CONFIG(path.join(link, 'inner')), { workspace: ws, forbiddenRoots: [] }), (error) => error instanceof ScratchError && /not a real path/.test(error.message));
  assert.deepEqual(fs.readdirSync(path.join(real, 'inner')), []);
  // The real path itself is still accepted.
  const scratch = provisionScratch(CONFIG(path.join(real, 'inner')), { workspace: ws, forbiddenRoots: [] });
  assert.equal(scratch.cleanup().cleaned, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a base that others can write to is refused', () => {
  const ws = repo();
  const root = base();
  fs.chmodSync(root, 0o777);
  assert.throws(() => provisionScratch(CONFIG(root), { workspace: ws, forbiddenRoots: [] }), /writable by others/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('invalid settings are rejected', () => {
  const ws = repo();
  const root = base();
  const refuse = (config, pattern) => assert.throws(() => provisionScratch(config, { workspace: ws, forbiddenRoots: [] }), pattern);
  refuse(null, /needs an absolute baseDir/);
  refuse({ env: ['X'] }, /needs an absolute baseDir/);
  refuse({ env: ['PATH'], baseDir: root }, /reserved/);
  refuse({ env: ['HOME'], baseDir: root }, /reserved/);
  refuse({ env: ['lower'], baseDir: root }, /must match/);
  refuse({ env: ['A-B'], baseDir: root }, /must match/);
  refuse({ env: 'X', baseDir: root }, /must be an array/);
  refuse({ env: Array.from({ length: 9 }, (_, i) => `V${i}`), baseDir: root }, /more than 8/);
  refuse({ env: ['X', 'X'], baseDir: root }, /duplicated/);
  refuse({ env: ['X'], baseDir: 'relative/dir' }, /normalized absolute path/);
  refuse({ env: ['X'], baseDir: `${root}/../x` }, /normalized absolute path/);
  refuse({ env: ['X'], baseDir: root, extra: 1 }, /unknown field "extra"/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the lead agent cannot enable scratch through a contract or a check proposal', async () => {
  const ws = repo();
  const root = base();
  const proposal = { id: 'unit', argv: ['pytest'], timeoutMs: null };
  for (const field of ['acceptanceScratch', 'scratch', 'env', 'sandboxPolicy', 'writableRoots']) {
    assert.throws(() => validateAgentChecks([{ ...proposal, [field]: field === 'env' ? ['TEAMWORK_TEST_SCRATCH_ROOT'] : { env: ['X'] } }], { workspace: ws }), new RegExp(`unknown field "${field}"`));
  }
  assert.throws(() => validateAcceptanceContract({ ...agentContract(unitCheck), acceptanceScratch: { env: ['X'] } }), /unknown field "acceptanceScratch"/);
  assert.throws(() => validateAcceptanceContract(agentContract({ ...unitCheck, env: ['X'] })), /unknown field "env"/);
  // Without the owner-side option a valid agent contract runs under the default policy.
  const exec = recordingExec();
  await runAcceptance({ workspace: ws, runId: 'r', attempt: 1, contract: agentContract(unitCheck), appServer: exec, runCheckImpl: noHostRun });
  assert.deepEqual(exec.calls[0].sandboxPolicy.writableRoots, []);
  assert.equal('env' in exec.calls[0], false);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('owner checks never create a scratch directory', async () => {
  const ws = repo();
  const root = base();
  const result = await runAcceptance({
    workspace: ws, runId: 'r', attempt: 1, contract: { requiredChecks: [{ id: 'unit', argv: ['pytest'] }] }, appServer: recordingExec(),
    runCheckImpl: async (check) => ({ id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' }),
    acceptanceScratch: CONFIG(root), ...OPEN,
  });
  assert.equal(result.disposition, 'accepted');
  assert.equal('scratch' in result, false);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
