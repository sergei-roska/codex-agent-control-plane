'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createEvidenceStore } = require('../src/evidence-store');
const { WriterAdmission } = require('../src/writer-admission');
const { takeSnapshot } = require('../src/workspace-snapshot');
const {
  validateAcceptanceContract, parseCheckCommand, runCheck, computeDisposition, runAcceptance, verifyCandidate, assessWithoutChecks, formatAcceptance,
  acceptanceIssue, invalidAcceptanceContract, unrunAcceptance, validateAgentChecks, pinAgentChecks, runSandboxedCheck, currentPins, repinChecks, describePinChanges,
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

test('unknown-only issues are unverifiable; a reported scope violation rejects while a reported failure is advisory', () => {
  const unknown = dispose({ writers: [okWriter({ deltaKnown: false })] });
  assert.equal(unknown.disposition, 'unverifiable');
  assert.deepEqual(codes(unknown), ['delta_unknown']);
  assert.equal(dispose({ unresolvedWriterCount: 1 }).disposition, 'unverifiable');
  const reported = dispose({ writers: [okWriter({ reportedScopeViolations: ['z.js'], reportOutcome: 'failed' })] });
  assert.equal(reported.disposition, 'rejected');
  assert.deepEqual(codes(reported), ['reported_scope_violation', 'writer_reported_failure']);
  assert.deepEqual(reported.issues.map((issue) => issue.advisory), [false, true]);
  assert.ok(reported.issues.every((issue) => issue.result === 'FAIL' && issue.predicate === 'accept.writers'));
  const failedOnly = dispose({ writers: [okWriter({ reportOutcome: 'failed' })] });
  assert.equal(failedOnly.disposition, 'accepted');
  assert.equal(failedOnly.issues[0].advisory, true);
  // Blind spot: the attested delta is clean but the report lists an out-of-scope path.
  const blind = dispose({ writers: [okWriter({ attestedScopeViolations: [], reportedScopeViolations: ['elsewhere.js'] })] });
  assert.equal(blind.disposition, 'rejected');
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

test('a check printing 10 MiB stores both streams as evidence, keeps the tails, and names the ids on failure', async () => {
  const dir = repo();
  const db = new Database(':memory:');
  const store = createEvidenceStore(db);
  const code = "const b=Buffer.alloc(1024*1024,'a');for(let i=0;i<10;i++){process.stdout.write(b)}process.stdout.write('END-OF-OUT');process.stderr.write('boom-err');process.exitCode=2";
  const result = await runAcceptance({
    workspace: dir, runId: 'run-ev', attempt: 1, contract: { requiredChecks: [node('big', code)] }, evidenceStore: store,
  });
  const check = result.checks[0];
  assert.equal(check.exitCode, 2);
  assert.ok(check.stdoutTail.endsWith('END-OF-OUT'));
  assert.equal(check.stdoutTail.length, 4096);
  assert.equal(check.stdoutTruncated, true);
  assert.equal(check.stderrTail, 'boom-err');
  assert.equal(check.stderrTruncated, false);
  const out = check.stdoutEvidence;
  const err = check.stderrEvidence;
  assert.equal(out.kind, 'check_stdout');
  assert.equal(out.checkId, 'big');
  assert.equal(out.originalBytes, 10 * 1024 * 1024 + 10);
  assert.equal(out.truncated, true);
  assert.equal(out.omitted.offset, 2 * 1024 * 1024);
  assert.equal(out.originalSha256, crypto.createHash('sha256').update(Buffer.concat([Buffer.alloc(10 * 1024 * 1024, 'a'), Buffer.from('END-OF-OUT')])).digest('hex'));
  assert.deepEqual(out.source, { producer: 'acceptance', argv: check.argv, exitCode: 2, signal: null, timedOut: false, canceled: false, stream: 'stdout' });
  assert.equal(err.kind, 'check_stderr');
  assert.equal(store.read(err.id, { runId: 'run-ev' }).bytes.toString(), 'boom-err');
  assert.equal(err.source.stream, 'stderr');
  const issue = result.issues.find((entry) => entry.code === 'check_failed');
  assert.ok(issue.detail.includes(out.id) && issue.detail.includes(err.id), issue.detail);
});

test('without an evidence store the refs are null, and a failing store never fails the run', async () => {
  const dir = repo();
  const none = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'console.log("hi")')] } });
  assert.equal(none.checks[0].stdoutEvidence, null);
  assert.equal(none.checks[0].stderrEvidence, null);
  assert.equal(none.checks[0].stdoutTruncated, false);
  const broken = { put() { throw Object.assign(new Error('no'), { code: 'evidence_boom' }); } };
  const failed = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: { requiredChecks: [node('ok', 'void 0')] }, evidenceStore: broken });
  assert.equal(failed.checks[0].evidenceError, 'evidence_boom');
  assert.equal(failed.checks[0].stdoutEvidence, null);
  assert.equal(failed.disposition, 'accepted');
});

