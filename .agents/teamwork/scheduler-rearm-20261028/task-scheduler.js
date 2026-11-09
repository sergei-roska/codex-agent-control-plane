'use strict';

const { resourceConflict } = require('./task-resource-policy');

const NO_CLAIM_STATES = new Set(['draining', 'paused_owner', 'waiting_budget', 'waiting_owner', 'recovering', 'blocked_technical', 'validating', 'accepted', 'partial', 'canceled']);
const IDLE = Object.freeze({
  dependency: 'dependency', capacity: 'capacity', role: 'role',
  writeConflict: 'write_conflict', readConflict: 'read_conflict',
  resourceConflict: 'resource_conflict', reviewBarrier: 'review_barrier',
  pause: 'pause_control', recovery: 'recovery', noReady: 'no_ready_work',
});
const copy = (value) => JSON.parse(JSON.stringify(value));

class TaskScheduler {
  constructor({ store, executor, projectId, objectiveId, controllerIdentity, roles, roleLimits, writerMode, leaseMs = 30000, pollIntervalMs = 1000, maxActiveTurns, plannerReservedSlots, isFrozenReview = () => false, admissionPolicy, now = () => Date.now() } = {}) {
    if (!store || !executor) throw new TypeError('BacklogStore and TaskExecutor are required');
    if (typeof projectId !== 'string' || !projectId || typeof objectiveId !== 'string' || !objectiveId) throw new TypeError('Project and objective identity are required');
    if (!Array.isArray(roles) || !roles.length || roles.some((role) => typeof role !== 'string' || !role) || new Set(roles).size !== roles.length) throw new TypeError('A finite unique role subset is required');
    if (!['shared', 'isolated'].includes(writerMode)) throw new TypeError('writerMode must be shared or isolated');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new TypeError('Lease and poll intervals must be positive integers');
    if (maxActiveTurns !== undefined && (!Number.isSafeInteger(maxActiveTurns) || maxActiveTurns < 1)) throw new TypeError('maxActiveTurns must be positive');
    if (plannerReservedSlots !== undefined && (!Number.isSafeInteger(plannerReservedSlots) || plannerReservedSlots < 0)) throw new TypeError('plannerReservedSlots must be non-negative');
    if (roleLimits !== undefined && (!roleLimits || typeof roleLimits !== 'object' || Array.isArray(roleLimits)
      || Object.entries(roleLimits).some(([role, limit]) => !role || !Number.isSafeInteger(limit) || limit < 0))) throw new TypeError('roleLimits must contain non-negative integers');
    if (typeof isFrozenReview !== 'function' || (admissionPolicy !== undefined && typeof admissionPolicy !== 'function')) throw new TypeError('Admission policies must be functions');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.store = store;
    this.executor = executor;
    this.projectId = projectId;
    this.objectiveId = objectiveId;
    this.roles = new Set(roles);
    this.roleLimits = roleLimits || {};
    this.writerMode = writerMode;
    this.leaseMs = leaseMs;
    this.pollIntervalMs = pollIntervalMs;
    this.maxActiveTurns = maxActiveTurns;
    this.plannerReservedSlots = plannerReservedSlots;
    this.isFrozenReview = isFrozenReview;
    this.now = now;
    this.admissionPolicy = admissionPolicy || (() => true);
    const current = store.getObjective(projectId, objectiveId);
    if (!current) throw Object.assign(new Error('objective_missing'), { code: 'objective_missing' });
    this.controllerIdentity = typeof controllerIdentity === 'function'
      ? controllerIdentity
      : () => controllerIdentity || { ownerGeneration: current.ownerGeneration, controlRevision: current.controlRevision };
    this.inFlight = new Map();
    this.parked = new Map();
    this.nextPollAt = new Map();
    this.lastAdmissionReasons = new Map();
    this.running = false;
    this.timer = null;
    this.runPromise = null;
    this.wakePending = false;
    this.lastIdle = { cause: IDLE.noReady, detail: 'not_started' };
  }

  start() {
    if (this.running) return this.projection();
    this.running = true;
    this.wake();
    return this.projection();
  }

  wake() {
    if (!this.running) return;
    if (this.runPromise) { this.wakePending = true; return; }
    queueMicrotask(() => {
      if (!this.running) return;
      if (this.runPromise) { this.wakePending = true; return; }
      this.runOnce().catch((error) => { this.lastIdle = { cause: IDLE.recovery, detail: error.code || error.message }; });
    });
  }

