'use strict';

const { createHash } = require('node:crypto');
const { checkSpecialistRequest, normalizeSpecialistRequest } = require('./contracts');
const { stableDigest } = require('./backlog-store');
const { deliveryRequestDigest, scopedExecutionDetails } = require('./delivery-role-capabilities');
const { canonicalRoleId } = require('./role-names');
const { DispatchJournal } = require('./durable-store');
const { Role, TaskState } = require('@a2a-js/sdk');

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const REMOTE_TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED,
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_CANCELLED', 'TASK_STATE_REJECTED',
  'COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED', 'REJECTED',
]);
const LIVE = ['intent', 'submitted', 'uncertain'];
const json = (value) => JSON.stringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const errorCode = (code) => Object.assign(new Error(code), { code });
const tupleId = (...parts) => createHash('sha256').update(json(parts)).digest('hex');
function exactObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) return null;
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    result[field] = descriptor.value;
  }
  return result;
}
function observedThreadId(remote) {
  if (typeof remote?.threadId === 'string') return remote.threadId;
  if (typeof remote?.metadata?.threadId === 'string') return remote.metadata.threadId;
  const artifacts = Array.isArray(remote?.artifacts) ? remote.artifacts : [];
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const threadId = artifacts[index]?.metadata?.threadId;
    if (typeof threadId === 'string' && threadId) return threadId;
  }
  const history = Array.isArray(remote?.history) ? remote.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const threadId = history[index]?.metadata?.threadId;
    if (typeof threadId === 'string' && threadId) return threadId;
  }
  return null;
}
const RECOVERY_PROOF_FIELDS = Object.freeze([
  'projectId', 'objectiveId', 'taskId', 'attemptId', 'fencingToken', 'claimOwnerGeneration',
  'recoveryGeneration', 'providerContextId', 'intentState', 'noEffect', 'remoteQuiescent',
  'processQuiescent', 'effectsSettled', 'evidenceRefs',
]);