test('computeDisposition renders check results without evidence fields unchanged', () => {
  const result = computeDisposition({
    requiredChecks: [{ id: 'c' }], checkResults: [{ id: 'c', result: 'failed', exitCode: 1 }],
    snapshotBefore: { kind: 'git', fingerprint: 'x' }, snapshotAfter: { kind: 'git', fingerprint: 'x' },
  });
  assert.equal(result.issues[0].detail, 'Required check "c" failed (exit 1).');
});

test('check evidence carries the acceptance attempt; identical output in two runs yields two rows', async () => {
  const dir = repo();
  const db = new Database(':memory:');
  const store = createEvidenceStore(db);
  const contract = { requiredChecks: [node('same', 'process.stdout.write("same");process.exitCode=Number(process.env.EXIT_CODE||0)')] };
  const first = await runAcceptance({ workspace: dir, runId: 'run-att', attempt: 1, contract, evidenceStore: store });
  process.env.EXIT_CODE = '3';
  let second;
  try { second = await runAcceptance({ workspace: dir, runId: 'run-att', attempt: 2, contract, evidenceStore: store }); } finally { delete process.env.EXIT_CODE; }
  const a = first.checks[0].stdoutEvidence;
  const b = second.checks[0].stdoutEvidence;
  assert.notEqual(a.id, b.id);
  assert.equal(a.attemptId, 'run-att:acceptance:1');
  assert.equal(b.attemptId, 'run-att:acceptance:2');
  assert.equal(a.source.exitCode, 0);
  assert.equal(b.source.exitCode, 3);
  // A replay of the same acceptance attempt reuses the row.
  const replay = await runAcceptance({ workspace: dir, runId: 'run-att', attempt: 2, contract, evidenceStore: store });
  assert.equal(replay.checks[0].stdoutEvidence.id, b.id);
});

// ------------------------------------------------- LL-4: agent-proposed checks

const EXACT_POLICY = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const agentContract = (...requiredChecks) => ({ id: 'acceptance-contract/v1', source: 'agent', requiredChecks });
const noHostRun = async () => { throw new Error('an agent check must never run on the host'); };
function fakeExec(reply) {
  const calls = [];
  return { calls, execCommand: async (args) => { calls.push(args); return typeof reply === 'function' ? reply(args) : reply; } };
}

test('the agent source survives contract validation and other sources are refused', () => {
  const out = validateAcceptanceContract(agentContract({ id: 'unit', argv: ['npm', 'test'] }));
  assert.deepEqual(out, agentContract({ id: 'unit', argv: ['npm', 'test'], timeoutMs: 600000 }));
  assert.deepEqual(validateAcceptanceContract(out), out);
  assert.throws(() => validateAcceptanceContract({ source: 'owner', requiredChecks: [] }), /unknown field "source"/);
});

