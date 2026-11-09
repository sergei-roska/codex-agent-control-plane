'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { Database } = require('better-sqlite3');

const WORKER_DIR = __dirname;
const REPO_ROOT = path.resolve(WORKER_DIR, '../../../../');
const FIXTURE_DIR = path.join(WORKER_DIR, 'fixture');
const SOURCE_CODEX_HOME = path.join(os.homedir(), '.codex');
const TURN_TIMEOUT_MS = 180_000;
const OBJECTIVE_TIMEOUT_MS = 420_000;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeCopy(source, destination, mode) {
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(input).isFile()) throw new Error('source is not a regular file');
    const content = fs.readFileSync(input);
    fs.writeFileSync(destination, content, { mode });
  } finally {
    fs.closeSync(input);
  }
}

function timeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function readDurableSnapshot(stateFile, projectId, runId) {
  const db = new (require('better-sqlite3'))(stateFile, { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare('SELECT status,result_json FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(projectId, runId);
    const runResult = run?.result_json ? JSON.parse(run.result_json) : null;
    const objectiveRow = db.prepare('SELECT objective_id,record_json FROM backlog_objectives WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId);
    const objective = objectiveRow ? { objectiveId: objectiveRow.objective_id, ...JSON.parse(objectiveRow.record_json) } : null;
    const objectiveTasks = objective
      ? db.prepare('SELECT task_id,state FROM backlog_tasks WHERE project_id=? AND objective_id=? ORDER BY task_id').all(projectId, objective.objectiveId)
      : [];
    const finalizationRow = db.prepare('SELECT state,record_json FROM backlog_finalizations WHERE project_id=? AND objective_id=? ORDER BY rowid DESC LIMIT 1')
      .get(projectId, objective?.objectiveId || '');
    const finalization = finalizationRow ? { state: finalizationRow.state, ...JSON.parse(finalizationRow.record_json) } : null;
    const phase = db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(projectId);
    const usage = db.prepare(`SELECT kind,role,model,effort,tokens_json,outcome,elapsed_ms FROM usage_ledger ORDER BY recorded_at,rowid`).all()
      .map((row) => ({ ...row, tokens: row.tokens_json ? JSON.parse(row.tokens_json) : null, tokens_json: undefined }));
    const legacyCandidate = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='candidates'").get()?.sql || null;
    const concurrentCandidates = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='concurrent_candidates'").get()?.sql || null;
    return {
      run: run ? { status: run.status, disposition: runResult?.disposition || null, candidateId: runResult?.candidateId || null,
        assignmentCount: runResult?.assignments?.length || 0, acceptanceDisposition: runResult?.acceptance?.disposition || null } : null,
      objective: objective ? { objectiveId: objective.objectiveId, disposition: objective.disposition } : null,
      tasks: objectiveTasks,
      finalization: finalization ? { state: finalization.state,
        disposition: finalization.checkResult?.disposition || null,
        checks: finalization.checkResult?.checks || [] } : null,
      shutdownPhase: phase ? JSON.parse(phase.phase_json).phase : null,
      usage,
      candidateTables: { legacyExists: Boolean(legacyCandidate),
        legacyColumns: legacyCandidate ? db.prepare('PRAGMA table_info(candidates)').all().map((row) => row.name) : [],
        legacyRowCount: legacyCandidate ? db.prepare('SELECT COUNT(*) AS count FROM candidates').get().count : 0,
        legacyRowPreserved: legacyCandidate ? db.prepare("SELECT COUNT(*) AS count FROM candidates WHERE candidate_id='legacy-candidate'").get().count === 1 : false,
        concurrentExists: Boolean(concurrentCandidates),
        concurrentRowCount: concurrentCandidates ? db.prepare('SELECT COUNT(*) AS count FROM concurrent_candidates').get().count : 0 },
    };
  } finally {
    db.close();
  }
}

function readSettledVerifierFailure(stateFile, projectId, objectiveId) {
  const db = new (require('better-sqlite3'))(stateFile, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`SELECT role_id,task_id,state,record_json FROM delivery_role_executions
      WHERE project_id=? AND objective_id=? ORDER BY created_at DESC,attempt_id DESC`).all(projectId, objectiveId);
    for (const row of rows) {
      const record = JSON.parse(row.record_json);
      if ((row.role_id !== 'verifier' && record.roleId !== 'verifier') || record.state !== 'terminal'
        || record.effectsSettled !== true || record.externalState !== TaskState.TASK_STATE_FAILED) continue;
      const usage = record.usage || {};
      return {
        taskId: row.task_id,
        attemptState: row.state,
        externalState: TaskState[record.externalState] || record.externalState,
        failureCode: record.failureCode || null,
        reportError: record.reportError || null,
        reportOutcome: record.report?.outcome || null,
        usage: {
          model: usage.model || null,
          effort: usage.effort || null,
          turns: Number.isFinite(usage.turns) ? usage.turns : null,
          tokens: Number.isFinite(usage.tokens) ? usage.tokens : null,
          tokenSource: usage.tokenSource || null,
          elapsedMs: Number.isFinite(usage.elapsedMs) ? usage.elapsedMs : null,
        },
      };
    }
    return null;
  } finally {
    db.close();
  }
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

async function main() {
  if (!fs.existsSync(path.join(SOURCE_CODEX_HOME, 'auth.json'))) throw new Error('native_auth_unavailable');
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-concurrent-native-'));
  mkdirPrivate(runRoot);
  const isolatedHome = path.join(runRoot, 'codex-home');
  const accountsDir = path.join(runRoot, 'accounts');
  const workspace = path.join(runRoot, 'workspace');
  const stateFile = path.join(runRoot, 'state.sqlite');
  const deliveryStorageRoot = path.join(runRoot, 'delivery-storage');
  const tokenFile = path.join(runRoot, 'local-token');
  const workspaceLockDir = path.join(runRoot, 'workspace-locks');
  const settingsFile = path.join(runRoot, 'project-settings.json');
const roleOverridesFile = path.join(runRoot, 'role-overrides.json');
  let runtime = null;
  let output = {
    status: 'started',
    sourceContext: {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      hashes: Object.fromEntries(['src/codex-app-server.js', 'src/delivery-role-capabilities.js',
        'test/delivery-verifier-integration.test.js', '.agents/teamwork/isolated-concurrent-smoke-20261104/worker/native-smoke.js']
        .map((file) => [file, sha256(path.join(REPO_ROOT, file))])),
    },
    priorRunArchives: ['pre-repair/', 'after-context-fix/'],
    budgets: { turnTimeoutMs: TURN_TIMEOUT_MS, objectiveTimeoutMs: OBJECTIVE_TIMEOUT_MS },
  };

  try {
    mkdirPrivate(isolatedHome);
    mkdirPrivate(accountsDir);
    mkdirPrivate(workspace);
    mkdirPrivate(deliveryStorageRoot);
    mkdirPrivate(workspaceLockDir);
    safeCopy(path.join(SOURCE_CODEX_HOME, 'auth.json'), path.join(isolatedHome, 'auth.json'), 0o600);
    const seedDb = new (require('better-sqlite3'))(stateFile);
    seedDb.exec(`CREATE TABLE candidates (
      candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, plan_revision_id TEXT NOT NULL,
      base_commit TEXT NOT NULL, head TEXT NOT NULL, branch TEXT NOT NULL, head_moved INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, diff_artifact_id TEXT, truncated INTEGER NOT NULL,
      acceptance_json TEXT, integrity_hash TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    seedDb.prepare(`INSERT INTO candidates(candidate_id,run_id,plan_revision_id,base_commit,head,branch,
      head_moved,manifest_json,diff_artifact_id,truncated,acceptance_json,integrity_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-candidate', 'legacy-run', 'legacy-plan', 'base', 'head',
      'legacy-branch', 0, '{}', null, 0, null, 'legacy-integrity', 'legacy-created');
    seedDb.close();
    output.candidateSchemaSeed = { legacyRowSeeded: true, source: 'matching existing server-delivery-engine fixture' };
    output.nativeConfig = {
      authCopiedPrivately: true,
      configCopiedPrivately: false,
      isolatedWorkspaceTrusted: true,
      roleOverrides: { coordinator: { model: 'gpt-6-luna', effort: 'low' },
        engineer: { model: 'gpt-6-luna', effort: 'low' }, verifier: { model: 'gpt-6-luna', effort: 'high' } },
      projectPermissions: 'full-access',
    };

    fs.writeFileSync(path.join(workspace, 'verify-output.js'), [
      "'use strict';",
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "assert.equal(fs.readFileSync('output.txt', 'utf8'), 'concurrent-smoke-ok\\n');",
      "process.stdout.write('PASS exact synthetic output\\n');",
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Isolated Smoke'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'isolated-smoke@example.invalid'], { cwd: workspace });
    execFileSync('git', ['add', 'verify-output.js'], { cwd: workspace });
    execFileSync('git', ['commit', '-qm', 'Seed independent acceptance check'], { cwd: workspace });
    fs.writeFileSync(path.join(isolatedHome, 'config.toml'),
      `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
    fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'full-access', deliveryEngine: 'concurrent-v1' }), { mode: 0o600 });
    fs.writeFileSync(roleOverridesFile, JSON.stringify({ version: 1, roles: output.nativeConfig.roleOverrides }), { mode: 0o600 });

    process.env.CODEX_HOME = isolatedHome;
    process.env.CODEX_A2A_ACCOUNTS_DIR = accountsDir;
    process.env.CODEX_A2A_TURN_TIMEOUT_MS = String(TURN_TIMEOUT_MS);
    process.env.CODEX_A2A_AUTO_RESUME = 'false';
    delete process.env.OPENAI_API_KEY;

    const { startServer } = require('../../../../src/server');
    const { CodexAppServer } = require('../../../../src/codex-app-server');
    const appServerFactory = (codexHome) => {
      const server = new CodexAppServer({ codexHome });
      const resolve = server.resolveExecutionPermissions.bind(server);
      server.resolveExecutionPermissions = async (...args) => {
        const result = await resolve(...args);
        output.nativePermissionResolution = { mode: result?.mode || null, sandboxMode: result?.sandboxMode || null,
          profileApi: result?.profileApi === true, writerProfile: result?.writerProfile || null,
          approvalPolicy: result?.approvalPolicy || null, reason: result?.reason || null };
        return result;
      };
      return server;
    };
    runtime = await startServer({
      port: 0,
      workspace,
      stateFile,
      tokenFile,
      workspaceLockDir,
      deliveryStorageRoot,
      projectSettingsFile: settingsFile,
      roleOverridesFile,
      accountsDir,
      appServerFactory,
      autoResume: false,
    });
    output.startup = {
      port: runtime.port,
      loopback: runtime.host === '127.0.0.1',
      engine: runtime.deliveryEngine,
      writerIsolation: runtime.writerIsolation,
      roleProfiles: [...runtime.roles.values()].map((role) => ({ id: role.id, model: role.model, effort: role.effort })),
    };
    if (!output.startup.loopback || runtime.deliveryEngine !== 'concurrent-v1') throw new Error('server_not_isolated_concurrent');
    const origin = `http://${runtime.host}:${runtime.port}`;
    const cardResponse = await fetch(`${origin}/orchestrator/agent-card.json`);
    output.startup.agentCardStatus = cardResponse.status;
    if (!cardResponse.ok) throw new Error('a2a_card_unavailable');

    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
    let taskResponse = await timeout(client.sendMessage({
      tenant: '',
      message: {
        messageId: 'isolated-native-concurrent-smoke',
        contextId: '', taskId: '', role: 1,
        parts: [{ content: { $case: 'text', value: 'Create output.txt containing exactly concurrent-smoke-ok followed by one newline. Use only this isolated workspace. Do not make external changes. Stop after the requested file is written and verified.' },
          mediaType: 'text/plain', filename: '', metadata: undefined }],
        metadata: { acceptance: { source: 'agent', requiredChecks: [{ id: 'verify-output', argv: ['node', 'verify-output.js'], timeoutMs: 5000 }] } },
        extensions: [], referenceTaskIds: [],
      },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
    }, { serviceParameters: { Authorization: `Bearer ${token}` } }), OBJECTIVE_TIMEOUT_MS, 'objective');
    taskResponse = taskResponse?.task || taskResponse;
    const activeTaskStates = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING];
    let pollDeadlineReached = false;
    let objectiveIdForPolling = null;
    let verifierFailureObserved = null;
    if (taskResponse?.id && activeTaskStates.includes(taskResponse.status?.state)) {
      const initialMapping = runtime.orchestrator.mapping(taskResponse.id);
      objectiveIdForPolling = initialMapping?.objectiveId
        || runtime.concurrentEngine.activeRuns().find((run) => run.runId === taskResponse.id)?.objectiveId
        || null;
      const deadline = Date.now() + OBJECTIVE_TIMEOUT_MS;
      while (activeTaskStates.includes(taskResponse.status?.state)
        && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        taskResponse = await client.getTask({ tenant: '', id: taskResponse.id }, { serviceParameters: { Authorization: `Bearer ${token}` } });
        taskResponse = taskResponse?.task || taskResponse;
        if (activeTaskStates.includes(taskResponse.status?.state) && objectiveIdForPolling) {
          verifierFailureObserved = readSettledVerifierFailure(stateFile, runtime.projectId, objectiveIdForPolling);
          if (verifierFailureObserved) {
            output.verifierFailure = verifierFailureObserved;
            output.taskAtVerifierFailure = { id: taskResponse.id, state: TaskState[taskResponse.status?.state] || taskResponse.status?.state };
            const canceled = await client.cancelTask({ tenant: '', id: taskResponse.id }, { serviceParameters: { Authorization: `Bearer ${token}` } });
            output.taskCancel = { responseState: canceled?.status?.state ?? null, reason: 'settled_verifier_failure' };
            taskResponse = canceled?.task || canceled;
            break;
          }
        }
      }
      pollDeadlineReached = activeTaskStates.includes(taskResponse.status?.state) && !verifierFailureObserved;
      if (pollDeadlineReached) {
        const canceled = await client.cancelTask({ tenant: '', id: taskResponse.id }, { serviceParameters: { Authorization: `Bearer ${token}` } });
        output.taskCancel = { responseState: canceled?.status?.state ?? null, reason: 'objective_poll_deadline' };
        taskResponse = canceled?.task || canceled;
      }
    }
    output.task = {
      id: taskResponse.id,
      state: taskResponse.status?.state || null,
      stateName: TaskState[taskResponse.status?.state] || null,
      pollDeadlineReached,
      finalMessage: taskResponse.status?.message?.parts?.map((part) => part.text || part.content?.value).filter(Boolean).join('\n') || null,
      artifactCount: taskResponse.artifacts?.length || 0,
      artifacts: (taskResponse.artifacts || []).map((artifact) => ({
        name: artifact.name || null,
        text: artifact.parts?.map((part) => part.text || part.content?.value).filter(Boolean).join('\n') || null,
      })),
    };
    if (!taskResponse.id) throw new Error('a2a_task_id_missing');
    const outputFile = path.join(workspace, 'output.txt');
    output.file = {
      exists: fs.existsSync(outputFile),
      sha256: fs.existsSync(outputFile) ? sha256(outputFile) : null,
      bytes: fs.existsSync(outputFile) ? fs.statSync(outputFile).size : null,
      verifierExitCode: null,
      verifierStdout: null,
    };
    if (output.file.exists) {
      const result = require('node:child_process').spawnSync(process.execPath, ['verify-output.js'], { cwd: workspace, encoding: 'utf8', timeout: 5000 });
      output.file.verifierExitCode = result.status;
      output.file.verifierStdout = result.stdout.trim();
    }

    const mapping = runtime.orchestrator.mapping(taskResponse.id);
    const objectiveId = mapping?.objectiveId || runtime.concurrentEngine.activeRuns().find((run) => run.runId === taskResponse.id)?.objectiveId;
    const objective = objectiveId ? runtime.concurrentEngine.store.getObjective(runtime.projectId, objectiveId) : null;
    const runDigest = runtime.concurrentEngine.getRunDigest(taskResponse.id);
    output.durableBeforeRestart = {
      projectId: runtime.projectId,
      runId: taskResponse.id,
      mappingEngine: mapping?.engine || null,
      objectiveId: objective?.objectiveId || objectiveId || null,
      disposition: objective?.disposition || null,
      digestDisposition: runDigest?.disposition || null,
      taskStates: objective?.tasks?.map((task) => ({ taskId: task.taskId, state: task.state })) || [],
    };

    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const file of ['verify-output.js', 'output.txt']) {
      if (fs.existsSync(path.join(workspace, file))) fs.copyFileSync(path.join(workspace, file), path.join(FIXTURE_DIR, file));
    }
    await runtime.close();
    runtime = null;
    output.afterFirstClose = readDurableSnapshot(stateFile, output.startup.projectId || output.durableBeforeRestart.projectId, taskResponse.id);

    runtime = await startServer({
      port: 0, workspace, stateFile, tokenFile, workspaceLockDir, deliveryStorageRoot,
      projectSettingsFile: settingsFile, roleOverridesFile, accountsDir, autoResume: false,
    });
    output.restart = { port: runtime.port, loopback: runtime.host === '127.0.0.1', engine: runtime.deliveryEngine };
    const reopenedMapping = runtime.orchestrator.mapping(taskResponse.id);
    const reopenedObjective = reopenedMapping?.objectiveId
      ? runtime.concurrentEngine.store.getObjective(runtime.projectId, reopenedMapping.objectiveId) : null;
    output.reopenDurability = {
      mappingEngine: reopenedMapping?.engine || null,
      disposition: reopenedObjective?.disposition || null,
      candidateId: runtime.concurrentEngine.getRunDigest(taskResponse.id)?.candidateId || null,
    };
    const reopenedCard = await fetch(`http://${runtime.host}:${runtime.port}/orchestrator/agent-card.json`);
    output.restart.agentCardStatus = reopenedCard.status;
    await runtime.close();
    runtime = null;
    output.afterSecondClose = readDurableSnapshot(stateFile, output.durableBeforeRestart.projectId, taskResponse.id);

    output.status = taskResponse.status?.state === TaskState.TASK_STATE_COMPLETED
      && output.file.verifierExitCode === 0
      && output.durableBeforeRestart.mappingEngine === 'concurrent-v1'
      && output.durableBeforeRestart.disposition === 'accepted'
      && output.reopenDurability.disposition === 'accepted'
      && output.afterSecondClose.shutdownPhase === 'released'
      ? 'accepted' : 'incomplete';
  } catch (error) {
    output.status = 'failed';
    output.error = { name: error?.name || 'Error', code: error?.code || null,
      message: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 300) };
  } finally {
    if (runtime) {
      try { await runtime.close(); output.cleanup = 'server_closed'; }
      catch (error) { output.cleanup = `close_failed:${error?.code || error?.name || 'error'}`; output.retainTempPath = runRoot; }
    }
    if (runtime === null && output.cleanup !== 'close_failed' && !String(output.cleanup || '').startsWith('close_failed:')) {
      if (fs.existsSync(path.join(isolatedHome, 'auth.json'))) fs.rmSync(path.join(isolatedHome, 'auth.json'), { force: true });
      if (fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: true });
    } else {
      output.retainTempPath = runRoot;
    }
  }

  fs.writeFileSync(path.join(WORKER_DIR, 'native-smoke-result.json'), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: output.status, port: output.startup?.port || output.restart?.port || null,
    disposition: output.durableBeforeRestart?.disposition || null, verifierExitCode: output.file?.verifierExitCode ?? null })}\n`);
  if (output.status !== 'accepted') process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'failed', error: { name: error?.name || 'Error', code: error?.code || null } })}\n`);
  process.exitCode = 1;
});
