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
const { finalizeCandidate, runFrozenCandidateChecks, measureCandidateTree } = require('./delivery-acceptance');
const { validateAcceptanceContract } = require('./acceptance');
const { HUMAN_REASONS } = require('./contracts');
const { VERSION, validateTask } = require('./delivery-contracts');
const { canonicalRoleId, getRole } = require('./role-names');

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
    try { observed = measureCandidateTree(this.workspace, manifest); } catch (_) { return null; }
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
    for (const identity of phase.attempts) {
      await this.roleService.prepareTerminalFailure(identity);
      const attempt = this.store.listAttempts(this.projectId, identity.objectiveId).find((entry) => entry.attemptId === identity.attemptId);
      if (!['failed', 'canceled'].includes(attempt?.state)) {
        this.store.requestLifecycleRecovery(this.projectId, identity.objectiveId, identity.recoveryGeneration);
      }
      this.executor.reconcileTerminalFailure(identity);
    }
    const result = await this.shutdown({ prepared: true });
    phase.phase = 'released';
    this.db.prepare('UPDATE concurrent_shutdown_phases SET phase_json=? WHERE project_id=?').run(canonical(phase), this.projectId);
    return result;
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
      if (!controller || controller.shutdownRequested) controller = await this.#controller(run, { prepareThread: false });
      controller.applyPendingOwnerCorrections();
      objective = this.store.getObjective(this.projectId, run.objectiveId);
      if (objective.disposition === 'paused_owner') {
        const control = this.store.getLifecycleControl(this.projectId, run.objectiveId);
        if (control?.cause === 'owner_pause' || control?.cause === 'owner_stop') controller.resumeObjective();
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
    const prompt = { ...turn.prompt, ownerContext, policy: {
      allowedRoles: this.roleIds.filter((role) => !['verifier', 'auditor', 'coordinator'].includes(canonicalRoleId(role))),
      mandatoryReviewRole: 'verifier', mandatoryOwnerCheckpoint: this.#ownerCheckpointInventory({ projectId: this.projectId, objectiveId: run.objectiveId }).map((entry) => entry.checkpointId),
      publicationAuthority: 'host-only', completionAuthority: 'host-finalization-only',
    } };
    const input = `Return only JSON matching the requested schema. Plan work for the durable ownerContext and current projection. Do not claim acceptance or completion. Resolve routine reversible choices internally. ownerDecision must be null unless a named owner-only obligation needs a decision after a completed read-only investigation. Cite investigation as attempt:<attemptId> in evidenceRefs. Choosing an option never grants new effect authority.\n${JSON.stringify(prompt)}`;
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
        if (!task || ['review', 'verifier', 'auditor'].includes(canonicalRoleId(task.role)) || !this.roleFor(task.role)) throw error('concurrent_planner_role_denied');
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
    const profilePins = [`verifier-${stableDigest(verifier).slice(7, 31)}`];
    if (!checkpoints.length || checkpoints.some((item) => {
      const checkpoint = rowsById.get(item.checkpointId);
      return !checkpoint || !this.reviewStore.isCheckpointActive({ ...scope, checkpointId: item.checkpointId })
        || checkpoint.kind !== 'owner_request' || checkpoint.critical !== true
        || checkpoint.checkIdentity !== run.checkIdentity || checkpoint.environmentDigest !== run.environmentDigest
        || canonical(checkpoint.checkPins) !== canonical(run.contract.requiredChecks.map((check) => check.id))
        || canonical(checkpoint.toolPins) !== canonical([]) || canonical(checkpoint.profilePins) !== canonical(profilePins);
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
    const row = this.db.prepare(`SELECT candidate_id FROM candidates WHERE project_id=? AND objective_id=? AND status='known'
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
    const request = {
      objective: task.objective,
      allowedFiles: [...(task.productWritePaths || [])],
      inputs: task.readScope?.kind === 'known' ? (task.readScope.paths || []).map((file) => `Frozen candidate path: ${file}`) : [],
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
    return { type: 'object', additionalProperties: false, required: ['expected', 'delta', 'dialogue', 'recovery', 'ownerDecision'],
      properties: { expected: { type: 'object', additionalProperties: true }, delta: { type: ['object', 'null'], additionalProperties: true },
        dialogue: { type: ['string', 'null'] }, recovery: { type: ['object', 'null'], additionalProperties: true },
        ownerDecision: { type: ['object', 'null'], additionalProperties: false,
          required: ['decisionId', 'reason', 'question', 'options', 'recommendation', 'evidenceRefs', 'obligations'],
          properties: { decisionId: { type: 'string' }, reason: { type: 'string', enum: HUMAN_REASONS }, question: { type: 'string' },
            options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'description'], properties: { id: { type: 'string' }, description: { type: 'string' } } } },
            recommendation: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } },
            obligations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['task', 'objective_acceptance'] }, id: { type: 'string' } } } } } } } };
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