test('validateAgentChecks pins known tools and workspace scripts with the agent source', () => {
  const ws = '/srv/ws';
  const contract = validateAgentChecks([
    { id: 'unit', argv: ['npm', 'test'], timeoutMs: null },
    { id: 'gate', argv: ['scripts/gate.sh'], timeoutMs: 1000 },
    { id: 'abs', argv: ['/srv/ws/bin/check', '--strict'], timeoutMs: null },
    { id: 'shell', argv: ['bash', 'scripts/m3.sh'], timeoutMs: null },
    { id: 'py', argv: ['python', '-m', 'pytest', '-c', 'pytest.ini'], timeoutMs: null },
    { id: 'venv', argv: ['.venv/bin/python', '-m', 'pytest'], timeoutMs: null },
    { id: 'plugins', argv: ['pytest', '-k', 'node', '-p', 'no:cacheprovider'], timeoutMs: null },
    { id: 'uv', argv: ['uv', 'run', 'pytest', 'tests'], timeoutMs: null },
  ], { workspace: ws });
  assert.equal(contract.source, 'agent');
  assert.equal(contract.id, 'acceptance-contract/v1');
  assert.deepEqual(contract.requiredChecks.map((check) => check.timeoutMs), [600000, 1000, 600000, 600000, 600000, 600000, 600000, 600000]);
});

test('validateAgentChecks refuses vacuous and unsafe checks, one guard at a time', () => {
  const refuse = (argv, pattern) => assert.throws(
    () => validateAgentChecks([{ id: 'c', argv, timeoutMs: null }], { workspace: '/srv/ws' }), pattern, JSON.stringify(argv),
  );
  // argv[0]: a workspace path or a known tool.
  for (const argv of [['curl', 'x'], ['check.sh'], ['/usr/bin/python3', 'x.py'], ['../outside.sh'], ['/srv/other/x.sh'], ['/srv/ws']]) {
    refuse(argv, /argv\[0\] must be a script path inside the workspace or one of python, python3, pytest/);
  }
  // Inline code after an interpreter.
  for (const argv of [
    ['python', '-c', 'print(1)'], ['python3', '-Ic', 'pass'], ['python', '-W', 'ignore', '-c', 'pass'], ['python3', '-Wignore', '-c', 'x'],
    ['node', '-e', '1'], ['node', '--eval', '1'], ['node', '--eval=1'], ['node', '-p', '1'], ['node', '-pe', '1'], ['node', '-r', './setup.js', '-e', '1'],
    ['.venv/bin/python', '-c', 'pass'], ['uv', 'run', 'python', '-c', 'pass'], ['npx', 'node', '-e', '1'], ['uv', 'run', 'bash', '-c', 'true'],
    ['npm', 'exec', '--', 'sh', '-ec', 'true'],
  ]) refuse(argv, /inline code/);
  // Commands that prove nothing.
  for (const name of ['echo', 'true', 'false', 'test', '[', 'yes']) refuse([name, 'x'], /proves nothing/);
  refuse(['./true'], /proves nothing/);
  refuse(['bin/echo', 'ok'], /proves nothing/);
  // bash and sh need a workspace script as argv[1].
  for (const argv of [['bash'], ['sh', '-c', 'exit 0'], ['bash', '-e', 'x.sh'], ['sh', '/tmp/x.sh'], ['bash', '../x.sh']]) {
    refuse(argv, /needs a script path inside the workspace as argv\[1\]/);
  }
  // The acceptance-contract/v1 limits still apply.
  refuse(['npm', 'test', ''], /argv entries must be non-empty/);
  assert.throws(() => validateAgentChecks(Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, argv: ['npm', 'test'], timeoutMs: null })), { workspace: '/srv/ws' }), /more than 10/);
  assert.throws(() => validateAgentChecks([{ id: 'bad id', argv: ['npm', 'test'], timeoutMs: null }], { workspace: '/srv/ws' }), /id must be/);
  assert.throws(() => validateAgentChecks([{ id: 'x', argv: ['npm', 'test'], timeoutMs: null, shell: true }], { workspace: '/srv/ws' }), /unknown field "shell"/);
});

