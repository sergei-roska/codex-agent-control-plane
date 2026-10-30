'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BacklogStore, stableDigest } = require('./backlog-store');
const { CandidateStore, captureManifest } = require('./candidate-store');
const { CandidateReviewStore } = require('./candidate-review');
const { DeliveryOutputArtifacts } = require('./delivery-output-artifacts');
const { DeliveryRoleService } = require('./delivery-role-service');
const { createDeliveryRoleCapabilities } = require('./delivery-role-capabilities');
const { TaskExecutor } = require('./task-executor');
const { ProjectDeliveryController } = require('./project-delivery-controller');
const { isProcessGroupGone } = require('./process-quiescence');
const { DeliveryInbox } = require('./delivery-inbox');
const { DeliveryLifecycle } = require('./delivery-lifecycle');
const { finalizeCandidate, runFrozenCandidateChecks } = require('./delivery-acceptance');
const { validateAcceptanceContract } = require('./acceptance');
const { HUMAN_REASONS } = require('./contracts');
const { VERSION, validateTask } = require('./delivery-contracts');
const { canonicalRoleId, getRole } = require('./role-names');
const { CONCURRENT_TABLES } = require('./concurrent-table-names');

const json = (value) => JSON.stringify(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const error = (code, message = code) => Object.assign(new Error(message), { code });
const copy = (value) => value == null ? value : structuredClone(value);
const ID = /^[\x21-\x7e]{1,128}$/;
const CONTROL_MESSAGE_LIMIT = 64;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function normalizeFastMode(value) {
  if (value === 'inherit' || value === 'off' || value === 'on') return value;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return null;
}

function effectiveRoleSettings(role = {}) {
  return { model: role.model || role.selectedModel || null,
    effort: role.effort || role.reasoningEffort || null,
    fastMode: normalizeFastMode(role.fastMode ?? role.fast) };
}

function pinnedRoleSettings(settings = {}) {
  return { model: settings.model || null, effort: settings.effort || null,
    fastMode: normalizeFastMode(settings.fastMode ?? settings.fast) };
}

function normalizeProviderIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.accountId !== 'string' || !value.accountId
    || typeof value.codexHome !== 'string' || !value.codexHome) throw error('concurrent_provider_identity_invalid');
  return { accountId: value.accountId, codexHome: value.codexHome };
}

function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw error(`concurrent_${field}_invalid`);
  return value;
}

function readOnlyTreeManifest(manifest) {
  return (manifest?.entries || []).map((entry) => ({ path: entry.path, digest: entry.digest }));
}