  async runOnce() {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.#runOnce();
    try { return await this.runPromise; } finally {
      this.runPromise = null;
      if (this.running && this.wakePending) { this.wakePending = false; this.wake(); }
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.projection();
  }

  projection() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    const capacity = this.store.projectCapacity(this.projectId, this.objectiveId);
    return {
      projectId: this.projectId, objectiveId: this.objectiveId,
      running: this.running, inFlight: [...this.inFlight.keys()], parked: [...this.parked.entries()].map(([attemptId, reason]) => ({ attemptId, reason })),
      capacity, idle: copy(this.lastIdle), disposition: objective?.disposition || 'missing',
      admissionReasons: Object.fromEntries(this.lastAdmissionReasons),
    };
  }

  async #runOnce() {
    const objective = this.store.getObjective(this.projectId, this.objectiveId);
    if (!objective) return this.#idle(IDLE.recovery, 'objective_missing');
    const identity = this.controllerIdentity();
    if (!identity || identity.ownerGeneration !== objective.ownerGeneration) return this.#idle(IDLE.recovery, 'owner_generation_changed');

    const attempts = this.store.listAttempts(this.projectId, this.objectiveId);
    const claims = this.store.listClaims(this.projectId, this.objectiveId).filter((claim) => ['active', 'expired', 'fenced'].includes(claim.state));
    const byAttempt = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
    const admissionOpen = !NO_CLAIM_STATES.has(objective.disposition) && identity.controlRevision === objective.controlRevision;
    for (const claim of claims) {
      const attempt = byAttempt.get(claim.attemptId);
      if (!attempt || this.inFlight.has(attempt.attemptId) || this.parked.has(attempt.attemptId)) continue;
      const intent = this.executor.getAttempt(attempt.attemptId);
      if (!intent && !admissionOpen) continue;
      if (intent?.state === 'uncertain') {
        this.parked.set(attempt.attemptId, 'trusted_recovery_required');
        continue;
      }
      if (intent?.state === 'submitted' && (this.nextPollAt.get(attempt.attemptId) || 0) > this.now()) continue;
      this.#launchAttempt(attempt, claim, identity, intent);
    }

    if (NO_CLAIM_STATES.has(objective.disposition)) return this.#idle(IDLE.pause, objective.disposition);
    if (identity.controlRevision !== objective.controlRevision) return this.#idle(IDLE.pause, 'control_revision_changed');

    const capacity = this.store.projectCapacity(this.projectId, this.objectiveId);
    const projectCeiling = Math.min(
      capacity.workerLimit,
      (this.maxActiveTurns === undefined ? capacity.maxActiveTurns : this.maxActiveTurns) - (this.plannerReservedSlots ?? capacity.plannerReservedSlots),
    );
    const projectLimit = Math.max(0, projectCeiling);
    const open = Math.max(0, projectLimit - capacity.active);
    if (!open) return this.#idle(IDLE.capacity, 'project_or_lead_reservation_full');
    const runtimeWorkerCeiling = projectLimit;
    this.lastAdmissionReasons.clear();

