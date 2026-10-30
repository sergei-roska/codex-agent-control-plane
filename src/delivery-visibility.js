'use strict';

const { isDeepStrictEqual } = require('node:util');

const MAX_PAGE_SIZE = 100;
const MAX_OBJECTIVES = 100;
const LIVE_CLAIM_STATES = new Set(['active', 'expired', 'fenced']);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function readableTaskTitle(task) {
  const summary = typeof task.objective === 'string' ? task.objective.replace(/\s+/g, ' ').trim() : '';
  if (!summary) return task.taskId;
  const characters = Array.from(summary);
  return characters.length <= 160 ? summary : `${characters.slice(0, 157).join('').trimEnd()}...`;
}

function timestamp(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return NaN;
  return Date.parse(value);
}

function elapsed(start, end) {
  const first = timestamp(start); const last = timestamp(end);
  return Number.isFinite(first) && Number.isFinite(last) && first >= 0 && last >= 0 && last >= first ? last - first : null;
}

function projectDeliveryObjectives(db, { projectId, sessionId } = {}) {
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('Project is required');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw new TypeError('Invalid session');
  if (!tableExists(db, 'backlog_objectives')) return { available: false, objectives: [], truncated: false };
  const rows = sessionId
    ? db.prepare("SELECT objective_id,record_json FROM backlog_objectives WHERE project_id=? AND json_extract(record_json,'$.sessionId')=? ORDER BY objective_id LIMIT ?").all(projectId, sessionId, MAX_OBJECTIVES + 1)
    : db.prepare('SELECT objective_id,record_json FROM backlog_objectives WHERE project_id=? ORDER BY objective_id LIMIT ?').all(projectId, MAX_OBJECTIVES + 1);
  const objectives = rows.map(row => ({ id: row.objective_id, record: parseJson(row.record_json) }))
    .filter(item => item.record && (!sessionId || item.record.sessionId === sessionId))
    .slice(0, MAX_OBJECTIVES)
    .map(item => ({ objectiveId: item.id, sessionId: item.record.sessionId || null, disposition: item.record.disposition || 'unknown', updatedAt: item.record.updatedAt || null }));
  return { available: true, objectives, truncated: rows.length > MAX_OBJECTIVES };
}

function encodeCursor(projectId, objectiveId, sessionId, taskId) {
  return Buffer.from(JSON.stringify({ v: 1, projectId, objectiveId, sessionId: sessionId || null, taskId })).toString('base64url');
}

function decodeCursor(value, projectId, objectiveId, sessionId) {
  if (!value) return '';
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new TypeError('Invalid backlog cursor'); }
  if (!cursor || cursor.v !== 1 || cursor.projectId !== projectId || cursor.objectiveId !== objectiveId
    || cursor.sessionId !== (sessionId || null) || typeof cursor.taskId !== 'string' || !cursor.taskId
    || Object.keys(cursor).sort().join(',') !== 'objectiveId,projectId,sessionId,taskId,v') throw new TypeError('Backlog cursor scope mismatch');
  return cursor.taskId;
}

