'use strict';

const { createRuntimeIdentity } = require('./runtime-identity');
const runtimeIdentity = globalThis[Symbol.for('codex.server.runtimeIdentity')] || createRuntimeIdentity();
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, Message, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { createAccountProfiles } = require('./account-profiles');
const { createSwitchingAppServer } = require('./app-server-switch');
const { CodexAppServer } = require('./codex-app-server');
const { loadRoles, createLeadRole } = require('./role-catalog');
const { loadEffectiveRoles } = require('./role-overrides');
const { readSettingsFile, resolveAcceptanceScratch } = require('./project-settings');
const { registerRoleAgents } = require('./a2a-role-service');
const { LeadOrchestrator, ResumeInputError, renderRunDigest } = require('./lead-orchestrator');
const { isThresholdOnlyRecoveryQuestion } = require('./lead-graph');
const { openStateDatabase, createTaskStore, DispatchJournal, reconcileInterruptedTasks, acquireStateLock, acquireWorkspaceLock, stateDbPath } = require('./durable-store');
const { createBudgetWatcher } = require('./budget-watcher');
const { classifyTransientFailure, createTransientRecoveryStore, createTransientRecovery } = require('./transient-recovery');
const { WriterAdmission } = require('./writer-admission');
const { LaneManager, selectWriterIsolation, laneRetentionHours } = require('./writer-lanes');
const { UsageLedger } = require('./usage-ledger');
const { SessionThreads } = require('./session-threads');
const { createActivityStore } = require('./activity-store');
const { createEvidenceStore } = require('./evidence-store');
const { StagingLog } = require('./staging-log');
const { validateAcceptanceContract, formatAcceptance, invalidAcceptanceContract, parseCheckCommand } = require('./acceptance');
const { formatLedger } = require('./partial-ledger');
const { loadOrCreateAuthToken, createAuthMiddleware } = require('./local-auth');
const { loadSkillCatalog } = require('./skill-catalog');
const { loadMcpCatalog } = require('./mcp-catalog');
const { parseTrialRunIds } = require('./aut03-lead-skill');
const { canonicalRoleId, roleDisplayName } = require('./role-names');
const { ConcurrentDeliveryEngine } = require('./concurrent-delivery-engine');
const { DeliveryEngineRouter } = require('./delivery-engine-router');
const { registerDeliveryHostControls } = require('./delivery-host-controls');
const { createProviderIdentityPin } = require('./delivery-provider-identity');
const { isProcessGroupGone } = require('./process-quiescence');
runtimeIdentity.seal();

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
// close() waits up to SHUTDOWN_TIMEOUT_MS for the runs to settle, then up to the same for the app server and HTTP close.
const SHUTDOWN_TOTAL_MS = 2 * SHUTDOWN_TIMEOUT_MS;
const AUTO_RESUME_TEXT = 'Automatic resume: Codex usage budget is available again.';
const AUTO_AUTH_RESUME_TEXT = 'Automatic resume: the account has been authenticated and required model budget is available.';
const TERMINAL_STORED_TASK_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']);

async function migrateLegacyRecoveryQuestion(orchestrator, runId) {
  const graph = orchestrator?.graph;
  if (!graph || typeof graph.getState !== 'function' || typeof graph.updateState !== 'function') return false;
  const config = { configurable: { thread_id: runId } };
  const snapshot = await graph.getState(config);
  const values = snapshot?.values || {};
  const request = values.humanRequest;
  const interrupt = (snapshot?.tasks || []).flatMap((task) => task.interrupts || [])
    .map((entry) => entry.value).find((value) => value?.kind === 'human_decision' && value.decisionId === request?.decisionId);
  const pendingHumanInput = (snapshot?.next || []).includes('human_input');
  if ((!interrupt && !pendingHumanInput) || !isThresholdOnlyRecoveryQuestion(request, values)) return false;
  const progress = [...(Array.isArray(values.progress) ? values.progress : []), {
    round: Number.isInteger(values.round) ? values.round : 0,
    kind: 'recovery_question_migrated',
    detail: 'A threshold-only owner recovery question was retired; required review remains active for technical replanning.',
  }].slice(-50);
  await graph.updateState(config, { humanRequest: null, progress }, 'human_input');
  const migrated = await graph.getState(config);
  return migrated?.values?.humanRequest == null
    && !((migrated?.tasks || []).flatMap((task) => task.interrupts || [])
      .some((entry) => entry.value?.kind === 'human_decision' && entry.value.decisionId === request.decisionId));
}

function projectIdForWorkspace(workspace) {
  const realWorkspace = fs.realpathSync(workspace);
  return crypto.createHash('sha1').update(realWorkspace).digest('hex').slice(0, 10);
}

function storedDeliveryMappings(db, projectId) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_run_engines'").get();
  if (!exists) return { hasConcurrent: false, projectIds: [], legacyRunIds: [], concurrentRunIds: [] };
  const rows = db.prepare('SELECT project_id, engine, run_id FROM delivery_run_engines').all();
  if (rows.some((row) => !['legacy', 'concurrent-v1'].includes(row.engine))) {
    throw Object.assign(new Error('State database contains an unknown delivery engine selection'), { code: 'delivery_engine_selection_unsafe' });
  }
  const projectIds = [...new Set(rows.map((row) => row.project_id))];
  if (projectIds.some((id) => id !== projectId)) {
    throw Object.assign(new Error('State database delivery mappings belong to a different project identity'), { code: 'delivery_project_identity_conflict' });
  }
  return { hasConcurrent: rows.some((row) => row.engine === 'concurrent-v1'),
    legacyRunIds: rows.filter((row) => row.engine === 'legacy').map((row) => row.run_id),
    concurrentRunIds: rows.filter((row) => row.engine === 'concurrent-v1').map((row) => row.run_id), projectIds };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function validQuiescentIdentity(identity) {
  return Boolean(identity && Number.isSafeInteger(identity.pid) && identity.pid > 1
    && Number.isSafeInteger(identity.pgid) && identity.pgid > 1
    && typeof identity.startTime === 'string' && identity.startTime.length > 0);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function storedOrchestratorTask(db, runId, { allowInputRequired = false } = {}) {
  if (typeof runId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(runId)) return null;
  const rows = db.prepare("SELECT tenant,status,status_state FROM tasks WHERE owner='orchestrator' AND id=?").all(runId);
  if (rows.length !== 1 || rows[0].tenant !== '') return null;
  const taskStatus = JSON.parse(rows[0].status);
  const allowed = allowInputRequired
    ? new Set(['TASK_STATE_INPUT_REQUIRED', ...TERMINAL_STORED_TASK_STATES])
    : TERMINAL_STORED_TASK_STATES;
  if (!isRecord(taskStatus) || taskStatus.state !== rows[0].status_state || !allowed.has(taskStatus.state)) return null;
  return { state: taskStatus.state };
}

function plannerSessionSettled(db, projectId, sessionId, { requireTurn = false } = {}) {
  const turns = db.prepare('SELECT status FROM delivery_planner_turns WHERE project_id=? AND session_id=?').all(projectId, sessionId);
  return (!requireTurn || turns.length > 0)
    && turns.every((turn) => ['complete', 'stale', 'reconciled_no_effect'].includes(turn.status));
}

function deterministicConcurrentIds(projectId, runId, request) {
  if (!isRecord(request) || (Object.hasOwn(request, 'contextId')
    && request.contextId != null && typeof request.contextId !== 'string')) return null;
  const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    objectiveId: `delivery-${digest([projectId, runId]).slice(0, 32)}`,
    sessionId: `session-${digest([projectId, request.contextId || runId]).slice(0, 32)}`,
  };
}

function orphanConcurrentMappingSettled(db, projectId, mapping) {
  const ids = deterministicConcurrentIds(projectId, mapping.run_id, JSON.parse(mapping.request_json));
  if (!ids || ids.objectiveId !== mapping.objective_id || ids.sessionId !== mapping.session_id) return false;
  if (db.prepare('SELECT 1 FROM concurrent_delivery_runs WHERE run_id=? LIMIT 1').get(mapping.run_id)
    || db.prepare('SELECT 1 FROM backlog_objectives WHERE objective_id=? LIMIT 1').get(mapping.objective_id)) return false;
  const task = storedOrchestratorTask(db, mapping.run_id);
  if (!task) return false;
  const turns = db.prepare('SELECT * FROM delivery_planner_turns WHERE project_id=? AND session_id=?').all(projectId, mapping.session_id);
  if (turns.length !== 1 || turns[0].status !== 'reconciled_no_effect') return false;
  const turn = turns[0];
  const pins = JSON.parse(turn.pins_json);
  const result = JSON.parse(turn.result_json);
  if (!isRecord(pins) || Object.hasOwn(pins, 'projectId') || Object.hasOwn(pins, 'sessionId') || Object.hasOwn(pins, 'turnId')
    || !Number.isSafeInteger(pins.ownerGeneration) || pins.ownerGeneration < 0
    || !isRecord(result) || Object.keys(result).sort().join(',') !== 'oldProviderGroupsGone,originalResult,ownerGeneration,projectId,providerDispatchStarted,providerScope,providerThreadId,sessionId,source,state,terminalProof,turnId'
    || result.state !== 'reconciled_no_effect' || result.source !== 'codex_app_server.thread_read'
    || result.projectId !== projectId || result.sessionId !== mapping.session_id || result.turnId !== turn.turn_id
    || result.providerScope !== turn.provider_scope || result.providerThreadId !== turn.provider_thread_id
    || result.ownerGeneration !== pins.ownerGeneration || result.oldProviderGroupsGone !== true
    || result.providerDispatchStarted !== true) return false;
  const original = result.originalResult;
  if (!isRecord(original) || !Object.hasOwn(original, 'errorCode') || original.errorCode !== 'turn_error'
    || !Object.hasOwn(original, 'preDispatchSource') || original.preDispatchSource !== null
    || Object.keys(original).some((key) => !['errorCode', 'preDispatchSource', 'providerFailure'].includes(key))) return false;
  const identities = db.prepare(`SELECT identity_json,start_json,terminal_json FROM concurrent_planner_execution_facts
    WHERE project_id=? AND session_id=? AND turn_id=?`).all(projectId, mapping.session_id, turn.turn_id);
  if (identities.length !== 1) return false;
  const fact = identities[0];
  const identity = JSON.parse(fact.identity_json);
  const start = JSON.parse(fact.start_json);
  const terminal = JSON.parse(fact.terminal_json);
  const processIdentity = start.processIdentity;
  if (!isRecord(identity) || Object.keys(identity).sort().join(',') !== 'ownerGeneration,projectId,providerScope,providerThreadId,sessionId,turnId'
    || identity.projectId !== projectId || identity.sessionId !== mapping.session_id || identity.turnId !== turn.turn_id
    || identity.providerScope !== turn.provider_scope || identity.providerThreadId !== turn.provider_thread_id
    || identity.ownerGeneration !== pins.ownerGeneration || !isRecord(start)
    || Object.keys(start).sort().join(',') !== 'processIdentity,threadId' || start.threadId !== turn.provider_thread_id
    || !validQuiescentIdentity(processIdentity) || !isProcessGroupGone(processIdentity)) return false;
  const proof = result.terminalProof;
  if (!isRecord(proof) || Object.keys(proof).sort().join(',') !== 'error,items,source,status,threadId,turnId'
    || proof.source !== 'thread/read' || proof.threadId !== turn.provider_thread_id
    || typeof proof.turnId !== 'string' || !proof.turnId || proof.status !== 'failed'
    || !isRecord(proof.error) || Object.keys(proof.error).sort().join(',') !== 'code,message,param,type'
    || proof.error.code !== 'invalid_json_schema' || proof.error.type !== 'invalid_request_error'
    || proof.error.param !== 'text.format.schema'
    || proof.error.message !== "Invalid schema for response_format 'codex_output_schema': 'schema.properties.expected.properties' is required for object schemas."
    || !Array.isArray(proof.items) || proof.items.length !== 1 || !isRecord(proof.items[0])
    || Object.keys(proof.items[0]).sort().join(',') !== 'id,type' || proof.items[0].type !== 'userMessage'
    || typeof proof.items[0].id !== 'string' || !proof.items[0].id
    || !isRecord(terminal) || !isDeepStrictEqual(terminal, proof)) return false;
  const noObjectiveEffects = [
    ['backlog_attempts', 'objective_id'], ['backlog_claims', 'objective_id'],
    ['delivery_role_executions', 'objective_id'], ['candidate_intents', 'objective_id'],
    ['delivery_output_bindings', 'objective_id'], ['concurrent_controller_fences', 'objective_id'],
    ['task_executor_attempts', 'objective_id'],
  ];
  for (const [table, column] of noObjectiveEffects) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).get(mapping.objective_id)) return false;
  }
  return db.prepare('SELECT 1 FROM dispatch_journal WHERE run_id=? LIMIT 1').get(mapping.run_id) == null;
}

