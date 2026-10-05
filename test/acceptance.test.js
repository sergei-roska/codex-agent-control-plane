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
  validateAcceptanceContract, parseCheckCommand, runCheck, computeDisposition, runAcceptance, verifyCandidate, assessWithoutChecks, formatAcceptance,
  acceptanceIssue, invalidAcceptanceContract, unrunAcceptance,
} = require('../src/acceptance');

const vcs = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
const node = (id, code, extra = {}) => ({ id, argv: [process.execPath, '-e', code], ...extra });
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-'));
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

test('reported and attested scope violations are rejected', async () => {
  const dir = repo();
  const result = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] },
    writers: [okWriter({ reportedScopeViolations: ['x.js'], attestedScopeViolations: ['y.js'] })],
  });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result).sort(), ['attested_scope_violation', 'reported_scope_violation']);
});

test('unknown delta is unverifiable', async () => {
  const dir = repo();
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] }, writers: [okWriter({ deltaKnown: false })] });
  assert.equal(result.disposition, 'unverifiable');
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
  const pidFile = path.join(os.tmpdir(), `accept-pid-${process.pid}-${Date.now()}`);
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

// ---------------------------------------------------- violation records (DBC-02b)

const gitSnap = { kind: 'git', head: 'h', fingerprint: 'f', entries: [] };
const oneCheck = [{ id: 'x', argv: ['x'] }];
const dispose = (extra = {}) => computeDisposition({
  requiredChecks: oneCheck, checkResults: [{ id: 'x', result: 'passed' }], snapshotBefore: gitSnap, snapshotAfter: gitSnap, ...extra,
});

test('a failed check plus an unavailable snapshot is rejected and lists both records', () => {
  const result = dispose({ checkResults: [{ id: 'x', result: 'failed', exitCode: 1 }], snapshotBefore: { kind: 'none' }, snapshotAfter: { kind: 'none' } });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['check_failed', 'snapshot_unavailable']);
  assert.deepEqual(result.issues.map((issue) => [issue.predicate, issue.result]), [['accept.checks', 'FAIL'], ['accept.snapshot', 'UNKNOWN']]);
});

test('unknown-only issues are unverifiable and advisory-only issues are accepted', () => {
  const unknown = dispose({ writers: [okWriter({ deltaKnown: false })] });
  assert.equal(unknown.disposition, 'unverifiable');
  assert.deepEqual(codes(unknown), ['delta_unknown']);
  assert.equal(dispose({ unresolvedWriterCount: 1 }).disposition, 'unverifiable');
  const advisory = dispose({ writers: [okWriter({ reportedScopeViolations: ['z.js'], reportOutcome: 'failed' })] });
  assert.equal(advisory.disposition, 'accepted');
  assert.deepEqual(codes(advisory), ['reported_scope_violation', 'writer_reported_failure']);
  assert.ok(advisory.issues.every((issue) => issue.advisory === true && issue.result === 'FAIL' && issue.predicate === 'accept.writers'));
  const failWins = dispose({ writers: [okWriter({ deltaKnown: false, attestedScopeViolations: ['y.js'] })] });
  assert.equal(failWins.disposition, 'rejected');
});

test('records carry predicate, result, boundary, advisory, evidence and keep code and detail', () => {
  const result = dispose({ writers: [okWriter({ reportValid: false })] });
  assert.deepEqual(result.issues[0], {
    code: 'report_invalid', detail: 'Writer w1 completed without a valid report.', predicate: 'accept.writers', result: 'FAIL', boundary: 'acceptance', advisory: false, evidence: [],
  });
  assert.equal(acceptanceIssue('candidate_changed', 'x').predicate, 'accept.candidate_stable');
  for (const code of ['acceptance_canceled', 'acceptance_error', 'acceptance_not_run']) {
    assert.deepEqual([acceptanceIssue(code, 'd').predicate, acceptanceIssue(code, 'd').result], ['accept.run', 'UNKNOWN']);
  }
});

test('contract_invalid is an accept.contract_valid UNKNOWN and the contract marker survives validation', () => {
  const unrun = unrunAcceptance('contract_invalid', 'bad');
  assert.equal(unrun.disposition, 'unverifiable');
  assert.deepEqual([unrun.issues[0].predicate, unrun.issues[0].result], ['accept.contract_valid', 'UNKNOWN']);
  const marker = invalidAcceptanceContract('bad');
  assert.deepEqual(validateAcceptanceContract(marker), marker);
  assert.equal(validateAcceptanceContract({ requiredChecks: [] }).id, 'acceptance-contract/v1');
  assert.equal(validateAcceptanceContract({ id: 'acceptance-contract/v1', requiredChecks: [] }).requiredChecks.length, 0);
  assert.throws(() => validateAcceptanceContract({ id: 'other', requiredChecks: [] }), TypeError);
});