class ConcurrentDeliveryEngine {
  constructor({ db, workspace, projectId, stateFile, storageRoot, baseUrl, authMiddleware, authToken,
    appServer, providerIdentity, providerIdentityFor, roles, leadRole, admission, lanes, writerIsolation, executionPermissions = 'inherit',
    acceptanceScratch = null, evidenceStore = null, roleLimits = {}, maxActiveTurns = 12,
    plannerReservedSlots = 1, ownerCorrectionAuthorized = () => false, authenticateOwner = () => false,
    now = () => Date.now(), sleepMs = 40 } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('Shared SQLite database is required');
    if (typeof workspace !== 'string' || !workspace) throw new TypeError('Workspace is required');
    if (typeof projectId !== 'string' || !/^[0-9a-f]{10}$/.test(projectId)) throw new TypeError('Normalized project ID is required');
    if (!appServer || typeof appServer.prepareThread !== 'function' || typeof appServer.run !== 'function') throw new TypeError('Codex App Server is required');
    if (!providerIdentity || typeof providerIdentity !== 'object' || Array.isArray(providerIdentity)
      || typeof providerIdentity.accountId !== 'string' || !providerIdentity.accountId
      || typeof providerIdentity.codexHome !== 'string' || !providerIdentity.codexHome) throw new TypeError('Pinned provider identity is required');
    if (typeof providerIdentityFor !== 'function') throw new TypeError('providerIdentityFor must be a synchronous function');
    if (!(roles instanceof Map) || !roles.size || !getRole(roles, 'verifier')) throw error('concurrent_verifier_role_required');
    if (!leadRole?.name || !leadRole?.model) throw error('concurrent_lead_role_required');
    if (!admission || !lanes || !writerIsolation) throw new TypeError('Writer admission and lane isolation are required');
    if (!['worktree', 'cooperative'].includes(writerIsolation.mode) || lanes.mode !== writerIsolation.mode) {
      throw error('concurrent_private_worktree_required');
    }
    if (writerIsolation.mode === 'cooperative') {
      const inheritedCooperative = writerIsolation.inherited === true && executionPermissions === 'inherit';
      const ownerFullAccessCooperative = writerIsolation.ownerFullAccess === true && executionPermissions === 'full-access'
        && writerIsolation.profile === ':danger-full-access';
      if (!inheritedCooperative && !ownerFullAccessCooperative) throw error('concurrent_cooperative_permissions_required');
    }
    if (typeof authMiddleware !== 'function' || typeof authToken !== 'string' || !authToken) throw new TypeError('Authenticated role routes are required');
    if (typeof now !== 'function' || !Number.isSafeInteger(sleepMs) || sleepMs < 5 || sleepMs > 1000) throw new TypeError('Invalid engine timing configuration');

    this.db = db;
    this.workspace = fs.realpathSync(workspace);
    this.projectId = projectId;
    this.stateFile = stateFile || ':memory:';
    this.storageRoot = path.resolve(storageRoot || path.join(require('node:os').homedir(), '.codex-agent-control-plane', 'projects', projectId));
    if (this.storageRoot === this.workspace || this.storageRoot.startsWith(`${this.workspace}${path.sep}`)
      || this.workspace.startsWith(`${this.storageRoot}${path.sep}`)) throw error('concurrent_storage_workspace_overlap');
    this.baseUrl = baseUrl;
    this.authMiddleware = authMiddleware;
    this.authToken = authToken;
    this.appServer = appServer;
    this.providerIdentity = deepFreeze(normalizeProviderIdentity(providerIdentity));
    this.providerIdentityFor = providerIdentityFor;
    this.roles = new Map([...roles.entries()].map(([key, role]) => [key, deepFreeze(copy(role))]));
    this.leadRole = deepFreeze(copy(leadRole));
    this.admission = admission;
    this.lanes = lanes;
    this.writerIsolation = writerIsolation;
    this.executionPermissions = executionPermissions;
    this.acceptanceScratch = acceptanceScratch;
    this.evidenceStore = evidenceStore;
    this.ownerCorrectionAuthorized = ownerCorrectionAuthorized;
    this.authenticateOwner = authenticateOwner;
    this.now = now;
    this.sleepMs = sleepMs;
    this.shutdownInitialProcessIdentity = copy(appServer.processIdentity?.() || null);
    this.ownerDecisionAuthorization = null;
    this.controllers = new Map();
    this.runs = new Map();
    this.leadThreads = new Map();
    this.checkContract = new Map();
    this.roleSettings = (input) => this.#settingsFor(input);
    this.roleFor = (roleId) => getRole(this.roles, roleId);
    this.roleCapacities = this.#capacities(roleLimits);
    this.roleIds = [...this.roles.keys()].map(canonicalRoleId);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS concurrent_shutdown_phases (
        project_id TEXT PRIMARY KEY, phase_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS concurrent_delivery_runs (
        project_id TEXT NOT NULL, run_id TEXT NOT NULL, objective_id TEXT NOT NULL, session_id TEXT NOT NULL,
        goal TEXT NOT NULL, contract_json TEXT NOT NULL, contract_digest TEXT NOT NULL,
        requirement_digest TEXT NOT NULL, checks_digest TEXT NOT NULL, environment_digest TEXT NOT NULL,
        check_identity TEXT NOT NULL, checkpoint_ids_json TEXT NOT NULL, lead_thread_id TEXT,
        lead_codex_home TEXT, lead_settings_json TEXT, failure_json TEXT, status TEXT NOT NULL,
        result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, run_id), UNIQUE(project_id, objective_id)
      );
      CREATE TABLE IF NOT EXISTS concurrent_planner_execution_facts (
        project_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        identity_json TEXT NOT NULL, start_json TEXT, terminal_json TEXT,
        PRIMARY KEY(project_id, session_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS concurrent_verifier_check_proofs (
        attempt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL, proof_json TEXT NOT NULL,
        proof_digest TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS concurrent_finalization_check_proofs (
        finalization_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        check_attempt_id TEXT NOT NULL, pins_json TEXT NOT NULL, result_json TEXT NOT NULL,
        result_digest TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS concurrent_controller_fences (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, owner_generation INTEGER NOT NULL,
        control_revision INTEGER NOT NULL, status TEXT NOT NULL, projection_json TEXT NOT NULL,
        projection_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id)
      );
    `);
    const shutdownPhase = this.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(this.projectId);
    this.shutdownRequested = Boolean(shutdownPhase && JSON.parse(shutdownPhase.phase_json).phase !== 'released');
    const store = new BacklogStore(db, {
      roleCapacities: this.roleCapacities, maxActiveTurns, plannerReservedSlots,
      selectedSettingsResolver: ({ task }) => this.roleSettings({ task }),
      checkpointInventory: (scope) => this.#ownerCheckpointInventory(scope),
      checkpointAccepted: (scope) => this.#checkpointAccepted(scope),
      ownerCorrectionAuthorized: (facts) => this.#ownerCorrectionAuthorized(facts),
      ownerDecisionAuthorized: (facts) => this.ownerDecisionAuthorization === canonical(facts),
      ownerDecisionEvidenceAuthorized: (facts) => this.#revalidateOwnerInvestigation(facts),
      finalizationAuthorized: (facts) => this.#finalizationAuthorized(facts),
      finalizationCheckProofAuthorized: (facts) => this.#finalizationCheckProofAuthorized(facts),
      finalizationRecoveryAuthorized: () => false,
      finalizationRemainderResolver: () => null,
      isOutputTrusted: (facts) => this.#isOutputTrusted(facts),
    });
    this.store = store;
    const laneStatus = lanes.status();
    const environment = { executionPermissions, laneStatus, appServerVersion: appServer.getVersion?.() || null };
    this.environmentDigest = stableDigest(environment);
    this.candidateStore = null;
    this.roleService = null;
    this.reviewStore = null;
    this.outputArtifacts = new DeliveryOutputArtifacts({ db, backlogStore: store, laneManager: lanes,
      admission, workspace: this.workspace, storageDir: path.join(this.storageRoot, 'artifacts'),
      authorizeBinding: (binding) => this.roleService?.authorizeArtifactBinding(binding) === true,
      producerEvidenceFor: (binding) => this.roleService?.producerEvidenceFor(binding) || null,
      controls: ({ projectId: pid, objectiveId, attemptId }) => {
        const objective = this.store.getObjective(pid, objectiveId);
        const claim = this.store.listClaims(pid, objectiveId).find((entry) => entry.attemptId === attemptId);
        const attempt = this.store.listAttempts(pid, objectiveId).find((entry) => entry.attemptId === attemptId);
        return { projectId: pid, objectiveId, attemptId, allowed: Boolean(objective && ['planning', 'executing'].includes(objective.disposition)),
          fenced: !claim || claim.state !== 'active', controlRevision: objective?.controlRevision ?? -1,
          fencingToken: attempt?.fencingToken ?? 0 };
      },
    });
    this.candidateStore = new CandidateStore({ db, workspace: this.workspace,
      storageDir: path.join(this.storageRoot, 'candidates'), ...this.outputArtifacts.candidateStoreOptions() });
    this.outputArtifacts.attachCandidateStore(this.candidateStore);
    this.reviewStore = new CandidateReviewStore({ db, candidateStore: this.candidateStore,
      currentObjective: (scope) => this.store.getObjective(scope.projectId, scope.objectiveId),
      checkpointInventory: (scope) => this.#ownerCheckpointInventory(scope),
      authorizeCheckpoint: (context) => this.#authorizeCheckpoint(context),
      authorizeProposal: (context) => context?.authorization?.source === 'concurrent-engine'
        && this.#isKnownRun(context.projectId, context.objectiveId),
      authorizeBinding: (context) => this.#reviewBinding(context),
      authorizeThread: (context) => this.#reviewThread(context),
      resolveAttempt: (scope) => this.#resolveReviewAttempt(scope),
      authorizeSettlement: (context) => this.#trustedReviewExecution(context),
      verifyReviewExecution: (context) => this.#trustedReviewExecution(context),
      authorizeCheckpointSupersession: (context) => this.#authorizeSupersession(context),
      attestClosure: (context) => this.#attestClosure(context),
      attestPromotion: (context) => this.#attestPromotion(context),
    });
    const capability = createDeliveryRoleCapabilities({ backlogStore: store, candidateReview: this.reviewStore,
      executionPermissions: this.executionPermissions,
      projectWorkspaceFor: ({ projectId: pid }) => this.#workspaceForProject(pid),
      scratchRootFor: ({ projectId: pid, objectiveId, attemptId }) => path.join(this.storageRoot, 'verifier-scratch', pid, objectiveId, attemptId),
    });
    this.roleService = new DeliveryRoleService({ db, backlogStore: store, candidateStore: this.candidateStore,
      candidateReview: this.reviewStore, outputArtifacts: this.outputArtifacts, lanes, roles, appServer,
      workspace: this.workspace, baseUrl, authMiddleware, authToken,
      settingsFor: this.roleSettings, roleFor: this.roleFor,
      resolveVerifierCapability: capability.resolveVerifierCapability,
      checkEvidenceFor: (input) => this.#checkEvidenceFor(input),
      executionPermissions, getProviderIdentity: () => this.#providerIdentity(),
      selectedSkillsFor: ({ task }) => this.#skillsFor(task), selectedMcpToolsFor: ({ task }) => this.#mcpToolsFor(task),
      privateRoot: path.join(this.storageRoot, 'role-private'),
    });
    this.executor = new TaskExecutor({ backlogStore: store, db,
      transportFor: (descriptor, attemptId) => this.roleService.transportFor(descriptor, attemptId),
      settingsFor: (input) => this.roleSettings(input), roleFor: this.roleFor,
      requestAdapter: (input) => this.#requestFor(input),
      resultAdapter: (input) => this.roleService.resultAdapter(input),
      receiptAdapter: (input) => this.roleService.receiptAdapter(input),
      recoveryProofAdapter: (input) => this.roleService.recoveryProofFor(input),
      terminalFailureProofAdapter: (input) => this.roleService.terminalFailureProofFor(input),
      resolveVerifierCapability: capability.resolveVerifierCapability,
    });
  }

  register(app) { return this.roleService.register(app); }

  async recoverInterruptedShutdown() {
    try { return await this.#recoverInterruptedShutdown(); }
    catch (cause) {
      if (cause?.code === 'concurrent_startup_recovery_unsafe') throw cause;
      const failure = error('concurrent_startup_recovery_unsafe');
      if (typeof cause?.code === 'string' && /^[a-z0-9_]+$/.test(cause.code)) failure.message += `: ${cause.code}`;
      throw Object.assign(failure, { cause });
    }
  }

  async #recoverInterruptedShutdown() {
    const saved = this.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(this.projectId);
    if (!saved) return { state: 'none' };
    let phase;
    try { phase = JSON.parse(saved.phase_json); } catch (_) { throw error('concurrent_startup_recovery_unsafe'); }
    if (phase?.phase === 'released') {
      this.shutdownRequested = false;
      return { state: 'released' };
    }
    const refuse = () => { throw error('concurrent_startup_recovery_unsafe'); };
    if (phase?.phase !== 'provider_closing' || !Array.isArray(phase.attempts)
      || !Array.isArray(phase.identities) || !phase.identities.length
      || phase.identities.some((identity) => !isProcessGroupGone(identity))) refuse();
    const hasPlannerLedger = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get();
    const activeTurns = hasPlannerLedger ? this.db.prepare(`SELECT project_id,session_id,provider_scope,provider_thread_id,turn_id,status,pins_json,result_json
      FROM delivery_planner_turns WHERE project_id=? AND status IN ('active','unknown') ORDER BY started_at,turn_id`).all(this.projectId) : [];
    const proofs = [];
    const allowedTurnsByObjective = new Map();
    for (const turn of activeTurns) {
      const provider = this.#providerIdentity();
      let pins;
      let failure;
      try { pins = JSON.parse(turn.pins_json); failure = turn.result_json ? JSON.parse(turn.result_json) : null; } catch (_) { refuse(); }
      if (turn.status !== 'unknown') refuse();
      const localPreDispatchFailure = failure?.errorCode === 'provider_home_changed'
        && (Object.hasOwn(failure, 'preDispatchSource') ? failure.preDispatchSource === 'switching_app_server.expected_home_preflight' : true)
        && Object.keys(failure).every((key) => ['errorCode', 'preDispatchSource', 'providerFailure'].includes(key));
      const terminalSchemaFailure = failure?.errorCode === 'turn_error' && failure.preDispatchSource === null
        && Object.keys(failure).every((key) => ['errorCode', 'preDispatchSource', 'providerFailure'].includes(key));
      const completedPlanRejected = ['planner_output_invalid', 'path_unsafe'].includes(failure?.errorCode) && failure.preDispatchSource === null
        && Object.keys(failure).every((key) => ['errorCode', 'preDispatchSource', 'providerFailure'].includes(key))
        && failure.providerFailure?.execution === null && failure.providerFailure?.terminalTurn === null;
      if (!localPreDispatchFailure && !terminalSchemaFailure && !completedPlanRejected) refuse();
      const fact = this.db.prepare(`SELECT identity_json,start_json,terminal_json FROM concurrent_planner_execution_facts
        WHERE project_id=? AND session_id=? AND turn_id=?`).get(this.projectId, turn.session_id, turn.turn_id);
      if (!fact) refuse();
      let identity;
      try { identity = JSON.parse(fact.identity_json); } catch (_) { refuse(); }
      if (identity.projectId !== this.projectId || identity.sessionId !== turn.session_id || identity.turnId !== turn.turn_id
        || identity.providerThreadId !== turn.provider_thread_id || identity.providerScope !== turn.provider_scope
        || !Number.isSafeInteger(identity.ownerGeneration) || identity.ownerGeneration < 0
        || pins.ownerGeneration !== identity.ownerGeneration || turn.provider_scope !== `lead:${this.projectId}:${turn.session_id}:${provider.accountId}:${provider.codexHome}`) refuse();
      let terminalProof = null;
      if (localPreDispatchFailure) {
        if (fact.start_json !== null || fact.terminal_json !== null
          || (typeof this.appServer.getCodexHome === 'function' && this.appServer.getCodexHome() !== null)) refuse();
      } else if (terminalSchemaFailure) {
        if (fact.start_json === null) refuse();
        let start;
        try { start = JSON.parse(fact.start_json); } catch (_) { refuse(); }
        if (start.threadId !== turn.provider_thread_id || !start.processIdentity
          || !phase.identities.some((savedIdentity) => canonical(savedIdentity) === canonical(start.processIdentity))
          || !isProcessGroupGone(start.processIdentity)) refuse();
        terminalProof = await this.#readFailedSchemaTurn(turn.provider_thread_id);
        if (!terminalProof) refuse();
        if (fact.terminal_json) {
          let savedTerminal;
          try { savedTerminal = JSON.parse(fact.terminal_json); } catch (_) { refuse(); }
          if (savedTerminal.threadId !== turn.provider_thread_id || savedTerminal.turnId !== terminalProof.turnId
            || savedTerminal.status !== 'failed' || savedTerminal.terminalTurn?.status !== 'failed') refuse();
        }
      } else if (completedPlanRejected) {
        if (fact.start_json === null || fact.terminal_json === null) refuse();
        let start;
        let terminal;
        try { start = JSON.parse(fact.start_json); terminal = JSON.parse(fact.terminal_json); } catch (_) { refuse(); }
        const execution = terminal.execution;
        const cleanup = execution?.cleanupReceipt;
        if (start.threadId !== turn.provider_thread_id || !start.processIdentity
          || !phase.identities.some((savedIdentity) => canonical(savedIdentity) === canonical(start.processIdentity))
          || !isProcessGroupGone(start.processIdentity)
          || terminal.threadId !== turn.provider_thread_id || terminal.status !== 'completed' || !terminal.turnId
          || execution.threadId !== turn.provider_thread_id || execution.turnId !== terminal.turnId
          || execution.turnStartSent !== true || execution.turnStartRejected !== false || execution.turnTerminal !== true
          || execution.generation !== cleanup?.generation || canonical(start.processIdentity) !== canonical(execution.processIdentity)
          || cleanup.method !== 'thread/backgroundTerminals/clean' || cleanup.scope !== 'provider-managed-background-terminals'
          || cleanup.completion !== 'confirmed' || cleanup.threadId !== turn.provider_thread_id || cleanup.turnId !== terminal.turnId
          || canonical(cleanup.processIdentity) !== canonical(start.processIdentity)) refuse();
        terminalProof = await this.#readCompletedPlannerTurn(turn.provider_thread_id, terminal.turnId);
        if (!terminalProof) refuse();
      }
      const matchingRuns = this.db.prepare(`SELECT r.run_id,r.objective_id,r.session_id,r.status,r.lead_thread_id,r.lead_codex_home,r.lead_settings_json
        FROM concurrent_delivery_runs r JOIN delivery_run_engines m ON m.project_id=r.project_id AND m.run_id=r.run_id
        WHERE r.project_id=? AND r.session_id=? AND m.engine='concurrent-v1'`).all(this.projectId, turn.session_id);
      const runs = matchingRuns.filter((candidate) => {
        if (!['running', 'paused', 'canceled'].includes(candidate.status) || candidate.lead_thread_id !== turn.provider_thread_id
          || candidate.lead_codex_home !== provider.codexHome || !candidate.lead_settings_json) return false;
        let settings;
        try { settings = JSON.parse(candidate.lead_settings_json); } catch (_) { return false; }
        return settings.threadId === candidate.lead_thread_id && settings.codexHome === provider.codexHome
          && settings.accountId === provider.accountId && settings.transportKey === turn.provider_scope;
      });
      if (runs.length !== 1) refuse();
      const run = runs[0];
      const objective = this.store.getObjective(this.projectId, run.objective_id);
      const allowedDispositions = completedPlanRejected ? ['paused_owner', 'canceled'] : ['canceled'];
      if (!objective || !allowedDispositions.includes(objective.disposition) || objective.sessionId !== turn.session_id
        || objective.ownerGeneration !== identity.ownerGeneration) refuse();
      if (!allowedTurnsByObjective.has(run.objective_id)) allowedTurnsByObjective.set(run.objective_id, new Set());
      allowedTurnsByObjective.get(run.objective_id).add(turn.turn_id);
      proofs.push({ turn, identity, failure, fact, terminalProof });
    }

    // Reuse the proven shutdown settlement path before checking lifecycle release.
    // A persisted terminal attempt is recoverable only with its original process proof.
    await this.#settleShutdownAttempts(phase);
    const storedRuns = this.db.prepare('SELECT run_id,objective_id,session_id FROM concurrent_delivery_runs WHERE project_id=? ORDER BY run_id').all(this.projectId);
    for (const stored of storedRuns) {
      const current = this.store.getObjective(this.projectId, stored.objective_id);
      if (!current) refuse();
      const inbox = new DeliveryInbox(this.db, { projectId: this.projectId, objectiveId: stored.objective_id, sessionId: stored.session_id });
      const lifecycle = new DeliveryLifecycle({ store: this.store, executor: this.executor,
        projectId: this.projectId, objectiveId: stored.objective_id, sessionId: stored.session_id, inbox,
        ownerGeneration: current.ownerGeneration, controlRevision: current.controlRevision,
        getAdmissionState: () => ({ admissionStopped: true, controllerWorkInFlight: false }),
        effectsSettledForShutdown: ({ objective: item, attempts }) => this.#effectsSettled(item, attempts) });
      const projection = lifecycle.shutdownProjection();
      lifecycle.close();
      const allowed = allowedTurnsByObjective.get(stored.objective_id) || new Set();
      const allowedPlannerOnly = projection.plannerTurns.length > 0 && projection.plannerTurns.length === allowed.size
        && projection.plannerTurns.every((plannerTurn) => allowed.has(plannerTurn.turn_id))
        && projection.reasons.every((reason) => reason === 'live_or_unknown_planner_turn');
      if (!projection.safeToRelease && !allowedPlannerOnly) refuse();
    }

    const changed = this.db.transaction(() => {
      for (const { turn, identity, failure, fact, terminalProof } of proofs) {
        const proof = { state: 'reconciled_no_effect', source: terminalProof ? 'codex_app_server.thread_read' : 'switching_app_server.expected_home_preflight',
          originalResult: failure, projectId: this.projectId, sessionId: turn.session_id, turnId: turn.turn_id,
          providerScope: turn.provider_scope, providerThreadId: turn.provider_thread_id, ownerGeneration: identity.ownerGeneration,
          oldProviderGroupsGone: true, providerDispatchStarted: Boolean(terminalProof), ...(terminalProof ? { terminalProof } : {}) };
        const result = this.db.prepare(`UPDATE delivery_planner_turns SET status='reconciled_no_effect',result_json=?,updated_at=?
          WHERE project_id=? AND session_id=? AND provider_scope=? AND provider_thread_id=? AND turn_id=? AND status='unknown' AND result_json=?`)
          .run(canonical(proof), this.now(), this.projectId, turn.session_id, turn.provider_scope, turn.provider_thread_id, turn.turn_id, turn.result_json);
        if (result.changes !== 1) refuse();
        if (terminalProof && fact.terminal_json === null) {
          const factUpdate = this.db.prepare(`UPDATE concurrent_planner_execution_facts SET terminal_json=?
            WHERE project_id=? AND session_id=? AND turn_id=? AND terminal_json IS NULL`)
            .run(canonical(terminalProof), this.projectId, turn.session_id, turn.turn_id);
          if (factUpdate.changes !== 1) refuse();
        }
      }
      return proofs.length;
    }).immediate();
    const result = await this.finishShutdown();
    this.shutdownRequested = false;
    return { state: 'recovered', reconciledTurns: changed, shutdown: result };
  }

  async #readFailedSchemaTurn(threadId) {
    if (typeof this.appServer._request !== 'function') return null;
    let response;
    try { response = await this.appServer._request('thread/read', { threadId, includeTurns: true }); }
    catch (_) { return null; }
    const thread = response?.thread;
    if (!thread || thread.id !== threadId || !Array.isArray(thread.turns) || thread.turns.length !== 1) return null;
    const turn = thread.turns[0];
    if (!turn || typeof turn.id !== 'string' || !turn.id || turn.status !== 'failed'
      || !turn.error || typeof turn.error.message !== 'string' || !Array.isArray(turn.items) || turn.items.length !== 1
      || turn.items[0]?.type !== 'userMessage' || typeof turn.items[0]?.id !== 'string') return null;
    let body;
    try { body = JSON.parse(turn.error.message); } catch (_) { return null; }
    const providerError = body?.error;
    if (body?.status !== 400 || body?.type !== 'error' || providerError?.type !== 'invalid_request_error'
      || providerError?.code !== 'invalid_json_schema' || providerError?.param !== 'text.format.schema'
      || providerError?.message !== "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas.") return null;
    return { threadId, turnId: turn.id, status: 'failed', error: {
      code: providerError.code, type: providerError.type, param: providerError.param, message: providerError.message,
    }, items: [{ type: 'userMessage', id: turn.items[0].id }], source: 'thread/read' };
  }

  async #readCompletedPlannerTurn(threadId, expectedTurnId) {
    if (typeof this.appServer._request !== 'function') return null;
    let response;
    try { response = await this.appServer._request('thread/read', { threadId, includeTurns: true }); }
    catch (_) { return null; }
    const thread = response?.thread;
    if (!thread || thread.id !== threadId || !Array.isArray(thread.turns) || thread.turns.length !== 1) return null;
    const turn = thread.turns[0];
    if (!turn || turn.id !== expectedTurnId || turn.status !== 'completed' || !Array.isArray(turn.items)
      || turn.items.length !== 3 || turn.items[0]?.type !== 'userMessage'
      || turn.items[1]?.type !== 'reasoning' || turn.items[2]?.type !== 'agentMessage') return null;
    return { threadId, turnId: turn.id, status: 'completed', items: turn.items.map((item) => ({ type: item.type, id: item.id || null })), source: 'thread/read' };
  }

  async recoverStoredRuns() {
    const rows = this.db.prepare("SELECT run_id FROM concurrent_delivery_runs WHERE project_id=? AND status IN ('prepared','running','paused','recovering') ORDER BY created_at,run_id")
      .all(this.projectId);
    const results = [];
    for (const row of rows) {
      const run = this.#run(row.run_id);
      if (!run) continue;
      const objective = this.store.getObjective(this.projectId, run.objectiveId);
      if (!objective || ['accepted', 'partial', 'canceled'].includes(objective.disposition)) continue;
      try {
        if (this.#leadProviderChanged(run)) {
          const eligibility = this.#providerResumeEligibility(run, objective);
          if (!eligibility.safe) throw error('concurrent_provider_identity_changed_unresolved', eligibility.reason);
          results.push({ runId: row.run_id, state: 'dormant', reason: 'provider_identity_changed' });
          continue;
        }
        const controller = await this.#controller(run, { prepareThread: false });
        if (objective.disposition === 'planning' || objective.disposition === 'executing') controller.start();
        results.push({ runId: row.run_id, state: controller.status().lastRecovery?.state || 'started' });
      } catch (cause) { results.push({ runId: row.run_id, state: 'unknown', reason: cause.code || 'recovery_failed' }); }
    }
    return results;
  }

  async run(input = {}) { return this.#runFacade(input, false); }
  async resume(input = {}) { return this.#runFacade(input, true); }

  activeRuns() {
    return [...this.controllers.entries()].filter(([, controller]) => controller.running || controller.cycle)
      .map(([runId, controller]) => ({ runId, pauseRequested: Boolean(controller.status().lifecycle?.cause === 'owner_pause'),
        engine: 'concurrent-v1', projectId: this.projectId, objectiveId: controller.objectiveId, sessionId: controller.sessionId }));
  }

  getRunEngine(runId) { return this.#run(runId) ? 'concurrent-v1' : null; }
  getRunGoal(runId) { return this.#run(runId)?.goal || null; }
  getRunDigest(runId) {
    const run = this.#run(runId);
    const objective = run && this.store.getObjective(this.projectId, run.objectiveId);
    return run ? { runId, goal: run.goal, objectiveId: run.objectiveId, disposition: objective?.disposition || 'unknown',
      candidateId: this.#latestCandidate(run.objectiveId)?.candidateId || null, failureEvidence: run.failure || null } : null;
  }
  isResumable(runId) { const objective = this.#objectiveForRun(runId); return Boolean(objective && !['accepted', 'partial', 'canceled'].includes(objective.disposition)); }
  getPause(runId) {
    const run = this.#run(runId);
    const objective = run && this.store.getObjective(this.projectId, run.objectiveId);
    if (!objective || ['accepted', 'partial', 'canceled'].includes(objective.disposition)) return null;
    const pendingDecision = this.store.pendingOwnerDecision(this.projectId, run.objectiveId);
    if (pendingDecision) return { kind: 'owner_decision', message: pendingDecision.request.question, decision: pendingDecision, replyPins: this.store.ownerDecisionPins(this.projectId, run.objectiveId) };
    return run.pause || (objective.disposition === 'paused_owner' ? { kind: 'owner_pause', message: 'Paused by the owner' }
      : objective.disposition === 'waiting_budget' ? { kind: 'waiting_for_budget', message: 'Waiting for provider budget' }
        : objective.disposition === 'blocked_technical' ? { kind: 'error', message: 'Concurrent delivery is blocked by an unresolved effect or failed task.' } : null);
  }
  requestPause(runId) {
    const controller = this.controllers.get(runId);
    if (!controller || !controller.running) return false;
    try { controller.pauseObjective(); this.#saveStatus(runId, 'paused'); return true; } catch (_) { return false; }
  }
  cancelPauseRequest(runId) {
    const controller = this.controllers.get(runId);
    if (!controller || this.store.getObjective(this.projectId, controller.objectiveId)?.disposition !== 'paused_owner') return false;
    try { controller.resumeObjective(); this.#saveStatus(runId, 'running'); return true; } catch (_) { return false; }
  }
  consumeCompletedPauseRequest() { return false; }
  getRecoveryCheckpoint(runId) {
    const controller = this.controllers.get(runId);
    if (!controller) return null;
    const status = controller.status();
    return { checkpointId: status.lastPlanner?.turnId || null, next: status.inbox?.wakeup ? ['plan'] : [], unresolvedWriters: status.scheduler?.counts?.unknown ?? 0 };
  }

  async steer(input = {}) {
    const fields = ['runId', 'projectId', 'sessionId', 'objectiveId', 'messageId', 'text', 'expectedPlanRevision', 'expectedGoalRevision', 'expectedControlRevision'];
    if (!input || Object.keys(input).sort().join('|') !== fields.slice().sort().join('|')) throw error('steer_fields_invalid');
    const run = this.#run(input.runId);
    if (!run || input.projectId !== this.projectId || input.sessionId !== run.sessionId || input.objectiveId !== run.objectiveId) throw error('steer_scope_mismatch');
    let controller = this.controllers.get(input.runId);
    let inbox = controller?.inbox || new DeliveryInbox(this.db, {
      projectId: this.projectId, objectiveId: run.objectiveId, sessionId: run.sessionId,
    });
    const message = { messageId: input.messageId, kind: 'steering', source: 'authenticated-control',
      payload: { text: input.text, expectedPlanRevision: input.expectedPlanRevision,
        expectedGoalRevision: input.expectedGoalRevision, expectedControlRevision: input.expectedControlRevision } };
    if (inbox.get(input.messageId)) {
      const ack = inbox.receive(message);
      return { ...ack, engine: 'concurrent-v1', runId: input.runId, projectId: this.projectId,
        sessionId: run.sessionId, objectiveId: run.objectiveId };
    }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12000) throw error('steer_text_invalid');
    const objective = this.store.getObjective(input.projectId, input.objectiveId);
    this.#assertSteerRevisions(objective, input);
    if (!controller || controller.shutdownRequested) controller = await this.#controller(run, { prepareThread: false });
    inbox = controller.inbox;
    const tx = this.db.transaction(() => {
      const currentRun = this.#run(input.runId);
      if (!currentRun || input.projectId !== this.projectId || input.sessionId !== currentRun.sessionId
        || input.objectiveId !== currentRun.objectiveId) throw error('steer_scope_mismatch');
      const ack = inbox.receive(message);
      if (ack.duplicate) return ack;
      this.#assertSteerRevisions(this.store.getObjective(input.projectId, input.objectiveId), input);
      return ack;
    });
    const ack = tx.immediate();
    if (!ack.duplicate) controller.wake();
    return { ...ack, engine: 'concurrent-v1', runId: input.runId, projectId: this.projectId,
      sessionId: run.sessionId, objectiveId: run.objectiveId };
  }

  #revalidateOwnerInvestigation(facts) {
    if (!this.ownerDecisionAuthorization) return null;
    const attempt = facts.attempt;
    const record = this.roleService.getExecution(attempt.attemptId);
    const row = this.db.prepare('SELECT release_facts_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND attempt_id=?')
      .get(facts.projectId, facts.objectiveId, attempt.attemptId);
    const release = row?.release_facts_json && JSON.parse(row.release_facts_json);
    if (!record || record.state !== 'settled' || record.effectsSettled !== true || record.projectId !== facts.projectId
      || record.objectiveId !== facts.objectiveId || record.attemptId !== attempt.attemptId
      || record.contractDigest !== attempt.contractDigest || record.ownerGeneration !== attempt.executionGeneration
      || record.providerContextId !== attempt.providerContextId || record.externalTaskId !== attempt.externalTaskId
      || release?.producerExecutionId !== attempt.attemptId || release.reportDigest !== record.result?.reportDigest
      || record.result.reportDigest !== `sha256:${sha256(canonical(record.report))}`
      || release.requestDigest !== record.requestDigest || release.selectedSettingsDigest !== record.settingsDigest
      || !attempt.evidenceRefs.includes(`delivery-role-execution:${record.attemptId}`)) return null;
    const base = this.candidateStore.get(record.baseCandidateId);
    const manifest = base && this.candidateStore.readManifest(base.manifestDigest);
    if (!manifest || base.projectId !== facts.projectId || base.objectiveId !== facts.objectiveId
      || attempt.contractSnapshot.baseCandidateId !== base.candidateId) return null;
    let observed;
    try { observed = captureManifest(this.workspace); } catch (_) { return null; }
    if (observed.digest !== manifest.digest) return null;
    return { state: 'revalidated', originalRequestDigest: facts.originalRequestDigest, currentPins: facts.currentPins,
      attemptId: attempt.attemptId, originalOwnerGeneration: attempt.executionGeneration,
      originalControls: attempt.capturedControls, reportDigest: record.result.reportDigest,
      candidateId: base.candidateId, manifestDigest: manifest.digest, observedDigest: observed.digest };
  }

  async controlOwnerDecision(input, { replace = false } = {}) {
    if (this.shutdownRequested) throw error('concurrent_shutdown_admission_closed');
    const run = this.#run(input?.runId);
    if (!run || input.projectId !== this.projectId || input.sessionId !== run.sessionId || input.objectiveId !== run.objectiveId) throw error('owner_decision_scope_mismatch');
    const inbox = this.controllers.get(run.runId)?.inbox || new DeliveryInbox(this.db, {
      projectId: this.projectId, objectiveId: run.objectiveId, sessionId: run.sessionId });
    const transaction = this.db.transaction(() => {
      this.ownerDecisionAuthorization = canonical({ projectId: this.projectId, objectiveId: run.objectiveId,
        action: replace ? 'replace' : 'respond', input });
      let result;
      try { result = this.store.controlOwnerDecision(this.projectId, run.objectiveId, input, { replace }); }
      finally { this.ownerDecisionAuthorization = null; }
      if (!result.duplicate && result.resume) inbox.signal(`owner.decision:${result.decision.digest.slice(7, 31)}`);
      return result;
    });
    const result = transaction.immediate();
    if (!result.duplicate && result.resume) {
      let controller = this.controllers.get(run.runId);
      if (controller && controller.ownerGeneration !== this.store.getObjective(this.projectId, run.objectiveId).ownerGeneration) {
        controller.stop(); this.controllers.delete(run.runId); controller = null;
      }
      controller = controller || await this.#controller(run, { prepareThread: false });
      controller.adoptOwnerDecisionControl();
      controller.start(); controller.wake();
    } else {
      const controller = this.controllers.get(run.runId);
      if (!result.duplicate && controller?.ownerGeneration === this.store.getObjective(this.projectId, run.objectiveId).ownerGeneration) controller.adoptOwnerDecisionControl();
    }
    return { ...result, engine: 'concurrent-v1', runId: run.runId, projectId: this.projectId,
      sessionId: run.sessionId, objectiveId: run.objectiveId };
  }

  #ownerDecisionWait(run) {
    const decision = this.store.pendingOwnerDecision(this.projectId, run.objectiveId);
    if (!decision) return null;
    const pause = { kind: 'owner_decision', message: decision.request.question, decision,
      replyPins: this.store.ownerDecisionPins(this.projectId, run.objectiveId) };
    this.#saveStatus(run.runId, 'paused');
    return { runId: run.runId, status: 'input_required', text: pause.message, pause, rounds: 0, assignments: [] };
  }

  controlStatus(runId) {
    const run = this.#run(runId);
    if (!run) return null;
    const objective = this.store.getObjective(this.projectId, run.objectiveId);
    const inbox = this.controllers.get(runId)?.inbox || new DeliveryInbox(this.db, {
      projectId: this.projectId, objectiveId: run.objectiveId, sessionId: run.sessionId,
    });
    const messages = inbox.messages({ limit: CONTROL_MESSAGE_LIMIT }).map((message) => ({ messageId: message.messageId,
      kind: message.kind, state: message.state, receivedAt: message.receivedAt, updatedAt: message.updatedAt,
      result: message.result }));
    return { engine: 'concurrent-v1', runId, projectId: this.projectId, sessionId: run.sessionId,
      objectiveId: run.objectiveId, ownerDecisions: this.store.listOwnerDecisions(this.projectId, run.objectiveId),
      decisionReplyPins: this.store.ownerDecisionPins(this.projectId, run.objectiveId),
      revisions: objective ? { planRevision: objective.planRevision,
        goalRevision: objective.goalRevision, controlRevision: objective.controlRevision,
        ownerGeneration: objective.ownerGeneration } : null,
      inbox: inbox.messages(), messages, pending: inbox.pending(), disposition: objective?.disposition || 'missing' };
  }

  runtimeProjection() {
    return { engine: 'concurrent-v1', projectId: this.projectId, writerIsolation: this.lanes.status(),
      roleExecutions: this.roleService.projection(), activeRuns: this.activeRuns(),
      capacity: this.store.projectCapacity(this.projectId) };
  }

  fenceShutdown({ durable = true } = {}) {
    const alreadyRequested = this.shutdownRequested;
    this.shutdownRequested = true;
    if (durable) this.db.prepare(`INSERT INTO concurrent_shutdown_phases(project_id,phase_json) VALUES(?,?)
      ON CONFLICT(project_id) DO UPDATE SET phase_json=excluded.phase_json
      WHERE json_extract(concurrent_shutdown_phases.phase_json,'$.phase')='released' AND ?=0`)
      .run(this.projectId, canonical({ phase: 'draining', attempts: [], identities: [] }), alreadyRequested ? 1 : 0);
    for (const controller of this.controllers.values()) controller.shutdown({ pause: false });
  }

  async prepareShutdown() {
    this.fenceShutdown();
    if (this.shutdownPreparation) return this.shutdownPreparation;
    const operation = this.#prepareShutdown();
    this.shutdownPreparation = operation;
    try { return await operation; }
    finally { if (this.shutdownPreparation === operation) this.shutdownPreparation = null; }
  }

  async #prepareShutdown() {
    for (const controller of this.controllers.values()) {
      if (controller.cycle) await controller.cycle;
      if (controller.scheduler.runPromise) await controller.scheduler.runPromise;
      await Promise.allSettled([...controller.scheduler.inFlight.values()]);
    }
    await this.#drainRoleCalls();
    if (this.roleService.active.size) throw error('concurrent_shutdown_unsafe');
    const saved = this.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(this.projectId);
    const phase = saved ? JSON.parse(saved.phase_json) : { phase: 'prepared', attempts: [], identities: [] };
    if (phase.phase === 'draining') phase.phase = 'prepared';
    for (const execution of this.roleService.projection()) {
      const record = this.roleService.getExecution(execution.attemptId);
      if (!record) continue;
      const objective = this.store.getObjective(this.projectId, record.objectiveId);
      const identity = { projectId: this.projectId, objectiveId: record.objectiveId, taskId: record.taskId,
        attemptId: record.attemptId, fencingToken: record.fencingToken, recoveryGeneration: objective?.ownerGeneration };
      try {
        const prepared = this.roleService.prepareTerminalShutdown(identity);
        if (!phase.attempts.some((entry) => entry.attemptId === identity.attemptId)) phase.attempts.push(identity);
        if (!phase.identities.some((entry) => canonical(entry) === canonical(prepared.processIdentity))) phase.identities.push(prepared.processIdentity);
      } catch (_) { /* Ineligible attempts remain owned for final lifecycle refusal. */ }
    }
    if (this.shutdownInitialProcessIdentity && !phase.identities.some((entry) => canonical(entry) === canonical(this.shutdownInitialProcessIdentity))) {
      phase.identities.push(copy(this.shutdownInitialProcessIdentity));
    }
    const current = phase.phase === 'provider_closing' ? null : this.appServer.processIdentity?.();
    if (current && !phase.identities.some((entry) => canonical(entry) === canonical(current))) phase.identities.push(copy(current));
    this.db.prepare(`INSERT INTO concurrent_shutdown_phases(project_id,phase_json) VALUES(?,?)
      ON CONFLICT(project_id) DO UPDATE SET phase_json=excluded.phase_json`).run(this.projectId, canonical(phase));
    return copy(phase);
  }

  beginProviderShutdown() {
    const saved = this.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(this.projectId);
    if (!saved || !this.shutdownRequested) throw error('concurrent_shutdown_not_prepared');
    const phase = JSON.parse(saved.phase_json);
    if (!['prepared', 'provider_closing'].includes(phase.phase)) throw error('concurrent_shutdown_not_prepared');
    phase.phase = 'provider_closing';
    this.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?').run(canonical(phase), this.projectId);
  }

  async finishShutdown() {
    const saved = this.db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').get(this.projectId);
    if (!this.shutdownRequested || !saved) throw error('concurrent_shutdown_not_prepared');
    const phase = JSON.parse(saved.phase_json);
    if (phase.phase !== 'provider_closing') throw error('concurrent_shutdown_provider_not_closing');
    if (phase.identities.some((identity) => !isProcessGroupGone(identity))) throw error('concurrent_shutdown_process_alive');
    await this.#settleShutdownAttempts(phase);
    const result = await this.shutdown({ prepared: true });
    phase.phase = 'released';
    this.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?').run(canonical(phase), this.projectId);
    return result;
  }

  async #settleShutdownAttempts(phase) {
    for (const identity of phase.attempts) {
      if (identity.projectId !== this.projectId) throw error('concurrent_startup_recovery_unsafe');
      const prepared = this.roleService.prepareTerminalShutdown(identity);
      if (!phase.identities.some((saved) => canonical(saved) === canonical(prepared.processIdentity))
        || !isProcessGroupGone(prepared.processIdentity)) throw error('concurrent_startup_recovery_unsafe');
    }
    for (const identity of phase.attempts) {
      await this.roleService.prepareTerminalFailure(identity);
      const attempt = this.store.listAttempts(this.projectId, identity.objectiveId).find((entry) => entry.attemptId === identity.attemptId);
      if (!['failed', 'canceled'].includes(attempt?.state)) {
        this.store.requestLifecycleRecovery(this.projectId, identity.objectiveId, identity.recoveryGeneration);
      }
      this.executor.reconcileTerminalFailure(identity);
    }
    this.#settleUndispatchedReviews(phase);
  }

  #settleUndispatchedReviews(phase) {
    if (!this.shutdownRequested || phase.phase !== 'provider_closing'
      || phase.identities.some((identity) => !isProcessGroupGone(identity)) || this.roleService.active.size) {
      throw error('concurrent_startup_recovery_unsafe');
    }
    for (const controller of this.controllers.values()) {
      if (controller.cycle || controller.scheduler.runPromise || controller.scheduler.inFlight.size) {
        throw error('concurrent_startup_recovery_unsafe');
      }
    }
    const absent = (attemptId) => ['task_executor_attempts', 'dispatch_journal', 'delivery_role_executions',
      'task_executor_thread_reservations', 'delivery_output_bindings'].every((table) =>
      !this.db.prepare(`SELECT 1 FROM ${table} WHERE attempt_id=? LIMIT 1`).get(attemptId));
    const runs = this.db.prepare('SELECT objective_id FROM concurrent_delivery_runs WHERE project_id=?').all(this.projectId);
    for (const { objective_id: objectiveId } of runs) {
      const settle = this.db.transaction(() => {
        const objective = this.store.getObjective(this.projectId, objectiveId);
        if (!objective || !['paused_owner', 'blocked_technical', 'canceled'].includes(objective.disposition)) return;
        const claims = this.store.listClaims(this.projectId, objectiveId).filter((claim) => ['active', 'expired', 'fenced'].includes(claim.state));
        if (!claims.length) return;
        const attempts = this.store.listAttempts(this.projectId, objectiveId);
        const eligible = claims.map((claim) => {
          const attempt = attempts.find((entry) => entry.attemptId === claim.attemptId);
          const task = objective.tasks.find((entry) => entry.taskId === claim.taskId);
          const contract = attempt?.contractSnapshot;
          if (!attempt || !task || !contract || task.role !== 'verifier' || task.kind !== 'review'
            || task.productWritePaths.length !== 0 || task.publicationAuthority?.state !== 'denied'
            || !['claimed', 'unknown'].includes(attempt.state) || !['claimed', 'settling'].includes(task.state)
            || attempt.externalTaskId || attempt.threadId || attempt.executionGeneration !== objective.ownerGeneration
            || claim.ownerGeneration !== objective.ownerGeneration || claim.taskId !== attempt.taskId
            || claim.fencingToken !== attempt.fencingToken || task.revision !== attempt.taskRevision
            || stableDigest(contract) !== attempt.contractDigest
            || stableDigest({ ...task, state: contract.state }) !== attempt.contractDigest || !absent(attempt.attemptId)) return null;
          return { claim, attempt };
        });
        // An unresolved dispatched sibling keeps the whole objective owned.
        if (eligible.some((entry) => !entry)) return;
        this.store.requestLifecycleRecovery(this.projectId, objectiveId, objective.ownerGeneration);
        for (const { claim, attempt } of eligible) {
          this.store.settleRecoveredNoEffect(this.projectId, objectiveId, attempt.attemptId, attempt.fencingToken, {
            projectId: this.projectId, objectiveId, taskId: attempt.taskId, attemptId: attempt.attemptId,
            fencingToken: attempt.fencingToken, claimOwnerGeneration: claim.ownerGeneration,
            recoveryGeneration: objective.ownerGeneration, providerContextId: attempt.providerContextId, intentState: null,
            noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true,
            evidenceRefs: [`concurrent-shutdown:undispatched-review:${attempt.attemptId}:${attempt.contractDigest}`],
          });
        }
      });
      settle.immediate();
    }
  }

  async shutdown({ prepared = false } = {}) {
    this.fenceShutdown({ durable: false });
    const projections = [];
    const controllers = [...this.controllers.entries()];
    for (const [, controller] of controllers) controller.shutdown({ pause: false });
    for (const [, controller] of controllers) {
      if (controller.cycle) await controller.cycle;
      if (controller.scheduler.runPromise) await controller.scheduler.runPromise;
      await Promise.allSettled([...controller.scheduler.inFlight.values()]);
    }
    await this.#drainRoleCalls();
    const stored = this.db.prepare('SELECT run_id FROM concurrent_delivery_runs WHERE project_id=? ORDER BY run_id').all(this.projectId);
    for (const { run_id: runId } of stored) {
      const run = this.#run(runId);
      if (!prepared) await this.#recoverDrainedRoleAttempts(run);
      const controller = this.controllers.get(runId);
      if (controller) {
        const projection = controller.lifecycle.shutdownProjection();
        projections.push({ runId, ...projection });
        if (projection.safeToRelease !== true) throw Object.assign(error('concurrent_shutdown_unsafe'), { projections });
        continue;
      }
      const objective = this.store.getObjective(this.projectId, run.objectiveId);
      if (!objective) throw error('concurrent_objective_missing');
      const inbox = new DeliveryInbox(this.db, { projectId: this.projectId, objectiveId: run.objectiveId, sessionId: run.sessionId });
      const lifecycle = new DeliveryLifecycle({ store: this.store, executor: this.executor,
        projectId: this.projectId, objectiveId: run.objectiveId, sessionId: run.sessionId, inbox,
        ownerGeneration: objective.ownerGeneration, controlRevision: objective.controlRevision,
        getAdmissionState: () => ({ admissionStopped: true, controllerWorkInFlight: false }),
        effectsSettledForShutdown: ({ objective: current, attempts }) => this.#effectsSettled(current, attempts) });
      const projection = lifecycle.shutdownProjection();
      lifecycle.close();
      projections.push({ runId, ...projection });
      if (projection.safeToRelease !== true) throw Object.assign(error('concurrent_shutdown_unsafe'), { projections });
    }
    return { engine: 'concurrent-v1', projectId: this.projectId, safeToRelease: true, projections };
  }

  async #recoverDrainedRoleAttempts(run) {
    const objective = this.store.getObjective(this.projectId, run.objectiveId);
    if (!objective) throw error('concurrent_objective_missing');
    const prepared = [];
    for (const attempt of this.store.listAttempts(this.projectId, run.objectiveId)) {
      if (['succeeded', 'failed', 'canceled'].includes(attempt.state)) continue;
      const identity = { projectId: this.projectId, objectiveId: run.objectiveId, taskId: attempt.taskId,
        attemptId: attempt.attemptId, fencingToken: attempt.fencingToken, recoveryGeneration: objective.ownerGeneration };
      try { await this.roleService.prepareNoPublicationRecovery(identity); }
      catch (_) { continue; }
      prepared.push(identity);
    }
    if (!prepared.length) return;
    this.store.requestLifecycleRecovery(this.projectId, run.objectiveId, objective.ownerGeneration);
    for (const identity of prepared) this.executor.recover(identity);
  }

  async #runFacade(input, isResume) {
    if (this.shutdownRequested) throw error('concurrent_shutdown_admission_closed');
    const runId = requireId(input.runId, 'run_id');
    let run = this.#run(runId);
    if (!run && isResume) throw Object.assign(error('concurrent_run_missing'), { name: 'RunNotFoundError', runId });
    if (!run) run = this.#createRun(input);
    else if (!isResume && (input.goal !== undefined || input.contract !== undefined)) this.#assertSameIntake(run, input);
    let objective = this.store.getObjective(this.projectId, run.objectiveId);
    if (!objective) throw error('concurrent_objective_missing');
    if (['accepted', 'partial'].includes(objective.disposition)) return copy(run.result) || this.#terminalResult(run);
    if (objective.disposition === 'canceled') return { runId, status: 'canceled', text: 'Canceled by the owner.', rounds: 0, assignments: [] };
    const ownerWait = this.#ownerDecisionWait(run);
    if (ownerWait) return ownerWait;
    if (isResume) {
      let controller = this.controllers.get(runId);
      const providerChanged = this.#leadProviderChanged(run);
      if (providerChanged) {
        try { controller = await this.#resumeWithCurrentProvider(run, objective); }
        catch (cause) {
          if (['concurrent_resume_quiescence_unproven', 'concurrent_resume_blocked_technical_unproven'].includes(cause.code)) {
            return this.#blockedResumeResult(run, cause.message || 'provider_resume_unproven');
          }
          throw cause;
        }
      } else {
        if (objective.disposition === 'blocked_technical') {
          const eligibility = this.#providerResumeEligibility(run, objective);
          if (!eligibility.safe || !eligibility.blockedReview) return this.#blockedResumeResult(run, eligibility.reason || 'review_recovery_unproven');
          const resumed = this.store.resumeBlockedTechnical(this.projectId, run.objectiveId, {
            expectedOwnerGeneration: objective.ownerGeneration, expectedControlRevision: objective.controlRevision,
            ...eligibility.blockedReview,
          });
          if (controller) controller.shutdown({ pause: false });
          this.controllers.delete(runId);
          controller = await this.#controller(this.#run(runId), { prepareThread: false });
          controller.inbox.signal('owner.resume');
          objective = resumed;
        } else {
          if (!controller || controller.shutdownRequested) controller = await this.#controller(run, { prepareThread: false });
          controller.applyPendingOwnerCorrections();
          objective = this.store.getObjective(this.projectId, run.objectiveId);
          if (objective.disposition === 'paused_owner') {
            const control = this.store.getLifecycleControl(this.projectId, run.objectiveId);
            if (control?.cause === 'owner_pause' || control?.cause === 'owner_stop') controller.resumeObjective();
          }
        }
      }
      if (input.input?.answer || typeof input.input === 'string') {
        const text = typeof input.input === 'string' ? input.input : input.input.answer;
        if (text) controller.receive({ messageId: `resume-${sha256(`${runId}:${this.now()}`).slice(0, 32)}`,
          kind: 'steering', source: 'orchestrator-resume', payload: { text } });
      }
      controller.start();
    } else {
      await this.#controller(run, { prepareThread: true });
      const controller = this.controllers.get(runId);
      controller.inbox.signal('run.initial');
      controller.start();
    }
    this.#saveStatus(runId, 'running');
    return this.#waitForTerminal(run, input.signal);
  }

  #blockedResumeResult(run, reason) {
    const pause = { kind: 'error', message: 'Concurrent delivery remains blocked because safe review recovery could not be proven.',
      failureCode: 'concurrent_resume_blocked_technical_unproven', reasonCode: reason };
    this.#savePause(run.runId, pause);
    return { runId: run.runId, status: 'input_required', text: pause.message, pause, rounds: 0, assignments: [] };
  }

  #leadProviderChanged(run) {
    const lead = this.#leadThread(run);
    if (!lead || typeof lead.accountId !== 'string' || typeof lead.codexHome !== 'string') return false;
    const current = this.#providerIdentity();
    return lead.accountId !== current.accountId || lead.codexHome !== current.codexHome;
  }

  #providerResumeEligibility(run, objective) {
    const fail = (reason) => ({ safe: false, reason });
    if (!run || !objective || !['paused_owner', 'blocked_technical'].includes(objective.disposition)) return fail('objective_not_paused');
    const control = this.store.getLifecycleControl(this.projectId, run.objectiveId);
    const expectedCause = objective.disposition === 'blocked_technical' ? 'blocked_technical' : ['owner_pause', 'owner_stop'].includes(control?.cause) ? control.cause : null;
    if (!expectedCause || control?.ownerGeneration !== objective.ownerGeneration || control?.controlRevision !== objective.controlRevision) return fail('owner_control_changed');
    if (this.store.pendingOwnerDecision(this.projectId, run.objectiveId)) return fail('owner_decision_pending');
    const inboxStateTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_inbox_state'").get();
    const inboxMessageTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_inbox_messages'").get();
    if (!inboxStateTable || !inboxMessageTable) return fail('inbox_state_unavailable');
    const inbox = this.db.prepare(`SELECT version FROM delivery_inbox_state WHERE project_id=? AND session_id=? AND objective_id=?`)
      .get(this.projectId, run.sessionId, run.objectiveId);
    if (!inbox || this.db.prepare(`SELECT 1 FROM delivery_inbox_messages WHERE project_id=? AND session_id=? AND objective_id=?
      AND state IN ('received','blocked') LIMIT 1`).get(this.projectId, run.sessionId, run.objectiveId)) return fail('pending_inbox_control');
    if (this.controllers.get(run.runId)?.cycle || this.controllers.get(run.runId)?.planner?.inFlight
      || this.controllers.get(run.runId)?.scheduler?.runPromise || this.controllers.get(run.runId)?.scheduler?.inFlight?.size) return fail('controller_work_in_flight');
    if (this.store.listClaims(this.projectId, run.objectiveId).some((claim) => ['active', 'expired', 'fenced'].includes(claim.state))) return fail('claim_pending');
    const unsettledAttempts = this.store.listAttempts(this.projectId, run.objectiveId)
      .filter((attempt) => !['succeeded', 'failed', 'canceled'].includes(attempt.state));
    if (unsettledAttempts.length || !this.#effectsSettled(objective, unsettledAttempts)) return fail('workspace_effects_unsettled');
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get()) return fail('planner_ledger_unavailable');
    const turns = this.db.prepare(`SELECT status FROM delivery_planner_turns WHERE project_id=? AND session_id=?`)
      .all(this.projectId, run.sessionId);
    if (turns.some((turn) => !['complete', 'stale', 'reconciled_no_effect'].includes(turn.status))) return fail('planner_turn_unsettled');
    const recoveryTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_lifecycle_planner_recoveries'").get();
    if (!recoveryTable || this.db.prepare(`SELECT 1 FROM delivery_lifecycle_planner_recoveries WHERE project_id=? AND session_id=?
      AND state<>'reconciled' LIMIT 1`).get(this.projectId, run.sessionId)) return fail('planner_recovery_unsettled');
    if (this.store.listLifecycleRetries(this.projectId, run.objectiveId).length
      || this.store.listBudgetWaits(this.projectId, run.objectiveId).some((wait) => wait.state === 'waiting')) return fail('lifecycle_retry_pending');
    const blockedReview = objective.disposition === 'blocked_technical' ? this.#blockedTechnicalReviewProof(run, objective) : null;
    if (objective.disposition === 'blocked_technical' && !blockedReview) return fail('blocked_review_recovery_unproven');
    return { safe: true, inboxVersion: inbox.version, blockedReview };
  }

  #blockedTechnicalReviewProof(run, objective) {
    if (objective.tasks.some((task) => task.state === 'failed' || task.state === 'blocked')) return null;
    const ready = objective.tasks.filter((task) => ['draft', 'queued', 'ready'].includes(task.state));
    if (ready.length !== 1) return null;
    const task = ready[0];
    if (task.state !== 'queued' || task.role !== 'verifier' || task.kind !== 'review' || task.productWritePaths.length !== 0
      || task.publicationAuthority?.state !== 'denied' || !task.baseCandidateId
      || !this.reviewStore.isFrozenReview({ task })) return null;
    const candidate = this.candidateStore.get(task.baseCandidateId);
    if (!candidate || candidate.projectId !== this.projectId || candidate.objectiveId !== run.objectiveId || candidate.status !== 'known') return null;
    const attempts = this.store.listAttempts(this.projectId, run.objectiveId).filter((attempt) => attempt.taskId === task.taskId)
      .sort((left, right) => right.attemptNo - left.attemptNo);
    const attempt = attempts[0];
    if (!attempt || attempt.state !== 'canceled' || attempt.outcome?.failureKind !== 'reconciled_no_effect'
      || attempt.taskRevision !== task.revision || attempt.effect?.remoteQuiescent !== true
      || attempt.effect?.processQuiescent !== true || attempt.effect?.effectsSettled !== true) return null;
    const claim = this.store.listClaims(this.projectId, run.objectiveId).find((entry) => entry.attemptId === attempt.attemptId);
    const receiptRow = this.db.prepare(`SELECT terminal_digest,release_facts_json,contract_json FROM backlog_attempts
      WHERE project_id=? AND objective_id=? AND attempt_id=?`).get(this.projectId, run.objectiveId, attempt.attemptId);
    if (!claim || claim.state !== 'released' || claim.ownerGeneration !== objective.ownerGeneration
      || claim.taskId !== task.taskId || claim.fencingToken !== attempt.fencingToken || !receiptRow?.release_facts_json) return null;
    let receipt;
    try { receipt = JSON.parse(receiptRow.release_facts_json); } catch (_) { return null; }
    const evidenceRef = `concurrent-shutdown:undispatched-review:${attempt.attemptId}:${attempt.contractDigest}`;
    if (receipt.projectId !== this.projectId || receipt.objectiveId !== run.objectiveId || receipt.taskId !== task.taskId
      || receipt.attemptId !== attempt.attemptId || receipt.fencingToken !== attempt.fencingToken
      || receipt.claimOwnerGeneration !== claim.ownerGeneration || receipt.recoveryGeneration !== objective.ownerGeneration
      || receipt.providerContextId !== attempt.providerContextId || receipt.intentState !== null || receipt.noEffect !== true
      || receipt.remoteQuiescent !== true || receipt.processQuiescent !== true || receipt.effectsSettled !== true
      || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length !== 1 || receipt.evidenceRefs[0] !== evidenceRef
      || !attempt.evidenceRefs?.includes(evidenceRef)
      || receiptRow.terminal_digest !== stableDigest({ recoveryProof: receipt })) return null;
    let contract;
    try { contract = JSON.parse(receiptRow.contract_json); } catch (_) { return null; }
    if (attempt.contractDigest !== stableDigest(contract) || stableDigest({ ...task, state: contract.state }) !== attempt.contractDigest) return null;
    return { taskId: task.taskId, attemptId: attempt.attemptId, candidateId: candidate.candidateId };
  }

  async #resumeWithCurrentProvider(run, objective) {
    const prior = this.#leadThread(run);
    const eligibility = this.#providerResumeEligibility(run, objective);
    if (!eligibility.safe) throw error('concurrent_resume_quiescence_unproven', eligibility.reason);
    const providerBefore = this.#providerIdentity();
    if (!prior || (prior.accountId === providerBefore.accountId && prior.codexHome === providerBefore.codexHome)) {
      throw error('concurrent_provider_identity_changed');
    }
    const rawRunBefore = this.db.prepare(`SELECT lead_thread_id,lead_codex_home,lead_settings_json FROM concurrent_delivery_runs
      WHERE project_id=? AND run_id=?`).get(this.projectId, run.runId);
    if (!rawRunBefore?.lead_settings_json || rawRunBefore.lead_thread_id !== prior.threadId || rawRunBefore.lead_codex_home !== prior.codexHome) {
      throw error('concurrent_lead_thread_missing');
    }
    const settings = { model: this.leadRole.model, effort: this.leadRole.effort || this.leadRole.reasoningEffort || null,
      fast: this.leadRole.fast ?? this.leadRole.fastMode ?? null, executionPermissions: this.executionPermissions,
      selectedSkills: this.#leadSkills(), selectedMcpTools: this.#leadMcpTools(), codexHome: providerBefore.codexHome };
    const role = copy(this.leadRole);
    this.#assertRoleSettings(role, settings, 'concurrent_lead_settings_mismatch');
    const prepared = await this.appServer.prepareThread({ role, cwd: this.workspace, permissionWorkspace: this.workspace,
      selectedSkills: settings.selectedSkills, selectedMcpTools: settings.selectedMcpTools,
      executionPermissions: this.executionPermissions, ...(this.appServer.getCodexHome ? { captureCodexHome: true } : {}) });
    this.#assertRoleSettings(role, settings, 'concurrent_lead_settings_changed_during_prepare');
    const providerAfter = this.#providerIdentity();
    const actualHome = prepared.codexHome ?? providerAfter.codexHome;
    if (providerAfter.accountId !== providerBefore.accountId || actualHome !== providerBefore.codexHome) {
      throw error('concurrent_provider_identity_changed_during_prepare');
    }
    if (typeof prepared.threadId !== 'string' || !prepared.threadId || prepared.threadId === prior.threadId) throw error('concurrent_lead_thread_not_fresh');
    const nextLead = { threadId: prepared.threadId, accountId: providerBefore.accountId, codexHome: actualHome,
      settings, settingsDigest: stableDigest(settings), transportKey: `lead:${this.projectId}:${run.sessionId}:${providerBefore.accountId}:${actualHome}` };
    const tx = this.db.transaction(() => {
      const currentRun = this.#run(run.runId);
      const currentObjective = this.store.getObjective(this.projectId, run.objectiveId);
      const currentEligibility = this.#providerResumeEligibility(currentRun, currentObjective);
      if (!currentEligibility.safe || currentEligibility.inboxVersion !== eligibility.inboxVersion
        || currentObjective.ownerGeneration !== objective.ownerGeneration || currentObjective.controlRevision !== objective.controlRevision
        || currentObjective.disposition !== objective.disposition) {
        throw error('concurrent_resume_control_changed', currentEligibility.reason || 'resume_pins_changed');
      }
      const currentBinding = this.db.prepare(`SELECT lead_thread_id,lead_codex_home,lead_settings_json FROM concurrent_delivery_runs
        WHERE project_id=? AND run_id=?`).get(this.projectId, run.runId);
      if (!currentBinding || currentBinding.lead_thread_id !== rawRunBefore.lead_thread_id
        || currentBinding.lead_codex_home !== rawRunBefore.lead_codex_home
        || currentBinding.lead_settings_json !== rawRunBefore.lead_settings_json) throw error('concurrent_resume_binding_changed');
      const revision = currentObjective.controlRevision + 1;
      this.store.events.appendInTransaction(this.projectId, { eventType: 'planner.provider_rebound', objectRevision: revision,
        payload: { objectiveId: run.objectiveId, runId: run.runId, ownerGeneration: currentObjective.ownerGeneration,
          controlRevision: currentObjective.controlRevision, priorBinding: { threadId: prior.threadId,
            accountId: prior.accountId, codexHome: prior.codexHome, settings: prior.settings,
            settingsDigest: prior.settingsDigest }, currentBinding: { threadId: nextLead.threadId,
            accountId: nextLead.accountId, codexHome: nextLead.codexHome, settings: nextLead.settings,
            settingsDigest: nextLead.settingsDigest } },
        dedupeKey: `concurrent:${run.objectiveId}:provider-rebind:${currentObjective.controlRevision}:${nextLead.threadId}` });
      const update = this.db.prepare(`UPDATE concurrent_delivery_runs SET lead_thread_id=?,lead_codex_home=?,lead_settings_json=?,updated_at=?
        WHERE project_id=? AND run_id=? AND lead_thread_id=? AND lead_codex_home=? AND lead_settings_json=?`)
        .run(nextLead.threadId, nextLead.codexHome, json(nextLead), this.now(), this.projectId, run.runId,
          rawRunBefore.lead_thread_id, rawRunBefore.lead_codex_home, rawRunBefore.lead_settings_json);
      if (update.changes !== 1) throw error('concurrent_lead_thread_conflict');
      if (currentObjective.disposition === 'blocked_technical') {
        this.store.resumeBlockedTechnical(this.projectId, run.objectiveId, { expectedOwnerGeneration: currentObjective.ownerGeneration,
          expectedControlRevision: currentObjective.controlRevision, ...currentEligibility.blockedReview });
      } else {
        this.store.transitionLifecycleControl(this.projectId, run.objectiveId, { action: 'resume',
          expectedOwnerGeneration: currentObjective.ownerGeneration, expectedControlRevision: currentObjective.controlRevision });
      }
      return this.#run(run.runId);
    });
    const reboundRun = tx.immediate();
    this.leadThreads.set(run.runId, nextLead);
    const previous = this.controllers.get(run.runId);
    if (previous) previous.shutdown({ pause: false });
    this.controllers.delete(run.runId);
    const controller = await this.#controller(reboundRun, { prepareThread: false });
    controller.inbox.signal('owner.resume');
    return controller;
  }

  #createRun(input) {
    if (input.engineMapping?.engine !== 'concurrent-v1' || input.engineMapping.projectId !== this.projectId) throw error('concurrent_engine_mapping_required');
    const runId = requireId(input.runId, 'run_id');
    const objectiveId = requireId(input.engineMapping.objectiveId, 'objective_id');
    const sessionId = requireId(input.engineMapping.sessionId, 'session_id');
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 50000) throw error('concurrent_goal_invalid');
    const contract = validateAcceptanceContract(input.contract);
    if (contract.invalid) throw error('concurrent_acceptance_contract_invalid');
    const contractDigest = stableDigest(contract);
    const requirementDigest = stableDigest({ goal: input.goal, contract });
    const checksDigest = stableDigest(contract);
    const checkIdentity = `checks-${stableDigest({ contract, environmentDigest: this.environmentDigest }).slice(7, 39)}`;
    const checkpointId = `owner-${sha256(`${this.projectId}:${objectiveId}:${requirementDigest}`).slice(0, 24)}`;
    const at = this.now();
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT run_id FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(this.projectId, runId);
      if (existing) throw error('concurrent_run_already_created');
      this.db.prepare(`INSERT INTO concurrent_delivery_runs(project_id,run_id,objective_id,session_id,goal,contract_json,contract_digest,
        requirement_digest,checks_digest,environment_digest,check_identity,checkpoint_ids_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'seeding',?,?)`).run(this.projectId, runId, objectiveId, sessionId, input.goal,
        json(contract), contractDigest, requirementDigest, checksDigest, this.environmentDigest, checkIdentity, json([checkpointId]), at, at);
    });
    tx.immediate();
    const run = this.#run(runId);
    this.checkContract.set(objectiveId, contract);
    this.store.createObjective({ projectId: this.projectId, objectiveId, sessionId, legacyRunId: runId,
      engineVersion: VERSION, goalRevision: 1, requirementDigest, checksDigest, authorityRevision: 1,
      controlRevision: 1, disposition: 'executing' }, { roleCapacities: this.roleCapacities,
      maxActiveTurns: this.store.maxActiveTurns, plannerReservedSlots: this.store.plannerReservedSlots });
    const baseId = this.#baseCandidateId(run);
    const existingCandidate = this.candidateStore.get(baseId);
    if (existingCandidate) {
      if (existingCandidate.projectId !== this.projectId || existingCandidate.objectiveId !== objectiveId
        || existingCandidate.integrationGeneration !== 1 || existingCandidate.environmentDigest !== this.environmentDigest
        || existingCandidate.checkIdentity !== checkIdentity || existingCandidate.manifestDigest !== captureManifest(this.workspace).digest) {
        throw error('concurrent_base_candidate_drift');
      }
    } else {
      this.candidateStore.createCandidate({ candidateId: baseId, projectId: this.projectId, objectiveId,
        integrationGeneration: 1, sourceAttemptId: `base-${sha256(runId).slice(0, 24)}`,
        environmentDigest: this.environmentDigest, checkIdentity });
    }
    const verifier = this.#settingsFor({ task: { role: 'verifier' } });
    const profilePins = [`verifier-${stableDigest(verifier).slice(7, 31)}`];
    this.reviewStore.registerCheckpoint({ projectId: this.projectId, objectiveId, checkpointId,
      kind: 'owner_request', reason: input.goal.slice(0, 1000), checkIdentity,
      checkPins: contract.requiredChecks.map((check) => check.id), toolPins: [], profilePins,
      environmentDigest: this.environmentDigest }, { source: 'owner-intake', runId, requirementDigest, contractDigest });
    this.#saveStatus(runId, 'prepared');
    return this.#run(runId);
  }

  #assertSameIntake(run, input) {
    if (input.goal !== undefined && input.goal !== run.goal) throw error('concurrent_intake_goal_conflict');
    if (input.contract !== undefined && stableDigest(validateAcceptanceContract(input.contract)) !== run.contractDigest) throw error('concurrent_intake_contract_conflict');
  }

  #assertSteerRevisions(objective, input) {
    if (!objective || objective.planRevision !== input.expectedPlanRevision || objective.goalRevision !== input.expectedGoalRevision
      || objective.controlRevision !== input.expectedControlRevision) throw error('steer_revision_stale');
    if (['accepted', 'partial', 'canceled', 'validating'].includes(objective.disposition)) throw error('steer_run_not_active');
  }

  async #controller(run, { prepareThread }) {
    if (this.shutdownRequested) throw error('concurrent_shutdown_admission_closed');
    let controller = this.controllers.get(run.runId);
    if (controller && !controller.shutdownRequested) return controller;
    let lead = this.#leadThread(run);
    if (!lead && prepareThread) lead = await this.#prepareLeadThread(run);
    if (!lead) throw error('concurrent_lead_thread_missing');
    const currentProvider = this.#providerIdentity();
    if (lead.codexHome !== currentProvider.codexHome || lead.accountId !== currentProvider.accountId) throw error('concurrent_provider_identity_changed');
    this.db.prepare('DELETE FROM concurrent_controller_fences WHERE project_id=? AND objective_id=?').run(this.projectId, run.objectiveId);
    controller = new ProjectDeliveryController({ store: this.store, executor: this.executor,
      projectId: this.projectId, objectiveId: run.objectiveId, sessionId: run.sessionId,
      providerThreadId: lead.threadId,
      authenticateOwner: (source) => this.authenticateOwner({ ...source, runId: run.runId }),
      onOwnerCorrection: (context) => this.#replaceOwnerCheckpoints(run, context),
      settingsFor: () => ({ ...lead.settings }),
      contextFor: () => ({ threadId: lead.threadId, transportKey: lead.transportKey,
        accountId: lead.accountId, codexHome: lead.codexHome, settingsDigest: lead.settingsDigest }),
      runTurn: (turn) => this.#runLeadTurn(run, lead, turn),
      authorizeRecovery: (proof) => Boolean(this.#plannerRecoveryProof(proof)),
      reconcilePriorTurn: (prior) => {
        const proof = this.#plannerRecoveryProof(prior);
        const eligibility = prior.recoveryEligibility;
        return proof && eligibility?.state === 'recovery_eligible'
          && Object.keys(proof).every((key) => eligibility[key] === proof[key])
          ? { state: 'no_effect', ...proof } : { state: 'unknown' };
      },
      trustedPreDispatchError: (cause) => this.appServer.isExpectedHomePreflightError?.(cause) === true,
      schedulerOptions: { roles: this.roleIds, roleLimits: this.roleCapacities,
        writerMode: 'isolated', maxActiveTurns: this.store.maxActiveTurns,
        plannerReservedSlots: this.store.plannerReservedSlots, pollIntervalMs: 200,
        isFrozenReview: (input) => this.reviewStore.isFrozenReview(input) },
      lifecycleOptions: { plannerRecoveryProofAdapter: (input) => this.#plannerRecoveryProof(input),
        plannerRetryIdentity: () => ({ source: 'concurrent-engine', provider: 'app-server', model: lead.settings.model, kind: 'planner_invalid' }),
        effectsSettledForShutdown: ({ objective, attempts }) => this.#effectsSettled(objective, attempts),
        getAdmissionState: () => ({ admissionStopped: false, controllerWorkInFlight: false }) },
    });
    this.controllers.set(run.runId, controller);
    return controller;
  }

  async #prepareLeadThread(run) {
    const providerBefore = this.#providerIdentity();
    const settings = { model: this.leadRole.model, effort: this.leadRole.effort || this.leadRole.reasoningEffort || null,
      fast: this.leadRole.fast ?? this.leadRole.fastMode ?? null, executionPermissions: this.executionPermissions,
      selectedSkills: this.#leadSkills(), selectedMcpTools: this.#leadMcpTools(), codexHome: providerBefore.codexHome };
    const prepareRole = copy(this.leadRole);
    this.#assertRoleSettings(prepareRole, settings, 'concurrent_lead_settings_mismatch');
    const prepared = await this.appServer.prepareThread({ role: prepareRole, cwd: this.workspace,
      permissionWorkspace: this.workspace, selectedSkills: settings.selectedSkills,
      selectedMcpTools: settings.selectedMcpTools, executionPermissions: this.executionPermissions,
      ...(this.appServer.getCodexHome ? { captureCodexHome: true } : {}) });
    this.#assertRoleSettings(prepareRole, settings, 'concurrent_lead_settings_changed_during_prepare');
    const providerAfter = this.#providerIdentity();
    const actualHome = prepared.codexHome ?? providerAfter.codexHome;
    if (actualHome !== providerBefore.codexHome || providerAfter.accountId !== providerBefore.accountId) {
      throw error('concurrent_provider_identity_changed_during_prepare');
    }
    if (typeof prepared.threadId !== 'string' || !prepared.threadId) throw error('concurrent_lead_thread_invalid');
    const thread = { threadId: prepared.threadId, codexHome: actualHome, accountId: providerBefore.accountId,
      settings, settingsDigest: stableDigest(settings), transportKey: `lead:${this.projectId}:${run.sessionId}:${providerBefore.accountId}:${actualHome}` };
    const updated = this.db.prepare(`UPDATE concurrent_delivery_runs SET lead_thread_id=?,lead_codex_home=?,lead_settings_json=?,status='prepared',updated_at=?
      WHERE project_id=? AND run_id=? AND lead_thread_id IS NULL`).run(thread.threadId, thread.codexHome,
      json(thread), this.now(), this.projectId, run.runId);
    if (updated.changes !== 1) {
      const saved = this.#leadThread(this.#run(run.runId));
      if (!saved || canonical(saved) !== canonical(thread)) throw error('concurrent_lead_thread_conflict');
      return saved;
    }
    this.leadThreads.set(run.runId, thread);
    return thread;
  }

  #runLeadTurn(run, lead, turn) {
    const currentProvider = this.#providerIdentity();
    if (currentProvider.accountId !== lead.accountId || currentProvider.codexHome !== lead.codexHome) throw error('concurrent_provider_identity_changed');
    const runRole = copy(this.leadRole);
    this.#assertRoleSettings(runRole, lead.settings, 'concurrent_lead_settings_mismatch');
    const ownerContext = { originalGoal: run.goal, acceptanceContract: this.checkContract.get(run.objectiveId) || run.contract,
      objectiveId: run.objectiveId, sessionId: run.sessionId, requirementDigest: this.store.getObjective(this.projectId, run.objectiveId)?.requirementDigest,
      checksDigest: this.store.getObjective(this.projectId, run.objectiveId)?.checksDigest, failureEvidence: run.failure || null };
    const plannerRoles = this.roleIds.filter((role) => !['review', 'verifier', 'auditor', 'coordinator'].includes(canonicalRoleId(role)));
    const prompt = { ...turn.prompt, ownerContext, policy: {
      allowedRoles: plannerRoles,
      mandatoryReviewRole: 'verifier', mandatoryOwnerCheckpoint: this.#ownerCheckpointInventory({ projectId: this.projectId, objectiveId: run.objectiveId }).map((entry) => entry.checkpointId),
      publicationAuthority: 'host-only', completionAuthority: 'host-finalization-only',
    } };
    const input = `Return only JSON matching the requested schema. Plan work for the durable ownerContext and current projection. Choose task roles only from policy.allowedRoles. The host automatically creates and runs the mandatory verifier; never add a verifier, auditor, review, or coordinator task. All productWritePaths, readScope.paths, and scratchWriteRoots must be workspace-relative paths without leading slash, backslashes, empty segments, or dot/dot-dot segments. Host acceptance command paths are not candidate files: never copy absolute check-script paths into task scopes. Preserve the owner acceptance contract; the host runs those checks. Do not claim acceptance or completion. Resolve routine reversible choices internally. ownerDecision must be null unless a named owner-only obligation needs a decision after a completed read-only investigation. Cite investigation as attempt:<attemptId> in evidenceRefs. Choosing an option never grants new effect authority.\n${JSON.stringify(prompt)}`;
    const identity = { projectId: this.projectId, sessionId: run.sessionId, turnId: turn.turnId,
      providerThreadId: turn.providerThreadId, providerScope: turn.providerScope,
      ownerGeneration: turn.prompt.pins.ownerGeneration };
    this.db.prepare(`INSERT INTO concurrent_planner_execution_facts(project_id,session_id,turn_id,identity_json)
      VALUES(?,?,?,?)`).run(this.projectId, run.sessionId, turn.turnId, canonical(identity));
    let observedStart = null;
    return this.appServer.run({ role: runRole, cwd: this.workspace, permissionWorkspace: this.workspace,
      input, threadId: lead.threadId, outputSchema: this.#plannerSchema(), executionPermissions: this.executionPermissions,
      selectedSkills: lead.settings.selectedSkills, selectedMcpTools: lead.settings.selectedMcpTools,
      expectedCodexHome: lead.codexHome,
      onTurnStart: (identity) => {
        if (observedStart) throw error('concurrent_lead_turn_start_duplicate');
        if (!identity || typeof identity !== 'object' || identity.threadId !== lead.threadId) throw error('concurrent_lead_turn_start_thread_mismatch');
        const processIdentity = identity.processIdentity;
        if (!processIdentity || !Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 1
          || !Number.isSafeInteger(processIdentity.pgid) || typeof processIdentity.startTime !== 'string' || !processIdentity.startTime) {
          throw error('concurrent_lead_turn_start_process_identity_invalid');
        }
        observedStart = copy(identity);
        this.db.prepare(`UPDATE concurrent_planner_execution_facts SET start_json=?
          WHERE project_id=? AND session_id=? AND turn_id=? AND start_json IS NULL`)
          .run(canonical(observedStart), this.projectId, run.sessionId, turn.turnId);
      },
    }).then((result) => {
      const providerAfter = this.#providerIdentity();
      if (providerAfter.accountId !== lead.accountId || providerAfter.codexHome !== lead.codexHome) throw error('concurrent_provider_identity_changed_during_lead_turn');
      this.#assertRoleSettings(runRole, lead.settings, 'concurrent_lead_settings_changed_during_turn');
      const execution = result?.execution;
      if (result?.threadId !== lead.threadId || execution?.threadId !== lead.threadId) throw error('concurrent_lead_thread_changed');
      if (result?.status !== 'completed' || !result.turnId || execution?.turnId !== result.turnId
        || observedStart?.threadId !== lead.threadId || execution?.turnStartSent !== true
        || execution?.turnStartRejected !== false || execution?.turnTerminal !== true
        || canonical(execution?.processIdentity) !== canonical(observedStart?.processIdentity)) {
        throw error('concurrent_lead_turn_untrusted');
      }
      this.db.prepare(`UPDATE concurrent_planner_execution_facts SET terminal_json=?
        WHERE project_id=? AND session_id=? AND turn_id=? AND terminal_json IS NULL`)
        .run(canonical({ threadId: result.threadId, turnId: result.turnId, status: result.status, execution }),
          this.projectId, run.sessionId, turn.turnId);
      let output;
      try { output = JSON.parse(result.text); } catch (_) { return null; }
      try { return this.#sanitizePlannerOutput(output, run); }
      catch (cause) {
        if (['concurrent_plan_invalid', 'concurrent_planner_role_denied', 'concurrent_dependency_checkpoint_unknown'].includes(cause.code)) return null;
        throw cause;
      }
    }, (cause) => {
      const execution = cause?.execution;
      const terminalTurn = cause?.terminalTurn;
      const terminalStatus = terminalTurn?.status || cause?.status;
      if (execution?.turnTerminal === true && execution.threadId === lead.threadId
        && execution.turnId && terminalTurn?.id === execution.turnId
        && ['failed', 'interrupted', 'completed'].includes(terminalStatus)
        && canonical(execution.processIdentity) === canonical(observedStart?.processIdentity)) {
        const terminal = { threadId: lead.threadId, turnId: execution.turnId, status: terminalStatus,
          terminalTurn, execution, failureClass: cause.failureClass || null, outcomeUnknown: cause.outcomeUnknown === true };
        this.db.prepare(`UPDATE concurrent_planner_execution_facts SET terminal_json=?
          WHERE project_id=? AND session_id=? AND turn_id=? AND terminal_json IS NULL`)
          .run(canonical(terminal), this.projectId, run.sessionId, turn.turnId);
      }
      throw cause;
    });
  }

  #plannerRecoveryProof(input) {
    this.#providerIdentity();
    const row = this.db.prepare(`SELECT identity_json,start_json,terminal_json FROM concurrent_planner_execution_facts
      WHERE project_id=? AND session_id=? AND turn_id=?`).get(input.projectId, input.sessionId, input.turnId);
    if (!row?.start_json || !row.terminal_json) return null;
    const identity = JSON.parse(row.identity_json);
    if (Object.keys(identity).some((key) => input[key] !== identity[key])) return null;
    const ledger = this.db.prepare(`SELECT provider_thread_id,provider_scope,pins_json,status FROM delivery_planner_turns
      WHERE project_id=? AND session_id=? AND turn_id=?`).get(input.projectId, input.sessionId, input.turnId);
    if (!ledger || !['active', 'unknown'].includes(ledger.status)
      || ledger.provider_thread_id !== identity.providerThreadId || ledger.provider_scope !== identity.providerScope
      || JSON.parse(ledger.pins_json).ownerGeneration !== identity.ownerGeneration) return null;
    const start = JSON.parse(row.start_json);
    const terminal = JSON.parse(row.terminal_json);
    const execution = terminal.execution;
    if (start.threadId !== identity.providerThreadId || terminal.threadId !== identity.providerThreadId
      || terminal.status !== 'completed' || !terminal.turnId || execution?.turnId !== terminal.turnId
      || execution.threadId !== identity.providerThreadId || execution.turnStartSent !== true
      || execution.turnStartRejected !== false || execution.turnTerminal !== true
      || canonical(start.processIdentity) !== canonical(execution.processIdentity)
      || !isProcessGroupGone(start.processIdentity)) return null;
    return { ...identity, remoteQuiescent: true, processQuiescent: true };
  }

  #sanitizePlannerOutput(output, run) {
    if (!output || typeof output !== 'object' || !output.expected || typeof output.expected !== 'object') throw error('concurrent_plan_invalid');
    if (output.delta && Array.isArray(output.delta.tasks)) {
      const latest = this.#latestCandidate(run.objectiveId);
      output.delta.tasks = output.delta.tasks.map((change) => {
        const task = copy(change?.task);
        if (!task || ['review', 'verifier', 'auditor', 'coordinator'].includes(canonicalRoleId(task.role)) || !this.roleFor(task.role)) throw error('concurrent_planner_role_denied');
        task.baseCandidateId = latest?.candidateId || null;
        task.checks = { checkPins: this.#ownerCheckPins(run), toolPins: [], profilePins: [] };
        task.publicationAuthority = { state: 'denied', reason: 'concurrent_engine_host_publication', authorityRevision: task.publicationAuthority?.authorityRevision ?? 1 };
        task.skillPins = [];
        task.toolPins = [];
        task.profilePins = [];
        task.state = task.state === 'blocked' ? 'blocked' : 'queued';
        return { ...change, task };
      });
      for (const dependency of output.delta.dependencies || []) {
        if (dependency.predecessorType === 'checkpoint' && !this.reviewStore.isCheckpointActive({ projectId: this.projectId,
          objectiveId: run.objectiveId, checkpointId: dependency.predecessorId })) throw error('concurrent_dependency_checkpoint_unknown');
      }
    }
    return output;
  }

  async #waitForTerminal(run, signal) {
    for (;;) {
      if (signal?.aborted) {
        const controller = this.controllers.get(run.runId);
        if (controller) await controller.cancelObjective().catch(() => {});
        return { runId: run.runId, status: 'canceled', text: 'Cancellation was requested; provider effects are being reconciled.', rounds: 0, assignments: [] };
      }
      const current = this.#run(run.runId);
      const objective = this.store.getObjective(this.projectId, run.objectiveId);
      if (!objective) throw error('concurrent_objective_missing');
      if (['accepted', 'partial'].includes(objective.disposition)) return this.#terminalResult(current);
      if (objective.disposition === 'canceled') return { runId: run.runId, status: 'canceled', text: 'Canceled by the owner.', rounds: 0, assignments: [] };
      const ownerWait = this.#ownerDecisionWait(run);
      if (ownerWait) return ownerWait;
      const controller = this.controllers.get(run.runId);
      if (!controller) throw error('concurrent_controller_missing');
      const status = controller.status();
      if (objective.disposition === 'paused_owner') {
        const pause = { kind: 'owner_pause', message: 'Paused by the owner' };
        this.#saveStatus(run.runId, 'paused');
        return { runId: run.runId, status: 'input_required', text: pause.message, pause, rounds: 0, assignments: [] };
      }
      if (status.lastRecovery?.state === 'stale' || objective.disposition === 'blocked_technical') {
        const pause = this.getPause(run.runId) || { kind: 'error', message: 'Concurrent delivery is blocked by an unresolved effect.' };
        this.#savePause(run.runId, pause);
        return { runId: run.runId, status: 'input_required', text: pause.message, pause, rounds: 0, assignments: [] };
      }
      if (status.lastPlanner?.state === 'error' && status.lastRecovery?.state === 'held') {
        const failure = status.lastPlanner.providerFailure;
        const code = failure?.code || status.lastPlanner.code || 'planner_turn_error';
        const message = code === 'invalid_json_schema'
          ? 'The Codex provider rejected the lead planner response schema (invalid_json_schema). The run is paused until the failure is safely reconciled.'
          : failure?.turnTerminal === true
            ? `The Codex provider turn failed (${code}). The run is paused until the terminal failure is reconciled.`
            : `The lead planner did not produce a confirmed result (${code}). The run remains fenced until the provider outcome is reconciled.`;
        const pause = { kind: 'error', message, failureCode: code,
          providerThreadId: failure?.threadId || null, providerTurnId: failure?.turnId || null,
          outcomeUnknown: failure?.outcomeUnknown === true };
        this.#savePause(run.runId, pause);
        this.#saveStatus(run.runId, 'paused');
        return { runId: run.runId, status: 'input_required', text: message, pause, rounds: 0, assignments: [] };
      }
      await this.#advance(run, controller);
      const refreshed = this.store.getObjective(this.projectId, run.objectiveId);
      if (['accepted', 'partial'].includes(refreshed.disposition)) return this.#terminalResult(this.#run(run.runId));
      await new Promise((resolve) => setTimeout(resolve, this.sleepMs));
    }
  }

  async #advance(run, controller) {
    const objective = this.store.getObjective(this.projectId, run.objectiveId);
    if (!objective || !['planning', 'executing'].includes(objective.disposition) || this.store.pendingOwnerDecision(this.projectId, run.objectiveId)) return;
    if (await this.#syncOwnerCorrection(run, controller) !== true) return;
    if (controller.inbox.projection().wakeup) return;
    const active = this.store.listClaims(this.projectId, run.objectiveId).some((claim) => ['active', 'expired', 'fenced'].includes(claim.state))
      || this.store.listAttempts(this.projectId, run.objectiveId).some((attempt) => ['claimed', 'running', 'settling', 'unknown'].includes(attempt.state));
    const capable = objective.tasks.some((task) => ['draft', 'queued', 'ready', 'claimed', 'running', 'settling'].includes(task.state));
    if (active || capable || controller.cycle || controller.scheduler.runPromise || controller.planner.inFlight) return;
    const candidate = this.#latestCandidate(run.objectiveId);
    if (!candidate) return;
    const projection = this.reviewStore.finalizationProjection({ projectId: this.projectId, objectiveId: run.objectiveId,
      candidateId: candidate.candidateId, requiredRoles: ['verifier'] });
    if (!projection.requirements.length || projection.requirements.some((entry) => entry.critical && entry.closure?.known !== true)) {
      this.#savePause(run.runId, { kind: 'error', message: 'Finalization requirements or checkpoint closures are unavailable.' });
      return;
    }
    if (projection.missingReceipts.length || projection.pendingReviewTasks.length) {
      this.#enqueueMissingReviews(run, projection);
      return;
    }
    const fence = controller.shutdown({ pause: false });
    if (controller.cycle || controller.scheduler.runPromise) return;
    const drained = controller.lifecycle.shutdownProjection();
    if (drained.safeToRelease !== true || fence.effectsSettled !== true) return;
    if (captureManifest(this.workspace).digest !== candidate.manifestDigest) {
      this.#recordFailure(run.runId, { code: 'live_workspace_manifest_mismatch', candidateId: candidate.candidateId,
        expectedManifestDigest: candidate.manifestDigest, actualManifestDigest: captureManifest(this.workspace).digest });
      return;
    }
    this.#recordControllerFence(run, objective, drained);
    const frozenProjection = this.reviewStore.finalizationProjection({ projectId: this.projectId, objectiveId: run.objectiveId,
      candidateId: candidate.candidateId, requiredRoles: ['verifier'] });
    if (!frozenProjection.complete) {
      this.#savePause(run.runId, { kind: 'error', message: 'Final review closure did not freeze after controller shutdown.' });
      return;
    }
    const result = await this.#finalize(run, candidate, controller);
    if (result?.state === 'accepted') {
      this.#saveTerminal(run.runId, result);
      return;
    }
    if (['rejected', 'invalidated'].includes(result?.state)) {
      this.#recordFailure(run.runId, { code: 'final_check_rejected', finalizationId: result.finalization?.finalizationId,
        checkResult: result.finalization?.checkResult || null, proof: this.#finalCheckProof(result.finalization?.finalizationId) });
      const fresh = await this.#controller(this.#run(run.runId), { prepareThread: false });
      fresh.inbox.signal('finalization.rejected');
      fresh.start();
      return;
    }
    if (result?.state === 'checking' || result?.state === 'unknown' || result?.state === 'barrier') {
      this.#savePause(run.runId, { kind: 'error', message: `Finalization remains ${result.state}; no checks were rerun.` });
      this.#saveStatus(run.runId, 'recovering');
      return;
    }
  }

  async #syncOwnerCorrection(run, controller) {
    const pending = controller.inbox.pending().some((message) => message.kind === 'owner_correction');
    const blocked = controller.inbox.messages().some((message) => message.kind === 'owner_correction' && message.state === 'blocked');
    if (!pending && !blocked) return true;
    if (pending) controller.wake('owner.correction.pending');
    return false;
  }

  #enqueueMissingReviews(run, projection) {
    const candidate = this.#latestCandidate(run.objectiveId);
    if (!candidate) return;
    const objective = this.store.getObjective(this.projectId, run.objectiveId);
    const missing = new Map(projection.missingReceipts.map((entry) => [entry.checkpointId, entry.role]));
    const proposals = [];
    for (const [checkpointId, role] of missing) {
      if (role !== 'verifier' || !this.reviewStore.isCheckpointActive({ projectId: this.projectId, objectiveId: run.objectiveId, checkpointId })) continue;
      const existing = objective.tasks.some((task) => task.checkpointId === checkpointId
        && task.baseCandidateId === candidate.candidateId && canonicalRoleId(task.role) === role
        && task.kind === 'review' && !['superseded', 'canceled'].includes(task.state));
      if (existing) continue;
      const proposal = this.reviewStore.proposeReviews({ projectId: this.projectId, objectiveId: run.objectiveId,
        checkpointId, candidateId: candidate.candidateId,
        reviewers: [{ role: 'verifier', taskId: `review-${sha256(`${candidate.candidateId}:${checkpointId}:verifier:${this.now()}`).slice(0, 24)}` }] },
      { source: 'concurrent-engine' });
      for (const entry of proposal) {
        const existing = this.store.getObjective(this.projectId, run.objectiveId).tasks.find((task) => task.taskId === entry.task.taskId);
        if (!existing) proposals.push(entry.task);
      }
    }
    if (!proposals.length) return;
    const current = this.store.getObjective(this.projectId, run.objectiveId);
    const delta = { schemaVersion: VERSION, expectedPlanRevision: current.planRevision,
      expectedGoalRevision: current.goalRevision, expectedAuthorityRevision: current.authorityRevision,
      expectedControlRevision: current.controlRevision, nextPlanRevision: current.planRevision + 1,
      tasks: proposals.map((task) => ({ task: { ...task, checks: { ...task.checks,
        checkPins: this.#ownerCheckPins(run) } } })), dependencies: [] };
    this.store.applyPlan(this.projectId, run.objectiveId, delta);
    this.#syncReviewTaskState(proposals.map((task) => task.taskId), 'queued');
    controllerWake(this.controllers.get(run.runId));
  }

  async #finalize(run, candidate, controller) {
    this.#providerIdentity();
    const current = this.store.getObjective(this.projectId, run.objectiveId);
    const contract = this.checkContract.get(run.objectiveId) || run.contract;
    const checkedContract = validateAcceptanceContract(contract);
    const finalizationId = `final-${sha256(`${run.runId}:${candidate.candidateId}:${current.planRevision}:${current.controlRevision}:${this.now()}`).slice(0, 32)}`;
    const request = { finalizationId, kind: 'accepted', expectedOwnerGeneration: current.ownerGeneration,
      expectedControlRevision: current.controlRevision, expectedGoalRevision: current.goalRevision,
      expectedPlanRevision: current.planRevision, expectedAuthorityRevision: current.authorityRevision,
      requirementDigest: current.requirementDigest, checksDigest: current.checksDigest,
      candidateId: candidate.candidateId, integrationGeneration: candidate.integrationGeneration,
      manifestDigest: candidate.manifestDigest, sourceHead: this.candidateStore.readManifest(candidate.manifestDigest).head ?? null,
      environmentDigest: candidate.environmentDigest, checkIdentity: candidate.checkIdentity,
      checkContractDigest: `sha256:${sha256(canonical(checkedContract))}`, checkSource: checkedContract.source || 'owner',
      requiredCheckIds: checkedContract.requiredChecks.map((check) => check.id), requiredRoles: ['verifier'],
      executionPermissions: this.executionPermissions, scratchEnabled: this.acceptanceScratch !== null, partialLedger: null };
    const result = await finalizeCandidate({ store: this.store, candidateStore: this.candidateStore, reviewStore: this.reviewStore,
      lifecycle: controller.lifecycle, projectId: this.projectId, objectiveId: run.objectiveId, request, contract: checkedContract,
      admission: this.admission, acceptanceScratch: this.acceptanceScratch,
      scratchForbiddenRoots: [this.workspace, this.storageRoot, this.lanes.lanesRoot], evidenceStore: this.evidenceStore,
      appServer: this.appServer, onChecksExecuted: (proof) => this.#recordFinalCheckProof(proof) });
    this.#providerIdentity();
    return result;
  }

  async #checkEvidenceFor({ task, attempt, execution, candidate, requiredCheckPins }) {
    this.#providerIdentity();
    const run = this.#runByObjective(task.projectId, task.objectiveId);
    if (!run || !Array.isArray(requiredCheckPins)) throw error('concurrent_owner_check_registry_missing');
    const contract = this.checkContract.get(task.objectiveId) || run.contract;
    const pins = contract.requiredChecks.map((check) => check.id).sort();
    if (canonical(pins) !== canonical(requiredCheckPins)) throw error('concurrent_owner_check_pins_mismatch');
    const saved = this.candidateStore.get(candidate.candidateId);
    if (!saved || saved.projectId !== task.projectId || saved.objectiveId !== task.objectiveId
      || saved.manifestDigest !== candidate.inputManifestDigest || saved.status !== 'known') throw error('concurrent_verifier_candidate_stale');
    let checked;
    if (pins.length) {
      checked = await runFrozenCandidateChecks({ candidateStore: this.candidateStore,
        candidate: { projectId: task.projectId, objectiveId: task.objectiveId, candidateId: saved.candidateId,
          integrationGeneration: saved.integrationGeneration, manifestDigest: saved.manifestDigest,
          environmentDigest: saved.environmentDigest, checkIdentity: saved.checkIdentity },
        contract, runId: attempt.attemptId, attempt: 1, executionPermissions: this.executionPermissions,
        acceptanceScratch: this.acceptanceScratch, scratchForbiddenRoots: [this.workspace, this.storageRoot, this.lanes.lanesRoot],
        admission: this.admission, evidenceStore: this.evidenceStore, appServer: this.appServer });
      if (checked.disposition !== 'accepted') throw error('concurrent_owner_check_failed');
    }
    this.#providerIdentity();
    const byId = new Map((checked?.checkResults || []).map((entry) => [entry.id, entry]));
    const proof = { projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId,
      attemptId: attempt.attemptId, fencingToken: attempt.fencingToken, providerContextId: execution.providerContextId,
      providerThreadId: execution.providerThreadId, candidateId: saved.candidateId,
      inputManifestDigest: saved.manifestDigest, selectedSettingsDigest: execution.settingsDigest,
      requestDigest: execution.requestDigest, checkPins: pins,
      results: pins.map((checkId) => {
        const result = byId.get(checkId);
        if (result?.result !== 'passed') throw error('concurrent_owner_check_result_missing');
        return { checkId, state: 'passed', evidenceRef: `verifier-check:${attempt.attemptId}:${checkId}` };
      }),
      evidenceRefs: [`verifier-check-proof:${attempt.attemptId}`,
        ...(checked?.checkResults || []).flatMap((entry) => [entry.stdoutEvidence, entry.stderrEvidence].filter(Boolean).map((ref) => {
          if (typeof ref === 'string' && ref.length > 0 && ref.length <= 1000) return ref;
          if (ref?.contract === 'evidence-ref/v1' && typeof ref.id === 'string' && /^ev_[0-9a-f]{32}$/.test(ref.id)) return ref.id;
          throw error('concurrent_owner_check_evidence_invalid');
        }))] };
    proof.evidenceDigest = `sha256:${sha256(canonical(proof))}`;
    const encoded = canonical(proof);
    const proofDigest = `sha256:${sha256(encoded)}`;
    const prior = this.db.prepare('SELECT proof_json,proof_digest FROM concurrent_verifier_check_proofs WHERE attempt_id=?').get(attempt.attemptId);
    if (prior && (prior.proof_json !== encoded || prior.proof_digest !== proofDigest)) throw error('concurrent_verifier_proof_conflict');
    this.db.prepare(`INSERT OR IGNORE INTO concurrent_verifier_check_proofs(attempt_id,project_id,objective_id,proof_json,proof_digest,created_at)
      VALUES(?,?,?,?,?,?)`).run(attempt.attemptId, task.projectId, task.objectiveId, encoded, proofDigest, this.now());
    return proof;
  }

  #recordFinalCheckProof({ projectId, objectiveId, finalizationId, checkAttemptId, pins, result }) {
    this.#providerIdentity();
    const encodedPins = canonical(pins);
    const encodedResult = canonical(result);
    const resultDigest = `sha256:${sha256(encodedResult)}`;
    const prior = this.db.prepare('SELECT * FROM concurrent_finalization_check_proofs WHERE finalization_id=?').get(finalizationId);
    if (prior) return prior.project_id === projectId && prior.objective_id === objectiveId
      && prior.check_attempt_id === checkAttemptId && prior.pins_json === encodedPins
      && prior.result_json === encodedResult && prior.result_digest === resultDigest;
    this.db.prepare(`INSERT INTO concurrent_finalization_check_proofs(finalization_id,project_id,objective_id,check_attempt_id,
      pins_json,result_json,result_digest,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(finalizationId, projectId, objectiveId, checkAttemptId, encodedPins, encodedResult, resultDigest, this.now());
    return true;
  }

  #finalizationCheckProofAuthorized(facts) {
    const proof = this.db.prepare('SELECT * FROM concurrent_finalization_check_proofs WHERE finalization_id=?').get(facts.finalizationId);
    if (!proof || proof.project_id !== facts.projectId || proof.objective_id !== facts.objectiveId
      || proof.check_attempt_id !== facts.checkAttemptId || proof.pins_json !== canonical(facts.pins)
      || proof.result_json !== canonical(facts.result)
      || proof.result_digest !== `sha256:${sha256(proof.result_json)}`) return false;
    return true;
  }

  #finalizationAuthorized(facts) {
    const run = this.#runByObjective(facts.projectId, facts.objectiveId);
    const objective = this.store.getObjective(facts.projectId, facts.objectiveId);
    if (!run || !objective) return false;
    const request = facts.request || facts.record?.request;
    if (!request || request.kind !== 'accepted' || canonical(request.requiredRoles) !== canonical(['verifier'])) return false;
    const scope = { projectId: facts.projectId, objectiveId: facts.objectiveId };
    const checkpoints = this.#ownerCheckpointInventory(scope);
    const history = this.reviewStore.checkpointHistory(scope);
    const rowsById = new Map(history.map((row) => [row.checkpoint.checkpointId, row.checkpoint]));
    const verifier = this.#settingsFor({ task: { role: 'verifier' } });
    if (!checkpoints.length || checkpoints.some((item) => {
      const checkpoint = rowsById.get(item.checkpointId);
      return !checkpoint || !this.reviewStore.isCheckpointActive({ ...scope, checkpointId: item.checkpointId })
        || checkpoint.kind !== 'owner_request' || checkpoint.critical !== true
        || checkpoint.checkIdentity !== run.checkIdentity || checkpoint.environmentDigest !== run.environmentDigest
        || canonical(checkpoint.checkPins) !== canonical(run.contract.requiredChecks.map((check) => check.id))
        || canonical(checkpoint.toolPins) !== canonical([]) || !this.#checkpointProfilePinAuthorized(checkpoint, verifier, run);
    })) return false;
    if (request.expectedOwnerGeneration !== objective.ownerGeneration || request.expectedControlRevision !== objective.controlRevision
      || request.expectedGoalRevision !== objective.goalRevision || request.expectedPlanRevision !== objective.planRevision
      || request.expectedAuthorityRevision !== objective.authorityRevision || request.requirementDigest !== objective.requirementDigest
      || request.checksDigest !== objective.checksDigest || request.checkContractDigest !== `sha256:${sha256(canonical(run.contract))}`
      || canonical(request.requiredCheckIds) !== canonical(run.contract.requiredChecks.map((check) => check.id))
      || request.checkSource !== (run.contract.source || 'owner') || request.checkIdentity !== run.checkIdentity
      || request.environmentDigest !== run.environmentDigest
      || request.executionPermissions !== this.executionPermissions || request.scratchEnabled !== (this.acceptanceScratch !== null)) return false;
    const candidate = this.#latestCandidate(facts.objectiveId);
    if (!candidate || candidate.candidateId !== request.candidateId || candidate.manifestDigest !== request.manifestDigest
      || candidate.environmentDigest !== request.environmentDigest || candidate.checkIdentity !== request.checkIdentity
      || captureManifest(this.workspace).digest !== candidate.manifestDigest) return false;
    const fence = this.db.prepare('SELECT * FROM concurrent_controller_fences WHERE project_id=? AND objective_id=?')
      .get(facts.projectId, facts.objectiveId);
    if (!fence || fence.status !== 'fenced' || fence.owner_generation !== objective.ownerGeneration
      || fence.control_revision !== objective.controlRevision) return false;
    if (facts.action === 'begin') return true;
    const record = facts.record;
    if (!record || !['barrier', 'checking', 'ready', 'accepted'].includes(record.state)) return false;
    const durable = this.store.getFinalization(facts.projectId, facts.objectiveId, record.finalizationId);
    if (!durable || durable.finalizationId !== record.finalizationId || durable.pinsDigest !== record.pinsDigest) return false;
    if (facts.action === 'start_checks' && record.state !== 'barrier') return false;
    if (facts.action === 'commit' && !['ready', 'accepted'].includes(record.state)) return false;
    return true;
  }

  #checkpointProfilePinAuthorized(checkpoint, verifierSettings, run) {
    const profilePin = (settings) => `verifier-${stableDigest(settings).slice(7, 31)}`;
    if (canonical(checkpoint.profilePins) === canonical([profilePin(verifierSettings)])) return true;
    const lineage = this.#providerRebindLineage(run);
    if (!lineage) return false;
    return lineage.identities.some((identity) => {
      const historicalSettings = { ...verifierSettings, codexHome: identity.codexHome, accountId: identity.accountId };
      return canonical(checkpoint.profilePins) === canonical([profilePin(historicalSettings)]);
    });
  }

  #providerRebindLineage(run) {
    const all = [];
    let after = 0;
    for (;;) {
      const page = this.store.events.replay(this.projectId, { after, limit: 500 });
      if (!page.length) break;
      all.push(...page);
      after = page[page.length - 1].sequence;
      if (page.length < 500) break;
    }
    const events = all.filter((event) => event.eventType === 'planner.provider_rebound'
      && event.payload?.objectiveId === run.objectiveId && event.payload?.runId === run.runId);
    if (!events.length) return null;
    let prior = null;
    let lastRevision = -1;
    let lastOwnerGeneration = -1;
    const identities = [];
    const validBinding = (binding) => binding && typeof binding.threadId === 'string' && binding.threadId
      && typeof binding.accountId === 'string' && binding.accountId
      && typeof binding.codexHome === 'string' && binding.codexHome
      && binding.settings && typeof binding.settings === 'object' && !Array.isArray(binding.settings)
      && binding.settings.codexHome === binding.codexHome
      && binding.settingsDigest === stableDigest(binding.settings);
    for (const event of events) {
      const payload = event.payload;
      if (!Number.isSafeInteger(payload.ownerGeneration) || payload.ownerGeneration < lastOwnerGeneration
        || !Number.isSafeInteger(payload.controlRevision) || payload.controlRevision < lastRevision
        || event.objectRevision !== payload.controlRevision + 1
        || !validBinding(payload.priorBinding) || !validBinding(payload.currentBinding)
        || payload.priorBinding.threadId === payload.currentBinding.threadId
        || payload.priorBinding.accountId === payload.currentBinding.accountId
        && payload.priorBinding.codexHome === payload.currentBinding.codexHome) return null;
      if (prior && (prior.threadId !== payload.priorBinding.threadId
        || prior.accountId !== payload.priorBinding.accountId || prior.codexHome !== payload.priorBinding.codexHome
        || prior.settingsDigest !== payload.priorBinding.settingsDigest
        || canonical(prior.settings) !== canonical(payload.priorBinding.settings))) return null;
      if (!prior) identities.push({ accountId: payload.priorBinding.accountId, codexHome: payload.priorBinding.codexHome });
      identities.push({ accountId: payload.currentBinding.accountId, codexHome: payload.currentBinding.codexHome });
      prior = payload.currentBinding;
      lastRevision = payload.controlRevision;
      lastOwnerGeneration = payload.ownerGeneration;
    }
    const persisted = run.leadSettings;
    const expectedTransport = `lead:${run.projectId}:${run.sessionId}:${persisted?.accountId}:${run.leadCodexHome}`;
    if (!persisted || !prior || prior.threadId !== run.leadThreadId || prior.accountId !== persisted.accountId
      || prior.codexHome !== run.leadCodexHome || prior.settingsDigest !== persisted.settingsDigest
      || canonical(prior.settings) !== canonical(persisted.settings) || persisted.transportKey !== expectedTransport) return null;
    return { identities };
  }

