'use strict';

const crypto = require('node:crypto');
const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const express = require('express');
const Database = require('better-sqlite3');
const {
  WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT, classifyCodexError, findCodexErrorInfo,
  BoundaryViolation, checkSpecialistRequest, parseWorkerReport, pathsOutsideAllowed,
} = require('./contracts');
const { WriterAdmission } = require('./writer-admission');
const { loadSkillCatalog, resolveSkillSelection } = require('./skill-catalog');
const { canonicalRoleId, legacyRoleId, roleDisplayName } = require('./role-names');
const { deterministicContextId } = require('./durable-store');
const { POLICY_ID, computeReviewTarget, reviewResult } = require('./review-policy');
const { InMemoryStagingLog } = require('./staging-log');

function displayRoleName(roleId, role) {
  return role.displayName || (canonicalRoleId(roleId) === roleId && role.name !== roleId ? role.name : roleDisplayName(roleId));
}

const DEFAULT_RECONCILE_RETRY = { intervalMs: 250, totalMs: 5000 };

function roleSlug(roleId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(roleId)) {
    throw new TypeError(`Invalid role id "${roleId}"; expected a lowercase slug`);
  }
  return roleId;
}

function extractText(message) {
  if (!Array.isArray(message?.parts) || message.parts.length === 0) {
    throw new Error('Unsupported input: provide at least one text part.');
  }

  const texts = [];
  for (const part of message.parts) {
    if (part?.content?.$case === 'text' && typeof part.content.value === 'string') {
      texts.push(part.content.value);
    } else if (typeof part?.text === 'string') {
      // Accept the JSON Schema form used by some A2A clients as well as the SDK
      // protobuf JSON representation.
      texts.push(part.text);
    } else {
      throw new Error('Unsupported input part: this agent accepts text parts only.');
    }
  }
  return texts.join('\n');
}

function assignmentSkillSelection(text, skillCatalog) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return [];
  let value;
  try { value = JSON.parse(text); } catch (_) {
    if (/(?:^|[,\s{])(?:"skills"|'skills'|skills|"skillPins"|'skillPins'|skillPins)\s*:/.test(text)) {
      throw new Error('Structured assignment skill fields must be valid JSON.');
    }
    return [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const hasSkills = Object.hasOwn(value, 'skills');
  const hasPins = Object.hasOwn(value, 'skillPins');
  if (!hasSkills && !hasPins) return [];
  const skills = hasSkills ? value.skills : [];
  if (!Array.isArray(skills) || skills.length > 5
    || skills.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(skills).size !== skills.length) {
    throw new Error('skills must contain at most 5 unique non-empty skill IDs.');
  }
  let pins;
  if (hasPins) {
    pins = value.skillPins;
    if (!Array.isArray(pins) || pins.length !== skills.length || pins.some((pin) => !pin || typeof pin !== 'object'
      || Array.isArray(pin) || Object.keys(pin).sort().join(',') !== 'id,sha256'
      || typeof pin.id !== 'string' || typeof pin.sha256 !== 'string')) {
      throw new Error('skillPins must exactly match skills with id and sha256 fields.');
    }
  }
  return resolveSkillSelection(skillCatalog, skills, pins === undefined ? {} : { pins });
}

const BOUNDARY_CONTRACT = 'boundary-contract/v1';
const PINNED_CHECK_READ_ONLY_ROLES = new Set(['architect', 'explorer', 'scout']);

// A structured request is a JSON object carrying both objective and allowedFiles, or requireAcceptance; returns it or null.
function parseStructuredRequest(text) {
  if (!text.trimStart().startsWith('{')) return null;
  let value;
  try { value = JSON.parse(text); } catch (_) { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.requireAcceptance) return value;
  return Object.hasOwn(value, 'objective') && Object.hasOwn(value, 'allowedFiles') ? value : null;
}

function boundaryRecord(predicate, result, code, boundary, detail, advisory = false, evidence = []) {
  return { predicate, result, code, boundary, detail: String(detail).slice(0, 500), evidence, advisory };
}

function isSupervisorExhausted(error) {
  return error?.failureClass === 'supervisor_exhausted' || error?.code === 'supervisor_exhausted';
}

function failureMetadata(error) {
  const classified = error ? classifyCodexError(error) : 'other';
  return {
    failureKind: isSupervisorExhausted(error)
      ? 'supervisor_exhausted'
      : classified === 'usage_limit'
        ? classified
        : error?.outcomeUnknown === true ? 'interrupted' : classified,
    codexErrorInfo: error ? findCodexErrorInfo(error) : null,
    // Restart budget exhausted: no child was spawned and no turn started.
    ...(isSupervisorExhausted(error) ? { effects: 'none' } : {}),
  };
}

const CONTINUE_INPUT = 'The usage limit has reset. Continue the assignment from where you stopped.';
const AUDIT_REPORT_GUIDANCE = [
  'Audit report contract:',
  'Begin the summary with exactly one complete first line: VERDICT: pass, VERDICT: fail, or VERDICT: inconclusive.',
  'List only required checks actually performed, or explicit validation steps for cited prior evidence, in checks. State what was actually run or validated; never describe reused tests as freshly executed.',
  'Record supplemental diagnostics, forbidden or unrun excluded tests, and reused verifier evidence in risks, with the exact command/result or evidence artifact and the limitation.',
  'Do not move an assigned failed or unrun check into risks to obtain a pass. Do not invent runs.',
].join('\n');
const PINNED_CHECK_REPORT_GUIDANCE = [
  'Pinned-check integrity report contract:',
  'Begin the summary with exactly one complete first line: VERDICT: preserve or VERDICT: weaken.',
  'Use this preserve/weaken verdict only for the pinned check under review.',
].join('\n');
const CUT_OFF_NOTE = 'A previous attempt at this assignment was cut off by a usage limit; its partial changes are already in the working directory. Inspect them and finish the assignment.';
const CUT_OFF_LANE_LOST_NOTE = 'A previous attempt at this assignment was cut off by a usage limit; its working copy could not be reused, so its partial changes are not available. Start the assignment again.';

// LL-5: the lead re-dispatched a scope-stopped attempt with a new allowedFiles.
const scopeResumeInput = (allowedFiles, input) => `The lead expanded your scope; allowedFiles is now: ${JSON.stringify(allowedFiles)}. Continue the assignment from where you stopped.\n${input}`;
const SCOPE_FRESH_NOTE = 'A previous attempt at this assignment stopped because a needed file was outside its allowedFiles; the lead expanded the scope. Inspect the working directory for its partial changes and finish the assignment.';
const SCOPE_FRESH_LANE_LOST_NOTE = 'A previous attempt at this assignment stopped because a needed file was outside its allowedFiles; the lead expanded the scope. Its working copy could not be reused, so its partial changes are not available. Start the assignment again.';

// The assignment text without the lead's continuation key (a fresh thread must not see it).
function withoutContinuation(input) {
  try {
    const value = JSON.parse(input);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'continuation')) {
      const { continuation: _drop, ...rest } = value;
      return JSON.stringify(rest);
    }
  } catch (_) { /* not JSON: keep as is */ }
  return input;
}

