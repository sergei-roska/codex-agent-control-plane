'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { takeSnapshot } = require('./workspace-snapshot');
const { readProcessIdentity } = require('./process-quiescence');
const { assertCodexHomeOutsideWorkspace } = require('./permission-profile');

const MAX_CHECKS = 10;
const MAX_ID = 64;
const MAX_ARGV = 64;
const MAX_ARG = 4096;
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 1800000;
const TAIL = 4096;
const CLOSE_GRACE_MS = 2000;
const SANDBOX_PROFILE = 'codex-a2a-acceptance';
const CHECK_ENV_KEYS = ['PATH', 'HOME', 'CODEX_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'CI', 'NO_COLOR', 'FORCE_COLOR'];
const CHECK_CAPTURE_RUNNER = [
  "const cp=require('node:child_process');const fs=require('node:fs');const meta=JSON.parse(process.argv[1]);const argv=process.argv.slice(2);",
  "const env={...process.env,TMPDIR:meta.tempDir,TMP:meta.tempDir,TEMP:meta.tempDir};const out=fs.openSync(meta.stdoutPath,'w');const err=fs.openSync(meta.stderrPath,'w');let settled=false;",
  "const child=cp.spawn(argv[0],argv.slice(1),{cwd:process.cwd(),env,stdio:['ignore',out,err],shell:false});",
  "child.on('error',(error)=>{if(settled)return;settled=true;try{fs.writeSync(err,String(error.message));fs.closeSync(out);fs.closeSync(err)}catch(_){}process.exitCode=1});",
  "child.on('close',(code)=>{if(settled)return;settled=true;try{fs.closeSync(out);fs.closeSync(err)}catch(_){}process.exitCode=code===null?1:code});",
].join('');

function sanitizedCheckEnv(source = process.env) {
  const env = {};
  for (const key of CHECK_ENV_KEYS) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return env;
}

function readCapturedTail(directoryFd, directoryPath, fileName) {
  let fd;
  try {
    const filePath = process.platform === 'linux' && directoryFd !== null
      ? `/proc/self/fd/${directoryFd}/${fileName}`
      : path.join(directoryPath, fileName);
    if (fs.constants.O_NOFOLLOW === undefined && fs.lstatSync(filePath).isSymbolicLink()) return '';
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return '';
    const length = Math.min(stat.size, TAIL * 2);
    const bytes = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, bytes, 0, length, stat.size - length);
    return bytes.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* Already closed. */ }
    }
  }
}

function resolveCodexExecutable(env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'codex');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch (_) { /* Try the next PATH entry. */ }
  }
  throw new Error('Could not resolve Codex executable "codex" on PATH');
}

function resolveCheckExecutable(argv0, cwd, env) {
  const candidates = path.isAbsolute(argv0) || argv0.includes(path.sep)
    ? [path.resolve(cwd, argv0)]
    : (env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, argv0));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* Try the next PATH entry. */ }
  }
  return null;
}

function resolveNpmInstallDir(argv, cwd, env) {
  if (argv[0] !== 'npm') return null;
  const executable = resolveCheckExecutable('npm', cwd, env);
  if (!executable) return null;
  const realExecutable = fs.realpathSync(executable);
  const npmBin = path.dirname(realExecutable);
  const installDir = path.dirname(npmBin);
  if (path.basename(realExecutable) !== 'npm-cli.js' || path.basename(npmBin) !== 'bin' || path.basename(installDir) !== 'npm') {
    throw new Error('Refusing to grant reads to an unrecognized npm installation');
  }
  const nodeRealPath = fs.realpathSync(process.execPath);
  const nodePrefix = path.dirname(path.dirname(nodeRealPath));
  const trustedInstallDirs = new Set([
    path.resolve(nodePrefix, 'lib', 'node_modules', 'npm'),
    path.resolve(nodePrefix, 'lib64', 'node_modules', 'npm'),
    path.resolve(nodePrefix, 'share', 'nodejs', 'npm'),
    '/usr/share/nodejs/npm',
    '/usr/lib/node_modules/npm',
    '/usr/local/lib/node_modules/npm',
  ]);
  const canonicalInstallDir = fs.realpathSync(installDir);
  if (!trustedInstallDirs.has(canonicalInstallDir)) {
    throw new Error('Refusing to grant reads to npm outside a trusted Node installation');
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(canonicalInstallDir, 'package.json'), 'utf8'));
  if (packageJson.name !== 'npm') throw new Error('Refusing to grant reads to an invalid npm package tree');
  return canonicalInstallDir;
}

