'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateAcceptanceContract, runAcceptance, acceptanceIssue } = require('./acceptance');
const { validateManifest } = require('./candidate-store');

class DeliveryAcceptanceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DeliveryAcceptanceError';
    this.code = code;
  }
}

function fail(code, message) { throw new DeliveryAcceptanceError(code, message); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function createGitContext(root) {
  const config = path.join(root, 'empty.gitconfig');
  const hooks = path.join(root, 'hooks');
  fs.writeFileSync(config, '');
  fs.mkdirSync(hooks, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_GLOBAL: config,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  });
  return { env, hooks };
}

function runGit(root, args, gitContext) {
  if (!gitContext?.env || !gitContext.hooks || inside(root, gitContext.hooks)) fail('accept_git_context_invalid');
  return execFileSync('git', ['-c', `core.hooksPath=${gitContext.hooks}`, '-c', 'core.attributesFile=/dev/null',
    '--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitContext.env,
  });
}

function makeWritableTree(root) {
  let stat;
  try { stat = fs.lstatSync(root); } catch (_) { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    try { fs.chmodSync(root, stat.mode | 0o700); } catch (_) { /* best effort */ }
    for (const name of fs.readdirSync(root)) makeWritableTree(path.join(root, name));
  } else {
    try { fs.chmodSync(root, stat.mode | 0o600); } catch (_) { /* best effort */ }
  }
}

function removeTemporaryTree(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (_) {
    makeWritableTree(root);
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (_) { /* a later owner reconciliation can remove the retained scratch tree */ }
  }
}

function measureCandidateTree(root, expectedManifest) {
  const realRoot = fs.realpathSync(root);
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!prefix && name === '.git') {
        const stat = fs.lstatSync(path.join(directory, name));
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail('accept_mirror_git_metadata_unsafe');
        continue;
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('accept_candidate_symlink');
      if (stat.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) fail('accept_candidate_special_file');
      const bytes = fs.readFileSync(absolute);
      entries.push({ path: relative, mode: stat.mode & 0o111 ? '100755' : '100644', size: bytes.length, digest: sha256(bytes) });
    }
  };
  walk(realRoot);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const candidate = { format: 'candidate-manifest-v1', head: expectedManifest.head ?? null, entries };
  candidate.digest = sha256(canonical(candidate));
  return validateManifest(candidate);
}

function assertCandidateIdentity(candidateStore, expected) {
  if (!candidateStore || typeof candidateStore.get !== 'function' || typeof candidateStore.readManifest !== 'function'
    || typeof candidateStore.materialize !== 'function') throw new TypeError('CandidateStore is required');
  if (!expected || typeof expected !== 'object' || typeof expected.projectId !== 'string'
    || typeof expected.objectiveId !== 'string' || typeof expected.candidateId !== 'string'
    || typeof expected.manifestDigest !== 'string' || typeof expected.environmentDigest !== 'string'
    || typeof expected.checkIdentity !== 'string' || !Number.isSafeInteger(expected.integrationGeneration)) {
    fail('accept_candidate_pin_invalid');
  }
  const candidate = candidateStore.get(expected.candidateId);
  if (!candidate || candidate.status !== 'known' || candidate.projectId !== expected.projectId
    || candidate.objectiveId !== expected.objectiveId || candidate.integrationGeneration !== expected.integrationGeneration
    || candidate.manifestDigest !== expected.manifestDigest || candidate.environmentDigest !== expected.environmentDigest
    || candidate.checkIdentity !== expected.checkIdentity) fail('accept_candidate_pin_stale');
  const manifest = candidateStore.readManifest(candidate.manifestDigest);
  if (!manifest || manifest.digest !== candidate.manifestDigest) fail('accept_candidate_manifest_missing');
  for (const entry of manifest.entries) {
    if (entry.path === '.git' || entry.path.startsWith('.git/')) fail('accept_candidate_git_path_unsafe');
  }
  return { candidate, manifest };
}