test('agent checks run only through execCommand with the read-only-workspace policy', async () => {
  const dir = repo();
  const exec = fakeExec({ exitCode: 0, stdout: 'all good', stderr: '' });
  const db = new Database(':memory:');
  const store = createEvidenceStore(db);
  const result = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: agentContract({ id: 'unit', argv: ['npm', 'test'], timeoutMs: 1234 }),
    writers: [okWriter()], appServer: exec, runCheckImpl: noHostRun, evidenceStore: store,
  });
  assert.equal(result.disposition, 'accepted');
  assert.deepEqual(exec.calls, [{ command: ['npm', 'test'], cwd: dir, sandboxPolicy: EXACT_POLICY, timeoutMs: 1234 }]);
  const [check] = result.checks;
  assert.equal(check.result, 'passed');
  assert.equal(check.exitCode, 0);
  assert.equal(check.sandboxed, true);
  assert.equal(check.stdoutTail, 'all good');
  assert.equal(check.stdoutEvidence.kind, 'check_stdout');
});

test('a failing agent check is rejected with check_failed and its output', async () => {
  const dir = repo();
  const exec = fakeExec({ exitCode: 2, stdout: '', stderr: '3 failed' });
  const result = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: agentContract({ id: 'unit', argv: ['pytest'] }), appServer: exec, runCheckImpl: noHostRun,
  });
  assert.equal(result.disposition, 'rejected');
  assert.deepEqual(codes(result), ['check_failed']);
  assert.equal(result.checks[0].exitCode, 2);
  assert.equal(result.checks[0].stderrTail, '3 failed');
});

test('an agent check whose execCommand throws or is missing is unverified, never a pass', async () => {
  const dir = repo();
  const throwing = { execCommand: async () => { throw new Error('sandbox unavailable'); } };
  const failed = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: agentContract({ id: 'unit', argv: ['npm', 'test'] }), appServer: throwing, runCheckImpl: noHostRun,
  });
  assert.equal(failed.disposition, 'unverifiable');
  assert.deepEqual(codes(failed), ['check_error']);
  assert.equal(failed.checks[0].result, 'error');
  assert.match(failed.checks[0].error, /sandbox unavailable/);
  assert.equal(failed.issues[0].result, 'UNKNOWN');
  const missing = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 2, contract: agentContract({ id: 'unit', argv: ['npm', 'test'] }), appServer: {}, runCheckImpl: noHostRun,
  });
  assert.equal(missing.disposition, 'unverifiable');
  assert.equal(missing.checks[0].error, 'EXEC_UNAVAILABLE');
  const noExit = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 3, contract: agentContract({ id: 'unit', argv: ['npm', 'test'] }), appServer: fakeExec({ stdout: '' }), runCheckImpl: noHostRun,
  });
  assert.equal(noExit.disposition, 'unverifiable');
});

test('a sandboxed check that outlives its timeoutMs is a timed-out failure', async () => {
  const hung = { execCommand: () => new Promise(() => {}) };
  const result = await runSandboxedCheck({ id: 'slow', argv: ['npm', 'test'], timeoutMs: 20 }, { appServer: hung, cwd: '/srv/ws', graceMs: 5 });
  assert.equal(result.timedOut, true);
  assert.equal(result.result, 'failed');
  const late = { execCommand: async () => { await tick(30); throw new Error('command timed out'); } };
  const after = await runSandboxedCheck({ id: 'slow', argv: ['npm', 'test'], timeoutMs: 20 }, { appServer: late, cwd: '/srv/ws', graceMs: 1000 });
  assert.equal(after.timedOut, true);
  assert.equal(after.result, 'failed');
  const snap = { kind: 'git', head: 'h', fingerprint: 'f', entries: [] };
  const disposition = computeDisposition({ requiredChecks: [{ id: 'slow', argv: ['x'] }], checkResults: [after], snapshotBefore: snap, snapshotAfter: snap });
  assert.equal(disposition.disposition, 'rejected');
});