    const limit = Math.min(open, 50);
    const controllerIdentity = identity;
    let eligibleClaims;
    try {
      eligibleClaims = this.store.claimReady(this.projectId, this.objectiveId, identity.ownerGeneration, {
        leaseMs: this.leaseMs,
        limit,
        controlRevision: identity.controlRevision,
        canClaim: (candidate, live) => {
          if (live.length >= runtimeWorkerCeiling) { this.lastAdmissionReasons.set(candidate.taskId, IDLE.capacity); return false; }
          if (!this.roles.has(candidate.role)) { this.lastAdmissionReasons.set(candidate.taskId, IDLE.role); return false; }
          const roleLimit = this.roleLimits[candidate.role] ?? objective.roleCapacities[candidate.role] ?? 0;
          if (live.filter((entry) => entry.claim.role === candidate.role).length >= roleLimit) { this.lastAdmissionReasons.set(candidate.taskId, IDLE.capacity); return false; }
          const resources = resourceConflict(candidate, live, { writerMode: this.writerMode, isFrozenReview: this.isFrozenReview });
          if (!resources.eligible) {
            this.lastAdmissionReasons.set(candidate.taskId, resources.reason === 'dependency_conflict' ? IDLE.dependency : resources.reason);
            return false;
          }
          const policy = this.admissionPolicy(candidate, live, { objective: copy(objective), controllerIdentity });
          if (policy && typeof policy.then === 'function') throw Object.assign(new Error('admission_policy_must_be_synchronous'), { code: 'admission_policy_must_be_synchronous' });
          if (policy !== true && policy !== false) throw Object.assign(new Error('admission_policy_must_return_boolean'), { code: 'admission_policy_must_return_boolean' });
          if (policy !== true) {
            this.lastAdmissionReasons.set(candidate.taskId, IDLE.resourceConflict);
          }
          return policy;
        },
      });
    } catch (error) {
      return this.#idle(error.code === 'control_revision_stale' ? IDLE.pause : IDLE.recovery, error.code || error.message);
    }
    for (const item of eligibleClaims) this.#launchAttempt(item.attempt, item.claim, identity, null);
    if (!eligibleClaims.length) {
      const reasons = [...this.lastAdmissionReasons.values()];
      const cause = reasons.includes(IDLE.reviewBarrier) ? IDLE.reviewBarrier
        : reasons.includes(IDLE.writeConflict) ? IDLE.writeConflict
          : reasons.includes(IDLE.readConflict) ? IDLE.readConflict
            : reasons.includes(IDLE.resourceConflict) ? IDLE.resourceConflict
              : reasons.includes(IDLE.dependency) ? IDLE.dependency
                  : reasons.includes(IDLE.role) ? IDLE.role
                    : reasons.includes(IDLE.capacity) ? IDLE.capacity : IDLE.noReady;
      const dependencyBlocked = !reasons.length && this.#hasDependencyWork();
      return this.#idle(dependencyBlocked ? IDLE.dependency : cause, reasons.length ? 'all_ready_tasks_ineligible' : dependencyBlocked ? 'dependency_or_checkpoint_unmet' : 'no_eligible_task');
    }
    this.lastIdle = { cause: null, detail: null, claimed: eligibleClaims.map((item) => item.task.taskId) };
    return this.projection();
  }

  #launchAttempt(attempt, claim, identity, intent) {
    const id = attempt.attemptId;
    const executionIdentity = {
      projectId: this.projectId, objectiveId: this.objectiveId, taskId: attempt.taskId,
      attemptId: id, fencingToken: claim.fencingToken,
      ...(attempt.state === 'unknown' && identity.ownerGeneration !== claim.ownerGeneration ? { recoveryGeneration: identity.ownerGeneration } : {}),
    };
    const work = intent?.state === 'submitted' ? this.executor.poll(executionIdentity)
      : intent ? this.executor.reconcile(executionIdentity)
        : this.executor.execute(executionIdentity);
    const promise = Promise.resolve(work).then((result) => {
      if (result?.state === 'submitted') this.nextPollAt.set(id, this.now() + this.pollIntervalMs);
      else if (result?.state === 'unknown') this.parked.set(id, result.reason || 'trusted_recovery_required');
      else { this.nextPollAt.delete(id); this.parked.delete(id); this.wake(); }
      return result;
    }, (error) => {
      this.parked.set(id, error.code || error.message || 'attempt_error');
      this.lastIdle = { cause: IDLE.recovery, detail: error.code || error.message || 'attempt_error', attemptId: id };
      return { state: 'error', code: error.code || null, message: error.message };
    }).finally(() => {
      if (this.inFlight.get(id) === promise) this.inFlight.delete(id);
      if (this.running && this.nextPollAt.has(id)) this.#schedulePoll();
      if (this.running && !this.parked.has(id)) this.wake();
    });
    this.inFlight.set(id, promise);
    return promise;
  }

  #schedulePoll() {
    if (this.timer || !this.running) return;
    const next = Math.min(...this.nextPollAt.values());
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const [attemptId, at] of this.nextPollAt) if (at <= this.now()) this.nextPollAt.set(attemptId, 0);
      this.wake();
    }, Math.max(1, next - this.now()));
    this.timer.unref?.();
  }

  #hasDependencyWork() {
    for (const state of ['queued', 'ready']) {
      let afterCursor;
      do {
        const page = this.store.projectBacklog(this.projectId, { objectiveId: this.objectiveId, state, afterCursor, limit: 500 });
        if (page.items.some((task) => task.dependencies.length > 0)) return true;
        afterCursor = page.nextCursor;
      } while (afterCursor);
    }
    return false;
  }

  #idle(cause, detail) { this.lastIdle = { cause, detail }; return this.projection(); }
}

module.exports = { TaskScheduler, IDLE };
