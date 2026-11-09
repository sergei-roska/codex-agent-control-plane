'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');

const RUNNER_DIR = __dirname;
const REPO_ROOT = path.resolve(RUNNER_DIR, '../../../..');
const FIXTURE_DIR = path.join(RUNNER_DIR, 'fixture');
const AUTH_SOURCE = '/home/sr/codex-home/auth.json';
const TASK_TIMEOUT_MS = 900_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_TURNS = 20;
const MAX_TOKENS = 300_000;
const PRODUCT_FILES = ['format-label.js', 'sum-positive.js', 'report.js'];
const CHECK_FILE = 'verify-product.js';
const FROZEN_CONTROLS_SHA256 = '8d6f5952a6f6575751eee5471bcb89415e729702b867a440f6899457f5f01050';
const FROZEN_CONTROL_FILE = path.join(RUNNER_DIR, 'fixture-controls.json');
const SOURCE_INVENTORY_FILE = path.join(REPO_ROOT, '.agents/teamwork/closeout-20261105/qualification/source-manifest.json');
const ACTIVE_STATES = new Set([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]);

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function copyPrivate(source, destination) {
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('private_source_not_regular');
    fs.writeFileSync(destination, fs.readFileSync(fd), { mode: 0o600, flag: 'wx' });
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

function fixtureHashes(directory) {
  return Object.fromEntries([...PRODUCT_FILES, 'verify-product.js'].map((name) => [
    name, hash(fs.readFileSync(path.join(directory, name))),
  ]));
}

function frozenFixtureControls() {
  if (hash(fs.readFileSync(FROZEN_CONTROL_FILE)) !== FROZEN_CONTROLS_SHA256) throw new Error('frozen_control_file_changed');
  const controls = JSON.parse(fs.readFileSync(FROZEN_CONTROL_FILE, 'utf8'));
  const actual = fixtureHashes(FIXTURE_DIR);
  if (!fixtureControlsMatch(actual, controls)) throw new Error('fixture_controls_do_not_match');
  return controls;
}

function fixtureControlsMatch(actual, controls) {
  return JSON.stringify(actual) === JSON.stringify(controls?.productInputSha256)
    && controls?.immutableCheckSha256 === actual?.[CHECK_FILE]
    && controls?.initialNegativeControl?.exitCode !== 0
    && controls?.positiveControl?.exitCode === 0;
}

function captureSourceManifest() {
  const pinnedPaths = Object.keys(JSON.parse(fs.readFileSync(SOURCE_INVENTORY_FILE, 'utf8'))).sort();
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split(/\r?\n/));
  const missing = pinnedPaths.filter((file) => !tracked.has(file) || !fs.existsSync(path.join(REPO_ROOT, file)));
  if (missing.length) throw new Error(`source_manifest_paths_missing:${missing.length}`);
  return Object.fromEntries(pinnedPaths.map((file) => [file, hash(fs.readFileSync(path.join(REPO_ROOT, file)))]));
}

function sourceDrift(before, after) {
  const paths = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  return paths.filter((file) => before?.[file] !== after?.[file]);
}

function semanticInput(goal, acceptance) {
  return { goal, acceptance };
}

function normalizeEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function withinInterval(value, startedAt, completedAt) {
  const timestamp = normalizeEpochMs(value);
  const start = normalizeEpochMs(startedAt);
  const end = normalizeEpochMs(completedAt);
  return timestamp !== null && start !== null && end !== null && timestamp >= start && timestamp <= end;
}

function steeringTiming(receipt, turn) {
  const receivedAtMs = normalizeEpochMs(receipt?.receivedAt);
  const appliedAtMs = receipt?.state === 'applied' ? normalizeEpochMs(receipt?.updatedAt) : null;
  const startedAtMs = normalizeEpochMs(turn?.startedAt);
  const completedAtMs = normalizeEpochMs(turn?.completedAt);
  const timingKnown = receivedAtMs !== null && appliedAtMs !== null && startedAtMs !== null && completedAtMs !== null;
  const receivedWithinTurn = withinInterval(receivedAtMs, startedAtMs, completedAtMs);
  const appliedWithinTurn = withinInterval(appliedAtMs, startedAtMs, completedAtMs);
  return { timingKnown, receivedAtMs, appliedAtMs, startedAtMs, completedAtMs,
    receivedWithinTurn, appliedWithinTurn, steeringWithinWorkerTurn: timingKnown && receivedWithinTurn && appliedWithinTurn,
    workerActiveReceiptLatencyMs: receivedWithinTurn ? receivedAtMs - startedAtMs : null,
    workerActiveApplyLatencyMs: appliedWithinTurn ? appliedAtMs - startedAtMs : null };
}

function usageFacts(usage) {
  const source = usage?.tokens && typeof usage.tokens === 'object' ? usage.tokens : null;
  const totalTokens = source && Number.isFinite(source.totalTokens) && source.totalTokens >= 0
    ? source.totalTokens : null;
  return { usage: usage ?? null, totalTokens, complete: totalTokens !== null };
}

