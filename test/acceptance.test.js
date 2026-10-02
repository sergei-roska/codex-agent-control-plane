'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { WriterAdmission } = require('../src/writer-admission');
const { takeSnapshot } = require('../src/workspace-snapshot');
const {
  validateAcceptanceContract, parseCheckCommand, buildSandboxCommand, runCheck, computeDisposition, runAcceptance, verifyCandidate, assessWithoutChecks, formatAcceptance,
} = require('../src/acceptance');

const vcs = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
const node = (id, code, extra = {}) => ({ id, argv: [process.execPath, '-e', code], ...extra });
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function repo(parent = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(parent, 'accept-'));
  vcs(dir, 'init', '-q');
  vcs(dir, 'config', 'user.email', 't@example.com');
  vcs(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  vcs(dir, 'add', '.');
  vcs(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const okWriter = (extra = {}) => ({
  attemptId: 'w1', role: 'orch-w', ran: true, completed: true, reportValid: true,
  reportedScopeViolations: [], attestedScopeViolations: [], deltaKnown: true, ...extra,
});
const codes = (result) => result.issues.map((issue) => issue.code);

test('contract validation accepts a good contract and normalizes it', () => {
  assert.deepEqual(validateAcceptanceContract(undefined), { requiredChecks: [] });
  assert.deepEqual(validateAcceptanceContract(null), { requiredChecks: [] });
  const out = validateAcceptanceContract({ requiredChecks: [{ id: 'unit.1', argv: ['npm', 'test'] }, { id: 'b', argv: ['x'], timeoutMs: 5 }] });
  assert.equal(out.requiredChecks[0].timeoutMs, 600000);
  assert.equal(out.requiredChecks[1].timeoutMs, 5);
});

test('contract validation rejects bad input', () => {
  const bad = (value) => assert.throws(() => validateAcceptanceContract(value), TypeError);
  bad({ requiredChecks: [{ id: 'a', argv: ['x'] }, { id: 'a', argv: ['y'] }] });
  bad({ requiredChecks: [{ id: 'a', argv: [] }] });
  bad({ requiredChecks: [{ id: 'a', argv: 'npm test' }] });
  bad({ requiredChecks: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, argv: ['x'] })) });
  bad({ requiredChecks: [{ id: 'a', argv: ['x'], timeoutMs: 1800001 }] });
  bad({ requiredChecks: [{ id: 'a', argv: ['x'], timeoutMs: 1.5 }] });
  bad({ requiredChecks: [{ id: 'bad id', argv: ['x'] }] });
  bad({ requiredChecks: [], extra: 1 });
});

test('parseCheckCommand splits on whitespace', () => {
  assert.deepEqual(parseCheckCommand('  npm  test -- x ', 1), { id: 'check-2', argv: ['npm', 'test', '--', 'x'] });
});

