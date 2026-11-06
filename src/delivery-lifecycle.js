'use strict';

const { createHash } = require('node:crypto');
const copy = (value) => JSON.parse(JSON.stringify(value));
const RETRY_FIELDS = ['retryId', 'kind', 'scopeType', 'scopeId', 'source', 'provider', 'model', 'hypothesisId', 'strategyId', 'failureCode', 'attempt'];
const PLANNER_VALIDATION_FAILURES = new Set([
  'planner_output_invalid', 'planner_output_field_invalid', 'planner_expected_revisions_required',
  'planner_expected_revision_mismatch', 'planner_delta_invalid', 'planner_metadata_invalid', 'planner_metadata_too_large',
  'plan_object_required', 'projection_object_required', 'tasks_array_required', 'dependencies_array_required',
  'plan_revision_stale', 'plan_revision_step_invalid', 'plan_too_large', 'task_change_duplicate', 'task_id_duplicate',
  'task_revision_stale', 'task_revision_step_invalid', 'new_task_revision_invalid', 'plan_task_change_invalid',
  'active_task_contract_immutable', 'terminal_task_immutable', 'replacement_task_state_invalid', 'planner_task_state_invalid',
  'dependency_change_requires_task_revision', 'dependency_object_required', 'dependency_duplicate', 'dependency_cycle',
  'dependency_self_reference', 'dependency_reference_missing', 'dependency_successor_missing', 'dependency_successor_mismatch',
  'checkpoint_edge_kind_invalid', 'checkpoint_reference_missing', 'checkpoint_id_duplicate', 'checkpoint_object_required',
  'checkpoints_array_required', 'planner_publication_authority_invalid', 'publication_authority_invalid', 'read_scope_invalid',
  'unknown_read_scope_must_be_null', 'unknown_read_scope_reason_required', 'path_duplicate', 'path_unsafe',
  'digest_invalid', 'enum_invalid', 'field_forbidden', 'field_required', 'field_unknown', 'graph_identity_mismatch',
  'id_invalid', 'integer_invalid', 'json_array_item_invalid', 'json_array_property_invalid', 'json_key_invalid',
  'json_plain_object_required', 'json_property_invalid', 'json_string_invalid', 'json_too_complex', 'json_too_deep',
  'number_not_finite', 'objective_reference_mismatch', 'project_reference_mismatch', 'string_control_character',
  'string_invalid', 'superseded_task_missing', 'supersession_lineage_immutable', 'task_reference_mismatch',
  'unexpected_expected_revision', 'record_kind_invalid', 'record_object_required', 'record_too_large',
]);
const identity = (value, name, max = 128) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x20\x7f]/.test(value)) {
    const error = new TypeError(`${name} must be a bounded printable identity`);
    error.code = `${name}_invalid`;
    throw error;
  }
  return value;
};
const error = (code) => Object.assign(new Error(code), { code });