function recordUsage(evidence, call, usage, outcome) {
  const facts = usageFacts(usage);
  call.usage = facts.usage;
  call.usageOutcome = outcome;
  call.authoritativeTotalTokens = facts.totalTokens;
  const observer = evidence.observer;
  observer.knownTokenSubtotal += facts.totalTokens ?? 0;
  if (!facts.complete) observer.unknownUsageCalls += 1;
  observer.usageComplete = observer.unknownUsageCalls === 0;
  observer.observedTokenTotal = observer.usageComplete ? observer.knownTokenSubtotal : null;
  call.knownTokenSubtotalAfter = observer.knownTokenSubtotal;
  call.usageCompleteAfter = observer.usageComplete;
}

function canAdmitNativeTurn(observer) {
  return observer.turns.length + observer.pendingTurnReservations < MAX_TURNS
    && observer.knownTokenSubtotal < MAX_TOKENS && observer.unknownUsageCalls === 0;
}

function reserveNativeTurn(observer) {
  if (!canAdmitNativeTurn(observer)) return false;
  observer.pendingTurnReservations += 1;
  return true;
}

function releaseNativeTurnReservation(observer, call) {
  if (!call.turnReservationPending) return;
  observer.pendingTurnReservations -= 1;
  call.turnReservationPending = false;
}

async function preserveRunOutcome(originalRun, request, evidence, call) {
  try {
    const result = await originalRun(request);
    call.completedAt = new Date().toISOString();
    call.actualModel = result?.usage?.model || null;
    call.actualEffort = result?.usage?.effort || null;
    call.actualFastMode = result?.usage?.fastMode || null;
    call.status = result?.status || null;
    recordUsage(evidence, call, usageFromResult(result), 'returned');
    return result;
  } catch (error) {
    call.completedAt = new Date().toISOString();
    call.error = safeError(error);
    call.execution = error?.execution ?? null;
    call.terminalTurn = error?.terminalTurn ?? null;
    recordUsage(evidence, call, usageFromResult(error), 'thrown');
    throw error;
  }
}

function shouldRetainPrivateRoot({ startupAttempted, runtimeReturned, closeSafe, evidenceSafe }) {
  if (startupAttempted && !runtimeReturned) return true;
  return !(closeSafe && evidenceSafe);
}

async function startRuntimeSafely(startServer, options, state) {
  state.startupAttempted = true;
  try {
    const runtime = await startServer(options);
    state.runtimeReturned = true;
    return runtime;
  } catch (error) {
    state.startupError = safeError(error);
    state.retainRoot = true;
    throw error;
  }
}

async function closeWithEvidence({ runtime, evidence, captureBeforeClose, captureAfterClose }) {
  const capture = { beforeClose: null, beforeCloseError: null, close: null, closeError: null,
    afterClose: null, afterCloseError: null };
  try { capture.beforeClose = await captureBeforeClose(); }
  catch (error) { capture.beforeCloseError = safeError(error); }
  try {
    await runtime.close();
    capture.close = { status: 'closed', completedAt: new Date().toISOString() };
  } catch (error) { capture.closeError = safeError(error); }
  if (capture.close) {
    try { capture.afterClose = await captureAfterClose(); }
    catch (error) { capture.afterCloseError = safeError(error); }
  }
  evidence.closeLifecycle = capture;
  return { closeSafe: Boolean(capture.close), evidenceSafe: capture.beforeClose?.complete === true
    && capture.afterClose?.complete === true };
}

async function finalizationSequence({ evidence, awaitSteering, closeRuntime, captureSourceAfter, reduce }) {
  const order = [];
  const failures = [];
  for (const [name, step] of [['steering', awaitSteering], ['close', closeRuntime],
    ['source_after', captureSourceAfter]]) {
    try { await step(); }
    catch (error) { failures.push({ stage: name, error: safeError(error) }); }
    order.push(name);
  }
  evidence.finalizationOrder = order;
  evidence.finalizationFailures = failures;
  const outcome = await reduce();
  return { order, failures, outcome };
}