class TaskExecutor {
  constructor({ backlogStore, db, transportFor, settingsFor, roleFor, requestAdapter, resultAdapter, receiptAdapter, recoveryProofAdapter, dispatchJournal, resolveVerifierCapability, now = () => Date.now(), maxEvidence = 64, maxRecoveryRetries = 2 }) {
    if (!backlogStore || !db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('BacklogStore and a better-sqlite3 database are required');
    if (backlogStore.db !== db) throw new TypeError('BacklogStore and executor must share one database');
    for (const [name, value] of Object.entries({ transportFor, settingsFor, roleFor, requestAdapter, resultAdapter })) if (typeof value !== 'function') throw new TypeError(`${name} is required`);
    if (!Number.isSafeInteger(maxEvidence) || maxEvidence < 1) throw new TypeError('maxEvidence must be positive');
    if (recoveryProofAdapter !== undefined && typeof recoveryProofAdapter !== 'function') throw new TypeError('recoveryProofAdapter must be a function');
    if (receiptAdapter !== undefined && typeof receiptAdapter !== 'function') throw new TypeError('receiptAdapter must be a function');
    if (resolveVerifierCapability !== undefined && typeof resolveVerifierCapability !== 'function') throw new TypeError('resolveVerifierCapability must be a function');
    if (!Number.isSafeInteger(maxRecoveryRetries) || maxRecoveryRetries < 1 || maxRecoveryRetries > 5) throw new TypeError('maxRecoveryRetries must be between one and five');
    this.store = backlogStore;
    this.db = db;
    this.transportFor = transportFor;
    this.settingsFor = settingsFor;
    this.roleFor = roleFor;
    this.requestAdapter = requestAdapter;
    this.resultAdapter = resultAdapter;
    this.receiptAdapter = receiptAdapter || null;
    this.recoveryProofAdapter = recoveryProofAdapter || null;
    this.resolveVerifierCapability = resolveVerifierCapability || null;
    this.verifierCapabilities = new Map();
    this.maxRecoveryRetries = maxRecoveryRetries;
    this.dispatchJournal = dispatchJournal || new DispatchJournal(db);
    if (this.dispatchJournal.db !== db) throw new TypeError('DispatchJournal and executor must share one database');
    this.now = now;
    this.maxEvidence = maxEvidence;
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_executor_attempts (
        attempt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        task_id TEXT NOT NULL, fencing_token INTEGER NOT NULL, context_id TEXT NOT NULL,
        request_digest TEXT NOT NULL, journal_id TEXT NOT NULL, transport_key TEXT NOT NULL,
        state TEXT NOT NULL, external_task_id TEXT, record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_executor_transport_idx ON task_executor_attempts(transport_key, state);
      CREATE TABLE IF NOT EXISTS task_executor_thread_reservations (
        transport_key TEXT NOT NULL, thread_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(transport_key, thread_id)
      );
      CREATE TABLE IF NOT EXISTS task_executor_evidence (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_executor_transport_failures (
        transport_key TEXT PRIMARY KEY, detail_json TEXT NOT NULL, failed_at INTEGER NOT NULL
      );
    `);
  }

  async execute(identity, { signal } = {}) {
    this.#requireTaskId(identity);
    const prior = this.#intent(identity.attemptId);
    if (prior) {
      this.#validateIntent(identity, prior);
      if (prior.state === 'settled') return { state: 'settled', externalTaskId: prior.external_task_id };
      if (prior.state === 'submitted') return { state: 'submitted', externalTaskId: prior.external_task_id, contextId: prior.context_id, replay: true };
      return prior.external_task_id ? this.poll(identity) : this.reconcile(identity);
    }
    const snapshot = this.#loadClaim(identity);
    if (signal?.aborted) return { state: 'unknown', reason: 'aborted_before_send' };
    const settings = await this.settingsFor({ task: clone(snapshot.task), attempt: clone(snapshot.attempt), objective: clone(snapshot.objective) });
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw errorCode('selected_settings_unknown');
    this.store.pinSelectedSettings(identity.projectId, identity.objectiveId, identity.attemptId, identity.fencingToken, settings);
    const pinned = this.#loadClaim(identity);
    if (pinned.attempt.capturedControls.selectedSettingsKnown !== true || pinned.attempt.selectedSettingsDigest !== stableDigest(settings)) throw errorCode('selected_settings_drift');
    const role = this.roleFor(pinned.task.role, settings);
    if (!role || canonicalRoleId(role.id || role.name) !== canonicalRoleId(pinned.task.role)) throw errorCode('role_mismatch');
    const adapted = await this.requestAdapter({ task: clone(pinned.contract), attempt: clone(pinned.attempt), settings: clone(settings), role: clone(role) });
    const request = adapted?.request || adapted;
    const normalized = normalizeSpecialistRequest(request, role);
    const requestDigest = deliveryRequestDigest({ request: normalized, settingsDigest: pinned.attempt.selectedSettingsDigest,
      taskDigest: pinned.attempt.contractDigest });
    let deliveryCapability = null;
    if (pinned.contract.kind === 'review' && pinned.contract.role === 'verifier' && pinned.contract.productWritePaths?.length === 0
      && normalized.allowedFiles.length === 0 && this.resolveVerifierCapability) {
      deliveryCapability = await this.resolveVerifierCapability({
        projectId: identity.projectId, objectiveId: identity.objectiveId, taskId: identity.taskId,
        attemptId: identity.attemptId, fencingToken: identity.fencingToken,
        providerContextId: pinned.attempt.providerContextId, requestDigest,
        request: normalized, role: 'verifier',
      }, normalized);
      if (deliveryCapability) this.verifierCapabilities.set(identity.attemptId, deliveryCapability);
    }
    const checked = checkSpecialistRequest(request, role, { capability: deliveryCapability, requestDigest });
    if (checked.objective !== pinned.contract.objective) throw errorCode('task_objective_mismatch');
    const declaredWrites = pinned.contract.productWritePaths;
    if (checked.allowedFiles.length !== declaredWrites.length
      || new Set(checked.allowedFiles).size !== checked.allowedFiles.length
      || declaredWrites.some((file) => !checked.allowedFiles.includes(file))) throw errorCode('product_write_scope_mismatch');
    const finalRequestDigest = deliveryRequestDigest({ request: checked, settingsDigest: pinned.attempt.selectedSettingsDigest,
      taskDigest: pinned.attempt.contractDigest });
    if (finalRequestDigest !== requestDigest) throw errorCode('request_normalization_digest_mismatch');
    const contextId = pinned.attempt.providerContextId;
    if (typeof contextId !== 'string' || !contextId) throw errorCode('provider_context_missing');
    const transportKey = String(adapted?.transportKey || `project:${identity.projectId}`);
    const requestedThreadId = adapted?.threadId || request?.threadId || request?.metadata?.threadId || pinned.attempt.threadId || null;
    if (requestedThreadId !== null && (typeof requestedThreadId !== 'string' || !requestedThreadId.trim())) throw errorCode('thread_identity_invalid');
    if (pinned.attempt.threadId && requestedThreadId !== pinned.attempt.threadId) throw errorCode('thread_identity_mismatch');
    const message = {
      messageId: tupleId(identity.projectId, identity.objectiveId, identity.attemptId, 'message'),
      contextId,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: JSON.stringify(checked) }, mediaType: 'text/plain' }],
      metadata: {
        projectId: identity.projectId,
        objectiveId: identity.objectiveId,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        fencingToken: identity.fencingToken,
        requestDigest,
        providerContextId: pinned.attempt.providerContextId,
        ...(deliveryCapability ? { capabilityId: deliveryCapability.capabilityId } : {}),
        ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
        productWritePaths: pinned.contract.productWritePaths,
        scratchWriteRoots: pinned.contract.scratchWriteRoots,
      },
      extensions: [],
      referenceTaskIds: [],
    };
    const intent = this.#commitIntent(identity, pinned, requestDigest, transportKey, requestedThreadId);
    if (!intent.owner) return this.reconcile(identity);
    const journal = this.dispatchJournal.recordSubmitting({
      attemptId: identity.attemptId,
      runId: identity.objectiveId,
      assignmentId: pinned.task.taskId,
      role: pinned.task.role,
      sandbox: role.sandbox,
      contextId,
      objectiveSha256: stableDigest(pinned.contract.objective),
    });
    if (!journal || journal.contextId !== contextId || journal.attemptId !== intent.record.journalId
      || journal.runId !== identity.objectiveId || journal.assignmentId !== pinned.task.taskId
      || journal.role !== pinned.task.role || journal.sandbox !== role.sandbox || journal.state !== 'submitting') throw errorCode('dispatch_journal_identity_conflict');
    if (signal?.aborted) {
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'aborted_before_transport' };
    }
    const transport = await this.#resolveTransport({ role: clone(role), settings: clone(settings), transportKey }, identity.attemptId);
    if (!transport) return { state: 'unknown', reason: 'transport_unavailable' };
    if (signal?.aborted) {
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'aborted_before_transport' };
    }
    const beforeSend = this.#loadClaim(identity);
    if (beforeSend.attempt.selectedSettingsDigest !== pinned.attempt.selectedSettingsDigest
      || beforeSend.attempt.contractDigest !== pinned.attempt.contractDigest) throw errorCode('pre_send_pin_drift');
    if (deliveryCapability) scopedExecutionDetails(deliveryCapability).assertCurrent();
    if (this.#transportUnavailable(transportKey)) {
      const failure = this.db.prepare('SELECT detail_json FROM task_executor_transport_failures WHERE transport_key=?').get(transportKey);
      this.#evidence(identity.attemptId, 'shared_transport_failed', failure ? JSON.parse(failure.detail_json) : { transportKey });
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'shared_transport_failed' };
    }
    try {
      const response = await transport.sendMessage({ message, configuration: { returnImmediately: true, acceptedOutputModes: ['text/plain', 'application/json'] }, metadata: message.metadata }, { signal });
      const remote = response?.task || response?.result?.task || response;
      if (!remote || typeof remote.id !== 'string') {
        this.#evidence(identity.attemptId, 'response_identity_invalid', { reason: 'task_id_missing', response: this.#remoteSummary(response) });
        this.#setState(identity.attemptId, 'uncertain', null);
        return { state: 'unknown', reason: 'task_id_missing' };
      }
      this.#validateRemote(remote, pinned.attempt, intent.record);
      this.#pinObservedThread(identity.attemptId, intent.record, remote);
      this.store.recordSubmitted(identity.projectId, identity.objectiveId, identity.attemptId, identity.fencingToken, remote.id);
      this.#setState(identity.attemptId, 'submitted', remote.id);
      this.dispatchJournal.recordSubmitted(identity.attemptId, remote.id);
      return { state: 'submitted', externalTaskId: remote.id, contextId };
    } catch (error) {
      this.#evidence(identity.attemptId, 'send_uncertain', { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 500) });
      if (error?.sharedTransportFailure === true) this.transportFailed(transportKey, error);
      else this.#setState(identity.attemptId, 'uncertain', null);
      if (signal?.aborted || error?.name === 'AbortError') return { state: 'unknown', reason: 'abort_pending_reconciliation' };
      return this.reconcile(identity);
    }
  }

  async reconcile(identity) {
    const row = this.#intent(identity.attemptId);
    if (!row) throw errorCode('send_intent_missing');
    this.#validateIntent(identity, row);
    if (row.state === 'submitted') return { state: 'submitted', externalTaskId: row.external_task_id, contextId: row.context_id };
    if (row.state === 'settled') return { state: 'settled', externalTaskId: row.external_task_id };
    const snapshot = this.#loadClaim(identity, { allowUnknown: true, allowControlDrift: true });
    const transport = await this.#resolveTransport({ role: this.roleFor(snapshot.task.role), transportKey: row.transport_key }, identity.attemptId);
    if (!transport) return { state: 'unknown', reason: 'transport_unavailable' };
    let found;
    try {
      if (typeof transport.findByContext !== 'function') throw errorCode('lookup_unavailable');
      found = await transport.findByContext(row.context_id);
    } catch (error) {
      this.#evidence(identity.attemptId, 'lookup_failed', { message: String(error?.message || error).slice(0, 500) });
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'lookup_failed' };
    }
    const tasks = Array.isArray(found) ? found : found ? [found] : [];
    if (!tasks.length) {
      this.#evidence(identity.attemptId, 'lookup_absent', { contextId: row.context_id });
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'lookup_absent_no_resend' };
    }
    if (tasks.length !== 1) {
      this.#evidence(identity.attemptId, 'lookup_ambiguous', { count: tasks.length });
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'lookup_ambiguous' };
    }
    try { this.#validateRemote(tasks[0], snapshot.attempt, row); } catch (error) {
      this.#evidence(identity.attemptId, 'lookup_identity_rejected', { code: error.code || 'identity_invalid', task: this.#remoteSummary(tasks[0]) });
      this.#setState(identity.attemptId, 'uncertain', null);
      return { state: 'unknown', reason: 'lookup_identity_rejected' };
    }
    this.#pinObservedThread(identity.attemptId, row, tasks[0]);
    this.#linkKnownTask(identity, snapshot, tasks[0]);
    if (snapshot.attempt.state !== 'unknown') return { state: 'submitted', externalTaskId: tasks[0].id, contextId: row.context_id, recovered: true };
    return { state: 'unknown', reason: 'known_remote_attempt_requires_trusted_reconciliation', externalTaskId: tasks[0].id, contextId: row.context_id };
  }

  async acceptTerminal(identity, remote) {
    const row = this.#intent(identity.attemptId);
    if (!row) throw errorCode('send_intent_missing');
    this.#validateIntent(identity, row);
    const snapshot = this.#loadClaim(identity, { allowUnknown: true, allowSettled: true, allowControlDrift: true });
    try { this.#validateRemote(remote, snapshot.attempt, row); } catch (error) {
      this.#evidence(identity.attemptId, 'terminal_identity_rejected', { code: error.code || 'identity_invalid', task: this.#remoteSummary(remote) });
      throw error;
    }
    this.#pinObservedThread(identity.attemptId, row, remote);
    if (row.external_task_id && remote.id !== row.external_task_id) {
      this.#evidence(identity.attemptId, 'terminal_task_conflict', { expected: row.external_task_id, received: remote.id });
      throw errorCode('external_task_conflict');
    }
    if (!REMOTE_TERMINAL.has(remote.status?.state)) {
      this.#evidence(identity.attemptId, 'terminal_status_rejected', { status: remote.status?.state ?? null, task: this.#remoteSummary(remote) });
      throw errorCode('remote_task_not_terminal');
    }
    let outcome;
    try {
      outcome = await this.resultAdapter({
        task: clone(snapshot.task), attempt: clone(snapshot.attempt), contract: clone(snapshot.contract),
        objective: clone(snapshot.objective),
        currentControl: {
          controlRevision: snapshot.objective.controlRevision,
          authorityRevision: snapshot.objective.authorityRevision,
          disposition: snapshot.objective.disposition,
          ownerGeneration: snapshot.objective.ownerGeneration,
        },
        remote: clone(remote),
      });
    } catch (error) {
      this.#evidence(identity.attemptId, 'result_adapter_failed', { message: String(error?.message || error).slice(0, 500), task: this.#remoteSummary(remote) });
      throw error;
    }
    if (!outcome || !outcome.result || !TERMINAL.has(outcome.result.state) || !outcome.evidence) {
      this.#evidence(identity.attemptId, 'result_adapter_rejected', { task: this.#remoteSummary(remote) });
      throw errorCode('trusted_result_required');
    }
    const evidence = outcome.evidence;
    if (evidence.remoteQuiescent !== true || evidence.processQuiescent !== true || evidence.effectsSettled !== true) {
      this.#evidence(identity.attemptId, 'quiescence_rejected', { task: this.#remoteSummary(remote) });
      throw errorCode('quiescence_evidence_required');
    }
    if (outcome.result.state === 'succeeded' && (evidence.controllerValidated !== true || outcome.result.trusted !== true)) {
      this.#evidence(identity.attemptId, 'output_trust_rejected', { task: this.#remoteSummary(remote) });
      throw errorCode('trusted_output_required');
    }
    try {
      const facts = identity.recoveryGeneration === undefined ? evidence : { ...evidence, recoveryGeneration: identity.recoveryGeneration };
      const settled = snapshot.attempt.state === 'unknown'
        ? this.store.reconcileAttempt(identity.projectId, identity.objectiveId, identity.attemptId, identity.fencingToken, { ...facts, result: outcome.result })
        : this.store.settleAttempt(identity.projectId, identity.objectiveId, identity.attemptId, identity.fencingToken, outcome.result, facts);
      const settledResult = settled.attempt.outcome || outcome.result;
      let receipt = null;
      if (this.receiptAdapter) {
        try {
          receipt = await this.receiptAdapter({
            task: clone(snapshot.task), attempt: clone(settled.attempt), contract: clone(snapshot.contract),
            outcome: clone(settledResult), evidence: clone(evidence), remote: clone(remote), duplicate: settled.duplicate === true,
            deliveryCapability: this.verifierCapabilities.get(identity.attemptId) || null,
          });
        } catch (error) {
          this.#evidence(identity.attemptId, 'receipt_adapter_pending', { code: error.code || 'receipt_unavailable' });
          receipt = { state: 'unknown', reason: error.code || 'receipt_unavailable' };
        }
      }
      this.#setState(identity.attemptId, 'settled', remote.id);
      this.dispatchJournal.recordFinished(identity.attemptId, { ...settledResult, taskId: remote.id, contextId: remote.contextId });
      return { state: settledResult.state, duplicate: settled.duplicate === true, result: settledResult, ...(receipt ? { receipt } : {}) };
    } catch (error) {
      this.#evidence(identity.attemptId, 'settlement_refused', { code: error.code || 'settlement_error' });
      throw error;
    }
  }

  async poll(identity) {
    const row = this.#intent(identity.attemptId);
    if (!row || !row.external_task_id) return this.reconcile(identity);
    this.#validateIntent(identity, row);
    if (row.state === 'settled') return { state: 'settled', externalTaskId: row.external_task_id };
    const snapshot = this.#loadClaim(identity, { allowUnknown: true, allowSettled: true, allowControlDrift: true });
    const transport = await this.#resolveTransport({ role: this.roleFor(snapshot.task.role), transportKey: row.transport_key }, identity.attemptId);
    if (!transport) return { state: 'unknown', reason: 'transport_unavailable' };
    if (typeof transport.getTask !== 'function') throw errorCode('task_poll_unavailable');
    let remote;
    try { remote = await transport.getTask({ id: row.external_task_id, contextId: row.context_id }); } catch (error) {
      this.#evidence(identity.attemptId, 'poll_failed', { message: String(error?.message || error).slice(0, 500) });
      this.#setState(identity.attemptId, 'uncertain', row.external_task_id);
      return { state: 'unknown', reason: 'poll_failed' };
    }
    try { this.#validateRemote(remote, snapshot.attempt, row); } catch (error) {
      this.#evidence(identity.attemptId, 'poll_identity_rejected', { code: error.code || 'identity_invalid', task: this.#remoteSummary(remote) });
      this.#setState(identity.attemptId, 'uncertain', row.external_task_id);
      return { state: 'unknown', reason: 'poll_identity_rejected' };
    }
    this.#pinObservedThread(identity.attemptId, row, remote);
    if (!REMOTE_TERMINAL.has(remote.status?.state)) return { state: 'submitted', externalTaskId: row.external_task_id, contextId: row.context_id };
    return this.acceptTerminal(identity, remote);
  }

  async abort(identity, { signal } = {}) {
    const row = this.#intent(identity.attemptId);
    if (!row) throw errorCode('send_intent_missing');
    this.#validateIntent(identity, row);
    const snapshot = this.#loadClaim(identity, { allowUnknown: true, allowControlDrift: true });
    const transport = await this.#resolveTransport({ role: this.roleFor(snapshot.task.role), transportKey: row.transport_key }, identity.attemptId);
    if (!transport) return { state: 'unknown', reason: 'transport_unavailable' };
    this.#setState(identity.attemptId, 'uncertain', row.external_task_id);
    if (typeof transport.cancel !== 'function') return { state: 'unknown', reason: 'cancel_unavailable' };
    try {
      await transport.cancel({ contextId: row.context_id, taskId: row.external_task_id, signal });
      this.#evidence(identity.attemptId, 'cancel_requested', { taskId: row.external_task_id });
    } catch (error) {
      this.#evidence(identity.attemptId, 'cancel_uncertain', { message: String(error?.message || error).slice(0, 500) });
    }
    return { state: 'unknown', reason: 'remote_and_process_quiescence_unconfirmed' };
  }

  recover(identity) {
    this.#requireTaskId(identity);
    const snapshot = this.#loadClaim(identity, { allowUnknown: true, allowControlDrift: true });
    if (snapshot.attempt.state !== 'unknown' || !['expired', 'fenced'].includes(snapshot.claim.state)) throw errorCode('recovery_not_pending');
    if (!Number.isSafeInteger(identity.recoveryGeneration) || identity.recoveryGeneration !== snapshot.objective.ownerGeneration) throw errorCode('recovery_generation_required');
    if (!this.recoveryProofAdapter) return { state: 'unknown', reason: 'trusted_recovery_adapter_unavailable' };
    const intent = this.#intent(identity.attemptId);
    if (intent) this.#validateIntent(identity, intent);
    let proof;
    try {
      proof = this.recoveryProofAdapter(Object.freeze({
        identity: Object.freeze({ ...identity }),
        attempt: clone(snapshot.attempt), claim: clone(snapshot.claim), task: clone(snapshot.task),
        objective: clone(snapshot.objective), intent: intent ? { ...JSON.parse(intent.record_json), state: intent.state,
          externalTaskId: intent.external_task_id, contextId: intent.context_id } : null,
      }));
    } catch (cause) {
      this.#evidence(identity.attemptId, 'recovery_proof_failed', { code: cause?.code || 'recovery_adapter_error' });
      return { state: 'unknown', reason: cause?.code || 'recovery_adapter_error' };
    }
    if (proof && typeof proof.then === 'function') {
      proof.catch?.(() => {});
      this.#evidence(identity.attemptId, 'recovery_proof_rejected', { reason: 'recovery_proof_must_be_synchronous' });
      return { state: 'unknown', reason: 'recovery_proof_must_be_synchronous' };
    }
    const normalized = exactObject(proof, RECOVERY_PROOF_FIELDS);
    const actualIntentState = intent?.state || null;
    if (!normalized || normalized.projectId !== identity.projectId || normalized.objectiveId !== identity.objectiveId
      || normalized.taskId !== identity.taskId || normalized.attemptId !== identity.attemptId
      || normalized.fencingToken !== identity.fencingToken || normalized.claimOwnerGeneration !== snapshot.claim.ownerGeneration
      || normalized.recoveryGeneration !== snapshot.objective.ownerGeneration || normalized.providerContextId !== snapshot.attempt.providerContextId
      || normalized.intentState !== actualIntentState || normalized.noEffect !== true
      || normalized.remoteQuiescent !== true || normalized.processQuiescent !== true || normalized.effectsSettled !== true
      || !Array.isArray(normalized.evidenceRefs) || normalized.evidenceRefs.length > 64
      || normalized.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref || ref.length > 1000)) {
      this.#evidence(identity.attemptId, 'recovery_proof_rejected', { reason: 'identity_or_quiescence_mismatch' });
      return { state: 'unknown', reason: 'recovery_proof_rejected' };
    }
    try {
      const settled = this.store.settleRecoveredNoEffect(identity.projectId, identity.objectiveId, identity.attemptId,
        identity.fencingToken, normalized, this.maxRecoveryRetries);
      if (intent) {
        this.#setState(identity.attemptId, 'settled', intent.external_task_id);
        this.dispatchJournal.recordFinished(identity.attemptId, { state: 'canceled', failureKind: 'reconciled_no_effect', contextId: intent.context_id });
      }
      this.#evidence(identity.attemptId, 'recovery_no_effect', { evidenceRefs: normalized.evidenceRefs, attemptNo: snapshot.attempt.attemptNo,
        retryLimit: this.maxRecoveryRetries, result: settled.state });
      return { state: settled.state, duplicate: settled.duplicate === true, taskId: identity.taskId, attemptId: identity.attemptId };
    } catch (cause) {
      this.#evidence(identity.attemptId, 'recovery_settlement_refused', { code: cause?.code || 'recovery_settlement_error' });
      return { state: 'unknown', reason: cause?.code || 'recovery_settlement_error' };
    }
  }

  transportFailed(transportKey, error) {
    const detail = { transportKey: String(transportKey), message: String(error?.message || error || 'transport_failed').slice(0, 500) };
    let rows = [];
    const tx = this.db.transaction(() => {
      rows = this.db.prepare(`SELECT attempt_id FROM task_executor_attempts WHERE transport_key=? AND state IN (${LIVE.map(() => '?').join(',')})`).all(String(transportKey), ...LIVE);
      this.db.prepare(`INSERT INTO task_executor_transport_failures(transport_key,detail_json,failed_at) VALUES(?,?,?)
        ON CONFLICT(transport_key) DO UPDATE SET detail_json=excluded.detail_json,failed_at=excluded.failed_at`).run(String(transportKey), json(detail), this.now());
      for (const row of rows) {
        this.db.prepare("UPDATE task_executor_attempts SET state='uncertain', updated_at=? WHERE attempt_id=? AND state IN ('intent','submitted','uncertain')").run(this.now(), row.attempt_id);
        this.#evidence(row.attempt_id, 'shared_transport_failed', detail);
      }
    });
    tx.immediate();
    return rows.map((row) => row.attempt_id);
  }

  getAttempt(attemptId) {
    const row = this.#intent(attemptId);
    return row ? { ...JSON.parse(row.record_json), state: row.state, externalTaskId: row.external_task_id } : null;
  }

  listEvidence(attemptId) {
    return this.db.prepare('SELECT kind,detail_json,created_at FROM task_executor_evidence WHERE attempt_id=? ORDER BY sequence').all(attemptId).map((row) => ({ kind: row.kind, detail: JSON.parse(row.detail_json), createdAt: row.created_at }));
  }

  #loadClaim(identity, { allowUnknown = false, allowSettled = false, allowControlDrift = false } = {}) {
    this.#requireTaskId(identity);
    const objective = this.store.getObjective(identity.projectId, identity.objectiveId);
    if (!objective) throw errorCode('objective_missing');
    const attempt = this.store.listAttempts(identity.projectId, identity.objectiveId).find((row) => row.attemptId === identity.attemptId);
    const claim = this.store.listClaims(identity.projectId, identity.objectiveId).find((row) => row.attemptId === identity.attemptId);
    const task = objective.tasks.find((row) => row.taskId === attempt?.taskId);
    if (!attempt || !claim || !task) throw errorCode('attempt_missing');
    if (identity.taskId !== attempt.taskId || identity.taskId !== claim.taskId || identity.taskId !== task.taskId) throw errorCode('task_identity_mismatch');
    if (attempt.fencingToken !== identity.fencingToken || claim.fencingToken !== identity.fencingToken) throw errorCode('fence_stale');
    const settledReplay = allowSettled && claim.state === 'released' && TERMINAL.has(attempt.state);
    if (!['active', 'expired', 'fenced'].includes(claim.state) && !settledReplay) throw errorCode('claim_inactive');
    if (!allowUnknown && !settledReplay && claim.state !== 'active') throw errorCode('claim_inactive');
    if (!allowUnknown && claim.leaseUntil <= this.now()) throw errorCode('claim_expired');
    const recovery = allowUnknown && attempt.state === 'unknown' && Number.isSafeInteger(identity.recoveryGeneration)
      && identity.recoveryGeneration === objective.ownerGeneration;
    if ((objective.ownerGeneration !== claim.ownerGeneration || attempt.executionGeneration !== claim.ownerGeneration) && !recovery) throw errorCode('owner_generation_stale');
    if (attempt.capturedControls.authorityRevision !== objective.authorityRevision
      || (!allowControlDrift && attempt.capturedControls.controlRevision !== objective.controlRevision)) throw errorCode('control_revision_stale');
    const contract = attempt.contractSnapshot;
    if (!contract || contract.revision !== task.revision || attempt.taskRevision !== task.revision || stableDigest(contract) !== attempt.contractDigest) throw errorCode('task_revision_or_digest_stale');
    if (task.state !== 'claimed' && task.state !== 'running' && !(allowUnknown && task.state === 'settling') && !(settledReplay && task.state === attempt.state)) throw errorCode('task_state_invalid');
    const currentAsClaimed = { ...task, state: contract.state };
    if (stableDigest(currentAsClaimed) !== attempt.contractDigest) throw errorCode('task_contract_drift');
    if (canonicalRoleId(task.role) !== canonicalRoleId(claim.role)) throw errorCode('role_mismatch');
    if (!allowUnknown && attempt.state !== 'claimed') throw errorCode('attempt_state_invalid');
    return { objective, attempt, claim, task, contract };
  }

  #commitIntent(identity, snapshot, requestDigest, transportKey, requestedThreadId) {
    const record = {
      projectId: identity.projectId, objectiveId: identity.objectiveId, taskId: snapshot.task.taskId,
      attemptId: identity.attemptId, fencingToken: identity.fencingToken, contextId: snapshot.attempt.providerContextId,
      requestDigest, journalId: identity.attemptId, transportKey,
      reservedThreadId: requestedThreadId || null, observedThreadId: snapshot.attempt.threadId || null,
      productWritePaths: clone(snapshot.contract.productWritePaths),
      scratchWriteRoots: clone(snapshot.contract.scratchWriteRoots),
    };
    const tx = this.db.transaction(() => {
      const current = this.#loadClaim(identity);
      if (current.attempt.contractDigest !== snapshot.attempt.contractDigest
        || current.attempt.selectedSettingsDigest !== snapshot.attempt.selectedSettingsDigest) throw errorCode('pre_intent_pin_drift');
      if (requestedThreadId) {
        const reservation = this.db.prepare(`INSERT OR IGNORE INTO task_executor_thread_reservations(transport_key,thread_id,attempt_id) VALUES(?,?,?)`)
          .run(transportKey, requestedThreadId, identity.attemptId);
        const held = this.db.prepare('SELECT attempt_id FROM task_executor_thread_reservations WHERE transport_key=? AND thread_id=?').get(transportKey, requestedThreadId);
        if (held?.attempt_id !== identity.attemptId) throw errorCode('provider_thread_busy');
      }
      const result = this.db.prepare(`INSERT OR IGNORE INTO task_executor_attempts
        (attempt_id,project_id,objective_id,task_id,fencing_token,context_id,request_digest,journal_id,transport_key,state,external_task_id,record_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'intent',NULL,?,?,?)`).run(
        identity.attemptId, identity.projectId, identity.objectiveId, record.taskId, identity.fencingToken,
        record.contextId, requestDigest, identity.attemptId, transportKey, json(record), this.now(), this.now(),
      );
      const row = this.#intent(identity.attemptId);
      const saved = JSON.parse(row.record_json);
      if (row.project_id !== identity.projectId || row.objective_id !== identity.objectiveId
        || row.fencing_token !== identity.fencingToken || row.context_id !== record.contextId
        || row.request_digest !== requestDigest || row.transport_key !== transportKey
        || saved.reservedThreadId !== record.reservedThreadId) throw errorCode('send_intent_conflict');
      return { owner: result.changes === 1, record: JSON.parse(row.record_json) };
    });
    return tx.immediate();
  }

  #validateRemote(remote, attempt, intent = null) {
    if (!remote || typeof remote.id !== 'string' || !remote.id.trim()) throw errorCode('external_task_id_missing');
    if (remote.contextId !== attempt.providerContextId) throw errorCode('context_identity_mismatch');
    const threadId = observedThreadId(remote);
    const pinnedThreadId = intent?.observedThreadId || intent?.reservedThreadId || attempt.threadId || null;
    if (pinnedThreadId && threadId !== pinnedThreadId) throw errorCode('thread_identity_mismatch');
    if (remote.metadata?.attemptId && remote.metadata.attemptId !== attempt.attemptId) throw errorCode('attempt_identity_mismatch');
  }

  #pinObservedThread(attemptId, intent, remote) {
    const threadId = observedThreadId(remote);
    if (!threadId) return;
    const tx = this.db.transaction(() => {
      const row = this.#intent(attemptId);
      const record = JSON.parse(row.record_json);
      if ((record.observedThreadId && record.observedThreadId !== threadId)
        || (record.reservedThreadId && record.reservedThreadId !== threadId)) throw errorCode('thread_identity_mismatch');
      if (!record.observedThreadId) {
        const held = this.db.prepare('SELECT attempt_id FROM task_executor_thread_reservations WHERE transport_key=? AND thread_id=?').get(row.transport_key, threadId);
        if (held && held.attempt_id !== attemptId) throw errorCode('provider_thread_busy');
        this.db.prepare('INSERT OR IGNORE INTO task_executor_thread_reservations(transport_key,thread_id,attempt_id) VALUES(?,?,?)').run(row.transport_key, threadId, attemptId);
        record.observedThreadId = threadId;
        this.db.prepare('UPDATE task_executor_attempts SET record_json=?,updated_at=? WHERE attempt_id=?').run(json(record), this.now(), attemptId);
      }
    });
    tx.immediate();
  }

  #remoteSummary(remote) {
    const state = remote?.status?.state;
    const summary = {
      taskId: typeof remote?.id === 'string' ? remote.id.slice(0, 256) : null,
      contextId: typeof remote?.contextId === 'string' ? remote.contextId.slice(0, 256) : null,
      threadId: typeof observedThreadId(remote) === 'string' ? observedThreadId(remote).slice(0, 256) : null,
      attemptId: typeof remote?.metadata?.attemptId === 'string' ? remote.metadata.attemptId.slice(0, 256) : null,
      status: typeof state === 'string' || typeof state === 'number' ? state : null,
    };
    return { ...summary, digest: stableDigest(summary) };
  }

  #linkKnownTask(identity, snapshot, remote) {
    try {
      this.store.recordSubmitted(identity.projectId, identity.objectiveId, identity.attemptId, identity.fencingToken, remote.id);
      this.#setState(identity.attemptId, 'submitted', remote.id);
      this.dispatchJournal.recordSubmitted(identity.attemptId, remote.id);
    } catch (error) {
      if (snapshot.attempt.state !== 'unknown' || !['claim_inactive', 'submission_state_invalid'].includes(error.code)) throw error;
      this.#evidence(identity.attemptId, 'known_task_requires_reconciliation', { taskId: remote.id });
      this.#setState(identity.attemptId, 'uncertain', remote.id);
    }
  }

  #intent(attemptId) { return this.db.prepare('SELECT * FROM task_executor_attempts WHERE attempt_id=?').get(attemptId) || null; }

  #requireTaskId(identity) {
    if (typeof identity?.taskId !== 'string' || !identity.taskId.trim()) throw errorCode('task_identity_required');
  }

  #validateIntent(identity, row) {
    this.#requireTaskId(identity);
    if (row.project_id !== identity.projectId || row.objective_id !== identity.objectiveId) throw errorCode('intent_identity_conflict');
    if (row.fencing_token !== identity.fencingToken) throw errorCode('fence_stale');
    if (row.task_id !== identity.taskId) throw errorCode('task_identity_mismatch');
  }

  #transportUnavailable(transportKey) {
    return Boolean(this.db.prepare('SELECT 1 FROM task_executor_transport_failures WHERE transport_key=?').get(String(transportKey)));
  }

  async #resolveTransport(options, attemptId) {
    try { return await this.transportFor(options); } catch (error) {
      if (error?.sharedTransportFailure === true) this.transportFailed(options.transportKey, error);
      else {
        this.#evidence(attemptId, 'transport_resolution_failed', { message: String(error?.message || error).slice(0, 500) });
        this.#setState(attemptId, 'uncertain', null);
      }
      return null;
    }
  }

  #setState(attemptId, state, externalTaskId) {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE task_executor_attempts SET state=?, external_task_id=COALESCE(?,external_task_id), updated_at=?
        WHERE attempt_id=? AND (state!='settled' OR ?='settled')`).run(state, externalTaskId || null, this.now(), attemptId, state);
      if (state === 'settled') this.db.prepare('DELETE FROM task_executor_thread_reservations WHERE attempt_id=?').run(attemptId);
    });
    tx.immediate();
  }

  #evidence(attemptId, kind, detail) {
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO task_executor_evidence(attempt_id,kind,detail_json,created_at) VALUES(?,?,?,?)').run(attemptId, kind, json(this.#bounded(detail)), this.now());
      this.db.prepare(`DELETE FROM task_executor_evidence WHERE sequence IN (
        SELECT sequence FROM task_executor_evidence WHERE attempt_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?
      )`).run(attemptId, this.maxEvidence);
    });
    tx.immediate();
  }

  #bounded(value) {
    let text;
    try { text = json(value); } catch (_) { text = '"unserializable"'; }
    if (text.length > 2000) return { truncated: true, prefix: text.slice(0, 1900) };
    return value ?? null;
  }
}

module.exports = { TaskExecutor };