function makeStatus(state, message) {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  };
}

function makeRoleCard({ roleId, role, endpoint }) {
  const skillId = roleId;
  return {
    name: displayRoleName(roleId, role),
    description: role.description,
    supportedInterfaces: [{
      url: endpoint,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: '',
    }],
    provider: { url: endpoint, organization: 'Codex Universal' },
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'Bearer token required for A2A JSON-RPC requests.',
            scheme: 'Bearer',
            bearerFormat: 'opaque',
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: skillId,
      name: displayRoleName(roleId, role),
      description: role.description,
      tags: [roleId],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    }],
    signatures: [],
  };
}

let ledgerWarned = false;

// Build the worker-turn ledger entry from a run result or thrown error. Absent usage -> nulls.
function workerUsageEntry({ roleId, taskId, contextId, source, outcome, retries, queueWaitMs = null }) {
  const usage = source?.usage || null;
  const turnId = source?.execution?.turnId || source?.turnId || null;
  return {
    entryId: turnId ? `${roleId}:${taskId}:${turnId}` : `${roleId}:${taskId}`,
    kind: 'worker_turn',
    runId: null,
    role: roleId,
    taskId,
    contextId,
    attemptId: null,
    model: usage?.model ?? null,
    effort: usage?.effort ?? null,
    startedAt: usage?.startedAt ?? null,
    elapsedMs: usage?.elapsedMs ?? null,
    turns: usage?.turns ?? null,
    modelRequests: usage?.modelRequests ?? null,
    retries,
    tokens: usage?.tokens ?? null,
    tokenSource: usage?.tokenSource ?? 'unavailable',
    cumulativeTotal: usage?.cumulativeTotal ?? null,
    appServerVersion: usage?.appServerVersion ?? null,
    outcome,
    permissionEvents: Array.isArray(source?.permissionEvents) ? source.permissionEvents : [],
    startupMs: usage?.startupMs ?? null,
    coldStart: usage?.coldStart ?? null,
    queueWaitMs,
  };
}