function inspectConcurrentStartupQuarantine(db, workspace, projectId) {
  const unsafe = { state: 'unsafe' };
  try {
    if (!db || typeof db.prepare !== 'function' || typeof workspace !== 'string' || typeof projectId !== 'string'
      ) return unsafe;
    if (!hasTable(db, 'concurrent_shutdown_phases')) return { state: 'none' };
    const phaseColumns = new Set(db.prepare('PRAGMA table_info(concurrent_shutdown_phases)').all().map((item) => item.name));
    if (!phaseColumns.has('project_id') || !phaseColumns.has('phase_json')) return unsafe;
    const phases = db.prepare('SELECT phase_json FROM concurrent_shutdown_phases WHERE project_id=?').all(projectId);
    if (!phases.length) return { state: 'none' };
    if (phases.length !== 1) return unsafe;
    const phase = JSON.parse(phases[0].phase_json);
    if (!phase || Array.isArray(phase) || typeof phase !== 'object') return unsafe;
    const keys = Object.keys(phase).sort().join(',');
    if (keys !== 'attempts,identities,phase') return unsafe;
    if (phase.phase === 'released' && Array.isArray(phase.attempts) && Array.isArray(phase.identities)) return { state: 'released' };
    const attemptIds = new Set();
    if (phase.phase === 'provider_closing' && Array.isArray(phase.attempts) && Array.isArray(phase.identities)
      && phase.attempts.every((entry) => entry && !Array.isArray(entry) && typeof entry === 'object'
        && Object.keys(entry).sort().join(',') === 'attemptId,fencingToken,objectiveId,projectId,recoveryGeneration,taskId'
        && ['projectId','objectiveId','taskId','attemptId'].every((key) => typeof entry[key] === 'string' && entry[key].length > 0)
        && entry.projectId === projectId && Number.isSafeInteger(entry.fencingToken) && entry.fencingToken > 0
        && Number.isSafeInteger(entry.recoveryGeneration) && entry.recoveryGeneration >= 0
        && !attemptIds.has(entry.attemptId) && Boolean(attemptIds.add(entry.attemptId)))
      && phase.identities.length > 0 && phase.identities.every((identity) => validQuiescentIdentity(identity) && isProcessGroupGone(identity))) {
      return { state: 'provider_closing' };
    }
    if (phase.phase !== 'draining' || !Array.isArray(phase.attempts) || phase.attempts.length
      || !Array.isArray(phase.identities) || phase.identities.length) return unsafe;
    const needed = ['delivery_planner_turns','concurrent_planner_execution_facts','delivery_run_engines','concurrent_delivery_runs','backlog_objectives','backlog_attempts','backlog_claims','delivery_role_executions','candidate_intents','delivery_output_publications','delivery_output_bindings','concurrent_controller_fences','writer_executions','tasks','dispatch_journal','task_executor_attempts','task_executor_evidence','task_executor_thread_reservations'];
    if (needed.some((table) => !hasTable(db, table))) return unsafe;
    const col = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
    for (const [table, names] of Object.entries({
      delivery_planner_turns:['project_id','session_id','provider_scope','provider_thread_id','turn_id','status','pins_json','result_json'],
      concurrent_planner_execution_facts:['project_id','session_id','turn_id','identity_json','start_json','terminal_json'],
      delivery_run_engines:['project_id','run_id','engine','objective_id','session_id','request_json'],
      concurrent_delivery_runs:['project_id','run_id','objective_id','session_id'],
      backlog_objectives:['project_id','objective_id','record_json','owner_generation'], backlog_attempts:['project_id','objective_id','terminal_digest','record_json'],
      backlog_claims:['project_id','objective_id','record_json'], delivery_role_executions:['project_id','objective_id','attempt_id','state','record_json'],
      candidate_intents:['project_id','objective_id','intent_id','state'], delivery_output_publications:['intent_id','artifact_id','state'],
      delivery_output_bindings:['project_id','objective_id','artifact_id'], concurrent_controller_fences:['project_id','objective_id','projection_json'],
      writer_executions:['workspace','state'], tasks:['tenant','owner','id','status','status_state'],dispatch_journal:['run_id','state'],
      task_executor_attempts:['attempt_id','project_id','objective_id','task_id','state','record_json'],
      task_executor_evidence:['attempt_id'],
      task_executor_thread_reservations:['attempt_id','transport_key','thread_id'],
    })) if (names.some((name) => !col(table).has(name))) return unsafe;
    const runMappings = db.prepare('SELECT project_id,run_id,engine,objective_id,session_id,request_json FROM delivery_run_engines').all();
    if (runMappings.some((item) => item.project_id !== projectId || !['legacy','concurrent-v1'].includes(item.engine))) return unsafe;
    const allTurns = db.prepare('SELECT * FROM delivery_planner_turns WHERE project_id=?').all(projectId);
    const active = allTurns.filter((item) => ['active','unknown'].includes(item.status));
    if (allTurns.some((item) => !['active','unknown','complete','stale','reconciled_no_effect'].includes(item.status))) return unsafe;
    if (active.length !== 1 || active[0].status !== 'active') return unsafe;
    const turn = active[0], pins = JSON.parse(turn.pins_json);
    if (turn.result_json != null || Object.hasOwn(pins,'projectId') || Object.hasOwn(pins,'sessionId') || Object.hasOwn(pins,'turnId')
      || !Number.isSafeInteger(pins.ownerGeneration) || pins.ownerGeneration < 0) return unsafe;
    const facts = db.prepare('SELECT * FROM concurrent_planner_execution_facts WHERE project_id=? AND session_id=? AND turn_id=?').all(projectId,turn.session_id,turn.turn_id);
    if (facts.length !== 1) return unsafe;
    const fact=facts[0], identity=JSON.parse(fact.identity_json), start=JSON.parse(fact.start_json);
    const processIdentity=start.processIdentity;
    if (fact.terminal_json != null || identity.projectId!==projectId || identity.sessionId!==turn.session_id || identity.turnId!==turn.turn_id
      || identity.providerThreadId!==turn.provider_thread_id || identity.providerScope!==turn.provider_scope
      || !Number.isSafeInteger(identity.ownerGeneration) || identity.ownerGeneration<0 || identity.ownerGeneration!==pins.ownerGeneration
      || start.threadId!==turn.provider_thread_id || !Number.isSafeInteger(processIdentity?.pid) || processIdentity.pid<=1
      || !Number.isSafeInteger(processIdentity?.pgid) || processIdentity.pgid<=1 || typeof processIdentity.startTime!=='string'
      || !processIdentity.startTime || !isProcessGroupGone(processIdentity)) return unsafe;
    const allMappings=runMappings.filter((item)=>item.engine==='concurrent-v1');
    const mappings=allMappings.filter((item)=>item.session_id===turn.session_id);
    if(mappings.length!==1) return unsafe;
    const mapping=mappings[0];
    if(runMappings.filter((item)=>item.run_id===mapping.run_id).length!==1) return unsafe;
    if(typeof mapping.run_id!=='string'||!/^[\x21-\x7e]{1,128}$/.test(mapping.run_id)) return unsafe;
    if (!storedOrchestratorTask(db, mapping.run_id, { allowInputRequired: true })) return unsafe;
    for (const task of db.prepare('SELECT status,status_state FROM tasks').all()) {
      const taskStatus = JSON.parse(task.status);
      if (!isRecord(taskStatus) || taskStatus.state !== task.status_state
        || ['TASK_STATE_SUBMITTED','TASK_STATE_WORKING'].includes(taskStatus.state)) return unsafe;
    }
    const runRows=db.prepare('SELECT project_id,run_id,objective_id,session_id FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').all(projectId,mapping.run_id);
    if(runRows.length!==1) return unsafe;
    const run=runRows[0];
    const objectiveRows=db.prepare('SELECT project_id,objective_id,record_json,owner_generation FROM backlog_objectives WHERE project_id=? AND objective_id=?').all(projectId,mapping.objective_id);
    if(objectiveRows.length!==1) return unsafe;
    const objectiveRow=objectiveRows[0];
    const objective=objectiveRow&&JSON.parse(objectiveRow.record_json);
    if(!run||run.project_id!==projectId||run.run_id!==mapping.run_id||run.objective_id!==mapping.objective_id||mapping.session_id!==turn.session_id||run.session_id!==turn.session_id||!objective||objective.projectId!==projectId
      ||objective.objectiveId!==mapping.objective_id||objective.sessionId!==turn.session_id||objective.disposition!=='canceled'
      ||objectiveRow.owner_generation!==identity.ownerGeneration
      ||(Object.hasOwn(objective,'ownerGeneration')&&objective.ownerGeneration!==identity.ownerGeneration)
      ||concurrentRunSettled(db,projectId,mapping,{ allowedPlannerTurn: turn, strictQuarantine: true })!==true) return unsafe;
    const real=fs.realpathSync(workspace);
    if(db.prepare("SELECT 1 FROM writer_executions WHERE workspace=? AND state IN ('active','unresolved') LIMIT 1").get(real)) return unsafe;
    for (const legacy of runMappings.filter((item)=>item.engine==='legacy')) {
      if (!storedOrchestratorTask(db, legacy.run_id)) return unsafe;
    }
    for (const other of allMappings.filter((item)=>item.run_id!==mapping.run_id)) {
      if (other.engine !== 'concurrent-v1' || typeof other.run_id !== 'string'
        || !/^[\x21-\x7e]{1,128}$/.test(other.run_id)
        || typeof other.objective_id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(other.objective_id)
        || typeof other.session_id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(other.session_id)
        || runMappings.filter((item)=>item.run_id===other.run_id).length!==1
        || !storedOrchestratorTask(db, other.run_id, { allowInputRequired: true })) return unsafe;
      const runRows = db.prepare('SELECT project_id,run_id,objective_id,session_id,status FROM concurrent_delivery_runs WHERE run_id=?').all(other.run_id);
      const objectiveRows = db.prepare('SELECT project_id,objective_id,record_json FROM backlog_objectives WHERE objective_id=?').all(other.objective_id);
      if (!runRows.length && !objectiveRows.length) {
        if (!orphanConcurrentMappingSettled(db, projectId, other)) return unsafe;
        continue;
      }
      if (runRows.length!==1 || objectiveRows.length!==1 || runRows[0].project_id!==projectId
        || runRows[0].run_id!==other.run_id || runRows[0].objective_id!==other.objective_id
        || runRows[0].session_id!==other.session_id || objectiveRows[0].project_id!==projectId) return unsafe;
      const objective = JSON.parse(objectiveRows[0].record_json);
      const allowPausedOwner = objective?.disposition === 'paused_owner';
      if (allowPausedOwner && (runRows[0].status !== 'paused'
        || !plannerSessionSettled(db, projectId, other.session_id, { requireTurn: true }))) return unsafe;
      if (concurrentRunSettled(db, projectId, other, { strictQuarantine: true, allowPausedOwner }) !== true) return unsafe;
    }
    if (!projectEffectsSettled(db, projectId, real, runMappings)) return unsafe;
    return {state:'quarantine',runId:mapping.run_id,objectiveId:mapping.objective_id,sessionId:turn.session_id};
  } catch (_) { return unsafe; }
}