function trackAdmission(admission) {
  if (!admission) fail('accept_check_admission_required');
  for (const method of ['acquire', 'recordTurnStart', 'release']) {
    if (typeof admission[method] !== 'function') throw new TypeError(`Acceptance admission.${method} is required`);
  }
  let releasePromise = null;
  let acquireStarted = false;
  let acquired = null;
  let releaseState = null;
  const adapter = {
    acquire: (...args) => {
      acquireStarted = true;
      return Promise.resolve().then(() => admission.acquire(...args)).then((lease) => {
        if (!lease || typeof lease !== 'object' || typeof lease.executionId !== 'string' || !lease.executionId) {
          fail('accept_check_admission_identity_invalid');
        }
        acquired = lease;
        return lease;
      });
    },
    recordTurnStart: (...args) => admission.recordTurnStart(...args),
    release: (...args) => {
      if (!acquired || args[0] !== acquired.executionId || releasePromise) fail('accept_check_admission_identity_invalid');
      releasePromise = Promise.resolve().then(() => admission.release(...args));
      return releasePromise;
    },
  };
  return {
    adapter,
    get releaseState() { return releaseState; },
    async waitForRelease({ requireRelease = false, timeoutMs = 30_000 } = {}) {
      if (acquireStarted && !acquired) fail('accept_check_admission_unresolved');
      if (!releasePromise) {
        if (acquired || requireRelease) fail('accept_check_admission_unresolved');
        return null;
      }
      let timer;
      let released;
      try {
        released = await Promise.race([
          releasePromise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('admission release timed out')), timeoutMs);
          }),
        ]);
      } catch (_) {
        fail('accept_check_admission_unresolved');
      } finally {
        clearTimeout(timer);
      }
      if (!released || typeof released !== 'object' || !['released', 'reconciled'].includes(released.state)) {
        fail('accept_check_admission_unresolved');
      }
      releaseState = released.state;
      return releaseState;
    },
  };
}

function trackAppServer(appServer) {
  if (!appServer) return { adapter: null, state: () => ({ pending: 0, failures: [] }) };
  const pending = new Set();
  const failures = [];
  const adapter = { ...appServer };
  if (typeof appServer.resolveExecutionPermissions === 'function') {
    adapter.resolveExecutionPermissions = (...args) => appServer.resolveExecutionPermissions(...args);
  }
  if (typeof appServer.execCommand === 'function') {
    adapter.execCommand = (...args) => {
      let request;
      try { request = Promise.resolve(appServer.execCommand(...args)); }
      catch (error) { failures.push('exec_command_rejected'); throw error; }
      pending.add(request);
      return request.then((value) => {
        if (!Number.isInteger(value?.exitCode)) failures.push('exec_command_outcome_unknown');
        return value;
      }, (error) => {
        failures.push('exec_command_rejected');
        throw error;
      }).finally(() => pending.delete(request));
    };
  }
  return { adapter, state: () => ({ pending: pending.size, failures: [...failures] }) };
}

function integrityFailure(result, detail) {
  const issue = acceptanceIssue('candidate_changed', detail);
  const issues = (Array.isArray(result.issues) ? result.issues : []).filter((entry) => entry?.code !== issue.code);
  const reasons = (Array.isArray(result.reasons) ? result.reasons : []).filter((entry) => entry?.code !== issue.code);
  issues.push(issue);
  reasons.push(issue);
  return { ...result, disposition: 'rejected', issues, reasons };
}