// Attempt that ended before any App Server turn: no usage, no tokens, one explicit row.
function preTurnUsageEntry({ roleId, taskId, contextId, outcome, retries, elapsedMs, startedAt, queueWaitMs }) {
  return {
    entryId: `${roleId}:${taskId}:pre`,
    kind: 'worker_turn',
    runId: null,
    role: roleId,
    taskId,
    contextId,
    attemptId: null,
    model: null,
    effort: null,
    startedAt,
    elapsedMs,
    turns: 0,
    modelRequests: null,
    retries,
    tokens: null,
    tokenSource: 'unavailable',
    cumulativeTotal: null,
    appServerVersion: null,
    outcome,
    permissionEvents: [],
    startupMs: null,
    coldStart: null,
    queueWaitMs,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Best-effort lead run id for the activity row: message metadata, else a top-level JSON field.
function activityRunId(requestContext, input) {
  const direct = requestContext?.userMessage?.metadata?.runId;
  if (typeof direct === 'string' && direct) return direct;
  try {
    const value = typeof input === 'string' && input.trimStart().startsWith('{') ? JSON.parse(input) : null;
    const runId = value?.runId ?? value?.assignment?.runId;
    return typeof runId === 'string' && runId ? runId : null;
  } catch (_) {
    return null;
  }
}

function stagingEventId(event) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
  return `role-event:v1:${digest}`;
}

function stagingReportPayload(report) {
  if (!report) return { reportValid: false };
  const checks = (Array.isArray(report.checks) ? report.checks : []).slice(0, 50)
    .map((check, index) => ({ index, result: check?.result || 'unknown' }));
  const findings = (Array.isArray(report.risks) ? report.risks : []).slice(0, 20)
    .map((finding) => String(finding).slice(0, 500));
  return {
    reportValid: true,
    outcome: report.outcome,
    summary: String(report.summary || '').slice(0, 1200),
    findings,
    failedChecks: checks.filter((check) => check.result === 'failed'),
    unrunChecks: checks.filter((check) => check.result === 'not_run' || check.result === 'unknown'),
    attemptedRemedies: (Array.isArray(report.filesChanged) ? report.filesChanged : []).slice(0, 20).map((file) => String(file).slice(0, 300)),
  };
}

function messageCorrelations(requestContext) {
  const metadata = requestContext?.userMessage?.metadata || {};
  const taskId = typeof requestContext?.taskId === 'string' ? requestContext.taskId : null;
  const contextId = typeof requestContext?.contextId === 'string' ? requestContext.contextId : null;
  return {
    runId: typeof metadata.runId === 'string' && metadata.runId ? metadata.runId : null,
    assignmentId: typeof metadata.assignmentId === 'string' && metadata.assignmentId ? metadata.assignmentId : taskId,
    attemptId: typeof metadata.attemptId === 'string' && metadata.attemptId ? metadata.attemptId : contextId || taskId,
    taskId,
    contextId,
  };
}

function makeExecutor({
  roleId, role, appServer, workspace, admission, reconcileRetry = DEFAULT_RECONCILE_RETRY, usageLedger = null, activityStore = null, skillCatalog,
  lanes = null, stagingLog,
}) {
  const writable = role.sandbox !== 'read-only';
  const reservations = new Map();

  // Release the workspace when the outcome is known; otherwise mark the writer unresolved and
  // retry reconciliation while its process is being terminated. Returns writerExecution metadata.
  const settleWriter = async (executionId, known, reason) => {
    let outcome;
    let released = false;
    if (known) {
      try {
        outcome = admission.release(executionId);
        released = true;
      } catch (_) {
        reason = 'release_failed'; // e.g. a sqlite error: fall back to the unresolved path
      }
    }
    if (!released) {
      admission.markUnresolved(executionId, reason);
      const deadline = Date.now() + reconcileRetry.totalMs;
      outcome = await admission.reconcile(executionId);
      while (outcome.state === 'unresolved' && Date.now() < deadline) {
        await sleep(reconcileRetry.intervalMs);
        outcome = await admission.reconcile(executionId);
      }
    }
    const record = admission.get(executionId);
    return {
      executionId,
      state: record?.state ?? outcome.state,
      delta: record?.delta ?? outcome.delta ?? null,
      reason: record?.state === 'unresolved' ? (record.reason ?? outcome.reason ?? null) : null,
    };
  };

  const releaseReservation = (taskId, reservation) => {
    if (reservations.get(taskId) === reservation) reservations.delete(taskId);
  };
  const executor = {
    async execute(requestContext, eventBus) {
      const { taskId, contextId } = requestContext;
      const canonicalRole = canonicalRoleId(roleId);
      const auditRole = canonicalRole === 'auditor';
      const verifierRole = canonicalRole === 'verifier';
      const reviewRole = auditRole || verifierRole;
      const stagingIds = messageCorrelations(requestContext);
      let activeTask = reservations.get(taskId);
      if (activeTask?.entered) {
        throw new Error(`Task "${taskId}" already has an active Codex run.`);
      }
      if (!activeTask) {
        activeTask = { taskId, entered: false, terminal: false, cancelRequested: false };
        reservations.set(taskId, activeTask);
      }
      activeTask.entered = true;
      activeTask.contextId = contextId;
      activeTask.eventBus = eventBus;
      const controller = new AbortController();
      activeTask.controller = controller;
      const publishTerminalStatus = (state, message) => {
        if (activeTask.terminal) return;
        activeTask.terminal = true;
        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: makeStatus(state, message),
          metadata: {},
        }));
      };
      const task = requestContext.task || {
        id: taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: {},
      };

      // The SDK requires a task/message event before any status or artifact event.
      eventBus.publish(AgentEvent.task(task));
      let execution = null;
      let writer = null;
      let settled = false;
      // Worktree mode (docs/parallel-writers-design.md): the prepared lane, and whether its outcome is recorded.
      let lane = null;
      let laneDone = false;
      // Set once appServer.run was reached: { usage, permissionEvents, provenance }.
      let telemetry = null;
      let reviewContext = null;
      let reviewTargetBefore = null;
      let reviewOriginTarget = null;
      let pinnedCheckReviewer = false;
      let reviewExecution = null;
      let reviewExecutionSettled = false;
      let reviewOutcomeMetadata = null;
      let stagingWriteFailed = false;
      let stagingStarted = false;
      let selectedSkills = [];
      // BUD-2: how a continuation request was served ({ laneAdopted, laneFallback, threadResumed }), else null.
      let continued = null;
      // Thread of the last turn, published as continuation metadata for every finished turn.
      let seenThreadId = null;
      // laneId only while the lane row still exists, so an adopter can fall back cleanly.
      const continuationMetadata = () => (seenThreadId ? {
        continuation: {
          threadId: seenThreadId,
          laneId: lane && lanes?.store?.get?.(lane.id) ? lane.id : null,
          codexHome: appServer.getCodexHome?.() ?? null,
        },
      } : {});
      const failedMetadata = (error) => {
        const base = failureMetadata(error);
        return {
          ...base,
          ...continuationMetadata(),
          ...(continued ? { continued } : {}),
          ...(writer ? { writerExecution: writer } : {}),
          ...(telemetry ? telemetry : {}),
          ...(reviewOutcomeMetadata ? { reviewCoverage: reviewOutcomeMetadata.reviewCoverage, review: reviewOutcomeMetadata } : {}),
        };
      };
      const writeStaging = (type, status, payload = {}, { target = reviewTargetBefore?.identity || null, problemId = null, required = auditRole || pinnedCheckReviewer || (verifierRole && Boolean(reviewContext)) } = {}) => {
        if (!stagingLog) {
          if (required) {
            stagingWriteFailed = true;
            throw new Error('staging log unavailable');
          }
          return true;
        }
        const event = {
          type,
          ...stagingIds,
          role: canonicalRole,
          problemId,
          target,
          status,
          payload: { policyId: POLICY_ID, ...payload },
        };
        delete event.taskId;
        delete event.contextId;
        event.eventId = stagingEventId(event);
        try {
          stagingLog.record(event);
          return true;
        } catch (error) {
          if (required) {
            stagingWriteFailed = true;
            throw error;
          }
          return false;
        }
      };
      const targetForDirectReview = (review, structuredRequest) => computeReviewTarget({
        workspace,
        review,
        runId: stagingIds.runId,
        goal: structuredRequest?.objective || '',
        checks: [],
      });
      const originatingReviewTarget = (ofAttemptId, review, isPinnedCheck) => {
        if (!stagingLog || typeof stagingLog.list !== 'function') return null;
        const type = isPinnedCheck ? 'pinned_check_started' : 'audit_started';
        const events = stagingLog.list({
          ...(stagingIds.runId ? { runId: stagingIds.runId } : {}),
          type,
          limit: 10000,
        }).filter((event) => event.attemptId === ofAttemptId
          && event.payload?.checkpointId === review.checkpointId
          && typeof event.target === 'string');
        const targets = [...new Set(events.map((event) => event.target))];
        return targets.length === 1 ? targets[0] : null;
      };
      const setReviewOutcome = ({ status, accepted = false, valid = false, verdict = null, reason, targetAfter = null, targetIdentity, stable = false } = {}) => {
        const known = Boolean(reviewTargetBefore?.known && targetAfter?.known);
        reviewOutcomeMetadata = {
          policyId: POLICY_ID,
          kind: reviewContext?.kind || null,
          checkpointId: reviewContext?.checkpointId || null,
          status: status || 'inconclusive',
          accepted: Boolean(accepted),
          valid: Boolean(valid),
          verdict,
          reason: reason || null,
          reviewCoverage: {
            targetKnown: known,
            targetIdentity: known ? (targetIdentity || reviewTargetBefore.identity) : null,
            stable: Boolean(stable),
            reason: !known ? (reviewTargetBefore?.reason || targetAfter?.reason || 'review_target_unknown') : stable ? null : (reason || 'review_target_changed'),
          },
        };
        return reviewOutcomeMetadata;
      };
      const externalWriterHolder = () => {
        const holder = admission.holder();
        return holder && ['active', 'unresolved'].includes(holder.state)
          && holder.executionId !== reviewExecution?.executionId ? holder : null;
      };
      const settleReviewReservation = async (known, reason) => {
        if (!reviewExecution || reviewExecutionSettled) return true;
        let result;
        try {
          result = await settleWriter(reviewExecution.executionId, known, reason);
        } catch (_) {
          result = { state: admission.get(reviewExecution.executionId)?.state || 'unresolved' };
        }
        reviewExecutionSettled = true;
        if (['released', 'reconciled'].includes(result.state)) return true;
        const targetAfter = reviewContext && structured ? targetForDirectReview(reviewContext, structured) : null;
        setReviewOutcome({
          status: 'inconclusive', accepted: false, valid: false,
          reason: 'review_reservation_unsettled', targetAfter,
          targetIdentity: targetAfter?.known ? targetAfter.identity : null,
          stable: false,
        });
        return false;
      };
      const executeStartedAt = new Date().toISOString();
      const executeStartMs = performance.now();
      // Writer attempts only: ms from the admission request to admitted or refused. Null for read-only.
      let queueWaitMs = null;
      const recordPreTurn = (outcome) => {
        if (!usageLedger) return;
        try {
          const retries = usageLedger.workerRowsForContext(contextId);
          usageLedger.record(preTurnUsageEntry({
            roleId,
            taskId,
            contextId,
            outcome,
            retries,
            elapsedMs: Math.round(performance.now() - executeStartMs),
            startedAt: executeStartedAt,
            queueWaitMs,
          }));
        } catch (error) {
          if (!ledgerWarned) {
            ledgerWarned = true;
            console.warn(`usage ledger write failed: ${error?.message || error}`);
          }
        }
      };
      const recordUsage = (source, outcome) => {
        const usage = source?.usage ?? null;
        const permissionEvents = Array.isArray(source?.permissionEvents) ? source.permissionEvents : [];
        telemetry = {
          usage,
          permissionEvents,
          provenance: {
            role: roleId,
            sandbox: role.sandbox,
            taskId,
            contextId,
            workspace,
            ...(lane ? { laneId: lane.id } : {}),
            permissionConfig: source?.permissionConfig ?? null,
            ...(selectedSkills.length ? { selectedSkills: selectedSkills.map(({ id, sha256 }) => ({ id, sha256 })) } : {}),
          },
        };
        if (!usageLedger) return;
        try {
          const retries = usageLedger.workerRowsForContext(contextId);
          usageLedger.record(workerUsageEntry({ roleId, taskId, contextId, source, outcome, retries, queueWaitMs }));
        } catch (error) {
          if (!ledgerWarned) {
            ledgerWarned = true;
            console.warn(`usage ledger write failed: ${error?.message || error}`);
          }
        }
      };
      let structured = null;
      try {
        let input;
        let rejection = null;
        try {
          writeStaging('role_selected', 'selected', { requestMode: 'pending' });
          input = extractText(requestContext.userMessage);
          const raw = parseStructuredRequest(input);
          if (auditRole && !raw) {
            throw new BoundaryViolation('assignment.review', 'review_context_missing', 'Auditor requests must be structured and include non-routine review context.');
          }
          if (raw) {
            try {
              structured = checkSpecialistRequest(raw, {
                id: roleId,
                name: auditRole ? 'auditor' : role.name,
                sandbox: role.sandbox,
              }, { workspace });
              const pinnedFallbackCandidate = role.sandbox === 'read-only'
                && PINNED_CHECK_READ_ONLY_ROLES.has(canonicalRole)
                && structured.review?.kind === 'pinned_check';
              if (structured.review && (reviewRole || pinnedFallbackCandidate)) {
                reviewContext = structured.review;
                pinnedCheckReviewer = pinnedFallbackCandidate;
                if ((auditRole || pinnedCheckReviewer) && structured.continuation) {
                  reviewOriginTarget = originatingReviewTarget(
                    structured.continuation.ofAttemptId,
                    reviewContext,
                    pinnedCheckReviewer,
                  );
                  if (!reviewOriginTarget) {
                    throw new BoundaryViolation('review.continuation', 'review_origin_unknown', 'The originating review target is unavailable; start a fresh review.');
                  }
                }
                if (auditRole || pinnedCheckReviewer) {
                  const holder = externalWriterHolder();
                  if (holder && ['active', 'unresolved'].includes(holder.state)) {
                    throw new BoundaryViolation('review.concurrent_writer', 'review_writer_unsettled', 'A pinned review cannot start while a workspace writer is active or unresolved.');
                  }
                  try {
                    reviewExecution = await admission.acquire({ role: canonicalRole, taskId, contextId, signal: controller.signal });
                  } catch (error) {
                    throw new BoundaryViolation('review.reservation', 'review_reservation_unavailable', `Review reservation could not be acquired: ${error?.code || 'admission_blocked'}`);
                  }
                }
                reviewTargetBefore = targetForDirectReview(reviewContext, structured);
                if (!reviewTargetBefore.known) {
                  throw new BoundaryViolation('review.target', 'review_target_unknown', `Review target identity is unavailable: ${reviewTargetBefore.reason}`);
                }
                if (reviewOriginTarget && reviewOriginTarget !== reviewTargetBefore.identity) {
                  throw new BoundaryViolation('review.continuation', 'review_origin_stale', 'The review target changed since the originating attempt; start a fresh review.');
                }
                writeStaging(auditRole ? 'audit_selected' : pinnedCheckReviewer ? 'pinned_check_selected' : 'verifier_selected', 'selected', {
                  kind: reviewContext.kind,
                  checkpointId: reviewContext.checkpointId,
                  reason: reviewContext.reason,
                  paths: reviewContext.paths,
                  evidenceIds: reviewContext.evidenceIds,
                  targetKnown: true,
                });
              }
              try {
                selectedSkills = assignmentSkillSelection(input, skillCatalog);
              } catch (skillError) {
                // Pin and hash mismatches are drift; count, duplicate, and unknown-id problems are shape errors.
                const drift = /changed since catalog load|pin does not match|path changed/.test(skillError.message);
                throw drift
                  ? new BoundaryViolation('dispatch.skill_pins', 'skill_pin_drift', skillError.message)
                  : new BoundaryViolation('assignment.skills', 'skill_invalid', skillError.message);
              }
            } catch (error) {
              if (!(error instanceof BoundaryViolation)) throw error;
              rejection = error;
              throw error;
            }
          } else {
            selectedSkills = assignmentSkillSelection(input, skillCatalog);
          }
        } catch (error) {
          if (auditRole && error instanceof BoundaryViolation) rejection = error;
          if (auditRole || pinnedCheckReviewer) {
            const code = error?.violations?.[0]?.code || (stagingWriteFailed ? 'staging_log_unavailable' : 'review_preflight_failed');
            setReviewOutcome({ status: 'rejected', reason: code, targetAfter: reviewTargetBefore, stable: false });
            try {
              writeStaging(auditRole ? 'audit_failure' : 'pinned_check_failure', 'failed', {
                stage: 'preflight',
                reason: code,
                checkpointId: reviewContext?.checkpointId || null,
                targetKnown: Boolean(reviewTargetBefore?.known),
              });
            } catch (_) { stagingWriteFailed = true; }
          } else {
            writeStaging('role_failure', 'failed', { stage: 'input', failureKind: rejection?.violations?.[0]?.code || 'input_error' });
          }
          if (rejection) {
            recordPreTurn('input_error');
            const results = rejection.violations.map((entry) => ({ ...entry, evidence: [], advisory: false }));
            const unavailable = results.some((entry) => entry.code === 'guarantee_unavailable');
            publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
              messageId: `${taskId}-input-error`,
              contextId,
              taskId,
              role: 2,
              parts: [{ content: { $case: 'text', value: error.message } }],
              metadata: {
                failureKind: unavailable ? 'guarantee_unavailable' : 'request_invalid',
                codexErrorInfo: null,
                effects: 'none',
                boundary: { contract: BOUNDARY_CONTRACT, results },
                ...(reviewOutcomeMetadata ? { reviewCoverage: reviewOutcomeMetadata.reviewCoverage, review: reviewOutcomeMetadata } : {}),
              },
            });
            return;
          }
          recordPreTurn('input_error');
          publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
            messageId: `${taskId}-input-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: error.message } }],
            metadata: {
              failureKind: 'other', codexErrorInfo: null,
              ...(reviewOutcomeMetadata ? { reviewCoverage: reviewOutcomeMetadata.reviewCoverage, review: reviewOutcomeMetadata } : {}),
            },
          });
          return;
        }

        // A lane only for a structured workspace-write request while the lane probe holds (R11).
        const useLane = writable && Boolean(lanes) && role.sandbox === 'workspace-write'
          && Array.isArray(structured?.allowedFiles) && structured.allowedFiles.length > 0 && await lanes.available();
        if (useLane) {
          let prepared;
          try {
            const continuation = structured?.continuation ?? null;
            if (continuation) continued = { laneAdopted: false, laneFallback: null, threadResumed: false };
            // Adopt the kept lane of the cut-off attempt; any other state falls back to a fresh lane.
            const adoption = continuation?.laneId
              ? lanes.adopt({ contextId, taskId, ofContextId: deterministicContextId(continuation.ofAttemptId), laneId: continuation.laneId })
              : null;
            if (adoption?.lane) {
              continued.laneAdopted = true;
              prepared = { lane: adoption.lane };
            } else {
              if (adoption?.fallback) continued.laneFallback = adoption.fallback;
              prepared = adoption?.refused ? { refused: adoption.refused } : await lanes.prepare({ contextId, taskId });
            }
          } catch (error) {
            recordPreTurn('failed');
            writeStaging('role_failure', 'failed', { stage: 'lane_prepare', failureKind: 'lane_prepare_failed' }, { required: false });
            publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
              messageId: `${taskId}-error`,
              contextId,
              taskId,
              role: 2,
              parts: [{ content: { $case: 'text', value: `Writer lane could not be prepared: ${error?.message || String(error)}` } }],
              metadata: { ...failureMetadata(error), effects: 'none' },
            });
            return;
          }
          if (prepared.refused) {
            // Fenced at prepare (R10): the same outcome as a fenced admission, nothing created.
            recordPreTurn('refused');
            writeStaging('role_failure', 'failed', { stage: 'lane_prepare', failureKind: prepared.refused.code }, { required: false });
            publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
              messageId: `${taskId}-error`,
              contextId,
              taskId,
              role: 2,
              parts: [{ content: { $case: 'text', value: prepared.refused.message } }],
              metadata: {
                failureKind: prepared.refused.code,
                codexErrorInfo: null,
                effects: 'none',
                admission: { code: prepared.refused.code, holder: null },
              },
            });
            return;
          }
          lane = prepared.lane;
        } else if (writable) {
          if (admission.holder()) {
            eventBus.publish(AgentEvent.statusUpdate({
              taskId,
              contextId,
              status: makeStatus(TaskState.TASK_STATE_SUBMITTED, {
                messageId: `${taskId}-admission-wait`,
                contextId,
                taskId,
                role: 2,
                parts: [{ content: { $case: 'text', value: 'Waiting for workspace writer admission' } }],
              }),
              metadata: {},
            }));
          }
          const admissionRequestedMs = performance.now();
          try {
            execution = await admission.acquire({ role: roleId, taskId, contextId, signal: controller.signal });
            queueWaitMs = Math.round(performance.now() - admissionRequestedMs);
          } catch (error) {
            queueWaitMs = Math.round(performance.now() - admissionRequestedMs);
            if (controller.signal.aborted) {
              recordPreTurn('canceled');
              writeStaging('role_failure', 'canceled', { stage: 'admission' }, { required: false });
              publishTerminalStatus(TaskState.TASK_STATE_CANCELED);
              return;
            }
            if (error?.code !== 'fenced' && error?.code !== 'admission_blocked') throw error;
            recordPreTurn('refused');
            writeStaging('role_failure', 'failed', { stage: 'admission', failureKind: error.code }, { required: false });
            publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
              messageId: `${taskId}-error`,
              contextId,
              taskId,
              role: 2,
              parts: [{ content: { $case: 'text', value: error.message } }],
              metadata: {
                failureKind: error.code,
                codexErrorInfo: null,
                effects: 'none',
                admission: { code: error.code, holder: error.holder ?? null },
              },
            });
            return;
          }
        }

        eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: makeStatus(TaskState.TASK_STATE_WORKING),
          metadata: {},
        }));

        if (activeTask.cancelRequested) {
          controller.abort();
          if (execution) {
            await settleWriter(execution.executionId, true);
            settled = true;
          }
          if (lane) {
            await lanes.complete({ lane, integrate: false, reason: 'canceled' });
            laneDone = true;
          }
          recordPreTurn('canceled');
          if (auditRole) writeStaging('audit_failure', 'canceled', { stage: 'pre_run', reason: 'canceled' });
          else if (verifierRole && reviewContext) writeStaging('verifier_failure', 'canceled', { stage: 'pre_run', reason: 'canceled' });
          else writeStaging('role_failure', 'canceled', { stage: 'pre_run' }, { required: false });
          publishTerminalStatus(TaskState.TASK_STATE_CANCELED);
          return;
        }
        let result;
        let runError = null;
        const activity = activityStore?.begin({
          key: taskId, runId: activityRunId(requestContext, input), role: canonicalRoleId(roleId),
        });
        const callRun = (threadId, text) => {
          if (auditRole || pinnedCheckReviewer) {
            const holder = externalWriterHolder();
            if (holder) {
              throw new BoundaryViolation('review.concurrent_writer', 'review_writer_unsettled', 'A pinned review cannot run while another workspace writer is active or unresolved.');
            }
          }
          if (!stagingStarted) {
            stagingStarted = true;
            writeStaging(auditRole ? 'audit_started' : pinnedCheckReviewer ? 'pinned_check_started' : verifierRole && reviewContext ? 'verifier_started' : 'role_started', 'started', {
              ...(reviewContext ? { kind: reviewContext.kind, checkpointId: reviewContext.checkpointId, reason: reviewContext.reason } : {}),
              targetKnown: Boolean(reviewTargetBefore?.known),
            });
          }
          return appServer.run({
            role: { id: roleId, ...role },
            cwd: lane ? lane.workspacePath : workspace,
            input: lane ? lanes.laneInput(lane, text)
              : auditRole && reviewContext?.kind === 'pinned_check'
                ? `${text}\n\n${PINNED_CHECK_REPORT_GUIDANCE}`
                : auditRole && reviewContext?.kind !== 'investigation'
                  ? `${text}\n\n${AUDIT_REPORT_GUIDANCE}` : text,
            ...(threadId ? { threadId } : {}),
            selectedSkills,
            outputSchema: WORKER_REPORT_SCHEMA,
            signal: controller.signal,
            ...(reviewExecution ? { onTurnStart: (info) => admission.recordTurnStart(reviewExecution.executionId, info) }
              : execution ? { onTurnStart: (info) => admission.recordTurnStart(execution.executionId, info) } : {}),
            ...(lane ? { sandboxPolicy: lanes.sandboxPolicy(lane), onTurnStart: (info) => lanes.recordTurnStart(lane, info) } : {}),
            ...(activity ? { onEvent: (event) => activity.observe(event) } : {}),
          });
        };
        try {
          if (lane) lanes.markRunning(lane);
          const continuation = structured?.continuation ?? null;
          if (continuation) {
            continued ??= { laneAdopted: false, laneFallback: null, threadResumed: false };
            // A lane writer whose lane is gone cannot claim its partial changes are present.
            const scope = continuation.reason === 'scope';
            let laneLost = Boolean(continuation.laneId) && !continued.laneAdopted;
            // A scope stop normally integrates its lane: the changes are in the workspace and the thread stays valid.
            if (scope && continued.laneFallback === 'lane_state_integrated') laneLost = false;
            const sameHome = (appServer.getCodexHome?.() ?? null) === (continuation.codexHome ?? null);
            const plainInput = withoutContinuation(input);
            const freshNote = scope
              ? (laneLost ? SCOPE_FRESH_LANE_LOST_NOTE : SCOPE_FRESH_NOTE)
              : (laneLost ? CUT_OFF_LANE_LOST_NOTE : CUT_OFF_NOTE);
            const freshInput = `${freshNote}\n${plainInput}`;
            if (continuation.threadId && !laneLost && sameHome) {
              try {
                result = await callRun(continuation.threadId, scope ? scopeResumeInput(structured.allowedFiles, plainInput) : CONTINUE_INPUT);
                continued.threadResumed = true;
              } catch (error) {
                // A rejected resume (thread gone or unusable) starts a fresh thread; nothing ran.
                if (error?.failureClass !== 'request_rejected' || error?.outcomeUnknown === true || controller.signal.aborted) throw error;
                result = await callRun(null, freshInput);
              }
            } else {
              result = await callRun(null, freshInput);
            }
          } else {
            result = await callRun(null, input);
          }
        } catch (error) {
          runError = error;
        } finally {
          activity?.end(runError
            ? (controller.signal.aborted ? 'canceled' : 'failed')
            : controller.signal.aborted ? 'canceled' : String(result?.status ?? 'unknown'));
        }
        seenThreadId = result?.threadId || runError?.execution?.threadId || runError?.threadId || result?.execution?.threadId || null;
        recordUsage(runError || result, runError
          ? (controller.signal.aborted ? 'canceled' : runError.outcomeUnknown === true ? 'interrupted' : 'failed')
          : controller.signal.aborted ? 'canceled' : String(result?.status ?? 'unknown'));
        if (execution) {
          // Known outcome: a result, or an error after a confirmed terminal (or before turn/start).
          const turnStarted = Boolean(admission.get(execution.executionId)?.turnStart);
          const known = !runError
            || (runError.outcomeUnknown !== true
              && (runError.execution?.turnTerminal === true || runError.execution?.turnStartRejected === true || !turnStarted));
          writer = await settleWriter(execution.executionId, known, runError?.outcomeUnknown === true ? 'outcome_unknown' : 'turn_not_terminal');
          settled = true;
        }
        let laneCanceled = false;
        if (lane) {
          // R6: integrate only a turn that completed and was not aborted; any other turn keeps its lane.
          const integrate = !runError && !controller.signal.aborted && result?.status === 'completed';
          const laneOutcome = await lanes.complete({
            lane,
            integrate,
            reason: integrate ? null
              : controller.signal.aborted ? 'canceled' : runError?.outcomeUnknown === true ? 'outcome_unknown' : 'turn_failed',
            allowedFiles: structured.allowedFiles,
            role: roleId,
            taskId,
            contextId,
            signal: controller.signal,
            settle: settleWriter,
          });
          laneDone = true;
          writer = laneOutcome.writerExecution;
          laneCanceled = laneOutcome.canceled;
        }
        if (runError) throw runError;
        const resultText = typeof result?.text === 'string' ? result.text : '';
        // A lane that went through integration reports that outcome even if a cancel arrived meanwhile.
        const canceled = lane ? laneCanceled : controller.signal.aborted;
        const completed = result?.status === 'completed';
        const parsedReport = completed ? parseWorkerReport(resultText) : { report: null, error: null };
        let effectiveCompleted = completed;
        if ((auditRole || pinnedCheckReviewer) && !canceled) {
          const targetAfter = targetForDirectReview(reviewContext, structured);
          const writerClear = !externalWriterHolder();
          const stable = Boolean(reviewTargetBefore?.known && targetAfter.known
            && reviewTargetBefore.identity === targetAfter.identity && writerClear);
          let decision = { valid: false, accepted: false, verdict: null, reason: 'review_report_invalid_or_incomplete' };
          if (reviewContext.kind === 'pinned_check') {
            const firstLine = String(parsedReport.report?.summary || '').split(/\r?\n/, 1)[0];
            const match = /^VERDICT: (preserve|weaken)$/.exec(firstLine);
            const valid = Boolean(parsedReport.report && !parsedReport.error
              && parsedReport.report.outcome === 'completed' && !parsedReport.report.decisionRequest && match);
            decision = {
              valid,
              accepted: valid && match[1] === 'preserve',
              verdict: match?.[1] || null,
              reason: valid ? null : 'pinned_check_verdict_or_report_invalid',
            };
          } else if (reviewContext.kind === 'investigation') {
            const valid = Boolean(parsedReport.report && !parsedReport.error
              && parsedReport.report.outcome === 'completed' && !parsedReport.report.decisionRequest);
            decision = { valid, accepted: false, verdict: null, reason: valid ? 'diagnostic_only' : 'investigation_report_invalid' };
          } else {
            decision = reviewResult({
              status: completed ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
              report: parsedReport.report,
              boundary: { results: [] },
              sandbox: role.sandbox,
              writerExecution: writer,
            }, 'auditor', reviewContext);
            decision.accepted = decision.valid && decision.verdict === 'pass';
          }
          const reason = !writerClear ? 'review_writer_unsettled'
            : !stable ? (reviewTargetBefore?.known && targetAfter.known ? 'review_target_changed' : targetAfter.reason || 'review_target_unknown')
              : decision.reason;
          setReviewOutcome({
            status: stable ? (decision.valid ? (decision.accepted ? 'accepted' : decision.verdict || 'diagnostic') : 'inconclusive') : 'inconclusive',
            accepted: stable && decision.accepted,
            valid: stable && decision.valid,
            verdict: decision.verdict,
            reason,
            targetAfter,
            stable,
          });
          effectiveCompleted = stable && (reviewContext.kind === 'investigation' || decision.valid);
          if (reviewExecution && !await settleReviewReservation(true, 'review_completed')) effectiveCompleted = false;
          try {
            writeStaging(auditRole
              ? (effectiveCompleted ? 'audit_result' : 'audit_failure')
              : (effectiveCompleted ? 'pinned_check_result' : 'pinned_check_failure'), effectiveCompleted ? 'completed' : 'failed', {
              kind: reviewContext.kind,
              checkpointId: reviewContext.checkpointId,
              reason: reviewOutcomeMetadata.reason,
              verdict: reviewOutcomeMetadata.verdict,
              accepted: reviewOutcomeMetadata.accepted,
              reviewCoverage: reviewOutcomeMetadata.reviewCoverage,
              ...stagingReportPayload(parsedReport.report),
            }, { target: reviewOutcomeMetadata.reviewCoverage.targetIdentity });
          } catch (_) {
            stagingWriteFailed = true;
            effectiveCompleted = false;
            setReviewOutcome({ status: 'inconclusive', reason: 'staging_log_unavailable', targetAfter, stable: false });
          }
          if (stagingWriteFailed) {
            effectiveCompleted = false;
            setReviewOutcome({ status: 'inconclusive', reason: 'staging_log_unavailable', targetAfter, stable: false });
          }
        } else if (verifierRole && reviewContext && !canceled) {
          const targetAfter = targetForDirectReview(reviewContext, structured);
          const holder = admission.holder();
          const writerClear = !(holder && ['active', 'unresolved'].includes(holder.state));
          const stable = Boolean(reviewTargetBefore?.known && targetAfter.known
            && reviewTargetBefore.identity === targetAfter.identity && writerClear);
          const emptyLaneReview = writer?.state === null
            && writer?.lane?.state === 'not_integrated'
            && writer.lane.reason === 'no_changes'
            && writer.delta?.known === true
            && writer.delta.source === 'lane_collection'
            && writer.delta.headChanged === false
            && Array.isArray(writer.delta.changedPaths)
            && writer.delta.changedPaths.length === 0
            && writer.delta.changedPathCount === 0;
          const reportedOutside = emptyLaneReview
            ? pathsOutsideAllowed(parsedReport.report?.filesChanged || [], structured?.allowedFiles || [], workspace)
            : [];
          const decision = reviewResult({
            status: completed ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
            report: parsedReport.report,
            boundary: { results: reportedOutside.length > 0
              ? [boundaryRecord('settle.reported_scope', 'FAIL', 'reported_scope_violation', 'settlement',
                `Reported changed files outside allowedFiles: ${reportedOutside.join(', ')}`)]
              : [] },
            sandbox: role.sandbox,
            writerExecution: writer,
            reviewCoverage: {
              targetKnown: Boolean(reviewTargetBefore?.known && targetAfter.known),
              targetIdentity: reviewTargetBefore?.known && targetAfter.known ? reviewTargetBefore.identity : null,
              stable,
            },
            scopeViolations: reportedOutside,
          }, 'verifier', reviewContext);
          const reason = !writerClear ? 'review_writer_unsettled'
            : !targetAfter.known ? targetAfter.reason || 'review_target_unknown'
              : stable ? decision.reason : 'verifier_target_changed_during_review';
          setReviewOutcome({
            status: decision.valid ? 'accepted' : 'inconclusive',
            accepted: decision.valid,
            valid: decision.valid,
            verdict: decision.verdict,
            reason,
            targetAfter,
            targetIdentity: targetAfter.known ? targetAfter.identity : null,
            stable,
          });
          try {
            writeStaging(decision.valid ? 'verifier_result' : 'verifier_failure', decision.valid ? 'completed' : 'failed', {
              kind: reviewContext.kind,
              checkpointId: reviewContext.checkpointId,
              reason: reviewOutcomeMetadata.reason,
              valid: reviewOutcomeMetadata.valid,
              reviewCoverage: reviewOutcomeMetadata.reviewCoverage,
              ...stagingReportPayload(parsedReport.report),
            }, { target: reviewOutcomeMetadata.reviewCoverage.targetIdentity });
          } catch (_) {
            stagingWriteFailed = true;
            effectiveCompleted = false;
            setReviewOutcome({ status: 'inconclusive', reason: 'staging_log_unavailable', targetAfter, targetIdentity: targetAfter.identity, stable: false });
          }
          if (stagingWriteFailed) {
            effectiveCompleted = false;
            setReviewOutcome({
              status: 'inconclusive', reason: 'staging_log_unavailable', targetAfter,
              targetIdentity: targetAfter.known ? targetAfter.identity : null, stable: false,
            });
          }
        } else if (auditRole || pinnedCheckReviewer) {
          writeStaging(auditRole ? 'audit_failure' : 'pinned_check_failure', 'failed', { stage: 'execution', reason: 'review_canceled' });
        } else if (verifierRole && reviewContext) {
          writeStaging('verifier_failure', 'failed', { stage: 'execution', reason: 'verification_canceled' });
        } else if (!reviewRole) {
          writeStaging(completed && !canceled ? 'role_result' : 'role_failure', completed && !canceled ? 'completed' : 'failed', {
            stage: 'execution', ...stagingReportPayload(parsedReport.report),
          }, { required: false });
        }
        if (!canceled && completed) {
          let boundary = { contract: 'legacy' };
          if (structured) {
            const results = [];
            if (parsedReport.error) {
              results.push(boundaryRecord('settle.report_valid', 'FAIL', 'report_invalid', 'settlement', parsedReport.error, !writable));
            }
            if (writable && writer?.lane && !writer.executionId) {
              // Nothing reached the shared tree: attested scope holds; a refused patch fails only this attempt (R7).
              const laneRef = writer.lane;
              if (laneRef.reason === 'lane_scope_refused') {
                results.push(boundaryRecord('settle.lane_scope', 'FAIL', 'lane_scope_refused', 'settlement',
                  `Lane patch refused, nothing integrated; paths outside allowedFiles: ${(laneRef.scopeViolations || []).join(', ')}`,
                  false, [`writer_lanes:${laneRef.id}`]));
              }
              results.push(boundaryRecord('settle.attested_scope', 'PASS', null, 'settlement',
                `Lane ${laneRef.id} not integrated (${laneRef.reason}): nothing integrated into the shared workspace`,
                false, [`writer_lanes:${laneRef.id}`]));
            } else if (writable && writer) {
              const delta = writer.delta;
              if (!delta || delta.known !== true) {
                results.push(boundaryRecord('settle.attested_scope', 'UNKNOWN', 'delta_unknown', 'settlement',
                  'The workspace delta of this writer is unknown'));
              } else {
                const outside = pathsOutsideAllowed(delta.changedPaths || [], structured.allowedFiles, workspace);
                if (outside.length) {
                  results.push(boundaryRecord('settle.attested_scope', 'FAIL', 'attested_scope_violation', 'settlement',
                    `Changed paths outside allowedFiles: ${outside.join(', ')}`));
                }
              }
            }
            boundary = { contract: BOUNDARY_CONTRACT, results };
          }
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: {
              artifactId: `${taskId}-result`,
              name: `${displayRoleName(roleId, role)} result`,
              description: role.description,
              parts: [{ content: { $case: 'text', value: resultText } }],
              metadata: {
                contract: parsedReport.error ? null : WORKER_REPORT_CONTRACT,
                ...(parsedReport.error ? { reportError: parsedReport.error } : {}),
                boundary,
                threadId: result.threadId || null,
                ...(continued ? { continued } : {}),
                ...continuationMetadata(),
            ...(selectedSkills.length ? { selectedSkills: selectedSkills.map(({ id, sha256 }) => ({ id, sha256 })) } : {}),
                ...(writer ? { writerExecution: writer } : {}),
                ...(telemetry ? telemetry : {}),
                ...(reviewOutcomeMetadata ? { reviewCoverage: reviewOutcomeMetadata.reviewCoverage, review: reviewOutcomeMetadata } : {}),
              },
              extensions: [],
            },
            append: false,
            lastChunk: true,
            metadata: {},
          }));
        }
        publishTerminalStatus(
          canceled ? TaskState.TASK_STATE_CANCELED : effectiveCompleted ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_FAILED,
          !canceled && !effectiveCompleted ? {
            messageId: `${taskId}-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: resultText || `Codex App Server returned status "${String(result?.status)}".` } }],
            metadata: failedMetadata(result?.error),
          } : undefined,
        );
      } catch (error) {
        if (execution && !settled) {
          // Never leave the workspace held by a writer that fell out of the normal flow.
          settled = true;
          try { writer = await settleWriter(execution.executionId, false, 'executor_error'); } catch (_) { /* keep the original error */ }
        }
        if (lane && !laneDone) {
          laneDone = true;
          try { writer = lanes.abandon(lane); } catch (_) { /* keep the original error */ }
        }
        if (auditRole || pinnedCheckReviewer) {
          const reason = error?.violations?.[0]?.code || (stagingWriteFailed ? 'staging_log_unavailable' : 'audit_execution_failed');
          if (!reviewOutcomeMetadata) {
            const targetAfter = reviewContext && structured ? targetForDirectReview(reviewContext, structured) : null;
            setReviewOutcome({ status: 'inconclusive', reason, targetAfter, targetIdentity: targetAfter?.known ? targetAfter.identity : null, stable: false });
          }
          if (reviewExecution && !reviewExecutionSettled) {
            const turnStarted = Boolean(admission.get(reviewExecution.executionId)?.turnStart);
            const known = error?.outcomeUnknown !== true
              && (error?.execution?.turnTerminal === true || error?.execution?.turnStartRejected === true || !turnStarted);
            await settleReviewReservation(known, error?.outcomeUnknown === true ? 'outcome_unknown' : 'review_failed');
          }
          try {
            writeStaging(auditRole ? 'audit_failure' : 'pinned_check_failure', 'failed', {
              stage: 'execution',
              reason: stagingWriteFailed ? 'staging_log_unavailable' : reason,
              checkpointId: reviewContext?.checkpointId || null,
              reviewCoverage: reviewOutcomeMetadata.reviewCoverage,
            });
          } catch (_) { stagingWriteFailed = true; }
          if (stagingWriteFailed) setReviewOutcome({ status: 'inconclusive', reason: 'staging_log_unavailable', stable: false });
        } else if (verifierRole && reviewContext) {
          const targetAfter = structured ? targetForDirectReview(reviewContext, structured) : null;
          if (!reviewOutcomeMetadata) setReviewOutcome({
            status: 'inconclusive',
            reason: error?.violations?.[0]?.code || 'verification_execution_failed',
            targetAfter,
            targetIdentity: targetAfter?.known ? targetAfter.identity : null,
            stable: false,
          });
          try {
            writeStaging('verifier_failure', 'failed', {
              stage: 'execution',
              reason: stagingWriteFailed ? 'staging_log_unavailable' : (error?.violations?.[0]?.code || 'verification_execution_failed'),
              checkpointId: reviewContext.checkpointId,
              reviewCoverage: reviewOutcomeMetadata.reviewCoverage,
            }, { target: reviewOutcomeMetadata.reviewCoverage.targetIdentity });
          } catch (_) { stagingWriteFailed = true; }
          if (stagingWriteFailed) setReviewOutcome({
            status: 'inconclusive', reason: 'staging_log_unavailable', targetAfter,
            targetIdentity: targetAfter?.known ? targetAfter.identity : null, stable: false,
          });
        } else {
          writeStaging('role_failure', 'failed', { stage: 'execution', failureKind: 'role_execution_failed' }, { required: false });
        }
        const canceled = controller.signal.aborted;
        publishTerminalStatus(
          canceled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
          canceled ? undefined : {
            messageId: `${taskId}-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: error?.message || String(error) } }],
            metadata: failedMetadata(error),
          },
        );
      } finally {
        if (reviewExecution && !reviewExecutionSettled) {
          const turnStarted = Boolean(admission.get(reviewExecution.executionId)?.turnStart);
          await settleReviewReservation(!turnStarted, controller.signal.aborted ? 'review_canceled' : 'review_exit');
        }
        releaseReservation(taskId, activeTask);
      }
    },

    async cancelTask(taskId) {
      const activeTask = reservations.get(taskId);
      if (!activeTask) return;
      activeTask.cancelRequested = true;
      activeTask.controller?.abort();
    },

    reserveTask(taskId) {
      if (reservations.has(taskId)) return undefined;
      const reservation = { taskId, entered: false, terminal: false, cancelRequested: false };
      reservations.set(taskId, reservation);
      return reservation;
    },

    releaseTask(taskId, reservation) {
      if (!reservation.entered) releaseReservation(taskId, reservation);
    },
  };
  return executor;
}

function rejectOverlappingTask(executor) {
  return (req, res, next) => {
    if (req.method !== 'POST' || req.body?.method !== 'SendMessage') return next();
    const taskId = req.body?.params?.message?.taskId;
    if (!taskId) return next();
    const reservation = executor.reserveTask(taskId);
    if (!reservation) {
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

    // Keep the reservation while the SDK awaits task-store/context work. A
    // socket close does not prove the SDK stopped processing the request, so
    // only a finished pre-executor response may release it here.
    res.once('finish', () => executor.releaseTask(taskId, reservation));
    try {
      next();
    } catch (error) {
      executor.releaseTask(taskId, reservation);
      throw error;
    }
  };
}

/** Mount one independently stored A2A JSON-RPC agent per role. */
function registerRoleAgents(app, {
  roles, appServer, workspace, baseUrl, taskStoreFactory = () => new InMemoryTaskStore(), admission, reconcileRetry, usageLedger, activityStore,
  skillCatalog = loadSkillCatalog(), lanes = null, stagingLog = new InMemoryStagingLog(),
}) {
  if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') {
    throw new TypeError('app must be an Express application');
  }
  if (!(roles instanceof Map)) throw new TypeError('roles must be a Map');
  if (!appServer || typeof appServer.run !== 'function') throw new TypeError('appServer.run is required');
  if (typeof workspace !== 'string' || !workspace) throw new TypeError('workspace is required');
  const origin = new URL(baseUrl);
  if (origin.hostname !== '127.0.0.1') throw new TypeError('baseUrl must use the 127.0.0.1 host');

  if (!admission) {
    // One in-memory admission per app keeps writers workspace-wide serialized across its roles.
    admission = new WriterAdmission({ db: new Database(':memory:'), workspace });
  }

  const registered = new Map();
  for (const [rawRoleId, role] of roles) {
    const roleId = canonicalRoleId(roleSlug(rawRoleId));
    if (!role?.name || !role?.description) throw new TypeError(`Role ${roleId} needs name and description`);
    const route = `/agents/${roleId}`;
    const endpoint = new URL(route, `${origin.origin}/`).toString();
    const card = makeRoleCard({ roleId, role, endpoint });
    const executor = makeExecutor({
      roleId, role, appServer, workspace, admission, reconcileRetry, usageLedger, activityStore, skillCatalog, lanes, stagingLog,
    });
    const handler = new DefaultRequestHandler(
      card,
      taskStoreFactory(legacyRoleId(roleId)),
      executor,
    );
    const cardHandler = agentCardHandler({
      agentCardProvider: async () => AgentCard.toJSON(card),
    });
    const rpcHandlers = [express.json(), rejectOverlappingTask(executor), jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    })];
    const aliases = new Set([roleId, legacyRoleId(roleId)]);
    for (const routeId of aliases) {
      const routePath = `/agents/${routeId}`;
      app.use(`${routePath}/agent-card.json`, cardHandler);
      app.use(routePath, ...rpcHandlers);
    }
    registered.set(rawRoleId, { card, handler });
  }
  return registered;
}

module.exports = { registerRoleAgents, extractText, workerUsageEntry };