function projectEffectsSettled(db, projectId, workspace, runMappings = []) {
  try {
    const attempts=db.prepare('SELECT project_id,objective_id,terminal_digest,record_json FROM backlog_attempts WHERE project_id=?').all(projectId);
    if(attempts.some((item)=>!item.objective_id||typeof item.terminal_digest!=='string'||!item.terminal_digest
      ||!['succeeded','failed','canceled'].includes(JSON.parse(item.record_json)?.state))) return false;
    const claims=db.prepare('SELECT project_id,objective_id,record_json FROM backlog_claims WHERE project_id=?').all(projectId);
    if(claims.some((item)=>JSON.parse(item.record_json)?.state!=='released')) return false;
    const executions=db.prepare('SELECT project_id,objective_id,attempt_id,state,record_json FROM delivery_role_executions WHERE project_id=?').all(projectId);
    for(const item of executions) {
      const record=JSON.parse(item.record_json);
      if(!['terminal','settled'].includes(item.state)||record.state!==item.state
        ||record.projectId!==projectId||record.objectiveId!==item.objective_id||record.attemptId!==item.attempt_id||record.effectsSettled!==true) return false;
    }
    const taskExecutorAttempts=db.prepare('SELECT attempt_id,project_id,objective_id,task_id,state,record_json FROM task_executor_attempts').all();
    for(const item of taskExecutorAttempts) {
      const record=JSON.parse(item.record_json);
      if(item.project_id!==projectId||item.state!=='settled'||!isRecord(record)||record.attemptId!==item.attempt_id
        ||record.projectId!==projectId||record.objectiveId!==item.objective_id||record.taskId!==item.task_id) return false;
    }
    if(db.prepare(`SELECT 1 FROM task_executor_evidence e LEFT JOIN task_executor_attempts a ON a.attempt_id=e.attempt_id
      WHERE a.attempt_id IS NULL LIMIT 1`).get()) return false;
    if(db.prepare('SELECT 1 FROM task_executor_thread_reservations LIMIT 1').get()) return false;
    const intents=db.prepare('SELECT project_id,objective_id,intent_id,state FROM candidate_intents WHERE project_id=?').all(projectId);
    if(intents.some((item)=>!['applied','refused','not_applied'].includes(item.state))) return false;
    const publications=db.prepare(`SELECT p.intent_id,p.artifact_id,p.state,b.project_id,b.objective_id
      FROM delivery_output_publications p LEFT JOIN delivery_output_bindings b ON b.artifact_id=p.artifact_id`).all();
    for(const item of publications) {
      if(!item.project_id) return false;
      if(item.project_id!==projectId) continue;
      if(!['applied','refused'].includes(item.state)||!item.objective_id) return false;
      const intent=db.prepare('SELECT project_id,objective_id,state FROM candidate_intents WHERE intent_id=?').get(item.intent_id);
      if(!intent||intent.project_id!==projectId||intent.objective_id!==item.objective_id||intent.state!==item.state) return false;
    }
    const fences=db.prepare('SELECT project_id,objective_id,projection_json FROM concurrent_controller_fences WHERE project_id=?').all(projectId);
    for(const item of fences) if(JSON.parse(item.projection_json)?.safeToRelease!==true) return false;
    const writerRows=db.prepare('SELECT state FROM writer_executions WHERE workspace=?').all(workspace);
    if(writerRows.some((item)=>!['released','reconciled'].includes(item.state))) return false;
    for(const mapping of runMappings) {
      const journal=db.prepare('SELECT state FROM dispatch_journal WHERE run_id=?').all(mapping.run_id);
      if(journal.some((item)=>item.state!=='finished')) return false;
    }
    return true;
  } catch (_) { return false; }
}

