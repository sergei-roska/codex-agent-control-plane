'use strict';

const { AgentEvent, InMemoryTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { AgentCard, TaskState } = require('@a2a-js/sdk');
const { UserBuilder, jsonRpcHandler, agentCardHandler } = require('@a2a-js/sdk/server/express');
const express = require('express');
const Database = require('better-sqlite3');
const {
  WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT, classifyCodexError, findCodexErrorInfo, normalizeEffectiveSettings,
} = require('./contracts');
const { WriterAdmission } = require('./writer-admission');

const DEFAULT_RECONCILE_RETRY = { intervalMs: 250, totalMs: 5000 };

function roleSlug(roleId) {
  if (!/^(orch|dlv)-[a-z0-9-]+$/.test(roleId)) {
    throw new TypeError(`Invalid role id "${roleId}"; expected an orch-* slug`);
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

function failureMetadata(error) {
  const classified = error ? classifyCodexError(error) : 'other';
  return {
    failureKind: classified === 'usage_limit' || classified === 'auth'
      ? classified
      : error?.outcomeUnknown === true ? 'interrupted' : classified,
    codexErrorInfo: error ? findCodexErrorInfo(error) : null,
  };
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
    name: role.name,
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
      name: role.name,
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
function workerUsageEntry({ roleId, taskId, contextId, source, outcome, retries }) {
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
    requested: usage?.requested ?? null,
    reported: usage?.reported ?? null,
    outcome,
    permissionEvents: Array.isArray(source?.permissionEvents) ? source.permissionEvents : [],
  };
}

// Pinned per-run settings sent by the lead; honored only when they name this endpoint's role.
// An entry naming this role that fails the format check, or (catalog ok) the catalog check, fails the turn.
async function effectiveSettingsFor(roleId, message, catalog) {
  const raw = message?.metadata?.effectiveSettings;
  if (!raw || typeof raw !== 'object' || raw.roleRuntimeId !== roleId) return null;
  const normalized = normalizeEffectiveSettings(raw);
  if (!normalized) throw new Error(`effectiveSettings for ${roleId} is malformed (invalid model, effort or serviceTier)`);
  if (catalog && catalog.status().state === 'ok') {
    const verdict = await catalog.validateSelection(normalized);
    if (!verdict.ok && verdict.code !== 'catalog_unavailable') {
      throw new Error(`effectiveSettings for ${roleId} refused: ${verdict.errors.map((entry) => entry.message).join('; ')}`);
    }
  }
  return normalized;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeExecutor({
  roleId, role, appServer, workspace, admission, reconcileRetry = DEFAULT_RECONCILE_RETRY, usageLedger = null, catalog = null,
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
      // Set once appServer.run was reached: { usage, permissionEvents, provenance }.
      let telemetry = null;
      const failedMetadata = (error) => ({
        ...failureMetadata(error),
        ...(writer ? { writerExecution: writer } : {}),
        ...(telemetry ? telemetry : {}),
      });
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
            permissionConfig: source?.permissionConfig ?? null,
          },
        };
        if (!usageLedger) return;
        try {
          const retries = usageLedger.workerRowsForContext(contextId);
          usageLedger.record(workerUsageEntry({ roleId, taskId, contextId, source, outcome, retries }));
        } catch (error) {
          if (!ledgerWarned) {
            ledgerWarned = true;
            console.warn(`usage ledger write failed: ${error?.message || error}`);
          }
        }
      };
      try {
        let input;
        try {
          input = extractText(requestContext.userMessage);
        } catch (error) {
          publishTerminalStatus(TaskState.TASK_STATE_FAILED, {
            messageId: `${taskId}-input-error`,
            contextId,
            taskId,
            role: 2,
            parts: [{ content: { $case: 'text', value: error.message } }],
            metadata: { failureKind: 'other', codexErrorInfo: null },
          });
          return;
        }

        if (writable) {
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
          try {
            execution = await admission.acquire({ role: roleId, taskId, contextId, signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted) {
              publishTerminalStatus(TaskState.TASK_STATE_CANCELED);
              return;
            }
            if (error?.code !== 'fenced' && error?.code !== 'admission_blocked') throw error;
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
          publishTerminalStatus(TaskState.TASK_STATE_CANCELED);
          return;
        }
        let result;
        let runError = null;
        try {
          const effective = await effectiveSettingsFor(roleId, requestContext.userMessage, catalog);
          result = await appServer.run({
            role: {
              id: roleId,
              ...role,
              ...(effective ? { model: effective.model, effort: effective.effort, ...(effective.serviceTier ? { serviceTier: effective.serviceTier } : {}) } : {}),
            },
            cwd: workspace,
            input,
            outputSchema: WORKER_REPORT_SCHEMA,
            signal: controller.signal,
            ...(execution ? { onTurnStart: (info) => admission.recordTurnStart(execution.executionId, info) } : {}),
          });
        } catch (error) {
          runError = error;
        }
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
        if (runError) throw runError;
        const resultText = typeof result?.text === 'string' ? result.text : '';
        const canceled = controller.signal.aborted;
        const completed = result?.status === 'completed';
        if (!canceled && completed) {
          eventBus.publish(AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: {
              artifactId: `${taskId}-result`,
              name: `${role.name} result`,
              description: role.description,
              parts: [{ content: { $case: 'text', value: resultText } }],
              metadata: {
                contract: WORKER_REPORT_CONTRACT,
                threadId: result.threadId || null,
                ...(writer ? { writerExecution: writer } : {}),
                ...(telemetry ? telemetry : {}),
              },
              extensions: [],
            },
            append: false,
            lastChunk: true,
            metadata: {},
          }));
        }
        publishTerminalStatus(
          canceled ? TaskState.TASK_STATE_CANCELED : completed ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_FAILED,
          !canceled && !completed ? {
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
  roles, appServer, workspace, baseUrl, taskStoreFactory = () => new InMemoryTaskStore(), admission, reconcileRetry, usageLedger, catalog = null,
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
    const roleId = roleSlug(rawRoleId);
    if (!role?.name || !role?.description) throw new TypeError(`Role ${roleId} needs name and description`);
    const route = `/agents/${roleId}`;
    const endpoint = new URL(route, `${origin.origin}/`).toString();
    const card = makeRoleCard({ roleId, role, endpoint });
    const executor = makeExecutor({ roleId, role, appServer, workspace, admission, reconcileRetry, usageLedger, catalog });
    const handler = new DefaultRequestHandler(
      card,
      taskStoreFactory(roleId),
      executor,
    );
    app.use(`${route}/agent-card.json`, agentCardHandler({
      agentCardProvider: async () => AgentCard.toJSON(card),
    }));
    app.use(route, express.json(), rejectOverlappingTask(executor), jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }));
    registered.set(roleId, { card, handler });
  }
  return registered;
}

module.exports = { registerRoleAgents, extractText, workerUsageEntry };