test('acceptance sandbox rejects explicit or default CODEX_HOME inside the workspace', () => {
  const dir = repo();
  const tempDir = path.join(dir, '.acceptance-tmp-fixture');
  fs.mkdirSync(tempDir);
  try {
    assert.throws(
      () => buildSandboxCommand({ argv: [process.execPath, '-e', ''], cwd: dir, tempDir, env: { PATH: process.env.PATH, CODEX_HOME: path.join(dir, 'credentials') } }),
      /CODEX_HOME must resolve outside/,
    );
    assert.throws(
      () => buildSandboxCommand({ argv: [process.execPath, '-e', ''], cwd: dir, tempDir, env: { PATH: process.env.PATH, HOME: path.join(dir, 'home') } }),
      /CODEX_HOME must resolve outside/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance sandbox denies existing sensitive roots without inventing absent ones', () => {
  const dir = repo();
  for (const relative of ['.runtime', 'runtime', 'data', '.codex/sessions']) fs.mkdirSync(path.join(dir, relative), { recursive: true });
  for (const relative of ['.env', '.codex/auth.json']) fs.writeFileSync(path.join(dir, relative), 'fixture');
  try {
    const command = buildSandboxCommand({
      argv: [process.execPath, '-e', ''],
      cwd: dir,
      tempDir: path.join(dir, '.acceptance-tmp-profile-fixture'),
      env: { ...process.env, CODEX_HOME: path.join(os.tmpdir(), 'acceptance-external-codex-home') },
    });
    const policy = command.args[command.args.indexOf('-c') + 1];
    for (const relative of ['.runtime', '.env', 'runtime', 'data', '.codex/auth.json', '.codex/sessions']) {
      assert.ok(policy.includes(`${JSON.stringify(path.resolve(dir, relative))}="deny"`), `missing restriction for ${relative}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck uses the sandbox protocol, preserves argv, and strips inherited secrets', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'auth.json'), 'fixture');
  fs.writeFileSync(path.join(dir, '.codex', 'sessions', 'session.json'), 'fixture');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-codex-'));
  const untrustedBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-check-bin-'));
  const untrustedExecutable = path.join(untrustedBinDir, 'probe');
  const capture = path.join(os.tmpdir(), `accept-codex-args-${process.pid}-${Date.now()}.json`);
  const fakeCodex = path.join(binDir, 'codex');
  const previous = Object.fromEntries(['PATH', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_SECRET', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  const expectedArgv = [untrustedExecutable, 'space arg', '$literal'];
  const checkSource = `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({api:process.env.OPENAI_API_KEY,aws:process.env.AWS_SECRET_ACCESS_KEY,custom:process.env.CUSTOM_SECRET,path:process.env.PATH,codexHome:process.env.CODEX_HOME,tmpdir:process.env.TMPDIR}));\n`;
  fs.writeFileSync(untrustedExecutable, checkSource, { mode: 0o755 });
  const fakeSource = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,env:process.env}));const marker=args.indexOf('--');if(marker<0)process.exit(97);const child=cp.spawn(args[marker+1],args.slice(marker+2),{cwd:process.cwd(),env:process.env,stdio:'inherit'});child.on('error',()=>process.exit(98));child.on('exit',(code,signal)=>process.exit(code===null?99:code));\n`;
  fs.writeFileSync(fakeCodex, fakeSource, { mode: 0o755 });
  try {
    process.env.PATH = binDir;
    process.env.OPENAI_API_KEY = 'must-not-reach-check';
    process.env.AWS_SECRET_ACCESS_KEY = 'must-not-reach-check';
    process.env.CUSTOM_SECRET = 'must-not-reach-check';
    process.env.CODEX_HOME = path.join(binDir, 'codex-home');
    const result = await runCheck({ id: 'argv', argv: expectedArgv }, { cwd: dir });
    assert.equal(result.result, 'passed');
    assert.deepEqual(result.argv, expectedArgv);
    const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const separator = captured.args.indexOf('--');
    assert.equal(captured.args[separator + 1], process.execPath);
    assert.equal(captured.args[separator + 2], '-e');
    assert.deepEqual(captured.args.slice(-expectedArgv.length), expectedArgv);
    assert.equal(captured.args[0], 'sandbox');
    assert.equal(captured.args[captured.args.indexOf('-C') + 1], dir);
    assert.equal(captured.args[captured.args.indexOf('-P') + 1], 'codex-a2a-acceptance');
    const policy = captured.args[captured.args.indexOf('-c') + 1];
    const captureConfig = JSON.parse(captured.args[separator + 4]);
    assert.match(policy, /extends=":workspace"/);
    assert.match(policy, /network=\{enabled=false\}/);
    assert.ok(policy.includes(JSON.stringify(binDir)));
    assert.ok(policy.includes(JSON.stringify(path.dirname(fs.realpathSync(process.execPath)))));
    assert.ok(!policy.includes(JSON.stringify(untrustedBinDir)), 'an argv-selected executable must not add a read grant');
    assert.ok(policy.includes(JSON.stringify(path.basename(captureConfig.tempDir))));
    assert.match(policy, /"\.git"="read"/);
    for (const relativePath of ['.env.*', '.codex/auth.json', '.codex/sessions']) {
      assert.ok(policy.includes(`${JSON.stringify(relativePath)}="deny"`), `missing workspace restriction for ${relativePath}`);
      assert.ok(policy.includes(`${JSON.stringify(path.resolve(dir, relativePath))}="deny"`), `missing absolute restriction for ${relativePath}`);
    }
    for (const relativePath of ['.runtime', '.env', 'runtime', 'data']) {
      assert.ok(!policy.includes(`${JSON.stringify(path.resolve(dir, relativePath))}="deny"`), `absent ${relativePath} must not be materialized by a deny rule`);
    }
    assert.equal(captured.env.OPENAI_API_KEY, undefined);
    assert.equal(captured.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(captured.env.CUSTOM_SECRET, undefined);
    assert.equal(captured.env.PATH, binDir);
    assert.equal(captured.env.CODEX_HOME, path.join(binDir, 'codex-home'));
    assert.equal(captured.env.TMPDIR, undefined);
    const childEnv = JSON.parse(result.stdoutTail);
    assert.equal(childEnv.api, undefined);
    assert.equal(childEnv.aws, undefined);
    assert.equal(childEnv.custom, undefined);
    assert.equal(childEnv.path, binDir);
    assert.equal(childEnv.codexHome, path.join(binDir, 'codex-home'));
    assert.ok(childEnv.tmpdir.startsWith(`${dir}${path.sep}.acceptance-tmp-`));
    assert.equal(fs.existsSync(childEnv.tmpdir), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(capture, { force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(untrustedBinDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck fails closed when the Codex sandbox CLI is unavailable', async () => {
  const dir = repo();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const result = await runCheck({ id: 'unavailable', argv: [process.execPath, '-e', 'process.exit(0)'] }, { cwd: dir });
    assert.equal(result.result, 'failed');
    assert.equal(result.error, 'CODEX_SANDBOX_UNAVAILABLE');
    assert.match(result.stderrTail, /Could not resolve Codex executable/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm checks can read the trusted npm installation outside the Node bin directory', async (t) => {
  const npmOnPath = (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try { fs.accessSync(path.join(dir, 'npm'), fs.constants.X_OK); return true; } catch (_) { return false; }
  });
  if (!npmOnPath) return t.skip('npm is unavailable on PATH');
  const dir = repo();
  try {
    const result = await runCheck({ id: 'npm-version', argv: ['npm', '--version'], timeoutMs: 30000 }, { cwd: dir });
    assert.equal(result.result, 'passed', JSON.stringify({ error: result.error, exitCode: result.exitCode, stderr: result.stderrTail }));
    assert.match(result.stdoutTail, /^\d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linked-worktree Git metadata is readable and stays read-only', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(process.cwd(), '.acceptance-linked-fixture-'));
  const source = repo(fixtureRoot);
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-linked-worktree-'));
  fs.rmSync(linked, { recursive: true, force: true });
  let marker = null;
  try {
    vcs(source, 'worktree', 'add', '--detach', linked, 'HEAD');
    const match = fs.readFileSync(path.join(linked, '.git'), 'utf8').trim().match(/^gitdir:\s*(.+)$/i);
    assert.ok(match, 'worktree .git file should point to its private gitdir');
    const gitDir = fs.realpathSync(path.resolve(linked, match[1]));
    const commonDir = fs.realpathSync(path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()));
    marker = path.join(commonDir, `.acceptance-readonly-${process.pid}-${Date.now()}`);
    const directGit = await runCheck({ id: 'linked-git-direct', argv: ['git', 'status', '--short'], timeoutMs: 30000 }, { cwd: linked });
    assert.equal(directGit.result, 'passed', directGit.stderrTail);
    const probe = `const cp=require('node:child_process');const fs=require('node:fs');const canRead=(file)=>{try{fs.accessSync(file,fs.constants.R_OK);return true}catch(_){return false}};const git=cp.spawnSync('git',['status','--short'],{encoding:'utf8'});let commonDirWriteSucceeded=false;try{fs.writeFileSync(${JSON.stringify(marker)},'probe');commonDirWriteSucceeded=true}catch(_){}if(commonDirWriteSucceeded)fs.rmSync(${JSON.stringify(marker)},{force:true});process.stdout.write(JSON.stringify({gitStatus:git.status,gitError:git.error?.message,gitStdout:git.stdout,gitStderr:git.stderr,worktreeHeadReadable:canRead(${JSON.stringify(path.join(gitDir, 'HEAD'))}),commonHeadReadable:canRead(${JSON.stringify(path.join(commonDir, 'HEAD'))}),commonDirWriteSucceeded}));if(git.status!==0||commonDirWriteSucceeded)process.exitCode=1`;
    const result = await runCheck({ id: 'linked-git', argv: [process.execPath, '-e', probe], timeoutMs: 30000 }, { cwd: linked });
    assert.equal(result.result, 'passed', JSON.stringify({ error: result.error, exitCode: result.exitCode, stdout: result.stdoutTail, stderr: result.stderrTail }));
    const details = JSON.parse(result.stdoutTail);
    assert.equal(details.gitStatus, 0);
    assert.equal(details.worktreeHeadReadable, true);
    assert.equal(details.commonHeadReadable, true);
    assert.equal(details.commonDirWriteSucceeded, false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (marker) fs.rmSync(marker, { force: true });
    try { vcs(source, 'worktree', 'remove', '--force', linked); } catch (_) { /* Cleanup fixture when worktree creation failed. */ }
    fs.rmSync(linked, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('sandbox cannot see the host test runner PID through procfs', { skip: process.platform !== 'linux' }, async () => {
  const dir = repo();
  // This is a narrow host-PID visibility probe, not proof of same-uid process isolation.
  const hostPid = process.pid;
  const code = `const fs=require('node:fs');const hostPid=${hostPid};let hostPidVisible=false;let hostEnvironReadable=false;try{fs.accessSync('/proc/'+hostPid);hostPidVisible=true;fs.accessSync('/proc/'+hostPid+'/environ',fs.constants.R_OK);hostEnvironReadable=true}catch(_){}process.stdout.write(JSON.stringify({hostPid,hostPidVisible,hostEnvironReadable}))`;
  try {
    const result = await runCheck({ id: 'procfs', argv: [process.execPath, '-e', code] }, { cwd: dir });
    assert.equal(result.result, 'passed');
    assert.deepEqual(JSON.parse(result.stdoutTail), { hostPid, hostPidVisible: false, hostEnvironReadable: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('passing check is accepted', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'process.exit(0)')] }, writers: [okWriter()] });
  assert.equal(result.disposition, 'accepted');
  assert.equal(result.candidate.kind, 'git');
  assert.deepEqual(result.requiredCheckIds, ['ok']);
  assert.equal(result.admissionHeld, false);
});

test('failing check is rejected with check_failed', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('bad', 'console.error("boom");process.exit(3)')] }, writers: [] });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['check_failed']);
  assert.equal(result.checks[0].exitCode, 3);
  assert.match(result.checks[0].stderrTail, /boom/);
});

test('nonexistent binary is check_failed with ENOENT', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [{ id: 'nx', argv: ['definitely-not-a-binary-xyz'] }] } });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['check_failed']);
  assert.equal(result.checks[0].error, 'ENOENT');
  assert.equal(result.checks[0].exitCode, null);
});

test('contract check without a result is check_missing', () => {
  const snap = { kind: 'git', head: 'h', fingerprint: 'f', entries: [] };
  const result = computeDisposition({ requiredChecks: [{ id: 'x', argv: ['x'] }], checkResults: [], snapshotBefore: snap, snapshotAfter: snap, writers: [], unresolvedWriterCount: 0 });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['check_missing']);
});

test('unresolved writers reject and are listed without checks', () => {
  const snap = { kind: 'git', head: 'h', fingerprint: 'f', entries: [] };
  const withChecks = computeDisposition({ requiredChecks: [{ id: 'x', argv: ['x'] }], checkResults: [{ id: 'x', result: 'passed' }], snapshotBefore: snap, snapshotAfter: snap, writers: [], unresolvedWriterCount: 1 });
  assert.deepEqual(codes(withChecks), ['writer_unresolved']);
  const without = computeDisposition({ requiredChecks: [], snapshotBefore: snap, snapshotAfter: snap, writers: [], unresolvedWriterCount: 1 });
  assert.equal(without.disposition, 'not_required');
  assert.deepEqual(codes(without), ['writer_unresolved']);
});

test('malformed writer report is rejected with report_invalid', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] }, writers: [okWriter({ reportValid: false })] });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['report_invalid']);
});