function concurrentRunSettled(db, projectId, mapping, { allowedPlannerTurn = null, strictQuarantine = false, allowPausedOwner = false } = {}) {
  if (mapping.project_id !== projectId || ![mapping.objective_id, mapping.session_id]
    .every((id) => typeof id === 'string' && /^[\x21-\x7e]{1,128}$/.test(id))) return 'unsafe';
  if (!hasTable(db, 'concurrent_delivery_runs')) return 'unsafe';
  const run = db.prepare('SELECT status,objective_id,session_id FROM concurrent_delivery_runs WHERE project_id=? AND run_id=?').get(projectId, mapping.run_id);
  if (!run || run.objective_id !== mapping.objective_id || run.session_id !== mapping.session_id) return 'unsafe';
  if (!['prepared', 'running', 'paused', 'recovering', 'accepted', 'partial', 'canceled'].includes(run.status)) return 'unsafe';
  if (!hasTable(db, 'backlog_objectives') || !hasTable(db, 'backlog_attempts') || !hasTable(db, 'backlog_claims')) return 'unsafe';
  const objectiveRow = db.prepare('SELECT record_json FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, mapping.objective_id);
  if (!objectiveRow) return 'unsafe';
  let objective;
  try { objective = JSON.parse(objectiveRow.record_json); } catch (_) { return 'unsafe'; }
  if (objective?.projectId !== projectId || objective.objectiveId !== mapping.objective_id
    || objective.sessionId !== mapping.session_id) return 'unsafe';
    if (hasTable(db, 'delivery_planner_turns')) {
      const turns = db.prepare('SELECT * FROM delivery_planner_turns WHERE project_id=? AND session_id=?')
        .all(projectId, mapping.session_id);
      const allowed = allowedPlannerTurn;
      if (turns.some((turn) => !['complete', 'stale', 'reconciled_no_effect'].includes(turn.status)
        && !(allowed && turn.project_id === allowed.project_id && turn.session_id === allowed.session_id
          && turn.provider_thread_id === allowed.provider_thread_id && turn.provider_scope === allowed.provider_scope
          && turn.turn_id === allowed.turn_id && turn.status === allowed.status && turn.status === 'active'))) return 'unsafe';
  }
  const pausedOwnerQuarantine = allowPausedOwner === true && run.status === 'paused' && objective.disposition === 'paused_owner';
  if (!['accepted', 'partial', 'canceled'].includes(objective.disposition) && !pausedOwnerQuarantine) {
    return ['planning', 'executing', 'paused_owner', 'waiting_owner', 'waiting_budget'].includes(objective.disposition) ? 'busy' : 'unsafe';
  }
  if (pausedOwnerQuarantine) {
    const columns = new Set(db.prepare('PRAGMA table_info(backlog_objectives)').all().map((item) => item.name));
    if (!columns.has('owner_generation')) return 'unsafe';
    const generation = db.prepare('SELECT owner_generation FROM backlog_objectives WHERE project_id=? AND objective_id=?').get(projectId, mapping.objective_id)?.owner_generation;
    if (!Number.isSafeInteger(generation) || generation < 0
      || (Object.hasOwn(objective, 'ownerGeneration') && objective.ownerGeneration !== generation)) return 'unsafe';
  }
  const attempts = db.prepare('SELECT terminal_digest,record_json FROM backlog_attempts WHERE project_id=? AND objective_id=?').all(projectId, mapping.objective_id);
  if (attempts.some((attempt) => typeof attempt.terminal_digest !== 'string' || !attempt.terminal_digest
    || (strictQuarantine && !['succeeded','failed','canceled'].includes(JSON.parse(attempt.record_json)?.state)))) return 'unsafe';
  for (const row of db.prepare('SELECT record_json FROM backlog_claims WHERE project_id=? AND objective_id=?').all(projectId, mapping.objective_id)) {
    let claim;
    try { claim = JSON.parse(row.record_json); } catch (_) { return 'unsafe'; }
    if (claim.state !== 'released') return 'unsafe';
  }
  if (hasTable(db, 'candidate_intents')) {
    const intents = db.prepare('SELECT state FROM candidate_intents WHERE project_id=? AND objective_id=?')
      .all(projectId, mapping.objective_id);
    if (intents.some((intent) => !['applied', 'refused', 'not_applied'].includes(intent.state))) return 'unsafe';
  }
  if (hasTable(db, 'delivery_role_executions')) {
    const executions = db.prepare('SELECT attempt_id,state,record_json FROM delivery_role_executions WHERE project_id=? AND objective_id=?')
      .all(projectId, mapping.objective_id);
    for (const execution of executions) {
      let record;
      try { record = JSON.parse(execution.record_json); } catch (_) { return 'unsafe'; }
      if (!['terminal', 'settled'].includes(execution.state) || record?.state !== execution.state
        || record.projectId !== projectId || record.objectiveId !== mapping.objective_id
        || record.attemptId !== execution.attempt_id || record.effectsSettled !== true) return 'unsafe';
    }
  }
  if (hasTable(db, 'concurrent_controller_fences')) {
    const fence = db.prepare('SELECT projection_json FROM concurrent_controller_fences WHERE project_id=? AND objective_id=?').get(projectId, mapping.objective_id);
    if (fence) {
      try { if (JSON.parse(fence.projection_json)?.safeToRelease !== true) return 'unsafe'; }
      catch (_) { return 'unsafe'; }
    }
  }
  if (hasTable(db, 'delivery_output_publications') && hasTable(db, 'delivery_output_bindings')) {
    const publications = db.prepare(`SELECT p.intent_id,p.state FROM delivery_output_publications p
      JOIN delivery_output_bindings b ON b.artifact_id=p.artifact_id WHERE b.project_id=? AND b.objective_id=?`)
      .all(projectId, mapping.objective_id);
    for (const publication of publications) {
      if (!(strictQuarantine ? ['applied', 'refused'] : ['applied', 'refused', 'not_applied']).includes(publication.state)) return 'unsafe';
      const intent = hasTable(db, 'candidate_intents')
        ? db.prepare('SELECT project_id,objective_id,state FROM candidate_intents WHERE intent_id=?').get(publication.intent_id)
        : null;
      if (!intent) {
        if (publication.state !== 'refused') return 'unsafe';
      } else if (intent.project_id !== projectId || intent.objective_id !== mapping.objective_id
        || !['applied', 'refused', 'not_applied'].includes(intent.state)
        || (strictQuarantine && intent.state !== publication.state)) return 'unsafe';
    }
  }
  return true;
}

function deliveryEngineFence({ db, workspace, projectId, engine, runId, legacyTaskIds, concurrentRecoveryUnsafe = false }) {
  if (engine === 'concurrent-v1' && concurrentRecoveryUnsafe) return 'unsafe';
  if (hasTable(db, 'delivery_run_engines')) {
    const mappings = db.prepare('SELECT project_id,run_id,engine,objective_id,session_id FROM delivery_run_engines WHERE project_id=? AND run_id<>?')
      .all(projectId, runId || '');
    for (const mapping of mappings) {
      if (mapping.engine === engine) continue;
      if (mapping.engine === 'concurrent-v1') {
        const settled = concurrentRunSettled(db, projectId, mapping);
        if (settled !== true) return settled;
        continue;
      }
      const tasks = db.prepare('SELECT status_state FROM tasks WHERE owner=? AND id=?').all('orchestrator', mapping.run_id);
      if (!tasks.length) return 'unsafe';
      if (tasks.some((task) => !TERMINAL_STORED_TASK_STATES.has(task.status_state))) return 'busy';
    }
  }
  if (engine === 'concurrent-v1') {
    for (const taskId of legacyTaskIds || []) {
      if (taskId === runId) continue;
      const tasks = db.prepare('SELECT status_state FROM tasks WHERE owner=? AND id=?').all('orchestrator', taskId);
      if (tasks.some((task) => !TERMINAL_STORED_TASK_STATES.has(task.status_state))) return 'busy';
    }
  }
  if (hasTable(db, 'writer_executions')) {
    const executions = db.prepare("SELECT state FROM writer_executions WHERE workspace=? AND state IN ('active','unresolved')").all(fs.realpathSync(workspace));
    if (executions.some((execution) => execution.state === 'unresolved')) return 'unsafe';
    if (executions.length) return 'busy';
  }
  return true;
}

/** CODEX_A2A_AUTO_RESUME: on by default; '0' or 'false' disables. */
function autoResumeEnabled(env = process.env) {
  const value = String(env.CODEX_A2A_AUTO_RESUME ?? '').trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

function textPart(text) {
  return { content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined };
}

function status(state, message) {
  return { state, message, timestamp: new Date().toISOString() };
}

function extractGoal(message, { allowEmpty = false } = {}) {
  const parts = message?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    if (allowEmpty) return '';
    throw new Error('Provide a non-empty text goal.');
  }
  const values = parts.map((part) => {
    if (part?.content?.$case === 'text') return part.content.value;
    if (typeof part?.text === 'string') return part.text;
    throw new Error('The lead accepts text parts only.');
  });
  const goal = values.join('\n').trim();
  if (!goal && !allowEmpty) throw new Error('Provide a non-empty text goal.');
  return goal;
}

function agentMessage(taskId, contextId, suffix, text) {
  return { messageId: `${taskId}-${suffix}`, contextId, taskId, role: 2, parts: [textPart(text)] };
}

function answerCommand(taskId, pause) {
  const parts = [`npm run ask -- --task ${taskId}`];
  if (pause?.kind === 'human_decision') {
    if (pause.decisionId) parts.push(`--decision ${pause.decisionId}`);
    parts.push('--choice <optionId>');
  }
  parts.push('"<answer>"');
  return parts.join(' ');
}

/** Human-readable INPUT_REQUIRED text for a pause, including how to answer. */
function describePause(taskId, pause, { autoResume = false, nextCheckAt = null, autoSwitch = false } = {}) {
  const lines = [];
  if (pause?.kind === 'human_decision') {
    lines.push(`Decision required: ${pause.question || '(no question given)'}`);
    if (pause.reason) lines.push(`Reason: ${pause.reason}`);
    if (Array.isArray(pause.options) && pause.options.length > 0) {
      lines.push('Options:');
      for (const option of pause.options) lines.push(`  - ${option.id}: ${option.description}`);
    }
    if (pause.recommendation) lines.push(`Recommendation: ${pause.recommendation}`);
    if (pause.decisionId) lines.push(`Decision ID: ${pause.decisionId}`);
  } else if (pause?.kind === 'waiting_for_budget') {
    lines.push(`Waiting for budget (${pause.source || 'unknown source'}): ${pause.message || 'usage limit reached.'}`);
    if (pause.resetsAt) lines.push(`Reported reset hint: ${pause.resetsAt}`);
    if (autoResume) {
      lines.push('The server resumes this task automatically once Codex budget is available.');
      if (autoSwitch) lines.push('Auto-switch is on: the server switches to another account with available budget.');
      if (nextCheckAt) lines.push(`Next budget check: ${new Date(nextCheckAt).toISOString()}`);
      lines.push('Send a message to this task to resume it immediately.');
    } else {
      lines.push('Send a message to this task to retry once quota is available.');
    }
  } else if (pause?.kind === 'waiting_for_auth') {
    lines.push('Waiting for an authenticated Codex account with available budget for this run.');
    lines.push(pause.action || 'Open the local Accounts panel and sign in to the affected existing profile.');
    if (autoResume) {
      lines.push('The server checks account authentication and required model availability, then resumes this task automatically.');
      if (nextCheckAt) lines.push(`Next authentication check: ${new Date(nextCheckAt).toISOString()}`);
    } else {
      lines.push('After signing in, send a message to this task to retry.');
    }
  } else if (pause?.kind === 'writer_unresolved') {
    lines.push('Earlier writer outcome(s) are unresolved: the server could not prove the writer stopped, so writable work is blocked.');
    for (const attempt of pause.attempts || []) lines.push(`  - ${attempt.attemptId} (${attempt.role}): ${attempt.reason}`);
    lines.push('Send any message to this task to retry reconciliation once the earlier writer is proven stopped.');
  } else if (pause?.kind === 'error') {
    lines.push(`The run stopped on an error${pause.errorName ? ` (${pause.errorName})` : ''}: ${pause.message || 'unknown error'}`);
    if (pause.recoveryCategory && pause.recoveryCategory !== 'unknown') lines.push(`Recovery classification: ${pause.recoveryCategory}; automatic retry is disabled.`);
    lines.push('Send a message to this task to retry the failed step.');
  } else if (pause?.kind === 'transient_recovery') {
    lines.push(`The run stopped after a ${pause.category || 'transient'} failure: ${pause.message || 'unknown error'}`);
    if (pause.attempts) lines.push(`Automatic recovery attempt: ${pause.attempts}`);
    if (pause.nextAttemptAt) lines.push(`Next recovery attempt: ${new Date(pause.nextAttemptAt).toISOString()}`);
    if (pause.recoveryExhausted === true && !Number.isFinite(pause.nextAttemptAt)) lines.push(`Automatic recovery exhausted after ${pause.attempts} attempts.`);
    else if (pause.ownerPauseRequested) lines.push('Automatic recovery is paused by the owner. Use the pause control to resume it, or send a message to continue manually.');
    else if (pause.recoveryState === 'dispatched') lines.push('The server is submitting this automatic recovery attempt.');
    else if (Number.isFinite(pause.nextAttemptAt)) lines.push('The server will retry this checkpoint automatically.');
    else lines.push('Automatic recovery is disabled or unsafe for this checkpoint; send a message to retry manually.');
  } else if (pause?.kind === 'owner_pause') {
    lines.push('Paused by the owner. Running worker turns finished first; no new work is planned until you continue.');
    lines.push('Send a message to this task to continue.');
  } else if (pause?.kind === 'stopped') {
    lines.push('Stopped by the owner. Running worker turns were cancelled; the run can continue.');
    lines.push('Send a message to this task to continue; the lead plans the next round from the checkpoint.');
  } else if (pause?.kind === 'restart') {
    lines.push('Run interrupted by server restart. Send a message to this task to resume.');
  } else {
    lines.push('The run is paused and needs input.');
  }
  lines.push(`Answer with: ${answerCommand(taskId, pause)}`);
  return lines.join('\n');
}

function makeLeadCard({ leadRole, endpoint }) {
  const roleId = canonicalRoleId('orch-lead');
  return {
    name: leadRole.displayName || roleDisplayName(roleId),
    description: leadRole.description,
    supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    provider: { url: endpoint, organization: 'Codex Universal' },
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {
      localBearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer', bearerFormat: 'opaque', description: 'Local A2A access token.' } } },
    },
    securityRequirements: [{ schemes: { localBearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: roleId,
      name: leadRole.displayName || roleDisplayName(roleId),
      description: leadRole.description,
      tags: [roleId],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    }],
    signatures: [],
  };
}

const MAX_ERROR_PAUSE_CHARS = 2000;

/** Text of the first non-empty user message in a task history, or ''. */
function firstUserGoal(task) {
  for (const message of task?.history || []) {
    if (message?.role !== 1) continue;
    try {
      const text = extractGoal(message, { allowEmpty: true });
      if (text) return text;
    } catch (_) { /* skip messages without usable text */ }
  }
  return '';
}

/** True when a validated contract carries anything worth pinning (checks or an invalid marker). */
function hasContract(contract) {
  return Boolean(contract) && (contract.requiredChecks?.length > 0 || Boolean(contract.invalid));
}

/** Metadata of the first non-empty user message in a task history, or {}. */
function firstUserMetadata(task) {
  for (const message of task?.history || []) {
    if (message?.role !== 1) continue;
    try {
      if (extractGoal(message, { allowEmpty: true })) return message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    } catch (_) { /* skip messages without usable text */ }
  }
  return {};
}

const TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);
const MAX_EARLIER_CONTEXT_CHARS = 24000;
const TRUNCATION_PREFIX = '[earlier context truncated]\n';

function partsText(parts) {
  return (parts || [])
    .map((part) => (part?.content?.$case === 'text' ? part.content.value : typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function priorResultText(refTask) {
  const artifacts = refTask?.artifacts || [];
  const fromArtifact = partsText(artifacts[artifacts.length - 1]?.parts);
  return fromArtifact || partsText(refTask?.status?.message?.parts) || '(no result text)';
}

/** Goal for a new run that continues a finished task; priorGoal falls back to the referenced task's first user message. */
function composeFollowUpGoal({ refTask, priorGoal, digest = null, newRequest }) {
  const artifacts = refTask.artifacts || [];
  const disposition = artifacts[artifacts.length - 1]?.metadata?.acceptance?.disposition || 'n/a';
  let earlier = `Earlier goal:\n${priorGoal || firstUserGoal(refTask)}\nEarlier result:\n${priorResultText(refTask)}`;
  if (earlier.length > MAX_EARLIER_CONTEXT_CHARS) {
    earlier = TRUNCATION_PREFIX + earlier.slice(earlier.length - (MAX_EARLIER_CONTEXT_CHARS - TRUNCATION_PREFIX.length));
  }
  const renderedDigest = digest ? renderRunDigest(digest) : '';
  return [
    'This is a follow-up to an earlier orchestrator task in the same conversation.',
    `Earlier task ${refTask.id} ended as ${TaskState[refTask.status?.state] || 'UNKNOWN'} (acceptance: ${disposition}).`,
    earlier,
    ...(renderedDigest ? ['Previous run in this session (digest; do not re-explore what it established, dispatch explorers only for gaps it names):', renderedDigest] : []),
    'New request (authoritative; the earlier context is background only):',
    newRequest,
  ].join('\n');
}

async function loadRunDigest(orchestrator, runId) {
  try { return (await orchestrator.getRunDigest?.(runId)) || null; } catch (_) { return null; }
}

/** Reference task ids of the first non-empty user message in a task history, or []. */
function firstUserReferenceIds(task) {
  for (const message of task?.history || []) {
    if (message?.role !== 1) continue;
    try {
      if (extractGoal(message, { allowEmpty: true })) return Array.isArray(message.referenceTaskIds) ? message.referenceTaskIds : [];
    } catch (_) { /* skip messages without usable text */ }
  }
  return [];
}

function isResumeInputError(error) {
  return error instanceof ResumeInputError;
}

/** Refreshes an existing paused task from the latest durable recovery record without overwriting a newer task state. */
function persistTransientRecoveryStatus({ db, recoveryStore, taskId, record, now = Date.now }) {
  const update = db.transaction(() => {
    const row = db.prepare(`SELECT status_state, status_last_updated, status, metadata FROM tasks
      WHERE tenant = ? AND owner = ? AND id = ?`).get('', 'orchestrator', taskId);
    if (!row || row.status_state !== 'TASK_STATE_INPUT_REQUIRED') return false;
    const currentRecord = recoveryStore.get(taskId);
    if (!currentRecord || currentRecord.updated_at !== record.updated_at || currentRecord.state !== record.state
      || currentRecord.attempts !== record.attempts || currentRecord.checkpoint_id !== record.checkpoint_id) return false;
    let metadata;
    let taskStatus;
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
      taskStatus = row.status ? JSON.parse(row.status) : {};
    } catch (_) { return false; }
    const prior = metadata.pause;
    if (!prior || !['transient_recovery', 'restart'].includes(prior.kind)) return false;
    if (prior.checkpointId && prior.checkpointId !== record.checkpoint_id) return false;
    const pause = {
      ...prior,
      kind: 'transient_recovery',
      category: record.category,
      attempts: record.attempts,
      checkpointId: record.checkpoint_id,
      nextAttemptAt: record.state === 'waiting' ? record.next_attempt_at : null,
      recoveryState: record.state,
      recoveryExhausted: record.state === 'exhausted' && !Number.isFinite(record.next_attempt_at),
      ownerPauseRequested: record.state === 'owner_paused',
      automatic: record.state === 'dispatched' || (record.state === 'waiting' && Number.isFinite(record.next_attempt_at)),
    };
    const message = Message.toJSON(agentMessage(taskId, taskStatus.message?.contextId || '', `recovery-${record.updated_at}`, describePause(taskId, pause)));
    const timestamp = new Date(now()).toISOString();
    const updatedStatus = { ...taskStatus, state: 'TASK_STATE_INPUT_REQUIRED', message, timestamp };
    const result = db.prepare(`UPDATE tasks SET status = ?, metadata = ?, status_last_updated = ?
      WHERE tenant = ? AND owner = ? AND id = ? AND status_state = ? AND status_last_updated = ?`)
      .run(JSON.stringify(updatedStatus), JSON.stringify({ ...metadata, pause }), now(), '', 'orchestrator', taskId,
        'TASK_STATE_INPUT_REQUIRED', row.status_last_updated);
    return result.changes === 1;
  });
  return update();
}

const STOPPED_PAUSE = { kind: 'stopped', message: 'Stopped by the owner' };

// STOP-01: the abort reason of a server shutdown. The lead graph parks such a run instead of ending it;
// an explicit task cancel aborts without this reason and stays terminal.
function ownerStopReason() {
  return Object.assign(new Error('Stopped by the owner'), { name: 'AbortError', ownerStop: true });
}

// `ownerChecks` (project setting, see src/project-settings.js): command strings pinned as an owner contract for a
// new run whose message carries no acceptance contract. Explicit checks replace them; a resume never repins.
function makeLeadExecutor({ orchestrator, loadTask, durabilityTimeoutMs = 2000, budgetWatcher = null, transientRecovery = null, autoResume = true, ownerChecks = null, legacyTaskIds = new Set(), objectiveBinding = null }) {
  const controllers = new Map();
  const reservations = new Set();
  const inflight = new Set();

  // Registers a budget pause with the watcher before describing it, so the text can name the next check.
  function describePauseText(taskId, pause) {
    if (!budgetWatcher) return describePause(taskId, pause);
    if (pause?.kind === 'waiting_for_budget' || pause?.kind === 'waiting_for_auth') {
      budgetWatcher.notePause(taskId, pause);
      const watched = budgetWatcher.status(taskId);
      return describePause(taskId, pause, { autoResume: true, nextCheckAt: watched?.nextCheckAt ?? null, autoSwitch: watched?.autoSwitch === true });
    }
    return describePause(taskId, pause);
  }

  async function executeLead(requestContext, eventBus) {
    const { taskId, contextId } = requestContext;
    if (controllers.has(taskId)) return;
    reservations.delete(taskId);
    const controller = new AbortController();
    controllers.set(taskId, controller);
    let task = requestContext.task || {
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [],
      metadata: {},
    };
    const resuming = requestContext.task?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED;
    let recoveryQuestionMigrated = false;
    if (resuming) {
      try { recoveryQuestionMigrated = await migrateLegacyRecoveryQuestion(orchestrator, taskId); } catch (_) { recoveryQuestionMigrated = false; }
      if (recoveryQuestionMigrated) {
        task = { ...task, status: status(TaskState.TASK_STATE_WORKING), metadata: { ...(task.metadata || {}), pause: null } };
      }
    }
    let effectivePause = null;
    // LL-4: checks the lead pins during the run are recorded in the task like an owner contract,
    // with source 'agent', so a restart and the launcher see them.
    const onEvent = (event) => {
      if (event?.type !== 'acceptance_contract' || !event.contract) return;
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_WORKING),
        metadata: { acceptanceContract: event.contract },
      }));
    };
    const republishPause = (pause, explanation, suffix) => {
      const text = explanation ? `${explanation}\n${describePauseText(taskId, pause)}` : describePauseText(taskId, pause);
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_INPUT_REQUIRED, agentMessage(taskId, contextId, `${suffix}-${Date.now()}`, text)),
        metadata: pause ? { pause } : {},
      }));
    };
    try {
      eventBus.publish(AgentEvent.task(task));
      let goal;
      // SES-01: the owner's own words of a follow-up run, shown verbatim in the continuing lead thread.
      let newRequest;
      let livePause = null;
      if (resuming) {
        if (objectiveBinding) {
          const storedBinding = requestContext.task?.metadata?.objectiveBinding;
          if (!storedBinding || storedBinding.projectId !== objectiveBinding.projectId
            || storedBinding.workspace !== objectiveBinding.workspace || storedBinding.taskId !== taskId) {
            republishPause(effectivePause, 'The original project/workspace binding is missing or conflicts with this server. The task remains incomplete and no work was dispatched.', 'objective-binding-error');
            return;
          }
        }
        try { livePause = (await orchestrator.getPause?.(taskId)) || null; } catch (_) { livePause = null; }
        // The checkpoint is authoritative; the stored task metadata is only a fallback.
        effectivePause = livePause || requestContext.task.metadata?.pause || null;
      }
      const pauseKind = effectivePause?.kind;
      const automaticResume = requestContext.userMessage?.metadata?.autoResume;
      const automaticBudget = automaticResume?.reason === 'budget';
      const automaticAuth = automaticResume?.reason === 'auth';
      const automaticTransient = automaticResume?.reason === 'transient_recovery';
      if (automaticBudget && (autoResume !== true || !resuming || livePause?.kind !== 'waiting_for_budget')) {
        if (resuming) {
          republishPause(effectivePause, 'The automatic budget retry is no longer eligible; the task remains paused.', 'budget-resume-rejected');
        } else {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'budget-resume-rejected', 'Automatic budget resume is only accepted for a task currently waiting for budget.')),
            metadata: {},
          }));
        }
        return;
      }
      if (automaticAuth && (autoResume !== true || !resuming || livePause?.kind !== 'waiting_for_auth')) {
        if (resuming) {
          republishPause(effectivePause, 'The automatic authentication retry is no longer eligible; the task remains paused.', 'auth-resume-rejected');
        } else {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'auth-resume-rejected', 'Automatic authentication resume is only accepted for a task currently waiting for authentication.')),
            metadata: {},
          }));
        }
        return;
      }
      if (automaticTransient && (autoResume !== true || !transientRecovery?.acceptAutomatic(taskId, {
        attempt: automaticResume.attempt,
        checkpointId: automaticResume.checkpointId,
      }))) {
        const recoveryState = transientRecovery?.status(taskId);
        if (recoveryState?.state === 'owner_paused') {
          republishPause(effectivePause, 'The automatic retry was paused by the owner before it could continue.', 'recovery-paused');
        } else if (controller.signal.aborted && controller.signal.reason?.ownerStop === true) {
          republishPause(STOPPED_PAUSE, '', 'stopped');
        }
        return;
      }
      // Once a valid manual or automatic resume is admitted, it no longer waits for budget.
      if (resuming) budgetWatcher?.forget(taskId);
      if (resuming) transientRecovery?.markRunning(taskId);
      try {
        goal = extractGoal(requestContext.userMessage, { allowEmpty: resuming && pauseKind !== 'human_decision' });
      } catch (error) {
        if (resuming) {
          republishPause(effectivePause, `${error.message} The task is still waiting.`, 'input-error');
          return;
        }
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'input-error', error.message)),
          metadata: {},
        }));
        return;
      }

      // The acceptance contract is read from a new run only; a resume can never change it.
      let contract;
      if (!resuming) {
        let raw = requestContext.userMessage?.metadata?.acceptance ?? requestContext.request?.metadata?.acceptance;
        // Project default owner checks: no source, so they are an owner contract like a CLI --check.
        if (raw === undefined && Array.isArray(ownerChecks) && ownerChecks.length > 0) {
          raw = { requiredChecks: ownerChecks.map((command, index) => parseCheckCommand(command, index)) };
        }
        try {
          if (raw && typeof raw === 'object' && 'invalid' in raw) throw new TypeError('acceptance has unknown field "invalid"');
          contract = validateAcceptanceContract(raw);
        } catch (error) {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'acceptance-error', `Invalid acceptance contract: ${error.message}`)),
            metadata: {},
          }));
          return;
        }
      }

      const referenceIds = !resuming ? requestContext.userMessage?.referenceTaskIds || [] : [];
      if (referenceIds.length > 0) {
        const refId = referenceIds[0];
        const refTask = referenceIds.length === 1 ? (requestContext.referenceTasks || []).find((candidate) => candidate?.id === refId) : undefined;
        const problem = referenceIds.length > 1 ? 'Only one reference task is supported.'
          : !refTask ? `Reference task ${refId} was not found.`
          : !TERMINAL_STATES.has(refTask.status?.state) ? `Reference task ${refId} is still active; answer or cancel it instead of continuing it.`
          : null;
        if (problem) {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'reference-error', problem)),
            metadata: {},
          }));
          return;
        }
        let priorGoal = null;
        try { priorGoal = (await orchestrator.getRunGoal?.(refId)) || null; } catch (_) { priorGoal = null; }
        newRequest = goal;
        goal = composeFollowUpGoal({ refTask, priorGoal, digest: await loadRunDigest(orchestrator, refId), newRequest: goal });
      }

      let resumeInput;
      if (resuming) {
        const messageMeta = requestContext.userMessage?.metadata || {};
        if (pauseKind === 'human_decision') {
          if (messageMeta.decisionId && livePause?.decisionId && messageMeta.decisionId !== livePause.decisionId) {
            republishPause(effectivePause, `Decision ID "${messageMeta.decisionId}" does not match the pending decision "${livePause.decisionId}". The task is still waiting.`, `decision-mismatch`);
            return;
          }
          resumeInput = { answer: goal, choice: messageMeta.choice, decisionId: messageMeta.decisionId };
        } else {
          resumeInput = { answer: goal };
        }
      }

      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_WORKING,
          resuming && requestContext.userMessage?.metadata?.acceptance !== undefined
            ? agentMessage(taskId, contextId, `resume-note-${Date.now()}`, 'Resumed. Acceptance metadata on a resume message is ignored; the contract was pinned when the run started.')
            : undefined),
        // Task metadata merges shallowly, so a cleared pause is null rather than absent.
        // A new run also pins its validated contract in the task record, so a restart before the
        // first checkpoint recovers it whichever metadata level carried it.
        metadata: resuming ? { pause: null } : {
          ...(objectiveBinding ? { objectiveBinding: { ...objectiveBinding, taskId } } : {}),
          acceptanceContract: contract,
        },
      }));
      if (!resuming && loadTask && (objectiveBinding || hasContract(contract))) {
        // Nothing may execute until the immutable objective binding and pinned contract are readable.
        const deadline = Date.now() + durabilityTimeoutMs;
        let durable = false;
        for (;;) {
          let stored = null;
          try { stored = await loadTask(taskId); } catch (_) { stored = null; }
          const savedBinding = stored?.metadata?.objectiveBinding;
          const bindingDurable = !objectiveBinding || (savedBinding?.projectId === objectiveBinding.projectId
            && savedBinding?.workspace === objectiveBinding.workspace && savedBinding?.taskId === taskId);
          const hasPinnedContract = Boolean(stored?.metadata)
            && Object.hasOwn(stored.metadata, 'acceptanceContract')
            && (stored.metadata.acceptanceContract === null || typeof stored.metadata.acceptanceContract === 'object');
          if (bindingDurable && hasPinnedContract) { durable = true; break; }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!durable) {
          eventBus.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, 'acceptance-durability-error', 'The acceptance contract could not be confirmed as stored; the run was not started.')),
            metadata: {},
          }));
          return;
        }
      }
      let result;
      if (resuming) {
        try {
          const resumeOrigin = ['budget', 'auth', 'transient_recovery'].includes(automaticResume?.reason) ? 'automatic' : 'owner';
          result = await orchestrator.resume({ runId: taskId, input: resumeInput, signal: controller.signal, onEvent, contextId, resumeOrigin });
        } catch (error) {
          if (error?.name !== 'RunNotFoundError' || (pauseKind !== 'restart' && pauseKind !== 'stopped')) throw error;
          // Crash before the first checkpoint: start over from the original goal.
          let original = firstUserGoal(task);
          const originalRequest = original;
          const originalRefIds = original ? firstUserReferenceIds(task) : [];
          if (originalRefIds.length > 0) {
            const refId = originalRefIds[0];
            const refTask = originalRefIds.length === 1 ? await loadTask?.(refId) : undefined;
            if (!refTask) throw new Error(`Reference task ${refId} could not be loaded to recover the original goal.`);
            let priorGoal = null;
            try { priorGoal = (await orchestrator.getRunGoal?.(refId)) || null; } catch (_) { priorGoal = null; }
            original = composeFollowUpGoal({ refTask, priorGoal, digest: await loadRunDigest(orchestrator, refId), newRequest: original });
          }
          if (!original) throw new Error('The run has no checkpoint and the original goal could not be recovered from the task history.');
          let originalContract;
          try {
            // Prefer the contract pinned at intake; runs from before that field fall back to message metadata.
            const pinned = task.metadata?.acceptanceContract;
            originalContract = validateAcceptanceContract(pinned !== undefined && pinned !== null ? pinned : firstUserMetadata(task).acceptance);
          } catch (contractError) {
            // Never continue as if no checks were required: carry an invalid marker into acceptance.
            originalContract = invalidAcceptanceContract(`Stored acceptance contract is invalid: ${contractError.message}`);
          }
          result = await orchestrator.run({ goal: original, runId: taskId, contract: originalContract, signal: controller.signal, onEvent, contextId, ...(originalRefIds.length > 0 ? { newRequest: originalRequest } : {}) });
        }
      } else {
        const runInput = { goal, runId: taskId, contract, signal: controller.signal, onEvent, contextId, ...(newRequest ? { newRequest } : {}) };
        const runMethod = legacyTaskIds.has(taskId) && typeof orchestrator.runLegacy === 'function'
          ? orchestrator.runLegacy.bind(orchestrator) : orchestrator.run.bind(orchestrator);
        result = await runMethod(runInput);
      }
      const stoppedByOwner = controller.signal.aborted && controller.signal.reason?.ownerStop === true;
      if (stoppedByOwner && (result?.status === 'canceled' || (result?.status === 'input_required' && result.pause?.kind === 'stopped'))) {
        // Shutdown: workers were cancelled, the lead run stays resumable.
        republishPause(STOPPED_PAUSE, '', 'stopped');
        return;
      }
      const paused = (result?.status === 'input_required' || result?.status === 'waiting_for_budget') && !controller.signal.aborted;
      if (paused) {
        const pause = result.pause || await orchestrator.getPause?.(taskId) || { kind: result.status === 'waiting_for_budget' ? 'waiting_for_budget' : 'human_decision' };
        if (pause.kind !== 'transient_recovery') transientRecovery?.forget(taskId);
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_INPUT_REQUIRED, agentMessage(taskId, contextId, `pause-${Date.now()}`, describePauseText(taskId, pause))),
          metadata: { pause },
        }));
        return;
      }
      const cancellationConfirmed = result?.status === 'canceled';
      // A shutdown stop that lands after the run already completed does not undo the finished result.
      const finishedBeforeStop = result?.status === 'completed' && stoppedByOwner;
      const cancellationUnconfirmed = controller.signal.aborted && !cancellationConfirmed && !finishedBeforeStop;
      const canceled = cancellationConfirmed;
      const completed = result?.status === 'completed' && (!controller.signal.aborted || finishedBeforeStop);
      const failed = !completed && !canceled;
      const output = cancellationUnconfirmed
        ? 'Cancellation was requested, but downstream A2A cancellation could not be confirmed.'
        : typeof result?.text === 'string' ? result.text : '';
      if (completed) {
        transientRecovery?.forget(taskId);
        const partial = result?.disposition === 'partial' && Array.isArray(result.checkpoints) ? result.checkpoints : null;
        const acceptanceText = [formatAcceptance(result?.acceptance), partial ? formatLedger(partial) : ''].filter(Boolean).join('\n\n');
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: `${taskId}-result`,
            name: 'Orchestrator result',
            description: 'Final result from the Codex Universal A2A team.',
            parts: [textPart(acceptanceText ? `${acceptanceText}\n\n${output}` : output)],
            metadata: {
              rounds: result?.rounds ?? 0,
              assignments: result?.assignments ?? [],
              ...(result?.acceptance ? { acceptance: result.acceptance } : {}),
              ...(partial ? { disposition: 'partial', checkpoints: partial } : {}),
            },
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: {},
        }));
      }
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(
          canceled ? TaskState.TASK_STATE_CANCELED : failed ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED,
          failed ? { messageId: `${taskId}-error`, contextId, taskId, role: 2, parts: [textPart(output || `Orchestrator ended with status: ${result?.status || 'unknown'}.`)] } : undefined,
        ),
        metadata: {},
      }));
    } catch (error) {
      const cancellationRequested = controller.signal.aborted;
      if (cancellationRequested && controller.signal.reason?.ownerStop === true) {
        // Shutdown stop that threw (for example an unconfirmed cancel): the checkpoint is mid-graph and resumable.
        republishPause(STOPPED_PAUSE, '', 'stopped');
        return;
      }
      if (resuming && !cancellationRequested && isResumeInputError(error)) {
        republishPause(effectivePause, `The answer was rejected: ${error?.message || String(error)}. The task is still waiting.`, 'input-error');
        return;
      }
      let resumable = false;
      if (!cancellationRequested && error?.name !== 'UnconfirmedCancellationError') {
        try { resumable = Boolean(await orchestrator.isResumable?.(taskId)); } catch (_) { resumable = false; }
      }
      if (resumable) {
        const message = String(error?.message || error).slice(0, MAX_ERROR_PAUSE_CHARS);
        const classification = classifyTransientFailure(error);
        const checkpoint = classification.eligible ? await orchestrator.getRecoveryCheckpoint?.(taskId) : null;
        const ownerPaused = orchestrator.consumeCompletedPauseRequest?.(taskId) === true;
        const safeCheckpoint = Boolean(checkpoint?.checkpointId && checkpoint.next.length === 1
          && checkpoint.next[0] === 'decide' && checkpoint.unresolvedWriters === 0 && !ownerPaused);
        let record = null;
        if (classification.eligible && checkpoint?.checkpointId) {
          record = transientRecovery?.failure(taskId, {
            category: classification.category,
            cause: message,
            checkpointId: checkpoint.checkpointId,
            enabled: autoResume && safeCheckpoint,
          }) || null;
        }
        const pause = record ? {
          kind: 'transient_recovery', message, errorName: error?.name || 'Error',
          category: classification.category, attempts: record.attempts,
          checkpointId: record.checkpoint_id, nextAttemptAt: record.next_attempt_at,
          recoveryExhausted: record.state === 'exhausted' && !Number.isFinite(record.next_attempt_at),
          automatic: record.state === 'waiting' && Number.isFinite(record.next_attempt_at),
          ...(ownerPaused ? { ownerPauseRequested: true } : {}),
        } : { kind: 'error', message, errorName: error?.name || 'Error', recoveryCategory: classification.category };
        if (pause.kind !== 'transient_recovery') transientRecovery?.forget(taskId);
        republishPause(pause, '', 'error-pause');
        return;
      }
      transientRecovery?.forget(taskId);
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_FAILED,
          { messageId: `${taskId}-error`, contextId, taskId, role: 2, parts: [textPart(cancellationRequested ? 'Cancellation was requested, but downstream A2A cancellation could not be confirmed.' : error?.message || String(error))] }),
        metadata: {},
      }));
    } finally {
      controllers.delete(taskId);
    }
  }

  return {
    execute(requestContext, eventBus) {
      const running = executeLead(requestContext, eventBus);
      inflight.add(running);
      const forget = () => inflight.delete(running);
      running.then(forget, forget);
      return running;
    },
    async cancelTask(taskId, eventBus) {
      budgetWatcher?.forget(taskId, { dropHistory: true });
      transientRecovery?.forget(taskId);
      const controller = controllers.get(taskId);
      if (controller) {
        controller.abort();
        return;
      }
      // Paused task: nothing is running, so the executor itself ends the task.
      eventBus?.publish(AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: status(TaskState.TASK_STATE_CANCELED),
        metadata: { pause: null },
      }));
      eventBus?.finished?.();
    },
    /** Resolves when every in-flight execute() has settled. */
    async settled() {
      await Promise.allSettled([...inflight]);
    },
    /** Shutdown: aborts every active run with the owner-stop reason so each parks as a resumable stopped pause. */
    cancelAll() {
      for (const controller of controllers.values()) controller.abort(ownerStopReason());
    },
    isTaskActive(taskId) {
      return controllers.has(taskId) || reservations.has(taskId);
    },
    reserveTask(taskId) {
      if (!taskId || controllers.has(taskId) || reservations.has(taskId)) return false;
      reservations.add(taskId);
      return true;
    },
    releaseTaskReservation(taskId) {
      reservations.delete(taskId);
    },
  };
}