function projectDeliveryVisibility(db, { projectId, objectiveId, sessionId, afterCursor = '', limit = 25 } = {}) {
  if (typeof projectId !== 'string' || !projectId || typeof objectiveId !== 'string' || !objectiveId) throw new TypeError('Project and objective are required');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw new TypeError('Invalid session');
  if (typeof afterCursor !== 'string' || afterCursor.length > 2048) throw new TypeError('Invalid cursor');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new TypeError('Invalid page limit');
  const afterTaskId = decodeCursor(afterCursor, projectId, objectiveId, sessionId);
  const result = { schema: 'delivery-visibility/v1', projectId, objectiveId, sessionId: sessionId || null,
    available: false, objective: null, counts: { ready: null, blocked: null, active: null, unknown: null }, tasks: [], nextCursor: null,
    capacity: null, planner: null, inbox: null, idleReasons: { known: [], unknown: [] }, unavailableReason: 'delivery_store_unavailable' };
  if (!tableExists(db, 'backlog_objectives') || !tableExists(db, 'backlog_tasks')) return result;
  const objectiveRow = db.prepare('SELECT record_json,plan_revision,capacities_json,max_active_turns,planner_reserved_slots FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, objectiveId);
  if (!objectiveRow) { result.unavailableReason = 'objective_not_found'; return result; }
  const objective = parseJson(objectiveRow.record_json);
  if (!objective || (sessionId && objective.sessionId !== sessionId)) { result.unavailableReason = sessionId ? 'session_mismatch' : 'objective_unavailable'; return result; }
  result.available = true;
  result.unavailableReason = null;
  result.objective = { objectiveId, sessionId: objective.sessionId || null, disposition: objective.disposition || 'unknown', goalRevision: objective.goalRevision ?? null, controlRevision: objective.controlRevision ?? null, planRevision: objectiveRow.plan_revision ?? null };

  // Read persisted objective tasks and attempts for dependency evidence. Neither store constructors nor adapters run here.
  const all = db.prepare('SELECT task_id,contract_json FROM backlog_tasks WHERE project_id=? AND objective_id=? ORDER BY task_id').all(projectId, objectiveId).map(row => parseJson(row.contract_json)).filter(Boolean);
  const byTask = new Map(all.map(task => [task.taskId, task]));
  const attemptRows = tableExists(db, 'backlog_attempts')
    ? db.prepare('SELECT record_json,contract_json FROM backlog_attempts WHERE project_id=? AND objective_id=? ORDER BY task_id,attempt_no').all(projectId, objectiveId) : [];
  const attempts = attemptRows.map(row => ({ ...parseJson(row.record_json, {}), contractSnapshot: parseJson(row.contract_json) }));
  const attemptsByTask = new Map();
  for (const attempt of attempts) {
    const list = attemptsByTask.get(attempt.taskId) || [];
    list.push(attempt);
    attemptsByTask.set(attempt.taskId, list);
  }
  const taskColumns = new Set(db.prepare('PRAGMA table_info(backlog_tasks)').all().map(column => column.name));
  const createdSequences = taskColumns.has('created_seq')
    ? new Map(db.prepare('SELECT task_id,created_seq FROM backlog_tasks WHERE project_id=? AND objective_id=?').all(projectId, objectiveId).map(row => [row.task_id, row.created_seq])) : new Map();
  const planEvents = tableExists(db, 'delivery_events')
    ? db.prepare("SELECT event_json FROM delivery_events WHERE project_id=? AND json_extract(event_json,'$.eventType')='plan.applied' AND json_extract(event_json,'$.payload.objectiveId')=?").all(projectId, objectiveId).map(row => parseJson(row.event_json)).filter(Boolean) : [];
  const executions = tableExists(db, 'delivery_role_executions')
    ? new Map(db.prepare('SELECT attempt_id,record_json FROM delivery_role_executions WHERE project_id=? AND objective_id=?').all(projectId, objectiveId).map(row => [row.attempt_id, parseJson(row.record_json, {})])) : new Map();
  const admission = new Map();
  if (tableExists(db, 'candidate_admission_timing') && tableExists(db, 'candidate_intents')) {
    for (const row of db.prepare('SELECT i.attempt_id,t.started_at,t.acquired_at FROM candidate_intents i LEFT JOIN candidate_admission_timing t ON t.intent_id=i.intent_id WHERE i.project_id=? AND i.objective_id=?').all(projectId, objectiveId)) {
      admission.set(row.attempt_id, admission.has(row.attempt_id) ? null : row);
    }
  }
  const readiness = new Map();
  for (const task of all) readiness.set(task.taskId, assessTask(task, byTask, attemptsByTask));
  const readyTasks = all.filter(task => ['queued', 'ready'].includes(task.state) && readiness.get(task.taskId).state === 'ready');
  const blockedTasks = all.filter(task => task.state === 'blocked' || (['queued', 'ready'].includes(task.state) && readiness.get(task.taskId).state === 'blocked'));
  const unknownTasks = all.filter(task => ['queued', 'ready'].includes(task.state) && readiness.get(task.taskId).state === 'unknown');
  result.counts.ready = readyTasks.length;
  result.counts.blocked = blockedTasks.length;
  result.counts.unknown = unknownTasks.length;

  const projectCapacityRow = tableExists(db, 'backlog_project_capacity')
    ? db.prepare('SELECT capacities_json,max_active_turns,planner_reserved_slots FROM backlog_project_capacity WHERE project_id=?').get(projectId) : null;
  const configuredRoles = parseJson(projectCapacityRow?.capacities_json || objectiveRow.capacities_json, {});
  const maxActiveTurns = projectCapacityRow?.max_active_turns ?? objectiveRow.max_active_turns ?? null;
  const plannerReservedSlots = projectCapacityRow?.planner_reserved_slots ?? objectiveRow.planner_reserved_slots ?? null;
  const claims = tableExists(db, 'backlog_claims')
    ? db.prepare("SELECT objective_id,record_json FROM backlog_claims WHERE project_id=?").all(projectId).map(row => ({ objectiveId: row.objective_id, ...parseJson(row.record_json, {}) })).filter(claim => LIVE_CLAIM_STATES.has(claim.state)) : [];
  const projectClaims = claims;
  const objectiveClaims = claims.filter(claim => claim.objectiveId === objectiveId);
  const byRole = {};
  for (const role of new Set([...Object.keys(configuredRoles), ...projectClaims.map(claim => claim.role)])) {
    byRole[role] = { active: projectClaims.filter(claim => claim.role === role).length, configuredLimit: Number.isSafeInteger(configuredRoles[role]) ? configuredRoles[role] : null };
  }
  result.counts.active = objectiveClaims.length;
  result.capacity = { projectActive: projectClaims.length, objectiveActive: objectiveClaims.length,
    configuredWorkerLimit: Number.isSafeInteger(maxActiveTurns) ? Math.max(0, maxActiveTurns - (plannerReservedSlots || 0)) : null,
    maxActiveTurns, plannerReservedSlots, byRole, source: projectCapacityRow ? 'configured_project' : 'configured_objective', effectiveRuntimeLimit: null };

  const sessionKey = sessionId || objective.sessionId;
  if (tableExists(db, 'delivery_inbox_state') && sessionKey) {
    const row = db.prepare('SELECT version,cursor,wakeup,trigger_json FROM delivery_inbox_state WHERE project_id=? AND session_id=? AND objective_id=?').get(projectId, sessionKey, objectiveId);
    result.inbox = row ? { available: true, scope: 'objective', version: row.version, cursor: row.cursor, wakeup: Boolean(row.wakeup), triggerReasons: parseJson(row.trigger_json, []) } : { available: true, scope: 'objective', version: 0, cursor: 0, wakeup: false, triggerReasons: [] };
  } else result.inbox = { available: false, scope: 'objective', state: 'unknown' };
  if (tableExists(db, 'delivery_planner_turns') && sessionKey) {
    const row = db.prepare("SELECT turn_id,status,started_at,updated_at FROM delivery_planner_turns WHERE project_id=? AND session_id=? AND status IN ('active','unknown') ORDER BY started_at DESC LIMIT 1").get(projectId, sessionKey);
    result.planner = { available: true, scope: 'session', sessionId: sessionKey, attribution: 'not_attributed_to_objective', activeTurn: row ? { turnId: row.turn_id, status: row.status, startedAt: row.started_at, updatedAt: row.updated_at } : null, inFlight: row?.status === 'active' };
  } else result.planner = { available: false, scope: 'session', state: 'unknown' };

  const known = [];
  const unknown = [];
  if (objective.disposition && ['paused_owner', 'waiting_budget', 'waiting_owner', 'draining', 'blocked_technical', 'canceled', 'accepted', 'partial'].includes(objective.disposition)) {
    known.push({ reason: 'objective_control', detail: `Objective disposition is ${objective.disposition}.`, disposition: objective.disposition });
  }
  const workerLimit = result.capacity.configuredWorkerLimit;
  if (workerLimit !== null && projectClaims.length >= workerLimit) known.push({ reason: 'project_capacity_full', detail: `${projectClaims.length} project claims use the configured ${workerLimit} worker slots.`, active: projectClaims.length, limit: workerLimit });
  for (const [role, count] of Object.entries(byRole)) if (count.configuredLimit !== null && count.active >= count.configuredLimit && count.active > 0) {
    known.push({ reason: 'role_capacity_full', detail: `${role}: ${count.active} project claims use the configured ${count.configuredLimit} role slots.`, role, active: count.active, limit: count.configuredLimit });
  }
  const blockedDependencies = [...readiness.values()].flatMap(value => value.dependencies.filter(dep => dep.satisfied === false).map(dep => ({ ...dep, certainty: 'known' })));
  const unknownDependencies = [...readiness.values()].flatMap(value => value.dependencies.filter(dep => dep.satisfied === null).map(dep => ({ ...dep, certainty: 'unknown' })));
  if (blockedDependencies.length) known.push({ reason: 'dependency_not_satisfied', detail: `${blockedDependencies.length} task dependencies are not yet satisfied.`, dependencies: blockedDependencies.slice(0, 20) });
  if (unknownDependencies.length) unknown.push({ reason: 'dependency_acceptance_unknown', detail: `${unknownDependencies.length} dependency outcomes need trusted acceptance evidence.`, dependencies: unknownDependencies.slice(0, 20) });
  const unresolved = projectClaims.filter(claim => claim.state === 'expired' || claim.state === 'fenced');
  if (unresolved.length) known.push({ reason: 'unresolved_effects', detail: `${unresolved.length} expired or fenced project claims retain capacity.`, count: unresolved.length });
  const resourceTasks = readyTasks.filter(task => Array.isArray(task.resourceClaims) && task.resourceClaims.length);
  if (resourceTasks.length) unknown.push({ reason: 'resource_admission_unknown', detail: 'Persisted resource claims are known, but the active scheduler conflict policy is not exposed to this readonly view.', tasks: resourceTasks.map(task => task.taskId) });
  if (readyTasks.length === 0 && blockedTasks.length === 0 && unknownTasks.length === 0) known.push({ reason: 'no_ready_work', detail: 'There is no queued or ready work in this objective.' });
  if (result.capacity.effectiveRuntimeLimit === null) unknown.push({ reason: 'effective_runtime_capacity_unknown', detail: 'The persisted configured ceiling is known; the active scheduler limit is not exposed.' });
  unknown.push({ reason: 'scheduler_admission_unknown', detail: 'Runtime admission policy and transient resource locks are not exposed by the accepted readonly API.' });
  result.idleReasons = { known, unknown };

  const pageRows = db.prepare('SELECT task_id,contract_json FROM backlog_tasks WHERE project_id=? AND objective_id=? AND task_id>? ORDER BY task_id LIMIT ?').all(projectId, objectiveId, afterTaskId, limit + 1);
  const selected = pageRows.slice(0, limit).map(row => parseJson(row.contract_json)).filter(Boolean);
  result.tasks = selected.map(task => {
    const assessed = readiness.get(task.taskId) || { state: 'unknown', dependencies: [] };
    const taskAttempts = attemptsByTask.get(task.taskId) || [];
    const created = planEvents.find(event => event.objectRevision === createdSequences.get(task.taskId)
      && Array.isArray(event.payload?.changedTaskIds) && event.payload.changedTaskIds.includes(task.taskId));
    return { taskId: task.taskId, objectiveId, state: task.state, readiness: assessed.state, role: task.role, priority: task.priority,
      title: readableTaskTitle(task), blockedReason: task.blockedReason || null, dependencyReasons: assessed.dependencies,
      resourceClaims: Array.isArray(task.resourceClaims) ? task.resourceClaims : [], attemptCount: taskAttempts.length,
      attempts: taskAttempts.map(attempt => {
        const execution = executions.get(attempt.attemptId) || {};
        const writer = admission.get(attempt.attemptId) || {};
        return { attemptId: attempt.attemptId, state: attempt.state, threadId: attempt.providerThreadId || attempt.threadId || null, contextId: attempt.providerContextId || attempt.contextId || null, tokenUsage: attempt.tokenUsage || null, selectedSettingsKnown: attempt.capturedControls?.selectedSettingsKnown === true,
          waits: { backlogMs: attempt.attemptNo === 1 && attempt.taskRevision === 1 ? elapsed(created?.createdAt, attempt.startedAt) : null,
            writerMs: elapsed(writer.started_at, writer.acquired_at), providerMs: elapsed(execution.providerInvocationStartedAt, execution.turnStartObservedAt),
            settlementMs: elapsed(execution.terminalObservedAt, attempt.settledAt) } };
      }) };
  });
  if (pageRows.length > limit && selected.length) result.nextCursor = encodeCursor(projectId, objectiveId, sessionId, selected.at(-1).taskId);
  return result;
}

function assessTask(task, byTask, attemptsByTask) {
  if (!['queued', 'ready', 'blocked'].includes(task.state)) return { state: task.state || 'unknown', dependencies: [] };
  const dependencies = [];
  for (const dep of Array.isArray(task.dependencies) ? task.dependencies : []) {
    if (dep.predecessorType === 'checkpoint') {
      dependencies.push({ predecessorType: 'checkpoint', predecessorId: dep.predecessorId, kind: dep.kind, state: 'acceptance_unverified', satisfied: null, reason: 'No readonly trusted checkpoint acceptance adapter is available.' });
      continue;
    }
    const predecessor = byTask.get(dep.predecessorId);
    if (!predecessor) {
      dependencies.push({ predecessorType: 'task', predecessorId: dep.predecessorId, kind: dep.kind, state: 'missing', satisfied: false, reason: 'Predecessor task is missing.' });
      continue;
    }
    const latest = (attemptsByTask.get(predecessor.taskId) || []).at(-1);
    if (dep.kind !== 'requires_output' && dep.kind !== 'integration_after') {
      dependencies.push({ predecessorType: 'task', predecessorId: predecessor.taskId, kind: dep.kind, state: 'acceptance_unverified', satisfied: null, reason: 'No readonly trusted acceptance adapter is available.' });
      continue;
    }
    const outcome = latest?.outcome;
    let satisfied = predecessor.state !== 'succeeded' ? false : null;
    let reason = predecessor.state === 'succeeded'
      ? 'Success is persisted without matching trusted attempt and settled effect evidence.'
      : 'Predecessor task has not succeeded.';
    const hasTrustedSettlement = predecessor.state === 'succeeded' && latest?.state === 'succeeded'
      && latest.taskRevision === predecessor.revision && outcome?.trusted === true
      && latest.effect?.remoteQuiescent === true && latest.effect?.processQuiescent === true && latest.effect?.effectsSettled === true;
    if (predecessor.state === 'succeeded' && outcome?.trusted === false) {
      satisfied = false;
      reason = 'Persisted predecessor output is explicitly untrusted.';
    } else if (hasTrustedSettlement) {
      const expected = dep.expectedOutput === undefined ? predecessor.outputContract : dep.expectedOutput;
      if (expected === undefined || isDeepStrictEqual(expected, outcome.outputContract)) {
        satisfied = true;
        reason = 'Trusted successful output matches the dependency contract.';
      } else {
        satisfied = false;
        reason = 'Trusted output does not match the dependency contract.';
      }
    }
    dependencies.push({ predecessorType: 'task', predecessorId: predecessor.taskId, kind: dep.kind, state: satisfied ? 'satisfied' : 'not_satisfied', satisfied, reason });
  }
  if (task.state === 'blocked' || dependencies.some(dep => dep.satisfied === false)) return { state: 'blocked', dependencies };
  if (dependencies.some(dep => dep.satisfied === null)) return { state: 'unknown', dependencies };
  return { state: 'ready', dependencies };
}

module.exports = { MAX_PAGE_SIZE, MAX_OBJECTIVES, projectDeliveryObjectives, projectDeliveryVisibility };