async function runFrozenCandidateChecks({
  candidateStore, candidate: expectedCandidate, contract, runId, attempt,
  executionPermissions, acceptanceScratch = null, scratchForbiddenRoots,
  admission, signal, evidenceStore = null, appServer = null,
  runAcceptanceImpl = runAcceptance, temporaryRoot = os.tmpdir(),
} = {}) {
  if (typeof runId !== 'string' || !runId || !Number.isSafeInteger(attempt) || attempt < 1) fail('accept_check_run_identity_invalid');
  if (!['inherit', 'strict', 'full-access'].includes(executionPermissions)) fail('accept_check_permissions_missing');
  if (typeof runAcceptanceImpl !== 'function') throw new TypeError('runAcceptanceImpl must be a function');
  const validatedContract = validateAcceptanceContract(contract);
  if (validatedContract.invalid) fail('accept_check_contract_invalid');
  const { candidate, manifest } = assertCandidateIdentity(candidateStore, expectedCandidate);
  const sourceWorkspace = fs.realpathSync(candidateStore.workspace);
  const candidateStorage = fs.realpathSync(candidateStore.storageDir);
  const tempParent = fs.realpathSync(temporaryRoot);
  if (!fs.statSync(tempParent).isDirectory() || inside(sourceWorkspace, tempParent) || inside(candidateStorage, tempParent)) fail('accept_check_temp_root_unsafe');

  const controlRoot = fs.mkdtempSync(path.join(tempParent, 'delivery-acceptance-controls-'));
  let workspace;
  try { workspace = fs.mkdtempSync(path.join(tempParent, 'delivery-acceptance-')); }
  catch (error) { removeTemporaryTree(controlRoot); throw error; }
  if (inside(sourceWorkspace, workspace) || inside(workspace, sourceWorkspace)
    || inside(candidateStorage, workspace) || inside(workspace, candidateStorage)
    || inside(workspace, controlRoot) || inside(controlRoot, workspace)
    || inside(sourceWorkspace, controlRoot) || inside(candidateStorage, controlRoot)) {
    fs.rmSync(workspace, { recursive: true, force: true });
    removeTemporaryTree(controlRoot);
    fail('accept_check_temp_root_unsafe');
  }
  let rawResult = null;
  let server = null;
  let preserveWorkspace = false;
  try {
    const gitContext = createGitContext(controlRoot);
    candidateStore.materialize(candidate.candidateId, workspace);
    const beforeManifest = measureCandidateTree(workspace, manifest);
    if (beforeManifest.digest !== manifest.digest) fail('accept_candidate_materialization_mismatch');

    runGit(workspace, ['init', '-q'], gitContext);
    runGit(workspace, ['config', 'user.name', 'Frozen candidate check'], gitContext);
    runGit(workspace, ['config', 'user.email', 'candidate-check@invalid'], gitContext);
    runGit(workspace, ['config', 'commit.gpgsign', 'false'], gitContext);
    runGit(workspace, ['add', '-f', '--all'], gitContext);
    runGit(workspace, ['commit', '--allow-empty', '-q', '-m', 'Frozen candidate mirror'], gitContext);
    const mirrorHead = runGit(workspace, ['rev-parse', 'HEAD'], gitContext).trim() || null;
    const tracked = trackAdmission(admission);
    server = trackAppServer(appServer);
    try {
      rawResult = await runAcceptanceImpl({
        workspace,
        ...(executionPermissions === 'full-access' ? { permissionWorkspace: sourceWorkspace } : {}),
        runId,
        attempt,
        contract,
        writers: [],
        unresolvedWriterCount: 0,
        admission: tracked.adapter,
        signal,
        evidenceStore,
        appServer: server.adapter,
        acceptanceScratch,
        scratchForbiddenRoots,
        executionPermissions,
        gitEnvironment: gitContext.env,
      });
      await tracked.waitForRelease({ requireRelease: validatedContract.requiredChecks.length > 0
        && rawResult?.disposition === 'accepted' });
    } catch (error) {
      let releaseError = null;
      try { await tracked.waitForRelease(); } catch (releaseFailure) { releaseError = releaseFailure; }
      const serverState = server.state();
      if (serverState.pending > 0 || serverState.failures.length > 0
        || error?.code === 'accept_check_admission_unresolved' || releaseError?.code === 'accept_check_admission_unresolved') {
        preserveWorkspace = true;
        const unknown = error?.code === 'accept_check_admission_unresolved' ? error
          : releaseError?.code === 'accept_check_admission_unresolved' ? releaseError
            : new DeliveryAcceptanceError('accept_check_effect_unknown');
        unknown.workspace = workspace;
        unknown.candidateId = candidate.candidateId;
        unknown.pendingAppServerCommands = serverState.pending;
        unknown.appServerFailures = serverState.failures;
        unknown.gitControlRoot = controlRoot;
        throw unknown;
      }
      throw error;
    }

    if (!rawResult || typeof rawResult !== 'object' || typeof rawResult.disposition !== 'string'
      || !Array.isArray(rawResult.checks) || !Array.isArray(rawResult.issues) || !Array.isArray(rawResult.reasons)) {
      fail('accept_check_result_invalid');
    }

    const serverState = server.state();
    if (serverState.pending > 0 || serverState.failures.length > 0) {
      preserveWorkspace = true;
      const unknown = new DeliveryAcceptanceError('accept_check_effect_unknown');
      unknown.workspace = workspace;
      unknown.candidateId = candidate.candidateId;
      unknown.pendingAppServerCommands = serverState.pending;
      unknown.appServerFailures = serverState.failures;
      unknown.gitControlRoot = controlRoot;
      unknown.checkResults = rawResult?.checks || [];
      throw unknown;
    }

    const afterManifest = measureCandidateTree(workspace, manifest);
    const afterCheck = afterManifest.digest === manifest.digest
      ? rawResult
      : integrityFailure(rawResult, 'The materialized candidate bytes or executable modes changed while acceptance checks ran.');
    const required = validatedContract.requiredChecks;
    const resultById = new Map((afterCheck.checks || []).map((entry) => [entry.id, entry]));
    const allRequiredPassed = required.every((check) => resultById.get(check.id)?.result === 'passed'
      && JSON.stringify(resultById.get(check.id)?.argv) === JSON.stringify(check.argv));
    const emptyContractAccepted = required.length === 0 && afterCheck.disposition === 'not_required'
      && afterCheck.checks.length === 0 && afterCheck.issues.length === 0 && afterCheck.reasons.length === 0;
    const disposition = emptyContractAccepted ? { ...afterCheck, disposition: 'accepted' }
      : afterCheck.disposition === 'not_required' ? integrityFailure(afterCheck, 'The acceptance runner returned an invalid empty-check result.')
      : afterCheck.disposition === 'accepted' && !allRequiredPassed
      ? integrityFailure(afterCheck, 'The acceptance runner omitted a passing result for a pinned required check.')
      : afterCheck;
    const checkPins = validatedContract.requiredChecks.flatMap((check) => (check.pins || []).map((pin) => ({ checkId: check.id, ...pin })));
    return {
      disposition: disposition.disposition,
      reasons: disposition.reasons || [],
      issues: disposition.issues || [],
      checkResults: disposition.checks || [],
      requiredCheckIds: [...validatedContract.requiredChecks.map((check) => check.id)],
      checkContract: { source: validatedContract.source || 'owner', digest: `sha256:${sha256(canonical(validatedContract))}`, pins: checkPins },
      checkSettings: { executionPermissions, scratchEnabled: acceptanceScratch !== null },
      candidate: { projectId: candidate.projectId, objectiveId: candidate.objectiveId,
        candidateId: candidate.candidateId, integrationGeneration: candidate.integrationGeneration,
        manifestDigest: manifest.digest, sourceHead: manifest.head ?? null,
        environmentDigest: candidate.environmentDigest, checkIdentity: candidate.checkIdentity },
      checkSnapshot: { syntheticHead: mirrorHead,
        beforeFingerprint: disposition.candidate?.fingerprint ?? null,
        afterFingerprint: disposition.candidateAfter?.fingerprint ?? null },
      verifiedAt: disposition.verifiedAt,
      admissionHeld: disposition.admissionHeld === true,
      admissionReleaseState: tracked.releaseState || null,
    };
  } finally {
    if (!preserveWorkspace) {
      removeTemporaryTree(workspace);
      removeTemporaryTree(controlRoot);
    }
  }
}