function rejectOverlappingLeadTask(executor) {
  return function rejectOverlappingLeadTaskMiddleware(req, res, next) {
    if (req.method !== 'POST' || req.body?.method !== 'SendMessage') return next();
    const taskId = req.body?.params?.message?.taskId;
    if (!taskId) return next();
    if (!executor.reserveTask(taskId)) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: req.body.id ?? null,
        error: {
          code: -32000,
          message: `Task "${taskId}" is already executing; concurrent messages for one task are rejected.`,
        },
      });
      return;
    }
    const releaseIfUnclaimed = () => executor.releaseTaskReservation(taskId);
    res.once?.('finish', releaseIfUnclaimed);
    return next();
  };
}

function registerLead(app, { leadRole, orchestrator, baseUrl, authMiddleware, taskStore = new InMemoryTaskStore(), budgetWatcher = null, transientRecovery = null, autoResume = true, ownerChecks = null, legacyTaskIds = new Set(), objectiveBinding = null }) {
  const endpoint = new URL('/orchestrator', `${baseUrl}/`).toString();
  const card = makeLeadCard({ leadRole, endpoint });
  const executor = makeLeadExecutor({ orchestrator, loadTask: (id) => taskStore.load(id, {}), budgetWatcher, transientRecovery, autoResume, ownerChecks, legacyTaskIds, objectiveBinding });
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);
  app.use('/orchestrator/agent-card.json', agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(card) }));
  app.use('/orchestrator', authMiddleware, express.json(), rejectOverlappingLeadTask(executor), jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return { card, requestHandler, executor };
}

