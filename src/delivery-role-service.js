'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, Role, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const { ClientFactory } = require('@a2a-js/sdk/client');
const {
  WORKER_REPORT_SCHEMA, checkSpecialistRequest, normalizeSpecialistRequest, parseWorkerReport, pathsOutsideAllowed,
  classifyCodexError,
} = require('./contracts');
const { isProcessGroupGone } = require('./process-quiescence');
const { stableDigest } = require('./backlog-store');
const { deliveryRequestDigest, scopedExecutionDetails } = require('./delivery-role-capabilities');
const { canonicalRoleId, roleDisplayName } = require('./role-names');
const { measureCandidateTree } = require('./delivery-acceptance');
const { captureManifest } = require('./candidate-store');
const { reviewResult } = require('./review-policy');
const { CONCURRENT_TABLES } = require('./concurrent-table-names');

const TERMINAL = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]);
const ACTIVE = new Set(['claimed', 'running']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const nowIso = () => new Date().toISOString();
const copy = (value) => value == null ? value : structuredClone(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const error = (code, message = code) => Object.assign(new Error(message), { code });

function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw error('delivery_role_identity_invalid', `${name} is invalid`);
  return value;
}

function extractText(message) {
  if (!Array.isArray(message?.parts) || !message.parts.length) throw error('delivery_role_text_required');
  const values = [];
  for (const part of message.parts) {
    if (part?.content?.$case === 'text' && typeof part.content.value === 'string') values.push(part.content.value);
    else if (typeof part?.text === 'string') values.push(part.text);
    else throw error('delivery_role_text_only');
  }
  return values.join('\n');
}

function makeStatus(state, message) {
  return { state, timestamp: nowIso(), ...(message ? { message } : {}) };
}

function laneHandle(lane) {
  return lane && { ...lane, id: lane.id || lane.laneId };
}

function effectiveFastMode(selected, role) {
  const mode = selected?.fastMode ?? role?.fastMode;
  if (mode === 'inherit' || mode === 'off' || mode === 'on') return mode;
  const legacy = selected?.fast ?? role?.fast;
  return typeof legacy === 'boolean' ? (legacy ? 'on' : 'off') : null;
}

function roleCard(roleId, role, endpoint, settings) {
  const label = role.displayName || (role.name !== roleId ? role.name : roleDisplayName(roleId));
  const selected = settings || role;
  const model = selected.model ?? selected.selectedModel ?? role.model ?? null;
  const effort = selected.effort ?? selected.reasoningEffort ?? role.effort ?? null;
  const fastMode = effectiveFastMode(selected, role);
  const configured = [model && `model=${model}`, effort && `effort=${effort}`, fastMode && `fastMode=${fastMode}`].filter(Boolean).join(', ');
  const description = `${role.description}${configured ? ` Configured execution: ${configured}.` : ''}`;
  return {
    name: label,
    description,
    supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    provider: { url: endpoint, organization: 'Codex Universal' },
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: { bearerAuth: { scheme: { $case: 'httpAuthSecurityScheme', value: {
      description: 'Bearer token required for A2A JSON-RPC requests.', scheme: 'Bearer', bearerFormat: 'opaque',
    } } } },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: roleId, name: label, description, tags: [roleId], examples: [], inputModes: ['text/plain'], outputModes: ['text/plain'], securityRequirements: [] }],
    signatures: [],
  };
}