  #authorizeCheckpoint({ input, authorization }) {
    if (authorization?.source !== 'owner-intake' && authorization?.source !== 'owner-correction') return false;
    const run = this.#runByObjective(input?.projectId, input?.objectiveId);
    if (!run || !this.#ownerCheckpointInventory({ projectId: input.projectId, objectiveId: input.objectiveId })
      .some((entry) => entry.checkpointId === input.checkpointId)) return false;
    return input.kind === 'owner_request' && input.critical !== false;
  }

  #authorizeSupersession(context) {
    const { input, currentObjective, mapping } = context || {};
    if (!input || !currentObjective || !Array.isArray(mapping) || !this.#isKnownRun(input.projectId, input.objectiveId)) return false;
    const inbox = new DeliveryInbox(this.db, { projectId: input.projectId, objectiveId: input.objectiveId,
      sessionId: this.store.getObjective(input.projectId, input.objectiveId)?.sessionId, authenticateOwner: this.authenticateOwner });
    return inbox.isAuthenticatedOwnerMessage(input.sourceMessageId) && input.expectedOwnerGeneration === currentObjective.ownerGeneration
      && input.expectedControlRevision === currentObjective.controlRevision && input.currentGoalRevision === currentObjective.goalRevision;
  }

  #authorizePromotion() { return false; }
  #attestPromotion() { return false; }

  #attestClosure(context) {
    const run = this.#runByObjective(context?.projectId, context?.objectiveId);
    if (!run) return null;
    if (context.kind === 'final-stabilization') {
      const candidate = context.candidate;
      const latest = this.#latestCandidate(context.objectiveId);
      const fence = this.db.prepare('SELECT * FROM concurrent_controller_fences WHERE project_id=? AND objective_id=?')
        .get(context.projectId, context.objectiveId);
      const manifest = candidate && this.candidateStore.readManifest(candidate.manifestDigest);
      const stable = Boolean(candidate && latest?.candidateId === candidate.candidateId && manifest
        && captureManifest(this.workspace).digest === candidate.manifestDigest
        && fence?.status === 'fenced' && fence.owner_generation === context.objective.ownerGeneration
        && fence.control_revision === context.objective.controlRevision);
      return { frozen: stable };
    }
    const checkpoint = context.checkpoint || this.reviewStore.checkpointHistory({ projectId: context.projectId,
      objectiveId: context.objectiveId }).find((row) => row.checkpoint.checkpointId === context.checkpointId)?.checkpoint;
    const candidate = context.candidate;
    const manifest = context.manifest || (candidate && this.candidateStore.readManifest(candidate.contentManifestDigest || candidate.manifestDigest));
    if (!checkpoint || !manifest || !candidate) return null;
    return { known: true, checkpointId: checkpoint.checkpointId,
      readManifest: readOnlyTreeManifest(manifest), checkpointAncestors: checkpoint.dependsOn || [] };
  }

  #replaceOwnerCheckpoints(run, { prior, current, message }) {
    const scope = { projectId: this.projectId, objectiveId: run.objectiveId };
    const active = this.reviewStore.checkpointInventory(scope);
    const history = new Map(this.reviewStore.checkpointHistory(scope).map((entry) => [entry.checkpoint.checkpointId, entry.checkpoint]));
    const replacements = active.map(({ checkpointId }) => ({ checkpointId,
      replacementCheckpointId: `owner-${sha256(`${run.runId}:${message.messageId}:${checkpointId}`).slice(0, 24)}` }));
    const ids = new Map(replacements.map((entry) => [entry.checkpointId, entry.replacementCheckpointId]));
    const saveInventory = (checkpointIds) => this.db.prepare(`UPDATE concurrent_delivery_runs SET checkpoint_ids_json=?
      WHERE project_id=? AND run_id=?`).run(json(checkpointIds), this.projectId, run.runId);
    saveInventory([...active.map((entry) => entry.checkpointId), ...ids.values()]);
    for (const entry of replacements) {
      const checkpoint = history.get(entry.checkpointId);
      this.reviewStore.registerCheckpoint({ ...scope, checkpointId: entry.replacementCheckpointId,
        kind: checkpoint.kind, reason: checkpoint.reason, critical: checkpoint.critical,
        checkIdentity: checkpoint.checkIdentity, checkPins: checkpoint.checkPins, toolPins: checkpoint.toolPins,
        profilePins: checkpoint.profilePins, environmentDigest: checkpoint.environmentDigest,
        dependsOn: checkpoint.dependsOn.map((checkpointId) => ids.get(checkpointId) || checkpointId) },
      { source: 'owner-correction', sourceMessageId: message.messageId });
    }
    this.reviewStore.supersedeCheckpoints({ ...scope, sourceMessageId: message.messageId,
      expectedOwnerGeneration: current.ownerGeneration, expectedControlRevision: current.controlRevision,
      priorGoalRevision: prior.goalRevision, currentGoalRevision: current.goalRevision, replacements },
    { source: 'owner-correction', sourceMessageId: message.messageId });
    saveInventory(replacements.map((entry) => entry.replacementCheckpointId));
  }

  #ownerCheckpointInventory({ projectId, objectiveId }) {
    const row = this.db.prepare('SELECT checkpoint_ids_json FROM concurrent_delivery_runs WHERE project_id=? AND objective_id=?')
      .get(projectId, objectiveId);
    if (!row) return [];
    return JSON.parse(row.checkpoint_ids_json).map((checkpointId) => ({ projectId, objectiveId, checkpointId }));
  }

  #checkpointAccepted({ projectId, objectiveId, checkpointId }) {
    if (!this.reviewStore?.isCheckpointActive({ projectId, objectiveId, checkpointId })) return false;
    const candidate = this.#latestCandidate(objectiveId);
    if (!candidate) return false;
    try {
      return this.reviewStore.finalizationProjection({ projectId, objectiveId, candidateId: candidate.candidateId,
        requiredRoles: ['verifier'] }).receipts.some((entry) => entry.current && entry.qualified
          && entry.receipt.checkpointId === checkpointId && entry.receipt.role === 'verifier');
    } catch (_) { return false; }
  }

  #reviewBinding({ task, attempt, claim }) {
    const storedAttempt = this.store.listAttempts(task.projectId, task.objectiveId).find((entry) => entry.attemptId === attempt.attemptId);
    const storedClaim = this.store.listClaims(task.projectId, task.objectiveId).find((entry) => entry.claimId === claim.claimId);
    return Boolean(storedAttempt && storedClaim && stableDigest({ ...storedAttempt, contractSnapshot: undefined })
      === stableDigest({ ...attempt, contractSnapshot: undefined }) && stableDigest(storedClaim) === stableDigest(claim));
  }

  #reviewThread({ binding, threadId }) {
    const execution = this.roleService.getExecution(binding.attemptId);
    return Boolean(execution && execution.providerThreadId === threadId && execution.providerContextId === binding.providerContextId
      && execution.fencingToken === binding.fencingToken);
  }

  #resolveReviewAttempt({ projectId, objectiveId, taskId, attemptId, claimId, fencingToken }) {
    const attempt = this.store.listAttempts(projectId, objectiveId).find((entry) => entry.attemptId === attemptId);
    const claim = this.store.listClaims(projectId, objectiveId).find((entry) => entry.claimId === claimId);
    const task = this.store.getObjective(projectId, objectiveId)?.tasks.find((entry) => entry.taskId === taskId);
    const execution = this.roleService.getExecution(attemptId);
    if (!attempt || !claim || !task || !execution) return null;
    const checkEvidence = execution.checkEvidence;
    return { ...attempt, role: task.role, threadId: execution.providerThreadId, claimId, claimState: claim.state, claim: { state: claim.state },
      ownerGeneration: claim.ownerGeneration, candidateId: task.baseCandidateId,
      inputManifestDigest: checkEvidence?.inputManifestDigest || this.candidateStore.get(task.baseCandidateId)?.manifestDigest || null,
      checksPassed: attempt.outcome?.checksPassed === true && checkEvidence?.passed === true,
      productWrites: execution.result?.report?.filesChanged || [], outcome: attempt.outcome, effect: attempt.effect };
  }

  #trustedReviewExecution({ task, attempt }) {
    if (!task || !attempt || attempt.role !== 'verifier' || attempt.state !== 'succeeded'
      || attempt.claimState !== 'released' || attempt.checksPassed !== true || attempt.productWrites?.length
      || attempt.outcome?.trusted !== true || attempt.effect?.remoteQuiescent !== true
      || attempt.effect?.processQuiescent !== true || attempt.effect?.effectsSettled !== true) return false;
    const execution = this.roleService.getExecution(attempt.attemptId);
    const proof = this.db.prepare('SELECT proof_json FROM concurrent_verifier_check_proofs WHERE attempt_id=?').get(attempt.attemptId);
    if (!execution || execution.state !== 'settled' || execution.effectsSettled !== true
      || !execution.providerThreadId || !execution.providerTurnId || execution.checkEvidence?.passed !== true
      || !execution.checkEvidence.evidenceDigest || execution.checkEvidence.inputManifestDigest !== attempt.inputManifestDigest) return false;
    const pins = this.#ownerCheckPins(this.#runByObjective(task.projectId, task.objectiveId));
    if (pins.length) return Boolean(proof && JSON.parse(proof.proof_json).evidenceDigest === execution.checkEvidence.evidenceDigest);
    const evidence = copy(execution.checkEvidence);
    delete evidence.passed;
    const digest = evidence.evidenceDigest;
    delete evidence.evidenceDigest;
    const bound = evidence.projectId === task.projectId && evidence.objectiveId === task.objectiveId
      && evidence.taskId === task.taskId && evidence.attemptId === attempt.attemptId
      && evidence.fencingToken === attempt.fencingToken && evidence.providerContextId === execution.providerContextId
      && evidence.providerThreadId === execution.providerThreadId && evidence.candidateId === task.baseCandidateId
      && evidence.inputManifestDigest === attempt.inputManifestDigest
      && evidence.selectedSettingsDigest === execution.settingsDigest && evidence.requestDigest === execution.requestDigest
      && canonical(evidence.checkPins) === canonical([]) && canonical(evidence.results) === canonical([])
      && Array.isArray(evidence.evidenceRefs) && evidence.evidenceRefs.length > 0;
    return bound && digest === `sha256:${sha256(canonical(evidence))}`;
  }

  #isOutputTrusted({ task, attempt, dependency }) {
    if (!attempt || attempt.state !== 'succeeded' || attempt.outcome?.trusted !== true
      || attempt.effect?.effectsSettled !== true || attempt.effect?.remoteQuiescent !== true
      || attempt.effect?.processQuiescent !== true) return false;
    const execution = this.roleService?.getExecution(attempt.attemptId);
    if (!execution || execution.state !== 'settled' || execution.effectsSettled !== true) return false;
    const candidateId = execution.result?.output?.candidateId;
    if (dependency.expectedOutput && dependency.expectedOutput !== candidateId) return false;
    const candidate = candidateId && this.candidateStore.get(candidateId);
    return Boolean(candidate && candidate.projectId === task.projectId && candidate.objectiveId === task.objectiveId
      && candidate.status === 'known');
  }

  #effectsSettled(objective, attempts) {
    if (!objective || attempts.length) return false;
    const unresolvedRole = this.db.prepare(`SELECT attempt_id FROM delivery_role_executions WHERE project_id=? AND objective_id=?
      AND (state NOT IN ('settled','terminal') OR json_extract(record_json,'$.effectsSettled') IS NOT 1) LIMIT 1`)
      .get(this.projectId, objective.objectiveId);
    const unresolvedPublication = this.db.prepare(`SELECT intent_id FROM delivery_output_publications p
      JOIN delivery_output_bindings b ON b.artifact_id=p.artifact_id WHERE b.project_id=? AND b.objective_id=?
      AND p.state NOT IN ('applied','refused') LIMIT 1`).get(this.projectId, objective.objectiveId);
    const unresolvedCandidate = this.db.prepare(`SELECT intent_id FROM candidate_intents WHERE project_id=? AND objective_id=?
      AND state IN ('prepared','applying','unknown','settling') LIMIT 1`).get(this.projectId, objective.objectiveId);
    const unresolvedWriter = this.db.prepare(`SELECT execution_id FROM writer_executions WHERE workspace=? AND state IN ('active','unresolved') LIMIT 1`)
      .get(this.workspace);
    return !unresolvedRole && !unresolvedPublication && !unresolvedCandidate && !unresolvedWriter;
  }

  #recordControllerFence(run, objective, projection) {
    const encoded = canonical(projection);
    this.db.prepare(`INSERT INTO concurrent_controller_fences(project_id,objective_id,owner_generation,control_revision,status,
      projection_json,projection_digest,created_at) VALUES(?,?,?,?,'fenced',?,?,?)
      ON CONFLICT(project_id,objective_id) DO UPDATE SET owner_generation=excluded.owner_generation,
      control_revision=excluded.control_revision,status=excluded.status,projection_json=excluded.projection_json,
      projection_digest=excluded.projection_digest,created_at=excluded.created_at`)
      .run(this.projectId, run.objectiveId, objective.ownerGeneration, objective.controlRevision, encoded,
        `sha256:${sha256(encoded)}`, this.now());
  }

  #recordFailure(runId, failure) {
    const encoded = canonical(failure);
    this.db.prepare('UPDATE concurrent_delivery_runs SET failure_json=?,status=?,updated_at=? WHERE project_id=? AND run_id=?')
      .run(encoded, 'running', this.now(), this.projectId, runId);
    const current = this.#run(runId);
    current.failure = JSON.parse(encoded);
  }

  #savePause(runId, pause) {
    const encoded = canonical(pause);
    this.db.prepare('UPDATE concurrent_delivery_runs SET failure_json=?,status=?,updated_at=? WHERE project_id=? AND run_id=?')
      .run(encoded, 'paused', this.now(), this.projectId, runId);
  }

  #saveStatus(runId, status) {
    this.db.prepare('UPDATE concurrent_delivery_runs SET status=?,updated_at=? WHERE project_id=? AND run_id=?')
      .run(status, this.now(), this.projectId, runId);
  }

  #saveTerminal(runId, finalization) {
    const run = this.#run(runId);
    const acceptance = finalization.finalization?.terminalRecord?.checkResult
      || this.store.getFinalization(this.projectId, run.objectiveId, finalization.finalization?.finalizationId)?.checkResult;
    const result = { runId, status: 'completed', disposition: finalization.state,
      text: `Concurrent delivery accepted candidate ${finalization.finalization?.pins?.candidate?.candidateId || ''}.`,
      rounds: 1, assignments: this.store.getObjective(this.projectId, run.objectiveId).tasks.map((task) => ({ taskId: task.taskId, state: task.state })),
      acceptance: acceptance ? { ...acceptance, disposition: finalization.state } : { disposition: finalization.state, reasons: [] },
      candidateId: finalization.finalization?.pins?.candidate?.candidateId || null };
    this.db.prepare('UPDATE concurrent_delivery_runs SET status=?,result_json=?,updated_at=? WHERE project_id=? AND run_id=?')
      .run('accepted', canonical(result), this.now(), this.projectId, runId);
    return result;
  }

  #terminalResult(run) {
    if (run?.result) return copy(run.result);
    const objective = run && this.store.getObjective(this.projectId, run.objectiveId);
    if (!objective || !['accepted', 'partial'].includes(objective.disposition)) throw error('concurrent_terminal_proof_missing');
    const finalization = this.store.currentFinalizationQualification(this.projectId, run.objectiveId,
      { candidateStore: this.candidateStore, reviewStore: this.reviewStore });
    if (!finalization.current || !finalization.historical?.goalAchieved) throw error('concurrent_finalization_not_current');
    return { runId: run.runId, status: 'completed', disposition: objective.disposition,
      text: `Concurrent delivery accepted candidate ${finalization.historical.pins.candidate.candidateId}.`, rounds: 1,
      assignments: objective.tasks.map((task) => ({ taskId: task.taskId, state: task.state })),
      acceptance: { ...finalization.historical.checkResult, disposition: objective.disposition },
      candidateId: finalization.historical.pins.candidate.candidateId };
  }

  #run(runId) {
    const row = this.db.prepare('SELECT * FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(this.projectId, runId);
    if (!row) return null;
    return { projectId: row.project_id, runId: row.run_id, objectiveId: row.objective_id, sessionId: row.session_id,
      goal: row.goal, contract: JSON.parse(row.contract_json), contractDigest: row.contract_digest,
      requirementDigest: row.requirement_digest, checksDigest: row.checks_digest, environmentDigest: row.environment_digest,
      checkIdentity: row.check_identity, checkpointIds: JSON.parse(row.checkpoint_ids_json), leadThreadId: row.lead_thread_id,
      leadCodexHome: row.lead_codex_home, leadSettings: row.lead_settings_json ? JSON.parse(row.lead_settings_json) : null,
      failure: row.failure_json ? JSON.parse(row.failure_json) : null, status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #runByObjective(projectId, objectiveId) {
    const row = this.db.prepare('SELECT run_id FROM concurrent_delivery_runs WHERE project_id=? AND objective_id=?').get(projectId, objectiveId);
    return row ? this.#run(row.run_id) : null;
  }
  #objectiveForRun(runId) { const run = this.#run(runId); return run ? this.store.getObjective(this.projectId, run.objectiveId) : null; }
  #isKnownRun(projectId, objectiveId) { return Boolean(this.db.prepare('SELECT 1 FROM concurrent_delivery_runs WHERE project_id=? AND objective_id=?').get(projectId, objectiveId)); }
  #latestCandidate(objectiveId) {
    const row = this.db.prepare(`SELECT candidate_id FROM ${CONCURRENT_TABLES.candidates} WHERE project_id=? AND objective_id=? AND status='known'
      ORDER BY integration_generation DESC,candidate_id DESC LIMIT 1`).get(this.projectId, objectiveId);
    return row ? this.candidateStore.get(row.candidate_id) : null;
  }
  #baseCandidateId(run) { return `candidate-base-${sha256(`${run.projectId}:${run.objectiveId}`).slice(0, 24)}`; }
  #leadThread(run) {
    const thread = this.leadThreads.get(run.runId) || run.leadSettings;
    return thread ? { ...thread, threadId: run.leadThreadId, codexHome: run.leadCodexHome,
      accountId: thread.accountId || null, settingsDigest: thread.settingsDigest || stableDigest(thread.settings),
      transportKey: thread.transportKey || `lead:${this.projectId}:${run.sessionId}:${run.leadCodexHome}` } : null;
  }
  #providerIdentity() {
    const currentValue = this.providerIdentityFor();
    if (currentValue && typeof currentValue.then === 'function') throw error('concurrent_provider_identity_async');
    const current = normalizeProviderIdentity(currentValue);
    if (current.accountId !== this.providerIdentity.accountId || current.codexHome !== this.providerIdentity.codexHome) {
      throw error('concurrent_provider_identity_changed');
    }
    return this.providerIdentity;
  }
  #assertRoleSettings(role, settings, code) {
    if (canonical(effectiveRoleSettings(role)) !== canonical(pinnedRoleSettings(settings))) throw error(code);
  }

  #requestFor({ task, settings, role }) {
    if (!task || !settings || !role) throw error('concurrent_task_request_invalid');
    const frozenReview = task.kind === 'review' && task.role === 'verifier' && task.baseCandidateId
      && task.productWritePaths?.length === 0;
    const request = {
      objective: task.objective,
      allowedFiles: [...(task.productWritePaths || [])],
      inputs: frozenReview
        ? [`Review frozen candidate ${task.baseCandidateId} in the prepared candidate workspace. The host retains the complete read scope and verifies candidate integrity.`]
        : task.readScope?.kind === 'known' ? (task.readScope.paths || []).map((file) => `Frozen candidate path: ${file}`) : [],
      evidence: [...(task.evidenceRefs || [])],
      acceptanceCriteria: Array.isArray(task.acceptance?.criteria) ? task.acceptance.criteria.filter((entry) => typeof entry === 'string') : [],
      checks: [...(task.checks?.checkPins || [])].map((pin) => `Host will execute pinned check: ${pin}`),
      stopConditions: ['Do not publish, modify shared workspace state, or claim acceptance.'],
      skills: this.#skillsFor(task),
      mcpTools: this.#mcpToolsFor(task),
      skillPins: [...(task.skillPins || [])],
      mcpToolPins: [...(task.toolPins || [])],
    };
    return { request, threadId: null,
      transportKey: `delivery:${this.projectId}:${canonicalRoleId(role.id || role.name)}:${settings.accountId}:${settings.codexHome}` };
  }
  #settingsFor({ task } = {}) {
    const role = this.roleFor(task?.role || 'verifier');
    if (!role) throw error('concurrent_role_unconfigured');
    const provider = this.#providerIdentity();
    return { model: role.model || null, effort: role.effort || role.reasoningEffort || null,
      fast: role.fast ?? role.fastMode ?? null, codexHome: provider.codexHome,
      accountId: provider.accountId, executionPermissions: this.executionPermissions,
      selectedSkills: this.#skillsFor(task), selectedMcpTools: this.#mcpToolsFor(task) };
  }
  #capacities(overrides) {
    const capacities = {};
    for (const [key, role] of this.roles) {
      const id = canonicalRoleId(role.id || key);
      const n = overrides[id] ?? (['verifier', 'auditor'].includes(id) ? 2 : id === 'coordinator' ? 1 : 4);
      if (!Number.isSafeInteger(n) || n < 1) throw error('concurrent_role_capacity_invalid');
      capacities[id] = n;
    }
    return capacities;
  }
  #ownerCheckPins(run) { return (this.checkContract.get(run.objectiveId) || run.contract).requiredChecks.map((check) => check.id).sort(); }
  #skillsFor() { return []; }
  #mcpToolsFor() { return []; }
  #leadSkills() { return []; }
  #leadMcpTools() { return []; }
  #workspaceForProject(projectId) { if (projectId !== this.projectId) throw error('concurrent_project_scope_mismatch'); return this.workspace; }
  #plannerSchema() {
    const object = (properties) => ({ type: 'object', additionalProperties: false,
      required: Object.keys(properties), properties });
    const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
    const stringArray = { type: 'array', items: { type: 'string' } };
    const pathArray = { type: 'array', items: { type: 'string',
      pattern: String.raw`^[^/\\]+(/[^/\\]+)*$`,
      description: 'Workspace-relative path only. No absolute paths, backslashes, dot or dot-dot segments. External host acceptance scripts are not candidate paths.' } };
    const dependency = object({
      projectId: { type: 'string' }, objectiveId: { type: 'string' },
      predecessorType: { type: 'string', enum: ['task', 'checkpoint'] }, predecessorId: { type: 'string' },
      successorTaskId: { type: 'string' }, kind: { type: 'string', enum: ['requires_output', 'requires_acceptance', 'integration_after'] },
      expectedOutput: { ...nullable({ type: 'string' }), description: 'Use the exact known candidate ID required by the successor, or null. Never put narrative text here.' },
    });
    const plannerTask = object({
      schemaVersion: { type: 'string', enum: [VERSION] }, projectId: { type: 'string' }, objectiveId: { type: 'string' },
      taskId: { type: 'string' }, revision: { type: 'integer' }, role: { type: 'string', enum: this.roleIds.filter((role) => !['review', 'verifier', 'auditor', 'coordinator'].includes(canonicalRoleId(role))) }, kind: { type: 'string' },
      objective: { type: 'string' }, priority: { type: 'integer' }, dependencies: { type: 'array', items: dependency },
      productWritePaths: pathArray,
      readScope: { anyOf: [
        object({ kind: { type: 'string', enum: ['known'] }, paths: pathArray, reason: { type: 'null' } }),
        object({ kind: { type: 'string', enum: ['unknown'] }, paths: { type: 'null' }, reason: { type: 'string' } }),
      ] },
      scratchWriteRoots: pathArray, resourceClaims: stringArray,
      publicationAuthority: object({ state: { type: 'string', enum: ['denied', 'unknown'] } }),
      state: { type: 'string', enum: ['draft', 'queued', 'blocked'] },
    });
    const taskChange = { anyOf: [object({ task: plannerTask }), object({ task: plannerTask, expectedRevision: { type: 'integer' } })] };
    const delta = object({
      schemaVersion: { type: 'string', enum: [VERSION] }, expectedPlanRevision: { type: 'integer' },
      expectedGoalRevision: { type: 'integer' }, expectedAuthorityRevision: { type: 'integer' },
      expectedControlRevision: { type: 'integer' }, nextPlanRevision: { type: 'integer' },
      tasks: { type: 'array', items: taskChange }, dependencies: { type: 'array', items: dependency },
    });
    const option = object({ id: { type: 'string' }, description: { type: 'string' } });
    const ownerDecision = object({
      decisionId: { type: 'string' }, reason: { type: 'string', enum: HUMAN_REASONS }, question: { type: 'string' },
      options: { type: 'array', items: option }, recommendation: { type: 'string' }, evidenceRefs: stringArray,
      obligations: { type: 'array', items: object({
        kind: { type: 'string', enum: ['task', 'objective_acceptance'] }, id: { type: 'string' },
      }) },
    });
    return object({
      expected: object({ planRevision: { type: 'integer' }, goalRevision: { type: 'integer' },
        authorityRevision: { type: 'integer' }, controlRevision: { type: 'integer' }, inboxVersion: { type: 'integer' } }),
      delta: nullable(delta), dialogue: nullable({ type: 'string' }),
      recovery: nullable(object({ hypothesisId: nullable({ type: 'string' }), strategyId: nullable({ type: 'string' }), mode: nullable({ type: 'string' }) })),
      ownerDecision: nullable(ownerDecision),
    });
  }
  #syncReviewTaskState(taskIds, state) {
    for (const taskId of taskIds) this.db.prepare('UPDATE review_tasks SET state=? WHERE task_id=?').run(state, taskId);
  }
  async #drainRoleCalls() {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (!this.roleService.active.size) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw error('concurrent_shutdown_unsafe');
  }
  #finalCheckProof(finalizationId) {
    if (!finalizationId) return null;
    const row = this.db.prepare('SELECT check_attempt_id,pins_json,result_json,result_digest FROM concurrent_finalization_check_proofs WHERE finalization_id=?').get(finalizationId);
    return row ? { checkAttemptId: row.check_attempt_id, pins: JSON.parse(row.pins_json), result: JSON.parse(row.result_json), resultDigest: row.result_digest } : null;
  }
  #ownerCorrectionAuthorized(facts) {
    if (typeof this.ownerCorrectionAuthorized !== 'function' || this.ownerCorrectionAuthorized(facts) !== true) return false;
    return this.#isKnownRun(facts.projectId, facts.objectiveId);
  }
}

function controllerWake(controller) { if (controller) controller.wake('review.tasks_added'); }

module.exports = { ConcurrentDeliveryEngine };