test('agent checks hold admission without a host process turn start; owner checks still use runCheck', async () => {
  const dir = repo();
  const turnStarts = [];
  const admission = {
    async acquire() { return { executionId: 'acc' }; },
    release() {},
    recordTurnStart(executionId, details) { turnStarts.push(details); },
  };
  const exec = fakeExec({ exitCode: 0, stdout: '', stderr: '' });
  const agent = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 1, contract: agentContract({ id: 'unit', argv: ['npm', 'test'] }), admission, appServer: exec, runCheckImpl: noHostRun,
  });
  assert.equal(agent.admissionHeld, true);
  assert.equal(agent.disposition, 'accepted');
  assert.deepEqual(turnStarts, []);
  const hostRuns = [];
  const owner = await runAcceptance({
    workspace: dir, runId: 'r', attempt: 2, contract: { requiredChecks: [{ id: 'unit', argv: ['npm', 'test'] }] }, admission, appServer: exec,
    runCheckImpl: async (check) => { hostRuns.push(check.id); return { id: check.id, argv: check.argv, exitCode: 0, signal: null, timedOut: false, error: null, durationMs: 1, stdoutTail: '', stderrTail: '', result: 'passed' }; },
  });
  assert.equal(owner.disposition, 'accepted');
  assert.deepEqual(hostRuns, ['unit']);
  assert.equal(exec.calls.length, 1);
  assert.equal(turnStarts.length, 1);
});

// ------------------------------------------------- pinned scripts of agent checks
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function pinWorkspace() {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'validate.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'tools', 'check.sh'), 'exit 0\n');
  return dir;
}

test('pins cover argv[0] and script arguments and ignore non-files and outside paths', () => {
  const dir = pinWorkspace();
  const outside = path.join(os.tmpdir(), 'outside-pin.txt');
  fs.writeFileSync(outside, 'x');
  const contract = validateAgentChecks([
    { id: 'py', argv: ['python', 'tools/validate.py', '--strict', 'tools', 'missing.txt', outside, '../outside-pin.txt'], timeoutMs: null },
    { id: 'self', argv: [path.join(dir, 'tools', 'check.sh')], timeoutMs: null },
    { id: 'plain', argv: ['npm', 'test'], timeoutMs: null },
  ], { workspace: dir });
  assert.deepEqual(contract.requiredChecks[0].pins, [{ path: 'tools/validate.py', sha256: sha('print(1)\n') }]);
  assert.deepEqual(contract.requiredChecks[1].pins, [{ path: 'tools/check.sh', sha256: sha('exit 0\n') }]);
  assert.equal('pins' in contract.requiredChecks[2], false);
  assert.deepEqual(validateAcceptanceContract(contract), contract);
  assert.equal(pinAgentChecks(contract, dir).requiredChecks[0].pins.length, 1);
});

test('an unchanged pinned script lets the check run', async () => {
  const dir = pinWorkspace();
  const contract = validateAgentChecks([{ id: 'py', argv: ['python', 'tools/validate.py'], timeoutMs: null }], { workspace: dir });
  const exec = fakeExec({ exitCode: 0, stdout: '', stderr: '' });
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract, appServer: exec, runCheckImpl: noHostRun });
  assert.equal(result.disposition, 'accepted');
  assert.equal(exec.calls.length, 1);
});