test('a reported-only scope item with a known delta is a non-blocking warning', async () => {
  const dir = repo();
  const result = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] },
    writers: [okWriter({ reportedScopeViolations: ['x.js'] })],
  });
  assert.equal(result.disposition, 'accepted');
  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'reported_scope_mismatch');
  assert.match(result.warnings[0].detail, /x\.js/);
});

test('a reported scope item with an unknown delta is rejected', async () => {
  const dir = repo();
  const result = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] },
    writers: [okWriter({ reportedScopeViolations: ['x.js'], deltaKnown: false })],
  });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result).sort(), ['delta_unknown', 'reported_scope_violation']);
  assert.deepEqual(result.warnings, []);
});

test('attested scope violations are rejected; a reported item beside them stays a warning', async () => {
  const dir = repo();
  const result = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] },
    writers: [okWriter({ reportedScopeViolations: ['x.js'], attestedScopeViolations: ['y.js'] })],
  });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['attested_scope_violation']);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['reported_scope_mismatch']);
});

test('unknown delta is rejected', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] }, writers: [okWriter({ deltaKnown: false })] });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['delta_unknown']);
});

test('a check that modifies a tracked file is rejected with candidate_changed', async () => {
  const dir = repo();
  const code = `require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'a.txt'))}, 'x')`;
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('mut', code)] } });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['candidate_changed']);
  assert.notEqual(result.candidate.fingerprint, result.candidateAfter.fingerprint);
});

