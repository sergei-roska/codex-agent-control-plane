'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { isDeepStrictEqual } = require('node:util');
const runner = require('./run-dccourts-182');

const TASK_ID = '3d20463a-1c91-4805-aaff-489d9f4ff5b6';
const RUN_ROOT = '/tmp/dccourts182-native-k2ID27';
const EVIDENCE_FILE = path.join(runner.RUNNER_DIR, `${TASK_ID}.evidence.json`);
const MATERIALIZATION_PROOF = path.join(runner.RUNNER_DIR, 'actual-materialization-proof.json');
const TRUST_CONFIG_SHA256 = '883b41ab2312ac1f3c84fdd8cebc9905e5f317b4cbce218334904e03569d57b9';
const ORIGINAL_COMMON_GIT_DIR = '/home/sr/Projects/dccourtscode/.git';
const RESUME_TEXT = 'Resume the existing DCCOURTS-182 objective at its current state. Keep its original goal and acceptance contract unchanged. Continue the pending verifier review for the already-created candidate; do not replace the objective or acceptance requirements.';

function requireCondition(ok, code) {
  if (!ok) throw new Error(code);
}

function privateReadJson(file) {
  const stat = fs.lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink(), `unsafe_private_file:${path.basename(file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function privateFileHash(file) {
  const stat = fs.lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink(), `unsafe_private_file:${path.basename(file)}`);
  return runner.sha256(fs.readFileSync(file));
}

function validateRetainedTrust(workspace, configFile) {
  const hash = privateFileHash(configFile);
  requireCondition(hash === TRUST_CONFIG_SHA256, 'continuation_codex_trust_config_hash_changed');
  const configText = fs.readFileSync(configFile, 'utf8');
  const projects = JSON.parse(execFileSync('python3', ['-c', [
    'import json, sys, tomllib',
    'data = tomllib.loads(sys.stdin.read())',
    'print(json.dumps(data.get("projects", {}), sort_keys=True))',
  ].join('; ')], { input: configText, encoding: 'utf8' }));
  const expectedProjects = [workspace, '/home/sr/Projects/dccourtscode'].sort();
  requireCondition(isDeepStrictEqual(Object.keys(projects).sort(), expectedProjects), 'continuation_codex_trust_project_set_changed');
  for (const project of expectedProjects) {
    requireCondition(projects[project]?.trust_level === 'trusted'
      && Object.keys(projects[project]).length === 1, 'continuation_codex_trust_entry_changed');
  }
  const commonGitDir = runner.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], workspace);
  requireCondition(commonGitDir === ORIGINAL_COMMON_GIT_DIR, 'continuation_target_common_git_relation_changed');
  return { sha256: hash, projects: expectedProjects, commonGitDir };
}

function captureResumeState() {
  const evidence = privateReadJson(EVIDENCE_FILE);
  requireCondition(evidence.taskId === TASK_ID, 'continuation_evidence_task_mismatch');
  requireCondition(evidence.close === 'completed' && evidence.status === 'incomplete', 'continuation_prior_close_not_safe');
  const materialization = privateReadJson(MATERIALIZATION_PROOF);
  requireCondition(materialization.verifyReviewInput === true && materialization.files === 3207,
    'review_materialization_proof_failed');
  const workspace = path.resolve(JSON.parse(fs.readFileSync(runner.INPUT_FILE, 'utf8')).workspace);
  requireCondition(workspace === '/home/sr/Projects/dccourtscode-harness-trial-20261104', 'continuation_workspace_mismatch');
  const target = runner.captureTarget(workspace);
  const targetDigest = runner.digestTarget(target);
  requireCondition(isDeepStrictEqual(targetDigest, evidence.sourceAfter), 'candidate_source_changed_since_last_attempt');

  const stateFile = path.join(RUN_ROOT, 'state.sqlite');
  const db = new (require('better-sqlite3'))(stateFile, { readonly: true, fileMustExist: true });
  let snapshot;
  let readiness;
  try {
    const mapping = db.prepare('SELECT run_id,engine,objective_id,session_id FROM delivery_run_engines WHERE run_id=?').get(TASK_ID);
    requireCondition(mapping?.engine === 'concurrent-v1', 'continuation_engine_mapping_missing');
    const run = db.prepare('SELECT status,objective_id FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?')
      .get(evidence.startup.projectId, TASK_ID);
    requireCondition(run?.objective_id === mapping.objective_id && run.status === 'paused', 'continuation_run_not_paused');
    const task = db.prepare('SELECT context_id,status_state FROM tasks WHERE id=? AND owner=?').get(TASK_ID, 'orchestrator');
    requireCondition(task?.status_state === 'TASK_STATE_INPUT_REQUIRED', 'continuation_a2a_task_not_input_required');
    const objectiveRow = db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?')
      .get(evidence.startup.projectId, mapping.objective_id);
    const objective = objectiveRow ? JSON.parse(objectiveRow.record_json) : null;
    requireCondition(objective?.disposition === 'blocked_technical', 'continuation_objective_not_blocked_technical');
    const phase = db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(evidence.startup.projectId);
    requireCondition(phase && JSON.parse(phase.phase_json).phase === 'released', 'continuation_shutdown_not_released');
    const activePlannerTurns = db.prepare("SELECT turn_id,status FROM delivery_planner_turns WHERE project_id=? AND status IN ('active','unknown')")
      .all(evidence.startup.projectId);
    requireCondition(activePlannerTurns.length === 0, 'continuation_planner_turn_unsettled');
    const unreconciledRecoveries = db.prepare("SELECT turn_id,state FROM delivery_lifecycle_planner_recoveries WHERE project_id=? AND state<>'reconciled'")
      .all(evidence.startup.projectId);
    requireCondition(unreconciledRecoveries.length === 0, 'continuation_planner_recovery_unsettled');

    const review = db.prepare(`SELECT task_id,candidate_id,state FROM review_tasks
      WHERE project_id=? AND objective_id=? AND state='queued' ORDER BY created_at DESC LIMIT 1`)
      .get(evidence.startup.projectId, mapping.objective_id);
    requireCondition(review?.task_id === 'review-e012790536d88c5f3213442e', 'continuation_queued_review_missing');
    const reviewTaskRow = db.prepare('SELECT state,role,contract_json FROM backlog_tasks WHERE project_id=? AND objective_id=? AND task_id=?')
      .get(evidence.startup.projectId, mapping.objective_id, review.task_id);
    const reviewContract = reviewTaskRow ? JSON.parse(reviewTaskRow.contract_json) : null;
    requireCondition(reviewTaskRow?.state === 'queued' && reviewTaskRow.role === 'verifier' && reviewContract?.kind === 'review',
      'continuation_backlog_review_not_queued');
    const candidate = db.prepare('SELECT candidate_id,status FROM concurrent_candidates WHERE project_id=? AND objective_id=? AND candidate_id=?')
      .get(evidence.startup.projectId, mapping.objective_id, review.candidate_id);
    requireCondition(candidate?.status === 'known' && review.candidate_id === materialization.candidateId,
      'continuation_review_candidate_unavailable');
    const prior = db.prepare('SELECT attempt_id,record_json,release_facts_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND task_id=? ORDER BY attempt_no DESC LIMIT 1')
      .get(evidence.startup.projectId, mapping.objective_id, review.task_id);
    const priorAttempt = prior ? JSON.parse(prior.record_json) : null;
    const releaseFacts = prior?.release_facts_json ? JSON.parse(prior.release_facts_json) : null;
    requireCondition(priorAttempt?.state === 'canceled' && priorAttempt.externalTaskId === null
      && priorAttempt.outcome?.failureKind === 'reconciled_no_effect', 'prior_review_not_reconciled_no_effect');
    requireCondition(releaseFacts?.remoteQuiescent === true && releaseFacts?.processQuiescent === true
      && releaseFacts?.effectsSettled === true && Array.isArray(releaseFacts.evidenceRefs)
      && releaseFacts.evidenceRefs.some((ref) => ref.startsWith(`concurrent-shutdown:undispatched-review:${prior.attempt_id}:`)),
    'prior_review_reconciliation_proof_missing');
    const claim = db.prepare('SELECT record_json FROM backlog_claims WHERE project_id=? AND objective_id=? AND task_id=? AND attempt_id=?')
      .get(evidence.startup.projectId, mapping.objective_id, review.task_id, prior.attempt_id);
    requireCondition(claim && JSON.parse(claim.record_json).state === 'released', 'prior_review_claim_not_released');

    const phaseData = JSON.parse(phase.phase_json);
    const snapshotData = runner.readSnapshot(stateFile, evidence.startup.projectId, TASK_ID, mapping.objective_id);
    snapshot = { mapping, run: { status: run.status, objectiveId: run.objective_id }, objective: {
      objectiveId: objective.objectiveId, disposition: objective.disposition }, task: {
      contextId: task.context_id, statusName: task.status_state }, phase: phaseData.phase,
      activePlannerTurns, unreconciledRecoveries,
      queuedReview: { taskId: review.task_id, candidateId: review.candidate_id, candidateStatus: candidate.status },
      priorUndispatchedReview: { attemptId: prior.attempt_id, state: priorAttempt.state,
        failureKind: priorAttempt.outcome.failureKind, externalTaskId: priorAttempt.externalTaskId,
        claimState: JSON.parse(claim.record_json).state, evidenceRefs: releaseFacts.evidenceRefs },
      deliverySnapshot: snapshotData };
    readiness = { target: targetDigest, stateSha256: privateFileHash(stateFile), snapshot };
  } finally {
    db.close();
  }

  const codexHome = path.join(RUN_ROOT, 'codex-home');
  const settingsFile = path.join(RUN_ROOT, 'project-settings.json');
  const roleOverridesFile = path.join(RUN_ROOT, 'role-overrides.json');
  const accountsDir = path.join(RUN_ROOT, 'accounts');
  const storage = path.join(RUN_ROOT, 'delivery-storage');
  const locks = path.join(RUN_ROOT, 'workspace-locks');
  for (const dir of [codexHome, accountsDir, storage, locks]) {
    requireCondition(fs.statSync(dir).isDirectory(), `continuation_private_directory_missing:${path.basename(dir)}`);
  }
  const settings = privateReadJson(settingsFile);
  requireCondition(settings.version === 1 && settings.deliveryEngine === 'concurrent-v1'
    && settings.executionPermissions === 'full-access', 'continuation_project_settings_changed');
  const roles = privateReadJson(roleOverridesFile);
  requireCondition(isDeepStrictEqual(roles, { version: 1, roles: evidence.roleOverrides }), 'continuation_role_overrides_changed');
  const trustMap = validateRetainedTrust(workspace, path.join(codexHome, 'config.toml'));
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  const authStat = fs.lstatSync(authPath);
  requireCondition(authStat.isFile() && !authStat.isSymbolicLink(), 'source_auth_unavailable');
  const resumeToken = path.join(RUN_ROOT, 'resume-token');
  requireCondition(!fs.existsSync(resumeToken), 'resume_token_already_exists');
  readiness.privatePaths = { codexHome, accountsDir, settingsFile, roleOverridesFile, storage, locks, stateFile,
    resumeToken, authAvailable: true };
  readiness.privateHashes = { settingsSha256: privateFileHash(settingsFile), roleOverridesSha256: privateFileHash(roleOverridesFile),
    codexTrustConfigSha256: trustMap.sha256,
    materializationProofSha256: privateFileHash(MATERIALIZATION_PROOF) };
  readiness.retainedTrustMap = trustMap;
  readiness.reviewMaterialization = { verified: true, files: materialization.files,
    candidateId: materialization.candidateId, manifestDigest: materialization.manifestDigest };
  readiness.acceptance = evidence.acceptance;
  return readiness;
}

async function backupReadonly(source, destination) {
  const db = new (require('better-sqlite3'))(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); } finally { db.close(); }
  fs.chmodSync(destination, 0o600);
  return { path: destination, sha256: runner.sha256(fs.readFileSync(destination)), bytes: fs.statSync(destination).size };
}

function assessAcceptedCompletion(snapshot, pre) {
  const required = (pre.acceptance?.requiredChecks || []).map((check) => check.id).sort();
  const contractValid = required.length > 0 && required.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(required).size === required.length;
  const candidateId = pre.snapshot.queuedReview.candidateId;
  const taskId = pre.snapshot.queuedReview.taskId;
  const sameIds = (ids) => Array.isArray(ids) && ids.slice().sort().join('\n') === required.join('\n');
  const verifierProof = (snapshot.proofs || []).find((proof) => proof.taskId === taskId
    && proof.candidateId === candidateId && sameIds(proof.checkPins)
    && Array.isArray(proof.results) && sameIds(proof.results.map((result) => result.checkId))
    && proof.results.every((result) => result.state === 'passed')
    && typeof proof.evidenceDigest === 'string');
  const finalization = snapshot.finalization;
  const finalRecord = finalization?.record;
  const terminal = finalRecord?.terminalRecord;
  const finalCandidateId = finalRecord?.pins?.candidate?.candidateId || terminal?.pins?.candidate?.candidateId;
  const finalizationProof = (snapshot.finalizationProofs || []).find((proof) => proof.finalizationId === finalRecord?.finalizationId
    && proof.checkAttemptId === finalRecord?.checkAttemptId
    && proof.pins?.candidate?.candidateId === candidateId
    && proof.result?.candidate?.candidateId === candidateId
    && proof.result?.disposition === 'accepted'
    && sameIds(proof.result?.requiredCheckIds)
    && Array.isArray(proof.result?.checkResults)
    && sameIds(proof.result.checkResults.map((result) => result.id))
    && proof.result.checkResults.every((result) => result.result === 'passed'));
  const accepted = contractValid && snapshot.a2a?.stateName === 'TASK_STATE_COMPLETED'
    && snapshot.run?.status === 'accepted' && snapshot.run?.result?.disposition === 'accepted'
    && snapshot.run?.result?.candidateId === candidateId
    && snapshot.objective?.disposition === 'accepted'
    && finalization?.state === 'accepted' && finalRecord?.state === 'accepted'
    && finalRecord?.checkResult?.disposition === 'accepted'
    && sameIds(finalRecord?.checkResult?.requiredCheckIds)
    && finalCandidateId === candidateId
    && terminal?.disposition === 'accepted' && terminal?.goalAchieved === true
    && Boolean(verifierProof) && Boolean(finalizationProof);
  return { accepted, requiredCheckIds: required, candidateId, reviewTaskId: taskId,
    verifierCheckProof: verifierProof ? { attemptId: verifierProof.attemptId, taskId: verifierProof.taskId,
      candidateId: verifierProof.candidateId, checkPins: verifierProof.checkPins,
      results: verifierProof.results } : null,
    finalization: finalization ? { state: finalization.state, candidateId: finalCandidateId,
      checkResultDisposition: finalRecord?.checkResult?.disposition || null } : null,
    finalizationCheckProof: finalizationProof ? { finalizationId: finalizationProof.finalizationId,
      checkAttemptId: finalizationProof.checkAttemptId, candidateId: finalizationProof.pins.candidate.candidateId,
      checkResults: finalizationProof.result.checkResults } : null };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

function replaceJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  JSON.parse(fs.readFileSync(temporary, 'utf8'));
  fs.renameSync(temporary, file);
}

async function preflight() {
  const result = captureResumeState();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(runner.RUNNER_DIR, `${TASK_ID}.resume-preflight-${stamp}.state.sqlite`);
  result.preActionStateBackup = await backupReadonly(path.join(RUN_ROOT, 'state.sqlite'), backupPath);
  result.mode = 'preflight_only';
  result.resumeMessage = RESUME_TEXT;
  result.createdAt = new Date().toISOString();
  const report = path.join(runner.RUNNER_DIR, `${TASK_ID}.resume-preflight-${stamp}.json`);
  result.reportPath = report;
  writeJson(report, result);
  process.stdout.write(`${JSON.stringify({ status: 'resume_preflight_ready', report,
    stateBackup: result.preActionStateBackup, taskId: TASK_ID, currentState: result.snapshot.task.statusName })}\n`);
  return result;
}

function timeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resume_timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

async function runResume() {
  const pre = await preflight();
  const workspace = JSON.parse(fs.readFileSync(runner.INPUT_FILE, 'utf8')).workspace;
  const codexHome = path.join(RUN_ROOT, 'codex-home');
  const accountsDir = path.join(RUN_ROOT, 'accounts');
  const stateFile = path.join(RUN_ROOT, 'state.sqlite');
  const tokenFile = pre.privatePaths.resumeToken;
  const settingsFile = pre.privatePaths.settingsFile;
  const roleOverridesFile = pre.privatePaths.roleOverridesFile;
  const locks = pre.privatePaths.locks;
  const storage = pre.privatePaths.storage;
  let runtime = null;
  let closeError = null;
  const output = { status: 'started', taskId: TASK_ID, objectiveId: pre.snapshot.mapping.objective_id,
    preflightReport: pre.reportPath,
    preActionStateBackup: pre.preActionStateBackup, sourceBefore: pre.target,
    acceptance: pre.acceptance,
    resumeMessageSha256: runner.sha256(RESUME_TEXT), providerExecutions: [], ownedLandoServicesBefore: runner.privateLandoServices() };
  try {
    runner.copyPrivate(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'));
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_A2A_ACCOUNTS_DIR = accountsDir;
    process.env.CODEX_A2A_TURN_TIMEOUT_MS = String(JSON.parse(fs.readFileSync(runner.INPUT_FILE, 'utf8')).bounds.turnTimeoutMs);
    process.env.CODEX_A2A_AUTO_RESUME = 'false';
    delete process.env.OPENAI_API_KEY;
    const { startServer } = require(path.join(runner.HARNESS_ROOT, 'src/server'));
    const { CodexAppServer } = require(path.join(runner.HARNESS_ROOT, 'src/codex-app-server'));
    const appServerFactory = (home) => {
      const appServer = new CodexAppServer({ codexHome: home });
      const genuineRun = appServer.run.bind(appServer);
      appServer.run = async (request) => {
        const item = { role: request.role?.id || request.role?.name || null,
          configuredModel: request.role?.model || null, configuredEffort: request.role?.effort || null };
        const capture = (result, outcome) => {
          item.outcome = outcome; item.status = result?.status || null;
          item.threadId = result?.threadId || result?.execution?.threadId || null;
          item.turnId = result?.turnId || result?.execution?.turnId || null;
          item.usage = result?.usage ? { model: result.usage.model || null, effort: result.usage.effort || null,
            fastMode: result.usage.fastMode || null, elapsedMs: result.usage.elapsedMs ?? null,
            turns: result.usage.turns ?? null, tokens: result.usage.tokens || null,
            tokenSource: result.usage.tokenSource || null } : null;
          item.failureClass = result?.failureClass || null;
          output.providerExecutions.push(item);
        };
        try { const result = await genuineRun(request); capture(result, result?.status || 'completed'); return result; }
        catch (error) { capture(error, 'failed'); throw error; }
      };
      return appServer;
    };
    runtime = await startServer({ port: 0, workspace, stateFile, tokenFile, workspaceLockDir: locks,
      deliveryStorageRoot: storage, projectSettingsFile: settingsFile, roleOverridesFile, accountsDir,
      appServerFactory, autoResume: false });
    requireCondition(runtime.host === '127.0.0.1' && runtime.deliveryEngine === 'concurrent-v1', 'resume_runtime_not_isolated_concurrent');
    output.startup = { projectId: runtime.projectId, deliveryEngine: runtime.deliveryEngine,
      roles: [...runtime.roles.values()].map((role) => ({ id: role.id, model: role.model, effort: role.effort })),
      writerIsolation: runtime.writerIsolation };
    const origin = `http://${runtime.host}:${runtime.port}`;
    const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const auth = { serviceParameters: { Authorization: `Bearer ${token}` } };
    const existing = await client.getTask({ tenant: '', id: TASK_ID }, auth);
    const task = existing?.task || existing;
    requireCondition(task?.id === TASK_ID && task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED,
      'resume_a2a_task_precondition_changed');
    output.existingTask = { id: task.id, state: TaskState[task.status.state], contextId: task.contextId || null };
    const response = await timeout(client.sendMessage({ tenant: '', message: {
      messageId: `resume-${TASK_ID}-${Date.now()}`, contextId: task.contextId || '', taskId: TASK_ID, role: 1,
      parts: [{ content: { $case: 'text', value: RESUME_TEXT }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    }, configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true } }, auth), 30000);
    let current = response?.task || response;
    requireCondition(current?.id === TASK_ID, 'resume_response_task_identity_changed');
    output.a2a = { id: current.id, state: current.status?.state ?? null, stateName: TaskState[current.status?.state] || null };
    const active = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING];
    const input = JSON.parse(fs.readFileSync(runner.INPUT_FILE, 'utf8'));
    const deadline = Date.now() + input.bounds.objectiveTimeoutMs;
    while (active.includes(current.status?.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const latest = await client.getTask({ tenant: '', id: TASK_ID }, auth);
      current = latest?.task || latest;
    }
    if (active.includes(current.status?.state)) output.timeout = true;
    output.a2a = { id: current.id, state: current.status?.state ?? null,
      stateName: TaskState[current.status?.state] || null };
    output.snapshotBeforeClose = runner.readSnapshot(stateFile, runtime.projectId, TASK_ID, pre.snapshot.mapping.objective_id);
    output.ownedLandoServicesDuringRun = runner.privateLandoServices();
    await runtime.close();
    runtime = null;
    output.close = 'completed';
    output.snapshotAfterClose = runner.readSnapshot(stateFile, output.startup.projectId, TASK_ID, pre.snapshot.mapping.objective_id);
  } catch (error) {
    output.status = 'failed';
    output.error = { name: error?.name || 'Error', code: error?.code || null,
      message: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 300) };
  } finally {
    if (runtime) {
      try { await runtime.close(); runtime = null; output.close = 'completed'; }
      catch (error) {
        closeError = error;
        output.close = 'unsafe_or_failed';
        output.closeError = { code: error?.code || null, name: error?.name || 'Error' };
        output.retainedRunRoot = RUN_ROOT;
      }
    }
    if (!closeError && output.close === 'completed') {
      try { fs.rmSync(path.join(codexHome, 'auth.json'), { force: true }); } catch (_) {}
      try { fs.rmSync(tokenFile, { force: true }); } catch (_) {}
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { output.afterStateBackup = await backupReadonly(stateFile, path.join(runner.RUNNER_DIR, `${TASK_ID}.resume-after-${stamp}.state.sqlite`)); }
    catch (error) { output.afterStateBackupError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200); }
    try {
      const afterTarget = runner.captureTarget(workspace);
      const evidenceName = `${stamp}-${TASK_ID}`;
      const diffPath = path.join(runner.RUNNER_DIR, `${evidenceName}.resume.diff`);
      const patchPath = path.join(runner.RUNNER_DIR, `${evidenceName}.resume.patch`);
      fs.writeFileSync(diffPath, afterTarget.trackedDiff, { mode: 0o600, flag: 'wx' });
      if (afterTarget.expectedPatch.length) fs.writeFileSync(patchPath, afterTarget.expectedPatch, { mode: 0o600, flag: 'wx' });
      output.candidateEvidence = { source: runner.digestTarget(afterTarget), diffPath,
        diffSha256: runner.sha256(afterTarget.trackedDiff), patchPath: afterTarget.expectedPatch.length ? patchPath : null,
        patchSha256: afterTarget.expectedPatchHash };
      output.sourceAfter = output.candidateEvidence.source;
    } catch (error) { output.candidateEvidenceError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200); }
    output.ownedLandoServicesAfter = runner.privateLandoServices();
    output.completionProof = output.snapshotAfterClose
      ? assessAcceptedCompletion({ ...output.snapshotAfterClose, a2a: output.a2a }, pre) : { accepted: false };
    const persistenceFailed = Boolean(output.afterStateBackupError || output.candidateEvidenceError);
    const desiredStatus = output.status === 'failed' || closeError ? 'failed'
      : output.completionProof.accepted && !persistenceFailed ? 'completed' : 'incomplete';
    output.status = 'incomplete';
    output.retainedRunRoot = RUN_ROOT;
    const safeTask = TASK_ID.replace(/[^A-Za-z0-9_-]/g, '_');
    const evidencePath = path.join(runner.RUNNER_DIR, `${safeTask}.resume-evidence-${stamp}.json`);
    output.evidencePath = evidencePath;
    const resultPath = path.join(runner.RUNNER_DIR, `${safeTask}.resume-result-${stamp}.json`);
    try { writeJson(evidencePath, output); }
    catch (error) {
      output.evidenceCaptureError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200);
    }
    try { writeJson(resultPath, output); }
    catch (error) {
      output.resultCaptureError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200);
    }
    const initialPersistenceFailed = Boolean(output.evidenceCaptureError || output.resultCaptureError);
    if (!initialPersistenceFailed && desiredStatus === 'completed') {
      output.status = 'completed';
      try {
        replaceJson(evidencePath, output);
        replaceJson(resultPath, output);
      } catch (error) {
        output.status = 'incomplete';
        output.resultCaptureError = `completion_evidence_persist_failed:${String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 160)}`;
        for (const file of [evidencePath, resultPath]) {
          try { if (fs.existsSync(file)) replaceJson(file, output); } catch (_) {}
        }
      }
    } else if (!initialPersistenceFailed) {
      output.status = desiredStatus;
      try {
        replaceJson(evidencePath, output);
        replaceJson(resultPath, output);
      } catch (error) {
        output.status = 'incomplete';
        output.resultCaptureError = `result_evidence_persist_failed:${String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 160)}`;
        for (const file of [evidencePath, resultPath]) {
          try { if (fs.existsSync(file)) replaceJson(file, output); } catch (_) {}
        }
      }
    }
    if (output.status !== 'completed') output.retainedRunRoot = RUN_ROOT;
    process.stdout.write(`${JSON.stringify({ status: output.status, taskId: TASK_ID, taskState: output.a2a?.stateName || null,
      resultPath, stateBackup: output.afterStateBackup || null, retainedRunRoot: output.retainedRunRoot || null })}\n`);
    if (output.status !== 'completed' || closeError || persistenceFailed || initialPersistenceFailed
      || output.evidenceCaptureError || output.resultCaptureError) process.exitCode = 1;
  }
}

async function main() {
  const mode = process.argv[2] || '--preflight';
  requireCondition(mode === '--preflight' || mode === '--run', 'usage: node resume-dccourts-182.js [--preflight|--run]');
  if (mode === '--preflight') await preflight();
  else await runResume();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', code: error?.code || null,
      message: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 300) })}\n`);
    process.exitCode = 1;
  });
}