function finalizeCollector(evidence) {
  const engine = evidence.engine;
  const taskCompleted = evidence.finalTask?.state === TaskState.TASK_STATE_COMPLETED;
  const checkerPassed = evidence.productCheck?.exitCode === 0;
  const candidateId = evidence.finalization?.candidateId || null;
  const objectiveAccepted = engine === 'concurrent-v1'
    ? evidence.finalization?.disposition === 'accepted' && typeof candidateId === 'string'
      && candidateId.length > 0
    : taskCompleted && checkerPassed;
  evidence.objectiveAcceptance = { engine, accepted: objectiveAccepted,
    taskState: evidence.finalTask?.state ?? null,
    disposition: evidence.finalization?.disposition || null, candidateId,
    checkerExitCode: evidence.productCheck?.exitCode ?? null };
  const gates = {
    noRunnerError: !evidence.error,
    finalizationStepsSucceeded: evidence.finalizationFailures?.length === 0,
    completedTask: taskCompleted,
    immutableCheckPassed: checkerPassed,
    checkerUnchanged: evidence.checkUnchanged === true,
    productOnlyScope: evidence.productScope?.allowedOnly === true,
    objectiveAccepted,
    safeClose: evidence.close?.status === 'closed',
    preCloseBackup: Boolean(evidence.stateBackupBeforeClose),
    postCloseBackup: Boolean(evidence.stateBackupAfterClose),
    lifecycleEvidenceComplete: evidence.closeLifecycle?.beforeClose?.complete === true
      && evidence.closeLifecycle?.afterClose?.complete === true,
    sourceBeforeCaptured: Boolean(evidence.sourceManifestBefore),
    sourceAfterCaptured: Boolean(evidence.sourceManifestAfter && !evidence.sourceManifestAfterError),
    sourceNoDrift: Array.isArray(evidence.sourceDrift) && evidence.sourceDrift.length === 0,
    steeringAccepted: engine !== 'concurrent-v1' || evidence.steeringAccepted === true,
  };
  evidence.collectorGates = gates;
  evidence.trialAccepted = null;
  evidence.status = Object.values(gates).every(Boolean)
    ? 'objective_accepted_pending_independent_review' : 'incomplete';
  return evidence.status;
}

function productScope(workspace) {
  const lines = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: workspace, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const entries = lines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
  const allowed = new Set(PRODUCT_FILES);
  const violations = entries.filter((entry) => !allowed.has(entry.path));
  return { entries, changedPaths: entries.map((entry) => entry.path).sort(), violations,
    allowedOnly: violations.length === 0 };
}

function seedFixture(workspace) {
  for (const name of [...PRODUCT_FILES, 'verify-product.js']) {
    fs.copyFileSync(path.join(FIXTURE_DIR, name), path.join(workspace, name), fs.constants.COPYFILE_EXCL);
  }
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'CN-15 disposable fixture'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'cn15-fixture@example.invalid'], { cwd: workspace });
  execFileSync('git', ['add', ...PRODUCT_FILES, 'verify-product.js'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'Seed failing product fixture'], { cwd: workspace });
  const initial = spawnSync(process.execPath, ['verify-product.js'], { cwd: workspace, encoding: 'utf8', timeout: 5000 });
  if (initial.status === 0) throw new Error('negative_control_unexpectedly_passed');
  return {
    inputHashes: fixtureHashes(workspace),
    initialCheck: { exitCode: initial.status, signal: initial.signal || null,
      stdout: initial.stdout || '', stderr: initial.stderr || '' },
  };
}