class DeliveryRoleService {
  constructor({ db, backlogStore, candidateStore, candidateReview, outputArtifacts, lanes, roles, appServer, workspace,
    baseUrl, authMiddleware, authToken, settingsFor, roleFor, resolveVerifierCapability,
    checkEvidenceFor = () => null,
    selectedSkillsFor = () => [], selectedMcpToolsFor = () => [], executionPermissions = 'inherit',
    getProviderIdentity = () => ({ codexHome: appServer?.getCodexHome?.() ?? null }), clock = () => new Date(),
    privateRoot = path.join(os.tmpdir(), 'codex-delivery-role-private') } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('A shared better-sqlite3 database is required');
    if (!backlogStore || backlogStore.db !== db) throw new TypeError('BacklogStore must share the database');
    if (!candidateStore || typeof candidateStore.get !== 'function' || typeof candidateStore.materialize !== 'function') throw new TypeError('CandidateStore is required');
    if (!candidateReview || typeof candidateReview.settleReceipt !== 'function') throw new TypeError('CandidateReview is required');
    if (!outputArtifacts || typeof outputArtifacts.bind !== 'function' || typeof outputArtifacts.capture !== 'function' || typeof outputArtifacts.publish !== 'function') throw new TypeError('DeliveryOutputArtifacts is required');
    if (!lanes || typeof lanes.prepare !== 'function' || typeof lanes.recordTurnStart !== 'function' || typeof lanes.markRunning !== 'function') throw new TypeError('LaneManager is required');
    if (!(roles instanceof Map) || !roles.size) throw new TypeError('Configured roles must be a non-empty Map');
    if (!appServer || typeof appServer.run !== 'function') throw new TypeError('CodexAppServer.run is required');
    if (typeof workspace !== 'string' || !workspace) throw new TypeError('Workspace is required');
    if (typeof authMiddleware !== 'function') throw new TypeError('Authenticated route middleware is required');
    if (typeof authToken !== 'string' || !authToken) throw new TypeError('Local A2A bearer token is required');
    for (const [name, fn] of Object.entries({ settingsFor, roleFor, selectedSkillsFor, selectedMcpToolsFor, getProviderIdentity, clock })) {
      if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
    }
    if (typeof checkEvidenceFor !== 'function') throw new TypeError('checkEvidenceFor must be a function');
    if (resolveVerifierCapability !== undefined && typeof resolveVerifierCapability !== 'function') throw new TypeError('resolveVerifierCapability must be a function');
    const parsedBase = new URL(baseUrl);
    if (parsedBase.hostname !== '127.0.0.1' || parsedBase.protocol !== 'http:') throw new TypeError('baseUrl must be loopback HTTP');
    this.db = db; this.store = backlogStore; this.candidates = candidateStore; this.reviews = candidateReview;
    this.artifacts = outputArtifacts; this.lanes = lanes; this.roles = roles; this.appServer = appServer;
    this.workspace = fs.realpathSync(workspace); this.baseUrl = parsedBase.origin; this.authMiddleware = authMiddleware;
    this.authToken = authToken; this.settingsFor = settingsFor; this.roleFor = roleFor;
    this.resolveVerifierCapability = resolveVerifierCapability || null;
    this.checkEvidenceFor = checkEvidenceFor;
    this.selectedSkillsFor = selectedSkillsFor; this.selectedMcpToolsFor = selectedMcpToolsFor;
    this.executionPermissions = executionPermissions; this.getProviderIdentity = getProviderIdentity;
    this.clock = clock; this.privateRoot = path.resolve(privateRoot); this.clients = new Map(); this.active = new Map(); this.capabilities = new Map();
    fs.mkdirSync(this.privateRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.privateRoot) !== this.privateRoot || this.privateRoot.startsWith(`${this.workspace}${path.sep}`)
      || this.workspace.startsWith(`${this.privateRoot}${path.sep}`)) throw error('delivery_role_private_root_unsafe');
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_role_executions (
        attempt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL, task_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL, provider_context_id TEXT NOT NULL, external_task_id TEXT NOT NULL,
        role_id TEXT NOT NULL, request_digest TEXT NOT NULL, settings_digest TEXT NOT NULL,
        state TEXT NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_role_external_task_idx ON delivery_role_executions(external_task_id);
      CREATE INDEX IF NOT EXISTS delivery_role_context_idx ON delivery_role_executions(provider_context_id);
    `);
  }

  now() { const value = this.clock(); return value instanceof Date ? value.toISOString() : String(value); }

  #role(roleId) {
    const wanted = canonicalRoleId(roleId);
    for (const [key, role] of this.roles) if (canonicalRoleId(role.id || key) === wanted) return { id: wanted, ...copy(role) };
    throw error('delivery_role_unconfigured');
  }

  #snapshot(metadata, externalTaskId, contextId, roleId) {
    const metadataKeys = ['attemptId', 'capabilityId', 'fencingToken', 'objectiveId', 'productWritePaths', 'projectId',
      'providerContextId', 'requestDigest', 'scratchWriteRoots', 'taskId', 'threadId'];
    if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).some((key) => !metadataKeys.includes(key))) throw error('delivery_role_metadata_invalid');
    for (const field of ['projectId', 'objectiveId', 'taskId', 'attemptId', 'providerContextId', 'requestDigest']) id(metadata?.[field], field);
    if (!Number.isSafeInteger(metadata.fencingToken) || metadata.fencingToken < 1) throw error('delivery_role_fence_invalid');
    if (metadata.providerContextId !== contextId) throw error('delivery_role_context_mismatch');
    const objective = this.store.getObjective(metadata.projectId, metadata.objectiveId);
    const attempt = this.store.listAttempts(metadata.projectId, metadata.objectiveId).find((row) => row.attemptId === metadata.attemptId);
    const claim = this.store.listClaims(metadata.projectId, metadata.objectiveId).find((row) => row.attemptId === metadata.attemptId);
    const task = objective?.tasks?.find((row) => row.taskId === metadata.taskId);
    if (!objective || !attempt || !claim || !task) throw error('delivery_role_claim_missing');
    const contract = attempt.contractSnapshot;
    if (objective.disposition !== 'executing' && objective.disposition !== 'planning') throw error('delivery_role_objective_inactive');
    if (claim.state !== 'active' || claim.leaseUntil <= Date.now() || !ACTIVE.has(attempt.state) || !ACTIVE.has(task.state)
      || attempt.taskId !== task.taskId || claim.taskId !== task.taskId || claim.projectId !== metadata.projectId
      || claim.objectiveId !== metadata.objectiveId || claim.fencingToken !== metadata.fencingToken
      || attempt.fencingToken !== metadata.fencingToken || attempt.providerContextId !== contextId
      || attempt.executionGeneration !== objective.ownerGeneration || claim.ownerGeneration !== objective.ownerGeneration
      || attempt.taskRevision !== task.revision || contract?.taskId !== task.taskId || stableDigest(contract) !== attempt.contractDigest
      || stableDigest({ ...task, state: contract.state }) !== attempt.contractDigest
      || attempt.capturedControls?.controlRevision !== objective.controlRevision
      || attempt.capturedControls?.authorityRevision !== objective.authorityRevision
      || attempt.capturedControls?.selectedSettingsKnown !== true
      || !/^sha256:[a-f0-9]{64}$/.test(attempt.selectedSettingsDigest)) throw error('delivery_role_claim_stale');
    if (task.role !== roleId || contract.role !== roleId) throw error('delivery_role_role_mismatch');
    if (canonical(metadata.productWritePaths || []) !== canonical(contract.productWritePaths || [])
      || canonical(metadata.scratchWriteRoots || []) !== canonical(contract.scratchWriteRoots || [])) throw error('delivery_role_metadata_scope_mismatch');
    if (attempt.externalTaskId && attempt.externalTaskId !== externalTaskId) throw error('delivery_role_external_task_mismatch');
    if (metadata.threadId !== undefined && metadata.threadId !== (attempt.threadId || null)) throw error('delivery_role_thread_mismatch');
    if (attempt.state === 'running' && (attempt.externalTaskId !== externalTaskId || task.state !== 'running')) throw error('delivery_role_ack_mapping_mismatch');
    return { objective, attempt, claim, task, contract };
  }

  #assertCurrent(record, { requireMapped = false } = {}) {
    const snapshot = this.#snapshot(record.metadata, record.externalTaskId, record.contextId, record.roleId);
    if (snapshot.attempt.selectedSettingsDigest !== record.settingsDigest || snapshot.attempt.contractDigest !== record.contractDigest
      || snapshot.objective.ownerGeneration !== record.ownerGeneration || snapshot.objective.controlRevision !== record.controlRevision
      || snapshot.objective.authorityRevision !== record.authorityRevision) throw error('delivery_role_pins_stale');
    const provider = this.getProviderIdentity({ projectId: record.projectId, roleId: record.roleId });
    if (!provider || canonical(provider) !== canonical(record.providerIdentity)) throw error('delivery_role_provider_identity_changed');
    const selected = this.settingsFor({ task: copy(snapshot.task), attempt: copy(snapshot.attempt), objective: copy(snapshot.objective) });
    if (!selected || typeof selected.then === 'function' || stableDigest(selected) !== record.settingsDigest) {
      selected?.catch?.(() => {});
      throw error('delivery_role_selected_settings_changed');
    }
    if (requireMapped && snapshot.attempt.state === 'running' && snapshot.attempt.externalTaskId !== record.externalTaskId) throw error('delivery_role_external_task_mismatch');
    return snapshot;
  }

  #assertTerminalIdentity(record, { task, attempt, remote }) {
    const objective = this.store.getObjective(record.projectId, record.objectiveId);
    const currentAttempt = this.store.listAttempts(record.projectId, record.objectiveId).find((row) => row.attemptId === record.attemptId);
    const claim = this.store.listClaims(record.projectId, record.objectiveId).find((row) => row.attemptId === record.attemptId);
    const currentTask = objective?.tasks?.find((row) => row.taskId === record.taskId);
    const contract = currentAttempt?.contractSnapshot;
    if (!objective || !currentAttempt || !claim || !currentTask || objective.ownerGeneration !== record.ownerGeneration
      || claim.ownerGeneration !== record.ownerGeneration || claim.state !== 'active' || claim.leaseUntil <= Date.now()
      || currentAttempt.state !== 'running' || currentTask.state !== 'running'
      || currentAttempt.attemptId !== attempt.attemptId || currentAttempt.fencingToken !== record.fencingToken
      || claim.fencingToken !== record.fencingToken || currentAttempt.taskId !== record.taskId
      || currentAttempt.providerContextId !== record.contextId || currentAttempt.externalTaskId !== record.externalTaskId
      || currentAttempt.taskRevision !== record.taskRevision || currentTask.revision !== record.taskRevision
      || currentAttempt.contractDigest !== record.contractDigest || !contract || stableDigest(contract) !== record.contractDigest
      || stableDigest({ ...currentTask, state: contract.state }) !== record.contractDigest
      || currentAttempt.selectedSettingsDigest !== record.settingsDigest
      || currentAttempt.providerContextId !== attempt.providerContextId || remote.id !== record.externalTaskId
      || remote.contextId !== record.contextId || task.taskId !== record.taskId) {
      throw error('delivery_role_terminal_identity_unavailable');
    }
    return { publicationAuthorizationChanged: objective.controlRevision !== record.controlRevision
      || objective.authorityRevision !== record.authorityRevision || objective.goalRevision !== record.goalRevision
      || !['executing', 'planning'].includes(objective.disposition) };
  }

  async #settleTerminalWithoutPublication(record, failureKind) {
    if (record.laneId && this.lanes.complete) {
      const lane = this.lanes.store.get(record.laneId);
      if (lane && ['prepared', 'running'].includes(lane.state)) await this.lanes.complete({ lane: laneHandle(lane), integrate: false,
        reason: failureKind, allowedFiles: record.writePaths, role: record.roleId,
        taskId: record.attemptId, contextId: record.contextId });
    }
    record.failureCode = failureKind;
    record.result = { output: { state: 'not_published', candidateId: null, artifactId: null, publication: null },
      failureCode: failureKind, terminalStatus: record.terminalStatus };
    record.state = 'settled'; this.#set(record);
    return { result: { state: 'failed', failureKind, publicationState: 'not_published' },
      evidence: { remoteQuiescent: record.effectsSettled === true, processQuiescent: record.effectsSettled === true,
        effectsSettled: record.effectsSettled === true, controllerValidated: false, producerExecutionId: record.attemptId,
        providerContextId: record.providerContextId, providerThreadId: record.providerThreadId, providerTurnId: record.providerTurnId,
        selectedSettingsDigest: record.settingsDigest, requestDigest: record.requestDigest, outputState: 'not_published',
        evidenceRefs: [`delivery-role-execution:${record.attemptId}`] } };
  }

  #set(record) {
    record.updatedAt = this.now();
    this.db.prepare('UPDATE delivery_role_executions SET state=?,record_json=?,updated_at=? WHERE attempt_id=?')
      .run(record.state, canonical(record), record.updatedAt, record.attemptId);
  }

  getExecution(attemptId) {
    const row = this.db.prepare('SELECT record_json FROM delivery_role_executions WHERE attempt_id=?').get(attemptId);
    return row ? copy(JSON.parse(row.record_json)) : null;
  }

  #isSettledTerminalShutdownReplay(record, attempt, claim, row, objective) {
    const proofDigest = record?.terminalShutdown?.digest;
    const settings = record?.selectedSettings;
    const provider = record?.providerIdentity;
    if (record?.state !== 'settled' || record.effectsSettled !== true
      || record.terminalShutdown?.phase !== 'proven'
      || !['failed', 'canceled'].includes(attempt?.state) || claim?.state !== 'released' || row?.state !== 'settled'
      || typeof proofDigest !== 'string'
      || !attempt.evidenceRefs?.includes(`delivery-terminal-failure:${record.attemptId}:${proofDigest}`)
      || !settings || typeof settings !== 'object' || Array.isArray(settings)
      || !provider || typeof provider !== 'object' || Array.isArray(provider)
      || typeof provider.codexHome !== 'string' || !provider.codexHome
      || settings.codexHome !== provider.codexHome
      || (provider.accountId !== undefined && (typeof provider.accountId !== 'string' || !provider.accountId
        || (settings.accountId !== undefined && settings.accountId !== provider.accountId)))) return false;
    const currentSettings = this.settingsFor({ task: copy(attempt.contractSnapshot), attempt: copy(attempt), objective: copy(objective) });
    if (currentSettings?.then) { currentSettings.catch?.(() => {}); return false; }
    if (!currentSettings || typeof currentSettings !== 'object' || Array.isArray(currentSettings)) return false;
    const currentKeys = Object.keys(currentSettings);
    const savedKeys = Object.keys(settings);
    if (canonical([...currentKeys].sort()) !== canonical([...savedKeys].sort())) return false;
    // stableDigest uses insertion order, but #set persists the enclosing record with sorted keys.
    const persistedSettingsInResolverOrder = {};
    for (const key of currentKeys) persistedSettingsInResolverOrder[key] = settings[key];
    return stableDigest(persistedSettingsInResolverOrder) === record.settingsDigest;
  }

  #noPublicationRecoverySnapshot(identity, terminalShutdown = false) {
    const record = this.getExecution(identity?.attemptId);
    const fail = () => { throw error('delivery_role_recovery_proof_unavailable'); };
    if (!record || this.active.has(record.externalTaskId) || !['terminal', 'recovering_no_publication', 'settled'].includes(record.state)
      || record.effectsSettled !== true || !record.providerInvocationStarted
      || (terminalShutdown ? !['completed', 'failed', 'canceled'].includes(record.terminalStatus) : record.terminalStatus !== 'completed')) fail();
    const objective = this.store.getObjective(record.projectId, record.objectiveId);
    const attempt = this.store.listAttempts(record.projectId, record.objectiveId).find((entry) => entry.attemptId === record.attemptId);
    const claim = this.store.listClaims(record.projectId, record.objectiveId).find((entry) => entry.attemptId === record.attemptId);
    const row = this.db.prepare('SELECT * FROM task_executor_attempts WHERE attempt_id=?').get(record.attemptId);
    const intent = row && JSON.parse(row.record_json);
    if (!objective || !attempt || !claim || !intent || (!terminalShutdown && ['succeeded', 'failed', 'canceled'].includes(attempt.state))
      || identity.projectId !== record.projectId || identity.objectiveId !== record.objectiveId
      || identity.taskId !== record.taskId || identity.fencingToken !== record.fencingToken
      || identity.recoveryGeneration !== objective.ownerGeneration
      || (terminalShutdown && objective.ownerGeneration !== record.ownerGeneration)
      || claim.ownerGeneration !== record.ownerGeneration || attempt.executionGeneration !== record.ownerGeneration
      || claim.fencingToken !== record.fencingToken || attempt.fencingToken !== record.fencingToken
      || attempt.taskId !== record.taskId || claim.taskId !== record.taskId
      || attempt.taskRevision !== record.taskRevision || attempt.contractDigest !== record.contractDigest
      || stableDigest(attempt.contractSnapshot) !== record.contractDigest
      || attempt.providerContextId !== record.providerContextId || record.contextId !== record.providerContextId
      || attempt.selectedSettingsDigest !== record.settingsDigest
      || record.requestDigest !== record.requestDigestObserved || intent.requestDigest !== record.requestDigest
      || row.request_digest !== record.requestDigest || row.context_id !== record.contextId
      || row.project_id !== record.projectId || row.objective_id !== record.objectiveId || row.task_id !== record.taskId
      || row.fencing_token !== record.fencingToken || intent.attemptId !== record.attemptId
      || (row.external_task_id && row.external_task_id !== record.externalTaskId)
      || (attempt.externalTaskId && attempt.externalTaskId !== record.externalTaskId)
      || !['intent', 'submitted', 'uncertain', ...(terminalShutdown ? ['settled'] : [])].includes(row.state)) fail();
    const settledTerminalShutdownReplay = terminalShutdown
      && this.#isSettledTerminalShutdownReplay(record, attempt, claim, row, objective);
    if (!settledTerminalShutdownReplay) {
      const provider = this.getProviderIdentity({ projectId: record.projectId, roleId: record.roleId });
      const settings = this.settingsFor({ task: copy(attempt.contractSnapshot), attempt: copy(attempt), objective: copy(objective) });
      if (settings?.then) { settings.catch?.(() => {}); fail(); }
      const role = this.roleFor(record.roleId, settings);
      if (canonical(provider) !== canonical(record.providerIdentity) || stableDigest(settings) !== record.settingsDigest
        || canonical(settings) !== canonical(record.selectedSettings)
        || !role || canonicalRoleId(role.id || role.name) !== record.roleId
        || (role.model || null) !== (record.selectedSettings.model || null)
        || effectiveFastMode(settings, role) !== record.provenance?.fastMode) fail();
    }
    const execution = record.execution;
    if (!record.providerThreadId || !record.providerTurnId || !execution
      || execution.threadId !== record.providerThreadId || execution.turnId !== record.providerTurnId
      || execution.turnStartSent !== true || execution.turnStartRejected !== false || execution.turnTerminal !== true
      || !execution.processIdentity || !Number.isSafeInteger(execution.processIdentity.pid) || execution.processIdentity.pid <= 1
      || !Number.isSafeInteger(execution.processIdentity.pgid) || typeof execution.processIdentity.startTime !== 'string'
      || !execution.processIdentity.startTime) fail();
    const bindings = this.db.prepare('SELECT * FROM delivery_output_bindings WHERE attempt_id=?').all(record.attemptId);
    if (this.db.prepare(`SELECT 1 FROM delivery_output_publications p JOIN delivery_output_bindings b
      ON b.artifact_id=p.artifact_id WHERE b.attempt_id=? LIMIT 1`).get(record.attemptId)
      || this.db.prepare('SELECT 1 FROM candidate_intents WHERE attempt_id=? LIMIT 1').get(record.attemptId)
      || this.db.prepare(`SELECT 1 FROM ${CONCURRENT_TABLES.candidates} WHERE source_attempt_id=? LIMIT 1`).get(record.attemptId)) fail();
    let lane = null;
    if (record.laneId) {
      lane = this.lanes.store.get(record.laneId);
      const binding = bindings.length === 1 && JSON.parse(bindings[0].identity_json);
      if (!lane || !(terminalShutdown ? ['worktree', 'cooperative'] : ['worktree']).includes(this.lanes.mode) || lane.workspace !== this.workspace || lane.taskId !== record.attemptId
        || lane.contextId !== record.providerContextId
        || (!['prepared', 'running', 'not_integrated'].includes(lane.state)
          && !(terminalShutdown && lane.state === 'orphaned' && lane.reason === 'server_restart'
            && record.terminalShutdown?.phase === 'prepared'))
        || (lane.state === 'not_integrated' && lane.reason !== (terminalShutdown ? 'shutdown_terminal_failure' : 'recovery_no_publication'))
        || !lane.baseCommit || !lane.path || fs.realpathSync(lane.path) !== lane.path
        || !lane.path.startsWith(`${fs.realpathSync(this.lanes.lanesRoot)}${path.sep}`)
        || lane.turnStart?.threadId !== record.providerThreadId
        || canonical(lane.turnStart.processIdentity) !== canonical(execution.processIdentity)
        || !binding || bindings[0].artifact_id !== record.artifactId || binding.laneId !== record.laneId
        || binding.projectId !== record.projectId || binding.objectiveId !== record.objectiveId || binding.taskId !== record.taskId
        || binding.attemptId !== record.attemptId || binding.fencingToken !== record.fencingToken
        || binding.ownerGeneration !== record.ownerGeneration || binding.controlRevision !== record.controlRevision
        || binding.goalRevision !== record.goalRevision || binding.authorityRevision !== record.authorityRevision
        || binding.contractDigest !== record.contractDigest || binding.selectedSettingsDigest !== record.settingsDigest
        || binding.baseCandidateId !== record.baseCandidateId || canonical(binding.declaredWritePaths) !== canonical([...record.writePaths].sort())
        || binding.providerContextId !== record.providerContextId || binding.lanePath !== lane.path
        || binding.baseCommit !== lane.baseCommit || !['bound', 'captured'].includes(bindings[0].state)) fail();
    } else if (record.writePaths.length || bindings.length) fail();
    const start = record.providerStartReceipt || lane?.turnStart;
    if (!start || start.threadId !== record.providerThreadId
      || canonical(start.processIdentity) !== canonical(execution.processIdentity)) fail();
    return { record, objective, attempt, claim, intentState: row.state, lane, settledTerminalShutdownReplay };
  }

  async prepareNoPublicationRecovery(identity) {
    let snapshot = this.#noPublicationRecoverySnapshot(identity);
    if (snapshot.record.noPublicationRecovery) {
      if (snapshot.record.noPublicationRecovery.recoveryGeneration !== identity.recoveryGeneration) throw error('delivery_role_recovery_not_prepared');
      return { state: 'prepared', attemptId: identity.attemptId };
    }
    snapshot.record.state = 'recovering_no_publication';
    this.#set(snapshot.record);
    if (snapshot.lane) {
      await this.lanes.complete({ lane: laneHandle(snapshot.lane), integrate: false, reason: 'recovery_no_publication',
        allowedFiles: snapshot.record.writePaths, role: snapshot.record.roleId,
        taskId: snapshot.record.attemptId, contextId: snapshot.record.contextId });
    }
    snapshot = this.#noPublicationRecoverySnapshot(identity);
    const record = snapshot.record;
    record.noPublicationRecovery = { recoveryGeneration: identity.recoveryGeneration,
      executionDigest: `sha256:${hash({ execution: record.execution, requestDigest: record.requestDigest,
        settingsDigest: record.settingsDigest, contractDigest: record.contractDigest, laneId: record.laneId })}` };
    record.result = { output: { state: 'not_published', candidateId: null, artifactId: null, publication: null },
      failureCode: 'recovery_no_publication', terminalStatus: record.terminalStatus };
    record.state = 'settled';
    this.#set(record);
    return { state: 'prepared', attemptId: identity.attemptId };
  }

  recoveryProofFor({ identity } = {}) {
    const { record, attempt, claim, intentState } = this.#noPublicationRecoverySnapshot(identity);
    const prepared = record.noPublicationRecovery;
    if (record.state !== 'settled' || !prepared || prepared.recoveryGeneration !== identity.recoveryGeneration
      || prepared.executionDigest !== `sha256:${hash({ execution: record.execution, requestDigest: record.requestDigest,
        settingsDigest: record.settingsDigest, contractDigest: record.contractDigest, laneId: record.laneId })}`
      || attempt.state !== 'unknown' || !['expired', 'fenced'].includes(claim.state)) throw error('delivery_role_recovery_not_prepared');
    return Object.freeze({ projectId: record.projectId, objectiveId: record.objectiveId, taskId: record.taskId,
      attemptId: record.attemptId, fencingToken: record.fencingToken, claimOwnerGeneration: claim.ownerGeneration,
      recoveryGeneration: identity.recoveryGeneration, providerContextId: record.providerContextId, intentState,
      noEffect: true, remoteQuiescent: true, processQuiescent: true, effectsSettled: true,
      evidenceRefs: Object.freeze([`delivery-role-no-publication:${record.attemptId}:${prepared.executionDigest}`]) });
  }

  #shutdownSnapshot(identity) {
    const snapshot = this.#noPublicationRecoverySnapshot(identity, true);
    const { record, attempt, objective } = snapshot;
    if (['succeeded', 'failed', 'canceled'].includes(attempt.state)
      && (!['failed', 'canceled'].includes(attempt.state) || record.terminalShutdown?.phase !== 'proven'
        || !attempt.evidenceRefs?.includes(`delivery-terminal-failure:${record.attemptId}:${record.terminalShutdown.digest}`))) {
      throw error('delivery_role_shutdown_replay_unavailable');
    }
    const fail = () => { throw error('delivery_role_shutdown_proof_unavailable'); };
    const task = objective.tasks.find((entry) => entry.taskId === record.taskId);
    if (!task || task.revision !== record.taskRevision
      || stableDigest({ ...task, state: attempt.contractSnapshot.state }) !== record.contractDigest) fail();
    const execution = record.execution;
    const receipt = execution.cleanupReceipt;
    if (!receipt || receipt.version !== 1 || receipt.method !== 'thread/backgroundTerminals/clean'
      || receipt.scope !== 'provider-managed-background-terminals' || receipt.completion !== 'confirmed'
      || !Number.isSafeInteger(execution.generation) || receipt.generation !== execution.generation
      || receipt.threadId !== record.providerThreadId || receipt.turnId !== record.providerTurnId
      || canonical(receipt.processIdentity) !== canonical(execution.processIdentity)
      || execution.processIdentity.pgid !== execution.processIdentity.pid
      || execution.escapedProcesses?.length || execution.survivingProcesses?.length
      || execution.processesUnsettled === true || execution.effectsUnsettled === true) fail();
    return snapshot;
  }

  prepareTerminalShutdown(identity) {
    const { record } = this.#shutdownSnapshot(identity);
    const digest = stableDigest({ execution: record.execution, requestDigest: record.requestDigest,
      contractDigest: record.contractDigest, settingsDigest: record.settingsDigest, laneId: record.laneId,
      providerIdentity: record.providerIdentity, ownerGeneration: record.ownerGeneration });
    if (record.terminalShutdown && record.terminalShutdown.digest !== digest) throw error('delivery_role_shutdown_proof_changed');
    if (!record.terminalShutdown) {
      record.terminalShutdown = { digest, processIdentity: copy(record.execution.processIdentity), phase: 'prepared' };
      this.#set(record);
    }
    return copy(record.terminalShutdown);
  }

  async prepareTerminalFailure(identity) {
    let snapshot = this.#shutdownSnapshot(identity);
    if (snapshot.settledTerminalShutdownReplay) return this.terminalFailureProofFor({ identity });
    const prepared = this.prepareTerminalShutdown(identity);
    if (!isProcessGroupGone(prepared.processIdentity)) throw error('delivery_role_shutdown_process_alive');
    if (snapshot.lane && snapshot.lane.state !== 'not_integrated') {
      await this.lanes.complete({ lane: laneHandle(snapshot.lane), integrate: false, reason: 'shutdown_terminal_failure',
        allowedFiles: snapshot.record.writePaths, role: snapshot.record.roleId,
        taskId: identity.attemptId, contextId: snapshot.record.contextId });
    }
    snapshot = this.#shutdownSnapshot(identity);
    if (this.prepareTerminalShutdown(identity).digest !== prepared.digest
      || !isProcessGroupGone(prepared.processIdentity)) throw error('delivery_role_shutdown_proof_changed');
    const record = snapshot.record;
    let drift = null;
    if (record.writePaths.length) {
      const base = this.candidates.get(record.baseCandidateId);
      const manifest = base && this.candidates.readManifest(base.manifestDigest);
      if (!manifest) throw error('delivery_role_shutdown_observation_unavailable');
      const observed = captureManifest(this.workspace);
      drift = { state: 'known', baselineDigest: manifest.digest, observedDigest: observed.digest,
        changed: observed.digest !== manifest.digest, meaning: 'shared_workspace_drift_since_baseline' };
    }
    record.terminalShutdown = { ...prepared, phase: 'proven', drift: prepared.drift || drift };
    record.result = { output: { state: 'not_published', candidateId: null, artifactId: null, publication: null },
      failureCode: 'shutdown_terminal_failure', terminalStatus: record.terminalStatus, sharedWorkspaceDrift: record.terminalShutdown.drift };
    record.state = 'settled'; this.#set(record);
    return this.terminalFailureProofFor({ identity });
  }

  terminalFailureProofFor({ identity } = {}) {
    const { record } = this.#shutdownSnapshot(identity);
    const prepared = this.prepareTerminalShutdown(identity);
    if (prepared.phase !== 'proven' || !isProcessGroupGone(prepared.processIdentity)) throw error('delivery_role_shutdown_not_prepared');
    return Object.freeze({ digest: prepared.digest, projectId: record.projectId, objectiveId: record.objectiveId,
      taskId: record.taskId, attemptId: record.attemptId, fencingToken: record.fencingToken,
      recoveryGeneration: identity.recoveryGeneration, providerContextId: record.providerContextId,
      remoteQuiescent: true, processQuiescent: true, effectsSettled: true,
      evidenceRefs: [`delivery-terminal-failure:${record.attemptId}:${prepared.digest}`],
      result: { state: 'failed', failureKind: 'shutdown_terminal_failure', publicationState: 'not_published' } });
  }

  producerEvidenceFor(binding) {
    const record = this.getExecution(binding?.attemptId);
    if (!record || record.state !== 'terminal' || record.terminalStatus !== 'completed') return null;
    if (record.projectId !== binding.projectId || record.objectiveId !== binding.objectiveId || record.taskId !== binding.taskId
      || record.fencingToken !== binding.fencingToken || record.providerContextId !== binding.providerContextId
      || !record.providerThreadId || !record.providerTurnId) return null;
    const execution = record.execution;
    if (!execution || execution.turnStartSent !== true || execution.turnStartRejected === true || execution.turnTerminal !== true
      || !execution.processIdentity) return null;
    return {
      projectId: record.projectId, objectiveId: record.objectiveId, taskId: record.taskId, attemptId: record.attemptId,
      fencingToken: record.fencingToken, providerContextId: record.providerContextId,
      providerThreadId: record.providerThreadId, providerTurnId: record.providerTurnId, terminalStatus: 'completed',
      providerThreadReceipt: { processIdentity: execution.processIdentity, threadId: record.providerThreadId, turnId: record.providerTurnId,
        turnStartSent: true, turnStartRejected: false, turnTerminal: true },
      remoteQuiescent: true, processQuiescent: true, effectsSettled: record.effectsSettled === true,
      evidenceDigest: `sha256:${hash({ attemptId: record.attemptId, externalTaskId: record.externalTaskId,
        providerContextId: record.providerContextId, providerThreadId: record.providerThreadId,
        providerTurnId: record.providerTurnId, execution, terminalStatus: record.terminalStatus })}`,
    };
  }

  authorizeArtifactBinding(binding) {
    try {
      const record = this.getExecution(binding?.attemptId);
      return Boolean(record && ['running', 'terminal'].includes(record.state)
        && record.contextId === binding.providerContextId && record.projectId === binding.projectId
        && record.objectiveId === binding.objectiveId && record.taskId === binding.taskId
        && record.fencingToken === binding.fencingToken && record.laneId === binding.laneId
        && record.baseCandidateId === binding.baseCandidateId
        && canonical([...record.writePaths].sort()) === canonical([...binding.declaredWritePaths].sort())
        && this.#assertCurrent(record));
    } catch (_) { return false; }
  }

  #knownPublicationRefusal(intentId, record, cause) {
    const intent = this.candidates.getIntent(intentId);
    const admissionApi = this.candidates.admission;
    const lease = admissionApi?.findByContextId?.(intentId) || admissionApi?.findAnyByContextId?.(intentId) || null;
    if (!intent) {
      if (lease || cause?.code !== 'generation_not_monotonic') return null;
      const latest = this.db.prepare(`SELECT candidate_id FROM ${CONCURRENT_TABLES.candidates}
        WHERE project_id=? AND objective_id=? ORDER BY integration_generation DESC LIMIT 1`).get(record.projectId, record.objectiveId);
      const candidate = latest ? this.candidates.get(latest.candidate_id) : null;
      const base = this.candidates.get(record.baseCandidateId);
      if (!candidate || candidate.status !== 'known' || !base || candidate.integrationGeneration <= base.integrationGeneration
        || candidate.parentCandidateId !== base.candidateId || base.integrationGeneration + 1 > candidate.integrationGeneration) return null;
      try {
        if (captureManifest(this.workspace).digest !== candidate.manifestDigest) return null;
      } catch (_) { return null; }
      return { state: 'refused', intent: null, admission: null, candidate, reason: 'generation_not_monotonic' };
    }
    if (intent.state !== 'refused' || intent.attemptId !== record.attemptId || intent.processIdentity) return null;
    if (!lease || !['released', 'reconciled'].includes(lease.state) || lease.contextId !== intentId
      || lease.attemptId !== record.attemptId || lease.projectId !== record.projectId || lease.objectiveId !== record.objectiveId
      || lease.fencingToken !== record.fencingToken || lease.controlRevision !== record.controlRevision) return null;
    return { state: 'refused', intent, admission: lease };
  }

  projection() {
    return this.db.prepare('SELECT record_json FROM delivery_role_executions ORDER BY created_at,attempt_id').all()
      .map((row) => JSON.parse(row.record_json)).map((record) => ({ attemptId: record.attemptId,
        externalTaskId: record.externalTaskId, state: record.state === 'running' && !this.active.has(record.externalTaskId) ? 'unknown' : record.state,
        reconciliation: record.state === 'running' && !this.active.has(record.externalTaskId) ? 'reopen_requires_host_reconciliation' : null, roleId: record.roleId,
        providerContextId: record.providerContextId, providerThreadId: record.providerThreadId || null,
        providerTurnId: record.providerTurnId || null, effectsSettled: record.effectsSettled === true,
        updatedAt: record.updatedAt }));
  }

  #recordInitial({ metadata, externalTaskId, contextId, roleId, requestDigest, settingsDigest, snapshot, request, capability }) {
    const prior = this.getExecution(metadata.attemptId);
    if (prior) {
      if (prior.externalTaskId !== externalTaskId || prior.contextId !== contextId || prior.requestDigest !== requestDigest
        || prior.settingsDigest !== settingsDigest || prior.fencingToken !== metadata.fencingToken) throw error('delivery_role_duplicate_conflict');
      if (prior.state !== 'terminal' && prior.state !== 'unknown') throw error('delivery_role_attempt_busy');
      throw error('delivery_role_attempt_already_dispatched');
    }
    const provider = this.getProviderIdentity({ projectId: metadata.projectId, roleId });
    if (!provider || typeof provider !== 'object') throw error('delivery_role_provider_identity_missing');
    const record = {
      schemaVersion: 'delivery-role-execution/v1', attemptId: metadata.attemptId, projectId: metadata.projectId,
      objectiveId: metadata.objectiveId, taskId: metadata.taskId, fencingToken: metadata.fencingToken,
      providerContextId: contextId, contextId, externalTaskId, roleId, requestDigest, settingsDigest,
      contractDigest: snapshot.attempt.contractDigest, taskRevision: snapshot.task.revision,
      ownerGeneration: snapshot.objective.ownerGeneration, controlRevision: snapshot.objective.controlRevision,
      authorityRevision: snapshot.objective.authorityRevision, goalRevision: snapshot.objective.goalRevision,
      selectedSettings: copy(snapshot.settings), providerIdentity: copy(provider),
      metadata: copy(metadata),
      capabilityId: capability ? scopedExecutionDetails(capability).capabilityId : null,
      requestDigestObserved: requestDigest, state: 'accepted', laneId: null, artifactId: null,
      baseCandidateId: snapshot.task.baseCandidateId || null, writePaths: copy(snapshot.contract.productWritePaths || []),
      providerThreadId: null, providerTurnId: null, execution: null, terminalStatus: null,
      effectsSettled: false, result: null, createdAt: this.now(), updatedAt: this.now(),
      providerInvocationStarted: false,
    };
    this.db.prepare(`INSERT INTO delivery_role_executions(attempt_id,project_id,objective_id,task_id,fencing_token,provider_context_id,
      external_task_id,role_id,request_digest,settings_digest,state,record_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?, 'accepted',?,?,?)`).run(record.attemptId, record.projectId, record.objectiveId, record.taskId,
      record.fencingToken, record.providerContextId, record.externalTaskId, record.roleId, record.requestDigest, record.settingsDigest,
      canonical(record), record.createdAt, record.updatedAt);
    return record;
  }

  #validateRequest(request, metadata, role, snapshot, contextId, externalTaskId) {
    const normalized = normalizeSpecialistRequest(request, role, { workspace: this.workspace });
    const digest = deliveryRequestDigest({ request: normalized, settingsDigest: snapshot.attempt.selectedSettingsDigest,
      taskDigest: snapshot.attempt.contractDigest });
    if (digest !== metadata.requestDigest) throw error('delivery_role_request_digest_mismatch');
    let capability = null;
    if (canonicalRoleId(role.id) === 'verifier') {
      if (!this.resolveVerifierCapability || !metadata.capabilityId) throw error('delivery_role_verifier_capability_required');
      capability = this.resolveVerifierCapability({ projectId: metadata.projectId, objectiveId: metadata.objectiveId,
        taskId: metadata.taskId, attemptId: metadata.attemptId, fencingToken: metadata.fencingToken,
        providerContextId: contextId, requestDigest: metadata.requestDigest, capabilityId: metadata.capabilityId,
        externalTaskId, role: 'verifier', request: normalized }, normalized);
      if (capability && typeof capability.then === 'function') throw error('delivery_role_capability_must_be_synchronous');
      const scoped = scopedExecutionDetails(capability);
      scoped.assertCurrent();
      if (scoped.capabilityId !== metadata.capabilityId || scoped.taskId !== metadata.taskId
        || scoped.attemptId !== metadata.attemptId || scoped.requestDigest !== metadata.requestDigest) throw error('delivery_role_verifier_capability_mismatch');
    } else if (metadata.capabilityId !== undefined) throw error('delivery_role_unexpected_capability');
    const checked = checkSpecialistRequest(request, role, { workspace: this.workspace, capability, requestDigest: metadata.requestDigest });
    if (checked.objective !== snapshot.contract.objective || canonical(checked.allowedFiles) !== canonical(snapshot.contract.productWritePaths || [])) {
      throw error('delivery_role_task_contract_mismatch');
    }
    if (checked.continuation) throw error('delivery_role_continuation_forbidden');
    return { checked, capability };
  }

  async #execute(requestContext, eventBus, roleId, role) {
    const { taskId: externalTaskId, contextId } = requestContext;
    const message = requestContext.userMessage;
    const metadata = message?.metadata || {};
    const inputText = extractText(message);
    let request;
    try { request = JSON.parse(inputText); } catch (_) { throw error('delivery_role_request_json_invalid'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw error('delivery_role_request_object_required');
    const initial = this.#snapshot(metadata, externalTaskId, contextId, roleId);
    const settings = await this.settingsFor({ task: copy(initial.task), attempt: copy(initial.attempt), objective: copy(initial.objective) });
    if (!settings || stableDigest(settings) !== initial.attempt.selectedSettingsDigest) throw error('delivery_role_selected_settings_mismatch');
    const actualRole = this.roleFor(roleId, settings);
    if (!actualRole || canonicalRoleId(actualRole.id || actualRole.name) !== roleId) throw error('delivery_role_configuration_mismatch');
    const { checked, capability } = this.#validateRequest(request, metadata, { id: roleId, ...actualRole }, initial, contextId, externalTaskId);
    const settingsDigest = stableDigest(settings);
    const snapshot = { ...initial, settings };
    let record = this.#recordInitial({ metadata, externalTaskId, contextId, roleId,
      requestDigest: metadata.requestDigest, settingsDigest, snapshot, request: checked, capability });
    if (capability) this.capabilities.set(record.attemptId, capability);
    if (capability) scopedExecutionDetails(capability).assertCurrent();
    const task = requestContext.task || { id: externalTaskId, contextId, status: makeStatus(TaskState.TASK_STATE_SUBMITTED), artifacts: [], history: [], metadata: {} };
    eventBus.publish(AgentEvent.task(task));
    eventBus.publish(AgentEvent.statusUpdate({ taskId: externalTaskId, contextId,
      status: makeStatus(TaskState.TASK_STATE_WORKING), metadata: {} }));
    record.state = 'running'; this.#set(record);
    let lane = null; let privateInput = null; let privateManifest = null;
    const controller = new AbortController();
    this.active.set(externalTaskId, { controller, attemptId: record.attemptId });
    const scoped = capability ? scopedExecutionDetails(capability) : null;
    const writer = role.sandbox !== 'read-only' && checked.allowedFiles.length > 0;
    try {
      this.#assertCurrent(record);
      if (scoped) {
        scoped.assertCurrent();
        if (!scoped.verifyCandidate()) throw error('delivery_role_candidate_drift');
      }
      if (writer) {
        const base = this.candidates.get(snapshot.task.baseCandidateId);
        if (!base || base.status !== 'known' || base.projectId !== metadata.projectId || base.objectiveId !== metadata.objectiveId) throw error('delivery_role_base_candidate_unknown');
        const prepared = await this.lanes.prepare({ contextId, taskId: metadata.attemptId });
        if (!prepared?.lane || prepared.refused) throw error(prepared?.refused?.code || 'delivery_role_lane_prepare_failed');
        lane = prepared.lane; record.laneId = lane.id; record.baseCandidateId = base.candidateId;
        record.state = 'running'; this.#set(record);
        const binding = this.artifacts.bind({ projectId: metadata.projectId, objectiveId: metadata.objectiveId,
          taskId: metadata.taskId, attemptId: metadata.attemptId, fencingToken: metadata.fencingToken,
          laneId: lane.id, baseCandidateId: base.candidateId, declaredWritePaths: checked.allowedFiles,
          environmentDigest: base.environmentDigest, checkIdentity: base.checkIdentity });
        record.artifactId = binding.artifactId; this.#set(record);
        this.lanes.markRunning(lane);
      } else if (!scoped) {
        const base = this.candidates.get(snapshot.task.baseCandidateId);
        if (!base || base.status !== 'known' || base.projectId !== metadata.projectId || base.objectiveId !== metadata.objectiveId) throw error('delivery_role_base_candidate_unknown');
        privateInput = path.join(this.privateRoot, `${metadata.attemptId}.candidate`);
        if (fs.existsSync(privateInput)) throw error('delivery_role_private_input_exists');
        this.candidates.materialize(base.candidateId, privateInput);
        const expectedManifest = this.candidates.readManifest(base.manifestDigest);
        privateManifest = measureCandidateTree(privateInput, expectedManifest);
        if (privateManifest.digest !== expectedManifest.digest) throw error('delivery_role_candidate_materialization_mismatch');
        record.baseCandidateId = base.candidateId; record.state = 'running'; this.#set(record);
      }
      const selectedSkills = await this.selectedSkillsFor({ task: copy(snapshot.task), attempt: copy(snapshot.attempt), settings: copy(settings), request: copy(checked) });
      const selectedMcpTools = await this.selectedMcpToolsFor({ task: copy(snapshot.task), attempt: copy(snapshot.attempt), settings: copy(settings), request: copy(checked) });
      const start = (info) => {
        this.#assertCurrent(record, { requireMapped: true });
        if (scoped) { scoped.assertCurrent(); if (!scoped.verifyCandidate()) throw error('delivery_role_candidate_drift'); }
        if (lane) this.lanes.recordTurnStart(lane, info);
        record.providerStartReceipt = copy(info);
        record.providerThreadId = info.threadId || record.providerThreadId;
        record.execution = { ...(record.execution || {}), processIdentity: copy(info.processIdentity || null), turnStartSent: true };
        record.turnStartObservedAt = this.now(); this.#set(record);
      };
      const input = JSON.stringify(checked);
      this.#assertCurrent(record, { requireMapped: true });
      record.providerInvocationStarted = true;
      record.providerInvocationStartedAt = this.now();
      this.#set(record);
      const result = await this.appServer.run({ role: { id: roleId, ...actualRole },
        cwd: scoped ? scoped.scratchRoot : lane ? lane.workspacePath : privateInput || this.workspace,
        permissionWorkspace: this.executionPermissions === 'full-access'
          ? this.workspace : scoped?.permissionWorkspace || privateInput || this.workspace, input,
        selectedSkills, selectedMcpTools, executionPermissions: this.executionPermissions, outputSchema: WORKER_REPORT_SCHEMA,
        expectedCodexHome: settings.codexHome || snapshot.providerIdentity.codexHome || null,
        ...(scoped ? { deliveryCapability: capability } : {}),
        ...(lane ? { sandboxPolicy: this.lanes.sandboxPolicy(lane) } : {}),
        ...(snapshot.attempt.threadId ? { threadId: snapshot.attempt.threadId } : {}),
        signal: controller.signal,
        onTurnStart: start,
      });
      const terminalObservedAt = this.now();
      if (scoped) {
        if (!scoped.verifyCandidate()) throw error('delivery_role_candidate_drift');
        if (result.threadId) scoped.pinObservedThread(result.threadId);
      }
      if (privateInput) {
        const base = this.candidates.get(record.baseCandidateId);
        const expectedManifest = base && this.candidates.readManifest(base.manifestDigest);
        if (!expectedManifest) throw error('delivery_role_candidate_manifest_missing');
        const after = measureCandidateTree(privateInput, expectedManifest);
        if (after.digest !== privateManifest.digest) throw error('delivery_role_readonly_candidate_changed');
      }
      const parsed = result.status === 'completed' ? parseWorkerReport(result.text) : { report: null, error: 'provider_turn_not_completed' };
      const terminal = result.execution?.turnTerminal === true && result.execution?.turnStartRejected !== true;
      if (result.threadId) record.providerThreadId = result.threadId;
      if (result.turnId) record.providerTurnId = result.turnId;
      record.execution = copy(result.execution || null);
      record.terminalStatus = terminal ? result.status : null;
      if (terminal) record.terminalObservedAt = terminalObservedAt;
      record.state = terminal ? 'terminal' : 'unknown';
      record.report = parsed.report; record.reportError = parsed.error;
      record.resultText = typeof result.text === 'string' ? result.text : '';
      record.usage = copy(result.usage || null); record.permissionEvents = copy(result.permissionEvents || []);
      record.provenance = { roleId, model: settings.model || actualRole.model || null, effort: settings.effort || actualRole.effort || null,
        fastMode: effectiveFastMode(settings, actualRole), contextId, externalTaskId, laneId: lane?.id || null,
        candidateId: record.baseCandidateId, capabilityId: scoped?.capabilityId || null };
      record.effectsSettled = terminal;
      record.state = record.effectsSettled ? 'terminal' : 'unknown';
      this.#set(record);
      const taskState = result.status === 'completed' && parsed.report && parsed.report.outcome === 'completed' && record.effectsSettled
        ? TaskState.TASK_STATE_COMPLETED
        : result.status === 'canceled' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED;
      const artifact = {
        artifactId: `${externalTaskId}-result`, name: `${role.name || roleId} result`, description: role.description || roleId,
        parts: [{ content: { $case: 'text', value: record.resultText } }],
        metadata: { reportError: parsed.error, executionId: metadata.attemptId, requestDigest: metadata.requestDigest }, extensions: [],
      };
      if (taskState === TaskState.TASK_STATE_COMPLETED) eventBus.publish(AgentEvent.artifactUpdate({ taskId: externalTaskId, contextId, artifact, append: false, lastChunk: true, metadata: {} }));
      eventBus.publish(AgentEvent.statusUpdate({ taskId: externalTaskId, contextId,
        status: makeStatus(taskState, taskState === TaskState.TASK_STATE_FAILED ? {
          messageId: `${externalTaskId}-error`, contextId, taskId: externalTaskId, role: Role.ROLE_AGENT,
          parts: [{ content: { $case: 'text', value: parsed.error || `Provider result status: ${result.status}` } }],
        } : undefined), metadata: {} }));
      record.externalState = taskState; this.#set(record);
    } catch (cause) {
      const observed = cause?.execution || null;
      if (observed) record.execution = copy(observed);
      record.providerThreadId = cause?.threadId || record.providerThreadId;
      record.providerTurnId = cause?.turnId || record.providerTurnId;
      record.terminalStatus = observed?.turnTerminal === true ? 'failed' : null;
      if (observed?.turnTerminal === true) record.terminalObservedAt = this.now();
      record.effectsSettled = !record.providerInvocationStarted || (cause?.outcomeUnknown !== true && (observed?.turnStartRejected === true
        || (observed?.turnTerminal === true && cause?.failureClass !== 'background_terminal_cleanup_failed')));
      if (!record.providerInvocationStarted) record.terminalStatus = 'not_started';
      record.state = record.effectsSettled ? 'terminal' : 'unknown';
      record.failureCode = cause?.code || cause?.failureClass || 'delivery_role_execution_failed';
      if (classifyCodexError(cause) === 'usage_limit') record.failureKind = 'usage_limit';
      record.failureMessage = String(cause?.message || cause).slice(0, 400);
      record.externalState = TaskState.TASK_STATE_FAILED;
      this.#set(record);
      eventBus.publish(AgentEvent.statusUpdate({ taskId: externalTaskId, contextId,
        status: makeStatus(TaskState.TASK_STATE_FAILED, {
          messageId: `${externalTaskId}-error`, contextId, taskId: externalTaskId, role: Role.ROLE_AGENT,
          parts: [{ content: { $case: 'text', value: 'The configured role execution did not produce a trusted result.' } }],
        }), metadata: { failureCode: record.failureCode } }));
    } finally {
      this.active.delete(externalTaskId);
      if (privateInput && record.state !== 'unknown') fs.rmSync(privateInput, { recursive: true, force: true });
    }
  }

  register(app) {
    if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') throw new TypeError('Express application is required');
    const registered = new Map();
    for (const [key, configuredRole] of this.roles) {
      const roleId = canonicalRoleId(configuredRole.id || key);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(roleId)) throw error('delivery_role_slug_invalid');
      if (!configuredRole?.name || !configuredRole?.description) throw error('delivery_role_description_required');
      const role = { id: roleId, ...copy(configuredRole) };
      const endpoint = `${this.baseUrl}/delivery/agents/${encodeURIComponent(roleId)}`;
      const card = roleCard(roleId, role, endpoint, role);
      const executor = {
        execute: (requestContext, eventBus) => this.#execute(requestContext, eventBus, roleId, role),
        cancelTask: async (taskId) => { const active = this.active.get(taskId); active?.controller?.abort(); },
      };
      const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
      const cardHandler = agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(card) });
      const route = `/delivery/agents/${encodeURIComponent(roleId)}`;
      app.use(`${route}/agent-card.json`, this.authMiddleware, cardHandler);
      app.use(route, this.authMiddleware, express.json(), jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
      registered.set(roleId, { card, handler, route });
    }
    this.registered = registered;
    return registered;
  }

  transportFor({ role, settings, transportKey }, attemptId) {
    const roleId = canonicalRoleId(role?.id || role?.name);
    if (!this.registered?.has(roleId)) throw error('delivery_role_route_unregistered');
    const cached = this.clients.get(roleId);
    const cardUrl = `${this.baseUrl}/delivery/agents/${encodeURIComponent(roleId)}/agent-card.json`;
    const clientPromise = cached || fetch(cardUrl, { headers: { Authorization: `Bearer ${this.authToken}` } }).then(async (response) => {
      if (!response.ok) throw error('delivery_role_card_fetch_failed', `Role card request returned ${response.status}`);
      return new ClientFactory().createFromAgentCard(await response.json());
    });
    if (!cached) this.clients.set(roleId, clientPromise);
    const requestOptions = (signal) => ({ serviceParameters: { Authorization: `Bearer ${this.authToken}` }, ...(signal ? { signal } : {}) });
    return {
      sendMessage: async (params, { signal } = {}) => (await clientPromise).sendMessage(params, requestOptions(signal)),
      getTask: async ({ id: taskId, contextId }) => (await clientPromise).getTask({ id: taskId, contextId }, requestOptions()),
      findByContext: async (contextId) => {
        const rows = this.db.prepare('SELECT record_json FROM delivery_role_executions WHERE provider_context_id=? ORDER BY created_at').all(contextId);
        const records = rows.map((row) => JSON.parse(row.record_json)).filter((row) => row.roleId === roleId);
        if (!records.length) return [];
        return Promise.all(records.map(async (record) => {
          try { return await (await clientPromise).getTask({ id: record.externalTaskId, contextId: record.contextId }, requestOptions()); }
          catch (_) { return { id: record.externalTaskId, contextId: record.contextId, status: { state: TaskState.TASK_STATE_UNSPECIFIED } }; }
        }));
      },
      cancel: async ({ taskId, contextId, signal }) => (await clientPromise).cancelTask({ id: taskId, contextId }, requestOptions(signal)),
      transportKey: String(transportKey || `delivery-role:${roleId}`), attemptId,
    };
  }

  async resultAdapter({ task, attempt, contract, objective, remote }) {
    const record = this.getExecution(attempt.attemptId);
    if (!record || record.externalTaskId !== remote.id || record.contextId !== remote.contextId
      || record.taskId !== task.taskId || record.projectId !== task.projectId || record.objectiveId !== task.objectiveId
      || record.fencingToken !== attempt.fencingToken || record.requestDigest !== record.requestDigestObserved
      || record.state !== 'terminal' || record.effectsSettled !== true) throw error('delivery_role_terminal_proof_missing');
    if (remote.status?.state !== record.externalState) throw error('delivery_role_remote_status_mismatch');
    const succeededRemotely = remote.status?.state === TaskState.TASK_STATE_COMPLETED;
    if ((record.providerInvocationStarted && (!record.execution
      || (record.execution.turnTerminal !== true && record.execution.turnStartRejected !== true)))
      || (!record.providerInvocationStarted && record.terminalStatus !== 'not_started')
      || (succeededRemotely && (!record.providerInvocationStarted || record.execution?.turnStartSent !== true
        || record.execution?.turnTerminal !== true || !record.providerThreadId || !record.providerTurnId))) {
      throw error('delivery_role_terminal_proof_missing');
    }
    const terminalIdentity = this.#assertTerminalIdentity(record, { task, attempt, remote });
    if (!succeededRemotely) {
      return this.#settleTerminalWithoutPublication(record, record.failureKind === 'usage_limit'
        ? 'usage_limit' : record.failureCode || 'role_report_or_turn_failed');
    }
    const remoteArtifact = (remote.artifacts || []).find((item) => item.metadata?.executionId === record.attemptId
      && item.metadata?.requestDigest === record.requestDigest);
    const remoteText = remoteArtifact?.parts?.map((part) => part?.content?.$case === 'text' ? part.content.value : part?.text)
      .filter((value) => typeof value === 'string').join('\n');
    if (!remoteArtifact || remoteText !== record.resultText) throw error('delivery_role_remote_result_mismatch');
    if (terminalIdentity.publicationAuthorizationChanged) {
      return this.#settleTerminalWithoutPublication(record, 'publication_authorization_changed');
    }
    let snapshot;
    try { snapshot = this.#assertCurrent(record, { requireMapped: true }); }
    catch (cause) { return this.#settleTerminalWithoutPublication(record, cause.code || 'publication_authorization_unavailable'); }
    const report = parseWorkerReport(record.resultText);
    if (!report.report || report.error || report.report.outcome !== 'completed') throw error('delivery_role_report_invalid');
    let reviewDecision = null;
    if (canonicalRoleId(task.role) === 'verifier') {
      const registeredTask = this.reviews.getReviewTask(task.taskId);
      if (!registeredTask || canonical(registeredTask) !== canonical({ ...task, state: registeredTask.state }) || registeredTask.readScope?.kind !== 'known'
        || !Array.isArray(registeredTask.readScope.paths) || registeredTask.readScope.paths.length === 0) {
        throw error('delivery_role_review_scope_unavailable');
      }
      reviewDecision = reviewResult({ status: 'TASK_STATE_COMPLETED', report: report.report, boundary: { results: [] }, sandbox: 'read-only' },
        'verifier', { paths: registeredTask.readScope.paths });
      if (reviewDecision.reason !== null && !['verifier_verdict_fail', 'verifier_verdict_inconclusive'].includes(reviewDecision.reason)) {
        throw error('delivery_role_review_report_invalid');
      }
    }
    let output = { state: 'unchanged', candidateId: record.baseCandidateId, artifactId: null, publication: null };
    if (record.laneId) {
      const artifact = this.artifacts.capture({ artifactId: record.artifactId, producerEvidence: { executionId: record.attemptId } });
      const outside = pathsOutsideAllowed(report.report.filesChanged, record.writePaths, this.workspace);
      if (outside.length || canonical([...report.report.filesChanged].sort()) !== canonical(artifact.deltaPaths)) throw error('delivery_role_report_scope_mismatch');
      if (artifact.state === 'captured') {
        const base = this.candidates.get(record.baseCandidateId);
        if (!base) throw error('delivery_role_base_candidate_unknown');
        const intentId = `publication-${record.attemptId}`;
        let publication;
        try {
          publication = await this.artifacts.publish({ artifactId: artifact.artifactId,
            candidateId: `candidate-${record.attemptId}`, intentId,
            integrationGeneration: base.integrationGeneration + 1 });
        } catch (cause) {
          const refusalProof = this.#knownPublicationRefusal(intentId, record, cause);
          if (!refusalProof) throw cause;
          const refusal = { state: 'refused', failureCode: refusalProof.intent?.result?.reason || refusalProof.reason || cause.code || 'candidate_publication_refused',
            ...(refusalProof.intent ? { candidateIntentId: refusalProof.intent.intentId } : {}),
            ...(refusalProof.admission ? { admissionExecutionId: refusalProof.admission.executionId } : {}),
            ...(refusalProof.candidate ? { currentCandidateId: refusalProof.candidate.candidateId } : {}) };
          if (this.lanes.complete) {
            const refusedLane = this.lanes.store.get(record.laneId);
            if (refusedLane && ['prepared', 'running'].includes(refusedLane.state)) await this.lanes.complete({ lane: laneHandle(refusedLane),
              integrate: false, reason: 'delivery_publication_refused', allowedFiles: record.writePaths,
              role: record.roleId, taskId: record.attemptId, contextId: record.contextId });
          }
          record.result = { output: { state: 'refused', candidateId: null, artifactId: artifact.artifactId, publication: refusal },
            failureCode: refusal.failureCode, terminalStatus: 'completed', reportDigest: `sha256:${hash(report.report)}` };
          record.state = 'settled'; this.#set(record);
          return { result: { state: 'failed', failureKind: 'candidate_publication_refused', publicationState: 'refused',
            artifactId: artifact.artifactId },
          evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: false,
            producerExecutionId: record.attemptId, providerContextId: record.providerContextId,
            providerThreadId: record.providerThreadId, providerTurnId: record.providerTurnId,
            selectedSettingsDigest: record.settingsDigest, requestDigest: record.requestDigest,
            artifactId: artifact.artifactId, publication: refusal, outputState: 'refused',
            evidenceRefs: [`delivery-role-execution:${record.attemptId}`, `delivery-output-artifact:${artifact.artifactId}`,
              `provider-thread:${record.providerThreadId}`, `provider-turn:${record.providerTurnId}`] } };
        }
        if (publication.state !== 'applied') throw error('delivery_role_publication_not_applied');
        output = { state: 'published', candidateId: publication.candidate?.candidateId || `candidate-${record.attemptId}`,
          artifactId: artifact.artifactId, publication };
      } else if (artifact.state === 'no_change') {
        if (report.report.filesChanged.length) throw error('delivery_role_report_scope_mismatch');
        output = { state: 'unchanged', candidateId: record.baseCandidateId, artifactId: artifact.artifactId, publication: null };
      } else throw error('delivery_role_artifact_state_invalid');
      if (this.lanes.complete) {
        const lane = this.lanes.store.get(record.laneId);
        if (lane && ['prepared', 'running'].includes(lane.state)) await this.lanes.complete({ lane: laneHandle(lane), integrate: false,
          reason: output.state === 'published' ? 'delivery_artifact_published' : 'delivery_artifact_no_change',
          allowedFiles: record.writePaths, role: record.roleId, taskId: record.attemptId, contextId: record.contextId });
      }
    } else {
      if (report.report.filesChanged.length || record.writePaths.length) throw error('delivery_role_readonly_report_writes');
      if (record.capabilityId) {
        const capability = this.#capabilityFor(record.attemptId);
        const details = scopedExecutionDetails(capability);
        details.assertCurrent();
        if (!details.verifyCandidate()) throw error('delivery_role_candidate_drift');
      }
    }
    let checkEvidence = null;
    if (canonicalRoleId(task.role) === 'verifier') {
      const requiredCheckPins = Array.isArray(contract.checks?.checkPins) ? contract.checks.checkPins : [];
      const capability = this.#capabilityFor(record.attemptId);
      const details = scopedExecutionDetails(capability);
      const base = this.candidates.get(record.baseCandidateId);
      if (!base || !details.verifyCandidate() || details.candidateId !== base.candidateId) throw error('delivery_role_verifier_candidate_unavailable');
      checkEvidence = await this.#checkEvidence({ task, attempt, record,
        candidate: { candidateId: base.candidateId, inputManifestDigest: details.inputManifestDigest }, requiredCheckPins });
    }
    record.result = { output, reportDigest: `sha256:${hash(report.report)}`, report, terminalStatus: 'completed',
      ...(reviewDecision ? { reviewDecision } : {}) };
    if (checkEvidence) { record.checkEvidence = checkEvidence; record.result.checksPassed = true; }
    record.state = 'settled'; this.#set(record);
    const evidenceRefs = [
      `delivery-role-execution:${record.attemptId}`,
      ...(output.artifactId ? [`delivery-output-artifact:${output.artifactId}`] : []),
      ...(output.candidateId ? [`candidate:${output.candidateId}`] : []),
      `provider-thread:${record.providerThreadId}`, `provider-turn:${record.providerTurnId}`,
    ];
    return {
      result: { state: 'succeeded', trusted: true, outputContract: 'delivery-role-output/v1',
        candidateId: output.candidateId, artifactId: output.artifactId, summary: report.report.summary,
        ...(checkEvidence ? { checksPassed: true } : {}) },
      evidence: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true, controllerValidated: true,
        producerExecutionId: record.attemptId, providerContextId: record.providerContextId,
        providerThreadId: record.providerThreadId, providerTurnId: record.providerTurnId,
        reportDigest: record.result.reportDigest, artifactId: output.artifactId, publication: output.publication,
        evidenceRefs, selectedSettingsDigest: record.settingsDigest, requestDigest: record.requestDigest,
        outputState: output.state, ...(checkEvidence ? { checksPassed: true, checkEvidenceDigest: checkEvidence.evidenceDigest,
          checkEvidenceRefs: checkEvidence.evidenceRefs } : {}) },
    };
  }

  #capabilityFor(attemptId) {
    const capability = this.capabilities?.get(attemptId);
    if (!capability) throw error('delivery_role_capability_unavailable');
    return capability;
  }

  async #checkEvidence({ task, attempt, record, candidate, requiredCheckPins }) {
    const input = { task: copy(task), attempt: copy(attempt), execution: copy(record), candidate: copy(candidate),
      requiredCheckPins: [...requiredCheckPins] };
    let proof;
    if (requiredCheckPins.length === 0) {
      proof = {
        projectId: task.projectId, objectiveId: task.objectiveId, taskId: task.taskId, attemptId: attempt.attemptId,
        fencingToken: attempt.fencingToken, providerContextId: record.providerContextId, providerThreadId: record.providerThreadId,
        candidateId: candidate.candidateId, inputManifestDigest: candidate.inputManifestDigest,
        selectedSettingsDigest: record.settingsDigest, requestDigest: record.requestDigest,
        checkPins: [], results: [], evidenceRefs: [`delivery-role-checks:none:${attempt.attemptId}`],
      };
      proof.evidenceDigest = `sha256:${hash(proof)}`;
    } else {
      proof = await this.checkEvidenceFor(input);
    }
    const fields = ['projectId', 'objectiveId', 'taskId', 'attemptId', 'fencingToken', 'providerContextId', 'providerThreadId',
      'candidateId', 'inputManifestDigest', 'selectedSettingsDigest', 'requestDigest', 'checkPins', 'results', 'evidenceRefs', 'evidenceDigest'];
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).sort().join('|') !== [...fields].sort().join('|')) {
      throw error('delivery_role_check_evidence_invalid');
    }
    const { evidenceDigest, ...body } = proof;
    const validRefs = Array.isArray(proof.evidenceRefs) && proof.evidenceRefs.length > 0 && proof.evidenceRefs.length <= 64
      && proof.evidenceRefs.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 1000);
    const expectedDigest = `sha256:${hash(body)}`;
    if (proof.projectId !== task.projectId || proof.objectiveId !== task.objectiveId || proof.taskId !== task.taskId
      || proof.attemptId !== attempt.attemptId || proof.fencingToken !== attempt.fencingToken
      || proof.providerContextId !== record.providerContextId || proof.providerThreadId !== record.providerThreadId
      || proof.candidateId !== candidate.candidateId || proof.inputManifestDigest !== candidate.inputManifestDigest
      || proof.selectedSettingsDigest !== record.settingsDigest || proof.requestDigest !== record.requestDigest
      || canonical(proof.checkPins) !== canonical(requiredCheckPins) || !Array.isArray(proof.results)
      || proof.results.length !== requiredCheckPins.length || proof.results.some((item, index) => !item || typeof item !== 'object'
        || Object.keys(item).sort().join('|') !== ['checkId', 'evidenceRef', 'state'].sort().join('|')
        || item.checkId !== requiredCheckPins[index] || item.state !== 'passed'
        || typeof item.evidenceRef !== 'string' || !item.evidenceRef || item.evidenceRef.length > 1000)
      || !validRefs || proof.evidenceDigest !== expectedDigest) throw error('delivery_role_check_evidence_invalid');
    return { ...copy(proof), passed: true };
  }

  async receiptAdapter({ task, attempt, outcome, evidence, remote, duplicate, deliveryCapability }) {
    if (canonicalRoleId(task.role) !== 'verifier') return { state: 'not_required' };
    if (!deliveryCapability) throw error('delivery_role_verifier_receipt_capability_missing');
    const details = scopedExecutionDetails(deliveryCapability);
    if (details.taskId !== task.taskId || details.attemptId !== attempt.attemptId || !details.verifyCandidate()) throw error('delivery_role_verifier_receipt_stale');
    const record = this.getExecution(attempt.attemptId);
    if (!record || record.externalTaskId !== remote.id || record.state !== 'settled'
      || !record.providerThreadId || !record.providerTurnId || record.effectsSettled !== true) throw error('delivery_role_verifier_execution_mismatch');
    if (!record.result?.checksPassed || record.checkEvidence?.passed !== true) throw error('delivery_role_check_evidence_missing');
    const refs = [...(evidence.evidenceRefs || []), `delivery-role-execution:${attempt.attemptId}`];
    const receiptOutcome = record.result.reviewDecision?.reason === 'verifier_verdict_fail' ? 'failed'
      : record.result.reviewDecision?.reason === 'verifier_verdict_inconclusive' ? 'inconclusive' : 'passed';
    const receipt = details.settleReviewReceipt(receiptOutcome, refs);
    return { state: 'settled', receipt, duplicate: duplicate === true };
  }
}

module.exports = { DeliveryRoleService };