function assertFinalizationContract(request, contract, acceptanceScratch) {
  const validated = validateAcceptanceContract(contract);
  if (validated.invalid) fail('accept_check_contract_invalid');
  const digest = `sha256:${sha256(canonical(validated))}`;
  const source = validated.source || 'owner';
  const requiredCheckIds = validated.requiredChecks.map((check) => check.id);
  if (request.checkContractDigest !== digest || request.checkSource !== source
    || canonical(request.requiredCheckIds) !== canonical(requiredCheckIds)
    || !['inherit', 'strict', 'full-access'].includes(request.executionPermissions)
    || typeof request.scratchEnabled !== 'boolean'
    || request.scratchEnabled !== (acceptanceScratch !== null)) {
    fail('finalization_check_contract_pins_stale');
  }
  return validated;
}

function finalizationResult(record, replay = false) {
  return { state: record.state, finalization: record, ...(replay ? { replay: true } : {}) };
}

function finalizeCandidateState({ store, projectId, objectiveId, finalizationId, pinsDigest, adapters, record }) {
  if (['accepted', 'partial', 'ready'].includes(record.state)) {
    const terminal = store.commitFinalization(projectId, objectiveId,
      { finalizationId, expectedPinsDigest: pinsDigest }, adapters);
    return { state: terminal.disposition, finalization: terminal, ...(terminal.replay ? { replay: true } : {}) };
  }
  return finalizationResult(record, record.replay === true);
}