test('verifyCandidate detects a change after acceptance', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] } });
  assert.equal(result.disposition, 'accepted');
  assert.equal(verifyCandidate(dir, result).unchanged, true);
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  assert.equal(verifyCandidate(dir, result).unchanged, false);
});

test('no contract and read-only run is not_required', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: undefined, writers: [okWriter({ ran: false, completed: false })] });
  assert.equal(result.disposition, 'not_required');
});

test('no contract with a writer that ran is unverified with issues', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, writers: [okWriter({ reportValid: false })] });
  assert.equal(result.disposition, 'unverified');
  assert.deepEqual(codes(result), ['report_invalid']);
});

test('non-git workspace with checks is unverifiable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-nogit-'));
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] } });
  assert.equal(result.disposition, 'unverifiable');
  assert.ok(codes(result).includes('snapshot_unavailable'));
});

test('timeout kills the whole process group including a grandchild', async () => {
  const dir = repo();
  const pidFile = path.join(dir, `.accept-pid-${process.pid}-${Date.now()}`);
  const code = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const result = await runCheck({ id: 't', argv: [process.execPath, '-e', code], timeoutMs: 1000 }, { cwd: dir });
  assert.equal(result.timedOut, true);
  assert.equal(result.result, 'failed');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try { process.kill(pid, 0); await tick(50); } catch (_) { alive = false; }
  }
  fs.rmSync(pidFile, { force: true });
  assert.equal(alive, false);
});