function resolveGitMetadataDirs(cwd) {
  const gitEntry = path.resolve(cwd, '.git');
  let entryStat;
  try {
    entryStat = fs.lstatSync(gitEntry);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (entryStat.isSymbolicLink()) throw new Error('Workspace .git path must not be a symlink');
  if (entryStat.isDirectory()) return [];
  if (!entryStat.isFile()) throw new Error('Workspace .git path must be a directory or linked-worktree file');

  const pointerLines = fs.readFileSync(gitEntry, 'utf8').trim().split(/\r?\n/);
  const pointer = pointerLines.length === 1 ? pointerLines[0].match(/^gitdir:\s*(.+)$/i) : null;
  if (!pointer) throw new Error('Workspace .git file has an invalid gitdir pointer');
  const gitDir = fs.realpathSync(path.resolve(cwd, pointer[1].trim()));
  if (!fs.statSync(gitDir).isDirectory()) throw new Error('Linked-worktree gitdir is not a directory');

  let commonDir = gitDir;
  let linkedWorktree = false;
  const commonDirFile = path.join(gitDir, 'commondir');
  try {
    const commonValue = fs.readFileSync(commonDirFile, 'utf8').trim();
    if (!commonValue || commonValue.includes('\n')) throw new Error('Linked-worktree commondir is invalid');
    commonDir = fs.realpathSync(path.resolve(gitDir, commonValue));
    linkedWorktree = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const name of ['HEAD', 'config']) {
    if (!fs.lstatSync(path.join(commonDir, name)).isFile()) throw new Error(`Git common directory is missing ${name}`);
  }
  for (const name of ['objects', 'refs']) {
    if (!fs.lstatSync(path.join(commonDir, name)).isDirectory()) throw new Error(`Git common directory is missing ${name}`);
  }
  if (linkedWorktree) {
    const worktreeRoot = path.join(commonDir, 'worktrees');
    const relativeGitDir = path.relative(worktreeRoot, gitDir);
    if (!relativeGitDir || relativeGitDir.startsWith('..') || path.isAbsolute(relativeGitDir) || relativeGitDir.includes(path.sep)) {
      throw new Error('Linked-worktree gitdir is outside its canonical common directory');
    }
    const backPointer = fs.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
    if (fs.realpathSync(path.resolve(gitDir, backPointer)) !== fs.realpathSync(gitEntry)) {
      throw new Error('Linked-worktree gitdir does not point back to this workspace');
    }
  }
  return [...new Set([gitDir, commonDir])];
}

function existingRestrictedPath(cwd, relativePath, access, missingPattern = null) {
  try {
    const stat = fs.lstatSync(path.resolve(cwd, relativePath));
    if (stat.isSymbolicLink()) throw new Error(`Acceptance restricted path must not be a symbolic link: ${relativePath}`);
    return [[relativePath, access]];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return missingPattern ? [[missingPattern, access]] : [];
  }
}

function buildSandboxCommand({ argv, cwd, tempDir, env = process.env }) {
  assertCodexHomeOutsideWorkspace(cwd, env);
  const codexPath = resolveCodexExecutable(env);
  const readableDirs = new Set([
    path.dirname(codexPath),
    path.dirname(fs.realpathSync(process.execPath)),
  ]);
  const npmInstallDir = resolveNpmInstallDir(argv, cwd, env);
  if (npmInstallDir) readableDirs.add(npmInstallDir);
  for (const gitDir of resolveGitMetadataDirs(cwd)) readableDirs.add(gitDir);
  let codexRestrictions = [
    ['.codex/auth.json*', 'deny'],
    ['.codex/sessions/**', 'deny'],
  ];
  try {
    const codexDir = fs.lstatSync(path.resolve(cwd, '.codex'));
    if (!codexDir.isDirectory() || codexDir.isSymbolicLink()) {
      throw new Error('Workspace .codex path must be a real directory for acceptance checks');
    }
    codexRestrictions = [
      ...existingRestrictedPath(cwd, '.codex/auth.json', 'deny', '.codex/auth.json*'),
      ...existingRestrictedPath(cwd, '.codex/sessions', 'deny', '.codex/sessions/**'),
    ];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sensitiveRestrictions = ['.runtime', '.env', 'runtime', 'data']
    .flatMap((relativePath) => existingRestrictedPath(cwd, relativePath, 'deny'));
  const gitRestriction = existingRestrictedPath(cwd, '.git', 'read');
  const restrictedPaths = [...sensitiveRestrictions, ...gitRestriction, ['.env.*', 'deny'], ...codexRestrictions];
  const workspaceRestrictedPaths = [...sensitiveRestrictions, ['.env.*', 'deny'], ...codexRestrictions];
  const tempName = path.basename(tempDir);
  const workspaceRoots = [
    '"."="write"',
    ...gitRestriction.map(([relativePath, access]) => `${JSON.stringify(relativePath)}=${JSON.stringify(access)}`),
    ...workspaceRestrictedPaths.map(([relativePath, access]) => `${JSON.stringify(relativePath)}=${JSON.stringify(access)}`),
    `${JSON.stringify(tempName)}="write"`,
  ].join(',');
  const filesystem = [
    '":root"="deny"',
    '":minimal"="read"',
    '":tmpdir"="deny"',
    '":slash_tmp"="deny"',
    ...[...readableDirs].map((dir) => `${JSON.stringify(dir)}="read"`),
    ...restrictedPaths.map(([relativePath, access]) => `${JSON.stringify(path.resolve(cwd, relativePath))}=${JSON.stringify(access)}`),
    `${JSON.stringify(path.resolve(tempDir))}="write"`,
    `":workspace_roots"={${workspaceRoots}}`,
  ].join(',');
  const profile = `permissions.${SANDBOX_PROFILE}={extends=":workspace",filesystem={${filesystem}},network={enabled=false}}`;
  const captureArgs = [
    process.execPath,
    '-e',
    CHECK_CAPTURE_RUNNER,
    JSON.stringify({
      stdoutPath: path.join(tempDir, 'stdout.log'),
      stderrPath: path.join(tempDir, 'stderr.log'),
      tempDir,
    }),
    ...argv,
  ];
  return {
    command: codexPath,
    args: ['sandbox', '-C', path.resolve(cwd), '-P', SANDBOX_PROFILE, '-c', profile, '--', ...captureArgs],
  };
}

function validateAcceptanceContract(value) {
  if (value === undefined || value === null) return { requiredChecks: [] };
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('acceptance must be an object');
  for (const key of Object.keys(value)) {
    if (key !== 'requiredChecks') throw new TypeError(`acceptance has unknown field "${key}"`);
  }
  const checks = value.requiredChecks === undefined ? [] : value.requiredChecks;
  if (!Array.isArray(checks)) throw new TypeError('acceptance.requiredChecks must be an array');
  if (checks.length > MAX_CHECKS) throw new TypeError(`acceptance.requiredChecks has more than ${MAX_CHECKS} entries`);
  const seen = new Set();
  const requiredChecks = checks.map((check, index) => {
    const at = `acceptance.requiredChecks[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) throw new TypeError(`${at} must be an object`);
    for (const key of Object.keys(check)) {
      if (!['id', 'argv', 'timeoutMs'].includes(key)) throw new TypeError(`${at} has unknown field "${key}"`);
    }
    const { id, argv } = check;
    if (typeof id !== 'string' || !id || id.length > MAX_ID || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new TypeError(`${at}.id must be 1-${MAX_ID} chars of [A-Za-z0-9._-]`);
    }
    if (seen.has(id)) throw new TypeError(`${at}.id "${id}" is duplicated`);
    seen.add(id);
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) {
      throw new TypeError(`${at}.argv must be a non-empty array of at most ${MAX_ARGV} strings`);
    }
    for (const arg of argv) {
      if (typeof arg !== 'string' || !arg || arg.length > MAX_ARG) {
        throw new TypeError(`${at}.argv entries must be non-empty strings of at most ${MAX_ARG} chars`);
      }
    }
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (check.timeoutMs !== undefined) {
      if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > MAX_TIMEOUT_MS) {
        throw new TypeError(`${at}.timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`);
      }
      timeoutMs = check.timeoutMs;
    }
    return { id, argv: [...argv], timeoutMs };
  });
  return { requiredChecks };
}

function parseCheckCommand(text, index) {
  const argv = String(text).trim().split(/\s+/).filter(Boolean);
  return { id: `check-${index + 1}`, argv };
}

function runCheck({ id, argv, timeoutMs = DEFAULT_TIMEOUT_MS }, { cwd, onSpawn, signal, closeGraceMs = CLOSE_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error = null;
    let settled = false;
    let canceled = false;
    let timer = null;
    let graceTimer = null;
    let onAbort = null;
    let tempDir = null;
    let tempDirFd = null;
    const finish = (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (tempDirFd !== null) {
        try { fs.closeSync(tempDirFd); } catch (_) { /* Already closed. */ }
      }
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* Preserve the check result; snapshots still detect leftovers. */ }
      }
      resolve({
        id,
        argv,
        exitCode: exitCode === undefined ? null : exitCode,
        signal: exitSignal || null,
        timedOut,
        canceled,
        error,
        durationMs: Date.now() - started,
        stdoutTail: stdout.slice(-TAIL),
        stderrTail: stderr.slice(-TAIL),
        result: exitCode === 0 && !timedOut && !canceled ? 'passed' : 'failed',
      });
    };
    let child;
    try {
      const sourceEnv = process.env;
      const sandboxEnv = sanitizedCheckEnv(sourceEnv);
      if (!resolveCheckExecutable(argv[0], cwd, sandboxEnv)) {
        error = 'ENOENT';
        stderr = `${argv[0]} was not found on PATH`;
        finish(null, null);
        return;
      }
      tempDir = fs.mkdtempSync(path.join(path.resolve(cwd), '.acceptance-tmp-'));
      const directoryFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
      tempDirFd = fs.openSync(tempDir, directoryFlags);
      const sandbox = buildSandboxCommand({ argv, cwd, tempDir, env: sourceEnv });
      child = spawn(sandbox.command, sandbox.args, { cwd, env: sandboxEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (spawnError) {
      error = spawnError.code || 'CODEX_SANDBOX_UNAVAILABLE';
      stderr = spawnError.message || String(spawnError);
      finish(null, null);
      return;
    }
    if (typeof onSpawn === 'function' && Number.isInteger(child.pid)) {
      // The child leads its own process group; callers record it so a crash can prove quiescence.
      try { onSpawn(child.pid); } catch (_) { /* recording is best effort */ }
    }
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* ESRCH: the group is already gone */ }
    };
    if (signal) {
      onAbort = () => { canceled = true; killGroup(); try { child.kill('SIGKILL'); } catch (_) { /* gone */ } };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-TAIL * 2); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-TAIL * 2); });
    child.on('error', (spawnError) => {
      error = spawnError.code || 'SPAWN_ERROR';
      finish(null, null);
    });
    child.on('exit', (code, exitSignal) => {
      if (tempDir) {
        stdout = (stdout + readCapturedTail(tempDirFd, tempDir, 'stdout.log')).slice(-TAIL * 2);
        stderr = (stderr + readCapturedTail(tempDirFd, tempDir, 'stderr.log')).slice(-TAIL * 2);
      }
      // A descendant must not outlive the check and mutate the workspace after the second snapshot.
      killGroup();
      // A grandchild in another session may hold the pipes open, so `close` may never come.
      graceTimer = setTimeout(() => finish(code, exitSignal), closeGraceMs);
    });
    child.on('close', (code, exitSignal) => finish(code, exitSignal));
    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* gone */ } }
    }, timeoutMs);
  });
}

function computeDisposition({
  requiredChecks = [], checkResults = [], snapshotBefore, snapshotAfter, writers = [], unresolvedWriterCount = 0,
} = {}) {
  const issues = [];
  const warnings = [];
  const results = new Map((checkResults || []).map((result) => [result.id, result]));
  for (const check of requiredChecks) {
    const result = results.get(check.id);
    if (!result) issues.push({ code: 'check_missing', detail: `Required check "${check.id}" has no result.` });
    else if (result.result !== 'passed') {
      issues.push({ code: 'check_failed', detail: `Required check "${check.id}" failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}${result.error ? `, ${result.error}` : ''}).` });
    }
  }
  if (unresolvedWriterCount > 0) {
    issues.push({ code: 'writer_unresolved', detail: `${unresolvedWriterCount} writer outcome(s) unresolved.` });
  }
  for (const writer of writers) {
    const who = writer.attemptId || writer.role || 'writer';
    if (writer.completed && !writer.reportValid) {
      issues.push({ code: 'report_invalid', detail: `Writer ${who} completed without a valid report.` });
    }
    // A self-reported file list is advisory: it blocks only when the server cannot prove the writer's real delta.
    const reportedKnown = writer.ran && writer.deltaKnown;
    for (const item of writer.reportedScopeViolations || []) {
      if (reportedKnown) warnings.push({ code: 'reported_scope_mismatch', detail: `Writer ${who} reported a change outside its scope that the server did not observe: ${item}` });
      else issues.push({ code: 'reported_scope_violation', detail: `Writer ${who} reported: ${item}` });
    }
    for (const item of writer.attestedScopeViolations || []) {
      issues.push({ code: 'attested_scope_violation', detail: `Writer ${who} changed out of scope: ${item}` });
    }
    if (writer.ran && !writer.deltaKnown) {
      issues.push({ code: 'delta_unknown', detail: `Writer ${who} ran but its workspace delta is unknown.` });
    }
  }
  const unavailable = snapshotBefore?.kind !== 'git' || snapshotAfter?.kind !== 'git';
  if (unavailable) {
    issues.push({ code: 'snapshot_unavailable', detail: 'No git snapshot of the candidate is available.' });
  } else if (snapshotBefore.fingerprint !== snapshotAfter.fingerprint) {
    issues.push({ code: 'candidate_changed', detail: 'The workspace changed while checks were running.' });
  }
  if (requiredChecks.length > 0) {
    if (unavailable) return { disposition: 'unverifiable', reasons: issues, issues, warnings };
    return { disposition: issues.length === 0 ? 'accepted' : 'rejected', reasons: issues, issues, warnings };
  }
  const anyRan = writers.some((writer) => writer.ran);
  // Without required checks no candidate is fingerprinted for acceptance, so snapshot issues
  // matter only when a writer ran.
  const list = anyRan ? issues : issues.filter((issue) => !['snapshot_unavailable', 'candidate_changed'].includes(issue.code));
  return { disposition: anyRan ? 'unverified' : 'not_required', reasons: list, issues: list, warnings };
}

function canceledAcceptance(requiredChecks, checks, admissionHeld) {
  const issues = [{ code: 'acceptance_canceled', detail: 'Acceptance was canceled before the checks completed.' }];
  return {
    disposition: 'unverifiable',
    reasons: issues,
    issues,
    candidate: { kind: null, head: null, fingerprint: null },
    candidateAfter: { fingerprint: null },
    checks,
    requiredCheckIds: requiredChecks.map((check) => check.id),
    verifiedAt: new Date().toISOString(),
    admissionHeld,
  };
}

async function runAcceptance({
  workspace, runId, attempt, contract, writers = [], unresolvedWriterCount = 0, admission, signal,
  snapshot = takeSnapshot, runCheckImpl = runCheck,
}) {
  const { requiredChecks } = validateAcceptanceContract(contract);
  let held = null;
  if (admission) {
    const id = `${runId}:accept:${attempt}`;
    try {
      held = await admission.acquire({ role: 'acceptance', taskId: id, contextId: id, signal });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) return canceledAcceptance(requiredChecks, [], false);
      throw error;
    }
  }
  try {
    const snapshotBefore = snapshot(workspace);
    const checks = [];
    const onSpawn = held
      ? (pid) => admission.recordTurnStart(held.executionId, { processIdentity: readProcessIdentity(pid), threadId: null })
      : undefined;
    for (const check of requiredChecks) {
      if (signal?.aborted) return canceledAcceptance(requiredChecks, checks, Boolean(held));
      // Crash window: a turn start without a proven identity keeps quiescence unproven until the real one is recorded.
      if (held) admission.recordTurnStart(held.executionId, { processIdentity: null, pending: true, threadId: null });
      const result = await runCheckImpl(check, { cwd: workspace, onSpawn, signal });
      checks.push(result);
      if (signal?.aborted || result?.canceled) return canceledAcceptance(requiredChecks, checks, Boolean(held));
    }
    const snapshotAfter = snapshot(workspace);
    const { disposition, reasons, issues, warnings } = computeDisposition({
      requiredChecks, checkResults: checks, snapshotBefore, snapshotAfter, writers, unresolvedWriterCount,
    });
    return {
      disposition,
      reasons,
      issues,
      warnings,
      candidate: { kind: snapshotBefore.kind, head: snapshotBefore.head ?? null, fingerprint: snapshotBefore.fingerprint ?? null },
      candidateAfter: { fingerprint: snapshotAfter.fingerprint ?? null },
      checks,
      requiredCheckIds: requiredChecks.map((check) => check.id),
      verifiedAt: new Date().toISOString(),
      admissionHeld: Boolean(held),
    };
  } finally {
    if (held) admission.release(held.executionId);
  }
}

/** Acceptance record for a contract without checks: no admission, at most one snapshot (only if a writer ran). */
function assessWithoutChecks({
  workspace, writers = [], unresolvedWriterCount = 0, snapshot = takeSnapshot,
}) {
  const anyRan = writers.some((writer) => writer.ran);
  const snap = anyRan ? snapshot(workspace) : null;
  const { disposition, reasons, issues, warnings } = computeDisposition({
    requiredChecks: [], checkResults: [], snapshotBefore: snap, snapshotAfter: snap, writers, unresolvedWriterCount,
  });
  return {
    disposition,
    reasons,
    issues,
    warnings,
    candidate: snap ? { kind: snap.kind, head: snap.head ?? null, fingerprint: snap.fingerprint ?? null } : { kind: null, head: null, fingerprint: null },
    candidateAfter: { fingerprint: snap?.fingerprint ?? null },
    checks: [],
    requiredCheckIds: [],
    verifiedAt: new Date().toISOString(),
    admissionHeld: false,
  };
}

/** Text block for the A2A result: the disposition first, then reasons unless accepted. */
function formatAcceptance(acceptance) {
  if (!acceptance || typeof acceptance.disposition !== 'string') return '';
  const lines = [`Acceptance: ${acceptance.disposition}`];
  if (acceptance.disposition !== 'accepted') {
    for (const reason of acceptance.reasons || []) lines.push(`- ${reason.code}: ${reason.detail}`);
  }
  return lines.join('\n');
}

function verifyCandidate(workspace, acceptance, snapshot = takeSnapshot) {
  const current = snapshot(workspace);
  const fingerprint = current.kind === 'git' ? current.fingerprint : null;
  const expected = acceptance?.candidate?.fingerprint ?? null;
  return { unchanged: fingerprint !== null && fingerprint === expected, fingerprint };
}

module.exports = {
  validateAcceptanceContract, parseCheckCommand, buildSandboxCommand, runCheck, computeDisposition, runAcceptance, verifyCandidate,
  assessWithoutChecks, formatAcceptance,
};