async function finalizeCandidate({
  store, candidateStore, reviewStore, lifecycle, projectId, objectiveId, request,
  contract, admission, acceptanceScratch = null, scratchForbiddenRoots,
  signal, evidenceStore = null, appServer = null,
  temporaryRoot = os.tmpdir(), onChecksExecuted,
} = {}) {
  if (!store || typeof store.beginFinalization !== 'function'
    || typeof store.startFinalizationChecks !== 'function'
    || typeof store.recordFinalizationChecks !== 'function'
    || typeof store.markFinalizationCheckUnknown !== 'function'
    || typeof store.commitFinalization !== 'function'
    || typeof store.getFinalization !== 'function') throw new TypeError('BacklogStore is required');
  if (typeof projectId !== 'string' || !projectId || typeof objectiveId !== 'string' || !objectiveId) {
    fail('finalization_objective_identity_invalid');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('finalization_request_invalid');
  if (onChecksExecuted !== undefined && typeof onChecksExecuted !== 'function') throw new TypeError('onChecksExecuted must be a function');
  const validatedContract = assertFinalizationContract(request, contract, acceptanceScratch);
  const finalizationId = request.finalizationId;
  const adapters = { candidateStore, reviewStore, lifecycle };
  const barrier = store.beginFinalization(projectId, objectiveId, request, adapters);
  if (barrier.projectId !== projectId || barrier.objectiveId !== objectiveId
    || barrier.finalizationId !== finalizationId || !barrier.pinsDigest || !barrier.pins?.candidate) {
    fail('finalization_barrier_invalid');
  }

  if (['accepted', 'partial', 'ready', 'checking', 'unknown', 'rejected', 'invalidated'].includes(barrier.state)) {
    return finalizeCandidateState({ store, projectId, objectiveId, finalizationId,
      pinsDigest: barrier.pinsDigest, adapters, record: barrier });
  }
  if (barrier.state !== 'barrier') fail('finalization_barrier_state_invalid');

  const checkAttemptId = crypto.randomUUID();
  let checking;
  try {
    checking = store.startFinalizationChecks(projectId, objectiveId, { finalizationId,
      expectedPinsDigest: barrier.pinsDigest, checkAttemptId }, adapters);
  } catch (error) {
    const current = store.getFinalization(projectId, objectiveId, finalizationId);
    if (current && current.pinsDigest === barrier.pinsDigest
      && ['checking', 'unknown', 'ready', 'accepted', 'partial', 'rejected', 'invalidated'].includes(current.state)) {
      return finalizeCandidateState({ store, projectId, objectiveId, finalizationId,
        pinsDigest: barrier.pinsDigest, adapters, record: current });
    }
    throw error;
  }
  const candidatePins = checking.pins.candidate;
  const expectedCandidate = {
    projectId, objectiveId,
    candidateId: candidatePins.candidateId,
    integrationGeneration: candidatePins.integrationGeneration,
    manifestDigest: candidatePins.manifestDigest,
    environmentDigest: candidatePins.environmentDigest,
    checkIdentity: candidatePins.checkIdentity,
  };
  let result;
  try {
    result = await runFrozenCandidateChecks({ candidateStore, candidate: expectedCandidate,
      contract: validatedContract, runId: checkAttemptId, attempt: 1,
      executionPermissions: checking.pins.executionPermissions, acceptanceScratch,
      scratchForbiddenRoots, admission, signal, evidenceStore, appServer,
      temporaryRoot });
  } catch (error) {
    if (typeof error?.workspace === 'string' && path.isAbsolute(error.workspace)
      && typeof error?.gitControlRoot === 'string' && path.isAbsolute(error.gitControlRoot)) {
      const unknown = store.markFinalizationCheckUnknown(projectId, objectiveId, {
        finalizationId, checkAttemptId,
        reasonCode: /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code || '') ? error.code : 'accept_check_effect_unknown',
        workspace: error.workspace, gitControlRoot: error.gitControlRoot,
      });
      return finalizationResult(unknown);
    }
    throw error;
  }

  if (onChecksExecuted) {
    const authorized = await onChecksExecuted({ projectId, objectiveId, finalizationId,
      checkAttemptId, pins: structuredClone(checking.pins), result: structuredClone(result) });
    if (authorized !== true) fail('finalization_check_execution_proof_missing');
  }

  const readyOrRejected = store.recordFinalizationChecks(projectId, objectiveId,
    { finalizationId, checkAttemptId, result }, adapters);
  return finalizeCandidateState({ store, projectId, objectiveId, finalizationId,
    pinsDigest: barrier.pinsDigest, adapters, record: readyOrRejected });
}

module.exports = { DeliveryAcceptanceError, measureCandidateTree, runFrozenCandidateChecks, finalizeCandidate };
