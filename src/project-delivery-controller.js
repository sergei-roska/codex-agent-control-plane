'use strict';

const { DeliveryInbox } = require('./delivery-inbox');
const { LeadPlanner } = require('./lead-planner');
const { TaskScheduler } = require('./task-scheduler');
const { DeliveryLifecycle } = require('./delivery-lifecycle');

const copy = (value) => JSON.parse(JSON.stringify(value));

class ProjectDeliveryController {
  constructor({ store, executor, projectId, objectiveId, sessionId, inbox, planner, lifecycle, lifecycleOptions = {}, runTurn, settingsFor, contextFor, reconcilePriorTurn, authorizeRecovery, trustedPreDispatchError, providerThreadId, schedulerOptions = {}, authenticateOwner, onOwnerCorrection = () => {}, onSettledAttempt = () => {}, processBudgetWaits = null, now = () => Date.now() } = {}) {
    if (!store || !executor) throw new TypeError('ProjectDeliveryController requires store and executor');
    if (!projectId || !objectiveId || !sessionId) throw new TypeError('Project, objective and session identity are required');
    if (typeof onOwnerCorrection !== 'function') throw new TypeError('Owner correction hook must be a function');
    this.onOwnerCorrection = onOwnerCorrection;
    this.onSettledAttempt = onSettledAttempt;
    this.processBudgetWaits = typeof processBudgetWaits === 'function' ? processBudgetWaits : null;
    this.budgetWaitTimer = null;
    this.store = store;
    this.executor = executor;
    this.projectId = projectId;
    this.objectiveId = objectiveId;
    this.sessionId = sessionId;
    this.inbox = inbox || new DeliveryInbox(store.db, { projectId, objectiveId, sessionId, authenticateOwner, now });
    if (this.inbox.db !== store.db || this.inbox.projectId !== projectId || this.inbox.objectiveId !== objectiveId || this.inbox.sessionId !== sessionId) throw new TypeError('Inbox identity and database must match controller');
    const currentObjective = this.store.getObjective(projectId, objectiveId);
    if (!currentObjective) throw Object.assign(new Error('objective_missing'), { code: 'objective_missing' });
    const configuredIdentity = typeof schedulerOptions.controllerIdentity === 'function'
      ? schedulerOptions.controllerIdentity()
      : schedulerOptions.controllerIdentity;
    this.ownerGeneration = configuredIdentity?.ownerGeneration ?? currentObjective.ownerGeneration;
    this.controlRevision = configuredIdentity?.controlRevision ?? currentObjective.controlRevision;
    if (!Number.isSafeInteger(this.ownerGeneration) || this.ownerGeneration < 0 || !Number.isSafeInteger(this.controlRevision) || this.controlRevision < 0) {
      throw new TypeError('Controller identity revisions must be non-negative integers');
    }
    this.lastModelTurn = null;
    let lifecycleRef = null;
    const observedRunTurn = typeof runTurn === 'function' ? async (turnInput) => {
      try {
        const output = await runTurn(turnInput);
        let recoveryProposal = null;
        try { recoveryProposal = output?.recovery === undefined ? null : copy(output.recovery); } catch (_) { recoveryProposal = null; }
        this.lastModelTurn = { turnId: turnInput.turnId, providerThreadId: turnInput.providerThreadId,
          providerScope: turnInput.providerScope, ownerGeneration: this.ownerGeneration,
          outputReturned: true, recoveryProposal };
        return output;
      } catch (cause) {
        this.lastModelTurn = { turnId: turnInput.turnId, providerThreadId: turnInput.providerThreadId,
          providerScope: turnInput.providerScope, ownerGeneration: this.ownerGeneration, outputReturned: false,
          failureCode: cause?.code || 'planner_turn_error',
          providerFailure: cause?.execution || cause?.terminalTurn || cause?.codexError ? {
            failureClass: cause.failureClass || null, outcomeUnknown: cause.outcomeUnknown === true,
            status: cause.status || cause.terminalTurn?.status || null,
            code: cause.codexError?.code || cause.terminalTurn?.error?.code || cause.code || null,
            threadId: cause.execution?.threadId || cause.threadId || null,
            turnId: cause.execution?.turnId || cause.turnId || cause.terminalTurn?.id || null,
            turnTerminal: cause.execution?.turnTerminal === true,
            turnStartRejected: cause.execution?.turnStartRejected === true,
          } : null };
        throw cause;
      }
    } : runTurn;
    const observedReconcilePriorTurn = typeof reconcilePriorTurn === 'function'
      ? (priorIdentity) => lifecycleRef ? lifecycleRef.reconcilePriorTurn(priorIdentity, reconcilePriorTurn) : reconcilePriorTurn(priorIdentity)
      : reconcilePriorTurn;
    this.planner = planner || new LeadPlanner({ store, inbox: this.inbox, runTurn: observedRunTurn, settingsFor, contextFor,
      reconcilePriorTurn: observedReconcilePriorTurn, authorizeRecovery, trustedPreDispatchError, providerThreadId, ownerGeneration: this.ownerGeneration, now });
    if (this.planner.store !== store || this.planner.inbox !== this.inbox || this.planner.ownerGeneration !== this.ownerGeneration) throw new TypeError('Planner identity does not match controller');
    this.running = false;
    this.shutdownRequested = false;
    this.runGeneration = 0;
    this.cycle = null;
    this.cyclePending = false;
    this.busyRetryTimer = null;
    this.busyRetryDelayMs = 100;
    this.reconciliationTimers = new Map();
    this.lastPlanner = null;
    this.lastRecovery = null;
    this.lastAttemptFailure = null;
    this.executionAbortController = new AbortController();
    const lifecycleIdentity = { ...(lifecycleOptions || {}), store, executor, projectId, objectiveId,
      ownerGeneration: this.ownerGeneration, controlRevision: this.controlRevision, inbox: this.inbox, planner: this.planner, now,
      onWake: (reason) => this.wake(reason),
      getAdmissionState: () => ({ admissionStopped: this.shutdownRequested || ['draining', 'paused_owner', 'waiting_budget', 'waiting_owner', 'recovering', 'blocked_technical', 'validating', 'accepted', 'partial', 'canceled'].includes(this.store.getObjective(this.projectId, this.objectiveId)?.disposition),
        controllerWorkInFlight: Boolean(this.cycle) || Boolean(this.scheduler?.runPromise) }) };
    this.lifecycle = lifecycle || new DeliveryLifecycle(lifecycleIdentity);
    lifecycleRef = this.lifecycle;
    if (this.lifecycle.store !== store || this.lifecycle.executor !== executor || this.lifecycle.projectId !== projectId
      || this.lifecycle.objectiveId !== objectiveId || this.lifecycle.ownerGeneration !== this.ownerGeneration
      || this.lifecycle.controlRevision !== this.controlRevision) throw new TypeError('Lifecycle identity does not match controller');
    this.scheduler = new TaskScheduler({ ...schedulerOptions, store, executor: this.#observedExecutor(), projectId, objectiveId,
      controllerIdentity: () => ({ ownerGeneration: this.ownerGeneration, controlRevision: this.controlRevision }),
      admissionPolicy: (candidate, live, context) => {
        if (this.inbox.pending({ limit: 1 }).length || this.inbox.hasBlockingOwnerCorrection() || this.store.pendingOwnerDecision(this.projectId, this.objectiveId)) return false;
        return schedulerOptions.admissionPolicy ? schedulerOptions.admissionPolicy(candidate, live, context) : true;
      } });
    const plannerRun = this.planner.run.bind(this.planner);
    this.planner.run = (...args) => this.shutdownRequested
      ? Promise.resolve({ state: 'blocked', reason: 'controller_shutdown' })
      : plannerRun(...args);
    const schedulerRunOnce = this.scheduler.runOnce.bind(this.scheduler);
    this.scheduler.runOnce = (...args) => this.shutdownRequested
      ? Promise.resolve({ state: 'blocked', reason: 'controller_shutdown' })
      : schedulerRunOnce(...args);
  }