function seedPositiveControl() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cn15-20261105-positive-'));
  mkdirPrivate(root);
  const correct = {
    'format-label.js': "'use strict';\nfunction formatLabel(value) { if (typeof value !== 'string') throw new TypeError('label must be a string'); return value.trim().toUpperCase(); }\nmodule.exports = { formatLabel };\n",
    'sum-positive.js': "'use strict';\nfunction sumPositive(values) { if (!Array.isArray(values)) throw new TypeError('values must be an array'); return values.reduce((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0), 0); }\nmodule.exports = { sumPositive };\n",
    'report.js': "'use strict';\nconst { formatLabel } = require('./format-label');\nconst { sumPositive } = require('./sum-positive');\nfunction report(label, values) { return { label: formatLabel(label), total: sumPositive(values) }; }\nmodule.exports = { report };\n",
  };
  for (const [name, source] of Object.entries(correct)) writePrivate(path.join(root, name), source);
  fs.copyFileSync(path.join(FIXTURE_DIR, 'verify-product.js'), path.join(root, 'verify-product.js'));
  const result = spawnSync(process.execPath, ['verify-product.js'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  const evidence = { exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '',
    solutionHashes: Object.fromEntries(Object.keys(correct).map((name) => [name, hash(fs.readFileSync(path.join(root, name)))])) };
  fs.rmSync(root, { recursive: true, force: true });
  if (result.status !== 0) throw new Error('positive_control_failed');
  return evidence;
}

function configToml(workspace) {
  return `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`;
}

function quotaUsage(limits) {
  const root = limits?.rateLimits || limits;
  const primary = root?.primary;
  const used = primary?.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return { primaryUsedPercent: used, primaryWindowDurationMins: primary.windowDurationMins ?? null,
    primaryResetsAt: primary.resetsAt ?? null };
}

function safeError(error) {
  return { name: error?.name || 'Error', code: error?.code || null,
    message: String(error?.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 300) };
}

function usageFromResult(result) {
  const candidates = [result?.usage, result?.tokens, result?.tokenUsage?.total, result?.cumulativeTotal];
  for (const value of candidates) if (value && typeof value === 'object') return value;
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const engine = args.find((value) => value === 'concurrent-v1' || value === 'legacy');
  const go = args.includes('--go');
  if (!engine) throw new Error('usage: node run-comparison.js concurrent-v1|legacy [--go]');
  if (!go) throw new Error('live_run_requires_explicit_--go');
  if (!fs.existsSync(AUTH_SOURCE)) throw new Error('configured_auth_file_unavailable');
  const controls = frozenFixtureControls();
  const sourceBefore = captureSourceManifest();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cn15-20261105-'));
  mkdirPrivate(root);
  const isolatedHome = path.join(root, 'codex-home');
  const accountsDir = path.join(root, 'accounts');
  const workspace = path.join(root, 'workspace');
  const stateFile = path.join(root, 'state.sqlite');
  const storage = path.join(root, 'delivery-storage');
  const tokenFile = path.join(root, 'local-token');
  const locks = path.join(root, 'workspace-locks');
  const settingsFile = path.join(root, 'project-settings.json');
  const roleFile = path.join(root, 'role-overrides.json');
  for (const dir of [isolatedHome, accountsDir, workspace, storage, locks]) mkdirPrivate(dir);
  const fixture = seedFixture(workspace);
  if (JSON.stringify(fixture.inputHashes) !== JSON.stringify(controls.productInputSha256)) throw new Error('seeded_fixture_hash_mismatch');
  const positiveControl = seedPositiveControl();
  copyPrivate(AUTH_SOURCE, path.join(isolatedHome, 'auth.json'));
  writePrivate(path.join(isolatedHome, 'config.toml'), configToml(workspace));
  writePrivate(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'full-access', deliveryEngine: engine }));
  const roleOverrides = Object.fromEntries(['coordinator', 'engineer', 'explorer', 'verifier'].map((role) => [role, {
    model: 'gpt-6-luna', effort: role === 'verifier' ? 'high' : 'low', fastMode: 'off',
  }]));
  writePrivate(roleFile, JSON.stringify({ version: 1, roles: roleOverrides }));
  process.env.CODEX_HOME = isolatedHome;
  process.env.CODEX_A2A_ACCOUNTS_DIR = accountsDir;
  process.env.CODEX_A2A_AUTO_RESUME = 'false';
  process.env.CODEX_A2A_TURN_TIMEOUT_MS = String(TURN_TIMEOUT_MS);
  delete process.env.OPENAI_API_KEY;

  const evidence = { schemaVersion: 2, engine, startedAt: new Date().toISOString(), root,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    sourceManifestBefore: sourceBefore,
    sourceInventorySha256: hash(fs.readFileSync(SOURCE_INVENTORY_FILE)),
    runnerSha256: hash(fs.readFileSync(__filename)),
    frozenControlsSha256: FROZEN_CONTROLS_SHA256,
    frozenControls: { productInputSha256: controls.productInputSha256,
      immutableCheckSha256: controls.immutableCheckSha256 },
    fixture, positiveControl, roleOverrides, budgets: { taskTimeoutMs: TASK_TIMEOUT_MS,
      turnTimeoutMs: TURN_TIMEOUT_MS, maxTurns: MAX_TURNS, maxObservedTokens: MAX_TOKENS },
    semanticInput: null, semanticInputSha256: null, transportEnvelopeSha256: null,
    progress: [], observer: { method: 'CodexAppServer.run pass-through onEvent',
      turns: [], calls: [], knownTokenSubtotal: 0, observedTokenTotal: 0, unknownUsageCalls: 0,
      usageComplete: true, pendingTurnReservations: 0, steering: null } };
  const wallStartedMs = Date.now();
  let runtime = null;
  let retainRoot = true;
  const startupState = { startupAttempted: false, runtimeReturned: false, retainRoot: false, startupError: null };
  let steeringPromise = null;
  let taskIdForRun = null;
  let nativeToken = null;
  try {
    const { startServer } = require(path.join(REPO_ROOT, 'src/server'));
    const { CodexAppServer } = require(path.join(REPO_ROOT, 'src/codex-app-server'));
    const appServerFactory = (codexHome) => {
      const appServer = new CodexAppServer({ codexHome });
      const originalRun = appServer.run.bind(appServer);
      appServer.run = async (request = {}) => {
        if (!reserveNativeTurn(evidence.observer)) throw new Error('native_observation_budget_reached');
        const role = request.role || {};
        const call = { role: role.name || null, configuredModel: role.model || null,
          configuredEffort: role.effort || null, fastMode: role.fastMode || null,
          startedAt: new Date().toISOString(), turns: [] };
        evidence.observer.calls.push(call);
        call.turnReservationPending = true;
        const prior = request.onEvent;
        const priorTurnStart = request.onTurnStart;
        const observedRequest = { ...request, onEvent(event) {
          const method = event?.method;
          if (method === 'turn/started') {
            releaseNativeTurnReservation(evidence.observer, call);
            const turn = { role: role.name || null, threadId: event.params?.threadId || null,
              turnId: event.params?.turn?.id || null, startedAt: new Date().toISOString(), completedAt: null };
            call.turns.push(turn);
            evidence.observer.turns.push(turn);
            if (engine === 'concurrent-v1' && turn.role && turn.role !== 'coordinator'
              && !evidence.observer.steering) {
              evidence.observer.steering = { status: 'triggered', turnId: turn.turnId,
                turnStartedAt: turn.startedAt };
              steeringPromise = steerOnActiveTurn(turn, { runtime, taskId: () => taskIdForRun,
                token: () => nativeToken, evidence });
              steeringPromise.catch((error) => {
                evidence.observer.steering = { ...evidence.observer.steering, status: 'failed',
                  error: safeError(error), failedAt: new Date().toISOString() };
              });
            }
          } else if (method === 'turn/completed') {
            const turnId = event.params?.turn?.id || null;
            const turn = [...call.turns].reverse().find((entry) => !entry.completedAt && (!turnId || entry.turnId === turnId));
            if (turn) turn.completedAt = new Date().toISOString();
          }
          if (typeof prior === 'function') prior(event);
        }, onTurnStart(info) {
          call.processIdentity = info?.processIdentity || null;
          call.preSendAt = new Date().toISOString();
          if (typeof priorTurnStart === 'function') priorTurnStart(info);
        } };
        try {
          return await preserveRunOutcome(originalRun, observedRequest, evidence, call);
        } finally {
          releaseNativeTurnReservation(evidence.observer, call);
        }
      };
      return appServer;
    };
    runtime = await startRuntimeSafely(startServer, { port: 0, workspace, stateFile, tokenFile, workspaceLockDir: locks,
      deliveryStorageRoot: storage, projectSettingsFile: settingsFile, roleOverridesFile: roleFile,
      accountsDir, appServerFactory, autoResume: false }, startupState);
    evidence.startup = { host: runtime.host, port: runtime.port, deliveryEngine: runtime.deliveryEngine,
      projectId: runtime.projectId, roles: [...runtime.roles.values()].map((role) => ({ id: role.id,
        model: role.model, effort: role.effort, fastMode: role.fastMode || 'off' })) };
    if (runtime.host !== '127.0.0.1' || runtime.deliveryEngine !== engine) throw new Error('runtime_isolation_or_engine_mismatch');
    const quota = await runtime.appServer.readRateLimits();
    evidence.quota = { observed: quotaUsage(quota), available: Boolean(quota) };
    if (evidence.quota.observed === null || evidence.quota.observed.primaryUsedPercent >= 90) throw new Error('quota_unknown_or_at_stop_threshold');

    const origin = `http://${runtime.host}:${runtime.port}`;
    const card = await fetch(`${origin}/orchestrator/agent-card.json`);
    if (!card.ok) throw new Error('a2a_card_unavailable');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const client = await new ClientFactory().createFromUrl(origin, '/orchestrator/agent-card.json');
    nativeToken = token;
    const goal = [
      'Implement these exact CommonJS exports in the three allowed product files: formatLabel(string) trims and uppercases the string and throws TypeError for nonstrings; sumPositive(array) sums positive finite numbers only, throws TypeError for nonarrays, and preserves its input; report(label, values) returns { label, total } by calling those module exports.',
      'Perform a bounded engineering diagnostic first: run node verify-product.js, make no edits, and report the genuine failure with evidence.',
      'After that diagnostic, use an explorer to inspect the failing check and relevant modules, then create distinct repair tasks for format-label.js and sum-positive.js, which are independent. Create a separate report.js repair task after those prerequisites. Have a fresh verifier run node verify-product.js and report the outcome.',
      'Preserve the goal, immutable check, and three-file scope. Do not ask the owner questions. Use only this disposable workspace, make no external changes, and report failures honestly.',
    ].join('\n');
    const acceptance = { source: 'agent', requiredChecks: [{ id: 'verify-product',
      argv: ['node', CHECK_FILE], timeoutMs: 5000 }] };
    const semantic = semanticInput(goal, acceptance);
    const message = { messageId: `cn15-${engine}-${crypto.randomUUID()}`,
      contextId: '', taskId: '', role: 1,
      parts: [{ content: { $case: 'text', value: goal }, mediaType: 'text/plain', filename: '', metadata: undefined }],
      metadata: { acceptance }, extensions: [], referenceTaskIds: [] };
    const configuration = { acceptedOutputModes: ['text/plain'], returnImmediately: true };
    evidence.semanticInput = semantic;
    evidence.semanticInputSha256 = hash(JSON.stringify(semantic));
    evidence.transportEnvelopeSha256 = hash(JSON.stringify({ message, configuration }));
    const sourceBeforeIntake = captureSourceManifest();
    const fixtureBeforeIntake = fixtureHashes(workspace);
    if (sourceDrift(sourceBefore, sourceBeforeIntake).length) throw new Error('source_drift_before_intake');
    if (JSON.stringify(fixtureBeforeIntake) !== JSON.stringify(controls.productInputSha256)) throw new Error('fixture_drift_before_intake');
    let task = await client.sendMessage({ tenant: '', message, configuration },
      { serviceParameters: { Authorization: `Bearer ${token}` } });
    task = task?.task || task;
    evidence.a2a = { id: task?.id || null, state: task?.status?.state ?? null,
      stateName: TaskState[task?.status?.state] || null };
    if (!task?.id) throw new Error('a2a_task_id_missing');
    const taskId = task.id;
    taskIdForRun = taskId;
    const mapping = runtime.orchestrator.mapping(taskId);
    evidence.mapping = mapping ? { engine: mapping.engine, projectId: mapping.projectId,
      sessionId: mapping.sessionId, objectiveId: mapping.objectiveId } : null;
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    while (ACTIVE_STATES.has(task?.status?.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      task = await client.getTask({ tenant: '', id: taskId }, { serviceParameters: { Authorization: `Bearer ${token}` } });
      task = task?.task || task;
      evidence.progress.push({ observedAt: new Date().toISOString(), state: task?.status?.state ?? null,
        stateName: TaskState[task?.status?.state] || null,
        nativeTurns: evidence.observer.turns.length, observedTokens: evidence.observer.observedTokenTotal });
      evidence.a2a.state = task?.status?.state ?? null;
      evidence.a2a.stateName = TaskState[task?.status?.state] || null;
      if (evidence.observer.turns.length >= MAX_TURNS
        || evidence.observer.observedTokenTotal >= MAX_TOKENS) {
        evidence.stopReason = evidence.observer.turns.length >= MAX_TURNS
          ? 'native_turn_limit_observed' : 'observed_token_limit_reached';
        break;
      }
    }
    if (ACTIVE_STATES.has(task?.status?.state)) {
      evidence.incompleteReason = evidence.stopReason || 'task_deadline_or_turn_limit';
      const cancellation = await client.cancelTask({ tenant: '', id: taskId }, { serviceParameters: { Authorization: `Bearer ${token}` } });
      evidence.cancel = { responseState: cancellation?.status?.state ?? cancellation?.task?.status?.state ?? null };
      task = cancellation?.task || cancellation;
    }
    evidence.finalTask = { state: task?.status?.state ?? null,
      stateName: TaskState[task?.status?.state] || null,
      message: task?.status?.message?.parts?.map((part) => part.text || part.content?.value).filter(Boolean).join('\n') || null,
      artifacts: (task?.artifacts || []).map((artifact) => ({ name: artifact.name || null,
        text: artifact.parts?.map((part) => part.text || part.content?.value).filter(Boolean).join('\n') || null })) };
    evidence.finalMapping = runtime.orchestrator.mapping(taskId) || null;
    evidence.finalization = engine === 'concurrent-v1' ? runtime.concurrentEngine.getRunDigest(taskId) : null;
    if (engine === 'legacy') evidence.steeringCoverage = 'unavailable_no_supported_live_steer';
    evidence.productCheck = spawnSync(process.execPath, ['verify-product.js'], { cwd: workspace,
      encoding: 'utf8', timeout: 5000 });
    evidence.productCheck = { exitCode: evidence.productCheck.status, stdout: evidence.productCheck.stdout || '',
      stderr: evidence.productCheck.stderr || '', signal: evidence.productCheck.signal || null,
      error: evidence.productCheck.error ? safeError(evidence.productCheck.error) : null };
    evidence.productHashesAfter = fixtureHashes(workspace);
    evidence.productDiff = execFileSync('git', ['diff', '--no-ext-diff', 'HEAD', '--', ...PRODUCT_FILES], { cwd: workspace, encoding: 'utf8' });
    evidence.productScope = productScope(workspace);
    evidence.checkUnchanged = evidence.productHashesAfter[CHECK_FILE] === controls.immutableCheckSha256;
    evidence.taskSnapshot = readTaskSnapshot(runtime, taskId, mapping?.objectiveId);
  } catch (error) {
    evidence.error = safeError(error);
    if (startupState.startupAttempted && !startupState.runtimeReturned) {
      retainRoot = true;
      evidence.startupCleanup = 'unresolved_private_root_retained';
      evidence.startupError = startupState.startupError;
    }
  } finally {
    const finalization = await finalizationSequence({
      evidence,
      awaitSteering: async () => { if (steeringPromise) await steeringPromise.catch(() => {}); },
      closeRuntime: async () => {
        if (!runtime) return;
        const currentTaskId = taskIdForRun || 'no-task';
        const lifecycle = await closeWithEvidence({ runtime, evidence,
          captureBeforeClose: async () => {
            const before = { complete: true };
            if (!evidence.taskSnapshot && taskIdForRun) {
              try {
                const currentMapping = runtime.orchestrator.mapping(taskIdForRun);
                evidence.taskSnapshot = readTaskSnapshot(runtime, taskIdForRun, currentMapping?.objectiveId);
              } catch (error) { before.snapshotError = safeError(error); before.complete = false; }
            }
            try {
              evidence.stateBackupBeforeClose = await backupStateDatabase(stateFile, currentTaskId, 'pre-close');
              if (!evidence.stateBackupBeforeClose) { before.backupError = 'state_backup_missing'; before.complete = false; }
            } catch (error) { before.backupError = safeError(error); before.complete = false; }
            return before;
          },
          captureAfterClose: async () => {
            const after = { complete: true };
            try { evidence.taskSnapshotAfterClose = readSnapshotAfterClose(stateFile); }
            catch (error) { after.snapshotError = safeError(error); after.complete = false; }
            try {
              evidence.stateBackupAfterClose = await backupStateDatabase(stateFile, currentTaskId, 'post-close');
              if (!evidence.stateBackupAfterClose) { after.backupError = 'state_backup_missing'; after.complete = false; }
            } catch (error) { after.backupError = safeError(error); after.complete = false; }
            return after;
          } });
        evidence.close = lifecycle.closeSafe ? evidence.closeLifecycle.close
          : { status: 'failed', error: evidence.closeLifecycle.closeError };
        if (lifecycle.closeSafe) runtime = null;
      },
      captureSourceAfter: async () => {
        try {
          evidence.sourceManifestAfter = captureSourceManifest();
          evidence.sourceDrift = sourceDrift(sourceBefore, evidence.sourceManifestAfter);
        } catch (error) {
          evidence.sourceManifestAfterError = safeError(error);
          evidence.sourceDrift = null;
        }
      },
      reduce: async () => {
        evidence.steeringAccepted = engine !== 'concurrent-v1'
          || evidence.observer.steering?.steeringWithinWorkerTurn === true;
        evidence.completedAt = new Date().toISOString();
        evidence.wallElapsedMs = Date.now() - wallStartedMs;
        retainRoot = shouldRetainPrivateRoot({ startupAttempted: startupState.startupAttempted,
          runtimeReturned: startupState.runtimeReturned,
          closeSafe: Boolean(evidence.close?.status === 'closed'),
          evidenceSafe: evidence.closeLifecycle?.beforeClose?.complete === true
            && evidence.closeLifecycle?.afterClose?.complete === true });
        evidence.retainedRuntimeRoot = retainRoot ? root : null;
        return finalizeCollector(evidence);
      },
    });
    evidence.finalizationOrder = finalization.order;
    evidence.finalizationFailures = finalization.failures;
    evidence.retainedRuntimeRoot = retainRoot ? root : null;
    const destination = path.join(RUNNER_DIR, `${engine}-${Date.now()}.evidence.json`);
    writePrivate(destination, `${JSON.stringify(evidence, null, 2)}\n`);
    if (!retainRoot) {
      fs.rmSync(path.join(isolatedHome, 'auth.json'), { force: true });
      fs.rmSync(tokenFile, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
    process.stdout.write(`${JSON.stringify({ status: evidence.status, engine, taskId: evidence.a2a?.id || null,
      evidence: destination, retainedRuntimeRoot: evidence.retainedRuntimeRoot })}\n`);
  }
}

async function steerOnActiveTurn(turn, context) {
  const started = Date.parse(turn.startedAt);
  const deadline = Math.min(Date.now() + 120_000, started + TURN_TIMEOUT_MS);
  const runtime = context.runtime;
  let taskId = context.taskId();
  const token = context.token();
  while (!taskId && Date.now() < Math.min(deadline, started + 10_000)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    taskId = context.taskId();
  }
  if (!runtime || !taskId || !token) throw new Error('steering_context_unavailable');
  const mapping = runtime.orchestrator.mapping(taskId);
  if (!mapping || mapping.engine !== 'concurrent-v1') throw new Error('steering_mapping_unavailable');
  const origin = `http://${runtime.host}:${runtime.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const statusResponse = await fetch(`${origin}/control/delivery/${encodeURIComponent(taskId)}`, { headers });
  if (!statusResponse.ok) throw new Error(`steering_status_http_${statusResponse.status}`);
  const status = await statusResponse.json();
  const messageId = `cn15-steer-${crypto.randomUUID()}`;
  const body = { runId: taskId, projectId: mapping.projectId, sessionId: mapping.sessionId,
    objectiveId: mapping.objectiveId, messageId,
    text: 'Keep the pinned goal, immutable acceptance check, and three-file scope unchanged. Continue with the planned diagnostic, investigation, and repairs.',
    expectedPlanRevision: status.revisions.planRevision,
    expectedGoalRevision: status.revisions.goalRevision,
    expectedControlRevision: status.revisions.controlRevision };
  const response = await fetch(`${origin}/control/delivery/${encodeURIComponent(taskId)}/steer`, {
    method: 'POST', headers, body: JSON.stringify(body) });
  const ack = await response.json();
  const evidence = context.evidence;
  evidence.observer.steering = { attemptedAt: new Date().toISOString(),
    responseStatus: response.status, acknowledgement: ack, turnId: turn.turnId,
    threadId: turn.threadId, turnStartedAt: turn.startedAt, turnCompletedAt: null, appliedAt: null };
  if (!response.ok || !['received', 'applied'].includes(ack.state)) throw new Error(`steering_ack_${ack.state || response.status}`);
  let terminalReceiptObserved = false;
  while (Date.now() < deadline) {
    const current = await fetch(`${origin}/control/delivery/${encodeURIComponent(taskId)}`, { headers });
    if (!current.ok) throw new Error(`steering_poll_http_${current.status}`);
    const bodyNow = await current.json();
    const receipt = (bodyNow.messages || []).find((message) => message.messageId === messageId);
    if (receipt) {
      evidence.observer.steering.receipt = receipt;
      if (receipt.state === 'applied' || receipt.state === 'refused') {
        evidence.observer.steering.resolvedAt = receipt.updatedAt || null;
        if (receipt.state === 'applied') evidence.observer.steering.appliedAt = receipt.updatedAt || null;
        terminalReceiptObserved = true;
      }
    }
    if (turn.completedAt && terminalReceiptObserved) break;
    if (turn.completedAt && Date.now() > Date.parse(turn.completedAt) + 10_000) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const record = evidence.observer.steering;
  record.turnCompletedAt = turn.completedAt;
  Object.assign(record, steeringTiming(record.receipt, turn));
}

function readTaskSnapshot(runtime, taskId, objectiveId) {
  const db = runtime.state.db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  const existing = new Set(tables);
  const tableRows = (table) => existing.has(table)
    ? db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}"`).all() : [];
  if (runtime.deliveryEngine === 'concurrent-v1') {
    const engine = runtime.concurrentEngine;
    const objective = objectiveId ? engine.store.getObjective(runtime.projectId, objectiveId) : null;
    const run = db.prepare('SELECT status,result_json FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(runtime.projectId, taskId);
    const query = (table) => existing.has(table) && objectiveId
      ? db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" WHERE project_id=? AND objective_id=?`).all(runtime.projectId, objectiveId) : [];
    return { engine: 'concurrent-v1', run: run ? { status: run.status, result: run.result_json ? JSON.parse(run.result_json) : null } : null,
      objective: objective ? { objectiveId: objective.objectiveId, disposition: objective.disposition } : null,
      tasks: objective?.tasks?.map((item) => ({ taskId: item.taskId, state: item.state, role: item.role })) || [],
      roleExecutions: query('delivery_role_executions').map((row) => ({ roleId: row.role_id, taskId: row.task_id,
        state: row.state, record: JSON.parse(row.record_json) })),
      attempts: query('backlog_attempts').map((row) => ({ attemptId: row.attempt_id, taskId: row.task_id,
        state: row.state, record: JSON.parse(row.record_json) })),
      events: db.prepare('SELECT event_json FROM delivery_events WHERE project_id=? ORDER BY rowid').all(runtime.projectId)
        .map((row) => JSON.parse(row.event_json)),
      usage: db.prepare('SELECT * FROM usage_ledger ORDER BY recorded_at,rowid').all().map((row) => ({ ...row,
        tokens_json: row.tokens_json ? JSON.parse(row.tokens_json) : null,
        permission_events_json: row.permission_events_json ? JSON.parse(row.permission_events_json) : null })),
      controlStatus: engine.controlStatus(taskId),
      finalization: query('backlog_finalizations'),
      proofTables: tables.filter((name) => /proof|finalization/i.test(name)),
      tableNames: tables };
  }
  return { engine: 'legacy', tableNames: tables,
    usage: existing.has('usage_ledger') ? tableRows('usage_ledger') : [],
    relevantTables: Object.fromEntries(tables.filter((name) => /task|dispatch|journal|check|acceptance|run|event|proof/i.test(name))
      .map((name) => [name, tableRows(name)])) };
}

async function backupStateDatabase(stateFile, taskId, phase) {
  if (!fs.existsSync(stateFile)) return null;
  const safeId = String(taskId).replace(/[^A-Za-z0-9_-]/g, '_');
  const destination = path.join(RUNNER_DIR, `${safeId}-${phase}-${Date.now()}.state.sqlite`);
  const Database = require('better-sqlite3');
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); } finally { db.close(); }
  fs.chmodSync(destination, 0o600);
  return { path: destination, sha256: hash(fs.readFileSync(destination)), bytes: fs.statSync(destination).size };
}