/**
 * PAUSE-01 control routes (loopback bearer token, like the role mounts). A pause only sets a flag on the
 * active lead run(s); the run parks at its next safe boundary and no worker turn is cancelled.
 * Responses: { runs: [{ taskId, pauseRequested }] } for the runs the call applied to (all active runs, or
 * the one named by body.taskId).
 */
function registerControl(app, { authMiddleware, orchestrator, runtimeIdentity, transientRecovery = null }) {
  const view = (runs) => ({ runs: runs.map((run) => ({ taskId: run.runId, pauseRequested: run.pauseRequested })) });
  const target = (req) => {
    const active = orchestrator.activeRuns?.() || [];
    const taskId = req.body?.taskId;
    return typeof taskId === 'string' && taskId ? active.filter((run) => run.runId === taskId) : active;
  };
  app.get('/control/runtime', authMiddleware, (_req, res) => {
    res.json(runtimeIdentity.snapshot);
  });
  app.get('/control/pause', authMiddleware, (req, res) => {
    const active = orchestrator.activeRuns?.() || [];
    const pending = (transientRecovery?.pausedRuns?.() || []).map((record) => ({ runId: record.run_id, pauseRequested: record.state === 'owner_paused' }));
    const merged = new Map([...active, ...pending].map((run) => [run.runId, run]));
    res.json(view([...merged.values()]));
  });
  app.post('/control/pause', authMiddleware, express.json(), (req, res) => {
    const applied = target(req).filter((run) => orchestrator.requestPause(run.runId));
    const paused = typeof req.body?.taskId === 'string' && req.body.taskId
      ? [req.body.taskId].filter((id) => transientRecovery?.pause(id))
      : (transientRecovery?.pausedRuns?.() || []).filter((run) => ['waiting', 'dispatched'].includes(run.state)).filter((run) => transientRecovery.pause(run.run_id)).map((run) => run.run_id);
    const updates = [...applied.map((run) => ({ runId: run.runId, pauseRequested: true })), ...paused.map((runId) => ({ runId, pauseRequested: true }))];
    res.json(view([...new Map(updates.map((run) => [run.runId, run])).values()]));
  });
  app.post('/control/pause/cancel', authMiddleware, express.json(), (req, res) => {
    const canceled = target(req).filter((run) => orchestrator.cancelPauseRequest(run.runId));
    const resumed = typeof req.body?.taskId === 'string' && req.body.taskId
      ? [req.body.taskId].filter((id) => transientRecovery?.cancelPauseRequest(id))
      : (transientRecovery?.pausedRuns?.() || []).filter((run) => run.state === 'owner_paused').filter((run) => transientRecovery.cancelPauseRequest(run.run_id)).map((run) => run.run_id);
    const updates = [...canceled.map((run) => ({ runId: run.runId, pauseRequested: false })), ...resumed.map((runId) => ({ runId, pauseRequested: false }))];
    res.json(view([...new Map(updates.map((run) => [run.runId, run])).values()]));
  });
}

function protectRoleRpcMounts(app, authMiddleware) {
  const protectedApp = {
    use(route, ...handlers) {
      if (typeof route === 'string' && /^\/agents\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) {
        app.use(route, authMiddleware, ...handlers);
      } else {
        app.use(route, ...handlers);
      }
      return protectedApp;
    },
    get: app.get.bind(app),
  };
  return protectedApp;
}

