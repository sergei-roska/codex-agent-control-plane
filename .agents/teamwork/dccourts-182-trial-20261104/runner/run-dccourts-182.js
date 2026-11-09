'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');

const RUNNER_DIR = __dirname;
const HARNESS_ROOT = path.resolve(RUNNER_DIR, '../../../../');
const INPUT_FILE = path.resolve(RUNNER_DIR, '../task-input.json');
const SOURCE_CODEX_HOME = path.join(os.homedir(), '.codex');
const SAFE_SOURCE_FILES = [
  'AGENTS.md', '.lando.yml', 'scripts/harness/validate-dccourts-182.sh',
  'composer.json', 'composer.lock', 'patches.lock.json',
  'web/modules/contrib/shs/js/shs.js',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileHash(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe_source_file:${path.basename(file)}`);
  return sha256(fs.readFileSync(file));
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function codexConfig(workspace) {
  return `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`;
}

function validateTomlConfig(workspace) {
  const config = codexConfig(workspace);
  execFileSync('python3', ['-c', 'import sys, tomllib; tomllib.loads(sys.stdin.read())'], { input: config, stdio: ['pipe', 'ignore', 'pipe'] });
  return sha256(config);
}

function copyPrivate(source, destination) {
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(input).isFile()) throw new Error('auth_source_not_regular');
    fs.writeFileSync(destination, fs.readFileSync(input), { mode: 0o600, flag: 'wx' });
  } finally {
    fs.closeSync(input);
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function captureTarget(workspace) {
  const sourceHashes = Object.fromEntries(SAFE_SOURCE_FILES.map((name) => [name, fileHash(path.join(workspace, name))]));
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], workspace);
  const binaryDiff = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: workspace, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const patchPath = path.join(workspace, 'patches/shs-3620147-preselect-stored-values.patch');
  const patchBytes = fs.existsSync(patchPath) ? fs.readFileSync(patchPath) : Buffer.alloc(0);
  return {
    head: git(['rev-parse', 'HEAD'], workspace),
    branch: git(['branch', '--show-current'], workspace),
    status,
    sourceHashes,
    trackedDiff: binaryDiff,
    expectedPatch: patchBytes,
    expectedPatchHash: patchBytes.length ? sha256(patchBytes) : null,
  };
}

function digestTarget(snapshot) {
  return {
    head: snapshot.head,
    branch: snapshot.branch,
    status: snapshot.status,
    sourceHashes: snapshot.sourceHashes,
    expectedPatchHash: snapshot.expectedPatchHash,
    trackedDiffHash: sha256(snapshot.trackedDiff),
  };
}

function saveCandidateEvidence(workspace, taskId) {
  const snapshot = captureTarget(workspace);
  const evidenceName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(taskId || 'no-task').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const diffPath = path.join(RUNNER_DIR, `${evidenceName}.diff`);
  const patchPath = path.join(RUNNER_DIR, `${evidenceName}.patch`);
  fs.writeFileSync(diffPath, snapshot.trackedDiff, { mode: 0o600, flag: 'wx' });
  if (snapshot.expectedPatch.length) fs.writeFileSync(patchPath, snapshot.expectedPatch, { mode: 0o600, flag: 'wx' });
  return {
    source: digestTarget(snapshot),
    diffPath,
    diffSha256: sha256(snapshot.trackedDiff),
    patchPath: snapshot.expectedPatch.length ? patchPath : null,
    patchSha256: snapshot.expectedPatchHash,
  };
}

function readSnapshot(stateFile, projectId, runId, objectiveId) {
  const Database = require('better-sqlite3');
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare('SELECT status,result_json FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(projectId, runId);
    const objectiveRow = objectiveId ? db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, objectiveId) : null;
    const objective = objectiveRow ? JSON.parse(objectiveRow.record_json) : null;
    const tasks = objectiveId ? db.prepare('SELECT task_id,state FROM backlog_tasks WHERE project_id=? AND objective_id=? ORDER BY task_id').all(projectId, objectiveId) : [];
    const finalRow = objectiveId ? db.prepare('SELECT state,record_json FROM backlog_finalizations WHERE project_id=? AND objective_id=? ORDER BY rowid DESC LIMIT 1').get(projectId, objectiveId) : null;
    const finalRecord = finalRow ? JSON.parse(finalRow.record_json) : null;
    const finalizationProofs = objectiveId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='concurrent_finalization_check_proofs'").get()
      ? db.prepare(`SELECT finalization_id,check_attempt_id,pins_json,result_json,result_digest
          FROM concurrent_finalization_check_proofs WHERE project_id=? AND objective_id=? ORDER BY created_at`).all(projectId, objectiveId)
        .map((row) => ({ finalizationId: row.finalization_id, checkAttemptId: row.check_attempt_id,
          pins: JSON.parse(row.pins_json), result: JSON.parse(row.result_json), resultDigest: row.result_digest }))
      : [];
    const roles = objectiveId ? db.prepare('SELECT role_id,task_id,state,record_json FROM delivery_role_executions WHERE project_id=? AND objective_id=? ORDER BY created_at,rowid').all(projectId, objectiveId) : [];
    const proofs = objectiveId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='concurrent_verifier_check_proofs'").get()
      ? db.prepare('SELECT proof_json FROM concurrent_verifier_check_proofs WHERE project_id=? AND objective_id=? ORDER BY created_at').all(projectId, objectiveId)
      : [];
    const usage = db.prepare('SELECT kind,role,model,effort,tokens_json,token_source,turns,outcome,elapsed_ms FROM usage_ledger ORDER BY recorded_at,rowid').all()
      .map((row) => ({ ...row, tokens: row.tokens_json ? JSON.parse(row.tokens_json) : null, tokens_json: undefined }));
    const phase = db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(projectId);
    const plannerFacts = db.prepare('SELECT start_json,terminal_json FROM concurrent_planner_execution_facts WHERE project_id=? ORDER BY rowid').all(projectId)
      .map((row) => ({ start: row.start_json ? JSON.parse(row.start_json) : null, terminal: row.terminal_json ? JSON.parse(row.terminal_json) : null }));
    const runResult = run?.result_json ? JSON.parse(run.result_json) : null;
    return {
      run: run ? { status: run.status, result: runResult } : null,
      objective: objective ? { objectiveId: objective.objectiveId, disposition: objective.disposition } : null,
      tasks,
      finalization: finalRow ? { state: finalRow.state, record: finalRecord } : null,
      finalizationProofs,
      roleExecutions: roles.map((row) => {
        const rec = JSON.parse(row.record_json);
        const u = rec.usage || {};
        return { role: row.role_id || rec.roleId || null, taskId: row.task_id, state: row.state,
          externalStateName: TaskState[rec.externalState] || null, failureCode: rec.failureCode || null,
          model: u.model || null, effort: u.effort || null, turns: u.turns ?? null, tokens: u.tokens ?? null,
          outcome: rec.report?.outcome || null, effectsSettled: rec.effectsSettled === true };
      }),
      proofs: proofs.map((row) => JSON.parse(row.proof_json)),
      usage,
      shutdownPhase: phase ? JSON.parse(phase.phase_json) : null,
      plannerFacts,
    };
  } finally {
    db.close();
  }
}

async function backupStateDatabase(stateFile, taskId) {
  if (!fs.existsSync(stateFile)) return null;
  const safeTaskId = String(taskId || 'unknown-task').replace(/[^A-Za-z0-9_-]/g, '_');
  const destination = path.join(RUNNER_DIR, `${safeTaskId}.state.sqlite`);
  if (fs.existsSync(destination)) throw new Error('task_state_backup_already_exists');
  const Database = require('better-sqlite3');
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  fs.chmodSync(destination, 0o600);
  return { path: destination, sha256: sha256(fs.readFileSync(destination)), bytes: fs.statSync(destination).size };
}

function writeTaskEvidence(output) {
  const taskId = output.a2a?.id || 'unknown-task';
  const safeTaskId = String(taskId).replace(/[^A-Za-z0-9_-]/g, '_');
  const destination = path.join(RUNNER_DIR, `${safeTaskId}.evidence.json`);
  const evidence = {
    schemaVersion: 1,
    taskId,
    status: output.status,
    inputSha256: output.inputSha256,
    acceptance: output.acceptance,
    roleOverrides: output.roleOverrides,
    sourceBefore: output.sourceBefore,
    sourceAfter: output.sourceAfter || null,
    startup: output.startup ? { projectId: output.startup.projectId || null,
      deliveryEngine: output.startup.deliveryEngine || null, roles: output.startup.roles || [] } : null,
    a2a: output.a2a ? { id: output.a2a.id || null, state: output.a2a.state ?? null,
      stateName: output.a2a.stateName || null } : null,
    mapping: output.mapping || null,
    candidateEvidence: output.candidateEvidence || null,
    snapshotBeforeClose: output.snapshotBeforeClose || null,
    snapshotAfterClose: output.snapshotAfterClose || null,
    unsafeCloseSnapshot: output.unsafeCloseSnapshot || null,
    providerExecutions: output.providerExecutions || [],
    stateBackup: output.stateBackup || null,
    stateBackupError: output.stateBackupError || null,
    close: output.close || null,
    retainedRunRoot: output.retainedRunRoot || null,
    ownedLandoServicesBefore: output.ownedLandoServicesBefore || [],
    ownedLandoServicesDuringRun: output.ownedLandoServicesDuringRun || [],
    ownedLandoServicesAfter: output.ownedLandoServicesAfter || [],
    ownedLandoServicesFinal: output.ownedLandoServicesFinal || [],
    error: output.error || null,
    closeError: output.closeError || null,
  };
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
  fs.writeFileSync(destination, encoded, { mode: 0o600, flag: 'wx' });
  JSON.parse(fs.readFileSync(destination, 'utf8'));
  return destination;
}

function privateLandoServices() {
  try {
    const output = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 5000 });
    return output.split(/\r?\n/).filter((name) => /^dccourts182check/.test(name));
  } catch (_) {
    return [];
  }
}

function settledVerifierFailure(stateFile, projectId, objectiveId) {
  if (!objectiveId) return null;
  const Database = require('better-sqlite3');
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT role_id,task_id,state,record_json FROM delivery_role_executions
      WHERE project_id=? AND objective_id=? ORDER BY created_at DESC,rowid DESC`).all(projectId, objectiveId);
    let failure = null;
    for (const row of rows) {
      const record = JSON.parse(row.record_json);
      if ((row.role_id !== 'verifier' && record.roleId !== 'verifier') || !['terminal', 'settled'].includes(record.state)
        || record.effectsSettled !== true || record.externalState !== TaskState.TASK_STATE_FAILED) continue;
      failure = { taskId: row.task_id, attemptState: row.state, failureCode: record.failureCode || null,
        externalState: TaskState[record.externalState] || record.externalState,
        model: record.usage?.model || null, effort: record.usage?.effort || null,
        turns: record.usage?.turns ?? null, tokens: record.usage?.tokens ?? null };
      break;
    }
    if (!failure) return null;
    const recoveryStates = new Set(['queued', 'ready', 'claimed', 'running', 'settling']);
    const taskRows = db.prepare(`SELECT task_id,state,role,contract_json FROM backlog_tasks
      WHERE project_id=? AND objective_id=? ORDER BY task_id`).all(projectId, objectiveId);
    const recoveryTasks = taskRows.filter((row) => {
      if (!recoveryStates.has(row.state)) return false;
      const contract = JSON.parse(row.contract_json);
      return row.role === 'engineer' || contract.kind === 'implementation'
        || (row.role === 'verifier' && contract.kind === 'review');
    }).map((row) => ({ taskId: row.task_id, role: row.role, kind: JSON.parse(row.contract_json).kind, state: row.state }));
    const hasPlannerLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get();
    const activePlannerTurns = hasPlannerLedger
      ? db.prepare("SELECT turn_id,status FROM delivery_planner_turns WHERE project_id=? AND status IN ('active','unknown') ORDER BY started_at,turn_id").all(projectId)
      : [{ status: 'ledger_unavailable' }];
    return { ...failure, fingerprint: sha256(JSON.stringify(failure)), quiet: recoveryTasks.length === 0 && activePlannerTurns.length === 0,
      recoveryTasks, activePlannerTurns };
  } finally {
    db.close();
  }
}

