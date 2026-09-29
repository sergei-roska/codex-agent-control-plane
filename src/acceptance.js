'use strict';

const { spawn } = require('node:child_process');
const { takeSnapshot } = require('./workspace-snapshot');
const { readProcessIdentity } = require('./process-quiescence');

const MAX_CHECKS = 10;
const MAX_ID = 64;
const MAX_ARGV = 64;
const MAX_ARG = 4096;
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 1800000;
const TAIL = 4096;
const CLOSE_GRACE_MS = 2000;

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
    const finish = (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
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
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-TAIL * 2); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-TAIL * 2); });
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

function computeDisposition({
  requiredChecks = [], checkResults = [], snapshotBefore, snapshotAfter, writers = [], unresolvedWriterCount = 0,
} = {}) {
  const issues = [];
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
    for (const item of writer.reportedScopeViolations || []) {
      issues.push({ code: 'reported_scope_violation', detail: `Writer ${who} reported: ${item}` });
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
    if (unavailable) return { disposition: 'unverifiable', reasons: issues, issues };
    return { disposition: issues.length === 0 ? 'accepted' : 'rejected', reasons: issues, issues };
  }
  const anyRan = writers.some((writer) => writer.ran);
  // Without required checks no candidate is fingerprinted for acceptance, so snapshot issues
  // matter only when a writer ran.
  const list = anyRan ? issues : issues.filter((issue) => !['snapshot_unavailable', 'candidate_changed'].includes(issue.code));
  return { disposition: anyRan ? 'unverified' : 'not_required', reasons: list, issues: list };
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
    const { disposition, reasons, issues } = computeDisposition({
      requiredChecks, checkResults: checks, snapshotBefore, snapshotAfter, writers, unresolvedWriterCount,
    });
    return {
      disposition,
      reasons,
      issues,
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
  assessWithoutChecks, formatAcceptance,
};
