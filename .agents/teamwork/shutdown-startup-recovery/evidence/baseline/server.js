'use strict';

const { createRuntimeIdentity } = require('./runtime-identity');
const runtimeIdentity = globalThis[Symbol.for('codex.server.runtimeIdentity')] || createRuntimeIdentity();
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const { openStateDatabase, createTaskStore, DispatchJournal, reconcileInterruptedTasks, acquireStateLock, acquireWorkspaceLock } = require('./durable-store');
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
runtimeIdentity.seal();

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
// close() waits up to SHUTDOWN_TIMEOUT_MS for the runs to settle, then up to the same for the app server and HTTP close.
const SHUTDOWN_TOTAL_MS = 2 * SHUTDOWN_TIMEOUT_MS;
const AUTO_RESUME_TEXT = 'Automatic resume: Codex usage budget is available again.';
const TERMINAL_STORED_TASK_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']);

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

function concurrentRunSettled(db, projectId, mapping) {
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
    const turns = db.prepare('SELECT status FROM delivery_planner_turns WHERE project_id=? AND session_id=?')
      .all(projectId, mapping.session_id);
    if (turns.some((turn) => !['complete', 'stale', 'reconciled_no_effect'].includes(turn.status))) return 'unsafe';
  }
  if (!['accepted', 'partial', 'canceled'].includes(objective.disposition)) {
    return ['planning', 'executing', 'paused_owner', 'waiting_owner', 'waiting_budget'].includes(objective.disposition) ? 'busy' : 'unsafe';
  }
  const attempts = db.prepare('SELECT terminal_digest FROM backlog_attempts WHERE project_id=? AND objective_id=?').all(projectId, mapping.objective_id);
  if (attempts.some((attempt) => typeof attempt.terminal_digest !== 'string' || !attempt.terminal_digest)) return 'unsafe';
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
      if (!['applied', 'refused', 'not_applied'].includes(publication.state)) return 'unsafe';
      const intent = hasTable(db, 'candidate_intents')
        ? db.prepare('SELECT project_id,objective_id,state FROM candidate_intents WHERE intent_id=?').get(publication.intent_id)
        : null;
      if (!intent) {
        if (publication.state !== 'refused') return 'unsafe';
      } else if (intent.project_id !== projectId || intent.objective_id !== mapping.objective_id
        || !['applied', 'refused', 'not_applied'].includes(intent.state)) return 'unsafe';
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
    if (pause.recoveryExhausted) lines.push(`Automatic recovery exhausted after ${pause.attempts} attempts.`);
    else if (pause.ownerPauseRequested) lines.push('Automatic recovery is paused by the owner. Use the pause control to resume it, or send a message to continue manually.');
    else if (pause.recoveryState === 'dispatched') lines.push('The server is submitting this automatic recovery attempt.');
    else if (pause.automatic !== true) lines.push('Automatic recovery is disabled or unsafe for this checkpoint; send a message to retry manually.');
    else lines.push('The server will retry this checkpoint automatically.');
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
      recoveryExhausted: record.state === 'exhausted',
      ownerPauseRequested: record.state === 'owner_paused',
      automatic: ['waiting', 'dispatched'].includes(record.state),
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
function makeLeadExecutor({ orchestrator, loadTask, durabilityTimeoutMs = 2000, budgetWatcher = null, transientRecovery = null, autoResume = true, ownerChecks = null, legacyTaskIds = new Set() }) {
  const controllers = new Map();
  const reservations = new Set();
  const inflight = new Set();

  // Registers a budget pause with the watcher before describing it, so the text can name the next check.
  function describePauseText(taskId, pause) {
    if (!budgetWatcher) return describePause(taskId, pause);
    if (pause?.kind === 'waiting_for_budget') {
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
    const task = requestContext.task || {
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [],
      metadata: {},
    };
    const resuming = requestContext.task?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED;
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
        try { livePause = (await orchestrator.getPause?.(taskId)) || null; } catch (_) { livePause = null; }
        // The checkpoint is authoritative; the stored task metadata is only a fallback.
        effectivePause = livePause || requestContext.task.metadata?.pause || null;
      }
      const pauseKind = effectivePause?.kind;
      const automaticResume = requestContext.userMessage?.metadata?.autoResume;
      const automaticBudget = automaticResume?.reason === 'budget';
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
        metadata: resuming ? { pause: null } : (hasContract(contract) ? { acceptanceContract: contract } : {}),
      }));
      if (!resuming && hasContract(contract) && loadTask) {
        // Nothing may execute until the pinned contract is readable from the store.
        const deadline = Date.now() + durabilityTimeoutMs;
        let durable = false;
        for (;;) {
          let stored = null;
          try { stored = await loadTask(taskId); } catch (_) { stored = null; }
          if (stored?.metadata?.acceptanceContract) { durable = true; break; }
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
          const resumeOrigin = ['budget', 'transient_recovery'].includes(automaticResume?.reason) ? 'automatic' : 'owner';
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
          recoveryExhausted: record.state === 'exhausted',
          automatic: record.state === 'waiting',
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

function registerLead(app, { leadRole, orchestrator, baseUrl, authMiddleware, taskStore = new InMemoryTaskStore(), budgetWatcher = null, transientRecovery = null, autoResume = true, ownerChecks = null, legacyTaskIds = new Set() }) {
  const endpoint = new URL('/orchestrator', `${baseUrl}/`).toString();
  const card = makeLeadCard({ leadRole, endpoint });
  const executor = makeLeadExecutor({ orchestrator, loadTask: (id) => taskStore.load(id, {}), budgetWatcher, transientRecovery, autoResume, ownerChecks, legacyTaskIds });
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
  const switching = injectedAppServer ? null : createSwitchingAppServer({
    profiles: accountProfiles,
    ...(appServerFactory ? { create: appServerFactory } : {}),
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
  try {
    await appServer.start?.();
    const accountResult = await appServer.getAccount();
    const account = accountResult?.account || accountResult;
    if (account?.type !== 'chatgpt') throw new Error('Codex Universal requires an authenticated ChatGPT account via Codex OAuth.');

    if (!state) state = await openStateDatabase(stateFile ? { filePath: stateFile } : undefined);
    if (ownsState) releaseLock = acquireStateLock(state.filePath);
    releaseWorkspaceLock = acquireWorkspaceLock(workspace, workspaceLockDir ? { lockDir: workspaceLockDir } : undefined);
    const startupLeadTaskIds = new Set(state.db.prepare('SELECT id FROM tasks WHERE owner=?').all('orchestrator').map((row) => row.id));
    const storedMappings = storedDeliveryMappings(state.db, normalizedProjectId);

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
      checkpointer: state.checkpointer, journal: new DispatchJournal(state), admission, usageLedger, stagingLog, activityStore, evidenceStore, sessionThreads,
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
        resumeRun: (taskId) => resumeBudgetRun({ taskId, baseUrl, authToken, taskStore: leadTaskStore, orchestrator, executor: () => leadAgent.executor, loopback }),
        // Automatic account switching needs the wrapper; an injected App Server stays on its account.
        accounts: switching ? {
          profiles: accountProfiles,
          switchTo: (name) => switching.switchTo(name),
          readProfileLimits,
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
    let cleanupSafe = true;
    if (startupConcurrentEngine) {
      try { cleanupSafe = (await startupConcurrentEngine.shutdown())?.safeToRelease === true; }
      catch (_) { cleanupSafe = false; }
    }
    if (cleanupSafe) {
      try {
        cleanupSafe = await bounded(Promise.resolve().then(() => appServer.close?.()).then(() => true), SHUTDOWN_TIMEOUT_MS) === true;
      } catch (_) { cleanupSafe = false; }
    }
    if (cleanupSafe) {
      if (httpServer) await closeHttpServer(httpServer);
      if (state && ownsState) { try { await state.close(); } catch (_) { cleanupSafe = false; } }
    }
    if (cleanupSafe) {
      releaseLock();
      releaseWorkspaceLock();
    } else {
      shuttingDown = true;
    }
    throw error;
  }
}

/** Lead tasks waiting in INPUT_REQUIRED whose checkpoint pause is waiting_for_budget. */
async function listBudgetPausedRuns({ state, taskStore, orchestrator }) {
  const rows = state.db.prepare('SELECT tenant, id FROM tasks WHERE owner = ? AND status_state = ? ORDER BY id')
    .all('orchestrator', 'TASK_STATE_INPUT_REQUIRED');
  const paused = [];
  for (const { id } of rows) {
    let pause = null;
    try { pause = (await orchestrator.getPause?.(id)) || null; } catch (_) { pause = null; }
    if (pause?.kind === 'waiting_for_budget') paused.push({ runId: id, pause });
  }
  return paused;
}

/** The task when it is INPUT_REQUIRED on a budget pause and not executing; otherwise null. */
async function budgetRunResumable({ taskId, taskStore, orchestrator, executor }) {
  const task = await taskStore.load(taskId, {});
  if (!task || task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) return null;
  const pause = (await orchestrator.getPause?.(taskId)) || null;
  if (pause?.kind !== 'waiting_for_budget') return null;
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

/**
 * Resumes a budget-paused lead task through the same A2A message/send a human uses (loopback, bearer token).
 * Returns false when the task is no longer waiting for budget; a message to a task that is already
 * executing is also rejected server-side by rejectOverlappingLeadTask.
 */
async function resumeBudgetRun({ taskId, baseUrl, authToken, taskStore, orchestrator, executor, loopback }) {
  const task = await budgetRunResumable({ taskId, taskStore, orchestrator, executor });
  if (!task) return false;
  if (!loopback.client) loopback.client = await new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json');
  await loopback.client.sendMessage({
    tenant: '',
    message: {
      messageId: `auto-resume-${taskId}-${Date.now()}`,
      contextId: task.contextId || '',
      taskId,
      role: 1,
      parts: [textPart(AUTO_RESUME_TEXT)],
      metadata: { autoResume: { reason: 'budget' } },
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

module.exports = { SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TOTAL_MS, startServer, projectIdForWorkspace, describePause, persistTransientRecoveryStatus, waitForShutdownWork, makeLeadExecutor, extractGoal, makeLeadCard, registerLead, registerControl, rejectOverlappingLeadTask, protectRoleRpcMounts };
