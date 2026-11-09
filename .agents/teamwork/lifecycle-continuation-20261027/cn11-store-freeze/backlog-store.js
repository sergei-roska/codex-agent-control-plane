'use strict';

const crypto = require('node:crypto');
const { createHash } = crypto;
const {
  VERSION, validateObjective, validateTask, validateClaim, validateAttempt,
  validateDependencyGraph, validatePlanDelta,
} = require('./delivery-contracts');
const { DeliveryEvents } = require('./delivery-events');

const LIVE_CLAIM_STATES = ['active', 'expired', 'fenced'];
const NO_CLAIM_OBJECTIVE_STATES = new Set(['draining', 'paused_owner', 'waiting_budget', 'waiting_owner', 'recovering', 'blocked_technical', 'validating', 'accepted', 'partial', 'canceled']);
const DEFAULT_DIGEST = `sha256:${'0'.repeat(64)}`;
const LIFECYCLE_CONTROL_CAUSES = new Set(['active', 'owner_pause', 'owner_stop', 'owner_cancel', 'budget_wait', 'blocked_technical']);
const LIFECYCLE_RETRY_KINDS = new Set(['transient', 'planner_invalid', 'executor_error']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
const encode = (value) => JSON.stringify(value);
const decode = (value) => JSON.parse(value);
const stableDigest = (value) => `sha256:${createHash('sha256').update(encode(value)).digest('hex')}`;
const defaultId = (kind, identity) => `${kind}-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;

function recordError(code, message = code) { const error = new Error(message); error.code = code; return error; }
function exactRecord(value, fields, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw recordError(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) throw recordError(code);
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw recordError(code);
    result[field] = descriptor.value;
  }
  return result;
}
function boundedIdentity(value, code, max = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x20\x7f]/.test(value)) throw recordError(code);
  return value;
}

class BacklogStore {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('A better-sqlite3 database is required');
    this.db = db;
    this.now = options.now || (() => Date.now());
    this.idFactory = options.idFactory || ((kind, identity) => defaultId(kind, identity));
    this.contextFactory = options.contextFactory || ((attemptId) => {
      const hex = createHash('sha256').update(attemptId).digest('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    });
    this.checkpointAccepted = options.checkpointAccepted || (() => false);
    if (options.ownerCorrectionAuthorized !== undefined && typeof options.ownerCorrectionAuthorized !== 'function') throw new TypeError('ownerCorrectionAuthorized must be a function');
    if (options.checkpointInventory !== undefined && typeof options.checkpointInventory !== 'function') throw new TypeError('checkpointInventory must be a function');
    this.ownerCorrectionAuthorized = options.ownerCorrectionAuthorized || (() => false);
    this.checkpointInventory = options.checkpointInventory || null;
    this.selectedSettingsResolver = options.selectedSettingsResolver || null;
    this.isOutputTrusted = options.isOutputTrusted || (({ task, attempt, dependency }) => {
      if (!attempt || attempt.state !== 'succeeded' || !attempt.outcome || attempt.outcome.trusted !== true) return false;
      if (dependency.expectedOutput !== undefined) return encode(attempt.outcome.outputContract) === encode(dependency.expectedOutput);
      return task.outputContract === undefined || encode(attempt.outcome.outputContract) === encode(task.outputContract);
    });
    this.maxActiveTurns = options.maxActiveTurns ?? 12;
    this.plannerReservedSlots = options.plannerReservedSlots ?? 1;
    this.roleCapacities = options.roleCapacities || { engineer: 4, explorer: 2, verifier: 2, auditor: 2, coordinator: 1 };
    this.maxLifecycleStrategies = options.maxLifecycleStrategies ?? 2;
    if (!Number.isSafeInteger(this.maxLifecycleStrategies) || this.maxLifecycleStrategies < 1 || this.maxLifecycleStrategies > 8) throw new TypeError('maxLifecycleStrategies must be between one and eight');
    this.events = options.events || new DeliveryEvents(db, { now: this.now, idFactory: this.idFactory, beforeInsert: options.beforeEventInsert });
    db.exec(`
      CREATE TABLE IF NOT EXISTS backlog_objectives (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, record_json TEXT NOT NULL,
        plan_revision INTEGER NOT NULL DEFAULT 0, capacities_json TEXT NOT NULL,
        max_active_turns INTEGER NOT NULL, planner_reserved_slots INTEGER NOT NULL,
        next_fence INTEGER NOT NULL DEFAULT 1, owner_generation INTEGER NOT NULL DEFAULT 0,
        checkpoints_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(project_id, objective_id)
      );
      CREATE TABLE IF NOT EXISTS backlog_project_capacity (
        project_id TEXT PRIMARY KEY, capacities_json TEXT NOT NULL,
        max_active_turns INTEGER NOT NULL, planner_reserved_slots INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backlog_owner_corrections (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
        correction_json TEXT NOT NULL, PRIMARY KEY(project_id, objective_id, source_message_id)
      );
      CREATE TABLE IF NOT EXISTS backlog_tasks (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, task_id TEXT NOT NULL,
        revision INTEGER NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL,
        role TEXT NOT NULL, contract_json TEXT NOT NULL, created_seq INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS backlog_tasks_page_idx ON backlog_tasks(project_id, objective_id, task_id);
      CREATE TABLE IF NOT EXISTS backlog_attempts (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, record_json TEXT NOT NULL, contract_json TEXT NOT NULL,
        terminal_digest TEXT, release_facts_json TEXT, PRIMARY KEY(project_id, objective_id, attempt_id),
        UNIQUE(project_id, objective_id, task_id, attempt_no)
      );
      CREATE TABLE IF NOT EXISTS backlog_claims (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, claim_id TEXT NOT NULL,
        task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, role TEXT NOT NULL,
        fencing_token INTEGER NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(project_id, objective_id, claim_id), UNIQUE(project_id, objective_id, task_id, fencing_token)
      );
      CREATE INDEX IF NOT EXISTS backlog_claims_live_idx ON backlog_claims(project_id, objective_id, role);
      CREATE TABLE IF NOT EXISTS backlog_lifecycle_controls (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, owner_generation INTEGER NOT NULL,
        control_revision INTEGER NOT NULL, cause TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id)
      );
      CREATE TABLE IF NOT EXISTS backlog_budget_waits (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, wait_id TEXT NOT NULL,
        state TEXT NOT NULL, control_revision INTEGER NOT NULL, owner_generation INTEGER NOT NULL,
        next_wake_at INTEGER NOT NULL, record_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id, wait_id)
      );
      CREATE TABLE IF NOT EXISTS backlog_lifecycle_retries (
        project_id TEXT NOT NULL, objective_id TEXT NOT NULL, retry_id TEXT NOT NULL,
        state TEXT NOT NULL, attempt INTEGER NOT NULL, next_wake_at INTEGER NOT NULL,
        record_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, objective_id, retry_id)
      );
      CREATE INDEX IF NOT EXISTS backlog_lifecycle_retries_due_idx
        ON backlog_lifecycle_retries(project_id, objective_id, state, next_wake_at);
    `);
  }

  createObjective(input, options = {}) {
    const objective = validateObjective({ schemaVersion: VERSION, ...input, createdAt: input.createdAt ?? this.now(), updatedAt: input.updatedAt ?? this.now() });
    const capacities = options.roleCapacities || this.roleCapacities;
    const maxActiveTurns = options.maxActiveTurns ?? this.maxActiveTurns;
    const plannerReservedSlots = options.plannerReservedSlots ?? this.plannerReservedSlots;
    this.#positiveIntegerMap(capacities);
    if (!Number.isSafeInteger(maxActiveTurns) || maxActiveTurns < 1 || !Number.isSafeInteger(plannerReservedSlots) || plannerReservedSlots < 0 || plannerReservedSlots >= maxActiveTurns) throw new TypeError('Invalid project capacity');
    const checkpoints = this.#normalizeCheckpoints(options.checkpoints === undefined ? [] : options.checkpoints, objective.projectId, objective.objectiveId);
    const tx = this.db.transaction(() => {
      const projectCapacity = this.db.prepare('SELECT capacities_json,max_active_turns,planner_reserved_slots FROM backlog_project_capacity WHERE project_id=?').get(objective.projectId);
      if (projectCapacity && (projectCapacity.capacities_json !== encode(capacities) || projectCapacity.max_active_turns !== maxActiveTurns || projectCapacity.planner_reserved_slots !== plannerReservedSlots)) throw recordError('project_capacity_configuration_conflict');
      this.db.prepare('INSERT OR IGNORE INTO backlog_project_capacity(project_id,capacities_json,max_active_turns,planner_reserved_slots) VALUES(?,?,?,?)').run(objective.projectId, encode(capacities), maxActiveTurns, plannerReservedSlots);
      this.db.prepare(`INSERT INTO backlog_objectives(project_id, objective_id, record_json, plan_revision, capacities_json, max_active_turns, planner_reserved_slots, checkpoints_json)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?)`).run(objective.projectId, objective.objectiveId, encode(objective), encode(capacities), maxActiveTurns, plannerReservedSlots, encode(checkpoints));
      const initialCause = objective.disposition === 'canceled' ? 'owner_cancel'
        : objective.disposition === 'paused_owner' ? 'owner_pause'
          : objective.disposition === 'waiting_budget' ? 'budget_wait'
            : objective.disposition === 'blocked_technical' ? 'blocked_technical' : 'active';
      this.#saveLifecycleControl(objective.projectId, objective.objectiveId, objective.ownerGeneration ?? 0, objective.controlRevision, initialCause);
      this.events.appendInTransaction(objective.projectId, { eventType: 'objective.created', objectRevision: 1, payload: { objectiveId: objective.objectiveId }, dedupeKey: `objective:${objective.objectiveId}:created` });
      return this.getObjective(objective.projectId, objective.objectiveId);
    });
    return tx.immediate();
  }

  getObjective(projectId, objectiveId) {
    const row = this.#objectiveRow(projectId, objectiveId);
    if (!row) return null;
    const record = decode(row.record_json);
    const checkpoints = this.#currentCheckpoints(projectId, objectiveId, decode(row.checkpoints_json));
    return { ...record, planRevision: row.plan_revision, ownerGeneration: row.owner_generation, maxActiveTurns: row.max_active_turns, plannerReservedSlots: row.planner_reserved_slots, roleCapacities: decode(row.capacities_json), checkpoints, tasks: this.#tasks(projectId, objectiveId), dependencies: this.#dependencies(projectId, objectiveId) };
  }

  applyOwnerCorrection(projectId, objectiveId, correction) {
    const normalized = this.#normalizeOwnerCorrection(correction);
    const tx = this.db.transaction(() => {
      const authorization = this.ownerCorrectionAuthorized(deepFreeze({ projectId, objectiveId, sourceMessageId: normalized.sourceMessageId, correction: clone(normalized) }));
      if (authorization && typeof authorization.then === 'function') throw recordError('owner_correction_authorization_async');
      if (authorization !== true) throw recordError('owner_correction_unauthorized');

      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      const prior = this.db.prepare('SELECT correction_json FROM backlog_owner_corrections WHERE project_id=? AND objective_id=? AND source_message_id=?')
        .get(projectId, objectiveId, normalized.sourceMessageId);
      if (prior) {
        if (prior.correction_json !== encode(normalized)) throw recordError('owner_correction_source_conflict');
        return this.getObjective(projectId, objectiveId);
      }

      const current = decode(row.record_json);
      validateObjective({ ...current, sessionId: normalized.sourceMessageId, requirementDigest: normalized.requirementDigest });
      if (['accepted', 'partial', 'canceled'].includes(current.disposition)) throw recordError('owner_correction_terminal_objective');
      if (normalized.expectedGoalRevision !== current.goalRevision || normalized.expectedAuthorityRevision !== current.authorityRevision || normalized.expectedControlRevision !== current.controlRevision) throw recordError('owner_correction_revision_stale');

      const nextObjective = validateObjective({
        ...current,
        requirementDigest: normalized.requirementDigest,
        goalRevision: current.goalRevision + 1,
        controlRevision: current.controlRevision + 1,
        disposition: current.disposition === 'validating' ? 'planning' : current.disposition,
        updatedAt: this.now(),
      });
      const changedTasks = this.db.prepare(`SELECT contract_json FROM backlog_tasks
        WHERE project_id=? AND objective_id=? AND state IN ('draft','queued','ready') ORDER BY task_id`).all(projectId, objectiveId).map((item) => decode(item.contract_json));
      const block = this.db.prepare(`UPDATE backlog_tasks SET state='blocked', contract_json=?
        WHERE project_id=? AND objective_id=? AND task_id=?`);
      for (const task of changedTasks) {
        task.state = 'blocked';
        task.blockedReason = 'owner_correction_replan_required';
        block.run(encode(validateTask(task)), projectId, objectiveId, task.taskId);
      }
      this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(nextObjective), projectId, objectiveId);
      const lifecycle = this.getLifecycleControl(projectId, objectiveId);
      this.#saveLifecycleControl(projectId, objectiveId, row.owner_generation, nextObjective.controlRevision, lifecycle?.cause || 'active');
      this.events.appendInTransaction(projectId, {
        eventType: 'objective.owner_correction',
        objectRevision: nextObjective.controlRevision,
        payload: { objectiveId, sourceMessageId: normalized.sourceMessageId, goalRevision: nextObjective.goalRevision, controlRevision: nextObjective.controlRevision, blockedTaskCount: changedTasks.length },
        dedupeKey: `owner-correction:${stableDigest([projectId, objectiveId, normalized.sourceMessageId])}`,
      });
      this.db.prepare('INSERT INTO backlog_owner_corrections(project_id,objective_id,source_message_id,correction_json) VALUES(?,?,?,?)')
        .run(projectId, objectiveId, normalized.sourceMessageId, encode(normalized));
      return this.getObjective(projectId, objectiveId);
    });
    return tx.immediate();
  }

  applyPlan(projectId, objectiveId, delta) {
    const tx = this.db.transaction(() => {
      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      const current = this.getObjective(projectId, objectiveId);
      if (['accepted', 'partial', 'canceled'].includes(current.disposition)) throw recordError('plan_objective_terminal');
      const normalized = validatePlanDelta(current, delta);
      const byId = new Map(current.tasks.map((task) => [task.taskId, task]));
      const changes = new Map(normalized.tasks.map((task) => [task.taskId, task]));
      for (const task of normalized.tasks) {
        if (!byId.has(task.taskId) && task.supersedesTaskId) {
          const prior = byId.get(task.supersedesTaskId);
          if (prior) changes.set(prior.taskId, { ...prior, state: 'superseded' });
        }
      }
      for (const task of normalized.tasks) changes.set(task.taskId, { ...task });
      for (const [taskId, task] of changes) {
        const dependencyUpdates = normalized.dependencies.filter((dep) => dep.successorTaskId === taskId).map(({ schemaVersion, ...dep }) => dep);
        if (dependencyUpdates.length) task.dependencies = task.dependencies.filter((dep) => !dependencyUpdates.some((next) => next.predecessorType === dep.predecessorType && next.predecessorId === dep.predecessorId && next.kind === dep.kind)).concat(dependencyUpdates);
      }
      const resulting = [...byId.values()].map((task) => changes.get(task.taskId) || task).concat([...changes.values()].filter((task) => !byId.has(task.taskId)));
      // validatePlanDelta validates the merged graph; validate once more after applying the normalized projection.
      validateDependencyGraph(resulting, current.checkpoints || []);
      const put = this.db.prepare(`INSERT INTO backlog_tasks(project_id, objective_id, task_id, revision, state, priority, role, contract_json, created_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, objective_id, task_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,priority=excluded.priority,role=excluded.role,contract_json=excluded.contract_json`);
      for (const task of changes.values()) put.run(projectId, objectiveId, task.taskId, task.revision, task.state, task.priority, task.role, encode(task), normalized.nextPlanRevision);
      this.db.prepare('UPDATE backlog_objectives SET plan_revision = ? WHERE project_id = ? AND objective_id = ?').run(normalized.nextPlanRevision, projectId, objectiveId);
      this.events.appendInTransaction(projectId, { eventType: 'plan.applied', objectRevision: normalized.nextPlanRevision, payload: { objectiveId, changedTaskIds: [...changes.keys()].sort() }, dedupeKey: `plan:${objectiveId}:${normalized.nextPlanRevision}` });
      return this.getObjective(projectId, objectiveId);
    });
    return tx.immediate();
  }

  requestControl(projectId, objectiveId, action, expectedControlRevision) {
    if (!['pause', 'resume', 'cancel'].includes(action) || !Number.isSafeInteger(expectedControlRevision) || expectedControlRevision < 0) throw new TypeError('Invalid control request');
    const tx = this.db.transaction(() => this.#requestControl(projectId, objectiveId, action, expectedControlRevision));
    return tx.immediate();
  }

  transitionLifecycleControl(projectId, objectiveId, input) {
    const request = exactRecord(input, ['action', 'expectedControlRevision', 'expectedOwnerGeneration'], 'lifecycle_control_fields_invalid');
    if (!['pause', 'stop', 'resume', 'cancel'].includes(request.action)
      || !Number.isSafeInteger(request.expectedControlRevision) || request.expectedControlRevision < 0
      || !Number.isSafeInteger(request.expectedOwnerGeneration) || request.expectedOwnerGeneration < 0) throw recordError('lifecycle_control_invalid');
    const tx = this.db.transaction(() => {
      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      if (row.owner_generation !== request.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const objective = decode(row.record_json);
      if (objective.controlRevision !== request.expectedControlRevision) throw recordError('control_revision_stale');
      const control = this.getLifecycleControl(projectId, objectiveId);
      if (request.action === 'resume' && !['owner_pause', 'owner_stop'].includes(control?.cause || 'owner_pause')) throw recordError('control_transition_invalid');
      const action = request.action === 'stop' ? 'pause' : request.action;
      const updated = this.#requestControl(projectId, objectiveId, action, request.expectedControlRevision);
      const cause = request.action === 'stop' ? 'owner_stop'
        : request.action === 'pause' ? 'owner_pause'
          : request.action === 'cancel' ? 'owner_cancel' : 'active';
      this.#saveLifecycleControl(projectId, objectiveId, request.expectedOwnerGeneration, updated.controlRevision, cause);
      if (request.action === 'stop') {
        this.events.appendInTransaction(projectId, { eventType: 'objective.owner_stopped', objectRevision: updated.controlRevision,
          payload: { objectiveId, controlRevision: updated.controlRevision, ownerGeneration: request.expectedOwnerGeneration },
          dedupeKey: `objective:${objectiveId}:owner-stop:${updated.controlRevision}` });
      }
      return this.getObjective(projectId, objectiveId);
    });
    return tx.immediate();
  }

  getLifecycleControl(projectId, objectiveId) {
    const row = this.db.prepare('SELECT owner_generation,control_revision,cause,updated_at FROM backlog_lifecycle_controls WHERE project_id=? AND objective_id=?').get(projectId, objectiveId);
    if (!row) {
      const objective = this.getObjective(projectId, objectiveId);
      if (!objective) return null;
      const cause = objective.disposition === 'canceled' ? 'owner_cancel'
        : objective.disposition === 'paused_owner' ? 'owner_pause'
          : objective.disposition === 'waiting_budget' ? 'budget_wait'
            : objective.disposition === 'blocked_technical' ? 'blocked_technical' : 'active';
      return { ownerGeneration: objective.ownerGeneration, controlRevision: objective.controlRevision, cause, updatedAt: objective.updatedAt };
    }
    return { ownerGeneration: row.owner_generation, controlRevision: row.control_revision, cause: row.cause, updatedAt: row.updated_at };
  }

  recordBudgetWait(projectId, objectiveId, input) {
    const wait = exactRecord(input, ['waitId', 'source', 'provider', 'model', 'reasonCode', 'nextWakeAt', 'expectedControlRevision', 'expectedOwnerGeneration'], 'budget_wait_fields_invalid');
    boundedIdentity(wait.waitId, 'budget_wait_id_invalid');
    boundedIdentity(wait.source, 'budget_wait_source_invalid', 80);
    boundedIdentity(wait.provider, 'budget_wait_provider_invalid', 128);
    boundedIdentity(wait.model, 'budget_wait_model_invalid', 128);
    if (typeof wait.reasonCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(wait.reasonCode)) throw recordError('budget_wait_reason_invalid');
    if (!Number.isSafeInteger(wait.nextWakeAt) || wait.nextWakeAt < 0
      || !Number.isSafeInteger(wait.expectedControlRevision) || wait.expectedControlRevision < 0
      || !Number.isSafeInteger(wait.expectedOwnerGeneration) || wait.expectedOwnerGeneration < 0) throw recordError('budget_wait_time_invalid');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      if (objective.controlRevision !== wait.expectedControlRevision) throw recordError('control_revision_stale');
      if (objectiveRow.owner_generation !== wait.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const prior = this.db.prepare('SELECT record_json FROM backlog_budget_waits WHERE project_id=? AND objective_id=? AND wait_id=?').get(projectId, objectiveId, wait.waitId);
      if (prior) {
        const saved = decode(prior.record_json);
        if (['waitId', 'source', 'provider', 'model', 'reasonCode', 'nextWakeAt'].some((key) => saved[key] !== wait[key])
          || saved.controlRevision !== wait.expectedControlRevision || saved.ownerGeneration !== wait.expectedOwnerGeneration) throw recordError('budget_wait_conflict');
        return saved;
      }
      if (!['planning', 'executing'].includes(objective.disposition)) throw recordError('budget_wait_controlled');
      const record = { ...wait, projectId, objectiveId, controlRevision: objective.controlRevision,
        ownerGeneration: objectiveRow.owner_generation, resumeDisposition: objective.disposition,
        state: 'waiting', createdAt: this.now(), updatedAt: this.now() };
      delete record.expectedControlRevision;
      delete record.expectedOwnerGeneration;
      const next = validateObjective({ ...objective, disposition: 'waiting_budget', updatedAt: this.now() });
      this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(next), projectId, objectiveId);
      this.#saveLifecycleControl(projectId, objectiveId, objectiveRow.owner_generation, objective.controlRevision, 'budget_wait');
      this.db.prepare(`INSERT INTO backlog_budget_waits(project_id,objective_id,wait_id,state,control_revision,owner_generation,next_wake_at,record_json,created_at,updated_at)
        VALUES(?,?,?,'waiting',?,?,?,?,?,?)`).run(projectId, objectiveId, wait.waitId, objective.controlRevision, objectiveRow.owner_generation, wait.nextWakeAt, encode(record), record.createdAt, record.updatedAt);
      this.events.appendInTransaction(projectId, { eventType: 'objective.waiting_budget', objectRevision: objective.controlRevision,
        payload: { objectiveId, waitId: wait.waitId, source: wait.source, provider: wait.provider, model: wait.model, nextWakeAt: wait.nextWakeAt },
        dedupeKey: `objective:${objectiveId}:budget-wait:${wait.waitId}` });
      return record;
    });
    return tx.immediate();
  }

  listBudgetWaits(projectId, objectiveId) {
    return this.db.prepare('SELECT record_json FROM backlog_budget_waits WHERE project_id=? AND objective_id=? ORDER BY created_at,wait_id').all(projectId, objectiveId).map((row) => decode(row.record_json));
  }

  wakeBudgetWait(projectId, objectiveId, waitId, pins) {
    const expected = exactRecord(pins, ['expectedControlRevision', 'expectedOwnerGeneration'], 'budget_wake_pins_invalid');
    boundedIdentity(waitId, 'budget_wait_id_invalid');
    if (!Number.isSafeInteger(expected.expectedControlRevision) || expected.expectedControlRevision < 0
      || !Number.isSafeInteger(expected.expectedOwnerGeneration) || expected.expectedOwnerGeneration < 0) throw recordError('budget_wake_pins_invalid');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      const row = this.db.prepare('SELECT state,record_json FROM backlog_budget_waits WHERE project_id=? AND objective_id=? AND wait_id=?').get(projectId, objectiveId, waitId);
      if (!row) throw recordError('budget_wait_missing');
      const record = decode(row.record_json);
      if (row.state !== 'waiting') throw recordError('budget_wait_not_pending');
      if (record.nextWakeAt > this.now()) throw recordError('budget_wait_not_due');
      if (objective.controlRevision !== expected.expectedControlRevision || record.controlRevision !== expected.expectedControlRevision) throw recordError('control_revision_stale');
      if (objectiveRow.owner_generation !== expected.expectedOwnerGeneration || record.ownerGeneration !== expected.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      if (objective.disposition !== 'waiting_budget' || this.getLifecycleControl(projectId, objectiveId)?.cause !== 'budget_wait') throw recordError('budget_wait_controlled');
      const next = validateObjective({ ...objective, disposition: record.resumeDisposition, updatedAt: this.now() });
      this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(next), projectId, objectiveId);
      const updated = { ...record, state: 'woken', updatedAt: this.now() };
      this.db.prepare("UPDATE backlog_budget_waits SET state='woken',record_json=?,updated_at=? WHERE project_id=? AND objective_id=? AND wait_id=? AND state='waiting'")
        .run(encode(updated), updated.updatedAt, projectId, objectiveId, waitId);
      this.#saveLifecycleControl(projectId, objectiveId, objectiveRow.owner_generation, objective.controlRevision, 'active');
      this.events.appendInTransaction(projectId, { eventType: 'objective.budget_woken', objectRevision: objective.controlRevision,
        payload: { objectiveId, waitId }, dedupeKey: `objective:${objectiveId}:budget-wake:${waitId}` });
      return { objective: this.getObjective(projectId, objectiveId), wait: updated };
    });
    return tx.immediate();
  }

  recordLifecycleRetry(projectId, objectiveId, input) {
    const retry = exactRecord(input, ['retryId', 'kind', 'scopeType', 'scopeId', 'source', 'provider', 'model', 'hypothesisId', 'strategyId', 'failureCode', 'attempt', 'maxAttempts', 'nextWakeAt', 'expectedControlRevision', 'expectedOwnerGeneration'], 'lifecycle_retry_fields_invalid');
    for (const field of ['retryId', 'hypothesisId', 'strategyId']) boundedIdentity(retry[field], 'lifecycle_retry_identity_invalid');
    boundedIdentity(retry.scopeId, 'lifecycle_retry_scope_invalid');
    if (!['objective', 'task', 'checkpoint'].includes(retry.scopeType)
      || (retry.kind === 'planner_invalid' && retry.scopeType !== 'objective')
      || (retry.kind === 'executor_error' && retry.scopeType !== 'task')) throw recordError('lifecycle_retry_scope_kind_invalid');
    for (const field of ['source', 'provider', 'model']) boundedIdentity(retry[field], 'lifecycle_retry_source_invalid', 128);
    if (!LIFECYCLE_RETRY_KINDS.has(retry.kind) || typeof retry.failureCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(retry.failureCode)) throw recordError('lifecycle_retry_kind_invalid');
    if (!Number.isSafeInteger(retry.attempt) || retry.attempt < 1 || !Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 2
      || retry.attempt > retry.maxAttempts || !Number.isSafeInteger(retry.nextWakeAt) || retry.nextWakeAt < 0
      || !Number.isSafeInteger(retry.expectedControlRevision) || retry.expectedControlRevision < 0
      || !Number.isSafeInteger(retry.expectedOwnerGeneration) || retry.expectedOwnerGeneration < 0) throw recordError('lifecycle_retry_bounds_invalid');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      if (objective.controlRevision !== retry.expectedControlRevision) throw recordError('control_revision_stale');
      if (objectiveRow.owner_generation !== retry.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      if (!['planning', 'executing'].includes(objective.disposition)) throw recordError('lifecycle_retry_controlled');
      if (retry.scopeType === 'objective' && retry.scopeId !== objectiveId) throw recordError('lifecycle_retry_scope_mismatch');
      if (retry.scopeType === 'task' && !this.db.prepare('SELECT 1 FROM backlog_tasks WHERE project_id=? AND objective_id=? AND task_id=?').get(projectId, objectiveId, retry.scopeId)) {
        throw recordError('lifecycle_retry_scope_missing');
      }
      if (retry.scopeType === 'checkpoint' && !this.getObjective(projectId, objectiveId).checkpoints.some((checkpoint) => checkpoint.checkpointId === retry.scopeId)) {
        throw recordError('lifecycle_retry_scope_missing');
      }
      const prior = this.db.prepare('SELECT state,attempt,record_json FROM backlog_lifecycle_retries WHERE project_id=? AND objective_id=? AND retry_id=?').get(projectId, objectiveId, retry.retryId);
      const createdAt = prior ? decode(prior.record_json).createdAt : this.now();
      if (prior) {
        const old = decode(prior.record_json);
        const sameStrategy = ['kind', 'scopeType', 'scopeId', 'source', 'provider', 'model', 'hypothesisId', 'strategyId', 'maxAttempts'].every((field) => old[field] === retry[field]);
        if (!sameStrategy || prior.state !== 'due' || retry.attempt !== prior.attempt + 1) throw recordError('lifecycle_retry_transition_invalid');
      } else if (retry.attempt !== 1) throw recordError('lifecycle_retry_attempt_invalid');
      if (!prior) {
        const repeatedHypothesis = this.db.prepare(`SELECT retry_id FROM backlog_lifecycle_retries
          WHERE project_id=? AND objective_id=? AND json_extract(record_json,'$.scopeType')=? AND json_extract(record_json,'$.scopeId')=?
            AND json_extract(record_json,'$.hypothesisId')=? AND json_extract(record_json,'$.strategyId')=? LIMIT 1`)
          .get(projectId, objectiveId, retry.scopeType, retry.scopeId, retry.hypothesisId, retry.strategyId);
        if (repeatedHypothesis) throw recordError('lifecycle_retry_hypothesis_conflict');
      }
      const strategyCount = this.db.prepare(`SELECT COUNT(*) AS n FROM backlog_lifecycle_retries
        WHERE project_id=? AND objective_id=? AND json_extract(record_json,'$.scopeType')=? AND json_extract(record_json,'$.scopeId')=?`)
        .get(projectId, objectiveId, retry.scopeType, retry.scopeId).n + (prior ? 0 : 1);
      if (strategyCount > this.maxLifecycleStrategies) throw recordError('lifecycle_strategy_limit_exceeded');
      const exhausted = retry.attempt >= retry.maxAttempts;
      const blocked = exhausted && strategyCount >= this.maxLifecycleStrategies;
      const objectiveBlocked = blocked && !this.#hasPotentialTaskProgress(projectId, objectiveId);
      const record = { ...retry, projectId, objectiveId, controlRevision: retry.expectedControlRevision,
        ownerGeneration: objectiveRow.owner_generation, state: blocked ? 'blocked' : exhausted ? 'exhausted' : 'waiting',
        createdAt, updatedAt: this.now() };
      delete record.expectedControlRevision;
      delete record.expectedOwnerGeneration;
      this.db.prepare(`INSERT INTO backlog_lifecycle_retries(project_id,objective_id,retry_id,state,attempt,next_wake_at,record_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,objective_id,retry_id) DO UPDATE SET state=excluded.state,attempt=excluded.attempt,
        next_wake_at=excluded.next_wake_at,record_json=excluded.record_json,updated_at=excluded.updated_at`)
        .run(projectId, objectiveId, retry.retryId, record.state, retry.attempt, retry.nextWakeAt, encode(record), record.createdAt, record.updatedAt);
      if (objectiveBlocked) {
        const next = validateObjective({ ...objective, disposition: 'blocked_technical', updatedAt: this.now() });
        this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(next), projectId, objectiveId);
        this.#saveLifecycleControl(projectId, objectiveId, objectiveRow.owner_generation, objective.controlRevision, 'blocked_technical');
      }
      const eventType = objectiveBlocked ? 'objective.blocked_technical' : exhausted ? 'lifecycle.retry.exhausted' : 'lifecycle.retry.scheduled';
      this.events.appendInTransaction(projectId, { eventType, objectRevision: objective.controlRevision,
        payload: { objectiveId, retryId: retry.retryId, kind: retry.kind, source: retry.source, provider: retry.provider, model: retry.model,
          scopeType: retry.scopeType, scopeId: retry.scopeId, hypothesisId: retry.hypothesisId, strategyId: retry.strategyId, attempt: retry.attempt, maxAttempts: retry.maxAttempts,
          failureCode: retry.failureCode, nextWakeAt: retry.nextWakeAt },
        dedupeKey: `objective:${objectiveId}:retry:${retry.retryId}:${retry.attempt}` });
      return record;
    });
    return tx.immediate();
  }

  listLifecycleRetries(projectId, objectiveId) {
    return this.db.prepare('SELECT record_json FROM backlog_lifecycle_retries WHERE project_id=? AND objective_id=? ORDER BY created_at,retry_id').all(projectId, objectiveId).map((row) => decode(row.record_json));
  }

  wakeLifecycleRetry(projectId, objectiveId, retryId, pins) {
    const expected = exactRecord(pins, ['expectedControlRevision', 'expectedOwnerGeneration'], 'lifecycle_retry_pins_invalid');
    boundedIdentity(retryId, 'lifecycle_retry_identity_invalid');
    if (!Number.isSafeInteger(expected.expectedControlRevision) || expected.expectedControlRevision < 0
      || !Number.isSafeInteger(expected.expectedOwnerGeneration) || expected.expectedOwnerGeneration < 0) throw recordError('lifecycle_retry_pins_invalid');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      const row = this.db.prepare('SELECT state,record_json FROM backlog_lifecycle_retries WHERE project_id=? AND objective_id=? AND retry_id=?').get(projectId, objectiveId, retryId);
      if (!row) throw recordError('lifecycle_retry_missing');
      const record = decode(row.record_json);
      if (!['waiting', 'exhausted'].includes(row.state) || !['planning', 'executing'].includes(objective.disposition)) throw recordError('lifecycle_retry_controlled');
      if (record.nextWakeAt > this.now()) throw recordError('lifecycle_retry_not_due');
      if (objective.controlRevision !== expected.expectedControlRevision || record.controlRevision !== expected.expectedControlRevision) throw recordError('control_revision_stale');
      if (objectiveRow.owner_generation !== expected.expectedOwnerGeneration || record.ownerGeneration !== expected.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const strategyCount = this.db.prepare(`SELECT COUNT(*) AS n FROM backlog_lifecycle_retries
        WHERE project_id=? AND objective_id=? AND json_extract(record_json,'$.scopeType')=? AND json_extract(record_json,'$.scopeId')=?`)
        .get(projectId, objectiveId, record.scopeType, record.scopeId).n;
      const nextState = row.state === 'exhausted' && strategyCount < this.maxLifecycleStrategies ? 'strategy_due' : row.state === 'exhausted' ? 'blocked' : 'due';
      if (nextState === 'blocked') throw recordError('lifecycle_strategy_limit_exceeded');
      const updated = { ...record, state: nextState, updatedAt: this.now() };
      this.db.prepare('UPDATE backlog_lifecycle_retries SET state=?,record_json=?,updated_at=? WHERE project_id=? AND objective_id=? AND retry_id=? AND state=?')
        .run(nextState, encode(updated), updated.updatedAt, projectId, objectiveId, retryId, row.state);
      this.events.appendInTransaction(projectId, { eventType: nextState === 'due' ? 'lifecycle.retry.due' : 'lifecycle.retry.strategy_due', objectRevision: objective.controlRevision,
        payload: { objectiveId, retryId, hypothesisId: record.hypothesisId, strategyId: record.strategyId },
        dedupeKey: `objective:${objectiveId}:retry-due:${retryId}:${record.attempt}` });
      return updated;
    });
    return tx.immediate();
  }

  resolveLifecycleRetry(projectId, objectiveId, retryId, pins) {
    const expected = exactRecord(pins, ['expectedControlRevision', 'expectedOwnerGeneration'], 'lifecycle_retry_pins_invalid');
    const tx = this.db.transaction(() => {
      const objective = this.getObjective(projectId, objectiveId);
      if (!objective) throw recordError('objective_missing');
      if (objective.controlRevision !== expected.expectedControlRevision) throw recordError('control_revision_stale');
      if (objective.ownerGeneration !== expected.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const row = this.db.prepare("SELECT record_json FROM backlog_lifecycle_retries WHERE project_id=? AND objective_id=? AND retry_id=? AND state IN ('due','strategy_due')").get(projectId, objectiveId, retryId);
      if (!row) throw recordError('lifecycle_retry_not_due');
      const prior = decode(row.record_json);
      if (prior.controlRevision !== expected.expectedControlRevision || prior.ownerGeneration !== expected.expectedOwnerGeneration) throw recordError('control_revision_stale');
      const record = { ...prior, state: 'resolved', updatedAt: this.now() };
      this.db.prepare("UPDATE backlog_lifecycle_retries SET state='resolved',record_json=?,updated_at=? WHERE project_id=? AND objective_id=? AND retry_id=? AND state IN ('due','strategy_due')")
        .run(encode(record), record.updatedAt, projectId, objectiveId, retryId);
      this.events.appendInTransaction(projectId, { eventType: 'lifecycle.retry.resolved', objectRevision: objective.controlRevision,
        payload: { objectiveId, retryId, attempt: record.attempt }, dedupeKey: `objective:${objectiveId}:retry-resolved:${retryId}:${record.attempt}` });
      return record;
    });
    return tx.immediate();
  }

  blockLifecycleRetry(projectId, objectiveId, retryId, input) {
    const request = exactRecord(input, ['failureCode', 'expectedControlRevision', 'expectedOwnerGeneration'], 'lifecycle_retry_pins_invalid');
    boundedIdentity(retryId, 'lifecycle_retry_identity_invalid');
    if (typeof request.failureCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.failureCode)
      || !Number.isSafeInteger(request.expectedControlRevision) || request.expectedControlRevision < 0
      || !Number.isSafeInteger(request.expectedOwnerGeneration) || request.expectedOwnerGeneration < 0) throw recordError('lifecycle_retry_pins_invalid');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      if (objective.controlRevision !== request.expectedControlRevision) throw recordError('control_revision_stale');
      if (objectiveRow.owner_generation !== request.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const row = this.db.prepare('SELECT state,record_json FROM backlog_lifecycle_retries WHERE project_id=? AND objective_id=? AND retry_id=?')
        .get(projectId, objectiveId, retryId);
      if (!row) throw recordError('lifecycle_retry_missing');
      const prior = decode(row.record_json);
      if (prior.controlRevision !== request.expectedControlRevision || prior.ownerGeneration !== request.expectedOwnerGeneration) throw recordError('control_revision_stale');
      if (!['waiting', 'due', 'exhausted', 'strategy_due', 'blocked'].includes(row.state)) throw recordError('lifecycle_retry_not_blockable');
      if (row.state === 'blocked') return { retry: prior, state: objective.disposition === 'blocked_technical' ? 'blocked_technical' : 'blocked_retry', objective };
      const updated = { ...prior, state: 'blocked', blockReason: request.failureCode, updatedAt: this.now() };
      this.db.prepare("UPDATE backlog_lifecycle_retries SET state='blocked',record_json=?,updated_at=? WHERE project_id=? AND objective_id=? AND retry_id=? AND state=?")
        .run(encode(updated), updated.updatedAt, projectId, objectiveId, retryId, row.state);
      const objectiveBlocked = ['planning', 'executing'].includes(objective.disposition)
        && !this.#hasPotentialTaskProgress(projectId, objectiveId);
      let updatedObjective = objective;
      if (objectiveBlocked && !['accepted', 'partial', 'canceled'].includes(objective.disposition)) {
        updatedObjective = validateObjective({ ...objective, disposition: 'blocked_technical', updatedAt: this.now() });
        this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(updatedObjective), projectId, objectiveId);
        this.#saveLifecycleControl(projectId, objectiveId, objectiveRow.owner_generation, objective.controlRevision, 'blocked_technical');
        this.events.appendInTransaction(projectId, { eventType: 'objective.blocked_technical', objectRevision: objective.controlRevision,
          payload: { objectiveId, failureCode: request.failureCode }, dedupeKey: `objective:${objectiveId}:blocked-technical:${objective.controlRevision}:${request.failureCode}` });
      } else {
        this.events.appendInTransaction(projectId, { eventType: 'lifecycle.retry.blocked', objectRevision: objective.controlRevision,
          payload: { objectiveId, retryId, scopeType: prior.scopeType, scopeId: prior.scopeId, failureCode: request.failureCode },
          dedupeKey: `objective:${objectiveId}:retry-blocked:${retryId}` });
      }
      return { retry: updated, state: objectiveBlocked ? 'blocked_technical' : 'blocked_retry', objective: updatedObjective };
    });
    return tx.immediate();
  }

  blockTechnical(projectId, objectiveId, input) {
    const request = exactRecord(input, ['failureCode', 'expectedControlRevision', 'expectedOwnerGeneration'], 'blocked_technical_fields_invalid');
    if (typeof request.failureCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.failureCode)
      || !Number.isSafeInteger(request.expectedControlRevision) || request.expectedControlRevision < 0
      || !Number.isSafeInteger(request.expectedOwnerGeneration) || request.expectedOwnerGeneration < 0) throw recordError('blocked_technical_fields_invalid');
    const tx = this.db.transaction(() => {
      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      if (row.owner_generation !== request.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const objective = decode(row.record_json);
      if (objective.controlRevision !== request.expectedControlRevision) throw recordError('control_revision_stale');
      if (['accepted', 'partial', 'canceled'].includes(objective.disposition)) throw recordError('lifecycle_retry_terminal_objective');
      if (objective.disposition === 'blocked_technical') return this.getObjective(projectId, objectiveId);
      if (!['planning', 'executing'].includes(objective.disposition)) throw recordError('lifecycle_retry_controlled');
      const next = validateObjective({ ...objective, disposition: 'blocked_technical', updatedAt: this.now() });
      this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(next), projectId, objectiveId);
      this.#saveLifecycleControl(projectId, objectiveId, request.expectedOwnerGeneration, request.expectedControlRevision, 'blocked_technical');
      this.events.appendInTransaction(projectId, { eventType: 'objective.blocked_technical', objectRevision: objective.controlRevision,
        payload: { objectiveId, failureCode: request.failureCode }, dedupeKey: `objective:${objectiveId}:blocked-technical:${request.expectedControlRevision}:${request.failureCode}` });
      return this.getObjective(projectId, objectiveId);
    });
    return tx.immediate();
  }

  blockTechnicalIfNoProgress(projectId, objectiveId, input) {
    const request = exactRecord(input, ['failureCode', 'expectedControlRevision', 'expectedOwnerGeneration'], 'blocked_technical_fields_invalid');
    if (typeof request.failureCode !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.failureCode)
      || !Number.isSafeInteger(request.expectedControlRevision) || request.expectedControlRevision < 0
      || !Number.isSafeInteger(request.expectedOwnerGeneration) || request.expectedOwnerGeneration < 0) throw recordError('blocked_technical_fields_invalid');
    const tx = this.db.transaction(() => {
      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      if (row.owner_generation !== request.expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const objective = decode(row.record_json);
      if (objective.controlRevision !== request.expectedControlRevision) throw recordError('control_revision_stale');
      if (['accepted', 'partial', 'canceled'].includes(objective.disposition)) throw recordError('lifecycle_retry_terminal_objective');
      if (objective.disposition === 'blocked_technical') return { state: 'blocked_technical', objective };
      if (!['planning', 'executing'].includes(objective.disposition)) throw recordError('lifecycle_retry_controlled');
      if (this.#hasPotentialTaskProgress(projectId, objectiveId)) return { state: 'progress_available', objective };
      const next = validateObjective({ ...objective, disposition: 'blocked_technical', updatedAt: this.now() });
      this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(next), projectId, objectiveId);
      this.#saveLifecycleControl(projectId, objectiveId, request.expectedOwnerGeneration, request.expectedControlRevision, 'blocked_technical');
      this.events.appendInTransaction(projectId, { eventType: 'objective.blocked_technical', objectRevision: objective.controlRevision,
        payload: { objectiveId, failureCode: request.failureCode }, dedupeKey: `objective:${objectiveId}:blocked-technical:${request.expectedControlRevision}:${request.failureCode}` });
      return { state: 'blocked_technical', objective: this.getObjective(projectId, objectiveId) };
    });
    return tx.immediate();
  }

  requestLifecycleRecovery(projectId, objectiveId, ownerGeneration) {
    if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) throw recordError('owner_generation_invalid');
    const tx = this.db.transaction(() => {
      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      if (row.owner_generation !== ownerGeneration) throw recordError('owner_generation_stale');
      const claims = this.listClaims(projectId, objectiveId).filter((claim) => ['active', 'expired', 'fenced'].includes(claim.state));
      const requested = [];
      for (const claim of claims) {
        const attemptRow = this.#attemptRow(projectId, objectiveId, claim.attemptId);
        if (!attemptRow) continue;
        const attempt = decode(attemptRow.record_json);
        if (['succeeded', 'failed', 'canceled'].includes(attempt.state)) continue;
        if (claim.state === 'active') this.#saveClaim({ ...claim, state: 'expired' });
        if (attempt.state !== 'unknown') this.#saveAttempt({ ...attempt, state: 'unknown' });
        const task = this.#task(projectId, objectiveId, claim.taskId);
        if (!['settling', 'succeeded', 'failed', 'canceled'].includes(task.state)) this.#putTask({ ...task, state: 'settling' });
        const identity = { taskId: claim.taskId, attemptId: claim.attemptId, fencingToken: claim.fencingToken,
          claimOwnerGeneration: claim.ownerGeneration, recoveryGeneration: ownerGeneration };
        requested.push(identity);
        this.events.appendInTransaction(projectId, { eventType: 'attempt.recovery_requested', objectRevision: task.revision,
          taskId: task.taskId, attemptId: attempt.attemptId, payload: { objectiveId, fencingToken: claim.fencingToken,
            claimOwnerGeneration: claim.ownerGeneration, recoveryGeneration: ownerGeneration },
          dedupeKey: `attempt:${attempt.attemptId}:recovery-request:${ownerGeneration}` });
      }
      return requested;
    });
    return tx.immediate();
  }

  advanceOwnerGeneration(projectId, objectiveId, expectedOwnerGeneration) {
    if (!Number.isSafeInteger(expectedOwnerGeneration) || expectedOwnerGeneration < 0) throw new TypeError('Invalid owner generation');
    const tx = this.db.transaction(() => {
      const row = this.#objectiveRow(projectId, objectiveId);
      if (!row) throw recordError('objective_missing');
      if (row.owner_generation !== expectedOwnerGeneration) throw recordError('owner_generation_stale');
      const next = expectedOwnerGeneration + 1;
      this.db.prepare('UPDATE backlog_objectives SET owner_generation=? WHERE project_id=? AND objective_id=?').run(next, projectId, objectiveId);
      const control = this.getLifecycleControl(projectId, objectiveId);
      this.#saveLifecycleControl(projectId, objectiveId, next, control?.controlRevision ?? this.getObjective(projectId, objectiveId).controlRevision, control?.cause || 'active');
      this.events.appendInTransaction(projectId, { eventType: 'controller.generation_advanced', objectRevision: next, payload: { objectiveId, ownerGeneration: next }, dedupeKey: `controller:${objectiveId}:generation:${next}` });
      return this.getObjective(projectId, objectiveId);
    });
    return tx.immediate();
  }

  projectBacklog(projectId, { objectiveId, afterTaskId = '', afterCursor, limit = 50, state } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid backlog page limit');
    const clauses = ['project_id = ?']; const params = [projectId];
    if (objectiveId !== undefined) {
      const cursor = afterCursor === undefined ? afterTaskId : afterCursor;
      if (typeof cursor !== 'string') throw new TypeError('Invalid objective backlog cursor');
      clauses.push('objective_id = ?', 'task_id > ?'); params.push(objectiveId, cursor);
    } else if (afterCursor) {
      let pair;
      try { pair = JSON.parse(Buffer.from(afterCursor, 'base64url').toString('utf8')); } catch { throw new TypeError('Invalid backlog cursor'); }
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((part) => typeof part !== 'string')) throw new TypeError('Invalid backlog cursor');
      clauses.push('(objective_id > ? OR (objective_id = ? AND task_id > ?))'); params.push(pair[0], pair[0], pair[1]);
    }
    if (state !== undefined) { clauses.push('state = ?'); params.push(state); }
    params.push(limit);
    const rows = this.db.prepare(`SELECT objective_id,task_id,contract_json FROM backlog_tasks WHERE ${clauses.join(' AND ')} ORDER BY objective_id,task_id LIMIT ?`).all(...params);
    const last = rows.at(-1);
    const nextCursor = rows.length === limit ? (objectiveId !== undefined ? last.task_id : Buffer.from(JSON.stringify([last.objective_id, last.task_id])).toString('base64url')) : null;
    return { items: rows.map((row) => decode(row.contract_json)), nextCursor };
  }

  claimReady(projectId, objectiveId, schedulerGeneration, { leaseMs = 30000, limit = 1, controlRevision, canClaim } = {}) {
    if (!Number.isSafeInteger(schedulerGeneration) || schedulerGeneration < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Invalid claim request');
    if (canClaim !== undefined && typeof canClaim !== 'function') throw new TypeError('canClaim must be a function');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      if (controlRevision === undefined) throw recordError('control_revision_required');
      if (controlRevision !== objective.controlRevision) throw recordError('control_revision_stale');
      if (schedulerGeneration !== objectiveRow.owner_generation) throw recordError('owner_generation_stale');
      if (NO_CLAIM_OBJECTIVE_STATES.has(objective.disposition)) return [];
      const capacities = decode(objectiveRow.capacities_json);
      const live = this.#liveClaims(projectId);
      const workerLimit = Math.max(0, objectiveRow.max_active_turns - objectiveRow.planner_reserved_slots);
      const results = [];
      const ready = this.#tasks(projectId, objectiveId).filter((task) => ['queued', 'ready'].includes(task.state)).sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId));
      for (const task of ready) {
        if (results.length >= limit || live.length + results.length >= workerLimit) break;
        if ((live.filter((claim) => claim.role === task.role).length + results.filter((item) => item.task.role === task.role).length) >= (capacities[task.role] ?? 0)) continue;
        if (!this.#isReady(projectId, objectiveId, task)) continue;
        if (canClaim) {
          const liveProjection = this.#liveClaimProjection(projectId);
          const eligible = canClaim(deepFreeze(clone(task)), deepFreeze(clone(liveProjection)));
          if (eligible && typeof eligible.then === 'function') throw recordError('claim_eligibility_must_be_synchronous');
          if (typeof eligible !== 'boolean') throw recordError('claim_eligibility_must_return_boolean');
          if (eligible !== true) continue;
        }
        const priorAttempts = this.db.prepare('SELECT COUNT(*) AS n FROM backlog_attempts WHERE project_id=? AND objective_id=? AND task_id=?').get(projectId, objectiveId, task.taskId).n;
        const attemptNo = priorAttempts + 1;
        const attemptId = this.idFactory('attempt', encode([projectId, objectiveId, task.taskId, attemptNo]));
        const claimId = this.idFactory('claim', encode([attemptId, 'claim']));
        const fence = objectiveRow.next_fence + results.length;
        const selectedSettings = this.selectedSettingsResolver ? this.selectedSettingsResolver({ projectId, objectiveId, task: clone(task), ownerGeneration: schedulerGeneration }) : null;
        if (selectedSettings && typeof selectedSettings.then === 'function') throw recordError('settings_resolver_must_be_synchronous');
        const settingsKnown = selectedSettings !== null && selectedSettings !== undefined;
        const capturedControls = { authorityRevision: objective.authorityRevision, controlRevision: objective.controlRevision, schedulerGeneration, selectedSettingsKnown: settingsKnown };
        const selectedSettingsDigest = stableDigest(settingsKnown ? selectedSettings : { state: 'unknown' });
        const attempt = validateAttempt({ schemaVersion: VERSION, projectId, objectiveId, attemptId, taskId: task.taskId, taskRevision: task.revision, attemptNo, executionGeneration: schedulerGeneration, fencingToken: fence, contractDigest: stableDigest(task), selectedSettingsDigest, state: 'claimed', providerContextId: this.contextFactory(attemptId), externalTaskId: null, capturedControls, startedAt: this.now() });
        const claim = validateClaim({ schemaVersion: VERSION, projectId, objectiveId, claimId, taskId: task.taskId, attemptId, ownerGeneration: schedulerGeneration, fencingToken: fence, role: task.role, capacityClass: task.role, leaseUntil: this.now() + leaseMs, heartbeatAt: this.now(), state: 'active', startedAt: this.now(), releasedAt: null });
        this.db.prepare('INSERT INTO backlog_attempts(project_id,objective_id,attempt_id,task_id,attempt_no,record_json,contract_json) VALUES(?,?,?,?,?,?,?)').run(projectId, objectiveId, attemptId, task.taskId, attemptNo, encode(attempt), encode(task));
        this.db.prepare('INSERT INTO backlog_claims(project_id,objective_id,claim_id,task_id,attempt_id,role,fencing_token,record_json) VALUES(?,?,?,?,?,?,?,?)').run(projectId, objectiveId, claimId, task.taskId, attemptId, task.role, fence, encode(claim));
        const claimed = { ...task, state: 'claimed' };
        this.#putTask(claimed);
        this.events.appendInTransaction(projectId, { eventType: 'attempt.claimed', objectRevision: task.revision, taskId: task.taskId, attemptId, payload: { objectiveId, claimId, fencingToken: fence, attemptNo }, dedupeKey: `attempt:${attemptId}:claimed` });
        results.push({ task: claimed, attempt, claim });
      }
      if (results.length) this.db.prepare('UPDATE backlog_objectives SET next_fence = next_fence + ? WHERE project_id=? AND objective_id=?').run(results.length, projectId, objectiveId);
      return results;
    });
    return tx.immediate();
  }

  recordSubmitted(projectId, objectiveId, attemptId, fencingToken, externalTaskId) {
    if (typeof externalTaskId !== 'string' || externalTaskId.length < 1 || externalTaskId.length > 256 || externalTaskId.trim().length === 0 || /[\x00-\x1f\x7f]/.test(externalTaskId)) throw recordError('external_task_id_invalid');
    return this.#mutateAttempt(projectId, objectiveId, attemptId, fencingToken, (attempt, claim, task) => {
      if (claim.state !== 'active') throw recordError('claim_inactive');
      if (attempt.capturedControls.selectedSettingsKnown !== true) throw recordError('selected_settings_unpinned');
      if (attempt.state === 'running' && attempt.externalTaskId === externalTaskId) return { attempt, claim, task, duplicate: true };
      if (attempt.state === 'running' && attempt.externalTaskId !== externalTaskId) throw recordError('external_task_conflict');
      if (attempt.state !== 'claimed') throw recordError('submission_state_invalid');
      if (attempt.externalTaskId !== null) throw recordError('external_task_conflict');
      attempt = { ...attempt, state: 'running', externalTaskId };
      task = { ...task, state: 'running' };
      this.#saveAttempt(attempt); this.#saveClaim(claim); this.#putTask(task);
      this.events.appendInTransaction(projectId, { eventType: 'attempt.submitted', objectRevision: task.revision, taskId: task.taskId, attemptId, payload: { externalTaskId }, dedupeKey: `attempt:${attemptId}:submitted` });
      return { attempt, claim, task };
    });
  }

  pinSelectedSettings(projectId, objectiveId, attemptId, fencingToken, settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('Selected settings must be an object');
    const digest = stableDigest(settings);
    return this.#mutateAttempt(projectId, objectiveId, attemptId, fencingToken, (attempt) => {
      if (attempt.externalTaskId || attempt.state !== 'claimed') throw recordError('settings_pin_window_closed');
      if (attempt.capturedControls.selectedSettingsKnown === true) {
        if (attempt.selectedSettingsDigest === digest) return attempt;
        throw recordError('selected_settings_conflict');
      }
      attempt = { ...attempt, selectedSettingsDigest: digest, capturedControls: { ...attempt.capturedControls, selectedSettingsKnown: true } };
      this.#saveAttempt(attempt);
      this.events.appendInTransaction(projectId, { eventType: 'attempt.settings_pinned', objectRevision: attempt.taskRevision, taskId: attempt.taskId, attemptId, payload: { settingsDigest: digest }, dedupeKey: `attempt:${attemptId}:settings` });
      return attempt;
    });
  }

  heartbeat(projectId, objectiveId, attemptId, fencingToken, { leaseMs = 30000, ownerGeneration } = {}) {
    return this.#mutateAttempt(projectId, objectiveId, attemptId, fencingToken, (attempt, claim) => {
      if (ownerGeneration !== undefined && claim.ownerGeneration !== ownerGeneration) throw recordError('owner_generation_stale');
      if (claim.state !== 'active' || ['succeeded', 'failed', 'canceled'].includes(attempt.state)) throw recordError('claim_inactive');
      const now = this.now(); claim = { ...claim, heartbeatAt: now, leaseUntil: now + leaseMs };
      this.#saveClaim(claim); return { attempt, claim };
    });
  }

  settleAttempt(projectId, objectiveId, attemptId, fencingToken, result, evidence = {}) {
    return this.#mutateAttempt(projectId, objectiveId, attemptId, fencingToken, (attempt, claim, task) => {
      const objective = this.getObjective(projectId, objectiveId);
      if (objective?.disposition === 'canceled' && result.state !== 'canceled') {
        result = { state: 'canceled', failureKind: 'objective_canceled' };
      }
      const terminal = result.state;
      if (!['succeeded', 'failed', 'canceled'].includes(terminal)) throw recordError('terminal_state_required');
      const digest = stableDigest({ result, evidence });
      const existing = this.db.prepare('SELECT terminal_digest FROM backlog_attempts WHERE project_id=? AND objective_id=? AND attempt_id=?').get(projectId, objectiveId, attemptId);
      if (existing.terminal_digest) {
        if (existing.terminal_digest === digest) return { attempt, claim, task, duplicate: true };
        throw recordError('terminal_result_conflict');
      }
      if (attempt.fencingToken !== fencingToken) throw recordError('fence_stale');
      if (evidence.remoteQuiescent !== true || evidence.processQuiescent !== true || evidence.effectsSettled !== true) throw recordError('quiescence_evidence_required');
      if (terminal === 'succeeded' && (result.trusted !== true || evidence.controllerValidated !== true)) throw recordError('trusted_output_required');
      if (terminal === 'succeeded' && attempt.capturedControls.selectedSettingsKnown !== true) throw recordError('selected_settings_unpinned');
      attempt = { ...attempt, state: terminal, outcome: clone(result), effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true }, evidenceRefs: evidence.evidenceRefs || [], settledAt: this.now() };
      const taskState = terminal === 'succeeded' ? 'succeeded' : terminal;
      task = { ...task, state: taskState };
      claim = { ...claim, state: 'released', releasedAt: this.now() };
      this.#saveAttempt(attempt, digest, evidence); this.#saveClaim(claim); this.#putTask(task);
      this.events.appendInTransaction(projectId, { eventType: `attempt.${terminal}`, objectRevision: task.revision, taskId: task.taskId, attemptId, payload: { taskId: task.taskId, result: clone(result) }, dedupeKey: `attempt:${attemptId}:terminal` });
      return { attempt, claim, task, duplicate: false };
    }, { allowReleased: true, recoveryGeneration: evidence.recoveryGeneration });
  }

  markExpired(projectId, objectiveId, now = this.now()) {
    const tx = this.db.transaction(() => {
      const claims = this.#liveClaims(projectId, objectiveId).filter((claim) => claim.state === 'active' && claim.leaseUntil <= now);
      for (let claim of claims) {
        claim = { ...claim, state: 'expired' };
        this.#saveClaim(claim);
        const row = this.#attemptRow(projectId, objectiveId, claim.attemptId);
        const attempt = { ...decode(row.record_json), state: 'unknown' };
        this.#saveAttempt(attempt);
        const task = this.#task(projectId, objectiveId, claim.taskId);
        this.#putTask({ ...task, state: 'settling' });
        this.events.appendInTransaction(projectId, { eventType: 'attempt.recovery_required', objectRevision: task.revision, taskId: task.taskId, attemptId: attempt.attemptId, payload: { claimId: claim.claimId, leaseExpiredAt: now }, dedupeKey: `attempt:${attempt.attemptId}:recovery` });
      }
      return claims.length;
    });
    return tx.immediate();
  }

  reconcileAttempt(projectId, objectiveId, attemptId, fencingToken, facts) {
    if (!facts || facts.remoteQuiescent !== true || facts.processQuiescent !== true || facts.effectsSettled !== true) throw recordError('quiescence_evidence_required');
    if (!facts.result || typeof facts.result !== 'object' || Array.isArray(facts.result) || !['succeeded', 'failed', 'canceled'].includes(facts.result.state)) throw recordError('terminal_result_required');
    const row = this.#attemptRow(projectId, objectiveId, attemptId);
    if (!row) throw recordError('attempt_missing');
    const attempt = decode(row.record_json);
    if (attempt.fencingToken !== fencingToken) throw recordError('fence_stale');
    if (attempt.state !== 'unknown') throw recordError('attempt_not_unknown');
    return this.settleAttempt(projectId, objectiveId, attemptId, fencingToken, facts.result, facts);
  }

  settleRecoveredNoEffect(projectId, objectiveId, attemptId, fencingToken, facts, retryLimit = 2) {
    if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) throw recordError('recovery_retry_limit_invalid');
    const fields = ['projectId', 'objectiveId', 'taskId', 'attemptId', 'fencingToken', 'claimOwnerGeneration',
      'recoveryGeneration', 'providerContextId', 'intentState', 'noEffect', 'remoteQuiescent',
      'processQuiescent', 'effectsSettled', 'evidenceRefs'];
    const proof = exactRecord(facts, fields, 'recovery_proof_fields_invalid');
    if (proof.projectId !== projectId || proof.objectiveId !== objectiveId || proof.attemptId !== attemptId
      || !Number.isSafeInteger(proof.fencingToken) || proof.fencingToken !== fencingToken
      || !Number.isSafeInteger(proof.claimOwnerGeneration) || proof.claimOwnerGeneration < 0
      || !Number.isSafeInteger(proof.recoveryGeneration) || proof.recoveryGeneration < 0
      || typeof proof.taskId !== 'string' || !proof.taskId || typeof proof.providerContextId !== 'string' || !proof.providerContextId
      || !(proof.intentState === null || ['intent', 'submitted', 'uncertain'].includes(proof.intentState))
      || proof.noEffect !== true || proof.remoteQuiescent !== true || proof.processQuiescent !== true || proof.effectsSettled !== true
      || !Array.isArray(proof.evidenceRefs) || proof.evidenceRefs.length > 64
      || proof.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref || ref.length > 1000)) throw recordError('recovery_proof_invalid');
    const tx = this.db.transaction(() => {
      const objectiveRow = this.#objectiveRow(projectId, objectiveId);
      if (!objectiveRow) throw recordError('objective_missing');
      const objective = decode(objectiveRow.record_json);
      if (objectiveRow.owner_generation !== proof.recoveryGeneration) throw recordError('owner_generation_stale');
      const row = this.db.prepare('SELECT record_json,terminal_digest,contract_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND attempt_id=?')
        .get(projectId, objectiveId, attemptId);
      if (!row) throw recordError('attempt_missing');
      let attempt = decode(row.record_json);
      const claimRow = this.db.prepare('SELECT record_json FROM backlog_claims WHERE project_id=? AND objective_id=? AND attempt_id=?').get(projectId, objectiveId, attemptId);
      if (!claimRow) throw recordError('claim_missing');
      let claim = decode(claimRow.record_json);
      const task = this.#task(projectId, objectiveId, attempt.taskId);
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_executor_attempts'").get()) throw recordError('recovery_executor_state_unavailable');
      const intentRow = this.db.prepare('SELECT state,external_task_id,context_id,project_id,objective_id,task_id,fencing_token FROM task_executor_attempts WHERE attempt_id=?').get(attemptId);
      const actualIntentState = intentRow?.state || null;
      if (proof.taskId !== attempt.taskId || proof.claimOwnerGeneration !== claim.ownerGeneration
        || proof.providerContextId !== attempt.providerContextId || proof.intentState !== actualIntentState
        || (intentRow && (intentRow.project_id !== projectId || intentRow.objective_id !== objectiveId || intentRow.task_id !== task.taskId
          || intentRow.fencing_token !== fencingToken || intentRow.context_id !== attempt.providerContextId))) throw recordError('recovery_identity_mismatch');
      if (attempt.fencingToken !== fencingToken || claim.fencingToken !== fencingToken) throw recordError('fence_stale');
      if (attempt.state !== 'unknown' || !['expired', 'fenced'].includes(claim.state)) throw recordError('recovery_not_pending');
      const digest = stableDigest({ recoveryProof: proof });
      if (row.terminal_digest) {
        if (row.terminal_digest === digest) return { attempt, claim, task, duplicate: true,
          state: objective.disposition === 'blocked_technical' ? 'blocked_technical' : task.state === 'blocked' ? 'task_blocked' : 'no_effect' };
        throw recordError('terminal_result_conflict');
      }
      const terminalResult = { state: 'canceled', failureKind: 'reconciled_no_effect' };
      const currentTaskContract = decode(row.contract_json);
      const recoveryExhausted = attempt.attemptNo >= retryLimit && objective.disposition !== 'canceled';
      attempt = { ...attempt, state: 'canceled', outcome: terminalResult,
        effect: { remoteQuiescent: true, processQuiescent: true, effectsSettled: true },
        evidenceRefs: proof.evidenceRefs, settledAt: this.now() };
      claim = { ...claim, state: 'released', releasedAt: this.now() };
      let nextTask;
      if (objective.disposition === 'canceled') nextTask = { ...task, state: 'canceled' };
      else if (recoveryExhausted) nextTask = { ...task, state: 'blocked', blockedReason: 'recovery_retry_exhausted' };
      else nextTask = { ...currentTaskContract, state: currentTaskContract.state === 'ready' ? 'ready' : 'queued' };
      this.#saveAttempt(attempt, digest, proof); this.#saveClaim(claim); this.#putTask(nextTask);
      const shouldBlockObjective = recoveryExhausted && ['planning', 'executing'].includes(objective.disposition)
        && !this.#hasPotentialTaskProgress(projectId, objectiveId);
      const objectiveBlocked = objective.disposition === 'blocked_technical' || shouldBlockObjective;
      if (shouldBlockObjective) {
        const nextObjective = validateObjective({ ...objective, disposition: 'blocked_technical', updatedAt: this.now() });
        this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?').run(encode(nextObjective), projectId, objectiveId);
        this.#saveLifecycleControl(projectId, objectiveId, objectiveRow.owner_generation, objective.controlRevision, 'blocked_technical');
      }
      const eventType = shouldBlockObjective ? 'objective.blocked_technical'
        : recoveryExhausted ? 'attempt.recovery_task_blocked' : 'attempt.reconciled_no_effect';
      this.events.appendInTransaction(projectId, { eventType,
        objectRevision: nextTask.revision, taskId: task.taskId, attemptId,
        payload: { objectiveId, taskId: task.taskId, fencingToken, retry: !recoveryExhausted && objective.disposition !== 'canceled',
          taskBlocked: recoveryExhausted, objectiveBlocked, attemptNo: attempt.attemptNo, retryLimit, evidenceRefs: proof.evidenceRefs },
        dedupeKey: `attempt:${attemptId}:reconciled-no-effect` });
      return { attempt, claim, task: nextTask, duplicate: false,
        state: objective.disposition === 'canceled' ? 'canceled' : objectiveBlocked ? 'blocked_technical'
          : recoveryExhausted ? 'task_blocked' : 'no_effect_requeued' };
    });
    return tx.immediate();
  }

  listClaims(projectId, objectiveId) { return this.db.prepare('SELECT record_json FROM backlog_claims WHERE project_id=? AND objective_id=? ORDER BY fencing_token').all(projectId, objectiveId).map((row) => decode(row.record_json)); }
  listAttempts(projectId, objectiveId) { return this.db.prepare('SELECT record_json,contract_json FROM backlog_attempts WHERE project_id=? AND objective_id=? ORDER BY task_id,attempt_no').all(projectId, objectiveId).map((row) => ({ ...decode(row.record_json), contractSnapshot: decode(row.contract_json) })); }
  projectCapacity(projectId, objectiveId) {
    const row = this.#objectiveRow(projectId, objectiveId); if (!row) return null;
    const claims = this.#liveClaims(projectId);
    const roleCapacities = decode(row.capacities_json);
    const byRole = {};
    for (const role of new Set([...Object.keys(roleCapacities), ...claims.map((claim) => claim.role)])) byRole[role] = { active: claims.filter((claim) => claim.role === role).length, limit: roleCapacities[role] ?? 0 };
    return { active: claims.length, workerLimit: Math.max(0, row.max_active_turns - row.planner_reserved_slots), maxActiveTurns: row.max_active_turns, plannerReservedSlots: row.planner_reserved_slots, byRole };
  }

  #requestControl(projectId, objectiveId, action, expectedControlRevision) {
    const row = this.#objectiveRow(projectId, objectiveId);
    if (!row) throw recordError('objective_missing');
    const objective = decode(row.record_json);
    if (objective.controlRevision !== expectedControlRevision) throw recordError('control_revision_stale');
    let disposition;
    if (action === 'pause' && !['accepted', 'partial', 'canceled'].includes(objective.disposition)) disposition = 'paused_owner';
    else if (action === 'resume' && objective.disposition === 'paused_owner') disposition = 'executing';
    else if (action === 'cancel' && !['accepted', 'partial', 'canceled'].includes(objective.disposition)) disposition = 'canceled';
    else throw recordError('control_transition_invalid');
    const next = validateObjective({ ...objective, disposition, controlRevision: objective.controlRevision + 1, updatedAt: this.now() });
    const eventAction = { pause: 'paused', resume: 'resumed', cancel: 'canceled' }[action];
    const cause = { pause: 'owner_pause', resume: 'active', cancel: 'owner_cancel' }[action];
    this.db.prepare('UPDATE backlog_objectives SET record_json=? WHERE project_id=? AND objective_id=?')
      .run(encode(next), projectId, objectiveId);
    if (action === 'cancel') {
      const unstarted = this.db.prepare(`SELECT contract_json FROM backlog_tasks WHERE project_id=? AND objective_id=?
        AND state IN ('draft','queued','ready','blocked') ORDER BY task_id`).all(projectId, objectiveId).map((item) => decode(item.contract_json));
      for (const task of unstarted) this.#putTask({ ...task, state: 'canceled' });
    }
    this.#saveLifecycleControl(projectId, objectiveId, row.owner_generation, next.controlRevision, cause);
    this.events.appendInTransaction(projectId, { eventType: `objective.${eventAction}`, objectRevision: next.controlRevision,
      payload: { objectiveId, controlRevision: next.controlRevision }, dedupeKey: `objective:${objectiveId}:control:${next.controlRevision}` });
    return this.getObjective(projectId, objectiveId);
  }

  #saveLifecycleControl(projectId, objectiveId, ownerGeneration, controlRevision, cause) {
    if (!LIFECYCLE_CONTROL_CAUSES.has(cause) || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0
      || !Number.isSafeInteger(controlRevision) || controlRevision < 0) throw recordError('lifecycle_control_record_invalid');
    this.db.prepare(`INSERT INTO backlog_lifecycle_controls(project_id,objective_id,owner_generation,control_revision,cause,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,objective_id) DO UPDATE SET owner_generation=excluded.owner_generation,
      control_revision=excluded.control_revision,cause=excluded.cause,updated_at=excluded.updated_at`)
      .run(projectId, objectiveId, ownerGeneration, controlRevision, cause, this.now());
  }

  #positiveIntegerMap(input) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.values(input).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('Role capacities must be positive finite integers'); }
  #normalizeOwnerCorrection(correction) {
    const fields = ['sourceMessageId', 'expectedGoalRevision', 'expectedAuthorityRevision', 'expectedControlRevision', 'requirementDigest'];
    if (!correction || typeof correction !== 'object' || Array.isArray(correction)) throw recordError('owner_correction_object_required');
    const keys = Reflect.ownKeys(correction);
    if (keys.length !== fields.length || keys.some((field) => typeof field !== 'string' || !fields.includes(field))) throw recordError('owner_correction_fields_invalid');
    const values = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(correction, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw recordError('owner_correction_fields_invalid');
      values[field] = descriptor.value;
    }
    for (const field of ['expectedGoalRevision', 'expectedAuthorityRevision', 'expectedControlRevision']) {
      if (!Number.isSafeInteger(values[field]) || values[field] < 0) throw recordError('owner_correction_revision_invalid');
    }
    return {
      sourceMessageId: values.sourceMessageId,
      expectedGoalRevision: values.expectedGoalRevision,
      expectedAuthorityRevision: values.expectedAuthorityRevision,
      expectedControlRevision: values.expectedControlRevision,
      requirementDigest: values.requirementDigest,
    };
  }
  #normalizeCheckpoints(checkpoints, projectId, objectiveId) {
    if (!Array.isArray(checkpoints) || checkpoints.length > 500) throw recordError('checkpoint_inventory_invalid');
    const byId = new Map();
    for (const item of checkpoints) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw recordError('checkpoint_inventory_invalid');
      const fields = Reflect.ownKeys(item);
      if (fields.length !== 3 || fields.some((field) => typeof field !== 'string' || !['projectId', 'objectiveId', 'checkpointId'].includes(field))) throw recordError('checkpoint_inventory_invalid');
      const values = {};
      for (const field of ['projectId', 'objectiveId', 'checkpointId']) {
        const descriptor = Object.getOwnPropertyDescriptor(item, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw recordError('checkpoint_inventory_invalid');
        values[field] = descriptor.value;
      }
      const checkpoint = { projectId: values.projectId, objectiveId: values.objectiveId, checkpointId: values.checkpointId };
      validateDependencyGraph([], [checkpoint]);
      if (checkpoint.projectId !== projectId || checkpoint.objectiveId !== objectiveId) throw recordError('checkpoint_inventory_scope_mismatch');
      const previous = byId.get(checkpoint.checkpointId);
      if (previous && encode(previous) !== encode(checkpoint)) throw recordError('checkpoint_inventory_conflict');
      byId.set(checkpoint.checkpointId, checkpoint);
    }
    return [...byId.values()].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  }
  #currentCheckpoints(projectId, objectiveId, initial) {
    const saved = this.#normalizeCheckpoints(initial, projectId, objectiveId);
    if (!this.checkpointInventory) return saved;
    const inventory = this.checkpointInventory({ projectId, objectiveId });
    if (inventory && typeof inventory.then === 'function') throw recordError('checkpoint_inventory_async');
    const registered = this.#normalizeCheckpoints(inventory, projectId, objectiveId);
    const byId = new Map(saved.map((item) => [item.checkpointId, item]));
    for (const checkpoint of registered) {
      const previous = byId.get(checkpoint.checkpointId);
      if (previous && encode(previous) !== encode(checkpoint)) throw recordError('checkpoint_inventory_conflict');
      byId.set(checkpoint.checkpointId, checkpoint);
    }
    if (byId.size > 500) throw recordError('checkpoint_inventory_invalid');
    return [...byId.values()].sort((a, b) => a.checkpointId.localeCompare(b.checkpointId));
  }
  #objectiveRow(projectId, objectiveId) { return this.db.prepare('SELECT * FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, objectiveId); }
  #tasks(projectId, objectiveId) { return this.db.prepare('SELECT contract_json FROM backlog_tasks WHERE project_id=? AND objective_id=? ORDER BY task_id').all(projectId, objectiveId).map((row) => decode(row.contract_json)); }
  #task(projectId, objectiveId, taskId) { const row = this.db.prepare('SELECT contract_json FROM backlog_tasks WHERE project_id=? AND objective_id=? AND task_id=?').get(projectId, objectiveId, taskId); if (!row) throw recordError('task_missing'); return decode(row.contract_json); }
  #putTask(task) { task = validateTask(task); this.db.prepare(`INSERT INTO backlog_tasks(project_id,objective_id,task_id,revision,state,priority,role,contract_json,created_seq) VALUES(?,?,?,?,?,?,?,?,0)
    ON CONFLICT(project_id,objective_id,task_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,priority=excluded.priority,role=excluded.role,contract_json=excluded.contract_json`).run(task.projectId, task.objectiveId, task.taskId, task.revision, task.state, task.priority, task.role, encode(task)); }
  #dependencies(projectId, objectiveId) { return this.#tasks(projectId, objectiveId).flatMap((task) => task.dependencies.map((dep) => ({ ...dep }))); }
  #isReady(projectId, objectiveId, task) {
    for (const dependency of task.dependencies) {
      if (dependency.predecessorType === 'checkpoint') { if (this.checkpointAccepted({ projectId, objectiveId, checkpointId: dependency.predecessorId, dependency }) !== true) return false; continue; }
      const pred = this.#task(projectId, objectiveId, dependency.predecessorId);
      const attemptRow = this.db.prepare('SELECT record_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND task_id=? ORDER BY attempt_no DESC LIMIT 1').get(projectId, objectiveId, pred.taskId);
      const attempt = attemptRow ? decode(attemptRow.record_json) : null;
      if (dependency.kind === 'requires_output' || dependency.kind === 'integration_after') {
        if (this.isOutputTrusted({ task: pred, attempt, dependency }) !== true) return false;
      } else if (this.checkpointAccepted({ projectId, objectiveId, checkpointId: dependency.predecessorId, dependency }) !== true) return false;
    }
    return true;
  }
  #hasPotentialTaskProgress(projectId, objectiveId) {
    if (this.#liveClaims(projectId, objectiveId).length) return true;
    return this.#tasks(projectId, objectiveId).some((task) => {
      if (['claimed', 'running', 'settling'].includes(task.state)) return true;
      return ['queued', 'ready'].includes(task.state) && this.#isReady(projectId, objectiveId, task);
    });
  }
  #liveClaims(projectId, objectiveId) {
    const rows = objectiveId === undefined
      ? this.db.prepare(`SELECT record_json FROM backlog_claims WHERE project_id=? AND json_extract(record_json, '$.state') IN ('active','expired','fenced')`).all(projectId)
      : this.db.prepare(`SELECT record_json FROM backlog_claims WHERE project_id=? AND objective_id=? AND json_extract(record_json, '$.state') IN ('active','expired','fenced')`).all(projectId, objectiveId);
    return rows.map((row) => decode(row.record_json));
  }
  #liveClaimProjection(projectId) {
    const rows = this.db.prepare(`SELECT c.record_json AS claim_json,a.record_json AS attempt_json,t.contract_json AS task_json
      FROM backlog_claims c
      JOIN backlog_attempts a ON a.project_id=c.project_id AND a.objective_id=c.objective_id AND a.attempt_id=c.attempt_id
      JOIN backlog_tasks t ON t.project_id=c.project_id AND t.objective_id=c.objective_id AND t.task_id=c.task_id
      WHERE c.project_id=? AND json_extract(c.record_json, '$.state') IN ('active','expired','fenced')
      ORDER BY c.fencing_token`).all(projectId);
    return rows.map((row) => ({ claim: decode(row.claim_json), attempt: decode(row.attempt_json), task: decode(row.task_json) }));
  }
  #attemptRow(projectId, objectiveId, attemptId) { return this.db.prepare('SELECT record_json FROM backlog_attempts WHERE project_id=? AND objective_id=? AND attempt_id=?').get(projectId, objectiveId, attemptId); }
  #saveAttempt(attempt, terminalDigest, releaseFacts) {
    attempt = validateAttempt(attempt);
    this.db.prepare('UPDATE backlog_attempts SET record_json=?, terminal_digest=COALESCE(?,terminal_digest), release_facts_json=COALESCE(?,release_facts_json) WHERE project_id=? AND objective_id=? AND attempt_id=?')
      .run(encode(attempt), terminalDigest ?? null, releaseFacts ? encode(releaseFacts) : null, attempt.projectId, attempt.objectiveId, attempt.attemptId);
  }
  #saveClaim(claim) { claim = validateClaim(claim); this.db.prepare('UPDATE backlog_claims SET record_json=? WHERE project_id=? AND objective_id=? AND claim_id=?').run(encode(claim), claim.projectId, claim.objectiveId, claim.claimId); }
  #mutateAttempt(projectId, objectiveId, attemptId, fencingToken, callback, { allowReleased = false, recoveryGeneration } = {}) {
    const tx = this.db.transaction(() => {
      const attemptRow = this.#attemptRow(projectId, objectiveId, attemptId); if (!attemptRow) throw recordError('attempt_missing');
      let attempt = decode(attemptRow.record_json);
      let claimRow = this.db.prepare('SELECT record_json FROM backlog_claims WHERE project_id=? AND objective_id=? AND attempt_id=?').get(projectId, objectiveId, attemptId);
      if (!claimRow) throw recordError('claim_missing');
      let claim = decode(claimRow.record_json);
      if (attempt.fencingToken !== fencingToken || claim.fencingToken !== fencingToken) throw recordError('fence_stale');
      const currentGeneration = this.#objectiveRow(projectId, objectiveId).owner_generation;
      if (claim.ownerGeneration !== currentGeneration && recoveryGeneration !== currentGeneration) throw recordError('owner_generation_stale');
      if (!['active', 'expired', 'fenced'].includes(claim.state) && !(allowReleased && claim.state === 'released')) throw recordError('claim_inactive');
      const task = this.#task(projectId, objectiveId, attempt.taskId);
      return callback(attempt, claim, task);
    });
    return tx.immediate();
  }
}

function createBacklogStore(db, options) { return new BacklogStore(db, options); }

module.exports = { BacklogStore, createBacklogStore, stableDigest };