async function startServer({
  port = Number(process.env.PORT || DEFAULT_PORT),
  workspace = process.env.CODEX_WORKSPACE || process.cwd(),
  appServer: injectedAppServer = null,
  accountsDir,
  readProfileLimits = readLimitsOfHome,
  readProfileState = null,
  appServerFactory,
  listen = true,
  listenImpl = (application, listenPort, host, callback) => application.listen(listenPort, host, callback),
  profilesDir,
  roleOverridesFile = process.env.CODEX_A2A_ROLE_OVERRIDES ? path.resolve(process.env.CODEX_A2A_ROLE_OVERRIDES) : null,
  projectSettingsFile = process.env.CODEX_A2A_PROJECT_SETTINGS ? path.resolve(process.env.CODEX_A2A_PROJECT_SETTINGS) : null,
  tokenFile,
  orchestratorFactory = (options) => new LeadOrchestrator(options),
  stateFile,
  state: providedState,
  workspaceLockDir,
  projectId: configuredProjectId = process.env.CODEX_A2A_PROJECT_ID,
  deliveryStorageRoot = process.env.CODEX_A2A_DELIVERY_STORAGE_ROOT,
  providerIdentityPinFactory = createProviderIdentityPin,
  concurrentEngineFactory = (options) => new ConcurrentDeliveryEngine(options),
  autoResume = autoResumeEnabled(),
  budgetWatcherOptions = {},
  transientRecoveryFactory = createTransientRecovery,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
  const aut03TrialRunIds = parseTrialRunIds(process.env.CODEX_A2A_AUT03_TRIAL_RUN_IDS ?? '');
  if (typeof workspace !== 'string' || !workspace || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`workspace must be an existing directory: ${workspace}`);
  }
  const normalizedProjectId = projectIdForWorkspace(workspace);
  if (configuredProjectId !== undefined && configuredProjectId !== normalizedProjectId) {
    throw Object.assign(new Error('Configured project ID does not match the workspace identity'), { code: 'delivery_project_identity_invalid' });
  }
  // An injected App Server is used as is; otherwise the switching wrapper follows the active account profile.
  const accountProfiles = createAccountProfiles(accountsDir ? { accountsDir } : {});
  const connectorPreferencesFile = path.join(accountProfiles.accountsDir, 'connector-preferences.json');
  let dispatchJournal = null;
  const switching = injectedAppServer ? null : createSwitchingAppServer({
    profiles: accountProfiles,
    onCallBound: (record) => {
      if (!dispatchJournal) throw Object.assign(new Error('Provider call journal is unavailable'), { code: 'provider_call_binding_unavailable' });
      return dispatchJournal.recordCallBound(record);
    },
    create: (codexHome) => appServerFactory
      ? appServerFactory(codexHome, { connectorPreferencesFile })
      : new CodexAppServer({ ...(codexHome ? { codexHome } : {}), connectorPreferencesFile }),
  });
  const appServer = injectedAppServer || switching;
  let httpServer = null;
  let state = providedState || null;
  const ownsState = !providedState;
  let startupConcurrentEngine = null;
  let concurrentShutdownPromise = null;
  let providerShutdownPromise = null;
  let shuttingDown = false;
  let releaseLock = () => {};
  let releaseWorkspaceLock = () => {};
  let stateLockAcquired = false;
  let workspaceLockAcquired = false;
  let quarantineDb = null;
  let providerStarted = false;
  try {
    // Inspect the durable shutdown fence before touching the provider or opening the
    // migratory/writable state connection.
    if (!providedState && stateFile !== ':memory:') {
      const filePath = stateDbPath(stateFile);
      if (fs.existsSync(filePath)) {
        releaseLock = acquireStateLock(filePath); stateLockAcquired = true;
        releaseWorkspaceLock = acquireWorkspaceLock(workspace, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined); workspaceLockAcquired = true;
        quarantineDb = new Database(filePath, { readonly: true, fileMustExist: true });
        const inspection = inspectConcurrentStartupQuarantine(quarantineDb, workspace, normalizedProjectId);
        if (inspection.state === 'unsafe') throw Object.assign(new Error('Concurrent startup recovery is unsafe'), { code: 'concurrent_startup_recovery_unsafe' });
        if (inspection.state === 'quarantine') {
          const tokenPath = require('./local-auth').tokenPath(tokenFile);
          const fd = fs.openSync(tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          let token;
          try {
            const tokenStat = fs.fstatSync(fd);
            if (!tokenStat.isFile() || (tokenStat.mode & 0o777) !== 0o600) throw new Error('Unsafe local authentication token');
            token = fs.readFileSync(fd, 'utf8');
          } finally { fs.closeSync(fd); }
          if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Unsafe local authentication token');
          const app = express();
          app.use((req, res, next) => {
            if (!['GET', 'HEAD'].includes(req.method)) return res.status(503).json({ error: 'concurrent_startup_quarantined' });
            next();
          });
          app.use(createAuthMiddleware(token));
          app.get('/control/runtime', (req, res) => res.json(runtimeIdentity.snapshot));
          app.get('/control/quarantine', (req, res) => res.json({ state: 'quarantined', reason: 'concurrent_startup_recovery_unsafe', projectId: normalizedProjectId }));
          const server = listen ? await new Promise((resolve, reject) => {
            const listening = listenImpl(app, port, HOST, (error) => error ? reject(error) : resolve(listening));
            listening.once('error', reject);
          }) : null;
          const actualPort = server?.address()?.port ?? port;
          let closed = false;
          return { app, host: HOST, port: actualPort, projectId: normalizedProjectId, quarantined: true,
            async close() {
              if (closed) return;
              if (server) await closeHttpServer(server);
              if (quarantineDb?.open) quarantineDb.close();
              quarantineDb = null;
              releaseLock(); releaseWorkspaceLock(); stateLockAcquired = false; workspaceLockAcquired = false; closed = true;
            } };
        }
        quarantineDb.close(); quarantineDb = null;
      }
    } else if (providedState && providedState.filePath && providedState.filePath !== ':memory:' && fs.existsSync(providedState.filePath)) {
      const filePath = providedState.filePath;
      releaseLock = acquireStateLock(filePath); stateLockAcquired = true;
      releaseWorkspaceLock = acquireWorkspaceLock(workspace, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined); workspaceLockAcquired = true;
      quarantineDb = new Database(filePath, { readonly: true, fileMustExist: true });
      const inspection = inspectConcurrentStartupQuarantine(quarantineDb, workspace, normalizedProjectId);
      quarantineDb.close(); quarantineDb = null;
      if (!['none','released'].includes(inspection.state)) {
        throw Object.assign(new Error('Concurrent startup phase requires owned-file preflight'), { code: 'concurrent_startup_recovery_unsafe' });
      }
    }
    await appServer.start?.();
    providerStarted = true;
    const accountResult = await appServer.getAccount();
    const account = accountResult?.account || accountResult;
    if (account?.type !== 'chatgpt') throw new Error('Codex Universal requires an authenticated ChatGPT account via Codex OAuth.');

    if (!state) state = await openStateDatabase(stateFile ? { filePath: stateFile } : undefined);
    if (ownsState && !stateLockAcquired && state.filePath !== ':memory:') { releaseLock = acquireStateLock(state.filePath); stateLockAcquired = true; }
    if (!workspaceLockAcquired) { releaseWorkspaceLock = acquireWorkspaceLock(workspace, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined); workspaceLockAcquired = true; }
    const startupLeadTaskIds = new Set(state.db.prepare('SELECT id FROM tasks WHERE owner=?').all('orchestrator').map((row) => row.id));
    const storedMappings = storedDeliveryMappings(state.db, normalizedProjectId);
    dispatchJournal = new DispatchJournal(state);
    if (typeof appServer.setCallBindingHandler === 'function') {
      appServer.setCallBindingHandler((record) => dispatchJournal.recordCallBound(record));
    }

    const authToken = loadOrCreateAuthToken(tokenFile ? { filePath: tokenFile } : undefined);
    const authMiddleware = createAuthMiddleware(authToken);
    const baseRoles = loadRoles({
      ...(profilesDir ? { profilesDir } : {}),
      onSourceFile: (file, source) => runtimeIdentity.captureProfileSource(file, source),
    });
    const skillCatalog = loadSkillCatalog();
    const mcpCatalog = loadMcpCatalog();
    const app = express();
    // Until startup reconciliation and route registration finish, JSON-RPC calls get a retryable 503 (not 404).
    let ready = false;
    app.use((req, res, next) => {
      if (shuttingDown) return res.status(503).json({ error: 'shutting_down' });
      if (ready || req.method === 'GET' || req.method === 'HEAD') return next();
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'starting', message: 'The server is starting; startup reconciliation is not complete. Retry shortly.' });
    });
    if (listen) {
      httpServer = await new Promise((resolve, reject) => {
        // Express 5 passes a listen failure (e.g. EADDRINUSE) to the callback.
        const server = listenImpl(app, port, HOST, (error) => (error ? reject(error) : resolve(server)));
        server.once('error', reject);
      });
    }
    // Reconcile only once this process owns both the state file and the port.
    await reconcileInterruptedTasks(state, { leadNamespace: 'orchestrator' });
    const admission = new WriterAdmission({ db: state.db, workspace });
    await admission.reconcileStale();
    // Owner project settings are read once at startup; saved settings are never changed here.
    let acceptanceScratch = null;
    let aut03LeadSkillEnabled = false;
    let ownerChecks = null;
    let executionPermissions = 'inherit';
    let projectSettings = { deliveryEngine: 'legacy' };
    if (projectSettingsFile) {
      projectSettings = readSettingsFile(projectSettingsFile);
      if (projectSettings.warning) console.warn(`[settings] ${projectSettings.warning}`);
      acceptanceScratch = resolveAcceptanceScratch(projectSettings, projectSettingsFile);
      ownerChecks = projectSettings.ownerChecks;
      executionPermissions = projectSettings.executionPermissions;
      aut03LeadSkillEnabled = projectSettings.aut03LeadSkillEnabled === true;
    }
    // Writer isolation uses the resolved owner policy; inherited full access is cooperative, not confined.
    const isolation = await selectWriterIsolation({ env: process.env, appServer, workspace, db: state.db, stateFile: state.filePath, executionPermissions });
    const lanes = new LaneManager({ db: state.db, workspace, admission, appServer, ...isolation });
    const laneRecovery = lanes.recover({ retentionHours: laneRetentionHours(process.env.CODEX_A2A_LANE_RETENTION_HOURS) });
    const worktreeMode = isolation.mode === 'worktree' || isolation.mode === 'cooperative';
    const actualPort = httpServer?.address()?.port ?? port;
    const baseUrl = `http://${HOST}:${actualPort}`;
    // Per-project role overrides (model, effort, extra rules) are read once here; they are edited only while the server is stopped.
    const { roles, leadRole } = loadEffectiveRoles({
      file: roleOverridesFile,
      roles: baseRoles,
      leadRole: createLeadRole(profilesDir ? { profilesDir } : undefined),
      warn: (message) => console.warn(`[roles] ${message}`),
    });
    const usageLedger = new UsageLedger({ db: state.db });
    const stagingLog = new StagingLog({ db: state.db });
    const evidenceStore = createEvidenceStore(state.db);
    const activityStore = createActivityStore(state.db);
    const sessionThreads = new SessionThreads({ db: state.db });
    const legacyOrchestrator = orchestratorFactory({
      appServer, roles, workspace, baseUrl, authToken, leadRole, skillCatalog, mcpCatalog,
      aut03TrialRunIds,
      aut03LeadSkillEnabled,
      checkpointer: state.checkpointer, journal: dispatchJournal, admission, usageLedger, stagingLog, activityStore, evidenceStore, sessionThreads,
      parallelWriters: worktreeMode,
      ...(acceptanceScratch ? { acceptanceScratch } : {}),
      executionPermissions,
    });
    if (!legacyOrchestrator || typeof legacyOrchestrator !== 'object') throw new TypeError('Legacy orchestrator must be an object');
    const legacyEngine = Object.create(legacyOrchestrator);
    legacyEngine.run = typeof legacyOrchestrator.run === 'function'
      ? legacyOrchestrator.run.bind(legacyOrchestrator)
      : async () => { throw new TypeError('Legacy orchestrator does not implement run'); };
    legacyEngine.resume = typeof legacyOrchestrator.resume === 'function'
      ? legacyOrchestrator.resume.bind(legacyOrchestrator)
      : async () => { throw Object.assign(new Error('No stored legacy run'), { name: 'RunNotFoundError' }); };
    const protectedRoleApp = protectRoleRpcMounts(app, authMiddleware);
    const specialistAgents = registerRoleAgents(protectedRoleApp, {
      roles, appServer, workspace, baseUrl, admission, usageLedger, activityStore, skillCatalog, mcpCatalog,
      executionPermissions,
      stagingLog,
      lanes: worktreeMode ? lanes : null,
      taskStoreFactory: (roleId) => createTaskStore(state, roleId),
    });
    const deliveryEngine = projectSettings.deliveryEngine || 'legacy';
    const needsConcurrentEngine = deliveryEngine === 'concurrent-v1' || storedMappings.hasConcurrent;
    let concurrentEngine = null;
    let concurrentRecoveryResults = [];
    if (needsConcurrentEngine) {
      if (!['worktree', 'cooperative'].includes(isolation.mode)) {
        throw Object.assign(new Error(`Concurrent delivery requires a supported lane isolation mode (${isolation.reason || isolation.mode})`), {
          code: 'concurrent_lane_isolation_required',
        });
      }
      const settledHome = (typeof appServer.getCodexHome === 'function' ? appServer.getCodexHome() : null)
        || accountProfiles.activeHome() || accountProfiles.codexDefaultHome;
      const identityPin = providerIdentityPinFactory(settledHome);
      if (!identityPin?.providerIdentity || typeof identityPin.providerIdentityFor !== 'function') {
        throw new TypeError('Provider identity pin factory must return a pinned identity and fresh synchronous getter');
      }
      const storageRoot = deliveryStorageRoot
        ? path.resolve(deliveryStorageRoot)
        : path.join(os.homedir(), '.codex-agent-control-plane', 'projects', normalizedProjectId);
      concurrentEngine = concurrentEngineFactory({
        db: state.db, workspace, projectId: normalizedProjectId, stateFile: state.filePath, storageRoot,
        baseUrl, authMiddleware, authToken, appServer,
        providerIdentity: identityPin.providerIdentity, providerIdentityFor: identityPin.providerIdentityFor,
        roles, leadRole, admission, lanes, writerIsolation: isolation, executionPermissions,
        acceptanceScratch, evidenceStore,
      });
      startupConcurrentEngine = concurrentEngine;
      concurrentEngine.register(protectedRoleApp);
      if (typeof concurrentEngine.recoverInterruptedShutdown === 'function') {
        await concurrentEngine.recoverInterruptedShutdown();
      }
      concurrentRecoveryResults = await concurrentEngine.recoverStoredRuns();
    }
    const mappedConcurrentTaskIds = new Set(storedMappings.concurrentRunIds);
    const legacyTaskIds = new Set([
      ...[...startupLeadTaskIds].filter((taskId) => !mappedConcurrentTaskIds.has(taskId)),
      ...storedMappings.legacyRunIds,
    ]);
    const canRunEngine = ({ engine, runId }) => deliveryEngineFence({ db: state.db, workspace,
      projectId: normalizedProjectId, engine, runId, legacyTaskIds,
      concurrentRecoveryUnsafe: concurrentRecoveryResults.some((item) => item.state === 'unknown') });
    let orchestrator = new DeliveryEngineRouter({
      db: state.db, projectId: normalizedProjectId, defaultEngine: deliveryEngine,
      legacyEngine, concurrentEngine, canRunEngine,
    });
    const leadTaskStore = createTaskStore(state, 'orchestrator');
    const transientRecoveryStore = createTransientRecoveryStore(state.db);
    const transientRecovery = transientRecoveryFactory({
      store: transientRecoveryStore,
      onState: (taskId, record) => persistTransientRecoveryStatus({ db: state.db, recoveryStore: transientRecoveryStore, taskId, record }),
      canResume: async (taskId, record) => {
        const task = await leadTaskStore.load(taskId, {});
        if (!task || task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) return false;
        const taskPause = task.metadata?.pause;
        if (taskPause?.kind && !['transient_recovery', 'restart'].includes(taskPause.kind)) return false;
        if (await orchestrator.getPause?.(taskId)) return false;
        const checkpoint = await orchestrator.getRecoveryCheckpoint?.(taskId);
        return Boolean(checkpoint?.checkpointId === record.checkpoint_id
          && checkpoint.next.length === 1 && checkpoint.next[0] === 'decide'
          && checkpoint.unresolvedWriters === 0 && !leadAgent.executor.isTaskActive(taskId));
      },
      resumeRun: (taskId, record, signal) => resumeTransientRun({
        taskId, record, baseUrl, authToken, taskStore: leadTaskStore, orchestrator,
        executor: () => leadAgent.executor, loopback, signal,
      }),
    });
    let budgetWatcher = null;
    let closeCompleted = false;
    let closeInProgress = null;
    const loopback = { client: null };
    if (autoResume) {
      const models = new Set([...roles.values()].map((role) => role.model).filter(Boolean));
      if (leadRole.model) models.add(leadRole.model);
      budgetWatcher = createBudgetWatcher({
        models: [...models],
        readRateLimits: async () => (typeof appServer.readRateLimits === 'function' ? appServer.readRateLimits() : null),
        listPausedRuns: () => listBudgetPausedRuns({ state, taskStore: leadTaskStore, orchestrator }),
        resumeRun: (taskId, reason) => resumeBudgetRun({ taskId, reason, baseUrl, authToken, taskStore: leadTaskStore, orchestrator, executor: () => leadAgent.executor, loopback }),
        // Automatic account switching needs the wrapper; an injected App Server stays on its account.
        accounts: switching ? {
          profiles: accountProfiles,
          switchTo: (...args) => switching.switchTo(...args),
          readProfileLimits,
          ...(readProfileState || readProfileLimits === readLimitsOfHome
            ? { readProfileState: readProfileState || readAccountStateOfHome } : {}),
          watch: (onChange) => {
            fs.watchFile(accountProfiles.filePath, { interval: 2000, persistent: false }, onChange);
            return () => fs.unwatchFile(accountProfiles.filePath, onChange);
          },
          canSwitch: (taskId) => budgetRunResumable({ taskId, taskStore: leadTaskStore, orchestrator, executor: () => leadAgent.executor }),
        } : null,
        ...budgetWatcherOptions,
      });
    }
    const leadAgent = registerLead(app, {
      leadRole, orchestrator, baseUrl, authMiddleware, taskStore: leadTaskStore, budgetWatcher,
      transientRecovery, autoResume, ownerChecks, legacyTaskIds,
      objectiveBinding: { projectId: normalizedProjectId, workspace: fs.realpathSync(workspace) },
    });
    registerControl(app, { authMiddleware, orchestrator, runtimeIdentity, transientRecovery });
    registerDeliveryHostControls(app, { authMiddleware, router: orchestrator });
    ready = true;
    budgetWatcher?.start();
    if (autoResume) transientRecovery.start();
    return {
      app,
      httpServer,
      appServer,
      accountProfiles,
      switchingAppServer: switching,
      projectId: normalizedProjectId,
      deliveryEngine,
      orchestrator,
      concurrentEngine,
      state,
      roles,
      specialistAgents,
      leadAgent,
      budgetWatcher,
      // Effective writer mode and why; `lanes.status()` reflects later re-probes.
      writerIsolation: { ...lanes.status(), recovery: laneRecovery },
      lanes,
      host: HOST,
      port: actualPort,
      async close() {
        if (closeCompleted) return;
        if (closeInProgress) return closeInProgress;
        closeInProgress = (async () => {
          shuttingDown = true;
          concurrentEngine?.fenceShutdown();
          ready = false;
          budgetWatcher?.stop();
          transientRecovery.stop();
          leadAgent.executor.cancelAll();
          if (concurrentEngine) {
            const drain = Promise.allSettled([leadAgent.executor.settled(), transientRecovery.drain()]).then(() => true);
            if (await bounded(drain, SHUTDOWN_TIMEOUT_MS) !== true) {
              throw Object.assign(new Error('Server work did not drain safely; state and workspace locks remain held'), { code: 'server_shutdown_drain_unsafe' });
            }
          } else {
            await waitForShutdownWork(leadAgent.executor, transientRecovery, SHUTDOWN_TIMEOUT_MS);
          }
          await new Promise((resolve) => setImmediate(resolve));
          if (concurrentEngine) {
            if (!concurrentShutdownPromise) {
              const operation = (async () => {
                await orchestrator.prepareShutdown();
                concurrentEngine.beginProviderShutdown();
                if (!providerShutdownPromise) providerShutdownPromise = Promise.resolve().then(() => appServer.close?.());
                await providerShutdownPromise;
                const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
                for (;;) {
                  try { return await concurrentEngine.finishShutdown(); }
                  catch (error) {
                    if (!['concurrent_shutdown_process_alive', 'delivery_role_shutdown_process_alive'].includes(error.code)
                      || Date.now() >= deadline) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                  }
                }
              })();
              concurrentShutdownPromise = operation;
              operation.catch(() => { if (concurrentShutdownPromise === operation) concurrentShutdownPromise = null; });
            }
            if ((await bounded(concurrentShutdownPromise, SHUTDOWN_TIMEOUT_MS))?.safeToRelease !== true) {
              throw Object.assign(new Error('Concurrent engine shutdown is still draining; state and workspace locks remain held'), { code: 'concurrent_shutdown_unsafe' });
            }
          } else {
            await orchestrator.shutdown();
            if (await bounded(Promise.resolve().then(() => appServer.close?.()).then(() => true), SHUTDOWN_TIMEOUT_MS) !== true) {
              throw Object.assign(new Error('App Server shutdown did not settle; state and workspace locks remain held'), { code: 'app_server_shutdown_unsafe' });
            }
          }
          if (httpServer) await closeHttpServer(httpServer);
          if (ownsState) await state.close();
          releaseLock();
          releaseWorkspaceLock();
          closeCompleted = true;
        })();
        try { await closeInProgress; } finally { closeInProgress = null; }
      },
    };
  } catch (error) {
    if (quarantineDb?.open) { try { quarantineDb.close(); } catch (_) {} }
    let cleanupSafe = true;
    const startupRecoveryRefused = error?.code === 'concurrent_startup_recovery_unsafe';
    if (startupConcurrentEngine && !startupRecoveryRefused) {
      try { cleanupSafe = (await startupConcurrentEngine.shutdown())?.safeToRelease === true; }
      catch (_) { cleanupSafe = false; }
    }
    if (cleanupSafe) {
      try {
        cleanupSafe = !providerStarted || await bounded(Promise.resolve().then(() => appServer.close?.()).then(() => true), SHUTDOWN_TIMEOUT_MS) === true;
      } catch (_) { cleanupSafe = false; }
    }
    if (cleanupSafe) {
      if (httpServer) await closeHttpServer(httpServer);
      if (state && ownsState) { try { await state.close(); } catch (_) { cleanupSafe = false; } }
    }
    if (cleanupSafe) {
      releaseLock(); stateLockAcquired = false;
      releaseWorkspaceLock(); workspaceLockAcquired = false;
    } else {
      shuttingDown = true;
    }
    throw error;
  }
}