function makeAdmission(dir) {
  const db = new Database(':memory:');
  return new WriterAdmission({
    db, workspace: dir, snapshot: takeSnapshot,
    quiescence: { isProcessGroupGone: () => true, killOrphanProcessGroup: () => true }, settleMs: 0,
  });
}

test('admission is held during checks and released after', async () => {
  const dir = repo();
  const admission = makeAdmission(dir);
  let checkStarted;
  const started = new Promise((resolve) => { checkStarted = resolve; });
  const slow = async (check) => {
    checkStarted();
    await tick(300);
    return { id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 300, stdoutTail: '', stderrTail: '', result: 'passed' };
  };
  const running = runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('s', 'void 0')] }, admission, runCheckImpl: slow });
  await started;
  let acquired = false;
  const other = admission.acquire({ role: 'orch-w', taskId: 't2', contextId: 'c2' }).then((handle) => { acquired = true; return handle; });
  await tick(100);
  assert.equal(acquired, false);
  const result = await running;
  assert.equal(result.admissionHeld, true);
  assert.equal(result.disposition, 'accepted');
  const handle = await other;
  assert.equal(acquired, true);
  admission.release(handle.executionId);
});

test('admission is released after a failing check', async () => {
  const dir = repo();
  const admission = makeAdmission(dir);
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('bad', 'process.exit(1)')] }, admission });
  assert.equal(result.disposition, 'rejected');
  const handle = await Promise.race([
    admission.acquire({ role: 'orch-w', taskId: 't3', contextId: 'c3' }),
    tick(2000).then(() => { throw new Error('admission not released'); }),
  ]);
  admission.release(handle.executionId);
});