async function runPreflight(input) {
  const target = input.workspace;
  const baseline = input.trialBaselineCommit;
  if (!target || !path.isAbsolute(target) || !baseline || !input.roleOverrides || !input.acceptance) throw new Error('task_input_contract_invalid');
  const before = captureTarget(target);
  const allowedBranch = 'test/harness-DCCOURTS-182-20261104';
  if (before.head !== baseline || before.branch !== allowedBranch || before.status !== '') throw new Error('target_not_clean_trial_baseline');
  const validationHash = before.sourceHashes['scripts/harness/validate-dccourts-182.sh'];
  if (validationHash !== input.validationScriptSha256) throw new Error('validator_baseline_hash_mismatch');
  if (!fs.existsSync(path.join(SOURCE_CODEX_HOME, 'auth.json'))) throw new Error('native_auth_unavailable');
  const configSha256 = validateTomlConfig(target);
  return {
    status: 'preflight_ready',
    inputSha256: sha256(fs.readFileSync(INPUT_FILE)),
    target: digestTarget(before),
    baselineCommit: baseline,
    roleOverrides: input.roleOverrides,
    acceptance: input.acceptance,
    bounds: input.bounds,
    isolatedConfigSha256: configSha256,
    authAvailable: true,
    runtime: { sdk: '@a2a-js/sdk', providerPath: 'real CodexAppServer', mode: 'preflight_only' },
  };
}

function timeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('objective_timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

async function runNative(input) {
  const workspace = input.workspace;
  const before = captureTarget(workspace);
  if (before.head !== input.trialBaselineCommit || before.branch !== 'test/harness-DCCOURTS-182-20261104' || before.status !== '') {
    throw new Error('target_not_clean_trial_baseline');
  }
  const baselineHash = before.sourceHashes['scripts/harness/validate-dccourts-182.sh'];
  if (baselineHash !== input.validationScriptSha256) throw new Error('validator_baseline_hash_mismatch');
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dccourts182-native-'));
  mkdirPrivate(runRoot);
  const codexHome = path.join(runRoot, 'codex-home');
  const accountsDir = path.join(runRoot, 'accounts');
  const stateFile = path.join(runRoot, 'state.sqlite');
  const storage = path.join(runRoot, 'delivery-storage');
  const locks = path.join(runRoot, 'workspace-locks');
  const tokenFile = path.join(runRoot, 'token');
  const projectSettings = path.join(runRoot, 'project-settings.json');
  const roleOverrides = path.join(runRoot, 'role-overrides.json');
  for (const dir of [codexHome, accountsDir, storage, locks]) mkdirPrivate(dir);
  copyPrivate(path.join(SOURCE_CODEX_HOME, 'auth.json'), path.join(codexHome, 'auth.json'));
  const configText = codexConfig(workspace);
  validateTomlConfig(workspace);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), configText, { mode: 0o600 });
  fs.writeFileSync(projectSettings, JSON.stringify({ version: 1, executionPermissions: 'full-access', deliveryEngine: 'concurrent-v1' }), { mode: 0o600 });
  fs.writeFileSync(roleOverrides, JSON.stringify({ version: 1, roles: input.roleOverrides }), { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_A2A_ACCOUNTS_DIR = accountsDir;
  process.env.CODEX_A2A_TURN_TIMEOUT_MS = String(input.bounds.turnTimeoutMs);
  process.env.CODEX_A2A_AUTO_RESUME = 'false';
  delete process.env.OPENAI_API_KEY;

  let runtime = null;
  let closeError = null;
  let startupAttempted = false;
  let preserveRunRoot = false;
  const output = {
    status: 'started', inputSha256: sha256(fs.readFileSync(INPUT_FILE)),
    sourceBefore: digestTarget(before), runRoot,
    roleOverrides: input.roleOverrides, acceptance: input.acceptance,
    ownedLandoServicesBefore: privateLandoServices(),
  };
  try {
    const { startServer } = require(path.join(HARNESS_ROOT, 'src/server'));
    const { CodexAppServer } = require(path.join(HARNESS_ROOT, 'src/codex-app-server'));
    const appServerFactory = (home) => {
      const appServer = new CodexAppServer({ codexHome: home });
      const genuineRun = appServer.run.bind(appServer);
      appServer.run = async (request) => {
        const record = { role: request.role?.id || request.role?.name || null,
          configuredModel: request.role?.model || null, configuredEffort: request.role?.effort || null };
        const capture = (result, outcome) => {
          record.outcome = outcome;
          record.status = result?.status || null;
          record.threadId = result?.threadId || result?.execution?.threadId || null;
          record.turnId = result?.turnId || result?.execution?.turnId || null;
          record.usage = result?.usage ? {
            model: result.usage.model || null, effort: result.usage.effort || null,
            fastMode: result.usage.fastMode || null, elapsedMs: result.usage.elapsedMs ?? null,
            turns: result.usage.turns ?? null, tokens: result.usage.tokens || null,
            tokenSource: result.usage.tokenSource || null,
          } : null;
          record.failureClass = result?.failureClass || null;
          record.execution = result?.execution ? {
            generation: result.execution.generation ?? null,
            processIdentity: result.execution.processIdentity || null,
            turnStartSent: result.execution.turnStartSent ?? null,
            turnStartRejected: result.execution.turnStartRejected ?? null,
            turnTerminal: result.execution.turnTerminal ?? null,
          } : null;
          output.providerExecutions.push(record);
        };
        try {
          const result = await genuineRun(request);
          capture(result, result?.status || 'completed');
          return result;
        } catch (error) {
          capture(error, 'failed');
          throw error;
        }
      };
      return appServer;
    };
    output.providerExecutions = [];
    startupAttempted = true;
    runtime = await startServer({ port: 0, workspace, stateFile, tokenFile, workspaceLockDir: locks,
      deliveryStorageRoot: storage, projectSettingsFile: projectSettings, roleOverridesFile: roleOverrides,
      accountsDir, appServerFactory, autoResume: false });
    if (runtime.host !== '127.0.0.1' || runtime.deliveryEngine !== 'concurrent-v1') throw new Error('runtime_isolation_check_failed');
    output.startup = { host: runtime.host, port: runtime.port, projectId: runtime.projectId,
      deliveryEngine: runtime.deliveryEngine, writerIsolation: runtime.writerIsolation,
      roles: [...runtime.roles.values()].map((role) => ({ id: role.id, model: role.model, effort: role.effort })) };
    const origin = `http://${runtime.host}:${runtime.port}`;
    const card = await fetch(`${origin}/orchestrator/agent-card.json`);
    if (!card.ok) throw new Error('agent_card_unavailable');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
    let task = await timeout(client.sendMessage({ tenant: '', message: {
      messageId: `dccourts-182-${Date.now()}`, contextId: '', taskId: '', role: 1,
      parts: [{ content: { $case: 'text', value: input.goal }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      metadata: { acceptance: input.acceptance }, extensions: [], referenceTaskIds: [],
    }, configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true } },
    { serviceParameters: { Authorization: `Bearer ${token}` } }), input.bounds.objectiveTimeoutMs, 'sendMessage');
    task = task?.task || task;
    output.a2a = { id: task?.id || null, state: task?.status?.state ?? null,
      stateName: TaskState[task?.status?.state] || null };
    if (!task?.id) throw new Error('a2a_task_id_missing');
    const active = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING];
    const deadline = Date.now() + input.bounds.objectiveTimeoutMs;
    let objectiveId = null;
    let verifierFailure = null;
    let stableVerifierFailureSince = null;
    let stableVerifierFailureFingerprint = null;
    const verifierQuietWindowMs = 30_000;
    while (active.includes(task.status?.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      task = await client.getTask({ tenant: '', id: task.id }, { serviceParameters: { Authorization: `Bearer ${token}` } });
      task = task?.task || task;
      const currentMapping = runtime.orchestrator.mapping(task.id);
      objectiveId = currentMapping?.objectiveId || runtime.concurrentEngine.activeRuns().find((run) => run.runId === task.id)?.objectiveId || objectiveId;
      if (active.includes(task.status?.state) && objectiveId) {
        verifierFailure = settledVerifierFailure(stateFile, runtime.projectId, objectiveId);
        if (verifierFailure?.quiet) {
          if (stableVerifierFailureFingerprint !== verifierFailure.fingerprint) {
            stableVerifierFailureFingerprint = verifierFailure.fingerprint;
            stableVerifierFailureSince = Date.now();
          }
          verifierFailure.stableForMs = Date.now() - stableVerifierFailureSince;
          if (verifierFailure.stableForMs >= verifierQuietWindowMs) {
            output.stableVerifierFailure = verifierFailure;
            output.verifierFailFastQuietWindowMs = verifierQuietWindowMs;
            const canceled = await client.cancelTask({ tenant: '', id: task.id }, { serviceParameters: { Authorization: `Bearer ${token}` } });
            task = canceled?.task || canceled;
            output.failFastCancelState = TaskState[task.status?.state] || task.status?.state || null;
            break;
          }
        } else {
          stableVerifierFailureFingerprint = null;
          stableVerifierFailureSince = null;
        }
      }
    }
    if (active.includes(task.status?.state)) {
      output.timeout = true;
      const canceled = await client.cancelTask({ tenant: '', id: task.id }, { serviceParameters: { Authorization: `Bearer ${token}` } });
      task = canceled?.task || canceled;
    }
    const mapping = runtime.orchestrator.mapping(task.id);
    objectiveId = mapping?.objectiveId || runtime.concurrentEngine.activeRuns().find((run) => run.runId === task.id)?.objectiveId || objectiveId;
    output.a2a = { id: task.id, state: task.status?.state ?? null, stateName: TaskState[task.status?.state] || null,
      finalMessage: task.status?.message?.parts?.map((part) => part.text || part.content?.value).filter(Boolean).join('\n') || null };
    output.mapping = { engine: mapping?.engine || null, objectiveId };
    output.snapshotBeforeClose = readSnapshot(stateFile, runtime.projectId, task.id, objectiveId);
    output.ownedLandoServicesDuringRun = privateLandoServices();
    await runtime.close();
    runtime = null;
    output.close = 'completed';
    output.snapshotAfterClose = readSnapshot(stateFile, output.startup.projectId, task.id, objectiveId);
    output.candidateEvidence = saveCandidateEvidence(workspace, task.id);
    output.sourceAfter = output.candidateEvidence.source;
    output.ownedLandoServicesAfter = privateLandoServices();
    const objective = output.snapshotAfterClose?.objective;
    const finalization = output.snapshotAfterClose?.finalization;
    const checkProofs = output.snapshotAfterClose?.proofs || [];
    output.status = task.status?.state === TaskState.TASK_STATE_COMPLETED && objective?.disposition === 'accepted'
      && finalization?.state === 'accepted' && checkProofs.length > 0 ? 'completed' : 'incomplete';
  } catch (error) {
    output.status = 'failed';
    output.error = { name: error?.name || 'Error', code: error?.code || null,
      message: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 300) };
  } finally {
    if (!output.candidateEvidence) {
      try {
        output.candidateEvidence = saveCandidateEvidence(workspace, output.a2a?.id || null);
        output.sourceAfter = output.candidateEvidence.source;
      } catch (error) {
        output.evidenceCaptureError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200);
      }
    }
    if (runtime) {
      try { await runtime.close(); runtime = null; output.close = 'completed'; }
      catch (error) {
        closeError = error;
        output.close = 'unsafe_or_failed';
        output.closeError = { code: error?.code || null, name: error?.name || 'Error' };
        output.retainedRunRoot = runRoot;
        try {
          const snapshot = readSnapshot(stateFile, runtime.projectId, output.a2a?.id, output.mapping?.objectiveId);
          output.unsafeCloseSnapshot = snapshot;
          output.ownedProcessIdentities = snapshot.shutdownPhase?.identities || [];
        } catch (_) {}
      }
    }
    if (startupAttempted && !runtime && output.close !== 'completed' && !closeError) {
      output.retainedRunRoot = runRoot;
      output.close = 'unknown_after_startup_failure';
    }
    try {
      output.stateBackup = await backupStateDatabase(stateFile, output.a2a?.id);
    } catch (error) {
      output.stateBackupError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200);
    }
    preserveRunRoot = Boolean(closeError || output.status !== 'completed' || output.stateBackupError
      || output.close !== 'completed');
    if (preserveRunRoot) output.retainedRunRoot = runRoot;
    if (!closeError && output.close === 'completed') {
      try { fs.rmSync(path.join(codexHome, 'auth.json'), { force: true }); } catch (_) {}
      try { fs.rmSync(tokenFile, { force: true }); } catch (_) {}
    }
    try {
      output.taskEvidencePath = writeTaskEvidence(output);
    } catch (error) {
      output.taskEvidenceError = String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 200);
      preserveRunRoot = true;
      output.retainedRunRoot = runRoot;
    }
    output.ownedLandoServicesFinal = privateLandoServices();
  }
  const resultPath = path.join(RUNNER_DIR, 'native-run-result.json');
  fs.writeFileSync(resultPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const summary = { status: output.status, resultPath, taskId: output.a2a?.id || null,
    taskState: output.a2a?.stateName || null, close: output.close || null };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (output.status !== 'completed' || closeError) process.exitCode = 1;
  if (!preserveRunRoot && output.close === 'completed') {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); }
    catch (_) { output.runRootCleanup = 'failed'; output.retainedRunRoot = runRoot; process.exitCode = 1; }
    if (output.runRootCleanup) fs.writeFileSync(resultPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--preflight' && mode !== '--run') throw new Error('usage: node runner/run-dccourts-182.js --preflight|--run');
  const raw = fs.readFileSync(INPUT_FILE);
  const input = JSON.parse(raw.toString('utf8'));
  if (input.issue !== 'DCCOURTS-182') throw new Error('wrong_task_input');
  if (mode === '--preflight') {
    const result = await runPreflight(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  await runNative(input);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: error?.code || null, message: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 300) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { RUNNER_DIR, HARNESS_ROOT, INPUT_FILE, SAFE_SOURCE_FILES, sha256, fileHash, mkdirPrivate,
  copyPrivate, git, captureTarget, digestTarget, readSnapshot, privateLandoServices, codexConfig, validateTomlConfig };