/** Lead tasks waiting in INPUT_REQUIRED on an automatic budget or authentication pause. */
async function listBudgetPausedRuns({ state, taskStore, orchestrator }) {
  const rows = state.db.prepare('SELECT tenant, id FROM tasks WHERE owner = ? AND status_state = ? ORDER BY id')
    .all('orchestrator', 'TASK_STATE_INPUT_REQUIRED');
  const paused = [];
  for (const { id } of rows) {
    let pause = null;
    try { pause = (await orchestrator.getPause?.(id)) || null; } catch (_) { pause = null; }
    if (pause?.kind === 'waiting_for_budget' || pause?.kind === 'waiting_for_auth') paused.push({ runId: id, pause });
  }
  return paused;
}

/** The task when it is INPUT_REQUIRED on a recoverable account pause and not executing; otherwise null. */
async function budgetRunResumable({ taskId, taskStore, orchestrator, executor, expectedKind = null }) {
  const task = await taskStore.load(taskId, {});
  if (!task || task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) return null;
  const pause = (await orchestrator.getPause?.(taskId)) || null;
  if (!['waiting_for_budget', 'waiting_for_auth'].includes(pause?.kind)) return null;
  if (expectedKind && pause.kind !== expectedKind) return null;
  if (executor().isTaskActive(taskId)) return null;
  return task;
}

/** Reads the rate limits of one account home through a short-lived App Server (null home: the system account). */
async function readLimitsOfHome(home) {
  const server = new CodexAppServer(home ? { codexHome: home } : {});
  try {
    return await server.readRateLimits();
  } finally {
    try { await server.close(); } catch (_) { /* best effort */ }
  }
}

/** Reads explicit account auth state separately from model availability; null limits stay unknown. */
async function readAccountStateOfHome(home) {
  const server = new CodexAppServer(home ? { codexHome: home } : {});
  try {
    const [accountResult, limitsResult] = await Promise.allSettled([server.getAccount(), server.readRateLimits()]);
    const state = { limits: limitsResult.status === 'fulfilled' ? limitsResult.value : null };
    if (accountResult.status === 'fulfilled' && typeof accountResult.value?.requiresOpenaiAuth === 'boolean') {
      state.requiresOpenaiAuth = accountResult.value.requiresOpenaiAuth;
    } else if (accountResult.status === 'rejected' && classifyTransientFailure(accountResult.reason).category === 'auth') {
      state.requiresOpenaiAuth = true;
    }
    return state;
  } finally {
    try { await server.close(); } catch (_) { /* best effort */ }
  }
}

/**
 * Resumes a budget-paused lead task through the same A2A message/send a human uses (loopback, bearer token).
 * Returns false when the task is no longer waiting for budget; a message to a task that is already
 * executing is also rejected server-side by rejectOverlappingLeadTask.
 */
async function resumeBudgetRun({ taskId, reason = 'budget', baseUrl, authToken, taskStore, orchestrator, executor, loopback }) {
  const task = await budgetRunResumable({ taskId, taskStore, orchestrator, executor,
    expectedKind: reason === 'auth' ? 'waiting_for_auth' : 'waiting_for_budget' });
  if (!task) return false;
  if (!loopback.client) loopback.client = await new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json');
  await loopback.client.sendMessage({
    tenant: '',
    message: {
      messageId: `auto-resume-${taskId}-${Date.now()}`,
      contextId: task.contextId || '',
      taskId,
      role: 1,
      parts: [textPart(reason === 'auth' ? AUTO_AUTH_RESUME_TEXT : AUTO_RESUME_TEXT)],
      metadata: { autoResume: { reason } },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
    metadata: undefined,
  }, { serviceParameters: { Authorization: `Bearer ${authToken}` } });
  return true;
}

async function resumeTransientRun({ taskId, record, baseUrl, authToken, taskStore, orchestrator, executor, loopback, signal }) {
  if (signal?.aborted) return false;
  const task = await taskStore.load(taskId, {});
  if (signal?.aborted) return false;
  if (!task || task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED || executor().isTaskActive(taskId)) return false;
  const taskPause = task.metadata?.pause;
  if (taskPause?.kind && !['transient_recovery', 'restart'].includes(taskPause.kind)) return false;
  if (await orchestrator.getPause?.(taskId)) return false;
  if (signal?.aborted) return false;
  const checkpoint = await orchestrator.getRecoveryCheckpoint?.(taskId);
  if (signal?.aborted) return false;
  if (!checkpoint || checkpoint.checkpointId !== record.checkpoint_id || checkpoint.next.join(',') !== 'decide'
    || checkpoint.unresolvedWriters !== 0) return false;
  if (!loopback.client) loopback.client = await new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json');
  if (signal?.aborted) return false;
  await loopback.client.sendMessage({
    tenant: '',
    message: {
      messageId: `auto-recovery-${taskId}-${Date.now()}`,
      contextId: task.contextId || '',
      taskId,
      role: 1,
      parts: [textPart('Continue the existing run from its current checkpoint after a transient service failure.')],
      metadata: { autoResume: { reason: 'transient_recovery', attempt: record.attempts, checkpointId: record.checkpoint_id } },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
    metadata: undefined,
  }, { serviceParameters: { Authorization: `Bearer ${authToken}` }, signal });
  return true;
}

function bounded(promise, timeoutMs) {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve(promise);
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

function waitForShutdownWork(executor, recovery, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return bounded(Promise.allSettled([executor.settled(), recovery.drain()]), timeoutMs);
}

function closeHttpServer(server) {
  let timer;
  const closed = new Promise((resolve) => {
    server.close(() => resolve());
  });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([closed, timeout]).finally(() => clearTimeout(timer));
}

if (require.main === module) {
  startServer().then((server) => {
    process.stdout.write(`Codex Universal A2A listening at http://${server.host}:${server.port}\n`);
    const shutdown = () => server.close().finally(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TOTAL_MS, startServer, projectIdForWorkspace, inspectConcurrentStartupQuarantine, describePause, persistTransientRecoveryStatus, waitForShutdownWork, makeLeadExecutor, extractGoal, makeLeadCard, registerLead, registerControl, rejectOverlappingLeadTask, protectRoleRpcMounts, migrateLegacyRecoveryQuestion };