test('runCheck reports the child pid through onSpawn and runAcceptance records its process identity', async () => {
  const dir = repo();
  const pids = [];
  const result = await runCheck(node('a', 'process.exit(0)'), { cwd: dir, onSpawn: (pid) => pids.push(pid) });
  assert.equal(result.result, 'passed');
  assert.equal(pids.length, 1);
  assert.ok(Number.isInteger(pids[0]));

  const starts = [];
  const admission = {
    async acquire() { return { executionId: 'acc-1' }; },
    release() {},
    recordTurnStart(executionId, details) { starts.push({ executionId, ...details }); },
  };
  const record = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('x', 'process.exit(0)')] }, admission,
  });
  assert.equal(record.disposition, 'accepted');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].pending, true);
  starts.shift();
  assert.equal(starts[0].executionId, 'acc-1');
  assert.equal(starts[0].threadId, null);
  assert.equal(starts[0].processIdentity.pgid, starts[0].processIdentity.pid);
});

test('assessWithoutChecks snapshots only when a writer ran', () => {
  const dir = repo();
  let snapshots = 0;
  const snapshot = (workspace) => { snapshots += 1; return takeSnapshot(workspace); };
  assert.equal(assessWithoutChecks({ workspace: dir, writers: [], snapshot }).disposition, 'not_required');
  assert.equal(snapshots, 0);
  const unverified = assessWithoutChecks({ workspace: dir, writers: [okWriter()], snapshot });
  assert.equal(unverified.disposition, 'unverified');
  assert.equal(snapshots, 1);
  assert.deepEqual(unverified.issues, []);
  assert.equal(unverified.candidate.kind, 'git');
});

test('formatAcceptance starts with the disposition and lists reasons unless accepted', () => {
  assert.equal(formatAcceptance(undefined), '');
  assert.equal(formatAcceptance({ disposition: 'accepted', reasons: [{ code: 'x', detail: 'y' }] }), 'Acceptance: accepted');
  assert.equal(formatAcceptance({ disposition: 'unverified', reasons: [{ code: 'delta_unknown', detail: 'd' }] }), 'Acceptance: unverified\n- delta_unknown: d');
  assert.equal(formatAcceptance({ disposition: 'not_required', reasons: [] }), 'Acceptance: not_required');
});