test('a modified or deleted pinned script gives check_changed and the check is not run', async () => {
  const dir = pinWorkspace();
  const contract = validateAgentChecks([{ id: 'py', argv: ['python', 'tools/validate.py'], timeoutMs: null }], { workspace: dir });
  const exec = fakeExec({ exitCode: 0, stdout: '', stderr: '' });
  fs.writeFileSync(path.join(dir, 'tools', 'validate.py'), 'print(2)\n');
  const modified = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract, appServer: exec, runCheckImpl: noHostRun });
  assert.equal(exec.calls.length, 0);
  assert.equal(modified.disposition, 'unverifiable');
  assert.deepEqual(codes(modified), ['check_changed']);
  assert.match(modified.issues[0].detail, /tools\/validate\.py.*owner's decision/);
  assert.equal(modified.issues[0].result, 'UNKNOWN');
  fs.rmSync(path.join(dir, 'tools', 'validate.py'));
  const deleted = await runAcceptance({ workspace: dir, runId: 'r', attempt: 2, contract, appServer: exec, runCheckImpl: noHostRun });
  assert.equal(exec.calls.length, 0);
  assert.deepEqual(codes(deleted), ['check_changed']);
});

// ------------------------------------------------- LL-6: reviewed changes of pinned checks

test('a change judged as weakening fails as check_weakened for exactly that content, without running', async () => {
  const dir = pinWorkspace();
  const contract = validateAgentChecks([{ id: 'py', argv: ['python', 'tools/validate.py'], timeoutMs: null }], { workspace: dir });
  const exec = fakeExec({ exitCode: 0, stdout: '', stderr: '' });
  fs.writeFileSync(path.join(dir, 'tools', 'validate.py'), 'print(2)\n');
  const weakened = [{ checkId: 'py', pins: currentPins(contract.requiredChecks[0], dir), by: 'auditor review r:r1:review1' }];
  const failed = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract, appServer: exec, runCheckImpl: noHostRun, weakened });
  assert.equal(exec.calls.length, 0);
  assert.equal(failed.disposition, 'rejected');
  assert.deepEqual(codes(failed), ['check_weakened']);
  assert.equal(failed.issues[0].result, 'FAIL');
  assert.match(failed.issues[0].detail, /weakens its requirement \(auditor review r:r1:review1\)/);
  // Other content than the judged one is a new change.
  fs.writeFileSync(path.join(dir, 'tools', 'validate.py'), 'print(3)\n');
  const again = await runAcceptance({ workspace: dir, runId: 'r', attempt: 2, contract, appServer: exec, runCheckImpl: noHostRun, weakened });
  assert.deepEqual(codes(again), ['check_changed']);
});

test('repinChecks pins the reviewed content and describePinChanges falls back to the current content', async () => {
  const dir = pinWorkspace();
  const contract = validateAgentChecks([{ id: 'py', argv: ['python', 'tools/validate.py'], timeoutMs: null }], { workspace: dir });
  fs.writeFileSync(path.join(dir, 'tools', 'validate.py'), 'print(2)\n');
  const [change] = describePinChanges(contract.requiredChecks[0], dir);
  assert.equal(change.path, 'tools/validate.py');
  assert.equal(change.pinnedSha256, contract.requiredChecks[0].pins[0].sha256);
  assert.equal(change.currentSha256, crypto.createHash('sha256').update('print(2)\n').digest('hex'));
  // The pinned bytes were never committed here, so only the current content can be shown.
  assert.equal(change.diff, 'print(2)\n');
  assert.match(change.note, /not available from git/);
  const reviewed = [{ id: 'py', pins: currentPins(contract.requiredChecks[0], dir) }];
  const repinned = repinChecks(contract, reviewed);
  assert.deepEqual(validateAcceptanceContract(repinned), repinned);
  assert.equal(repinned.source, 'agent');
  const exec = fakeExec({ exitCode: 0, stdout: '', stderr: '' });
  const result = await runAcceptance({ workspace: dir, runId: 'r', attempt: 1, contract: repinned, appServer: exec, runCheckImpl: noHostRun });
  assert.equal(result.disposition, 'accepted');
  assert.equal(exec.calls.length, 1);
  // A file that was gone at review time loses its pin.
  assert.equal('pins' in repinChecks(contract, [{ id: 'py', pins: [{ path: 'tools/validate.py', sha256: null }] }]).requiredChecks[0], false);
});
