'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { takeSnapshot } = require('./workspace-snapshot');
const { readProcessIdentity } = require('./process-quiescence');
const { provisionScratch } = require('./acceptance-scratch');

const MAX_CHECKS = 10;
const MAX_ID = 64;
const MAX_ARGV = 64;
const MAX_ARG = 4096;
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 1800000;
const TAIL = 4096;
const MiB = 1024 * 1024;
const CAPTURE_HEAD_BYTES = 2 * MiB;
const CAPTURE_TAIL_BYTES = 6 * MiB;
const CLOSE_GRACE_MS = 2000;
const EXEC_GRACE_MS = 2000;

const CONTRACT_ID = 'acceptance-contract/v1';
// Contract source of checks proposed by the lead agent (LL-4); owner contracts carry no source.
const AGENT_SOURCE = 'agent';
// Agent checks run through the App Server sandbox: the cwd is not writable, /tmp stays writable, no network.
const AGENT_CHECK_SANDBOX_POLICY = Object.freeze({
  type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
});
const AGENT_CHECK_TOOLS = ['python', 'python3', 'pytest', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'make', 'bash', 'sh', 'uv', 'cargo', 'go'];
const VACUOUS_COMMANDS = new Set(['echo', 'true', 'false', 'test', '[', 'yes']);
const SHELLS = new Set(['bash', 'sh']);
const PYTHONS = new Set(['python', 'python3']);
const NODE_INLINE = /^(-e|-p|--eval|--print|--eval=.*|--print=.*|-[A-Za-z]*[ep][A-Za-z]*)$/;

/**
 * Marker for a stored contract that failed validation on restart. It travels through
 * validateAcceptanceContract unchanged so the run's acceptance can report contract_invalid.
 */
function invalidAcceptanceContract(detail) {
  return { id: CONTRACT_ID, requiredChecks: [], invalid: { code: 'contract_invalid', detail: String(detail).slice(0, 500) } };
}

function validatePins(pins, at) {
  if (!Array.isArray(pins) || pins.length > MAX_ARGV) throw new TypeError(`${at}.pins must be an array of at most ${MAX_ARGV} entries`);
  return pins.map((pin) => {
    if (!pin || typeof pin !== 'object' || typeof pin.path !== 'string' || !pin.path || pin.path.length > MAX_ARG
      || typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
      throw new TypeError(`${at}.pins entries must be { path, sha256 }`);
    }
    return { path: pin.path, sha256: pin.sha256 };
  });
}