test('runCheck finishes after exit even when a grandchild in another session holds the pipe', async () => {
  const dir = repo();
  const code = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();";
  const started = Date.now();
  const result = await runCheck(node('gc', code), { cwd: dir, closeGraceMs: 300 });
  assert.equal(result.result, 'passed');
  assert.ok(Date.now() - started < 5000);
});

test('runCheck kills a lingering descendant in the check process group after exit', async () => {
  const dir = repo();
  const marker = path.join(dir, 'late.txt');
  const child = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'x'),1000)`;
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}).unref();`;
  const result = await runCheck(node('lg', code), { cwd: dir });
  assert.equal(result.result, 'passed');
  await tick(1600);
  assert.equal(fs.existsSync(marker), false);
});

test('runAcceptance records a pending turn start before each check spawns', async () => {
  const dir = repo();
  const starts = [];
  const admission = {
    async acquire() { return { executionId: 'acc-2' }; },
    release() {},
    recordTurnStart(executionId, details) { starts.push(details); },
  };
  await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('x', 'process.exit(0)')] }, admission });
  assert.equal(starts.length, 2);
  assert.equal(starts[0].processIdentity, null);
  assert.equal(starts[0].pending, true);
  assert.ok(starts[1].processIdentity);
});

test('abort kills the running check group and yields unverifiable with acceptance_canceled', async () => {
  const dir = repo();
  const admission = makeAdmission(dir);
  const controller = new AbortController();
  const running = runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('long', 'setTimeout(()=>{},30000)')] }, admission, signal: controller.signal,
  });
  await tick(300);
  controller.abort();
  const result = await running;
  assert.equal(result.disposition, 'unverifiable');
  assert.ok(result.issues.some((issue) => issue.code === 'acceptance_canceled'));
  assert.equal(result.checks[0].canceled, true);
  const handle = await Promise.race([
    admission.acquire({ role: 'orch-w', taskId: 'tz', contextId: 'cz' }),
    tick(2000).then(() => { throw new Error('admission not released'); }),
  ]);
  admission.release(handle.executionId);
});

test('abort while waiting for admission is unverifiable with acceptance_canceled', async () => {
  const dir = repo();
  const admission = makeAdmission(dir);
  const holder = await admission.acquire({ role: 'orch-w', taskId: 'h', contextId: 'h' });
  const controller = new AbortController();
  const running = runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('x', 'void 0')] }, admission, signal: controller.signal,
  });
  await tick(100);
  controller.abort();
  const result = await running;
  assert.equal(result.disposition, 'unverifiable');
  assert.equal(result.issues[0].code, 'acceptance_canceled');
  admission.release(holder.executionId);
});

test('a first commit of an out-of-scope file in an unborn repository is not accepted', () => {
  const { diffSnapshots } = require('../src/workspace-snapshot');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-unborn-'));
  try {
    vcs(dir, 'init', '-q');
    vcs(dir, 'config', 'user.email', 't@example.com');
    vcs(dir, 'config', 'user.name', 't');
    const before = takeSnapshot(dir);
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'x\n');
    vcs(dir, 'add', '.');
    vcs(dir, 'commit', '-q', '-m', 'first');
    const after = takeSnapshot(dir);
    const delta = diffSnapshots(before, after, dir);
    assert.equal(delta.known, true);
    const outside = delta.changedPaths.filter((file) => !file.startsWith('src/'));
    assert.deepEqual(outside, ['secret.txt']);
    const result = computeDisposition({
      requiredChecks: [{ id: 'x', argv: ['x'] }], checkResults: [{ id: 'x', result: 'passed' }],
      snapshotBefore: before, snapshotAfter: after, writers: [okWriter({ attestedScopeViolations: outside })], unresolvedWriterCount: 0,
    });
    assert.notEqual(result.disposition, 'accepted');
    assert.ok(codes(result).includes('attested_scope_violation'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