  start() {
    if (this.running || this.shutdownRequested || this.cycle) return this.status();
    if (this.store.pendingOwnerDecision(this.projectId, this.objectiveId)) return this.status();
    this.lastRecovery = this.lifecycle.recover();
    if (this.lastRecovery.state === 'stale') return this.status();
    this.runGeneration += 1;
    this.running = true;
    this.#scheduleBudgetWaitPoll();
    this.scheduler.start();
    for (const attempt of this.store.listAttempts(this.projectId, this.objectiveId).filter((item) => item.state === 'unknown')) {
      this.#scheduleUnknownReconciliation(attempt.attemptId);
    }
    if (this.inbox.pending({ limit: 1 }).length) this.wake();
    else if (this.inbox.projection().wakeup) this.wake();
    return this.status();
  }

  receive(message) {
    const ack = this.inbox.receive(message);
    this.wake();
    return ack;
  }

  wake(reason) {
    if (this.shutdownRequested) return;
    if (this.busyRetryTimer) { clearTimeout(this.busyRetryTimer); this.busyRetryTimer = null; }
    if (reason !== undefined) this.inbox.signal(reason);
    if (!this.running) return;
    if (this.cycle) { this.cyclePending = true; return; }
    const runGeneration = this.runGeneration;
    queueMicrotask(() => {
      if (!this.running || this.shutdownRequested || runGeneration !== this.runGeneration || this.cycle) return;
      this.runOnce().catch((error) => ({ state: 'error', code: error.code || 'controller_error' }));
    });
  }