function validateAcceptanceContract(value) {
  if (value === undefined || value === null) return { requiredChecks: [] };
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('acceptance must be an object');
  if (value.invalid && Array.isArray(value.requiredChecks) && value.requiredChecks.length === 0 && value.invalid.code === 'contract_invalid') {
    return invalidAcceptanceContract(value.invalid.detail);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'requiredChecks' && !(key === 'id' && value.id === CONTRACT_ID) && !(key === 'source' && value.source === AGENT_SOURCE)) {
      throw new TypeError(`acceptance has unknown field "${key}"`);
    }
  }
  const checks = value.requiredChecks === undefined ? [] : value.requiredChecks;
  if (!Array.isArray(checks)) throw new TypeError('acceptance.requiredChecks must be an array');
  if (checks.length > MAX_CHECKS) throw new TypeError(`acceptance.requiredChecks has more than ${MAX_CHECKS} entries`);
  const seen = new Set();
  const requiredChecks = checks.map((check, index) => {
    const at = `acceptance.requiredChecks[${index}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) throw new TypeError(`${at} must be an object`);
    for (const key of Object.keys(check)) {
      if (!['id', 'argv', 'timeoutMs'].includes(key) && !(key === 'pins' && value.source === AGENT_SOURCE)) throw new TypeError(`${at} has unknown field "${key}"`);
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
    const out = { id, argv: [...argv], timeoutMs };
    // Pins of an agent check survive re-validation (stored contracts are validated again on every run).
    if (check.pins !== undefined) out.pins = validatePins(check.pins, at);
    return out;
  });
  // The agent source survives every re-validation, so an agent check can never run as an owner check.
  return { id: CONTRACT_ID, requiredChecks, ...(value.source === AGENT_SOURCE ? { source: AGENT_SOURCE } : {}) };
}

// True when `file` (relative to the workspace or absolute) names a path inside the workspace.
function insideWorkspace(file, workspace) {
  const root = path.resolve(workspace);
  const rel = path.relative(root, path.resolve(root, file));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// First inline-code flag in the option segment of the interpreter at argv[index], or null.
function inlineCodeFlag(argv, index) {
  const name = path.basename(argv[index]);
  const rest = argv.slice(index + 1);
  if (name === 'node') return rest.find((arg) => NODE_INLINE.test(arg)) || null;
  const python = PYTHONS.has(name);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--' || !arg.startsWith('-') || arg === '-') return null;
    if (arg.startsWith('--')) continue;
    const letters = arg.slice(1);
    for (let j = 0; j < letters.length; j += 1) {
      const letter = letters[j];
      if (letter === 'c') return arg;
      // Python: -m starts module arguments; -W and -X take a value (attached or the next argument).
      if (python && letter === 'm') return null;
      if (python && (letter === 'W' || letter === 'X')) {
        if (j === letters.length - 1) i += 1;
        break;
      }
      // Shells: -o and +o take an option name.
      if (!python && letter === 'o' && j === letters.length - 1) { i += 1; break; }
    }
  }
  return null;
}

/**
 * Validate an acceptanceChecks proposal of the lead agent (LL-4) and return it as an agent contract
 * { id, requiredChecks, source: 'agent' }. Throws TypeError for a malformed, vacuous, or unsafe check.
 */
function validateAgentChecks(checks, { workspace }) {
  if (!Array.isArray(checks)) throw new TypeError('acceptanceChecks must be an array or null');
  // The strict decision schema has timeoutMs null for the default.
  const normalized = checks.map((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || check.timeoutMs !== null) return check;
    const { timeoutMs: _default, ...rest } = check;
    return rest;
  });
  const contract = validateAcceptanceContract({ requiredChecks: normalized });
  const tools = new Set(AGENT_CHECK_TOOLS);
  for (const { id, argv } of contract.requiredChecks) {
    const at = `acceptanceChecks "${id}"`;
    const command = argv[0];
    const name = path.basename(command);
    if (VACUOUS_COMMANDS.has(name)) throw new TypeError(`${at}: ${command} proves nothing and is refused`);
    const known = !command.includes('/') && tools.has(command);
    if (!known && !(command.includes('/') && insideWorkspace(command, workspace))) {
      throw new TypeError(`${at}: argv[0] must be a script path inside the workspace or one of ${AGENT_CHECK_TOOLS.join(', ')}`);
    }
    if (SHELLS.has(name) && !(typeof argv[1] === 'string' && !argv[1].startsWith('-') && insideWorkspace(argv[1], workspace))) {
      throw new TypeError(`${at}: ${name} needs a script path inside the workspace as argv[1]`);
    }
    // An interpreter at argv[0], or one started by a runner such as uv run or npx.
    for (let index = 0; index < argv.length; index += 1) {
      const token = index === 0 ? name : argv[index];
      const interpreter = SHELLS.has(token) || PYTHONS.has(token) || token === 'node';
      if (!interpreter || (index > 0 && argv[index - 1].startsWith('-') && argv[index - 1] !== '--')) continue;
      const flag = inlineCodeFlag(argv, index);
      if (flag) throw new TypeError(`${at}: inline code (${flag}) after ${token} is refused; put the check in a script inside the workspace`);
    }
  }
  return pinAgentChecks({ ...contract, source: AGENT_SOURCE }, workspace);
}

// sha256 of a regular file inside the workspace, or null when it is missing, not a file, or outside.
function hashWorkspaceFile(file, workspace) {
  try {
    if (!insideWorkspace(file, workspace)) return null;
    const full = path.resolve(workspace, file);
    if (!insideWorkspace(fs.realpathSync(full), fs.realpathSync(workspace)) || !fs.statSync(full).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Pin the content of every workspace file named in a check's argv (argv[0] and script arguments) so a later
 * rewrite of a validator is detected: each check of an agent contract gets pins [{ path, sha256 }].
 */
function pinAgentChecks(contract, workspace) {
  const root = path.resolve(workspace);
  const requiredChecks = contract.requiredChecks.map((check) => {
    const pins = [];
    for (const arg of check.argv) {
      const sha256 = hashWorkspaceFile(arg, workspace);
      if (sha256 === null) continue;
      const rel = path.relative(root, path.resolve(root, arg));
      if (!pins.some((pin) => pin.path === rel)) pins.push({ path: rel, sha256 });
    }
    return pins.length > 0 ? { ...check, pins } : check;
  });
  return { ...contract, requiredChecks };
}

// Pinned paths of an agent check whose content changed or which are gone.
function changedPins(check, workspace) {
  return (check.pins || []).filter((pin) => hashWorkspaceFile(pin.path, workspace) !== pin.sha256).map((pin) => pin.path);
}

// Current content hash of every pinned path of a check (null when the file is gone).
function currentPins(check, workspace) {
  return (check.pins || []).map((pin) => ({ path: pin.path, sha256: hashWorkspaceFile(pin.path, workspace) }));
}

// True when a review record judged exactly the current content of the check's pinned files.
function samePins(recorded, current) {
  return recorded.length === current.length
    && current.every((pin) => recorded.some((entry) => entry.path === pin.path && entry.sha256 === pin.sha256));
}

/**
 * LL-6: re-pin checks of an agent contract to the content that was reviewed and approved
 * (reviewed: [{ id, pins: [{ path, sha256 | null }] }]). A pinned file that was gone loses its pin; the
 * check then fails when it runs. Content changed after the review is detected again as check_changed.
 */
function repinChecks(contract, reviewed) {
  const byId = new Map(reviewed.map((entry) => [entry.id, entry.pins || []]));
  const requiredChecks = contract.requiredChecks.map((check) => {
    if (!byId.has(check.id) || !check.pins) return check;
    const pins = byId.get(check.id).filter((pin) => typeof pin.sha256 === 'string').map(({ path: file, sha256 }) => ({ path: file, sha256 }));
    const { pins: _old, ...rest } = check;
    return pins.length > 0 ? { ...rest, pins } : rest;
  });
  return { ...contract, requiredChecks };
}

const DIFF_MAX_CHARS = 8000;

function readGit(workspace, args) {
  return execFileSync('git', ['-C', workspace, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * MiB, timeout: 10000,
    // Read-only: no optional index refresh or lock.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

/**
 * LL-6: what changed in each pinned file of a check, for the reviewer: { path, pinnedSha256,
 * currentSha256, diff, note }. The diff comes read-only from git when the committed HEAD version is
 * exactly the pinned content; otherwise only the current content is given (the pinned bytes are not kept).
 */
function describePinChanges(check, workspace) {
  const clip = (text) => (text.length > DIFF_MAX_CHARS ? `${text.slice(0, DIFF_MAX_CHARS)}\n[... ${text.length - DIFF_MAX_CHARS} chars omitted]` : text);
  return (check.pins || []).flatMap((pin) => {
    const current = hashWorkspaceFile(pin.path, workspace);
    if (current === pin.sha256) return [];
    const entry = { path: pin.path, pinnedSha256: pin.sha256, currentSha256: current, diff: '', note: '' };
    let headMatches = false;
    try {
      const head = readGit(workspace, ['show', `HEAD:./${pin.path}`]);
      headMatches = crypto.createHash('sha256').update(head).digest('hex') === pin.sha256;
    } catch { headMatches = false; }
    if (headMatches) {
      try {
        entry.diff = clip(readGit(workspace, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', `./${pin.path}`]).toString('utf8'));
        entry.note = 'Diff of the pinned content (committed at HEAD) against the current file.';
        return [entry];
      } catch { /* fall back to the current content */ }
    }
    if (current === null) {
      entry.note = 'The pinned file is gone.';
    } else {
      try { entry.diff = clip(fs.readFileSync(path.resolve(workspace, pin.path), 'utf8')); } catch { entry.diff = ''; }
      entry.note = 'The pinned content is not available from git; this is the current file content.';
    }
    return [entry];
  });
}

function parseCheckCommand(text, index) {
  const argv = String(text).trim().split(/\s+/).filter(Boolean);
  return { id: `check-${index + 1}`, argv };
}

// Bounded capture of one output stream: first 2 MiB, last 6 MiB, a sha256 and a byte count over all of it.
class StreamCapture {
  constructor() {
    this.headParts = [];
    this.headLen = 0;
    this.tailParts = [];
    this.tailLen = 0;
    this.total = 0;
    this.hash = crypto.createHash('sha256');
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.hash.update(buf);
    this.total += buf.length;
    let rest = buf;
    if (this.headLen < CAPTURE_HEAD_BYTES) {
      const take = Math.min(CAPTURE_HEAD_BYTES - this.headLen, buf.length);
      this.headParts.push(buf.subarray(0, take));
      this.headLen += take;
      rest = buf.subarray(take);
    }
    if (rest.length === 0) return;
    this.tailParts.push(rest);
    this.tailLen += rest.length;
    while (this.tailParts.length > 1 && this.tailLen - this.tailParts[0].length >= CAPTURE_TAIL_BYTES) {
      this.tailLen -= this.tailParts.shift().length;
    }
  }

  // { head, tail, originalBytes, originalSha256 } in the shape the evidence store accepts.
  capture() {
    const all = Buffer.concat(this.tailParts);
    const tail = all.length > CAPTURE_TAIL_BYTES ? all.subarray(all.length - CAPTURE_TAIL_BYTES) : all;
    return {
      head: Buffer.concat(this.headParts), tail, originalBytes: this.total, originalSha256: this.hash.copy().digest('hex'),
    };
  }

  // Last TAIL chars as text, and whether anything before them was dropped.
  tailText() {
    const need = TAIL * 4;
    let bytes = Buffer.concat(this.tailParts);
    // The tail is contiguous with the head until the tail buffer first drops a chunk (6 MiB, far above `need`).
    if (bytes.length < need) bytes = Buffer.concat([Buffer.concat(this.headParts), bytes]);
    bytes = bytes.subarray(Math.max(0, bytes.length - need));
    const text = bytes.toString('utf8');
    return { text: text.slice(-TAIL), truncated: this.total > bytes.length || text.length > TAIL };
  }
}

function runCheck({ id, argv, timeoutMs = DEFAULT_TIMEOUT_MS }, {
  cwd, onSpawn, signal, closeGraceMs = CLOSE_GRACE_MS, onCapture,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = new StreamCapture();
    const stderr = new StreamCapture();
    let timedOut = false;
    let error = null;
    let settled = false;
    let canceled = false;
    let timer = null;
    let graceTimer = null;
    let onAbort = null;
    const finish = (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      const out = stdout.tailText();
      const err = stderr.tailText();
      if (typeof onCapture === 'function') {
        try { onCapture({ stdout: stdout.capture(), stderr: stderr.capture() }); } catch (_) { /* evidence is best effort */ }
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
        stdoutTail: out.text,
        stderrTail: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        result: exitCode === 0 && !timedOut && !canceled ? 'passed' : 'failed',
      });
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (spawnError) {
      error = spawnError.code || 'SPAWN_ERROR';
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
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (spawnError) => {
      error = spawnError.code || 'SPAWN_ERROR';
      finish(null, null);
    });
    child.on('exit', (code, exitSignal) => {
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

/**
 * Runs one agent-proposed check through appServer.execCommand in the read-only-workspace sandbox and
 * returns the runCheck result shape. An unavailable or failing execCommand is result 'error' (never a
 * pass); a check that outlives its timeoutMs is a timed-out failure, as with runCheck.
 */
async function runSandboxedCheck({ id, argv, timeoutMs = DEFAULT_TIMEOUT_MS }, {
  appServer, cwd, signal, onCapture, graceMs = EXEC_GRACE_MS, scratch = null,
} = {}) {
  const started = Date.now();
  const stdout = new StreamCapture();
  const stderr = new StreamCapture();
  const finish = ({ exitCode = null, timedOut = false, canceled = false, error = null, result }) => {
    const out = stdout.tailText();
    const err = stderr.tailText();
    if (typeof onCapture === 'function') {
      try { onCapture({ stdout: stdout.capture(), stderr: stderr.capture() }); } catch (_) { /* evidence is best effort */ }
    }
    return {
      id,
      argv,
      exitCode,
      signal: null,
      timedOut,
      canceled,
      error,
      durationMs: Date.now() - started,
      stdoutTail: out.text,
      stderrTail: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      sandboxed: true,
      result,
    };
  };
  if (typeof appServer?.execCommand !== 'function') return finish({ error: 'EXEC_UNAVAILABLE', result: 'error' });
  if (signal?.aborted) return finish({ canceled: true, result: 'failed' });
  let timer = null;
  let onAbort = null;
  const outcome = await new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs + graceMs);
    if (signal) {
      onAbort = () => resolve({ canceled: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve()
      .then(() => appServer.execCommand(scratch
        // Owner opt-in (src/acceptance-scratch.js): the run's scratch directory is the only writable root.
        ? {
          command: [...argv], cwd, sandboxPolicy: { ...scratch.policy, writableRoots: [...scratch.policy.writableRoots] }, env: { ...scratch.env }, timeoutMs,
        }
        : { command: [...argv], cwd, sandboxPolicy: { ...AGENT_CHECK_SANDBOX_POLICY }, timeoutMs }))
      .then((value) => resolve({ value }), (error) => resolve({ error }));
  });
  clearTimeout(timer);
  if (onAbort) signal.removeEventListener('abort', onAbort);
  if (outcome.canceled) return finish({ canceled: true, result: 'failed' });
  if (outcome.timedOut) return finish({ timedOut: true, error: 'EXEC_TIMEOUT', result: 'failed' });
  if (outcome.error) {
    const error = `EXEC_ERROR: ${String(outcome.error?.message || outcome.error).slice(0, 300)}`;
    if (Date.now() - started >= timeoutMs) return finish({ timedOut: true, error, result: 'failed' });
    return finish({ error, result: 'error' });
  }
  const { value } = outcome;
  if (typeof value?.stdout === 'string') stdout.push(value.stdout);
  if (typeof value?.stderr === 'string') stderr.push(value.stderr);
  if (!Number.isInteger(value?.exitCode)) return finish({ error: 'EXEC_NO_EXIT_CODE', result: 'error' });
  return finish({ exitCode: value.exitCode, result: value.exitCode === 0 ? 'passed' : 'failed' });
}

// Predicate id, result, and advisory flag per acceptance issue code (docs/execution-boundary-contract.md).
const ISSUE_META = {
  check_missing: ['accept.checks', 'FAIL', false],
  check_failed: ['accept.checks', 'FAIL', false],
  // A sandboxed agent check that could not be run: unverified, never a pass.
  check_error: ['accept.checks', 'UNKNOWN', false],
  snapshot_unavailable: ['accept.snapshot', 'UNKNOWN', false],
  candidate_changed: ['accept.candidate_stable', 'FAIL', false],
  writer_unresolved: ['accept.writers', 'UNKNOWN', false],
  delta_unknown: ['accept.writers', 'UNKNOWN', false],
  attested_scope_violation: ['accept.writers', 'FAIL', false],
  report_invalid: ['accept.writers', 'FAIL', false],
  reported_scope_violation: ['accept.writers', 'FAIL', false],
  writer_reported_failure: ['accept.writers', 'FAIL', true],
  acceptance_canceled: ['accept.run', 'UNKNOWN', false],
  acceptance_error: ['accept.run', 'UNKNOWN', false],
  acceptance_not_run: ['accept.run', 'UNKNOWN', false],
  // The required checks cannot be known, so this is UNKNOWN and yields unverifiable by the normal rule.
  contract_invalid: ['accept.contract_valid', 'UNKNOWN', false],
  // A pinned script of an agent check was edited or removed: the check is not run, the owner decides.
  check_changed: ['accept.checks', 'UNKNOWN', false],
  // LL-6: a reviewer judged that the change to a pinned check weakens its requirement: the check fails.
  check_weakened: ['accept.checks', 'FAIL', false],
  // The per-run scratch directory could not be removed: recorded, advisory, never decides the disposition.
  scratch_cleanup_failed: ['accept.scratch', 'UNKNOWN', true],
};

/** An acceptance issue as a violation record; keeps `code` and `detail` for existing consumers. */
function acceptanceIssue(code, detail) {
  const [predicate, result, advisory] = ISSUE_META[code];
  return { code, detail: String(detail).slice(0, 500), predicate, result, boundary: 'acceptance', advisory, evidence: [] };
}

function computeDisposition({
  requiredChecks = [], checkResults = [], snapshotBefore, snapshotAfter, writers = [], unresolvedWriterCount = 0,
} = {}) {
  const issues = [];
  const add = (code, detail) => issues.push(acceptanceIssue(code, detail));
  const results = new Map((checkResults || []).map((result) => [result.id, result]));
  for (const check of requiredChecks) {
    const result = results.get(check.id);
    if (!result) add('check_missing', `Required check "${check.id}" has no result.`);
    else if (result.result === 'error' && result.error === 'check_changed') add('check_changed', result.detail);
    else if (result.result === 'failed' && result.error === 'check_weakened') add('check_weakened', result.detail);
    else if (result.result === 'error') add('check_error', `Required check "${check.id}" could not run in the sandbox (${result.error || 'error'}); it is unverified.`);
    else if (result.result !== 'passed') {
      const ids = [result.stdoutEvidence?.id, result.stderrEvidence?.id].filter(Boolean);
      const evidence = ids.length > 0 ? ` Evidence: ${ids.join(', ')}.` : '';
      add('check_failed', `Required check "${check.id}" failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}${result.error ? `, ${result.error}` : ''}).${evidence}`);
    }
  }
  if (unresolvedWriterCount > 0) {
    add('writer_unresolved', `${unresolvedWriterCount} writer outcome(s) unresolved.`);
  }
  for (const writer of writers) {
    const who = writer.attemptId || writer.role || 'writer';
    if (writer.completed && !writer.reportValid) {
      add('report_invalid', `Writer ${who} completed without a valid report.`);
    }
    for (const item of writer.reportedScopeViolations || []) {
      add('reported_scope_violation', `Writer ${who} reported: ${item}`);
    }
    for (const item of writer.attestedScopeViolations || []) {
      add('attested_scope_violation', `Writer ${who} changed out of scope: ${item}`);
    }
    if (['failed', 'blocked'].includes(writer.reportOutcome)) {
      add('writer_reported_failure', `Writer ${who} reported outcome ${writer.reportOutcome}.`);
    }
    if (writer.ran && !writer.deltaKnown) {
      add('delta_unknown', `Writer ${who} ran but its workspace delta is unknown.`);
    }
  }
  const unavailable = snapshotBefore?.kind !== 'git' || snapshotAfter?.kind !== 'git';
  if (unavailable) {
    add('snapshot_unavailable', 'No git snapshot of the candidate is available.');
  } else if (snapshotBefore.fingerprint !== snapshotAfter.fingerprint) {
    add('candidate_changed', 'The workspace changed while checks were running.');
  }
  if (requiredChecks.length > 0) {
    // FAIL wins over UNKNOWN so a failed check is never hidden; advisory records never decide.
    const blocking = issues.filter((issue) => !issue.advisory);
    let disposition = 'accepted';
    if (blocking.some((issue) => issue.result === 'FAIL')) disposition = 'rejected';
    else if (blocking.some((issue) => issue.result === 'UNKNOWN' || issue.result === 'ERROR')) disposition = 'unverifiable';
    return { disposition, reasons: issues, issues };
  }
  const anyRan = writers.some((writer) => writer.ran);
  // Without required checks no candidate is fingerprinted for acceptance, so snapshot issues
  // matter only when a writer ran.
  const list = anyRan ? issues : issues.filter((issue) => !['snapshot_unavailable', 'candidate_changed'].includes(issue.code));
  return { disposition: anyRan ? 'unverified' : 'not_required', reasons: list, issues: list };
}

/** Acceptance record for any lead-side condition that leaves the checks unrun (never `accepted`). */
function unrunAcceptance(code, detail, requiredCheckIds = []) {
  const issues = [acceptanceIssue(code, detail)];
  return {
    disposition: 'unverifiable',
    reasons: issues,
    issues,
    candidate: { kind: null, head: null, fingerprint: null },
    candidateAfter: { fingerprint: null },
    checks: [],
    requiredCheckIds,
    verifiedAt: new Date().toISOString(),
    admissionHeld: false,
  };
}

function canceledAcceptance(requiredChecks, checks, admissionHeld) {
  const issues = [acceptanceIssue('acceptance_canceled', 'Acceptance was canceled before the checks completed.')];
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

// Stores one stream capture as evidence; a store failure yields { ref: null, error } and never throws.
function storeCheckStream(evidenceStore, runId, attemptId, check, result, stream, capture) {
  const text = capture.tail.toString('utf8').slice(-500);
  const omitted = capture.originalBytes - capture.head.length - capture.tail.length;
  const how = omitted > 0 ? `first ${capture.head.length} and last ${capture.tail.length} bytes kept, ${omitted} omitted` : 'complete';
  const lead = `${check.argv.join(' ')} ${stream} (exit ${result.exitCode}): ${capture.originalBytes} bytes, ${how}`;
  try {
    const ref = evidenceStore.put({
      runId,
      attemptId,
      checkId: check.id,
      kind: stream === 'stdout' ? 'check_stdout' : 'check_stderr',
      mediaType: 'text/plain; charset=utf-8',
      content: capture,
      summary: `${lead}. Tail: ${text}`.slice(0, 2000),
      source: {
        producer: 'acceptance',
        argv: check.argv,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        canceled: result.canceled,
        stream,
      },
    });
    return { ref, error: null };
  } catch (error) {
    return { ref: null, error: error?.code || error?.message || 'evidence_error' };
  }
}

async function runAcceptance({
  workspace, runId, attempt, contract, writers = [], unresolvedWriterCount = 0, admission, signal,
  snapshot = takeSnapshot, runCheckImpl = runCheck, evidenceStore = null, appServer = null, weakened = [],
  acceptanceScratch = null, scratchForbiddenRoots,
}) {
  const validated = validateAcceptanceContract(contract);
  const { requiredChecks } = validated;
  // Agent-proposed checks never run on the host: only through the App Server sandbox.
  const sandboxed = validated.source === AGENT_SOURCE;
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
  // Owner opt-in only (server settings): sandboxed checks get a fresh scratch directory, removed after the run.
  let scratch = null;
  let scratchRecord = null;
  const closeScratch = (acceptance) => {
    if (!scratch) return acceptance;
    if (!scratchRecord) {
      const cleanup = scratch.cleanup();
      scratchRecord = { dir: scratch.dir, cleaned: cleanup.cleaned, error: cleanup.error };
    }
    const out = { ...acceptance, scratch: scratchRecord };
    if (!scratchRecord.cleaned) {
      const issue = acceptanceIssue('scratch_cleanup_failed', `Scratch directory ${scratch.dir} was not removed: ${scratchRecord.error}`);
      out.issues = [...out.issues, issue];
      out.reasons = [...out.reasons, issue];
    }
    return out;
  };
  try {
    if (sandboxed && acceptanceScratch) {
      scratch = provisionScratch(acceptanceScratch, { workspace, ...(scratchForbiddenRoots ? { forbiddenRoots: scratchForbiddenRoots } : {}) });
    }
    const snapshotBefore = snapshot(workspace);
    const checks = [];
    const onSpawn = held
      ? (pid) => admission.recordTurnStart(held.executionId, { processIdentity: readProcessIdentity(pid), threadId: null })
      : undefined;
    for (const check of requiredChecks) {
      if (signal?.aborted) return closeScratch(canceledAcceptance(requiredChecks, checks, Boolean(held)));
      // Crash window: a turn start without a proven identity keeps quiescence unproven until the real one is recorded.
      // A sandboxed check has no host process and cannot write the workspace, so it records none.
      if (held && !sandboxed) admission.recordTurnStart(held.executionId, { processIdentity: null, pending: true, threadId: null });
      let captured = null;
      const onCapture = (value) => { captured = value; };
      const changed = sandboxed ? changedPins(check, workspace) : [];
      // LL-6: a change already judged as weakening (for exactly this content) fails the check without a new review.
      const verdict = changed.length > 0
        ? weakened.find((entry) => entry.checkId === check.id && samePins(entry.pins || [], currentPins(check, workspace)))
        : null;
      const result = verdict
        ? {
          id: check.id, argv: check.argv, result: 'failed', error: 'check_weakened', exitCode: null, sandboxed: true,
          detail: `Pinned acceptance check "${check.id}" fails: the change to ${changed.join(', ')} weakens its requirement (${verdict.by}). Restore the requirement or fix the cause.`,
        }
        : changed.length > 0
        ? {
          id: check.id, argv: check.argv, result: 'error', error: 'check_changed', exitCode: null, sandboxed: true,
          detail: `Pinned acceptance check "${check.id}" was not run: ${changed.join(', ')} changed since it was pinned. Changing a pinned acceptance check needs the owner's decision.`,
        }
        : sandboxed
        ? await runSandboxedCheck(check, { appServer, cwd: workspace, signal, onCapture, scratch })
        : await runCheckImpl(check, { cwd: workspace, onSpawn, signal, onCapture });
      if (captured && result && typeof result === 'object') {
        const out = evidenceStore ? storeCheckStream(evidenceStore, runId, `${runId}:acceptance:${attempt}`, check, result, 'stdout', captured.stdout) : { ref: null, error: null };
        const err = evidenceStore ? storeCheckStream(evidenceStore, runId, `${runId}:acceptance:${attempt}`, check, result, 'stderr', captured.stderr) : { ref: null, error: null };
        result.stdoutEvidence = out.ref;
        result.stderrEvidence = err.ref;
        const failure = out.error || err.error;
        if (failure) result.evidenceError = failure;
      }
      checks.push(result);
      if (signal?.aborted || result?.canceled) return closeScratch(canceledAcceptance(requiredChecks, checks, Boolean(held)));
    }
    const snapshotAfter = snapshot(workspace);
    const { disposition, reasons, issues } = computeDisposition({
      requiredChecks, checkResults: checks, snapshotBefore, snapshotAfter, writers, unresolvedWriterCount,
    });
    return closeScratch({
      disposition,
      reasons,
      issues,
      candidate: { kind: snapshotBefore.kind, head: snapshotBefore.head ?? null, fingerprint: snapshotBefore.fingerprint ?? null },
      candidateAfter: { fingerprint: snapshotAfter.fingerprint ?? null },
      checks,
      requiredCheckIds: requiredChecks.map((check) => check.id),
      verifiedAt: new Date().toISOString(),
      admissionHeld: Boolean(held),
    });
  } catch (error) {
    // A failure of the run itself still removes the directory; the cleanup outcome rides on the error.
    if (scratch) {
      const cleanup = scratch.cleanup();
      if (!cleanup.cleaned && error && typeof error === 'object') error.scratchCleanupError = cleanup.error;
    }
    throw error;
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
  const { disposition, reasons, issues } = computeDisposition({
    requiredChecks: [], checkResults: [], snapshotBefore: snap, snapshotAfter: snap, writers, unresolvedWriterCount,
  });
  return {
    disposition,
    reasons,
    issues,
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
  validateAcceptanceContract, parseCheckCommand, runCheck, computeDisposition, runAcceptance, verifyCandidate,
  assessWithoutChecks, formatAcceptance, acceptanceIssue, unrunAcceptance, invalidAcceptanceContract,
  validateAgentChecks, pinAgentChecks, runSandboxedCheck, AGENT_CHECK_SANDBOX_POLICY, AGENT_CHECK_TOOLS,
  currentPins, repinChecks, describePinChanges,
};