function readSnapshotAfterClose(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(stateFile, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
    const tableSet = new Set(tables);
    const shutdown = tableSet.has('concurrent_shutdown_phases')
      ? db.prepare('SELECT * FROM concurrent_shutdown_phases ORDER BY rowid').all() : [];
    const runStates = tableSet.has('concurrent_delivery_runs')
      ? db.prepare('SELECT project_id,run_id,status,result_json,failure_json,updated_at FROM concurrent_delivery_runs ORDER BY created_at,run_id').all() : [];
    const legacyTasks = tableSet.has('tasks') ? db.prepare('SELECT * FROM tasks').all() : [];
    return { tables, integrity: db.pragma('integrity_check'), shutdown, runStates, legacyTasks };
  } finally { db.close(); }
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ status: 'failed', error: safeError(error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { fixtureHashes, seedFixture, seedPositiveControl, quotaUsage, fixtureControlsMatch,
  frozenFixtureControls, captureSourceManifest,
  sourceDrift, semanticInput, normalizeEpochMs, steeringTiming, usageFacts, recordUsage,
  canAdmitNativeTurn, reserveNativeTurn, releaseNativeTurnReservation, preserveRunOutcome,
  shouldRetainPrivateRoot, startRuntimeSafely, closeWithEvidence, finalizationSequence,
  finalizeCollector, hash };