  async runOnce() {
    if (this.shutdownRequested) return { state: 'blocked', reason: 'controller_shutdown' };
    if (this.cycle) return this.cycle;
    const runGeneration = this.runGeneration;
    const cycle = this.#runCycle(runGeneration).catch((error) => ({ state: 'error', code: error.code || 'controller_error' })).finally(() => {
      if (this.cycle === cycle) this.cycle = null;
      if (this.running && !this.shutdownRequested && runGeneration === this.runGeneration && this.cyclePending) {
        this.cyclePending = false;
        this.wake();
      }
    });
    this.cycle = cycle;
    return cycle;
  }

  stop() {
    this.running = false;
    this.runGeneration += 1;
    this.cyclePending = false;
    if (this.budgetWaitTimer) { clearTimeout(this.budgetWaitTimer); this.budgetWaitTimer = null; }
    if (this.busyRetryTimer) { clearTimeout(this.busyRetryTimer); this.busyRetryTimer = null; }
    this.scheduler.stop();
    for (const timer of this.reconciliationTimers.values()) clearTimeout(timer);
    this.reconciliationTimers.clear();
    this.lifecycle.close();
    return this.status();
  }

  pauseObjective(pins) {
    const updated = this.lifecycle.pause(pins);
    this.controlRevision = updated.controlRevision;
    this.scheduler.wake();
    this.wake('owner.pause');
    return updated;
  }

  async emergencyStop(pins) {
    const updated = this.lifecycle.stop(pins);
    this.controlRevision = updated.controlRevision;
    const aborts = await this.#abortAdmittedAttempts();
    this.scheduler.wake();
    this.wake('owner.stop');
    return { objective: updated, aborts, lifecycle: this.lifecycle.projection() };
  }

  adoptOwnerDecisionControl() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    this.lifecycle.observeControlRevision(objective.controlRevision);
    this.controlRevision = objective.controlRevision;
  }

  resumeObjective(pins) {
    const updated = this.lifecycle.resume(pins);
    this.controlRevision = updated.controlRevision;
    this.executionAbortController = new AbortController();
    this.scheduler.wake();
    this.wake('owner.resume');
    return updated;
  }

  async cancelObjective(pins) {
    const updated = this.lifecycle.cancel(pins);
    this.controlRevision = updated.controlRevision;
    const aborts = await this.#abortAdmittedAttempts();
    this.scheduler.wake();
    this.wake('owner.cancel');
    return { objective: updated, aborts, lifecycle: this.lifecycle.projection() };
  }

  shutdown({ pause = false } = {}) {
    if (pause && !['accepted', 'partial', 'canceled', 'paused_owner'].includes(this.store.getObjective(this.projectId, this.objectiveId)?.disposition)) {
      const updated = this.lifecycle.pause();
      this.controlRevision = updated.controlRevision;
    }
    if (!this.shutdownRequested && this.planner.inFlight) this.inbox.signal('controller.shutdown');
    this.shutdownRequested = true;
    if (this.budgetWaitTimer) { clearTimeout(this.budgetWaitTimer); this.budgetWaitTimer = null; }
    this.runGeneration += 1;
    this.running = false;
    this.cyclePending = false;
    if (this.busyRetryTimer) { clearTimeout(this.busyRetryTimer); this.busyRetryTimer = null; }
    this.scheduler.stop();
    this.lifecycle.close();
    return this.lifecycle.shutdownProjection();
  }

  status() {
    return { projectId: this.projectId, objectiveId: this.objectiveId, sessionId: this.sessionId,
      running: this.running, objective: this.store.getObjective(this.projectId, this.objectiveId),
      inbox: this.inbox.projection(), messages: this.inbox.messages(), pendingMessages: this.inbox.pending(), scheduler: this.scheduler.projection(),
      planner: this.planner.projection(), lastPlanner: this.lastPlanner, lastRecovery: this.lastRecovery,
      lastAttemptFailure: this.lastAttemptFailure,
      lifecycle: this.lifecycle.projection() };
  }

  async #runCycle(runGeneration) {
    if (!this.#runGenerationCurrent(runGeneration)) return this.#staleRunResult();
    await this.#applyOwnerCorrections();
    if (!this.#runGenerationCurrent(runGeneration)) return this.#staleRunResult();
    const currentObjective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!currentObjective || currentObjective.ownerGeneration !== this.ownerGeneration
      || currentObjective.controlRevision !== this.controlRevision) {
      this.scheduler.wake();
      return { state: 'stale', reason: 'lifecycle_identity_changed' };
    }
    const inbox = this.inbox.projection();
    if (inbox.wakeup) {
      const exhaustedRecovery = this.lifecycle.finalizeBlockedPlannerRecovery();
      if (exhaustedRecovery.state !== 'none' && exhaustedRecovery.state !== 'stale') {
        this.scheduler.wake();
        return { state: 'blocked', reason: exhaustedRecovery.state === 'blocked_technical'
          ? 'planner_recovery_exhausted' : 'planner_retry_exhausted' };
      }
      if (exhaustedRecovery.state === 'stale') {
        this.scheduler.wake();
        return { state: 'stale', reason: exhaustedRecovery.reason };
      }
      if (!this.#runGenerationCurrent(runGeneration)) return this.#staleRunResult();
      let result;
      try { result = await this.planner.run(inbox.triggerReasons.join(',') || 'durable_trigger'); }
      catch (cause) {
        if (!this.#runGenerationCurrent(runGeneration)) return this.#staleRunResult();
        const turn = this.lastModelTurn?.turnId === this.planner.projection().lastTurn?.turn_id ? this.lastModelTurn : null;
        this.lastRecovery = this.lifecycle.handlePlannerFailure({ failureCode: cause?.code || 'planner_turn_error', turn });
        if (['blocked_retry', 'blocked_technical'].includes(this.lastRecovery.state)) {
          const finalized = this.lifecycle.finalizeBlockedPlannerRecovery();
          if (finalized.state === 'blocked_technical') this.lastRecovery = { ...this.lastRecovery, state: 'blocked_technical', objective: finalized.objective };
          this.scheduler.wake();
        }
        result = { state: 'error', code: cause?.code || 'planner_turn_error', recovery: this.lastRecovery,
          providerFailure: turn?.providerFailure || null };
      }
      if (!this.#runGenerationCurrent(runGeneration)) {
        this.lastPlanner = result;
        return this.#staleRunResult();
      }
      this.lastPlanner = result;
      if (result.state === 'complete' && result.decision) this.adoptOwnerDecisionControl();
      if (result.state === 'complete') this.lifecycle.resolveDueRetries();
      if (result.state === 'busy') this.#scheduleBusyRetry();
      else this.busyRetryDelayMs = 100;
      if (result.state === 'complete' || result.state === 'stale') this.scheduler.wake();
      return result;
    }
    this.scheduler.wake();
    return { state: 'idle', reason: 'no_trigger' };
  }

  applyPendingOwnerCorrections() {
    if (this.shutdownRequested) throw Object.assign(new Error('controller_shutdown'), { code: 'controller_shutdown' });
    this.#applyOwnerCorrections();
  }

  #applyOwnerCorrections() {
    if (this.store.getObjective(this.projectId, this.objectiveId)?.ownerGeneration !== this.ownerGeneration) {
      throw Object.assign(new Error('owner_generation_stale'), { code: 'owner_generation_stale' });
    }
    for (const message of this.inbox.pending()) {
      if (message.kind !== 'owner_correction') continue;
      try {
        if (!this.inbox.isAuthenticatedOwnerMessage(message.messageId)) throw Object.assign(new Error('owner_authentication_required'), { code: 'owner_authentication_required' });
        if (typeof this.store.applyOwnerCorrection !== 'function') throw Object.assign(new Error('owner_correction_extension_unavailable'), { code: 'owner_correction_extension_unavailable' });
        const correction = { ...message.payload.correction, sourceMessageId: message.messageId };
        const apply = this.store.db.transaction(() => {
          const prior = this.store.getObjective(this.projectId, this.objectiveId);
          if (prior?.ownerGeneration !== this.ownerGeneration || prior.controlRevision !== this.controlRevision) {
            throw Object.assign(new Error('lifecycle_identity_changed'), { code: 'lifecycle_identity_changed' });
          }
          const current = this.store.applyOwnerCorrection(this.projectId, this.objectiveId, correction);
          const result = this.onOwnerCorrection({ prior: copy(prior), current: copy(current), message: copy(message) });
          if (result && typeof result.then === 'function') {
            result.catch?.(() => {});
            throw Object.assign(new Error('owner_correction_hook_async'), { code: 'owner_correction_hook_async' });
          }
          const refreshed = this.store.getObjective(this.projectId, this.objectiveId);
          if (refreshed?.ownerGeneration !== this.ownerGeneration || refreshed.controlRevision !== current.controlRevision
            || refreshed.goalRevision !== current.goalRevision || refreshed.requirementDigest !== current.requirementDigest) {
            throw Object.assign(new Error('lifecycle_identity_changed'), { code: 'lifecycle_identity_changed' });
          }
          this.inbox.markApplied(message.messageId, 'received', { goalRevision: current.goalRevision, controlRevision: current.controlRevision });
          this.inbox.signal('owner.correction.applied');
          return current;
        });
        const updated = apply.immediate();
        this.controlRevision = updated.controlRevision;
        this.lifecycle.observeControlRevision(updated.controlRevision);
      } catch (cause) {
        this.inbox.markBlocked(message.messageId, 'received', { code: cause.code || 'owner_correction_failed' });
      }
    }
  }

  #observedExecutor() {
    const original = this.executor;
    const wrap = (name) => async (...args) => {
      let result;
      try {
        result = name === 'execute'
          ? await original.execute(args[0], { ...(args[1] || {}), signal: this.executionAbortController.signal })
          : await original[name](...args);
      } catch (cause) {
        const failureCode = typeof cause?.code === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(cause.code)
          ? cause.code : 'attempt_error';
        this.lastAttemptFailure = { attemptId: args[0]?.attemptId || null, operation: name, failureCode,
          state: 'held', reason: 'trusted_recovery_required' };
        const objective = this.store.getObjective(this.projectId, this.objectiveId);
        if (!this.shutdownRequested && objective?.ownerGeneration === this.ownerGeneration
          && objective.controlRevision === this.controlRevision && ['planning', 'executing'].includes(objective.disposition)) {
          this.store.blockTechnical(this.projectId, this.objectiveId, { failureCode,
            expectedOwnerGeneration: this.ownerGeneration, expectedControlRevision: this.controlRevision });
        }
        throw cause;
      }
      if (!this.shutdownRequested && ['succeeded', 'failed', 'canceled', 'settled'].includes(result?.state)) {
        const attemptId = args[0]?.attemptId;
        const timer = this.reconciliationTimers.get(attemptId);
        if (timer) clearTimeout(timer);
        this.reconciliationTimers.delete(attemptId);
        if (result?.state === 'failed' && result.result?.failureKind === 'usage_limit') {
          await this.onSettledAttempt({ identity: args[0], result: copy(result.result) });
        }
        this.inbox.signal('attempt.settled');
        this.wake();
      } else if (result?.state === 'unknown' && args[0]?.attemptId) {
        this.#scheduleUnknownReconciliation(args[0].attemptId);
      }
      return result;
    };
    return { getAttempt: (...args) => original.getAttempt(...args), execute: wrap('execute'), reconcile: wrap('reconcile'), poll: wrap('poll') };
  }

  #scheduleBudgetWaitPoll() {
    if (!this.processBudgetWaits || !this.running || this.shutdownRequested || this.budgetWaitTimer) return;
    this.budgetWaitTimer = setTimeout(async () => {
      this.budgetWaitTimer = null;
      if (!this.running || this.shutdownRequested) return;
      try { await this.processBudgetWaits(this.objectiveId); } catch (_) { /* durable wait remains pending */ }
      this.#scheduleBudgetWaitPoll();
    }, 1000);
    this.budgetWaitTimer.unref?.();
  }

  #scheduleBusyRetry() {
    if (!this.running || this.busyRetryTimer) return;
    const delay = this.busyRetryDelayMs;
    const runGeneration = this.runGeneration;
    this.busyRetryDelayMs = Math.min(2000, this.busyRetryDelayMs * 2);
    this.busyRetryTimer = setTimeout(() => {
      this.busyRetryTimer = null;
      if (this.running && !this.shutdownRequested && runGeneration === this.runGeneration && this.inbox.projection().wakeup) this.wake();
    }, delay);
    this.busyRetryTimer.unref?.();
  }

  #runGenerationCurrent(runGeneration) {
    return !this.shutdownRequested && runGeneration === this.runGeneration;
  }

  #scheduleUnknownReconciliation(attemptId) {
    if (this.shutdownRequested || this.reconciliationTimers.has(attemptId)) return;
    const timer = setTimeout(async () => {
      this.reconciliationTimers.delete(attemptId);
      if (this.shutdownRequested) return;
      const attempt = this.store.listAttempts(this.projectId, this.objectiveId).find((item) => item.attemptId === attemptId);
      if (!attempt || !['claimed', 'unknown', 'running', 'settling'].includes(attempt.state)) return;
      const claim = this.store.listClaims(this.projectId, this.objectiveId).find((item) => item.attemptId === attemptId);
      if (!claim || !['active', 'expired', 'fenced'].includes(claim.state)) return;
      const intent = this.executor.getAttempt(attemptId);
      const identity = { projectId: this.projectId, objectiveId: this.objectiveId, taskId: attempt.taskId,
        attemptId, fencingToken: claim.fencingToken,
        ...(attempt.state === 'unknown' && (!intent || claim.ownerGeneration !== this.ownerGeneration)
          ? { recoveryGeneration: this.ownerGeneration } : {}) };
      try {
        if (intent?.state === 'submitted') await this.executor.poll(identity);
        else if (intent && intent.state !== 'settled') await this.executor.reconcile(identity);
        else if (!intent) await this.executor.recover(identity);
      } catch (_) { /* unresolved identities remain held for the next reconciliation pass */ }
      const current = this.store.listAttempts(this.projectId, this.objectiveId).find((item) => item.attemptId === attemptId);
      if (current && !['succeeded', 'failed', 'canceled'].includes(current.state)) this.#scheduleUnknownReconciliation(attemptId);
      this.scheduler.wake();
      this.wake('attempt.reconciliation');
    }, 1000);
    timer.unref?.();
    this.reconciliationTimers.set(attemptId, timer);
  }

  #staleRunResult() {
    return { state: 'stale', reason: this.shutdownRequested ? 'controller_shutdown' : 'run_generation_changed' };
  }

  async #abortAdmittedAttempts() {
    this.executionAbortController.abort();
    const attempts = new Map(this.store.listAttempts(this.projectId, this.objectiveId).map((attempt) => [attempt.attemptId, attempt]));
    const live = this.store.listClaims(this.projectId, this.objectiveId).filter((claim) => ['active', 'expired', 'fenced'].includes(claim.state));
    return Promise.all(live.map(async (claim) => {
      const attempt = attempts.get(claim.attemptId);
      const intent = this.executor.getAttempt(claim.attemptId);
      if (!attempt || !intent || intent.state === 'settled') return { attemptId: claim.attemptId, state: 'unknown', reason: 'no_cancelable_intent' };
      const identity = { projectId: this.projectId, objectiveId: this.objectiveId, taskId: attempt.taskId,
        attemptId: attempt.attemptId, fencingToken: claim.fencingToken,
        ...(attempt.state === 'unknown' && this.ownerGeneration !== claim.ownerGeneration ? { recoveryGeneration: this.ownerGeneration } : {}) };
      try { return { attemptId: claim.attemptId, ...(await this.executor.abort(identity)) }; }
      catch (cause) { return { attemptId: claim.attemptId, state: 'unknown', reason: cause.code || 'abort_unconfirmed' }; }
    }));
  }
}

module.exports = { ProjectDeliveryController };