class DeliveryLifecycle {
  constructor({ store, executor, projectId, objectiveId, ownerGeneration, controlRevision, inbox, planner,
    budgetWakeEligibility = () => false, onWake = () => {}, onRetryDue = () => {}, getAdmissionState = () => ({ admissionStopped: null }),
    effectsSettledForShutdown = () => false, plannerRecoveryProofAdapter, plannerRetryIdentity,
    now = () => Date.now(), baseRetryDelayMs = 250,
    maxRetryDelayMs = 30000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (!store || !executor || store.db !== executor.db) throw new TypeError('Lifecycle requires a shared BacklogStore and TaskExecutor');
    if (typeof projectId !== 'string' || !projectId || typeof objectiveId !== 'string' || !objectiveId) throw new TypeError('Lifecycle scope is required');
    for (const [name, fn] of Object.entries({ budgetWakeEligibility, onWake, onRetryDue, getAdmissionState, effectsSettledForShutdown, now, setTimeoutImpl, clearTimeoutImpl })) {
      if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
    }
    if (plannerRecoveryProofAdapter !== undefined && typeof plannerRecoveryProofAdapter !== 'function') throw new TypeError('plannerRecoveryProofAdapter must be a function');
    if (plannerRetryIdentity !== undefined && typeof plannerRetryIdentity !== 'function') throw new TypeError('plannerRetryIdentity must be a function');
    if (!Number.isSafeInteger(baseRetryDelayMs) || baseRetryDelayMs < 1 || !Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < baseRetryDelayMs) throw new TypeError('Retry backoff bounds are invalid');
    const objective = store.getObjective(projectId, objectiveId);
    if (!objective) throw error('objective_missing');
    this.store = store;
    this.executor = executor;
    this.db = store.db;
    this.projectId = projectId;
    this.objectiveId = objectiveId;
    this.sessionId = objective.sessionId;
    this.ownerGeneration = ownerGeneration ?? objective.ownerGeneration;
    this.controlRevision = controlRevision ?? objective.controlRevision;
    if (!Number.isSafeInteger(this.ownerGeneration) || this.ownerGeneration < 0
      || !Number.isSafeInteger(this.controlRevision) || this.controlRevision < 0) throw new TypeError('Lifecycle pins must be non-negative integers');
    this.inbox = inbox || null;
    this.planner = planner || null;
    this.budgetWakeEligibility = budgetWakeEligibility;
    this.onWake = onWake;
    this.onRetryDue = onRetryDue;
    this.getAdmissionState = getAdmissionState;
    this.effectsSettledForShutdown = effectsSettledForShutdown;
    this.plannerRecoveryProofAdapter = plannerRecoveryProofAdapter || null;
    this.plannerRetryIdentity = plannerRetryIdentity || null;
    this.now = now;
    this.baseRetryDelayMs = baseRetryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.timer = null;
    this.disabledBudgetWaits = new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_lifecycle_planner_recoveries (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, provider_scope TEXT NOT NULL, owner_generation INTEGER NOT NULL,
      failure_code TEXT NOT NULL, proof_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,turn_id)
    );`);
  }

  pause(pins) { return this.#control('pause', pins); }
  stop(pins) { return this.#control('stop', pins); }
  resume(pins) { return this.#control('resume', pins); }
  cancel(pins) { return this.#control('cancel', pins); }

  observeControlRevision(controlRevision) {
    if (!Number.isSafeInteger(controlRevision) || controlRevision < this.controlRevision) throw error('control_revision_stale');
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!objective || objective.ownerGeneration !== this.ownerGeneration || objective.controlRevision !== controlRevision) throw error('lifecycle_generation_or_control_stale');
    this.controlRevision = controlRevision;
    return this.projection();
  }

  recordBudgetWait(input) {
    const fields = ['waitId', 'source', 'provider', 'model', 'reasonCode', 'delayMs'];
    if (input && Object.hasOwn(input, 'blockers')) fields.push('blockers');
    const normalized = this.#exact(input, fields, 'budget_wait_fields_invalid');
    for (const field of ['waitId', 'source', 'provider', 'model']) identity(normalized[field], `budget_${field}`, field === 'source' ? 80 : 128);
    if (typeof normalized.reasonCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(normalized.reasonCode)) throw error('budget_wait_reason_invalid');
    if (!Number.isSafeInteger(normalized.delayMs) || normalized.delayMs < 0 || normalized.delayMs > 30 * 24 * 60 * 60 * 1000) throw error('budget_wait_delay_invalid');
    const pins = this.#currentPins();
    const wait = this.store.recordBudgetWait(this.projectId, this.objectiveId, {
      waitId: normalized.waitId, source: normalized.source, provider: normalized.provider, model: normalized.model,
      reasonCode: normalized.reasonCode, nextWakeAt: this.now() + normalized.delayMs,
      ...(Object.hasOwn(normalized, 'blockers') ? { blockers: normalized.blockers } : {}),
      expectedControlRevision: pins.expectedControlRevision, expectedOwnerGeneration: pins.expectedOwnerGeneration,
    });
    this.disabledBudgetWaits.delete(wait.waitId);
    this.#schedule();
    return wait;
  }

  wakeBudget(waitId) {
    identity(waitId, 'budget_wait_id');
    const wait = this.store.listBudgetWaits(this.projectId, this.objectiveId).find((item) => item.waitId === waitId);
    if (!wait) throw error('budget_wait_missing');
    if (wait.state !== 'waiting') throw error('budget_wait_not_pending');
    const pins = this.#currentPins();
    if (wait.nextWakeAt > this.now()) throw error('budget_wait_not_due');
    if (wait.ownerGeneration !== pins.expectedOwnerGeneration || wait.controlRevision !== pins.expectedControlRevision) throw error('budget_wait_controlled');
    const fact = this.budgetWakeEligibility(Object.freeze(copy(wait)));
    if (fact && typeof fact.then === 'function') { fact.catch?.(() => {}); throw error('budget_wake_eligibility_must_be_synchronous'); }
    if (fact !== true) {
      this.disabledBudgetWaits.add(waitId);
      this.#schedule();
      return { state: 'waiting', reason: 'trusted_eligibility_not_true', wait };
    }
    const result = this.store.wakeBudgetWait(this.projectId, this.objectiveId, waitId, {
      expectedControlRevision: pins.expectedControlRevision, expectedOwnerGeneration: pins.expectedOwnerGeneration,
    });
    this.disabledBudgetWaits.delete(waitId);
    this.onWake('lifecycle.budget.wake');
    this.#schedule();
    return { state: 'woken', ...result };
  }

  recordTransientFailure(input) {
    const normalized = this.#exact(input, RETRY_FIELDS, 'lifecycle_retry_fields_invalid');
    for (const field of ['retryId', 'scopeId', 'hypothesisId', 'strategyId']) identity(normalized[field], `retry_${field}`);
    for (const field of ['source', 'provider', 'model']) identity(normalized[field], `retry_${field}`, 128);
    if (!['transient', 'planner_invalid', 'executor_error'].includes(normalized.kind)
      || typeof normalized.failureCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(normalized.failureCode)) throw error('lifecycle_retry_kind_invalid');
    if (!Number.isSafeInteger(normalized.attempt) || normalized.attempt < 1 || normalized.attempt > 2) throw error('lifecycle_retry_attempt_invalid');
    const delayMs = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** (normalized.attempt - 1)));
    const pins = this.#currentPins();
    const record = this.store.recordLifecycleRetry(this.projectId, this.objectiveId, {
      ...normalized, maxAttempts: 2, nextWakeAt: this.now() + delayMs,
      expectedControlRevision: pins.expectedControlRevision, expectedOwnerGeneration: pins.expectedOwnerGeneration,
    });
    this.#schedule();
    return record;
  }

  recover() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!objective) throw error('objective_missing');
    if (objective.ownerGeneration !== this.ownerGeneration) return { state: 'stale', reason: 'owner_generation_changed', ownerGeneration: objective.ownerGeneration };
    if (objective.controlRevision !== this.controlRevision) return { state: 'stale', reason: 'control_revision_changed', controlRevision: objective.controlRevision };
    const requested = this.store.requestLifecycleRecovery(this.projectId, this.objectiveId, this.ownerGeneration);
    const plannerRecovery = this.#recoverActivePlannerTurns();
    const attempts = this.store.listAttempts(this.projectId, this.objectiveId);
    const byAttempt = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
    const results = [];
    for (const claim of requested) {
      const attempt = byAttempt.get(claim.attemptId);
      if (!attempt) {
        results.push({ attemptId: claim.attemptId, state: 'unknown', reason: 'attempt_record_missing' });
        continue;
      }
      const intent = this.executor.getAttempt(claim.attemptId);
      if (intent?.state === 'submitted' || intent?.state === 'settled') {
        results.push({ attemptId: claim.attemptId, state: 'deferred', reason: `executor_${intent.state}` });
        continue;
      }
      const result = this.executor.recover({ projectId: this.projectId, objectiveId: this.objectiveId,
        taskId: claim.taskId, attemptId: claim.attemptId, fencingToken: claim.fencingToken,
        recoveryGeneration: this.ownerGeneration });
      results.push({ attemptId: claim.attemptId, ...result });
    }
    const finalObjective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!finalObjective || finalObjective.ownerGeneration !== this.ownerGeneration) {
      this.close();
      return { state: 'stale', reason: 'owner_generation_changed', ownerGeneration: finalObjective?.ownerGeneration ?? null,
        attempts: results, plannerRecovery };
    }
    if (finalObjective.controlRevision !== this.controlRevision) {
      this.close();
      return { state: 'stale', reason: 'control_revision_changed', controlRevision: finalObjective.controlRevision,
        attempts: results, plannerRecovery };
    }
    this.#schedule();
    return { state: 'checked', requested: requested.length, attempts: results, plannerRecovery, projection: this.projection() };
  }

  tick() {
    let pins;
    try { pins = this.#currentPins(); }
    catch (cause) {
      this.close();
      return { woke: 0, state: 'stale', reason: cause.code || 'lifecycle_control_stale', projection: this.projection() };
    }
    let woke = 0;
    for (const wait of this.store.listBudgetWaits(this.projectId, this.objectiveId)) {
      if (wait.state !== 'waiting' || wait.nextWakeAt > this.now() || this.disabledBudgetWaits.has(wait.waitId)) continue;
      try { if (this.wakeBudget(wait.waitId).state === 'woken') woke += 1; } catch (_) { this.disabledBudgetWaits.add(wait.waitId); }
    }
    for (const retry of this.store.listLifecycleRetries(this.projectId, this.objectiveId)) {
      if (!['waiting', 'exhausted'].includes(retry.state) || retry.nextWakeAt > this.now()) continue;
      if (retry.controlRevision !== pins.expectedControlRevision || retry.ownerGeneration !== pins.expectedOwnerGeneration) continue;
      try {
        const due = this.store.wakeLifecycleRetry(this.projectId, this.objectiveId, retry.retryId, {
          expectedControlRevision: retry.controlRevision, expectedOwnerGeneration: retry.ownerGeneration,
        });
        if (due.state === 'due' || due.state === 'strategy_due') {
          if (retry.kind === 'planner_invalid' && retry.scopeType === 'objective') {
            this.onWake(due.state === 'due' ? 'lifecycle.retry.due' : 'lifecycle.retry.strategy_change');
          } else {
            this.onRetryDue(Object.freeze(copy(due)));
          }
          woke += 1;
        }
      } catch (_) { /* stale or terminal retry records remain durable and do not dispatch */ }
    }
    this.#schedule();
    return { woke, projection: this.projection() };
  }

  resolveDueRetries() {
    const pins = this.#currentPins();
    const resolved = [];
    for (const retry of this.store.listLifecycleRetries(this.projectId, this.objectiveId)) {
      if (retry.kind !== 'planner_invalid' || retry.scopeType !== 'objective'
        || !['due', 'strategy_due'].includes(retry.state)) continue;
      try {
        resolved.push(this.store.resolveLifecycleRetry(this.projectId, this.objectiveId, retry.retryId, {
          expectedControlRevision: pins.expectedControlRevision, expectedOwnerGeneration: pins.expectedOwnerGeneration,
        }));
      } catch (_) { /* control drift is fail-closed */ }
    }
    return resolved;
  }

  finalizeBlockedPlannerRecovery() {
    let pins;
    try { pins = this.#currentPins(); }
    catch (cause) { return { state: 'stale', reason: cause.code || 'lifecycle_control_stale' }; }
    const exhausted = this.store.listLifecycleRetries(this.projectId, this.objectiveId).some((retry) => retry.kind === 'planner_invalid'
      && retry.scopeType === 'objective' && retry.scopeId === this.objectiveId && retry.state === 'blocked'
      && retry.ownerGeneration === this.ownerGeneration && retry.controlRevision === this.controlRevision);
    if (!exhausted) return { state: 'none' };
    return this.store.blockTechnicalIfNoProgress(this.projectId, this.objectiveId, {
      failureCode: 'planner_recovery_exhausted', expectedControlRevision: pins.expectedControlRevision,
      expectedOwnerGeneration: pins.expectedOwnerGeneration,
    });
  }

  handlePlannerFailure({ failureCode, turn } = {}) {
    if (typeof failureCode !== 'string' || !turn || typeof turn !== 'object') return { state: 'held', reason: 'planner_failure_identity_missing' };
    if (turn.outputReturned !== true || !PLANNER_VALIDATION_FAILURES.has(failureCode)) return { state: 'held', reason: 'planner_turn_effect_unknown' };
    try { this.#currentPins(); } catch (cause) { return { state: 'held', reason: cause.code || 'lifecycle_control_stale' }; }
    if (!this.plannerRecoveryProofAdapter || !this.planner || typeof this.planner.markPriorTurnRecoveryEligible !== 'function') {
      return { state: 'held', reason: 'planner_recovery_adapter_unavailable' };
    }
    const turnPins = { projectId: this.projectId, sessionId: this.sessionId, turnId: turn.turnId,
      providerThreadId: turn.providerThreadId, providerScope: turn.providerScope, ownerGeneration: this.ownerGeneration };
    let proof;
    try { proof = this.plannerRecoveryProofAdapter(Object.freeze({ ...turnPins, failureCode, phase: 'validation' })); }
    catch (cause) { return { state: 'held', reason: cause.code || 'planner_recovery_proof_unavailable' }; }
    if (proof && typeof proof.then === 'function') { proof.catch?.(() => {}); return { state: 'held', reason: 'planner_recovery_proof_must_be_synchronous' }; }
    const proofFields = ['projectId', 'sessionId', 'turnId', 'providerThreadId', 'providerScope', 'ownerGeneration', 'remoteQuiescent', 'processQuiescent'];
    let normalizedProof;
    try { normalizedProof = this.#exact(proof, proofFields, 'planner_recovery_proof_invalid'); }
    catch (cause) { return { state: 'held', reason: cause.code || 'planner_recovery_proof_invalid' }; }
    if (!normalizedProof || Object.keys(turnPins).some((key) => normalizedProof[key] !== turnPins[key])
      || normalizedProof.remoteQuiescent !== true || normalizedProof.processQuiescent !== true) return { state: 'held', reason: 'planner_recovery_proof_rejected' };
    try { this.#savePlannerRecoveryProof({ ...turnPins, failureCode, proof: normalizedProof }, this.controlRevision); }
    catch (cause) { return { state: 'held', reason: cause.code || 'lifecycle_control_stale' }; }
    if (!this.plannerRetryIdentity) return { state: 'eligible', reason: 'bounded_retry_identity_unavailable', proof: normalizedProof };
    let retryIdentity;
    try { retryIdentity = this.plannerRetryIdentity(Object.freeze({ failureCode, turn: copy(turn), proof: normalizedProof })); }
    catch (cause) { return { state: 'eligible', reason: cause.code || 'bounded_retry_identity_unavailable', proof: normalizedProof }; }
    const retryPins = this.#exact(retryIdentity, ['source', 'provider', 'model', 'kind'], 'lifecycle_retry_identity_invalid');
    if (!retryPins || !['planner_invalid', 'transient'].includes(retryPins.kind)) return { state: 'eligible', reason: 'bounded_retry_identity_invalid', proof: normalizedProof };
    for (const field of ['source', 'provider', 'model']) identity(retryPins[field], `retry_${field}`, 128);
    let proposal = turn.recoveryProposal;
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || Object.getPrototypeOf(proposal) !== Object.prototype) proposal = {};
    const hypothesisId = typeof proposal.hypothesisId === 'string' && /^[\x21-\x7e]{1,128}$/.test(proposal.hypothesisId)
      ? proposal.hypothesisId : `validation-${failureCode}`;
    const strategyCandidate = proposal.strategyId || proposal.mode;
    const strategyId = typeof strategyCandidate === 'string' && /^[\x21-\x7e]{1,128}$/.test(strategyCandidate)
      ? strategyCandidate : 'correct_output';
    const retryScope = { scopeType: 'objective', scopeId: this.objectiveId };
    const matching = this.store.listLifecycleRetries(this.projectId, this.objectiveId)
      .filter((item) => item.scopeType === retryScope.scopeType && item.scopeId === retryScope.scopeId
        && item.hypothesisId === hypothesisId && item.strategyId === strategyId);
    const attempt = matching.reduce((max, item) => Math.max(max, item.attempt), 0) + 1;
    if (attempt > 2) {
      const pins = this.#currentPins();
      const prior = matching.filter((item) => item.attempt === 2).at(-1);
      if (!prior) return { state: 'held', reason: 'retry_history_incomplete', proof: normalizedProof };
      const blocked = this.store.blockLifecycleRetry(this.projectId, this.objectiveId, prior.retryId, {
        failureCode: 'recovery_strategy_repeated', expectedControlRevision: pins.expectedControlRevision,
        expectedOwnerGeneration: pins.expectedOwnerGeneration,
      });
      return { state: blocked.state, retry: blocked.retry, objective: blocked.objective,
        reason: 'recovery_strategy_repeated', proof: normalizedProof };
    }
    const retryId = `planner-${createHash('sha256').update(JSON.stringify([retryScope.scopeType, retryScope.scopeId, hypothesisId, strategyId])).digest('hex').slice(0, 32)}`;
    try {
      const retry = this.recordTransientFailure({ retryId, kind: retryPins.kind, ...retryScope, source: retryPins.source,
        provider: retryPins.provider, model: retryPins.model, hypothesisId, strategyId, failureCode, attempt });
      const objective = this.store.getObjective(this.projectId, this.objectiveId);
      if (retry.state === 'blocked' && objective?.disposition !== 'blocked_technical') {
        return { state: 'blocked_retry', retry, proof: normalizedProof };
      }
      return { state: retry.state === 'blocked' ? 'blocked_technical' : 'scheduled', retry, proof: normalizedProof };
    } catch (cause) {
      if (cause.code === 'lifecycle_strategy_limit_exceeded') {
        const pins = this.#currentPins();
        const prior = this.store.listLifecycleRetries(this.projectId, this.objectiveId)
          .filter((item) => item.scopeType === retryScope.scopeType && item.scopeId === retryScope.scopeId
            && item.hypothesisId === hypothesisId).sort((left, right) => right.updatedAt - left.updatedAt)[0];
        if (!prior) return { state: 'held', reason: 'retry_strategy_limit_without_history', proof: normalizedProof };
        const blocked = this.store.blockLifecycleRetry(this.projectId, this.objectiveId, prior.retryId, {
          failureCode: 'recovery_strategy_limit', expectedControlRevision: pins.expectedControlRevision,
          expectedOwnerGeneration: pins.expectedOwnerGeneration,
        });
        return { state: blocked.state, retry: blocked.retry, objective: blocked.objective,
          reason: 'recovery_strategy_limit', proof: normalizedProof };
      }
      throw cause;
    }
  }

  reconcilePriorTurn(priorIdentity, delegate) {
    if (typeof delegate !== 'function') throw error('planner_reconciler_unavailable');
    try { this.#currentPins(); } catch (_) { return delegate(priorIdentity); }
    const saved = this.db.prepare(`SELECT provider_thread_id,provider_scope,owner_generation,proof_json,state
      FROM delivery_lifecycle_planner_recoveries WHERE project_id=? AND session_id=? AND turn_id=?`)
      .get(priorIdentity.projectId, priorIdentity.sessionId, priorIdentity.turnId);
    if (!saved || saved.state !== 'validation_proven' || saved.provider_thread_id !== priorIdentity.providerThreadId
      || saved.provider_scope !== priorIdentity.providerScope || saved.owner_generation !== priorIdentity.ownerGeneration) {
      return delegate(priorIdentity);
    }
    const proof = JSON.parse(saved.proof_json);
    const recoveryEligibility = { ...proof, state: 'recovery_eligible' };
    return Promise.resolve(delegate({ ...priorIdentity, recoveryEligibility })).then((result) => {
      if (result?.state === 'no_effect' && result.projectId === priorIdentity.projectId && result.sessionId === priorIdentity.sessionId
        && result.turnId === priorIdentity.turnId && result.ownerGeneration === priorIdentity.ownerGeneration
        && result.providerThreadId === priorIdentity.providerThreadId && result.providerScope === priorIdentity.providerScope
        && result.remoteQuiescent === true && result.processQuiescent === true) {
        this.db.prepare(`UPDATE delivery_lifecycle_planner_recoveries SET state='reconciled',updated_at=?
          WHERE project_id=? AND session_id=? AND turn_id=? AND state='validation_proven'`)
          .run(this.now(), priorIdentity.projectId, priorIdentity.sessionId, priorIdentity.turnId);
      }
      return result;
    });
  }

  shutdownProjection() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    let admission = null;
    try { admission = this.getAdmissionState(); } catch (_) { admission = null; }
    const claims = this.store.listClaims(this.projectId, this.objectiveId).filter((claim) => ['active', 'expired', 'fenced'].includes(claim.state));
    const attempts = this.store.listAttempts(this.projectId, this.objectiveId).filter((attempt) => !['succeeded', 'failed', 'canceled'].includes(attempt.state));
    const hasPlannerLedger = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get();
    const plannerTurns = hasPlannerLedger ? this.db.prepare(`SELECT turn_id,status FROM delivery_planner_turns
      WHERE project_id=? AND session_id=? AND status IN ('active','unknown') ORDER BY started_at,turn_id`).all(this.projectId, this.sessionId) : [];
    const inboxPending = this.inbox?.pending().length ?? 0;
    let effectsSettled = false;
    try {
      const fact = this.effectsSettledForShutdown(Object.freeze({ projectId: this.projectId, objectiveId: this.objectiveId, objective: copy(objective), attempts: copy(attempts) }));
      if (fact && typeof fact.then === 'function') fact.catch?.(() => {});
      else effectsSettled = fact === true;
    }
    catch (_) { effectsSettled = false; }
    const durableAdmissionBlocked = ['draining', 'paused_owner', 'waiting_budget', 'waiting_owner', 'recovering', 'blocked_technical', 'validating', 'accepted', 'partial', 'canceled'].includes(objective?.disposition);
    const admissionStopped = admission?.admissionStopped === true || durableAdmissionBlocked;
    const reasons = [];
    if (admission?.controllerWorkInFlight === true) reasons.push('controller_cycle_in_flight');
    if (claims.length) reasons.push('live_or_uncertain_claims');
    if (attempts.length) reasons.push('unsettled_attempts');
    if (plannerTurns.length || this.planner?.inFlight) reasons.push('live_or_unknown_planner_turn');
    if (inboxPending) reasons.push('pending_inbox_messages');
    if (!effectsSettled) reasons.push('publication_effect_settlement_unproven');
    if (!admissionStopped) reasons.push('admission_not_stopped_or_unknown');
    return { projectId: this.projectId, objectiveId: this.objectiveId, ownerGeneration: this.ownerGeneration,
      controlRevision: objective?.controlRevision ?? null, disposition: objective?.disposition || 'missing',
      admissionStopped,
      claims, unresolvedAttempts: attempts.map((attempt) => ({ attemptId: attempt.attemptId, taskId: attempt.taskId, state: attempt.state })),
      plannerTurns: copy(plannerTurns), plannerInFlight: Boolean(this.planner?.inFlight), inboxPending,
      effectsSettled, safeToRelease: reasons.length === 0, reasons };
  }

  projection() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    const waits = this.store.listBudgetWaits(this.projectId, this.objectiveId);
    const retries = this.store.listLifecycleRetries(this.projectId, this.objectiveId);
    const control = this.store.getLifecycleControl(this.projectId, this.objectiveId);
    return { projectId: this.projectId, objectiveId: this.objectiveId, ownerGeneration: this.ownerGeneration,
      controlRevision: objective?.controlRevision ?? null, cause: control?.cause || null, disposition: objective?.disposition || 'missing',
      ownerDecisions: this.store.listOwnerDecisions(this.projectId, this.objectiveId),
      budgetWaits: copy(waits), retries: copy(retries), shutdown: this.shutdownProjection() };
  }

  close() {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = null;
  }

  #control(action, pins = {}) {
    const expectedControlRevision = pins.expectedControlRevision ?? this.controlRevision;
    const expectedOwnerGeneration = pins.expectedOwnerGeneration ?? this.ownerGeneration;
    if (expectedOwnerGeneration !== this.ownerGeneration) throw error('owner_generation_stale');
    if (expectedControlRevision !== this.controlRevision) throw error('control_revision_stale');
    this.#currentPins();
    const updated = this.store.transitionLifecycleControl(this.projectId, this.objectiveId,
      { action, expectedControlRevision, expectedOwnerGeneration });
    this.controlRevision = updated.controlRevision;
    if (action === 'resume') this.disabledBudgetWaits.clear();
    this.#schedule();
    return updated;
  }

  #currentObjective() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!objective) throw error('objective_missing');
    if (objective.ownerGeneration !== this.ownerGeneration) throw error('owner_generation_stale');
    return objective;
  }

  #currentPins() {
    const objective = this.#currentObjective();
    if (objective.controlRevision !== this.controlRevision) throw error('control_revision_stale');
    return { expectedControlRevision: objective.controlRevision, expectedOwnerGeneration: this.ownerGeneration };
  }

  #schedule() {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = null;
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!objective || objective.ownerGeneration !== this.ownerGeneration) return;
    if (objective.controlRevision !== this.controlRevision) return;
    const times = [
      ...this.store.listBudgetWaits(this.projectId, this.objectiveId).filter((wait) => wait.state === 'waiting'
        && wait.ownerGeneration === this.ownerGeneration && wait.controlRevision === objective.controlRevision
        && !this.disabledBudgetWaits.has(wait.waitId)).map((wait) => wait.nextWakeAt),
      ...this.store.listLifecycleRetries(this.projectId, this.objectiveId).filter((retry) => ['waiting', 'exhausted'].includes(retry.state)
        && retry.ownerGeneration === this.ownerGeneration && retry.controlRevision === objective.controlRevision).map((retry) => retry.nextWakeAt),
    ];
    if (!times.length) return;
    const delay = Math.max(1, Math.min(...times) - this.now());
    this.timer = this.setTimeoutImpl(() => { this.timer = null; this.tick(); }, delay);
    this.timer.unref?.();
  }

  #savePlannerRecoveryProof({ projectId, sessionId, turnId, providerThreadId, providerScope, ownerGeneration, failureCode, proof }, expectedControlRevision) {
    const encoded = JSON.stringify(proof);
    const tx = this.db.transaction(() => {
      const objective = this.store.getObjective(projectId, this.objectiveId);
      if (!objective || objective.ownerGeneration !== ownerGeneration || ownerGeneration !== this.ownerGeneration
        || objective.controlRevision !== expectedControlRevision || expectedControlRevision !== this.controlRevision) {
        throw error('lifecycle_generation_or_control_stale');
      }
      const existing = this.db.prepare(`SELECT proof_json,state FROM delivery_lifecycle_planner_recoveries
        WHERE project_id=? AND session_id=? AND turn_id=?`).get(projectId, sessionId, turnId);
      if (existing) {
        if (existing.proof_json !== encoded) throw error('planner_recovery_proof_conflict');
        return;
      }
      this.db.prepare(`INSERT INTO delivery_lifecycle_planner_recoveries
        (project_id,session_id,turn_id,provider_thread_id,provider_scope,owner_generation,failure_code,proof_json,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'validation_proven',?,?)`)
        .run(projectId, sessionId, turnId, providerThreadId, providerScope, ownerGeneration, failureCode, encoded, this.now(), this.now());
    });
    return tx.immediate();
  }

  #recoverActivePlannerTurns() {
    if (!this.planner || typeof this.planner.markPriorTurnRecoveryEligible !== 'function') return [];
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_planner_turns'").get();
    if (!table) return [];
    const rows = this.db.prepare(`SELECT turn_id,provider_thread_id,provider_scope,pins_json FROM delivery_planner_turns
      WHERE project_id=? AND session_id=? AND status='active' ORDER BY started_at,turn_id`).all(this.projectId, this.sessionId);
    const results = [];
    for (const row of rows) {
      let pins;
      try { pins = JSON.parse(row.pins_json); } catch (_) { results.push({ turnId: row.turn_id, state: 'held', reason: 'planner_pins_invalid' }); continue; }
      const input = { projectId: this.projectId, sessionId: this.sessionId, turnId: row.turn_id,
        providerThreadId: row.provider_thread_id, providerScope: row.provider_scope,
        ownerGeneration: pins.ownerGeneration, phase: 'restart' };
      let proof;
      try { proof = this.plannerRecoveryProofAdapter?.(Object.freeze(input)); }
      catch (cause) { results.push({ turnId: row.turn_id, state: 'held', reason: cause.code || 'planner_recovery_proof_unavailable' }); continue; }
      if (proof && typeof proof.then === 'function') { proof.catch?.(() => {}); results.push({ turnId: row.turn_id, state: 'held', reason: 'planner_recovery_proof_must_be_synchronous' }); continue; }
      const fields = ['projectId', 'sessionId', 'turnId', 'providerThreadId', 'providerScope', 'ownerGeneration', 'remoteQuiescent', 'processQuiescent'];
      let normalized;
      try { normalized = this.#exact(proof, fields, 'planner_recovery_proof_invalid'); }
      catch (cause) { results.push({ turnId: row.turn_id, state: 'held', reason: cause.code }); continue; }
      if (fields.slice(0, 6).some((field) => normalized[field] !== input[field])
        || normalized.remoteQuiescent !== true || normalized.processQuiescent !== true) {
        results.push({ turnId: row.turn_id, state: 'held', reason: 'planner_recovery_proof_rejected' });
        continue;
      }
      try {
        results.push({ turnId: row.turn_id, state: 'eligible', proof: this.planner.markPriorTurnRecoveryEligible(normalized) });
      } catch (cause) { results.push({ turnId: row.turn_id, state: 'held', reason: cause.code || 'planner_recovery_not_authorized' }); }
    }
    return results;
  }

  #exact(value, fields, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw error(code);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) throw error(code);
    const result = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw error(code);
      result[field] = descriptor.value;
    }
    return result;
  }
}

module.exports = { DeliveryLifecycle };
